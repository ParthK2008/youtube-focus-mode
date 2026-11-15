/**
 * detect.js
 * Pure detection and matching logic for YouTube Focus Mode.
 * No chrome.* calls. DOM helpers only use standard Element/Document APIs,
 * so everything here is unit-testable. Loaded before storage.js/content.js.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.YFMDetect = api;
})(typeof self !== "undefined" ? self : globalThis, function () {
  "use strict";

  const YT_ORIGIN = "https://www.youtube.com";

  // ---------------------------------------------------------------- text
  function stripDiacritics(s) {
    return String(s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").normalize("NFC");
  }

  // Lowercase, strip Latin-style accents, drop zero-width chars, collapse whitespace.
  function normalizeText(s) {
    if (s === null || s === undefined) return "";
    return stripDiacritics(s)
      .replace(/[\u200b-\u200d\ufeff]/g, "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .trim();
  }

  // ------------------------------------------------------------ keywords
  // The rule search has always used: case-insensitive substring of the title.
  // v1.1 only adds whitespace + accent normalization, on every surface.
  function matchesKeyword(title, keyword) {
    const k = normalizeText(keyword);
    if (!k) return false;
    return normalizeText(title).includes(k);
  }

  // ------------------------------------------------------------ hashtags
  const TAG_CHAR = "\\p{L}\\p{M}\\p{N}_";
  // A "#" glued directly to a preceding letter/digit/underscore (word#gaming,
  // page#section) is NOT a hashtag. This is the single documented rule and it
  // is applied on every surface.
  const HASHTAG_RE = new RegExp("(?<![" + TAG_CHAR + "])#([" + TAG_CHAR + "]+)", "gu");

  function normalizeTag(t) {
    return normalizeText(t).replace(new RegExp("[^" + TAG_CHAR + "]", "gu"), "");
  }

  function extractHashtags(text) {
    const out = [];
    if (!text) return out;
    const s = String(text);
    for (const m of s.matchAll(HASHTAG_RE)) {
      const tag = normalizeTag(m[1]);
      if (tag && !out.includes(tag)) out.push(tag);
    }
    return out;
  }

  function hashtagFromHref(href) {
    if (!href) return "";
    try {
      const u = new URL(href, YT_ORIGIN);
      const m = /^\/hashtag\/([^/]+)/.exec(u.pathname);
      return m ? normalizeTag(decodeURIComponent(m[1])) : "";
    } catch (e) {
      return "";
    }
  }

  // matchesHashtag("Best #Gaming setup", "#gaming") -> true
  // matchesHashtag("#gamingsetup", "#gaming") -> false (whole-token match)
  // matchesHashtag("gaming", "#gaming") -> false (plain word)
  function matchesHashtag(text, entry) {
    const want = normalizeTag(String(entry || "").replace(/^#+/, ""));
    if (!want) return false;
    return extractHashtags(text).includes(want);
  }

  // Storage form: lowercase, one leading "#", no spaces/punctuation.
  function normalizeHashtagEntry(raw) {
    let s = String(raw === null || raw === undefined ? "" : raw).trim().toLowerCase();
    s = s.replace(/^#+/, "");
    s = s.replace(new RegExp("[^" + TAG_CHAR + "]", "gu"), "");
    return s ? "#" + s : "";
  }

  function hashtagKey(entry) {
    return normalizeTag(String(entry || "").replace(/^#+/, ""));
  }

  // ------------------------------------------------------------ channels
  const CHANNEL_ID_RE = /^UC[\w-]{22}$/;

  function safeDecode(s) {
    try {
      return decodeURIComponent(s);
    } catch (e) {
      return s;
    }
  }

  function isYoutubeHost(host) {
    return /(^|\.)youtube\.com$/i.test(host || "");
  }

  // Parses a pathname into a channel identity, or null.
  function parseChannelPath(pathname) {
    let m = /^\/(@[^/?#]+)/.exec(pathname || "");
    if (m) return { kind: "handle", value: safeDecode(m[1]) };
    m = /^\/channel\/(UC[\w-]{22})(?:[/?#]|$)/.exec(pathname || "");
    if (m) return { kind: "id", value: m[1] };
    m = /^\/c\/([^/?#]+)/.exec(pathname || "");
    if (m) return { kind: "custom", value: safeDecode(m[1]) };
    m = /^\/user\/([^/?#]+)/.exec(pathname || "");
    if (m) return { kind: "user", value: safeDecode(m[1]) };
    return null;
  }

  function parseChannelHref(href) {
    if (!href) return null;
    try {
      const u = new URL(href, YT_ORIGIN);
      if (!isYoutubeHost(u.hostname)) return null;
      return parseChannelPath(u.pathname);
    } catch (e) {
      return null;
    }
  }

  function isChannelPath(pathname) {
    return parseChannelPath(pathname) !== null;
  }

  // Popup input: display name, @handle, UC id, or full channel URL.
  // Returns { kind, value, entry } or null when it is a URL that is not a channel.
  function parseChannelInput(raw) {
    const s = String(raw === null || raw === undefined ? "" : raw).trim();
    if (!s) return null;
    if (/^(https?:\/\/)?((www|m)\.)?youtube\.com(\/|$)/i.test(s)) {
      const parsed = parseChannelHref(/^https?:/i.test(s) ? s : "https://" + s);
      if (!parsed) return null;
      const entry =
        parsed.kind === "custom" ? "/c/" + parsed.value :
        parsed.kind === "user" ? "/user/" + parsed.value :
        parsed.value;
      return { kind: parsed.kind, value: parsed.value, entry };
    }
    if (s.charAt(0) === "@") {
      const h = s.replace(/\s+/g, "");
      return h.length > 1 ? { kind: "handle", value: h, entry: h } : null;
    }
    if (CHANNEL_ID_RE.test(s)) return { kind: "id", value: s, entry: s };
    return { kind: "name", value: s, entry: s };
  }

  // Comparison key: case-insensitive, no whitespace, no accents, no leading "@".
  function channelKey(value) {
    return normalizeText(value)
      .replace(/^\/(c|user)\//, "")
      .replace(/\s+/g, "")
      .replace(/^@/, "");
  }

  function channelEntryKey(entry) {
    const p = parseChannelInput(entry);
    return p ? channelKey(p.value) : "";
  }

  // "Some Title by Channel Name 1.2M views 2 years ago 10 minutes" -> "Channel Name"
  const BY_RE = /\sby\s(.+?)\s+(?:[\d.,]+\s*[KMBkmb]?\s+(?:views?|watching)|No views|\d+\s+(?:second|minute|hour|day|week|month|year)s?\s+ago)/i;
  function extractByFromAria(label) {
    if (!label) return "";
    const m = BY_RE.exec(String(label));
    return m ? m[1].trim() : "";
  }

  function trimAriaTitle(label) {
    const s = String(label || "");
    const m = BY_RE.exec(s);
    if (m) return s.slice(0, m.index).trim();
    return s.replace(/,\s*[\d.,]+\s*[KMBkmb]?\s+views?\s*-\s*play Short\s*$/i, "").trim();
  }

  // ----------------------------------------------------------- selectors
  const ITEM_TAGS = [
    "ytd-video-renderer", "ytd-grid-video-renderer", "ytd-rich-item-renderer",
    "ytd-compact-video-renderer", "ytd-compact-radio-renderer",
    "ytd-compact-playlist-renderer", "ytd-playlist-renderer",
    "ytd-grid-playlist-renderer", "ytd-radio-renderer",
    "ytd-playlist-video-renderer", "ytd-playlist-panel-video-renderer",
    "ytd-reel-item-renderer", "ytd-channel-renderer", "ytd-grid-channel-renderer",
    "ytd-guide-entry-renderer", "ytd-mini-guide-entry-renderer",
    "yt-lockup-view-model", "ytm-shorts-lockup-view-model",
    "ytm-shorts-lockup-view-model-v2",
    // community posts (feed, search, channel Community tab, /post/<id> page)
    "ytd-post-renderer", "ytd-backstage-post-thread-renderer", "ytd-backstage-post-renderer"
  ];
  const ITEM_SEL = ITEM_TAGS.concat([".ytp-videowall-still", ".ytp-ce-element"]).join(",");
  const SHELF_SEL = [
    "ytd-reel-shelf-renderer", "ytd-rich-shelf-renderer", "ytd-rich-section-renderer",
    "ytd-shelf-renderer", "grid-shelf-view-model"
  ].join(",");
  const SHORTS_TAG_SEL =
    "ytm-shorts-lockup-view-model,ytm-shorts-lockup-view-model-v2,ytd-reel-item-renderer";
  const SHORTS_SHELF_SEL = "ytd-reel-shelf-renderer,ytd-rich-shelf-renderer[is-shorts]";
  const TILE_BOUNDARY_SEL =
    "ytd-comments,#comments,#description,ytd-watch-metadata,ytd-text-inline-expander," +
    "ytd-engagement-panel-section-list-renderer,ytd-masthead,#guide,ytd-shorts,#chat";

  // ------------------------------------------------------------- shorts
  function isShortsHref(href) {
    if (!href || href.indexOf("/shorts") === -1) return false;
    try {
      const u = new URL(href, YT_ORIGIN);
      return isYoutubeHost(u.hostname) && (/^\/shorts\/[^/]+/.test(u.pathname) || u.pathname === "/shorts");
    } catch (e) {
      return false;
    }
  }

  function isShortsPath(pathname) {
    return /^\/shorts\/[^/]+/.test(pathname || "");
  }

  function itemContainerOf(el) {
    if (!el || !el.closest) return null;
    let c = el.closest(ITEM_SEL);
    if (!c) return null;
    for (;;) {
      const p = c.parentElement;
      const outer = p && p.closest(ITEM_SEL);
      if (!outer) return c;
      c = outer;
    }
  }

  // Structure-based Short check: Shorts link, Shorts lockup element or Shorts
  // overlay badge, or living inside a Shorts shelf. Never relies on one tag.
  function isShortItem(c) {
    if (!c || !c.querySelector) return false;
    if (c.matches(SHORTS_TAG_SEL) || c.querySelector(SHORTS_TAG_SEL)) return true;
    if (c.closest(SHORTS_SHELF_SEL)) return true;
    if (c.querySelector('[overlay-style="SHORTS"]')) return true;
    const links = c.tagName === "A" ? [c] : c.querySelectorAll("a[href]");
    if (c.tagName === "A" && isShortsHref(c.getAttribute("href"))) return true;
    for (const a of links) {
      if (isShortsHref(a.getAttribute("href"))) return true;
    }
    return false;
  }

  // A shelf is a Shorts shelf when it is a known Shorts shelf, or when every
  // video-ish link inside it is a Short (and there is at least one).
  function shelfIsShortsOnly(shelf) {
    if (!shelf || !shelf.querySelectorAll) return false;
    if (shelf.matches(SHORTS_SHELF_SEL)) return true;
    if (shelf.querySelector(SHORTS_SHELF_SEL) && !shelf.querySelector('a[href*="/watch"]')) return true;
    let shorts = 0;
    let other = 0;
    for (const a of shelf.querySelectorAll("a[href]")) {
      const href = a.getAttribute("href");
      if (isShortsHref(href)) shorts++;
      else if (/\/watch\?/.test(href) || /\/playlist\?/.test(href)) other++;
    }
    if (shelf.querySelector(SHORTS_TAG_SEL) && other === 0) return true;
    return shorts > 0 && other === 0;
  }

  // Fallback for unknown wrappers: a thumbnail-like Shorts link outside any
  // known item. Climb while the parent still holds exactly one video.
  function structuralContainer(a) {
    if (!a || !a.closest || a.closest(ITEM_SEL) || a.closest(TILE_BOUNDARY_SEL)) return null;
    if (!a.querySelector("img,yt-image,yt-img-shadow,yt-thumbnail-view-model,ytd-thumbnail") &&
        !a.closest("ytd-thumbnail,yt-thumbnail-view-model")) return null;
    let cur = a;
    for (let depth = 0; depth < 8; depth++) {
      const p = cur.parentElement;
      if (!p || p === a.ownerDocument.body || p.matches(SHELF_SEL) ||
          /^(ytd-item-section-renderer|ytd-rich-grid-renderer|ytd-app|ytd-page-manager|ytd-browse|ytd-search)$/i.test(p.tagName)) break;
      const ids = new Set();
      for (const l of p.querySelectorAll('a[href*="/watch?v="],a[href*="/shorts/"]')) {
        ids.add(videoIdFromHref(l.getAttribute("href")) || l.getAttribute("href"));
        if (ids.size > 1) break;
      }
      if (ids.size > 1) break;
      cur = p;
    }
    return cur;
  }

  // -------------------------------------------------------------- video
  function videoIdFromHref(href) {
    if (!href) return "";
    try {
      const u = new URL(href, YT_ORIGIN);
      if (!isYoutubeHost(u.hostname)) return "";
      if (u.pathname === "/watch") {
        const v = u.searchParams.get("v");
        return v && /^[\w-]{6,20}$/.test(v) ? v : "";
      }
      const m = /^\/(?:shorts|embed|live)\/([\w-]{6,20})/.exec(u.pathname);
      return m ? m[1] : "";
    } catch (e) {
      return "";
    }
  }

  function extractVideoId(c) {
    if (!c || !c.querySelectorAll) return "";
    const own = c.tagName === "A" ? [c] : [];
    for (const a of own.concat(Array.from(c.querySelectorAll("a[href]")))) {
      const id = videoIdFromHref(a.getAttribute("href"));
      if (id) return id;
    }
    return "";
  }

  // Titles. Old renderers and the new lockup layout, text/title/aria-label.
  const TITLE_SELECTORS = [
    "#video-title", "a#video-title-link", "yt-formatted-string#video-title",
    "[class*='lockup-metadata-view-model'][class*='__title']",
    "[class*='lockup-metadata-view-model'][class*='heading-reset']",
    "[class*='shortsLockupViewModelHostMetadataTitle']",
    "[class*='shortsLockupViewModelHostOutsideMetadataTitle']",
    ".ytp-videowall-still-info-title", ".ytp-ce-video-title", ".ytp-ce-playlist-title"
  ].join(",");

  function clean(s) {
    return (s || "").replace(/\s+/g, " ").trim();
  }

  function extractTitleTexts(c) {
    const out = [];
    const add = (s) => {
      const v = clean(s);
      if (v && !out.includes(v)) out.push(v);
    };
    if (!c || !c.querySelectorAll) return out;
    const nodes = c.querySelectorAll(TITLE_SELECTORS);
    const ariaFallback = [];
    for (const n of nodes) {
      add(n.textContent);
      add(n.getAttribute("title"));
      const al = n.getAttribute("aria-label");
      if (al) ariaFallback.push(al);
    }
    if (out.length === 0) {
      for (const a of c.querySelectorAll('a[href*="/watch?v="],a[href*="/shorts/"],a[href*="/playlist?list="]')) {
        add(a.getAttribute("title"));
        add(a.textContent);
        const al = a.getAttribute("aria-label");
        if (al) ariaFallback.push(al);
      }
    }
    if (out.length === 0) ariaFallback.forEach((l) => add(trimAriaTitle(l)));
    return out;
  }

  // ------------------------------------------------ channel identities
  const NAME_SELECTORS = [
    "ytd-channel-name yt-formatted-string", "ytd-channel-name a", "#channel-name a",
    "#channel-name yt-formatted-string", "#byline", "#owner-name a", ".ytp-ce-channel-title",
    "[class*='content-metadata-view-model'][class*='metadata-row']:first-child [class*='metadata-text']"
  ].join(",");

  function emptyIdentities() {
    return { keys: new Set(), handles: [], ids: [], customs: [], users: [], names: [] };
  }

  function addIdentity(ids, kind, value) {
    const v = clean(value);
    if (!v) return;
    const key = channelKey(v);
    if (!key) return;
    const list = kind === "handle" ? ids.handles : kind === "id" ? ids.ids :
      kind === "custom" ? ids.customs : kind === "user" ? ids.users : ids.names;
    if (!list.includes(v)) list.push(v);
    ids.keys.add(key);
  }

  // Collects every channel identity found inside one element (an item, a
  // header, an owner row). Depends on no single element.
  function extractChannelIdentities(root) {
    const ids = emptyIdentities();
    if (!root || !root.querySelectorAll) return ids;
    const links = root.tagName === "A" ? [root] : [];
    for (const a of links.concat(Array.from(root.querySelectorAll("a[href]")))) {
      const p = parseChannelHref(a.getAttribute("href"));
      if (!p) continue;
      addIdentity(ids, p.kind, p.value);
      addIdentity(ids, "name", a.textContent);
      addIdentity(ids, "name", a.getAttribute("title"));
      addIdentity(ids, "name", a.getAttribute("aria-label"));
    }
    for (const n of root.querySelectorAll(NAME_SELECTORS)) {
      addIdentity(ids, "name", n.textContent);
    }
    if (ids.names.length === 0) {
      const cn = root.querySelector("ytd-channel-name");
      if (cn) addIdentity(ids, "name", cn.textContent);
    }
    for (const n of root.querySelectorAll(".ytp-videowall-still-info-author")) {
      addIdentity(ids, "name", clean(n.textContent).split(/\s[•·]\s/)[0]);
    }
    for (const a of root.querySelectorAll('a[href*="watch?v="],a[href*="/shorts/"]')) {
      addIdentity(ids, "name", extractByFromAria(a.getAttribute("aria-label")));
    }
    return ids;
  }

  // ------------------------------------------------- hashtags from items
  function extractItemHashtags(c) {
    const tags = new Set();
    if (!c || !c.querySelectorAll) return tags;
    extractHashtags(c.textContent).forEach((t) => tags.add(t));
    for (const n of c.querySelectorAll("[title],[aria-label]")) {
      extractHashtags(n.getAttribute("title")).forEach((t) => tags.add(t));
      extractHashtags(n.getAttribute("aria-label")).forEach((t) => tags.add(t));
    }
    const links = c.tagName === "A" ? [c] : [];
    for (const a of links.concat(Array.from(c.querySelectorAll('a[href*="/hashtag/"]')))) {
      const t = hashtagFromHref(a.getAttribute("href"));
      if (t) tags.add(t);
    }
    return tags;
  }

  // ------------------------------------------------------------ pages
  function watchVideoId(loc) {
    try {
      const u = new URL(loc.href);
      return u.pathname === "/watch" ? u.searchParams.get("v") || "" : "";
    } catch (e) {
      return "";
    }
  }

  function metaContent(doc, sel) {
    const el = doc.querySelector(sel);
    return el ? el.getAttribute("content") || "" : "";
  }

  // Page-level metadata can be stale after SPA navigation. Trust it only when
  // it points at the current video.
  function metaIsFresh(doc, vid) {
    const u = metaContent(doc, 'meta[property="og:url"]');
    const c = doc.querySelector('link[rel="canonical"]');
    const url = u || (c ? c.getAttribute("href") || "" : "");
    return !!url && videoIdFromHref(url) === vid;
  }

  const WATCH_DESC_SEL = [
    "ytd-watch-metadata #description", "ytd-watch-metadata ytd-text-inline-expander",
    "ytd-watch-metadata #description-inline-expander",
    "ytd-video-secondary-info-renderer #description", "ytd-video-secondary-info-renderer ytd-expander"
  ].join(",");
  const WATCH_TAGLINK_SEL = [
    "ytd-watch-metadata a[href*='/hashtag/']", "#above-the-fold a[href*='/hashtag/']",
    "ytd-video-primary-info-renderer a[href*='/hashtag/']"
  ].join(",");
  const WATCH_OWNER_SEL = "ytd-watch-metadata #owner, ytd-video-owner-renderer, #upload-info";

  function readWatchPage(doc, loc) {
    const videoId = watchVideoId(loc);
    if (!videoId) return null;
    const flexy = doc.querySelector("ytd-watch-flexy");
    const attr = flexy ? flexy.getAttribute("video-id") : "";
    const fresh = !attr || attr === videoId;
    const ownerEl = doc.querySelector(WATCH_OWNER_SEL);
    const identities = ownerEl ? extractChannelIdentities(ownerEl) : emptyIdentities();
    const texts = [];
    const tags = new Set();
    const h1 = doc.querySelector("ytd-watch-metadata h1, #title h1, h1.ytd-watch-metadata");
    if (h1) texts.push(h1.textContent);
    for (const el of doc.querySelectorAll(WATCH_DESC_SEL)) texts.push(el.textContent);
    for (const a of doc.querySelectorAll(WATCH_TAGLINK_SEL)) {
      const t = hashtagFromHref(a.getAttribute("href"));
      if (t) tags.add(t);
      texts.push(a.textContent);
    }
    if (metaIsFresh(doc, videoId)) {
      for (const author of doc.querySelectorAll('[itemprop="author"]')) {
        for (const l of author.querySelectorAll('link[itemprop="url"]')) {
          const p = parseChannelHref(l.getAttribute("href"));
          if (p) addIdentity(identities, p.kind, p.value);
        }
        for (const n of author.querySelectorAll('link[itemprop="name"]')) {
          addIdentity(identities, "name", n.getAttribute("content"));
        }
      }
      texts.push(metaContent(doc, 'meta[name="description"]'));
      texts.push(metaContent(doc, 'meta[property="og:description"]'));
      for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
        try {
          const j = JSON.parse(s.textContent);
          for (const o of Array.isArray(j) ? j : [j]) {
            if (o && typeof o.description === "string" && videoIdFromHref(o.url || o["@id"] || "") === videoId) {
              texts.push(o.description);
            }
          }
        } catch (e) {
          // ignore malformed JSON-LD
        }
      }
    }
    return { videoId, fresh, identities, texts, tags };
  }

  const CHANNEL_HEADER_SEL =
    "yt-page-header-renderer,yt-page-header-view-model,ytd-c4-tabbed-header-renderer,#channel-header,#page-header";
  // Matched against a single leaf element's text, never across sibling spans.
  const HANDLE_TEXT_RE = /^(@[\p{L}\p{N}._-]{3,})(?:\s|[•·]|$)/u;

  // Identities of the channel whose page is open. URL identity is always
  // available; header DOM adds name/handle/id when it has rendered. A header
  // that contradicts the URL is stale and ignored.
  function readChannelPage(doc, loc) {
    const fromUrl = parseChannelPath(loc.pathname);
    const urlIds = emptyIdentities();
    if (fromUrl) addIdentity(urlIds, fromUrl.kind, fromUrl.value);
    const header = doc.querySelector(CHANNEL_HEADER_SEL);
    const domIds = emptyIdentities();
    if (header) {
      const found = extractChannelIdentities(header);
      const h1 = header.querySelector("h1");
      if (h1) addIdentity(domIds, "name", h1.textContent);
      for (const n of header.querySelectorAll("#channel-name,ytd-channel-name yt-formatted-string")) {
        addIdentity(domIds, "name", n.textContent);
      }
      for (const leaf of header.querySelectorAll("*")) {
        if (leaf.children.length > 0) continue;
        const hm = HANDLE_TEXT_RE.exec(clean(leaf.textContent));
        if (hm) addIdentity(domIds, "handle", hm[1]);
      }
      found.handles.forEach((v) => addIdentity(domIds, "handle", v));
      found.ids.forEach((v) => addIdentity(domIds, "id", v));
      found.customs.forEach((v) => addIdentity(domIds, "custom", v));
      found.users.forEach((v) => addIdentity(domIds, "user", v));
    }
    // Page metadata can be stale after SPA navigation. Its channel ID is used
    // only when its og:title agrees with the live header name.
    const ogTitle = metaContent(doc, 'meta[property="og:title"]');
    if (ogTitle && domIds.keys.has(channelKey(ogTitle))) {
      const canon = doc.querySelector('link[rel="canonical"]');
      const canonId = canon ? parseChannelHref(canon.getAttribute("href")) : null;
      const metaId = metaContent(doc, 'meta[itemprop="identifier"]');
      if (canonId && canonId.kind === "id") addIdentity(domIds, "id", canonId.value);
      else if (CHANNEL_ID_RE.test(metaId)) addIdentity(domIds, "id", metaId);
    }
    let stale = false;
    if (fromUrl && (fromUrl.kind === "handle" || fromUrl.kind === "id")) {
      const dom = fromUrl.kind === "handle" ? domIds.handles : domIds.ids;
      if (dom.length > 0 && !dom.some((v) => channelKey(v) === channelKey(fromUrl.value))) stale = true;
    }
    const all = emptyIdentities();
    for (const src of stale ? [urlIds] : [urlIds, domIds]) {
      for (const k of src.keys) all.keys.add(k);
      for (const f of ["handles", "ids", "customs", "users", "names"]) {
        for (const v of src[f]) if (!all[f].includes(v)) all[f].push(v);
      }
    }
    return { urlKeys: urlIds.keys, identities: all, stale };
  }

  // ---------------------------------------------------- shorts player
  const REEL_ACTIVE_SEL = "ytd-reel-video-renderer[is-active]";

  function readShortsReel(reel) {
    const identities = extractChannelIdentities(reel);
    const texts = [];
    const tags = new Set();
    for (const n of reel.querySelectorAll(
      "#overlay, ytd-reel-player-overlay-renderer, [class*='shorts-video-title'], .yt-shorts-video-title-view-model, h2, #description"
    )) {
      texts.push(n.textContent);
    }
    for (const a of reel.querySelectorAll('a[href*="/hashtag/"]')) {
      const t = hashtagFromHref(a.getAttribute("href"));
      if (t) tags.add(t);
      texts.push(a.textContent);
    }
    return { identities, texts, tags };
  }

  // ------------------------------------------------ Shorts sidebar entry
  // YouTube links its Shorts guide entry as "/shorts/" (trailing slash). That
  // is not a Short itself, so isShortsHref() deliberately stays untouched and
  // this separate helper only ever marks guide / mini-guide entries.
  function isShortsNavHref(href) {
    if (!href) return false;
    try {
      const u = new URL(href, YT_ORIGIN);
      return isYoutubeHost(u.hostname) && /^\/shorts\/?$/.test(u.pathname);
    } catch (e) {
      return false;
    }
  }

  const GUIDE_ENTRY_SEL = "ytd-guide-entry-renderer,ytd-mini-guide-entry-renderer";

  function isShortsNavEntry(c) {
    if (!c || !c.matches || !c.matches(GUIDE_ENTRY_SEL)) return false;
    for (const a of c.querySelectorAll("a[href]")) {
      if (isShortsNavHref(a.getAttribute("href"))) return true;
    }
    return false;
  }

  // ------------------------------------------------------ community posts
  const POST_SEL = "ytd-post-renderer,ytd-backstage-post-thread-renderer,ytd-backstage-post-renderer";

  function isPostItem(c) {
    return !!(c && c.matches && (c.matches(POST_SEL) || c.querySelector(POST_SEL)));
  }

  function postIdFromHref(href) {
    if (!href) return "";
    try {
      const u = new URL(href, YT_ORIGIN);
      if (!isYoutubeHost(u.hostname)) return "";
      const m = /^\/post\/([\w-]{6,})/.exec(u.pathname);
      return m ? m[1] : "";
    } catch (e) {
      return "";
    }
  }

  function extractPostId(c) {
    if (!c || !c.querySelectorAll) return "";
    const own = c.tagName === "A" ? [c] : [];
    for (const a of own.concat(Array.from(c.querySelectorAll('a[href*="/post/"]')))) {
      const id = postIdFromHref(a.getAttribute("href"));
      if (id) return id;
    }
    return "";
  }

  // The author of a post is the FIRST channel link in it. Later channel links
  // are @mentions inside the post text and must not block the post.
  function extractPostAuthorIdentities(c) {
    const ids = emptyIdentities();
    if (!c || !c.querySelectorAll) return ids;
    const links = c.tagName === "A" ? [c] : [];
    for (const a of links.concat(Array.from(c.querySelectorAll("a[href]")))) {
      const p = parseChannelHref(a.getAttribute("href"));
      if (!p) continue;
      addIdentity(ids, p.kind, p.value);
      addIdentity(ids, "name", a.textContent);
      addIdentity(ids, "name", a.getAttribute("title"));
      addIdentity(ids, "name", a.getAttribute("aria-label"));
      break;
    }
    const nameEl = c.querySelector("#author-text, #author ytd-channel-name, #header-author #author-text");
    if (nameEl) addIdentity(ids, "name", nameEl.textContent);
    return ids;
  }

  // ------------------------------------------- metadata lookups (Decision D1)
  // Pure parsers for same-origin lookups. oEmbed: { title, author_name, author_url }.
  function parseOembed(json) {
    if (!json || typeof json !== "object") return null;
    const name = clean(json.author_name);
    const title = clean(json.title);
    let handle = "";
    let channelId = "";
    const p = parseChannelHref(json.author_url);
    if (p && p.kind === "handle") handle = p.value;
    else if (p && p.kind === "id") channelId = p.value;
    if (!name && !handle && !channelId && !title) return null;
    return { n: name, h: handle, c: channelId, t: extractHashtags(title) };
  }

  // Reads one JSON string literal starting right after its opening quote.
  function readJsonString(src, start) {
    let i = start;
    while (i < src.length) {
      const ch = src.charCodeAt(i);
      if (ch === 92) i += 2;
      else if (ch === 34) break;
      else i += 1;
    }
    if (i >= src.length) return "";
    try {
      return JSON.parse('"' + src.slice(start, i) + '"');
    } catch (e) {
      return "";
    }
  }

  // Video page HTML -> { title, description, author, channelId } from the
  // player response's videoDetails (the first occurrence is the main video).
  function parsePlayerResponseHtml(html) {
    const out = { title: "", description: "", author: "", channelId: "" };
    if (!html || typeof html !== "string") return out;
    const at = html.indexOf('"videoDetails":{');
    if (at === -1) return out;
    const win = html.slice(at, at + 60000);
    const grab = (key) => {
      const k = win.indexOf('"' + key + '":"');
      return k === -1 ? "" : readJsonString(win, k + key.length + 4);
    };
    out.title = grab("title");
    out.description = grab("shortDescription");
    out.author = grab("author");
    const cid = grab("channelId");
    if (CHANNEL_ID_RE.test(cid)) out.channelId = cid;
    return out;
  }

  // All comparison keys a lookup result can be matched on.
  function metaIdentityKeys(meta) {
    const keys = new Set();
    if (!meta) return keys;
    for (const v of [meta.n, meta.h, meta.c]) {
      const k = channelKey(v || "");
      if (k) keys.add(k);
    }
    return keys;
  }

  // ------------------------------------------------------------- rules
  const KNOWN_TOGGLES = [
    "blockShorts", "hideHomeFeed", "blockChannels", "hideUpNext", "hideComments",
    "disableAutoplay", "hideExplore", "blockKeywords", "blockHashtags", "searchOnlyMode"
  ];

  // Search-Only Mode forces Shorts blocking and the home-feed hide. Focus
  // Session forces every toggle on (see background.js).
  function effectiveToggles(settings) {
    if (!settings || !settings.toggles) return {};
    if (settings.toggles.searchOnlyMode) {
      return Object.assign({}, settings.toggles, { blockShorts: true, hideHomeFeed: true });
    }
    return settings.toggles;
  }

  function compileRules(settings, learn) {
    const toggles = effectiveToggles(settings);
    const aliases = (learn && learn.channelAliases) || {};
    const channelKeyToEntry = new Map();
    for (const entry of (settings && settings.blockedChannels) || []) {
      const ek = channelEntryKey(entry);
      if (!ek) continue;
      channelKeyToEntry.set(ek, ek);
      for (const k of aliases[ek] || []) if (k && !channelKeyToEntry.has(k)) channelKeyToEntry.set(k, ek);
    }
    const keywords = [];
    for (const k of (settings && settings.blockedKeywords) || []) {
      const n = normalizeText(k);
      if (n && !keywords.includes(n)) keywords.push(n);
    }
    const tagSet = new Set();
    for (const h of (settings && settings.blockedHashtags) || []) {
      const t = hashtagKey(h);
      if (t) tagSet.add(t);
    }
    const cache = new Map();
    for (const e of (learn && learn.hashtagCache) || []) {
      if (e && e.id && tagSet.has(e.tag)) cache.set(e.id, e.tag);
    }
    return {
      toggles,
      channelsOn: !!toggles.blockChannels && channelKeyToEntry.size > 0,
      keywordsOn: !!toggles.blockKeywords && keywords.length > 0,
      hashtagsOn: !!toggles.blockHashtags && tagSet.size > 0,
      channelKeyToEntry, keywords, tagSet, cache
    };
  }

  function matchChannel(keys, rules) {
    for (const k of keys) {
      const e = rules.channelKeyToEntry.get(k);
      if (e) return e;
    }
    return null;
  }

  function matchKeywordAny(texts, rules) {
    for (const t of texts) {
      const n = normalizeText(t);
      for (const k of rules.keywords) if (n.includes(k)) return k;
    }
    return null;
  }

  function matchHashtagAny(tagSetOfItem, rules) {
    for (const t of tagSetOfItem) if (rules.tagSet.has(t)) return t;
    return null;
  }

  // ------------------------------------------------------ shorts guard
  // One guard per attempt: the target URL is the key, and one window covers
  // click / navigate / popstate for the same attempt. Redirects are limited to
  // one per second.
  function createAttemptGuard(opts) {
    const windowMs = (opts && opts.windowMs) || 2500;
    const gapMs = (opts && opts.redirectGapMs) || 1000;
    const contMs = (opts && opts.continuationMs) || 2500;
    const seen = new Map();
    let lastRedirect = -Infinity;
    return {
      attempt(key, now) {
        for (const [k, at] of seen) if (now - at > windowMs) seen.delete(k);
        if (seen.has(key)) return { isNew: false };
        seen.set(key, now);
        return { isNew: true };
      },
      canRedirect(now) {
        return now - lastRedirect >= gapMs;
      },
      markRedirect(now) {
        lastRedirect = now;
      },
      inContinuation(now) {
        return now - lastRedirect <= contMs;
      },
      msUntilRedirect(now) {
        return Math.max(0, gapMs - (now - lastRedirect));
      }
    };
  }

  // trigger: load | toggle | nav | finish | popstate | guard
  // (toggle and guard redirect but never count; load counts only with a YouTube referrer)
  function decideShortsRedirect(i) {
    const home = { action: "home", url: null, count: false };
    const viaTracked = (count) =>
      i.lastNonShorts ? { action: "replace", url: i.lastNonShorts, count } : home;
    if (i.continuation) return viaTracked(false);
    if (i.trigger === "toggle" || i.trigger === "guard") return viaTracked(false);
    if (i.trigger === "load") {
      if (i.referrerIsYoutube) return { action: "back", url: null, count: true };
      return viaTracked(false);
    }
    if (i.trigger !== "popstate" && i.navPrev) return { action: "back", url: null, count: true };
    if (i.lastNonShorts) return { action: "replace", url: i.lastNonShorts, count: true };
    return home;
  }

  return {
    normalizeText, matchesKeyword, extractHashtags, hashtagFromHref, matchesHashtag,
    normalizeHashtagEntry, hashtagKey, normalizeTag,
    parseChannelPath, parseChannelHref, isChannelPath, parseChannelInput, channelKey,
    channelEntryKey, extractByFromAria, trimAriaTitle,
    ITEM_SEL, SHELF_SEL, SHORTS_SHELF_SEL, REEL_ACTIVE_SEL, KNOWN_TOGGLES,
    isShortsHref, isShortsPath, itemContainerOf, isShortItem, shelfIsShortsOnly,
    structuralContainer, videoIdFromHref, extractVideoId, extractTitleTexts,
    extractChannelIdentities, extractItemHashtags, watchVideoId, readWatchPage,
    readChannelPage, readShortsReel, effectiveToggles, compileRules, matchChannel,
    matchKeywordAny, matchHashtagAny, createAttemptGuard, decideShortsRedirect,
    // v1.2.0 additions
    isShortsNavHref, isShortsNavEntry, POST_SEL, isPostItem, postIdFromHref, extractPostId,
    extractPostAuthorIdentities, parseOembed, parsePlayerResponseHtml, metaIdentityKeys
  };
});
