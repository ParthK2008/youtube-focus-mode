/**
 * background.js — MV3 service worker.
 *
 * Responsibilities:
 *  - Install defaults / migrate v1.0 data on update.
 *  - Run the Focus Session countdown with chrome.alarms (service workers are
 *    killed when idle, so setTimeout/setInterval cannot be trusted).
 *  - Own every write to the stats and learning stores. Content scripts only
 *    send messages; this worker applies them one at a time through a
 *    serialized queue (read, de-dupe, increment, write), so several open tabs
 *    can never lose an update.
 *  - Prune the learning cache/aliases when a blocklist entry is removed.
 */

importScripts("detect.js", "storage.js");

const YFM_SESSION_END_ALARM = "yfm-session-end";
const YFM_BADGE_TICK_ALARM = "yfm-badge-tick";
const YFM_CONTENT_FILES = ["detect.js", "storage.js", "content.js"];
const YFM_YOUTUBE_URLS = ["https://www.youtube.com/*", "https://m.youtube.com/*", "https://youtube.com/*"];

// Focus Session switches every blocking feature on for the session
// (including hashtag blocking) and restores the previous toggles afterwards.
const YFM_FOCUS_TOGGLES_ON = {
  blockShorts: true,
  hideHomeFeed: true,
  blockChannels: true,
  hideUpNext: true,
  hideComments: true,
  disableAutoplay: true,
  hideExplore: true,
  blockKeywords: true,
  blockHashtags: true,
  searchOnlyMode: true
};

const yfmQueue = YFMStorage.createSerialQueue();

// ---------------------------------------------------------------- lifecycle
function yfmInjectIntoOpenTabs() {
  chrome.tabs.query({ url: YFM_YOUTUBE_URLS }, (tabs) => {
    for (const tab of tabs || []) {
      if (tab.id === undefined) continue;
      chrome.scripting.executeScript({ target: { tabId: tab.id }, files: YFM_CONTENT_FILES }, () => void chrome.runtime.lastError);
      chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ["styles/injected.css"] }, () => void chrome.runtime.lastError);
    }
  });
}

chrome.runtime.onInstalled.addListener((details) => {
  // Fresh install writes defaults; an update migrates in place and never
  // overwrites blocklists, keywords, toggles or the current week's stats.
  yfmQueue.enqueue(() => YFMStorage.migrate());
  if (details.reason === "install" || details.reason === "update") yfmInjectIntoOpenTabs();
});

// Idempotent safety net if the worker wakes before onInstalled finished.
yfmQueue.enqueue(() => YFMStorage.migrate());

// ------------------------------------------------------------ focus session
function yfmFormatBadgeMinutes(msRemaining) {
  const totalMinutes = Math.max(0, Math.ceil(msRemaining / 60000));
  if (totalMinutes >= 100) return "99+";
  return `${totalMinutes}m`;
}

function yfmSetBadge(text, color) {
  chrome.action.setBadgeText({ text: text || "" });
  if (color) chrome.action.setBadgeBackgroundColor({ color });
}

function yfmStartFocusSession(durationMinutes) {
  return YFMStorage.getState().then((state) => {
    const safeDuration =
      Number.isFinite(durationMinutes) && durationMinutes > 0
        ? Math.min(durationMinutes, 24 * 60)
        : state.focusSession.durationMinutes || 25;
    const endTime = Date.now() + safeDuration * 60 * 1000;
    const previousToggles = Object.assign({}, state.toggles);

    return YFMStorage.setState({
      toggles: Object.assign({}, state.toggles, YFM_FOCUS_TOGGLES_ON),
      focusSession: { active: true, endTime, durationMinutes: safeDuration, previousToggles }
    }).then((newState) => {
      chrome.alarms.create(YFM_SESSION_END_ALARM, { when: endTime });
      chrome.alarms.create(YFM_BADGE_TICK_ALARM, { periodInMinutes: 1 });
      yfmSetBadge(yfmFormatBadgeMinutes(endTime - Date.now()), "#2f8f7f");
      return newState;
    });
  });
}

