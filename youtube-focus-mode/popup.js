/**
 * popup.js — wires the popup UI to shared state.
 * Settings are read and written through storage.js. Anything time-based
 * (the Focus Session) is a message to background.js, which owns the
 * chrome.alarms-driven countdown. Stats are only ever read here; the
 * background queue is their single writer.
 */

(function () {
  "use strict";

  const D = YFMDetect;
  const S = YFMStorage;

  let state = null;
  let stats = S.emptyStatsData(null).stats;
  let countdownIntervalId = null;

  const els = {
    tabs: document.querySelectorAll(".yfm-tab"),
    panels: document.querySelectorAll(".yfm-panel"),
    onboarding: document.getElementById("yfm-onboarding"),
    sessionEndedBanner: document.getElementById("yfm-session-ended-banner"),
    notYoutubeBanner: document.getElementById("yfm-not-youtube-banner"),
    sessionStatus: document.getElementById("yfm-session-status"),
    listStatus: document.getElementById("yfm-list-status"),
    channelInput: document.getElementById("yfm-channel-input"),
    channelAdd: document.getElementById("yfm-channel-add"),
    channelList: document.getElementById("yfm-channel-list"),
    keywordType: document.getElementById("yfm-keyword-type"),
    keywordInput: document.getElementById("yfm-keyword-input"),
    keywordAdd: document.getElementById("yfm-keyword-add"),
    keywordList: document.getElementById("yfm-keyword-list"),
    hashtagList: document.getElementById("yfm-hashtag-list"),
    durationInput: document.getElementById("yfm-duration-input"),
    startSessionBtn: document.getElementById("yfm-start-session"),
    stopSessionBtn: document.getElementById("yfm-stop-session"),
    sessionIdle: document.getElementById("yfm-session-idle"),
    sessionActive: document.getElementById("yfm-session-active"),
    countdownTime: document.getElementById("yfm-countdown-time"),
    statShorts: document.getElementById("yfm-stat-shorts"),
    statRecs: document.getElementById("yfm-stat-recs"),
    statChannels: document.getElementById("yfm-stat-channels"),
    statKeywords: document.getElementById("yfm-stat-keywords"),
    statHashtags: document.getElementById("yfm-stat-hashtags"),
    exportBtn: document.getElementById("yfm-export-btn"),
    importInput: document.getElementById("yfm-import-input"),
    importStatus: document.getElementById("yfm-import-status"),
    version: document.getElementById("yfm-version")
  };

  // ---------- Single writer for settings ----------
  // Every settings change (toggles, list edits, import, the onboarding
  // flag) is sent to the background service worker, which applies it
  // through the same serialized queue as the Focus Session and migration
  // writes. Two writes fired in the same tick from this popup (or from a
  // second popup window) can therefore never silently clobber each other,
  // the way two independent direct storage.setState() calls could.
  function commitState(partial) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: "YFM_SET_STATE", partial }, (response) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!response || !response.ok) return reject(new Error((response && response.error) || "Save failed."));
        resolve(response.state);
      });
    });
  }

  // ---------- Tabs ----------
  els.tabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      els.tabs.forEach((t) => t.classList.remove("active"));
      els.panels.forEach((p) => p.classList.remove("active"));
      tab.classList.add("active");
      document.querySelector(`.yfm-panel[data-panel="${tab.dataset.tab}"]`).classList.add("active");
    });
  });

  // ---------- Validation (one place, used by add and edit) ----------
  function say(message) {
    els.listStatus.textContent = message || "";
    els.listStatus.hidden = !message;
  }

  // Each validator returns { ok: true, value } or { ok: false, message }.
  // `others` is the list without the entry being edited.
  function validateChannel(raw, others) {
    if (!String(raw).trim()) return { ok: false, message: "Enter a channel name, @handle, channel ID or URL." };
    const parsed = D.parseChannelInput(raw);
    if (!parsed) return { ok: false, message: "That link doesn't point to a YouTube channel." };
    const key = D.channelKey(parsed.value);
    if (!key) return { ok: false, message: "Enter a channel name, @handle, channel ID or URL." };
    if (others.some((c) => D.channelEntryKey(c) === key)) return { ok: false, message: "That channel is already on the list." };
    return { ok: true, value: parsed.entry };
  }

  function validateKeyword(raw, others) {
    const trimmed = String(raw).trim();
    if (!D.normalizeText(trimmed)) return { ok: false, message: "Enter a keyword." };
    if (others.some((k) => D.normalizeText(k) === D.normalizeText(trimmed))) {
      return { ok: false, message: "That keyword is already on the list." };
    }
    return { ok: true, value: trimmed };
  }

  function validateHashtag(raw, others) {
    const value = D.normalizeHashtagEntry(raw);
    if (!value) return { ok: false, message: "Enter a hashtag such as #gaming (letters, digits or underscores)." };
    if (others.some((h) => D.hashtagKey(h) === D.hashtagKey(value))) {
      return { ok: false, message: "That hashtag is already on the list." };
    }
    return { ok: true, value };
  }

  const KINDS = {
    channel: { field: "blockedChannels", validate: validateChannel },
    keyword: { field: "blockedKeywords", validate: validateKeyword },
    hashtag: { field: "blockedHashtags", validate: validateHashtag }
  };

  function saveList(kind, next) {
    return commitState({ [KINDS[kind].field]: next }).then((s) => {
      state = s;
      renderLists();
    });
  }

  function addEntry(kind, raw) {
    const k = KINDS[kind];
    const result = k.validate(raw, state[k.field]);
    if (!result.ok) {
      say(result.message);
      return Promise.resolve(false);
    }
    say("");
    return saveList(kind, state[k.field].concat(result.value)).then(() => true);
  }

  function editEntry(kind, oldValue, raw) {
    const k = KINDS[kind];
    const others = state[k.field].filter((v) => v !== oldValue);
    const result = k.validate(raw, others);
    if (!result.ok) {
      say(result.message);
      return Promise.resolve(false);
    }
    say("");
    return saveList(kind, state[k.field].map((v) => (v === oldValue ? result.value : v))).then(() => true);
  }

  function removeEntry(kind, value) {
    say("");
    return saveList(kind, state[KINDS[kind].field].filter((v) => v !== value));
  }

  // ---------- Rendering ----------
  // Search-Only Mode forces blockShorts and hideHomeFeed on without changing
  // their stored value, so those two switches are shown checked-and-disabled
  // while it's active rather than silently disagreeing with reality.
  const FORCED_BY_SEARCH_ONLY = ["blockShorts", "hideHomeFeed"];

  function renderToggles() {
    const forced = !!state.toggles.searchOnlyMode;
    document.querySelectorAll("[data-toggle-input]").forEach((input) => {
      const key = input.dataset.toggleInput;
      const isForced = forced && FORCED_BY_SEARCH_ONLY.includes(key);
      input.checked = isForced ? true : !!state.toggles[key];
      input.disabled = isForced;
      const row = input.closest(".yfm-toggle-row");
      if (row) row.classList.toggle("yfm-toggle-forced", isForced);
    });
  }

  function iconButton(label, text, onClick) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.setAttribute("aria-label", label);
    btn.textContent = text;
    btn.addEventListener("click", onClick);
    return btn;
  }

  function renderChips(listEl, kind, badge) {
    const items = state[KINDS[kind].field];
    listEl.innerHTML = "";
    if (items.length === 0) {
      const li = document.createElement("li");
      li.className = "yfm-empty-note";
      li.textContent = "None added yet.";
      listEl.appendChild(li);
      return;
    }
    items.forEach((item) => {
      const li = document.createElement("li");
      li.className = "yfm-chip";
      li.dataset.value = item;
      if (badge) {
        const b = document.createElement("span");
        b.className = "yfm-badge";
        b.textContent = badge;
        li.appendChild(b);
      }
      const span = document.createElement("span");
      span.className = "yfm-chip-text";
      span.textContent = badge ? item.replace(/^#/, "") : item;
      li.appendChild(span);
      li.appendChild(iconButton(`Edit ${item}`, "✎", () => startEdit(li, kind, item, badge)));
      li.appendChild(iconButton(`Remove ${item}`, "✕", () => removeEntry(kind, item)));
      listEl.appendChild(li);
    });
  }

  function startEdit(li, kind, item, badge) {
    li.innerHTML = "";
    li.classList.add("yfm-chip-editing");
    const input = document.createElement("input");
    input.type = "text";
    input.value = item;
    input.setAttribute("aria-label", `Edit ${item}`);
    const commit = () => {
      editEntry(kind, item, input.value);
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") commit();
      if (e.key === "Escape") { say(""); renderLists(); }
    });
    li.appendChild(input);
    li.appendChild(iconButton("Save", "✓", commit));
    li.appendChild(iconButton("Cancel", "✕", () => { say(""); renderLists(); }));
    input.focus();
    input.select();
  }

  function renderLists() {
    renderChips(els.channelList, "channel", null);
    renderChips(els.keywordList, "keyword", null);
    renderChips(els.hashtagList, "hashtag", "#");
  }

  function renderStats() {
    els.statShorts.textContent = stats.shortsBlocked;
    els.statRecs.textContent = stats.recsBlocked;
    els.statChannels.textContent = stats.channelsBlocked;
    els.statKeywords.textContent = stats.keywordsBlocked;
    els.statHashtags.textContent = stats.hashtagsBlocked;
  }

  function formatCountdown(ms) {
    const totalSeconds = Math.max(0, Math.round(ms / 1000));
    const mm = Math.floor(totalSeconds / 60).toString().padStart(2, "0");
    const ss = (totalSeconds % 60).toString().padStart(2, "0");
    return `${mm}:${ss}`;
  }

  function stopCountdownTimer() {
    if (countdownIntervalId) {
      clearInterval(countdownIntervalId);
      countdownIntervalId = null;
    }
  }

  function renderSession() {
    if (state.focusSession.active && state.focusSession.endTime) {
      els.sessionIdle.hidden = true;
      els.sessionActive.hidden = false;
      els.sessionStatus.textContent = "Focus session in progress";

      stopCountdownTimer();
      const tick = () => {
        const remaining = state.focusSession.endTime - Date.now();
        els.countdownTime.textContent = formatCountdown(remaining);
        if (remaining <= 0) stopCountdownTimer();
      };
      tick();
      countdownIntervalId = setInterval(tick, 1000);
    } else {
      stopCountdownTimer();
      els.sessionIdle.hidden = false;
      els.sessionActive.hidden = true;
      els.sessionStatus.textContent = "for YouTube";
      els.durationInput.value = state.focusSession.durationMinutes || 25;
    }
  }

  function renderBanners() {
    els.onboarding.hidden = !!state.onboardingSeen;
    const endedRecently =
      state.lastSessionEnd &&
      state.lastSessionEnd.reason === "completed" &&
      Date.now() - state.lastSessionEnd.at < 60000;
    els.sessionEndedBanner.hidden = !endedRecently;
  }

  function renderAll() {
    renderToggles();
    renderLists();
    renderStats();
    renderSession();
    renderBanners();
  }

  // ---------- State ----------
  function refreshState() {
    return Promise.all([S.getState(), S.getStatsData()]).then(([s, data]) => {
      state = s;
      stats = S.statsForDisplay(data, Date.now());
      renderAll();
    });
  }

  function setToggle(key, value) {
    return commitState({ toggles: { [key]: value } }).then((s) => {
      state = s;
      renderToggles();
    });
  }

  // ---------- Event wiring ----------
  document.querySelectorAll("[data-toggle-input]").forEach((input) => {
    input.addEventListener("change", () => {
      const key = input.dataset.toggleInput;
      const partial = { toggles: { [key]: input.checked } };
      if (!state.onboardingSeen) partial.onboardingSeen = true;
      commitState(partial).then((s) => {
        state = s;
        renderToggles();
        renderBanners();
      });
    });
  });

  els.channelAdd.addEventListener("click", () => {
    addEntry("channel", els.channelInput.value).then((ok) => {
      if (ok) els.channelInput.value = "";
      els.channelInput.focus();
    });
  });
  els.channelInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") els.channelAdd.click();
  });

  // An entry that starts with "#" is a hashtag even if the selector says Keyword.
  els.keywordAdd.addEventListener("click", () => {
    const raw = els.keywordInput.value;
    const isHashtag = els.keywordType.value === "hashtag" || raw.trim().charAt(0) === "#";
    addEntry(isHashtag ? "hashtag" : "keyword", raw).then((ok) => {
      if (ok) els.keywordInput.value = "";
      els.keywordInput.focus();
    });
  });
  els.keywordInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") els.keywordAdd.click();
  });

  els.startSessionBtn.addEventListener("click", () => {
    const minutes = parseInt(els.durationInput.value, 10) || 25;
    chrome.runtime.sendMessage({ type: "YFM_START_SESSION", durationMinutes: minutes }, (response) => {
      if (response && response.ok) {
        state = response.state;
        renderAll();
      }
    });
  });

  els.stopSessionBtn.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "YFM_STOP_SESSION" }, (response) => {
      if (response && response.ok) {
        state = response.state;
        renderAll();
      }
    });
  });

  els.exportBtn.addEventListener("click", () => {
    S.exportSettings().then((data) => {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `youtube-focus-mode-settings-${Date.now()}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    });
  });

  els.importInput.addEventListener("change", () => {
    const file = els.importInput.files && els.importInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        const clean = S.sanitizeImport(parsed);
        if (!clean) {
          els.importStatus.textContent = "That file didn't look like valid settings.";
        } else {
          commitState(clean)
            .then((s) => {
              state = s;
              renderAll();
              els.importStatus.textContent = "Settings imported successfully.";
            })
            .catch(() => {
              els.importStatus.textContent = "Couldn't save the imported settings.";
            });
        }
      } catch (err) {
        els.importStatus.textContent = "Couldn't parse that file as JSON.";
      }
      els.importInput.value = "";
    };
    reader.readAsText(file);
  });

  // ---------- Active-tab awareness & self-healing injection ----------
  // Uses `activeTab`/host access to read the current tab's URL and `scripting`
  // as a fallback so the extension works on tabs that were already open
  // before install/reload, without requiring a manual page refresh.
  // studio.youtube.com and music.youtube.com are deliberately not supported.
  function ensureContentScriptOnActiveTab() {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      if (!tab || !tab.url) return;

      const isYoutube = /^https:\/\/((www|m)\.)?youtube\.com\//i.test(tab.url);
      els.notYoutubeBanner.hidden = isYoutube;
      if (!isYoutube || tab.id === undefined) return;

      chrome.tabs.sendMessage(tab.id, { type: "YFM_PING" }, () => {
        if (chrome.runtime.lastError) {
          chrome.scripting.executeScript(
            { target: { tabId: tab.id }, files: ["detect.js", "storage.js", "content.js"] },
            () => void chrome.runtime.lastError
          );
          chrome.scripting.insertCSS(
            { target: { tabId: tab.id }, files: ["styles/injected.css"] },
            () => void chrome.runtime.lastError
          );
        }
      });
    });
  }

  // ---------- Live sync while popup is open ----------
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (changes[S.STATE_KEY]) {
      state = S.mergeSettings(changes[S.STATE_KEY].newValue);
      renderAll();
    }
    if (changes[S.STATS_KEY]) {
      stats = S.statsForDisplay(changes[S.STATS_KEY].newValue, Date.now());
      renderStats();
    }
  });

  // ---------- Boot ----------
  els.version.textContent = chrome.runtime.getManifest().version;
  // roll the week over in storage if it has ended, so the numbers shown are current
  chrome.runtime.sendMessage({ type: "YFM_ENSURE_WEEK" }, () => void chrome.runtime.lastError);
  refreshState();
  ensureContentScriptOnActiveTab();
})();
