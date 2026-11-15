/**
 * content.js — injected into www./m.youtube.com pages (never studio. or music.).
 *
 * YouTube is a heavy single-page app, so this script:
 *  - keeps CSS-first hiding (classes on <html>, :has() rules) for instant,
 *    flicker-free toggling,
 *  - adds a debounced, changed-nodes-only pipeline that resolves each tile to
 *    its outermost item container and evaluates it against the rules,
 *  - re-evaluates a container when its title/href/aria-label arrives late,
 *  - reacts to YouTube's own navigation events instead of page loads.
 */

(function () {
  "use strict";

  if (window.__yfmContentLoaded) return;
  if (/^(studio|music)\./i.test(location.hostname)) return;
  window.__yfmContentLoaded = true;

  const D = self.YFMDetect;
  const S = self.YFMStorage;
  const HIDE_ATTR = "data-yfm-hide";
  const FLUSH_DELAY_MS = 40;

  let settings = null;
  let learn = null;
  let rules = null;
  let toggles = {};

  const TOGGLE_TO_CLASS = {
    blockShorts: "yfm-hide-shorts",
    hideHomeFeed: "yfm-hide-home-feed",
    hideUpNext: "yfm-hide-up-next",
    hideComments: "yfm-hide-comments",
    hideExplore: "yfm-hide-explore",
    disableAutoplay: "yfm-disable-autoplay"
  };

  // Synchronous mirror of the six class-toggle booleans (one tiny key, no lists,
  // no stats). chrome.storage stays the single source of truth; the mirror only
  // lets the classes exist at document_start, before the asynchronous storage
  // read returns, so e.g. the related column never paints once. It is rewritten
  // from the real settings on every applyHtmlClasses().
  const MIRROR_KEY = "yfm.cls";
  let lastMirror = null;

  function applyEarlyClasses() {
    const html = document.documentElement;
    if (!html) return;
    let m = null;
    try { m = JSON.parse(localStorage.getItem(MIRROR_KEY) || "null"); } catch (e) { /* blocked or corrupt */ }
    if (m && typeof m === "object") {
      for (const [key, cls] of Object.entries(TOGGLE_TO_CLASS)) html.classList.toggle(cls, m[key] === true);
    }
    html.classList.toggle("yfm-path-home", location.pathname === "/");
  }
  applyEarlyClasses();

  function compile() {
    rules = D.compileRules(settings, learn);
    toggles = rules.toggles;
  }

  function applyHtmlClasses() {
    const html = document.documentElement;
    for (const [key, cls] of Object.entries(TOGGLE_TO_CLASS)) {
      html.classList.toggle(cls, !!toggles[key]);
    }
    html.classList.toggle("yfm-path-home", location.pathname === "/");
    const mirror = {};
    for (const key of Object.keys(TOGGLE_TO_CLASS)) mirror[key] = !!toggles[key];
    const raw = JSON.stringify(mirror);
    if (raw !== lastMirror) {
      lastMirror = raw;
      try { localStorage.setItem(MIRROR_KEY, raw); } catch (e) { /* storage blocked */ }
    }
  }

  // YouTube can rewrite <html class>. Re-apply our classes synchronously (before
  // the next paint) whenever that attribute changes. Our own toggles never fire
  // it again because classList.toggle(token, force) is a no-op when unchanged.
  if (document.documentElement) {
    new MutationObserver(() => {
      if (rules) applyHtmlClasses();
      else applyEarlyClasses();
    }).observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  }

  // ------------------------------------------------------------ item rules
  // ------------------------------------------------------ background messaging
  // Content scripts never write storage themselves. Messages are retried once
  // if the service worker was asleep.
  function send(msg, attempt) {
    try {
      chrome.runtime.sendMessage(msg, () => {
        const err = chrome.runtime.lastError;
        if (err && !attempt) setTimeout(() => send(msg, 1), 500);
      });
    } catch (e) {
      // extension context invalidated (extension was reloaded); nothing to do
    }
  }

  // Per-tab navigation memory (sessionStorage is per tab).
  const tracker = {
    get(k) {
      try { return sessionStorage.getItem("yfm." + k); } catch (e) { return null; }
    },
    set(k, v) {
      try { sessionStorage.setItem("yfm." + k, v); } catch (e) { /* storage blocked */ }
    },
    record() {
      const href = location.href;
      const cur = this.get("cur");
      if (cur !== href) {
        if (cur) this.set("prev", cur);
        this.set("cur", href);
      }
      if (!D.isShortsPath(location.pathname)) this.set("lastNonShorts", href);
    }
  };

  // ------------------------------------------------------------- stat reports
  // Every count is a message to the background queue, which de-dupes and
  // applies it. The in-memory set only avoids re-sending; the background's
  // week-scoped, bounded set is the authority.
  const tabTag = Math.random().toString(36).slice(2, 10);
  let nonceCounter = 0;
  const sentUnique = new Set();
  let sentWeek = 0;

  function reportStat(stat, key) {
    if (S.STAT_MODES[stat] === "unique") {
      if (!key) return;
      const week = S.getWeekStartTimestamp();
      if (week !== sentWeek || sentUnique.size > S.DEDUPE_MAX) {
        sentUnique.clear();
        sentWeek = week;
      }
      const memo = stat + ":" + key;
      if (sentUnique.has(memo)) return;
      sentUnique.add(memo);
    }
    nonceCounter += 1;
    send({ type: "YFM_STAT", stat, key: key || "", nonce: tabTag + ":" + nonceCounter });
  }

  const STAT_FOR_REASON = { channel: "channelsBlocked", keyword: "keywordsBlocked", hashtag: "hashtagsBlocked" };
  const NON_VIDEO_ITEM_SEL = "ytd-guide-entry-renderer,ytd-mini-guide-entry-renderer,ytd-channel-renderer,ytd-grid-channel-renderer";

  // One count per unique video (by video ID; a stable title key when a tile
  // has no video link). Channel cards and guide entries are not videos.
  function countHit(c, reason) {
    const stat = STAT_FOR_REASON[reason];
    if (!stat || c.matches(NON_VIDEO_ITEM_SEL)) return;
    const isPost = D.isPostItem(c);
    let key = isPost ? D.extractPostId(c) : D.extractVideoId(c);
    if (!key && !isPost) {
      const titles = D.extractTitleTexts(c);
      key = titles.length ? "t:" + D.normalizeText(titles[0]).slice(0, 120) : "";
    }
    reportStat(stat, key);
  }

  // Recommendations hidden: once per home view and once per watch view.
  let viewId = 1;
  let firstFinishHandled = false;
  const bootHref = location.href;
  // The location whose view has settled (initial load, or yt-navigate-finish).
  // YouTube fires yt-page-data-updated before yt-navigate-finish, so counting
  // must wait until the view id for the new page exists.
  let settledHref = bootHref;
  const recsCounted = new Set();

  function countRecsOnce(surface) {
    const key = viewId + ":" + surface;
    if (recsCounted.has(key)) return;
    recsCounted.add(key);
    reportStat("recsBlocked", key);
  }

  function countRecommendations() {
    if (location.href !== settledHref) return;
    if (location.pathname === "/" && toggles.hideHomeFeed &&
        document.querySelector('ytd-browse[page-subtype="home"] ytd-rich-item-renderer')) {
      countRecsOnce("home");
    } else if (location.pathname === "/watch" && toggles.hideUpNext &&
        document.querySelector("ytd-watch-next-secondary-results-renderer yt-lockup-view-model," +
          "ytd-watch-next-secondary-results-renderer ytd-compact-video-renderer")) {
      countRecsOnce("watch");
    }
  }


  // ---------------------------------------------------- metadata lookups (D1)
  // Shorts tiles in feeds carry no channel and only the visible caption, so the
  // answer is not in the tile. For those tiles (and only those, never long-video
  // tiles) the extension may ask youtube.com itself for public metadata, within
  // hard limits. Results are cached by the background under yfmMeta.
  // The fetch runs here, in the content script: it is same-origin to the page,
  // needs no new permission, and avoids a service-worker round trip per tile.
  const LOOKUP = { maxActive: 2, spacingMs: 250, maxOembed: 30, maxHtml: 10, failMs: 10 * 60 * 1000 };
  const metaCache = new Map();   // video id -> { id, n, h, c, t, full }
  const metaWaiting = new Map(); // "stage:id" -> containers waiting for the answer
  const metaFailed = new Map();  // video id -> time of last failed lookup
  const metaQueue = [];          // { id, stage }
  const htmlTried = new Set();   // per-ID once for the heavy page lookup
  let metaActive = 0;
  let metaLastStart = 0;
  let metaTimer = null;
  let metaOembedUsed = 0;
  let metaHtmlUsed = 0;

  function loadMeta(entries) {
    const now = Date.now();
    for (const e of entries || []) {
      if (!S.metaFresh(e, now)) continue;
      const cur = metaCache.get(e.id);
      if (!cur || e.full || !cur.full) metaCache.set(e.id, e);
    }
  }

  // Returns true when the caller should treat the item as "answer pending".
  function requestMeta(id, c, stage, priority) {
    const failedAt = metaFailed.get(id);
    if (failedAt && Date.now() - failedAt < LOOKUP.failMs) return false;
    const wk = stage + ":" + id;
    const list = metaWaiting.get(wk);
    if (list) {
      if (c && !list.includes(c)) list.push(c);
      return true;
    }
    if (stage === "oembed") {
      if (metaOembedUsed >= LOOKUP.maxOembed) return false;
      metaOembedUsed += 1;
    } else {
      if (htmlTried.has(id) || metaHtmlUsed >= LOOKUP.maxHtml) return false;
      htmlTried.add(id);
      metaHtmlUsed += 1;
    }
    metaWaiting.set(wk, c ? [c] : []);
    if (priority) metaQueue.unshift({ id, stage });
    else metaQueue.push({ id, stage });
    pumpMeta();
    return true;
  }

  function pumpMeta() {
    clearTimeout(metaTimer);
    metaTimer = null;
    if (document.hidden) return; // resumes on visibilitychange
    while (metaActive < LOOKUP.maxActive && metaQueue.length) {
      const wait = LOOKUP.spacingMs - (Date.now() - metaLastStart);
      if (wait > 0) {
        metaTimer = setTimeout(pumpMeta, wait);
        return;
      }
      metaLastStart = Date.now();
      metaActive += 1;
      runMetaJob(metaQueue.shift());
    }
  }

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) pumpMeta();
  });

  function runMetaJob(job) {
    const url = job.stage === "oembed"
      ? "/oembed?format=json&url=" + encodeURIComponent(location.origin + "/shorts/" + job.id)
      : "/shorts/" + job.id;
    fetch(url, { credentials: "same-origin" })
      .then((res) => {
        if (!res.ok) throw new Error("http " + res.status);
        return job.stage === "oembed" ? res.json() : res.text();
      })
      .then((body) => finishMeta(job, body))
      .catch(() => {
        metaFailed.set(job.id, Date.now());
        settleMeta(job);
      })
      .then(() => {
        metaActive -= 1;
        pumpMeta();
      });
  }

  function finishMeta(job, body) {
    const id = job.id;
    const cur = metaCache.get(id) || { id, n: "", h: "", c: "", t: [], full: false };
    let entry;
    if (job.stage === "oembed") {
      const p = D.parseOembed(body);
      if (!p) throw new Error("empty oembed");
      entry = { id, n: p.n, h: p.h, c: p.c, t: p.t, full: false };
    } else {
      const p = D.parsePlayerResponseHtml(body);
      if (!p.title && !p.description && !p.author) throw new Error("no player response");
      const tags = new Set(cur.t || []);
      D.extractHashtags(p.title).forEach((t) => tags.add(t));
      D.extractHashtags(p.description).forEach((t) => tags.add(t));
      entry = { id, n: cur.n || p.author, h: cur.h, c: cur.c || p.channelId, t: Array.from(tags), full: true };
    }
    metaCache.set(id, entry);
    send({ type: "YFM_META_PUT", entry });
    settleMeta(job);
  }

  // A lookup finished (or failed): re-evaluate exactly the tiles that waited.
  function settleMeta(job) {
    const wk = job.stage + ":" + job.id;
    const list = metaWaiting.get(wk) || [];
    metaWaiting.delete(wk);
    if (!rules) return;
    const containers = new Set(list.filter((el) => el.isConnected));
    if (containers.size) evaluateSets(containers, new Set());
    if (D.isShortsPath(location.pathname)) evaluatePageBlocks();
  }

  function metaVerdict(c) {
    if (toggles.blockShorts) return null; // hidden anyway; never look anything up
    if (!rules.channelsOn && !rules.hashtagsOn) return null;
    if (!D.isShortItem(c)) return null;
    const id = D.extractVideoId(c);
    if (!id) return null;
    // On a channel's own page every Short belongs to that channel (and a blocked
    // channel shows the block screen), so the channel needs no lookup there.
    const needChannel = rules.channelsOn && !D.isChannelPath(location.pathname) &&
      D.extractChannelIdentities(c).keys.size === 0;
    if (!needChannel && !rules.hashtagsOn) return null;
    const entry = metaCache.get(id);
    if (entry) {
      if (needChannel && D.matchChannel(D.metaIdentityKeys(entry), rules)) return "channel";
      if (rules.hashtagsOn && D.matchHashtagAny(entry.t || [], rules)) return "hashtag";
      // Caption/description-only hashtags need the video's own page, once.
      if (rules.hashtagsOn && !entry.full) requestMeta(id, c, "html");
      return null;
    }
    // Hide optimistically until the answer arrives so blocked content never flashes.
    return requestMeta(id, c, "oembed") ? "pending" : null;
  }

  // Direct visit of /shorts/<id> while Block Shorts is OFF.
  function metaPageBlock(id) {
    if (!rules.channelsOn && !rules.hashtagsOn) return null;
    const entry = metaCache.get(id);
    if (!entry) {
      requestMeta(id, null, "oembed", true);
      return null;
    }
    if (rules.channelsOn) {
      const e = D.matchChannel(D.metaIdentityKeys(entry), rules);
      if (e) {
        return {
          key: "short-channel:" + id + ":" + e,
          title: "Channel blocked by YouTube Focus Mode",
          detail: "This channel is on your blocklist. Remove it in the extension popup to see it again."
        };
      }
    }
    if (rules.hashtagsOn) {
      const t = D.matchHashtagAny(entry.t || [], rules);
      if (t) {
        reportStat("hashtagsBlocked", id);
        return {
          key: "short-tag:" + id + ":" + t,
          title: "Video blocked (hashtag #" + t + ")",
          detail: "This video carries a hashtag on your blocklist. Remove it in the extension popup to watch it."
        };
      }
      if (!entry.full) requestMeta(id, null, "html", true);
    }
    return null;
  }

  function verdictFor(c) {
    // The Shorts sidebar entry links to "/shorts/", which isShortsHref() does not accept.
    if (toggles.blockShorts && D.isShortsNavEntry(c)) return "shorts";
    if (toggles.blockShorts && D.isShortItem(c)) return "shorts";
    // A post's author is its first channel link; later links are @mentions.
    if (rules.channelsOn &&
        D.matchChannel((D.isPostItem(c) ? D.extractPostAuthorIdentities(c) : D.extractChannelIdentities(c)).keys, rules)) return "channel";
    if (rules.keywordsOn && D.matchKeywordAny(D.extractTitleTexts(c), rules)) return "keyword";
    if (rules.hashtagsOn) {
      // Layer 1: title, caption, snippet text, aria-labels and /hashtag/ links.
      if (D.matchHashtagAny(D.extractItemHashtags(c), rules)) return "hashtag";
      // Layer 3: a video learned earlier (its description matched when opened).
      const id = D.extractVideoId(c);
      if (id && rules.cache.has(id)) return "hashtag";
    }
    return metaVerdict(c);
  }

  function setHide(el, reason) {
    const cur = el.getAttribute(HIDE_ATTR);
    if (reason) {
      if (cur !== reason) el.setAttribute(HIDE_ATTR, reason);
    } else if (cur !== null) {
      el.removeAttribute(HIDE_ATTR);
    }
  }

  function evaluateContainer(c) {
    if (!c.isConnected) return;
    const reason = verdictFor(c);
    setHide(c, reason);
    if (reason) countHit(c, reason);
    if (reason === null) {
      const shelf = c.closest('[' + HIDE_ATTR + '="shelf"]');
      if (shelf) setHide(shelf, null);
    }
  }

  function hiddenWithin(el, stopAt) {
    for (let n = el; n && n !== stopAt; n = n.parentElement) {
      if (n.hasAttribute(HIDE_ATTR)) return true;
    }
    return false;
  }

  // A shelf is hidden when it is a Shorts-only shelf (Block Shorts on), or
  // when every item inside it is hidden (no empty shelf header left behind).
  function evaluateShelf(shelf) {
    if (!shelf.isConnected) return;
    let reason = null;
    if (toggles.blockShorts && D.shelfIsShortsOnly(shelf)) {
      reason = "shorts";
    } else {
      const items = shelf.querySelectorAll(D.ITEM_SEL);
      if (items.length > 0) {
        let anyVisible = false;
        for (const it of items) {
          if (!hiddenWithin(it, shelf)) { anyVisible = true; break; }
        }
        if (!anyVisible) reason = "shelf";
      }
    }
    setHide(shelf, reason);
  }

  function collectFrom(root, containers, shelves) {
    if (!root || root.nodeType !== 1) return;
    const own = D.itemContainerOf(root);
    if (own) containers.add(own);
    if (root.matches(D.SHELF_SEL)) shelves.add(root);
    for (const el of root.querySelectorAll(D.ITEM_SEL)) {
      const c = D.itemContainerOf(el);
      if (c) containers.add(c);
    }
    for (const s of root.querySelectorAll(D.SHELF_SEL)) shelves.add(s);
    if (toggles.blockShorts) {
      for (const a of root.querySelectorAll('a[href*="/shorts/"]')) {
        const c = D.structuralContainer(a);
        if (c) containers.add(c);
      }
    }
  }

  function addAncestorShelves(c, shelves) {
    let s = c.parentElement && c.parentElement.closest(D.SHELF_SEL);
    while (s) {
      shelves.add(s);
      s = s.parentElement && s.parentElement.closest(D.SHELF_SEL);
    }
  }

  function finishShelves(shelves) {
    // innermost shelves first, so outer sections see inner results
    const ordered = Array.from(shelves).sort((a, b) => (a.contains(b) ? 1 : b.contains(a) ? -1 : 0));
    for (const s of ordered) evaluateShelf(s);
  }

  // Small sets (a lookup answer, a few new tiles) are evaluated synchronously.
  function evaluateSets(containers, shelves) {
    for (const c of containers) {
      evaluateContainer(c);
      addAncestorShelves(c, shelves);
    }
    finishShelves(shelves);
  }

  // Large sets (first paint of a long feed, an infinite-scroll batch, a rule
  // change) are evaluated in time slices so the main thread is never held for
  // long, whatever the machine. Shelves are collapsed after every container of
  // the set has been judged, exactly as in the synchronous path.
  const SLICE_MS = 12;
  const SLICE_THRESHOLD = 12;
  function evaluateSetsSliced(containers, shelves) {
    if (containers.size <= SLICE_THRESHOLD) {
      evaluateSets(containers, shelves);
      return;
    }
    const list = Array.from(containers);
    let i = 0;
    const step = () => {
      const end = performance.now() + SLICE_MS;
      while (i < list.length) {
        const c = list[i++];
        evaluateContainer(c);
        addAncestorShelves(c, shelves);
        if (i < list.length && performance.now() > end) {
          setTimeout(step, 0);
          return;
        }
      }
      finishShelves(shelves);
    };
    step();
  }

  // Full pass: boot, and any rule/settings change. Never runs per mutation.
  function evaluateAll() {
    const containers = new Set();
    const shelves = new Set();
    collectFrom(document.documentElement, containers, shelves);
    for (const el of document.querySelectorAll("[" + HIDE_ATTR + "]")) {
      if (el.matches(D.SHELF_SEL)) shelves.add(el);
      else {
        const c = D.itemContainerOf(el) || el;
        containers.add(c);
      }
    }
    evaluateSetsSliced(containers, shelves);
  }

  // ----------------------------------------------------- pending pipeline
  const pending = new Set();
  let flushScheduled = false;

  function scheduleFlush() {
    if (flushScheduled) return;
    flushScheduled = true;
    setTimeout(flush, FLUSH_DELAY_MS);
  }

  function processPending() {
    if (pending.size === 0) return;
    const roots = Array.from(pending);
    pending.clear();
    const containers = new Set();
    const shelves = new Set();
    for (const r of roots) if (r.isConnected) collectFrom(r, containers, shelves);
    evaluateSetsSliced(containers, shelves);
  }

  function flush() {
    flushScheduled = false;
    if (!rules) return;
    processPending();
    pageLevel();
  }

  function isOwn(el) {
    return !!(el && el.id && el.id.indexOf("yfm-") === 0);
  }

  function inPlayer(el) {
    return !!(el.closest && el.closest("#movie_player,.html5-video-player") &&
      !el.closest(".ytp-endscreen-content,.ytp-ce-element"));
  }

  const observer = new MutationObserver((records) => {
    let any = false;
    for (const m of records) {
      if (m.type === "childList") {
        if (m.addedNodes.length === 0 || isOwn(m.target)) continue;
        for (const n of m.addedNodes) {
          if (n.nodeType === 1) {
            if (!isOwn(n)) { pending.add(n); any = true; }
          } else if (n.nodeType === 3) {
            const c = D.itemContainerOf(m.target);
            if (c) { pending.add(c); any = true; }
          }
        }
      } else {
        const el = m.type === "characterData" ? m.target.parentElement : m.target;
        if (!el || isOwn(el) || inPlayer(el)) continue;
        const c = D.itemContainerOf(el);
        if (c) { pending.add(c); any = true; }
      }
    }
    if (any) scheduleFlush();
  });

  function startObserving() {
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["href", "title", "aria-label"]
    });
  }

  // ------------------------------------------------------- page-level rules
  // Shortcut labels double as the search each one runs. Edit here to change them.
  const HOME_SHORTCUTS = [
    { label: "Tutorials", tint: "blue", icon: "M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2V5zM8 7h7M8 11h7" },
    { label: "Documentaries", tint: "violet", icon: "M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z" },
    { label: "Lectures", tint: "green", icon: "M2 9l10-5 10 5-10 5L2 9zM6 11.5V16c0 1.5 3 3 6 3s6-1.5 6-3v-4.5" }
  ];
  const SVG_NS = "http://www.w3.org/2000/svg";

  function svgIcon(size, paths, extra) {
    const svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("width", String(size));
    svg.setAttribute("height", String(size));
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    svg.setAttribute("aria-hidden", "true");
    for (const d of [].concat(paths)) {
      const p = document.createElementNS(SVG_NS, "path");
      p.setAttribute("d", d);
      svg.appendChild(p);
    }
    if (extra) svg.appendChild(extra);
    return svg;
  }

  function runHomeSearch(text) {
    const q = String(text || "").trim();
    if (!q) return;
    location.assign("/results?search_query=" + encodeURIComponent(q));
  }

  function buildHomePlaceholder() {
    const root = document.createElement("div");
    root.id = "yfm-home-placeholder";

    const h1 = document.createElement("h1");
    const and = document.createElement("span");
    and.className = "yfm-ph-and";
    and.textContent = "and";
    h1.append("Search ", and, " Learn");

    const field = document.createElement("div");
    field.className = "yfm-ph-field";
    const circle = document.createElementNS(SVG_NS, "circle");
    circle.setAttribute("cx", "11");
    circle.setAttribute("cy", "11");
    circle.setAttribute("r", "7");
    const input = document.createElement("input");
    input.type = "text";
    input.className = "yfm-ph-input";
    input.setAttribute("aria-label", "Search YouTube");
    input.setAttribute("autocomplete", "off");
    input.setAttribute("maxlength", "200");
    input.placeholder = "What do you want to learn today?";
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.isComposing) runHomeSearch(input.value);
    });
    const go = document.createElement("button");
    go.type = "button";
    go.className = "yfm-ph-go";
    go.setAttribute("aria-label", "Search");
    go.appendChild(svgIcon(20, "M5 12h14M13 6l6 6-6 6"));
    go.addEventListener("click", () => runHomeSearch(input.value));
    field.append(svgIcon(22, "M21 21l-4.5-4.5", circle), input, go);

    const shortcuts = document.createElement("div");
    shortcuts.className = "yfm-ph-shortcuts";
    shortcuts.setAttribute("role", "group");
    shortcuts.setAttribute("aria-label", "Quick searches");
    for (const sc of HOME_SHORTCUTS) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "yfm-ph-chip";
      const dot = document.createElement("span");
      dot.className = "yfm-ph-dot";
      dot.setAttribute("data-tint", sc.tint);
      dot.appendChild(svgIcon(26, sc.icon));
      const label = document.createElement("span");
      label.textContent = sc.label;
      b.append(dot, label);
      b.addEventListener("click", () => runHomeSearch(sc.label));
      shortcuts.appendChild(b);
    }

    root.append(h1, field, shortcuts);
    return root;
  }

  function insertHomePlaceholder() {
    const onHome = location.pathname === "/";
    const existing = document.getElementById("yfm-home-placeholder");
    if (!toggles.hideHomeFeed || !onHome) {
      if (existing) existing.remove();
      return;
    }
    if (existing) return;
    const container =
      document.querySelector('ytd-browse[page-subtype="home"] ytd-two-column-browse-results-renderer') ||
      document.querySelector("ytd-two-column-browse-results-renderer");
    if (!container) return;
    container.appendChild(buildHomePlaceholder());
  }

  // Autoplay: the switch is hidden by CSS (html.yfm-disable-autoplay) and kept
  // OFF here. The state is watched with an observer on each switch's
  // aria-checked, so any flip back to ON (account sync, YouTube itself) is undone
  // at once. The click budget stops a tug-of-war if YouTube keeps re-enabling it.
  const autoplayWatched = new WeakSet();
  let autoplayObserver = null;
  const autoplayClicks = new WeakMap(); // per switch, so one stubborn switch never starves another

  function switchAutoplayOff(el) {
    if (!toggles.disableAutoplay || el.getAttribute("aria-checked") !== "true") return;
    const now = Date.now();
    const recent = (autoplayClicks.get(el) || []).filter((t) => now - t < 10000);
    if (recent.length >= 6) { autoplayClicks.set(el, recent); return; }
    recent.push(now);
    autoplayClicks.set(el, recent);
    el.click();
  }

  function disableAutoplayIfNeeded() {
    if (!toggles.disableAutoplay) return;
    if (!/^\/watch/.test(location.pathname)) return;
    if (!autoplayObserver) {
      autoplayObserver = new MutationObserver((records) => {
        for (const m of records) switchAutoplayOff(m.target);
      });
    }
    for (const el of document.querySelectorAll(".ytp-autonav-toggle-button")) {
      switchAutoplayOff(el);
      if (!autoplayWatched.has(el)) {
        autoplayWatched.add(el);
        autoplayObserver.observe(el, { attributes: true, attributeFilter: ["aria-checked"] });
      }
    }
  }

  // The Explore section has no distinguishing href, so it is found by its header
  // text (English UI only). Marking is always on; hiding is gated by the
  // html.yfm-hide-explore class, so toggling needs no JS.
  function markExploreSections() {
    for (const sec of document.querySelectorAll("ytd-guide-section-renderer")) {
      const h = sec.querySelector("#guide-section-title, h3");
      const isExplore = !!h && D.normalizeText(h.textContent) === "explore";
      if (isExplore) {
        if (!sec.hasAttribute("data-yfm-explore")) sec.setAttribute("data-yfm-explore", "");
      } else if (sec.hasAttribute("data-yfm-explore")) {
        sec.removeAttribute("data-yfm-explore");
      }
    }
  }

  function pageLevel() {
    if (!rules) return;
    applyHtmlClasses();
    insertHomePlaceholder();
    disableAutoplayIfNeeded();
    markExploreSections();
    evaluateShortsPlayer();
    evaluatePageBlocks();
    countRecommendations();
  }

  // ------------------------------------------------------------ block screen
  // The screen carries id="yfm-block-screen" and never the hide attribute, so
  // the item-hiding rule can never hide it.
  let playGuard = null;

  function pauseVideos() {
    for (const v of document.querySelectorAll("video")) {
      try { v.pause(); } catch (e) { /* not ready */ }
    }
  }

  function goBack() {
    const prev = tracker.get("prev");
    const home = location.origin + "/";
    if (!prev) {
      location.assign(home);
      return;
    }
    const before = location.href;
    history.back();
    setTimeout(() => {
      if (location.href === before) location.assign(home);
    }, 800);
  }

  function removeBlockScreen() {
    const el = document.getElementById("yfm-block-screen");
    if (el) el.remove();
    if (playGuard) {
      document.removeEventListener("play", playGuard, true);
      playGuard = null;
    }
  }

  function showBlockScreen(block) {
    removeBlockScreen();
    const wrap = document.createElement("div");
    wrap.id = "yfm-block-screen";
    wrap.setAttribute("role", "alertdialog");
    wrap.setAttribute("data-key", block.key);
    const h = document.createElement("h2");
    h.textContent = block.title;
    const p = document.createElement("p");
    p.textContent = block.detail;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Go back";
    btn.addEventListener("click", goBack);
    wrap.append(h, p, btn);
    document.documentElement.appendChild(wrap);
    playGuard = (e) => {
      if (e.target && e.target.tagName === "VIDEO") e.target.pause();
    };
    document.addEventListener("play", playGuard, true);
    pauseVideos();
  }

  function applyBlock(block) {
    const existing = document.getElementById("yfm-block-screen");
    if (!block) {
      if (existing) removeBlockScreen();
      return;
    }
    if (existing && existing.getAttribute("data-key") === block.key) {
      pauseVideos();
      return;
    }
    showBlockScreen(block);
  }

  // Alias learning: remember every identity seen together on a blocked
  // channel's own page (name + handle + id), so later matches work in any form.
  const learnedAliasSigs = new Set();
  function learnAliases(keys, entryKey) {
    if (keys.size < 2 || keys.size > 6) return;
    const list = Array.from(keys).sort();
    const sig = entryKey + "|" + list.join(",");
    if (learnedAliasSigs.has(sig)) return;
    learnedAliasSigs.add(sig);
    send({ type: "YFM_LEARN_ALIAS", entries: [entryKey], keys: list });
  }

  function channelBlockFor(identities, keyPrefix) {
    const entry = D.matchChannel(identities.keys, rules);
    if (!entry) return null;
    learnAliases(identities.keys, entry);
    return {
      key: keyPrefix + entry,
      title: "Channel blocked by YouTube Focus Mode",
      detail: "This channel is on your blocklist. Remove it in the extension popup to see it again."
    };
  }

  // A post's own page (/post/<id>): same author / hashtag rules as the feed tile.
  function postPageBlock() {
    const post = document.querySelector(D.POST_SEL);
    if (!post) return null;
    const pid = D.postIdFromHref(location.pathname);
    const eid = D.extractPostId(post);
    if (pid && eid && pid !== eid) return null; // stale post from the previous page
    if (rules.channelsOn) {
      const b = channelBlockFor(D.extractPostAuthorIdentities(post), "post-channel:");
      if (b) return b;
    }
    if (rules.hashtagsOn) {
      const tag = D.matchHashtagAny(D.extractItemHashtags(post), rules);
      if (tag) {
        if (pid || eid) reportStat("hashtagsBlocked", pid || eid);
        return {
          key: "post-tag:" + (pid || eid) + ":" + tag,
          title: "Post blocked (hashtag #" + tag + ")",
          detail: "This post carries a hashtag on your blocklist. Remove it in the extension popup to see it."
        };
      }
    }
    return null;
  }

  function pageBlock() {
    const path = location.pathname;
    if (toggles.blockHashtags && rules.tagSet.size > 0 && /^\/hashtag\//.test(path)) {
      const tag = D.hashtagFromHref(location.href);
      if (rules.tagSet.has(tag)) {
        return {
          key: "hashtag-page:" + tag,
          title: "Hashtag blocked by YouTube Focus Mode",
          detail: "#" + tag + " is on your blocklist. Remove it in the extension popup to see this page again."
        };
      }
    }
    if (D.isShortsPath(path) && !toggles.blockShorts && shortsFallback && shortsFallback.id === path.split("/")[2]) {
      return shortsFallback.block;
    }
    if (D.isShortsPath(path) && !toggles.blockShorts) {
      const mb = metaPageBlock(path.split("/")[2]);
      if (mb) return mb;
    }
    if (/^\/post\//.test(path) && (rules.channelsOn || rules.hashtagsOn)) {
      const pb = postPageBlock();
      if (pb) return pb;
    }
    if (toggles.blockChannels && rules.channelKeyToEntry.size > 0) {
      if (D.isChannelPath(path)) {
        const r = D.readChannelPage(document, location);
        const b = channelBlockFor(r.identities, "channel:");
        if (b) return b;
      }
    }
    // /live/<id> opens the same watch page as /watch?v=<id>.
    const liveId = /^\/live\/([\w-]{6,20})/.exec(path);
    if (path === "/watch" || liveId) {
      const data = liveId
        ? D.readWatchPage(document, { href: location.origin + "/watch?v=" + liveId[1], pathname: "/watch" })
        : D.readWatchPage(document, location);
      if (data && data.fresh) {
        if (toggles.blockChannels && rules.channelKeyToEntry.size > 0) {
          const b = channelBlockFor(data.identities, "watch-channel:");
          if (b) return b;
        }
        if (toggles.blockHashtags && rules.tagSet.size > 0) {
          const hit = watchHashtagHit(data);
          if (hit) {
            hashtagVideoBlocked(data.videoId, hit.tag, hit.fromCache);
            return {
              key: "watch-tag:" + data.videoId + ":" + hit.tag,
              title: "Video blocked (hashtag #" + hit.tag + ")",
              detail: "This video carries a hashtag on your blocklist. Remove it in the extension popup to watch it."
            };
          }
        }
      }
    }
    return null;
  }

  function evaluatePageBlocks() {
    applyBlock(pageBlock());
  }

  // Data on a freshly navigated page arrives late. Re-check a few times, then stop.
  let retryTimers = [];
  function scheduleRetries() {
    retryTimers.forEach(clearTimeout);
    const href = location.href;
    retryTimers = [250, 700, 1500, 3000, 6000].map((ms) =>
      setTimeout(() => {
        if (location.href === href && rules) evaluatePageBlocks();
      }, ms));
  }

  // ----------------------------------------------------- Shorts: two layers
  // Layer A intercepts clicks/middle-clicks/Enter/Space on any Shorts link (this
  // also covers links in comments and descriptions that hiding rules never
  // reach). Layer B guards entries that are not link clicks (programmatic SPA
  // navigation, back/forward). Both share one attempt guard keyed by the
  // target URL, so the same attempt is never counted twice.
  const shortsGuard = D.createAttemptGuard({ windowMs: 2500, redirectGapMs: 1000, continuationMs: 2500 });
  let navPrev = null;
  let shortsRecheckTimer = null;
  let shortsRechecks = 0;

  function showToast(text) {
    const old = document.getElementById("yfm-toast");
    if (old) old.remove();
    const el = document.createElement("div");
    el.id = "yfm-toast";
    el.setAttribute("role", "status");
    el.textContent = text;
    document.documentElement.appendChild(el);
    setTimeout(() => el.remove(), 1800);
  }

  function shortsLinkFromEvent(e) {
    const path = e.composedPath ? e.composedPath() : [];
    for (const n of path) {
      if (n === document) break;
      if (n && n.tagName === "A" && n.getAttribute && D.isShortsHref(n.getAttribute("href"))) return n;
    }
    return null;
  }

  function onShortsActivate(e) {
    if (!rules || !toggles.blockShorts) return;
    if (e.type === "keydown" && e.key !== "Enter" && e.key !== " ") return;
    if (e.type === "click" && e.button !== 0) return;
    if (e.type === "auxclick" && e.button !== 1) return;
    const a = shortsLinkFromEvent(e);
    if (!a) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const url = new URL(a.getAttribute("href"), location.href).href.split("#")[0];
    if (shortsGuard.attempt(url, Date.now()).isNew) {
      reportStat("shortsBlocked", url);
      showToast("Short blocked");
    }
  }

  ["click", "auxclick", "keydown"].forEach((type) => document.addEventListener(type, onShortsActivate, true));

  function referrerIsYoutube() {
    try {
      return /(^|\.)youtube\.com$/i.test(new URL(document.referrer).hostname);
    } catch (e) {
      return false;
    }
  }

  function sameOriginUrl(url) {
    try {
      return new URL(url).origin === location.origin ? url : null;
    } catch (e) {
      return null;
    }
  }

  function scheduleShortsRecheck(ms) {
    if (shortsRechecks >= 4) return;
    shortsRechecks += 1;
    clearTimeout(shortsRecheckTimer);
    shortsRecheckTimer = setTimeout(() => handleShortsUrl("guard"), ms + 20);
  }

  function handleShortsUrl(trigger) {
    if (!rules || !toggles.blockShorts) return;
    if (!D.isShortsPath(location.pathname)) {
      shortsRechecks = 0;
      return;
    }
    const now = Date.now();
    const url = location.href.split("#")[0];
    const continuation = shortsGuard.inContinuation(now);
    const first = shortsGuard.attempt(url, now);
    const dec = D.decideShortsRedirect({
      trigger,
      continuation,
      navPrev: navPrev && now - navPrev.at < 15000 ? navPrev.url : null,
      lastNonShorts: sameOriginUrl(tracker.get("lastNonShorts")),
      referrerIsYoutube: referrerIsYoutube()
    });
    if (dec.count && first.isNew && !continuation) reportStat("shortsBlocked", url);
    if (!shortsGuard.canRedirect(now)) {
      scheduleShortsRecheck(shortsGuard.msUntilRedirect(now));
      return;
    }
    shortsGuard.markRedirect(now);
    if (first.isNew) showToast("Short blocked");
    if (dec.action === "back") {
      history.back();
      setTimeout(() => handleShortsUrl("guard"), 700);
    } else if (dec.action === "replace" && dec.url) {
      location.replace(dec.url);
    } else {
      location.replace(location.origin + "/");
    }
  }

  // ------------------------------------------------------------- hashtags
  // Layer 2: read what the opened video really carries (live DOM first;
  // metadata only when it is fresh for this video). Layer 3: remember the
  // video ID so every list hides it afterwards.
  function watchHashtagHit(data) {
    const tags = new Set(data.tags);
    for (const text of data.texts) D.extractHashtags(text).forEach((t) => tags.add(t));
    const live = D.matchHashtagAny(tags, rules);
    if (live) return { tag: live, fromCache: false };
    const cached = rules.cache.get(data.videoId);
    return cached ? { tag: cached, fromCache: true } : null;
  }

  const learnedTagKeys = new Set();
  function hashtagVideoBlocked(videoId, tag, fromCache) {
    if (!fromCache && !learnedTagKeys.has(videoId + ":" + tag)) {
      learnedTagKeys.add(videoId + ":" + tag);
      send({ type: "YFM_LEARN_HASHTAG", videoId, tag });
    }
    reportStat("hashtagsBlocked", videoId);
  }

  // Shorts player (only reachable when Block Shorts is OFF): a Short whose
  // channel, caption or hashtags match is hidden and the player advances.
  let shortsFallback = null;
  const shortSkips = [];

  function clearShortsMarks() {
    for (const r of document.querySelectorAll("ytd-reel-video-renderer[" + HIDE_ATTR + "]")) r.removeAttribute(HIDE_ATTR);
  }

  function evaluateShortsPlayer() {
    const id = location.pathname.split("/")[2];
    if (!D.isShortsPath(location.pathname) || toggles.blockShorts) {
      clearShortsMarks();
      shortsFallback = null;
      return;
    }
    if (shortsFallback && shortsFallback.id !== id) shortsFallback = null;
    const reel = document.querySelector(D.REEL_ACTIVE_SEL);
    if (!reel) return;
    const info = D.readShortsReel(reel);
    const tags = new Set(info.tags);
    for (const text of info.texts) D.extractHashtags(text).forEach((t) => tags.add(t));
    let stat = null;
    let tag = null;
    if (rules.channelsOn && D.matchChannel(info.identities.keys, rules)) stat = "channelsBlocked";
    else if (rules.keywordsOn && D.matchKeywordAny(info.texts, rules)) stat = "keywordsBlocked";
    else if (rules.hashtagsOn) {
      tag = D.matchHashtagAny(tags, rules);
      const cached = rules.cache.get(id);
      if (tag || cached) {
        stat = "hashtagsBlocked";
        tag = tag || cached;
        if (!rules.cache.has(id)) hashtagVideoBlocked(id, tag, false);
      }
    }
    if (!stat) {
      clearShortsMarks();
      shortsFallback = null;
      return;
    }
    setHide(reel, "short-player");
    for (const v of reel.querySelectorAll("video")) {
      try { v.pause(); } catch (e) { /* not ready */ }
    }
    reportStat(stat, id);
    if (shortsFallback) return;
    const now = Date.now();
    while (shortSkips.length && now - shortSkips[0] > 8000) shortSkips.shift();
    const next = document.querySelector("#navigation-button-down button");
    if (!next || shortSkips.length >= 5) {
      shortsFallback = {
        id,
        block: {
          key: "short:" + id,
          title: "Short blocked by YouTube Focus Mode",
          detail: "This Short matches your blocklist."
        }
      };
      return;
    }
    shortSkips.push(now);
    next.click();
  }


  // ------------------------------------------------------------- events
  document.addEventListener("yt-navigate-start", () => {
    if (rules) applyHtmlClasses();
    if (!D.isShortsPath(location.pathname)) navPrev = { url: location.href, at: Date.now() };
    handleShortsUrl("nav");
  });

  document.addEventListener("yt-navigate-finish", () => {
    tracker.record();
    // lookup budgets are per page view; queued work for the old view is dropped
    metaOembedUsed = 0;
    metaHtmlUsed = 0;
    metaQueue.length = 0;
    metaWaiting.clear();
    // the initial load also fires a navigate-finish; it is not a new view
    if (firstFinishHandled || location.href !== bootHref) viewId += 1;
    firstFinishHandled = true;
    settledHref = location.href;
    handleShortsUrl("finish");
    pageLevel();
    scheduleRetries();
  });

  document.addEventListener("yt-page-data-updated", () => {
    if (rules) pageLevel();
  });

  window.addEventListener("popstate", () => {
    tracker.record();
    if (!rules) return;
    handleShortsUrl("popstate");
    pageLevel();
    scheduleRetries();
  });

  function onStorageChanged(changes, areaName) {
    if (areaName !== "local") return;
    if (changes[S.META_KEY]) loadMeta(S.mergeMeta(changes[S.META_KEY].newValue).entries);
    let changed = false;
    if (changes[S.STATE_KEY]) {
      settings = S.mergeSettings(changes[S.STATE_KEY].newValue);
      changed = true;
    }
    if (changes[S.LEARN_KEY]) {
      learn = S.mergeLearn(changes[S.LEARN_KEY].newValue);
      changed = true;
    }
    if (!changed || !settings) return;
    const wasBlockingShorts = !!toggles.blockShorts;
    compile();
    applyHtmlClasses();
    evaluateAll();
    pageLevel();
    if (toggles.blockShorts && !wasBlockingShorts) handleShortsUrl("toggle");
  }

  chrome.storage.onChanged.addListener(onStorageChanged);

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message && message.type === "YFM_PING") {
      sendResponse({ ok: true });
    }
    return false;
  });

  // -------------------------------------------------------------- boot
  function boot() {
    Promise.all([S.getState(), S.getLearn(), S.getMeta()]).then(([s, l, m]) => {
      settings = s;
      learn = l;
      loadMeta(m.entries);
      compile();
      applyHtmlClasses();
      evaluateAll();
      pageLevel();
      startObserving();
      tracker.record();
      // a long-lived document means we were injected into an already-open tab
      handleShortsUrl(performance.now() > 15000 ? "toggle" : "load");
      scheduleRetries();
    });
  }

  boot();
})();
