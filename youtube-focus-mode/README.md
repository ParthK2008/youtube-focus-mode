# YouTube Focus Mode

A Chrome/Edge (Manifest V3) extension that lets you use YouTube intentionally —
every distraction-driving pattern (Shorts, infinite home feed, autoplay,
end-screen rabbit-holing, comments, specific channels, keywords, hashtags) can
be switched off on demand, and nothing is ever forced or permanent. All data
stays on your device.

**Author:** Saurabh Maurya · **Version:** 1.2.0

## Install (load unpacked)

1. Open `chrome://extensions` (or `edge://extensions` in Edge).
2. Turn on **Developer mode** (top-right toggle).
3. Click **Load unpacked**.
4. Select this folder (`youtube-focus-mode/`).
5. Pin the extension from the puzzle-piece menu so its icon stays visible.
6. Open any YouTube tab (or refresh an open one) — the popup icon is your
   control panel.

Only `www.youtube.com`, `m.youtube.com`, and bare `youtube.com` are affected.
`studio.youtube.com` and `music.youtube.com` are never touched.

## Features

| Feature | Where | Notes |
|---|---|---|
| Block Shorts | Toggles tab | Hides every Shorts shelf and single item on every surface (search, home, subscriptions, sidebar, channel pages, guide, mini guide). Clicking, middle-clicking, or activating a Shorts link with the keyboard is intercepted so you never leave the page; programmatic navigation to a Short (including back/forward) is redirected back. |
| Hide Home Feed | Toggles tab | Replaces the home recommendation feed with a centered "Search and Learn" screen (search field plus three quick-search shortcuts). |
| Block Channels | Lists tab | Add a channel name, `@handle`, channel ID, or full channel URL. Matching videos, Shorts and community posts are hidden everywhere; a blocked channel's `/shorts/<id>`, `/live/<id>` and `/post/<id>` pages show the block screen; the channel's own cards and page (all tabs) are blocked outright. Seeing a channel's name/handle/ID together teaches the extension the link between them, so any one form you typed keeps working. |
| Hide Up Next | Toggles tab | Removes end-screen suggestions and the whole related/"up next" column (including its filter chips) on video pages. |
| Hide Comments | Toggles tab | Removes the comments section under videos. |
| Disable Autoplay | Toggles tab | Hides YouTube's autoplay switch and keeps autoplay forced off on every video page, including if YouTube turns it back on. |
| Hide Explore/Trending | Toggles tab | Removes the whole Explore section (and any Trending entry) from the left sidebar. The Explore section is recognised by its English header text. |
| Block Title Keywords | Lists tab | Case-insensitive substring match against video titles (accents/whitespace normalized), applied identically on every surface. |
| Block Hashtags | Lists tab | Add `#hashtag` entries with their own toggle. Blocks a whole hashtag token — `#gaming` never matches `#gamingsetup` or the plain word "gaming". See "What hashtag blocking can and can't see" below. |
| Focus Timer / Session Mode | Session tab | Pick a duration, hit Start — every blocking feature turns on for that long, then automatically reverts to what you had before. A live countdown shows on the toolbar badge and in the popup. |
| Search-Only Mode | Toggles tab | Forces Block Shorts and Hide Home Feed on for as long as it's on. |
| Stats Dashboard | Stats tab | Local, weekly counters with a one-line definition under each — see below. Resets automatically each Monday. |
| Import/Export | Stats tab | Export your toggles and blocklists (channels, keywords, hashtags) as a JSON file; re-import on another machine or after reinstalling. An export from v1.0 imports cleanly (hashtags simply stay empty). |

## What each stat actually counts

- **Shorts blocked** — a blocked click-through or forced redirect that leaves you on the page you were already on, counted once per attempt. Hiding a Short in a feed is **not** counted. Also not counted: opening a Shorts URL with no previous YouTube page in this tab (typed, pasted, or a link from outside YouTube), or switching Block Shorts on while already sitting on a Short — both still redirect you away.
- **Recommendations hidden** — one count per home-page view and one per watch-page view where something was actually hidden, not one per DOM change.
- **Channel matches / Keyword matches / Hashtag matches** — each counts a unique video once per week, de-duplicated by video ID. Scrolling away and back, switching tabs, reloading, and toggling a feature off and back on never inflate these.

## What hashtag blocking can and can't see

YouTube's feeds (home, search, subscriptions, Shorts) only ever put a video's
**title**, and sometimes a short **description snippet**, on the page — never
the full description. So:

- A hashtag in the **title**, a **Shorts caption**, a **search snippet**, or a
  visible `/hashtag/` link is blocked immediately, on every surface.
- A hashtag that appears **only in the full description of a long video**
  cannot be seen from a feed thumbnail. It's caught the moment you **open**
  that video — you'll see a "Video blocked" screen instead of playback — and
  from then on that video is remembered by ID and hidden from every list.
