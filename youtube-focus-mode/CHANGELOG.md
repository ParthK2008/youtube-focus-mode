# Changelog

## 1.2.0

### Fixed
- **Shorts icon still visible in the sidebar with Block Shorts on.** The guide entry links to `/shorts/` (trailing slash), which the old rules did not match. It is now hidden in the expanded sidebar, the collapsed mini sidebar and the drawer, in Block Shorts, Search-Only Mode and Focus Session.
- **Blocked channel's Shorts, community posts and live pages still reachable.** Community posts are now evaluated like any other item (author = first channel link in the post). Shorts tiles carry no channel in the feed, so their channel is looked up (see Added). `/post/<id>`, `/live/<id>` and, with Block Shorts off, `/shorts/<id>` pages of a blocked channel show the channel block screen.
- **Hashtag blocking missed Shorts and posts.** Posts are now evaluated for hashtags, and Shorts whose hashtag is only in the caption/description are caught through the metadata lookup. The whole-token matching rule is unchanged.
- **Hide Up Next: recommendations flashed and came back on scroll.** The whole related column (`#related`, its chip bar, and loose recommendation tiles inside `#secondary`) is hidden, `<html>` classes are re-applied whenever YouTube rewrites the `class` attribute and on `yt-navigate-start`, and the class state is applied at document start from a tiny synchronous mirror (`localStorage` key `yfm.cls`, the six class-toggle booleans only) instead of waiting for the asynchronous storage read.
- **Disable Autoplay could be switched back on.** The autoplay switch (player bar, settings-menu row, up-next card) is hidden while the toggle is on, and autoplay is forced off continuously by an observer on the switch's state, not once per URL.
- **Hide Explore/Trending did nothing visible.** The whole Explore section (header and entries) is now hidden, recognised by its English header text; existing Explore/Trending entry rules are kept.

### Changed
- Hide Home Feed placeholder redesigned as a centered "Search and Learn" screen with a working search field and three quick-search buttons (light and dark theme). Shown under the same conditions as before.

### Added
- **Metadata lookups (same-origin, limited).** To catch Shorts and posts that show no channel or hashtag in the feed, the extension may look up public metadata for those items on youtube.com itself. Nothing is sent anywhere else. Limits: 2 concurrent, 250 ms apart, 30 oEmbed + 10 page lookups per page view, once per video, none while the tab is hidden, failures not retried for 10 minutes. Results are cached for 30 days (max 5000) under a new storage key `yfmMeta`.
- New background message type `YFM_META_PUT`. Schema version, storage keys, toggles and existing message types are unchanged.

## 1.1.0

### Fixed
- **Shorts still showing with Block Shorts ON (search and elsewhere).** Detection is now structural (a Shorts link, a Shorts lockup/badge element, or membership in a Shorts shelf) instead of a fixed tag list, so it covers the new `yt-lockup-view-model` / `ytm-shorts-lockup-view-model` / `grid-shelf-view-model` markup as well as the legacy renderers. Hiding always targets the outermost item container, so no blank gaps are left, and an empty shelf collapses instead of showing an empty header. A debounced observer re-checks lazily-loaded and re-rendered results.
- **Blocked channels only partly blocked.** Channel identity is now collected from every available source (handle, channel ID, `/c/` and `/user/` links, and the visible name in every known layout) instead of one fixed selector, and the blocklist accepts a name, `@handle`, channel ID, or full URL, matched case- and accent-insensitively. Channel cards, guide entries, and the channel's own page/watch pages are now blocked outright with a "Channel blocked" screen, in addition to hiding its videos everywhere. Seeing a channel's name, handle and ID together (its own page) teaches the extension the alias, so a name-only or ID-only entry keeps working everywhere afterward.
- **Blocked keywords not applied on the home feed.** Title extraction is now one function that reads every known title location (old renderers and the new lockup layout, plus `title` and `aria-label` fallbacks) and is applied identically on every surface. The matching rule itself (case-insensitive substring) is unchanged; only whitespace/accent normalization was added.
- **Inaccurate stats.** "Shorts blocked" now means a blocked click-through or forced redirect that leaves you on your previous page — never a hidden feed item. Channel/keyword/hashtag matches are de-duplicated by video ID (bounded, week-scoped) so re-renders, scrolling, and toggling never inflate a count. All stat writes go through the background service worker's serialized queue, so multiple open tabs can't lose updates. The old full-page Shorts overlay is gone in favor of a small auto-dismissing toast that never affects counting.

### Added
- **Hashtag blocking.** Add `#hashtag` entries alongside keywords, with their own "Block Hashtags" toggle. Hashtags in titles, Shorts captions, search snippets, and visible `/hashtag/` links are blocked on every surface immediately. A hashtag that appears only in a video's full description is caught the moment that video is opened (its own "Video blocked" screen), and is then remembered by video ID and hidden from every list afterward — this extension does not fetch pages in the background, so a never-opened, description-only match cannot be detected until you open it once. Opening `/hashtag/<name>` for a blocked tag shows a blocked screen. Removing a hashtag from the list clears its learned matches immediately.

### Changed
- Manifest scope narrowed to `www.youtube.com`, `m.youtube.com`, and bare `youtube.com` — `studio.youtube.com` and `music.youtube.com` were previously (unintentionally) matched and are now excluded.
- Storage schema bumped to v2 (settings, stats, and the learning cache now live in separate keys). Existing v1.0 installs are migrated automatically on update; no blocklist, keyword, toggle, or current-week stat is ever overwritten.
- Popup: added a hashtag manager (its own list with add/edit/delete and a `#` badge), inline validation messages for bad entries and duplicates, per-stat one-line definitions on the Stats tab, and updated hint text describing exactly what channel/keyword/hashtag matching does and does not cover.
