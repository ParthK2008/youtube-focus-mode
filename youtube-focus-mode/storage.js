/**
 * storage.js
 * Shared storage layer for YouTube Focus Mode (background, content, popup).
 * Everything lives in chrome.storage.local and never leaves the device.
 *
 * Three keys, so writers never clobber each other:
 *   yfmState : settings (toggles, lists, focus session). Written by popup/background.
 *   yfmStats : counters + de-dupe sets. Written ONLY by the background queue.
 *   yfmLearn : hashtag learning cache + channel aliases. Written ONLY by the background queue.
 *   yfmMeta  : cached same-origin lookup results (channel/hashtags of Shorts). Written ONLY by the background queue.
 */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.YFMStorage = api;
})(typeof self !== "undefined" ? self : globalThis, function (root) {
  "use strict";

  const STATE_KEY = "yfmState";
  const STATS_KEY = "yfmStats";
  const LEARN_KEY = "yfmLearn";
  const META_KEY = "yfmMeta";
  const SCHEMA_VERSION = 2;
  const DEDUPE_MAX = 5000;
  const CACHE_MAX = 5000;
  const ALIAS_ENTRIES_MAX = 500;
  const ALIAS_KEYS_MAX = 24;
  const NONCE_MAX = 100;
  const META_MAX = 5000;
  const META_TTL_MS = 30 * 24 * 60 * 60 * 1000;

  const STAT_MODES = {
    shortsBlocked: "always",
    recsBlocked: "always",
    channelsBlocked: "unique",
    keywordsBlocked: "unique",
    hashtagsBlocked: "unique"
  };

  const DEFAULT_SETTINGS = {
    schemaVersion: SCHEMA_VERSION,
    toggles: {
      blockShorts: true,
      hideHomeFeed: false,
      blockChannels: true,
      hideUpNext: false,
      hideComments: false,
      disableAutoplay: false,
      hideExplore: false,
      blockKeywords: true,
      blockHashtags: true,
      searchOnlyMode: false
    },
    blockedChannels: [],
    blockedKeywords: [],
    blockedHashtags: [],
    focusSession: {
      active: false,
      endTime: null,
      durationMinutes: 25,
      previousToggles: null
    },
    onboardingSeen: false
  };

  function emptyStatsData(weekStart) {
    return {
      schemaVersion: SCHEMA_VERSION,
      stats: {
        weekStart: weekStart || null,
        shortsBlocked: 0,
        recsBlocked: 0,
        channelsBlocked: 0,
        keywordsBlocked: 0,
        hashtagsBlocked: 0
      },
      counted: { channelsBlocked: [], keywordsBlocked: [], hashtagsBlocked: [] },
      nonces: []
    };
  }

  function emptyLearn() {
    return { schemaVersion: SCHEMA_VERSION, hashtagCache: [], channelAliases: {} };
  }

  function deepMerge(base, override) {
    const result = Array.isArray(base) ? base.slice() : Object.assign({}, base);
    if (!override) return result;
    for (const key of Object.keys(override)) {
      const b = base ? base[key] : undefined;
      const o = override[key];
      if (o && typeof o === "object" && !Array.isArray(o) && b && typeof b === "object" && !Array.isArray(b)) {
        result[key] = deepMerge(b, o);
      } else {
        result[key] = o;
      }
    }
    return result;
  }

  function mergeSettings(stored) {
    const s = Object.assign({}, stored || {});
    delete s.stats; // v1.0 kept stats here; they live in yfmStats now
    return deepMerge(DEFAULT_SETTINGS, s);
  }

  function mergeStatsData(stored) {
    const base = emptyStatsData(null);
    const s = stored || {};
    return {
      schemaVersion: SCHEMA_VERSION,
      stats: Object.assign({}, base.stats, s.stats || {}),
      counted: {
        channelsBlocked: (s.counted && s.counted.channelsBlocked) || [],
        keywordsBlocked: (s.counted && s.counted.keywordsBlocked) || [],
        hashtagsBlocked: (s.counted && s.counted.hashtagsBlocked) || []
      },
      nonces: s.nonces || []
    };
  }

  function mergeLearn(stored) {
    const s = stored || {};
    return {
      schemaVersion: SCHEMA_VERSION,
      hashtagCache: Array.isArray(s.hashtagCache) ? s.hashtagCache : [],
      channelAliases: s.channelAliases && typeof s.channelAliases === "object" ? s.channelAliases : {}
    };
  }

  // ---- chrome.storage.local helpers (area is injectable for tests) ----
  function area() {
    return root.chrome.storage.local;
  }

  function rawGet(keys, storage) {
    return new Promise((resolve) => (storage || area()).get(keys, (r) => resolve(r || {})));
  }

  function rawSet(obj, storage) {
    return new Promise((resolve) => (storage || area()).set(obj, () => resolve()));
  }

  function getState(storage) {
    return rawGet([STATE_KEY], storage).then((r) => mergeSettings(r[STATE_KEY]));
  }

  function setState(partial, storage) {
    return getState(storage).then((current) => {
      const next = deepMerge(current, partial);
      return rawSet({ [STATE_KEY]: next }, storage).then(() => next);
    });
  }

  function getWeekStartTimestamp(date) {
    const d = new Date(date || Date.now());
    const diffToMonday = (d.getDay() + 6) % 7;
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - diffToMonday);
    return d.getTime();
  }

  // Stats for display: never show last week's numbers after the week rolled over.
  function statsForDisplay(statsData, now) {
    const data = mergeStatsData(statsData);
    if (data.stats.weekStart !== getWeekStartTimestamp(now)) return emptyStatsData(getWeekStartTimestamp(now)).stats;
    return data.stats;
  }

  function getStatsData(storage) {
    return rawGet([STATS_KEY, STATE_KEY], storage).then((r) => {
      if (r[STATS_KEY]) return mergeStatsData(r[STATS_KEY]);
      const legacy = r[STATE_KEY] && r[STATE_KEY].stats;
      const seeded = emptyStatsData(null);
      if (legacy) Object.assign(seeded.stats, legacy);
      return seeded;
    });
  }

  function getLearn(storage) {
    return rawGet([LEARN_KEY], storage).then((r) => mergeLearn(r[LEARN_KEY]));
  }

  // ---- pure stat application ----
  function boundedPush(list, key, max) {
    list.push(key);
    if (list.length > max) list.splice(0, list.length - max);
  }

  // Returns { data, changed }. Pure: never mutates its input.
  function applyStat(statsData, msg, now, dedupeMax) {
    const max = dedupeMax || DEDUPE_MAX;
    const data = mergeStatsData(JSON.parse(JSON.stringify(mergeStatsData(statsData))));
    const week = getWeekStartTimestamp(now);
    let changed = false;
    if (data.stats.weekStart !== week) {
      const fresh = emptyStatsData(week);
      data.stats = fresh.stats;
      data.counted = fresh.counted;
      data.nonces = [];
      changed = true;
    }
    if (!msg || !Object.prototype.hasOwnProperty.call(STAT_MODES, msg.stat)) return { data, changed };
    if (msg.nonce && data.nonces.includes(msg.nonce)) return { data, changed };
    const mode = STAT_MODES[msg.stat];
    if (mode === "unique") {
      if (!msg.key) return { data, changed };
      const set = data.counted[msg.stat];
      if (set.includes(msg.key)) {
        if (msg.nonce) { boundedPush(data.nonces, msg.nonce, NONCE_MAX); changed = true; }
        return { data, changed };
      }
      boundedPush(set, msg.key, max);
    }
    data.stats[msg.stat] = (data.stats[msg.stat] || 0) + 1;
    if (msg.nonce) boundedPush(data.nonces, msg.nonce, NONCE_MAX);
    return { data, changed: true };
  }

  // ---- learning cache / aliases (pure) ----
  function learnPut(learn, entry, now, max) {
    const cap = max || CACHE_MAX;
    const next = mergeLearn(JSON.parse(JSON.stringify(mergeLearn(learn))));
    if (!entry || !entry.id || !entry.tag) return next;
    next.hashtagCache = next.hashtagCache.filter((e) => e.id !== entry.id);
    next.hashtagCache.push({ id: entry.id, tag: entry.tag, at: now });
    if (next.hashtagCache.length > cap) next.hashtagCache.splice(0, next.hashtagCache.length - cap);
    return next;
  }

  function aliasPut(learn, entryKeys, keys) {
    const next = mergeLearn(JSON.parse(JSON.stringify(mergeLearn(learn))));
    for (const ek of entryKeys || []) {
      if (!ek) continue;
      const cur = next.channelAliases[ek] || [];
      for (const k of keys || []) {
        if (k && k !== ek && !cur.includes(k)) cur.push(k);
      }
      next.channelAliases[ek] = cur.slice(-ALIAS_KEYS_MAX);
    }
    const names = Object.keys(next.channelAliases);
    if (names.length > ALIAS_ENTRIES_MAX) {
      for (const n of names.slice(0, names.length - ALIAS_ENTRIES_MAX)) delete next.channelAliases[n];
    }
    return next;
  }

  // Drops cache entries and aliases whose blocklist entry no longer exists.
  function learnPrune(learn, settings) {
    const D = root.YFMDetect;
    const next = mergeLearn(JSON.parse(JSON.stringify(mergeLearn(learn))));
    const tags = new Set((settings.blockedHashtags || []).map((h) => D.hashtagKey(h)).filter(Boolean));
    next.hashtagCache = next.hashtagCache.filter((e) => tags.has(e.tag));
    const entries = new Set((settings.blockedChannels || []).map((c) => D.channelEntryKey(c)).filter(Boolean));
    for (const k of Object.keys(next.channelAliases)) if (!entries.has(k)) delete next.channelAliases[k];
    return next;
  }

  // ---- lookup metadata cache (Decision D1) ----
  // Entry: { id, n: channel name, h: @handle, c: channel id, t: [hashtags], full: bool, at: ms }
  function emptyMeta() {
    return { schemaVersion: SCHEMA_VERSION, entries: [] };
  }

  function mergeMeta(stored) {
    const s = stored || {};
    return { schemaVersion: SCHEMA_VERSION, entries: Array.isArray(s.entries) ? s.entries : [] };
  }

  function getMeta(storage) {
    return rawGet([META_KEY], storage).then((r) => mergeMeta(r[META_KEY]));
  }

  function metaFresh(entry, now) {
    return !!(entry && entry.id && typeof entry.at === "number" && now - entry.at <= META_TTL_MS);
  }

  // Pure: replaces the entry with the same id, drops expired entries, bounds the list.
  function metaPut(meta, entry, now, max) {
    const cap = max || META_MAX;
    const next = mergeMeta(JSON.parse(JSON.stringify(mergeMeta(meta))));
    next.entries = next.entries.filter((e) => metaFresh(e, now));
    if (!entry || !entry.id) return next;
    const tags = Array.isArray(entry.t) ? entry.t.filter((x) => typeof x === "string").slice(0, 30) : [];
    const clip = (v) => (typeof v === "string" ? v.slice(0, 120) : "");
    next.entries = next.entries.filter((e) => e.id !== entry.id);
    next.entries.push({ id: String(entry.id).slice(0, 24), n: clip(entry.n), h: clip(entry.h), c: clip(entry.c), t: tags, full: !!entry.full, at: now });
    if (next.entries.length > cap) next.entries.splice(0, next.entries.length - cap);
    return next;
  }

  // ---- serialized queue ----
  function createSerialQueue() {
    let tail = Promise.resolve();
    return {
      enqueue(fn) {
        const run = tail.then(fn, fn);
        tail = run.then(() => undefined, () => undefined);
        return run;
      }
    };
  }

  // ---- migration (v1.0 -> v2) ----
  function migrate(storage) {
    return rawGet([STATE_KEY, STATS_KEY, LEARN_KEY], storage).then((r) => {
      const stored = r[STATE_KEY];
      const out = {};
      const nextSettings = mergeSettings(stored);
      if (stored && stored.focusSession && stored.focusSession.previousToggles &&
          stored.focusSession.previousToggles.blockHashtags === undefined) {
        nextSettings.focusSession.previousToggles = Object.assign({}, stored.focusSession.previousToggles, {
          blockHashtags: DEFAULT_SETTINGS.toggles.blockHashtags
        });
      }
      out[STATE_KEY] = nextSettings;
      if (!r[STATS_KEY]) {
        const seeded = emptyStatsData(null);
        const legacy = stored && stored.stats;
        if (legacy && typeof legacy === "object") Object.assign(seeded.stats, legacy);
        out[STATS_KEY] = seeded;
      } else {
        out[STATS_KEY] = mergeStatsData(r[STATS_KEY]);
      }
      out[LEARN_KEY] = mergeLearn(r[LEARN_KEY]);
      return rawSet(out, storage);
    });
  }

  // ---- import / export ----
  function exportSettings() {
    return getState().then((state) => ({
      toggles: state.toggles,
      blockedChannels: state.blockedChannels,
      blockedKeywords: state.blockedKeywords,
      blockedHashtags: state.blockedHashtags,
      exportedAt: new Date().toISOString(),
      version: 2
    }));
  }

  function sanitizeImport(data) {
    const D = root.YFMDetect;
    if (!data || typeof data !== "object" || Array.isArray(data)) return null;
    const toggles = {};
    if (data.toggles && typeof data.toggles === "object") {
      for (const k of D.KNOWN_TOGGLES) if (typeof data.toggles[k] === "boolean") toggles[k] = data.toggles[k];
    }
    const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim()) : []);
    const channels = [];
    for (const c of strings(data.blockedChannels)) {
      const p = D.parseChannelInput(c);
      if (p && !channels.some((e) => D.channelEntryKey(e) === D.channelKey(p.value))) channels.push(p.entry);
    }
    const keywords = [];
    for (const k of strings(data.blockedKeywords)) {
      const n = D.normalizeText(k);
      if (n && !keywords.some((e) => D.normalizeText(e) === n)) keywords.push(k);
    }
    const out = { toggles, blockedChannels: channels, blockedKeywords: keywords };
    if (Array.isArray(data.blockedHashtags)) {
      const tags = [];
      for (const h of strings(data.blockedHashtags)) {
        const e = D.normalizeHashtagEntry(h);
        if (e && !tags.includes(e)) tags.push(e);
      }
      out.blockedHashtags = tags;
    }
    return out;
  }

  function importSettings(data) {
    const clean = sanitizeImport(data);
    if (!clean) return Promise.reject(new Error("Invalid settings file."));
    return setState(clean);
  }

  return {
    STATE_KEY, STATS_KEY, LEARN_KEY, META_KEY, META_MAX, META_TTL_MS, SCHEMA_VERSION, DEDUPE_MAX, CACHE_MAX, STAT_MODES,
    DEFAULT_SETTINGS, emptyStatsData, emptyLearn, deepMerge, mergeSettings, mergeStatsData,
    mergeLearn, rawGet, rawSet, getState, setState, getWeekStartTimestamp, statsForDisplay,
    getStatsData, getLearn, applyStat, learnPut, aliasPut, learnPrune, createSerialQueue,
    migrate, exportSettings, sanitizeImport, importSettings,
    emptyMeta, mergeMeta, getMeta, metaFresh, metaPut
  };
});