- **Shorts** are different: when Block Hashtags or Block Channels has entries
  and Block Shorts is off, the extension looks up each Short's public metadata
  on youtube.com (see "Lookups" below), so a caption/description-only hashtag
  or the Short's channel is caught in the feed too.

This means a description-only hashtagged long video can appear once in a feed
before you've opened it. That's a structural limit of what a browser
extension can read from a feed, not a bug, and it's the same limit the popup
and this README describe plainly rather than pretend around.

## Why each permission is requested

- **`storage`** — saves your toggle states, blocklists (channels, keywords,
  hashtags), session state, the hashtag learning cache, channel aliases, and
  stats in `chrome.storage.local`. Nothing is synced to a server.
- **`activeTab`** — lets the popup interact with the YouTube tab you currently
  have open (checking it's YouTube, injecting the content script if it isn't
  already running).
- **`scripting`** — required for Manifest V3 content-script injection, used
  both by the popup's self-healing check and by the background worker on
  install/update so already-open tabs don't need a manual refresh.
- **`alarms`** — powers the Focus Timer countdown. MV3 service workers are
  killed when idle, so the timer uses `chrome.alarms` (which survives that)
  instead of `setTimeout`/`setInterval`, which would silently stop working.
- **Host permissions** for `www.youtube.com`, `m.youtube.com`, `youtube.com` —
  the extension only ever reads or modifies these YouTube pages. It does not
  run on `studio.youtube.com` or `music.youtube.com`.

No `<all_urls>`, no `tabs`, no `webRequest`, no `history`, no analytics, no
third parties. Everything the extension does is visible in its own source
files.

## Early class mirror

So that the hide rules apply before the first paint, the six on/off switches
that only toggle a CSS class (Block Shorts, Hide Home Feed, Hide Up Next, Hide
Comments, Hide Explore, Disable Autoplay) are mirrored as one small
`localStorage` entry (`yfm.cls`, six booleans — no lists, no stats) on
youtube.com. `chrome.storage` stays the single source of truth; the mirror is
rewritten from it on every change.

## Lookups (privacy)

To catch Shorts and posts that show no channel or hashtag in the feed, the
extension may look up public metadata for those items on youtube.com itself.
Nothing is sent anywhere else.

- Only same-origin requests to `https://www.youtube.com/…` (an `oembed` call,
  and for hashtag blocking the Short's own page), made by the content script.
  No new permission is needed.
- Only when Block Channels or Block Hashtags is on **with entries**, Block
  Shorts is off, and only for Shorts tiles whose answer is not in the tile.
  Never for long-video tiles.
- At most 2 requests at a time, 250 ms apart, 30 `oembed` and 10 full-page
  lookups per page view, each video at most once, none while the tab is
  hidden. Failures are not retried for 10 minutes.
- Results (channel name/handle/ID and hashtags, no page content) are cached
  locally for 30 days, up to 5000 videos, in `chrome.storage.local`.
- Until an answer arrives, an unresolved Short is hidden so blocked content
  never flashes; it is shown again if it does not match.

## How it handles YouTube's single-page app behavior

YouTube almost never does a full page reload while you navigate. The content
script listens for YouTube's own `yt-navigate-start`, `yt-navigate-finish`,
`yt-page-data-updated` and `popstate` events to re-apply every rule on each
internal navigation, and uses a debounced `MutationObserver` (processing only
added/changed nodes, never a full re-scan) to catch elements YouTube renders
in after the fact — lazily-loaded shelves, titles that arrive after their
container, and so on.

## Files

- `manifest.json` — MV3 manifest, permissions, and scope.
- `detect.js` — every detection/matching rule as small, pure, unit-tested
  functions (Shorts detection, title/channel/hashtag extraction, matching,
  stat de-duplication helpers, the Shorts click/redirect guard). No
  `chrome.*` calls.
- `storage.js` — the shared schema (settings / stats / learning cache),
  migration, the serialized write queue, import/export.
- `background.js` — the MV3 service worker: install/update migration, the
  Focus Session alarm-driven countdown, and the single writer for stats, the
  learning cache and the lookup cache.
- `content.js` — the engine that runs on YouTube pages: applies `detect.js`'s
  rules to the live DOM, the Shorts click interceptor and URL guard, the
  block screens, the toast, and the observer pipeline.
- `popup.html` / `popup.css` / `popup.js` — the settings UI.
- `styles/injected.css` — CSS-first hiding rules and the block-screen/toast
  styling.
- `tests/` — `unit.test.js` (pure-logic tests, `node tests/unit.test.js`,
  no browser needed) and `tests/e2e/` (Playwright tests that load the real
  extension into headless Chromium against static fixture pages reproducing
  YouTube's old and new markup families — `node tests/e2e/run.js`).
