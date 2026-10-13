# greasemonkey-scripts

Small collection of userscripts I actually run. Every script is self-contained, has no
dependencies and lives in [`scripts/`](scripts/).

| Script | What it does |
|---|---|
| [`tiktok-live-auto-stay.user.js`](scripts/tiktok-live-auto-stay.user.js) | Keeps you on a paused TikTok LIVE instead of letting TikTok skip to the next stream. |

## Install

1. Install a userscript manager:
   - [Tampermonkey](https://www.tampermonkey.net/) — Chrome, Edge, Firefox, Safari
   - [Violentmonkey](https://violentmonkey.github.io/) — Chrome, Edge, Firefox
   - [Greasemonkey](https://addons.mozilla.org/firefox/addon/greasemonkey/) — Firefox
2. Open the raw file, the manager offers to install it:

   ```
   https://raw.githubusercontent.com/cens0r3d/greasemonkey-scripts/main/scripts/tiktok-live-auto-stay.user.js
   ```

3. Greasemonkey note: it blocks local `file://` installs by default. Either paste the file
   content into *New user script*, or set `extensions.greasemonkey.fileIsGreaseable` to `true`
   in `about:config`.

## tiktok-live-auto-stay.user.js

While the host is away, TikTok shows a `LIVE Pause` overlay and then moves everyone to the next
stream automatically:

> Das nächste LIVE wird automatisch in 4 Sekunden abgespielt. **Abbrechen**

This script clicks *Abbrechen* / *Cancel* for you every time, so you stay on the stream you
picked — no more landing in a random LIVE after a short break.

### How it works

1. **Detect** — looks for an element whose text contains `LIVE` plus a number and a seconds
   unit (`in 4 seconds`, `in 4 Sekunden`, `4秒`, …). `LIVE` is spelled the same in almost every
   locale, and text is matched instead of TikTok's rotating class names.
2. **Confirm** — the countdown has to sit in a flat container that also shows a pause hint
   (`LIVE Pause`, `Paused`, `En pause`). That is what keeps chat lines such as
   *"the next live in 5 seconds"* from triggering anything.
3. **Act** — a full pointer/mouse/click sequence is sent to the cancel control, because React
   reacts to bubbling events. If the overlay survives, it escalates: direct `click()`, then
   keyboard events, then wrapper elements — each level adds exactly one new technique.
4. **Guard** — a stream that really ended (`LIVE has ended`) is never cancelled, so TikTok is
   allowed to move on when there is nothing left to watch.

### Controls

| Action | Result |
|---|---|
| Click the badge | Auto-Stay on / off |
| `Alt` + `C` | Auto-Stay on / off |
| Drag the badge | Move it anywhere; the position is remembered |
| Double click the badge | Reset to top right |

The badge appears in the top right corner and never docks into TikTok's DOM, so layout changes
on their side cannot hide it. Greasemonkey/Tampermonkey storage is used for the position, the
mode and the counter; if the manager offers no storage API, `localStorage` is used instead.

### Configuration

All options sit at the top of the script:

| Option | Default | Meaning |
|---|---|---|
| `mode` | `'stay'` | `'stay'` cancels the countdown, `'off'` only observes |
| `giveUpAfter` | `0` | `0` = never give up; `N` = let TikTok move on after N cancels in the same stream |
| `clickCooldownMs` | `1200` | Minimum gap between two click attempts |
| `scanIntervalMs` | `400` | Minimum gap between two DOM scans |
| `retryDelayMs` | `700` | Grace period before a click counts as failed |
| `maxClickLevel` | `4` | Escalation steps per overlay |
| `notify` | `false` | Desktop notification on the first successful cancel |
| `badge` | `true` | Show the status badge |
| `badgeTop` / `badgeRight` | `84` / `16` | Badge offsets in px |
| `hotkey` | `true` | `Alt+C` toggle |
| `debug` | `false` | Console logging |

Debug handle: `window.__ttAutoStay` (`__ttAutoStay.tick()` runs one detection cycle manually,
`__ttAutoStay.config.debug = true` turns logging on).

### Notes

- Only runs on `tiktok.com/*/live` pages; it removes the badge again elsewhere.
- The scan is budgeted and skips chat subtrees, so a busy chat does not slow the page down.
- Success is only counted after the countdown actually disappeared.

## License

MIT — see [LICENSE](LICENSE).
