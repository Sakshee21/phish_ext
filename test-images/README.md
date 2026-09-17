# test-images/

Real PNG screenshots for `scripts/test-phash.ts`'s real-image validation pass
(the synthetic self-check runs without any of this — these are only needed
for the second half of the script).

These files are gitignored (see root `.gitignore`) — they're often
screenshots of real third-party sites, not something to commit.

## Files to add

| Filename | What to put in it |
|---|---|
| `same-1.png` | A screenshot of any real login/landing page. |
| `same-2.png` | A **second, independently captured** screenshot of the *same* page — reload and recapture, or capture a few seconds apart. Don't just duplicate `same-1.png`; the point is to include the natural noise between two real captures (font antialiasing, ad/banner timing, subpixel rendering differences), which is exactly the noise the `<= 7` Hamming-distance threshold (`brands.json` / `src/utils/phash.ts`) needs to be robust to. |
| `different.png` | A screenshot of a **genuinely different** site — any other page works, doesn't need to be a login page. |

## How to capture them

Easiest path: open the page in Chrome, then use the extension's own
mechanism so the test reflects real conditions —
`chrome.tabs.captureVisibleTab` output is a full-viewport PNG, so any
full-viewport screenshot (e.g. browser DevTools → Cmd/Ctrl+Shift+P →
"Capture screenshot", or your OS's screenshot tool cropped to the browser
viewport) is representative. Exact resolution doesn't matter — the
algorithm resizes internally.

## Running

```
pnpm test:phash
# or directly:
node --experimental-strip-types scripts/test-phash.ts
```

If any of the three files are missing, the real-image section prints which
ones and skips itself — the synthetic self-check still runs regardless.