function yfmEndFocusSession(reason) {
  return YFMStorage.getState().then((state) => {
    if (!state.focusSession.active) return state;
    const previous = state.focusSession.previousToggles || state.toggles;
    // A session that started on v1.0 has no blockHashtags in its snapshot.
    const reverted = Object.assign({}, YFMStorage.DEFAULT_SETTINGS.toggles, previous);
    return YFMStorage.setState({
      toggles: reverted,
      focusSession: { active: false, endTime: null, previousToggles: null },
      lastSessionEnd: { at: Date.now(), reason: reason || "completed" }
    }).then((newState) => {
      chrome.alarms.clear(YFM_SESSION_END_ALARM);
      chrome.alarms.clear(YFM_BADGE_TICK_ALARM);
      yfmSetBadge("");
      return newState;
    });
  });
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === YFM_SESSION_END_ALARM) {
    yfmEndFocusSession("completed");
    return;
  }
  if (alarm.name === YFM_BADGE_TICK_ALARM) {
    YFMStorage.getState().then((state) => {
      if (!state.focusSession.active || !state.focusSession.endTime) {
        chrome.alarms.clear(YFM_BADGE_TICK_ALARM);
        yfmSetBadge("");
        return;
      }
      const remaining = state.focusSession.endTime - Date.now();
      if (remaining <= 0) yfmEndFocusSession("completed");
      else yfmSetBadge(yfmFormatBadgeMinutes(remaining), "#2f8f7f");
    });
  }
});

// ---------------------------------------------------- stats / learning queue
function yfmApplyStat(msg) {
  return YFMStorage.getStatsData().then((data) => {
    const result = YFMStorage.applyStat(data, msg, Date.now());
    if (!result.changed) return result.data;
    return YFMStorage.rawSet({ [YFMStorage.STATS_KEY]: result.data }).then(() => result.data);
  });
}

function yfmLearnHashtag(msg) {
  return YFMStorage.getLearn().then((learn) => {
    const next = YFMStorage.learnPut(learn, { id: msg.videoId, tag: msg.tag }, Date.now());
    return YFMStorage.rawSet({ [YFMStorage.LEARN_KEY]: next });
  });
}

function yfmLearnAlias(msg) {
  return YFMStorage.getLearn().then((learn) => {
    const next = YFMStorage.aliasPut(learn, msg.entries, msg.keys);
    if (JSON.stringify(next.channelAliases) === JSON.stringify(learn.channelAliases)) return undefined;
    return YFMStorage.rawSet({ [YFMStorage.LEARN_KEY]: next });
  });
}

// Lookup results (Decision D1) are cached under their own key, bounded and
// expiring (see storage.js metaPut). Only this queue writes it.
function yfmMetaPut(msg) {
  const e = msg && msg.entry;
  if (!e || typeof e.id !== "string" || !/^[\w-]{6,24}$/.test(e.id)) return Promise.resolve();
  return YFMStorage.getMeta().then((meta) => {
    const next = YFMStorage.metaPut(meta, e, Date.now());
    return YFMStorage.rawSet({ [YFMStorage.META_KEY]: next });
  });
}

function yfmPruneLearning() {
  return Promise.all([YFMStorage.getState(), YFMStorage.getLearn()]).then(([settings, learn]) => {
    const next = YFMStorage.learnPrune(learn, settings);
    if (JSON.stringify(next) === JSON.stringify(learn)) return undefined;
    return YFMStorage.rawSet({ [YFMStorage.LEARN_KEY]: next });
  });
}

// Removing/editing a list entry (popup, import, session revert) prunes the
// cache entries and aliases that came from it.
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes[YFMStorage.STATE_KEY]) yfmQueue.enqueue(yfmPruneLearning);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") return false;
  const done = () => sendResponse({ ok: true });

  switch (message.type) {
    case "YFM_GET_STATE":
      YFMStorage.getState().then((state) => sendResponse({ ok: true, state }));
      return true;

    // Every settings write (popup toggles, list edits, import) goes through
    // this same queue as the Focus Session and migration writes, so two
    // writes fired in the same tick (e.g. a toggle flip plus marking
    // onboarding seen) can never silently clobber each other.
    case "YFM_SET_STATE":
      yfmQueue.enqueue(() => YFMStorage.setState(message.partial || {})).then(
        (state) => sendResponse({ ok: true, state }),
        (err) => sendResponse({ ok: false, error: String(err) })
      );
      return true;

    case "YFM_START_SESSION":
      yfmStartFocusSession(message.durationMinutes).then((state) => sendResponse({ ok: true, state }));
      return true;

    case "YFM_STOP_SESSION":
      yfmEndFocusSession("cancelled").then((state) => sendResponse({ ok: true, state }));
      return true;

    case "YFM_STAT":
      yfmQueue.enqueue(() => yfmApplyStat(message)).then(done, done);
      return true;

    case "YFM_ENSURE_WEEK":
      yfmQueue.enqueue(() => yfmApplyStat({})).then(done, done);
      return true;

    case "YFM_LEARN_HASHTAG":
      yfmQueue.enqueue(() => yfmLearnHashtag(message)).then(done, done);
      return true;

    case "YFM_META_PUT":
      yfmQueue.enqueue(() => yfmMetaPut(message)).then(done, done);
      return true;

    case "YFM_LEARN_ALIAS":
      yfmQueue.enqueue(() => yfmLearnAlias(message)).then(done, done);
      return true;

    default:
      return false;
  }
});
