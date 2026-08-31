# Testing the Warning Layer

How to run and test the five warning conditions, including Progressive Reveal.
`TESTING.md` at the repo root covers Layer 1 (perceptual hashing) separately —
this doc is about what the participant actually sees.

---

## 1. Which build to use

There are three, and picking the wrong one is the most common way to lose an
afternoon.

| Command | Output folder | Picker | Use it for |
|---|---|---|---|
| `pnpm build:pilot` | `.output/chrome-mv3-pilot` | **yes** | **testing — use this one** |
| `pnpm build` | `.output/chrome-mv3` | no | the build participants get |
| `pnpm dev` | `.output/chrome-mv3-dev` | yes | live reload |

Note the folder name changes with the build. `--mode pilot` writes to
`chrome-mv3-**pilot**`, so if you rebuild and nothing seems to change, check
you loaded the folder you just built.

**Avoid `pnpm dev` unless you need hot reload.** The dev build loads the
offscreen document's script from `http://localhost:3000`, so the moment that
terminal isn't running, Layer 1 silently returns no hash and every page reads
as safe — with no error explaining why.

```bash
pnpm install
pnpm build:pilot
```

Then in Chrome: `chrome://extensions` → Developer mode on → **Load unpacked** →
`.output/chrome-mv3-pilot`. Remove any older copy of the extension first so two
aren't scanning at once.

Check **Details → Site access** is set to **"On all sites"**. If it's on-click,
`captureVisibleTab` fails and Layer 1 never runs.

---

## 2. Golden rule when re-testing

**After rebuilding, close the test tab, reload the extension, then open the page
fresh.**

A tab open across a rebuild keeps running the old content script, whose
`browser.*` handles are dead. You'll see:

```
[phish_ext] Interaction NOT logged - this tab is running a stale content script.
```

Nothing is broken; the tab is just stale. But every occurrence is a lost data
point, so don't ignore it during a pilot. There's a second, quieter way a stale
script corrupts data: its old bundle writes interaction events **without a
`visitId`**. Those can't be grouped into a visit, so the logs page and exports
**ignore them** (you'll see "N events from an older version ignored" at the top
of the history). That's a deliberate guard, not data recovery — reload the
extension and reopen the tab so new events group properly.

---

## 3. Test pages

| Page | What it exercises |
|---|---|
| `demo/index.html` (serve locally) | Most reliable end-to-end test |
| `https://divcenter4.github.io/test/vtop.html` | VTOP clone — richest evidence set |
| `https://divcenter4.github.io/test/idhc.html` | Lookalike brand name ("IDHC Second" vs IDFC First Bank) |

For the local fixture:

```bash
cd demo && python3 -m http.server 8000
```

Open `http://127.0.0.1:8000/` — **not** `localhost`, which the content script
explicitly excludes.

For the GitHub-hosted clones, Chrome Safe Browsing now flags them. Click
**Details → visit this unsafe site**. For the real study, host clones locally —
participants blocked by Chrome never see our warning at all, and Chrome's own
red interstitial is itself a warning that would confound the comparison.

---

## 4. Condition assignment

Each install is randomly assigned **one** of five conditions on first run and
keeps it permanently. That's the between-subjects design: a participant on
`banner` sees a banner on every flagged page, forever, with no escalation.

In a pilot build, the popup's **Warning condition** dropdown overrides it for
testing. In a study build the dropdown isn't rendered at all.

⚠️ **Never reset assignment on a real participant's profile.** It doesn't fail
loudly — it produces a participant whose logged events span two conditions,
which is unusable and undetectable afterwards. See the warning at the top of
`src/utils/condition-assignment.ts`.

An install that has already been assigned keeps that assignment, so **each
participant needs a fresh browser profile.**

---

## 5. The four static conditions

Pick each from the dropdown, reload the page. Each renders exactly one thing
and nothing else — no escalation, no spotlight, no cross-condition mixing.

- **Banner** — red strip at the top, dismissible, page still usable.
- **Modal** — full-screen interrupt, requires Go Back or Proceed Anyway.
- **Tooltip** — bubble anchored to the password field; scroll to check it
  follows.
- **Passive Icon** — small ⚠ badge bottom-right; click it to expand details.

---

## 6. Progressive Reveal

The core contribution, and the one worth testing carefully. **One condition
with internal stages** — not the other four firing in sequence.

Evidence is revealed **one piece at a time, marked on the page**, and once
everything has been shown a final confirmation is required.

```
stage 1        toolbar badge only. No evidence. The system is watching.
stage 2        1st piece outlined on the page
stage 3        2nd piece outlined (1st stays outlined)
...            one more each step, accumulating
final stage    everything outlined + confirmation modal, decision required
```

Stage count follows the evidence: 5 pieces → 7 stages, 2 pieces → 4 stages.

**Advancing happens two ways:**

- **Automatically**, but dwell alone is a slow inaction fallback (~10s before the
  first piece, ~12s between pieces, ~15s before the confirmation) and can carry a
  visit no further than the first reveal (stage 2) — past that, an *auto* advance
  needs a fresh hesitation signal (approach/focus/typing) since the current stage
  appeared, and those escalate immediately, faster than the dwell timer. So on an
  evidence-heavy page, doing nothing does not race through the stages; stage count
  reflects hesitation, not how much evidence the page happened to have.
- **Manually**, via the **Next** button on each popover.

These are logged separately (`auto` vs `manual`) — each `escalated` event
records its `trigger`. Evidence someone *sought out* is different behaviour
from evidence pushed at them, and the two shouldn't be pooled. The engagement
signals themselves are logged too, as `approached` / `focused` / `typed`
micro-events (see §7).

**Escalation is lazy, and stopping early is the intended outcome.** Someone who
reacts at stage 1 and leaves should never see stage 2 — that's a result, not a
failure. Escalation also pauses when the tab is hidden or idle for 10s, so an
abandoned tab doesn't march itself to a modal.

### What to check

1. Select `progressive`, reload, **don't touch anything**. Toolbar badge only —
   nothing injected into the page. After ~6s the first outline appears, then
   one more every ~6s.
2. Click **Next** repeatedly — each click reveals one more outlined element.
3. Move the mouse toward the password field, or click into it. Escalation
   should jump early (rate-limited to one jump per 1.5s).
4. Switch tabs mid-way and come back. It should hold its stage, not skip ahead.
5. At the final stage, confirm the outlines are still visible behind the modal.

---

## 7. Where the data lands

Open the background service worker console (`chrome://extensions` → "service
worker") and run:

```js
browser.storage.local.get('phish_interactions').then(e => console.table(e.phish_interactions))
```

Each event carries `type` (`shown` / `escalated` / `dismissed` / `proceeded` /
`went-back` / `left-page`, plus the `approached` / `focused` / `typed` /
`submitted` engagement micro-events, which are logged for **all five**
conditions), `condition`, a `visitId` grouping all events of one flagged
page-load, and for Progressive Reveal the `stage` reached. The full detection snapshot (signals, flagged elements,
reasoning, comparison) is stored **once per visit on the `shown` event**; later
events in the visit omit it to keep storage lean.

**Data is structured by visit.** The viewer groups events into visit sections —
one per flagged page-load — with a metric header per visit: `time to react`
(shown → terminal action), `engaged` time (shown → last event), `first signal`
time, stage reached, escalation count, manual advances, and per-signal counts.
Each visit's events expand underneath it (rows are still expandable to the
detection detail: pHash + Hamming distance, keyword match, domain flag with
typosquat edit distance, flagged elements, reasoning, official-vs-actual).

**The participant-facing view beats the console.** Click **View logs** in the
popup footer to open `/logs.html`: the full history, filterable by date range,
event type, condition, and free-text search, with the per-install participant
ID and assigned condition shown at the top. **Send to study** uploads the
current (filtered) view straight to the submission site using the Google
account via `chrome.identity` — no separate sign-in step. It requires the
`oauth2.client_id` in `wxt.config.ts` and a non-empty submission-site origin
(`DEV_SUBMISSION_SITE` / `PROD_SUBMISSION_SITE` in `wxt.config.ts`). **Export JSON** (from the same
page) downloads a file a researcher can import — schema v3, a `visits` array
(nested events + derived metrics) plus participant ID, assigned condition, and
extension version — respecting whatever filters are currently applied. A
visit's `complete: false` flag marks visits that a filter cut short, so only an
unfiltered export should be trusted for metric-level analysis.

To check the participant ID directly:

```js
browser.storage.local.get('phish_participant').then(console.log)
```

**The stage at the terminal action is the headline measurement** — how much
evidence it took before the participant acted. That's what makes Progressive
Reveal comparable against the fixed conditions.

To check the assigned condition directly:

```js
browser.storage.local.get('phish_condition_assignment').then(console.log)
```

`source` is `'random'` for a real assignment and `'dev-override'` if the picker
was used, so test data stays distinguishable from real data.

---

## 8. Known gaps

Worth knowing before drawing conclusions from pilot data:

- **`left-page` is best-effort, not guaranteed.** It's sent fire-and-forget to
  the background on `pagehide`, so it survives most navigations but isn't
  guaranteed under aggressive context teardown. It closes the old blind spot —
  a participant who reacts by navigating away is now counted — but treat it as
  a soft signal rather than a hard one.
- **Micro-events are logged for all five conditions.** `approached` / `focused` /
  `typed` / `submitted` come from one shared engagement tracker that runs for
  every condition, so they are directly comparable across conditions — only
  Progressive Reveal additionally *acts* on them to escalate. Detection is
  identical across conditions by design: `approached` uses a hysteresis latch
  (fire once on reaching the field, re-arm only after a clear exit) precisely so
  that conditions rendering at the field (PR, Tooltip) can't accrue extra
  incidental approaches versus Banner/Modal. A caveat still worth checking in
  pilot data: `focused`/`typed` require a real credential field, so a page with
  none (e.g. a homepage clone) yields no typing signal in any condition.
- **Filtered exports break visit metrics.** The `complete` flag marks visits a
  filter cut short; only an unfiltered export should be used for metric-level
  analysis.
- **Thresholds are guesses.** 6s/6s/8s and 120px are starting values, not
  findings. Pilot with ~8–10 people, look at the distribution of highest stage
  reached, then **freeze them**. Changing thresholds mid-study makes
  participants non-comparable, the same hazard as re-randomising assignment.
- **Evidence count varies by page.** Progressive Reveal is only interesting when
  there are several pieces to reveal; a page yielding 1–2 makes it nearly
  indistinguishable from a plain modal.
