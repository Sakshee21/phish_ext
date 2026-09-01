import { driver, type DriveStep } from 'driver.js';
// `?inline` gives the stylesheet as a string instead of a side-effecting
// import. A plain `import 'driver.js/dist/driver.css'` gets bundled into the
// content script's stylesheet, which WXT injects via the manifest on *every*
// page the content script matches -- so a security extension would be putting
// visible styling infrastructure on every page a participant visits, flagged
// or not. Injected on demand instead: see `ensureStyles()`.
import driverCss from 'driver.js/dist/driver.css?inline';

import type { BrandComparison, FlaggedElement } from '@/lib/types';
import type { WarningActions } from '@/components/renderers/types';

/**
 * Driver.js adapter for Progressive Reveal's stage 2 container.
 *
 * Used *only* by Progressive Reveal. The four static conditions each show
 * exactly one thing and never a spotlight -- a participant assigned to
 * 'banner' sees a banner, full stop.
 *
 * Each reveal stage annotates the page with exactly one new piece of evidence.
 * The tour chrome is deliberately stripped -- no previous button, no
 * "Evidence X of Y" progress text -- because both imply a browsable set of
 * items, which is the wrong signal at a stage that has revealed one and is
 * withholding the rest.
 *
 * The page *is* dimmed around the spotlit element: an annotation nobody
 * notices measures nothing, and the dimming is what makes the evidence read as
 * the subject of the screen rather than as page furniture. It stays purely
 * visual -- the page underneath remains fully usable (see EXTRA_CSS).
 */

let activeHighlight: ReturnType<typeof driver> | null = null;
/**
 * True while we are destroying the popover ourselves (a stage transition).
 * Driver.js fires onDestroyed either way, and without this a normal
 * escalation would be logged as though the participant had dismissed it.
 */
let tearingDownInternally = false;
let styleElement: HTMLStyleElement | null = null;
let outlineLayer: HTMLElement | null = null;
let blurLayer: HTMLElement | null = null;
/**
 * The evidence currently outlined, in reveal order. Stages only ever append
 * to this (the ladder reveals a growing prefix of the same list), so a stage
 * transition adds boxes instead of rebuilding the layer -- which is what
 * keeps the blur mask from blinking off and back on between stages.
 */
interface OutlineEntry {
  flagged: FlaggedElement;
  el: HTMLElement;
  box: HTMLElement;
}
let outlineEntries: OutlineEntry[] = [];
/** The options of the most recent render, so stale driver callbacks (which
 *  capture nothing) still act on the current stage's wiring. */
let currentOptions: HighlightOptions | null = null;

const OUTLINE_ID = 'phish-ext-evidence-outlines';

/**
 * Above the dimming overlay (10000) so accumulated evidence stays bright
 * rather than greying out with the page, but below Driver's popover (1e9) so
 * an outline never paints over the text explaining it.
 */
const OUTLINE_Z = 999_999_999;

/** The blur sits just under the outlines, so the boxes stay crisp. */
const BLUR_Z = 999_999_998;

/**
 * Light on purpose. Enough that the page reads as pushed-back and the sharp
 * evidence becomes the subject of the screen, but not so much that the page
 * is unreadable -- the participant still has to be able to weigh the page and
 * decide, and a warning that removes the choice measures nothing.
 *
 * Also kept small because the layer is a full-viewport backdrop-filter whose
 * mask is repainted on every scroll frame: the larger the radius, the heavier
 * that continuous re-rasterization gets, which reads as jank.
 */
const BLUR_PX = 2;

/** Breathing room around each unblurred hole. */
const HOLE_PAD = 6;

/** 3px of breathing room on every side of an outline box, hence +6 on each dimension. */
const PAD = 3;

/** Styling for our popover additions, appended to Driver.js's own stylesheet. */
const EXTRA_CSS = `
/* Driver.js resets only the popover wrapper (all:unset); its children inherit
   whatever the host page declares. On a dark-themed site that paints the
   description black-on-black, so every child is pinned explicitly here. */
.phish-popover, .phish-popover * {
  box-sizing: border-box !important;
  text-shadow: none !important;
  text-transform: none !important;
  letter-spacing: normal !important;
  float: none !important;
}
/* Presence without blocking. The evidence stage has to be *noticed* -- a
   quiet tooltip on a busy page gets read as chrome and ignored -- but it must
   still leave the page usable, so the weight goes into size, a red spine,
   depth, and a brief entrance rather than into an overlay. */
.phish-popover {
  background: #fff !important; color: #3c4043 !important;
  min-width: 300px !important; max-width: 380px !important;
  padding: 15px 17px !important;
  border-radius: 12px !important;
  border-left: 5px solid #b3261e !important;
  box-shadow: 0 12px 34px rgba(0,0,0,.30), 0 0 0 1px rgba(179,38,30,.20) !important;
  animation: phish-pop-in .22s cubic-bezier(.2,.8,.3,1) both;
}
@keyframes phish-pop-in {
  from { opacity: 0; transform: translateY(7px) scale(.97); }
  to   { opacity: 1; transform: none; }
}
/* Motion is what actually catches the eye, so the newest outline pulses --
   three times, then settles. Left running it would become wallpaper, and on a
   warning that is worse than not animating at all. */
@keyframes phish-pulse {
  0%, 100% { box-shadow: 0 0 0 3px rgba(179,38,30,.18), 0 2px 10px rgba(0,0,0,.12); }
  50%      { box-shadow: 0 0 0 9px rgba(179,38,30,.32), 0 2px 16px rgba(0,0,0,.20); }
}
.phish-outline-newest { animation: phish-pulse 1.1s ease-in-out 3; }
@media (prefers-reduced-motion: reduce) {
  .phish-popover { animation: none !important; }
  .phish-outline-newest { animation: none !important; }
}
/* Driver builds the title as a <header> and the footer as a <footer> (the
   description is a <div>). Those are semantic tags, so a host page's own
   "header { height: 88px }" -- every site has one -- lands straight on our
   title and leaves a tall empty band under one line of text. all:unset only
   guards the popover wrapper, not these children, so their box has to be pinned
   back to content-sized here. Height is the one that bit us; width/max-height
   are the same class of bleed, closed pre-emptively. */
.phish-popover .driver-popover-title,
.phish-popover .driver-popover-description,
.phish-popover .driver-popover-footer {
  background: none !important; background-color: transparent !important;
  border: 0 !important; box-shadow: none !important;
  height: auto !important; max-height: none !important; width: auto !important;
  min-height: 0 !important; min-width: 0 !important;
  margin-left: 0 !important; margin-right: 0 !important; padding: 0 !important;
}
.phish-popover .driver-popover-title {
  color: #b3261e !important; font-size: 15px !important; font-weight: 700 !important;
  line-height: 1.35 !important; display: flex !important; align-items: flex-start !important; gap: 8px !important;
}
/* A warning mark in the heading: at a glance this reads as a warning rather
   than as a product tooltip. */
.phish-popover .driver-popover-title::before {
  content: "!"; flex: none;
  width: 20px !important; height: 20px !important;
  background: #b3261e !important; color: #fff !important;
  border-radius: 50% !important;
  font: 700 13px/20px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif !important;
  text-align: center !important;
}
.phish-popover .driver-popover-description { font-size: 13px !important; line-height: 1.55 !important; color: #3c4043 !important; margin-top: 8px !important; }
.phish-popover .driver-popover-description div { background: none !important; background-color: transparent !important; }
.phish-popover .phish-compare {
  display: flex; align-items: center; gap: 6px; margin-top: 8px;
  font: 600 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
}
.phish-popover .phish-compare-bad {
  background-color: rgba(179,38,30,0.09) !important; color: #8c1d18 !important;
  border: 1px solid rgba(179,38,30,0.25) !important; border-radius: 4px; padding: 2px 6px !important;
}
.phish-popover .phish-compare-good {
  background-color: rgba(30,125,52,0.09) !important; color: #155d27 !important;
  border: 1px solid rgba(30,125,52,0.25) !important; border-radius: 4px; padding: 2px 6px !important;
}
.phish-popover .phish-compare-vs { color: #9aa0a6; font-weight: 500; }
.phish-popover .driver-popover-footer { margin-top: 12px !important; }
.phish-popover .phish-btn {
  all: unset; cursor: pointer; border-radius: 6px; padding: 6px 12px;
  font: 600 12.5px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  color: #5f6368; border: 1px solid #d0d7de; margin-right: 6px;
}
.phish-popover .phish-btn:hover { background-color: #f3f4f6 !important; }
/* The strong button keeps its white text on hover, so it must NOT inherit the
   light hover background -- white on near-white is invisible. Darken the red
   instead. Declared after .phish-btn:hover and matching its specificity, so
   this wins the cascade for the strong button only. */
.phish-popover .phish-btn-strong:hover {
  color: #fff !important;
  background-color: #8c1d18 !important;
  border-color: #8c1d18 !important;
}
.phish-popover .phish-btn-strong { color: #fff !important; background-color: #b3261e !important; border-color: #b3261e !important; }
/* driver.css blocks interaction in TWO separate ways, and both have to go.
   The obvious one is the overlay swallowing clicks. The other is easy to miss:
   Driver puts a driver-active class on <body>, and its stylesheet carries
   ".driver-active * { pointer-events: none }" -- which freezes the entire
   page, not just the overlay.

   That second one would have quietly wrecked the study. Whether the
   participant types into the credential field IS the primary outcome, so a
   frozen page records Progressive Reveal as perfectly effective for a reason
   that has nothing to do with the warning design: they could not have complied
   even if they wanted to. Every condition has to leave it possible to fall for
   the page; only then does refusing to mean anything.

   Dimming is visual, interception is behavioural, and only the first is
   wanted. Specificity note: ".driver-active .driver-overlay" (0,2,0) has to
   outrank the ".driver-active *" reset (0,1,0) restoring the page. */
.driver-active * { pointer-events: auto !important; }
.driver-active .driver-overlay { pointer-events: none !important; }
.driver-popover, .driver-popover * { pointer-events: auto !important; }
`;

/**
 * The evidence currently marked, resolved to live elements.
 *
 * Elements flagged without a selector (the domain, the typeface) are not
 * things on the page, so they get a popover but no outline -- they still have
 * to be shown. Elements whose selector no longer resolves or that render 0x0
 * (a collapsed login panel) are skipped rather than marked as an invisible box
 * pointing at nothing.
 */
function computeTargets(evidence: FlaggedElement[]): Array<{ flagged: FlaggedElement; el: HTMLElement }> {
  return evidence
    .filter((f) => f.selector)
    .map((f) => ({ flagged: f, el: document.querySelector<HTMLElement>(f.selector!) }))
    .filter((t): t is { flagged: FlaggedElement; el: HTMLElement } => {
      if (!t?.el) return false;
      // A hidden element (a collapsed login panel, say) would draw a 0x0 box
      // pointing at nothing. Skip rather than mark something invisible.
      const rect = t.el.getBoundingClientRect();
      return rect.width >= 2 && rect.height >= 2;
    });
}

function makeBox(flagged: FlaggedElement, position: number): HTMLElement {
  const box = document.createElement('div');
  box.style.cssText =
    // border-box so the 2px border sits inside the measured box -- otherwise
    // the outline renders 4px wider than the element it is framing.
    'position:absolute;box-sizing:border-box;border:3px solid #b3261e;border-radius:7px;'
    + 'background:rgba(179,38,30,0.08);'
    + 'box-shadow:0 0 0 3px rgba(179,38,30,0.18), 0 2px 10px rgba(0,0,0,0.12);'
    + 'transition:left .15s ease, top .15s ease, width .15s ease, height .15s ease;';
  const label = document.createElement('div');
  label.textContent = `${position + 1}. ${flagged.title ?? flagged.element}`;
  label.style.cssText =
    'position:absolute;top:-26px;left:-3px;background:#b3261e;color:#fff;'
    + 'font:700 12px/1.75 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;'
    + 'padding:2px 10px;border-radius:6px 6px 6px 0;white-space:nowrap;'
    + 'box-shadow:0 3px 8px rgba(0,0,0,0.28);max-width:320px;overflow:hidden;'
    + 'text-overflow:ellipsis;letter-spacing:.01em;';
  box.append(label);
  return box;
}

/**
 * Repaint the outlines so they track their elements, and re-cut the blur's
 * holes to match. Runs on every append and on every scroll/resize frame.
 */
function place(): void {
  if (!outlineLayer) return;
  const holes: Hole[] = [];
  outlineEntries.forEach(({ el, box }) => {
    const rect = el.getBoundingClientRect();
    // An element scrolled out of view (or collapsed since capture) should
    // not leave a stray box floating at the edge of the screen.
    const offscreen =
      rect.width < 2 || rect.height < 2
      || rect.bottom < 0 || rect.top > window.innerHeight
      || rect.right < 0 || rect.left > window.innerWidth;
    box.style.display = offscreen ? 'none' : 'block';
    if (offscreen) return;
    box.style.left = `${rect.left - PAD}px`;
    box.style.top = `${rect.top - PAD}px`;
    box.style.width = `${rect.width + PAD * 2}px`;
    box.style.height = `${rect.height + PAD * 2}px`;
    // Everything revealed so far stays sharp, not just the newest piece --
    // the participant is meant to be assembling a picture from the evidence,
    // and blurring what they have already been shown would undo that.
    holes.push({ left: rect.left, top: rect.top, width: rect.width, height: rect.height });
  });
  // While the frost is suspended (a scroll gesture in progress) the mask is
  // not on screen -- skip the style writes and re-cut the holes once, on
  // resume.
  if (blurLayer && !blurSuspended) paintBlurHoles(holes);
}

// ── Blur suspension during scroll ──
// The blur is a full-viewport backdrop-filter whose mask must chase the
// elements on every scroll frame -- one whole-page re-rasterization per frame,
// which is by far the heaviest thing on screen. Reading, on the other hand,
// re-filters nothing. So the frost is suspended while the page is actually
// moving and restored shortly after it settles: the dim overlay underneath
// stays up the whole time, so the visual drops from "dim + frost" to "dim
// only" for the length of the gesture and back -- no brightness jump, no
// full-page re-filter storm.

/** How long after the last scroll/resize event the frost is restored. */
const BLUR_RESUME_MS = 150;

let blurSuspended = false;
let blurResumeTimer: number | null = null;

function suspendBlurForScroll(): void {
  if (!blurLayer || blurSuspended) return;
  blurSuspended = true;
  blurLayer.style.display = 'none';
}

function resumeBlurAfterScroll(): void {
  blurResumeTimer = null;
  if (!blurLayer) return;
  // The holes are stale from before the gesture -- re-cut them at the settled
  // position first, so the frost comes back already aligned.
  blurSuspended = false;
  place();
  blurLayer.style.display = 'block';
}

function scheduleBlurResume(): void {
  if (blurResumeTimer != null) clearTimeout(blurResumeTimer);
  blurResumeTimer = window.setTimeout(resumeBlurAfterScroll, BLUR_RESUME_MS);
}

// Scroll fires far faster than the screen repaints; coalescing to one
// update per frame keeps the outlines locked to their elements instead of
// lagging behind them.
let frame = 0;
const onReposition = () => {
  // Scroll and resize both invalidate the blur's hole positions; suspend the
  // expensive layer for the gesture and schedule its restoration instead of
  // paying a whole-page re-filter on every frame.
  suspendBlurForScroll();
  scheduleBlurResume();
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    place();
  });
};
let listening = false;

function startListening(): void {
  if (listening) return;
  listening = true;
  window.addEventListener('scroll', onReposition, true);
  window.addEventListener('resize', onReposition);
}

function stopListening(): void {
  if (!listening) return;
  listening = false;
  window.removeEventListener('scroll', onReposition, true);
  window.removeEventListener('resize', onReposition);
}

function ensureOutlineLayer(): void {
  if (outlineLayer) return;
  outlineLayer = document.createElement('div');
  outlineLayer.id = OUTLINE_ID;
  outlineLayer.style.cssText =
    `position:fixed;inset:0;pointer-events:none;z-index:${OUTLINE_Z};`;
  document.body.append(outlineLayer);
  startListening();
}

/** The blur goes in underneath the outlines. Its holes are cut in `place()`,
 *  so it never renders as a full-page blur even for one frame. */
function ensureBlurLayer(): void {
  if (blurLayer || !canBlur()) return;
  blurLayer = document.createElement('div');
  blurLayer.style.cssText =
    `position:fixed;inset:0;pointer-events:none;z-index:${BLUR_Z};`
    + `backdrop-filter:blur(${BLUR_PX}px);-webkit-backdrop-filter:blur(${BLUR_PX}px);`;
  document.body.append(blurLayer);
}

/** Remove the blur but keep the outlines: the page returns to a readable
 *  state while everything revealed so far stays marked. Also cancels any
 *  pending scroll-gesture restoration -- without this, a timer scheduled just
 *  before a Skip could resurrect the layer afterwards. */
function removeBlur(): void {
  if (blurResumeTimer != null) {
    clearTimeout(blurResumeTimer);
    blurResumeTimer = null;
  }
  blurSuspended = false;
  blurLayer?.remove();
  blurLayer = null;
}

/**
 * Bring the outlines in line with the evidence revealed so far.
 *
 * Stages only ever *append* (the ladder reveals a growing prefix), so the
 * common path adds boxes and re-cuts the blur mask in place -- no layer
 * teardown, no flash. A rebuild happens only when the new list is not a
 * pure extension of the current one (a fresh warning, an element dropping
 * out of view and reshuffling the numbering).
 */
function syncOutlines(evidence: FlaggedElement[], showBlur: boolean): void {
  const targets = computeTargets(evidence);

  const canAppend =
    outlineLayer !== null
    && targets.length >= outlineEntries.length
    && targets.every((t, i) =>
      i >= outlineEntries.length
      || (t.flagged === outlineEntries[i]!.flagged && t.el === outlineEntries[i]!.el));

  if (!canAppend) clearOutlines();
  if (targets.length === 0) {
    if (showBlur) removeBlur();
    return;
  }

  ensureOutlineLayer();
  // The most recently revealed item pulses; the earlier ones stay put so the
  // accumulated picture does not turn into a light show.
  if (outlineEntries.length > 0) {
    outlineEntries[outlineEntries.length - 1]!.box.classList.remove('phish-outline-newest');
  }
  for (let i = outlineEntries.length; i < targets.length; i++) {
    const box = makeBox(targets[i]!.flagged, i);
    outlineLayer!.append(box);
    outlineEntries.push({ flagged: targets[i]!.flagged, el: targets[i]!.el, box });
  }
  outlineEntries[outlineEntries.length - 1]!.box.classList.add('phish-outline-newest');

  if (showBlur) ensureBlurLayer();
  else removeBlur();
  place();
}

/**
 * Can we punch holes in a blur?
 *
 * Driver's overlay is an SVG whose spotlight is a hole in its *path*, and
 * backdrop-filter clips to an element's box rather than to path geometry --
 * blurring that overlay would blur the spotlight along with everything else.
 * So the blur is our own layer, and the holes are cut with a mask.
 *
 * Both features are checked because without the mask the layer would blur the
 * entire page including the evidence, which is worse than no blur at all.
 * Unsupported means we simply keep the dimming and skip the blur.
 */
function canBlur(): boolean {
  return (
    typeof CSS !== 'undefined'
    && typeof CSS.supports === 'function'
    && CSS.supports('mask-composite', 'exclude')
    && CSS.supports('backdrop-filter', 'blur(3px)')
  );
}

type Hole = { left: number; top: number; width: number; height: number };

/**
 * Repaint the blur's mask so every revealed element stays sharp.
 *
 * The mask is a stack: one full-viewport layer at the bottom, then one layer
 * per hole above it composited with `exclude` (XOR). Since each hole lies
 * inside the full cover, XOR removes it -- which is how several holes are cut
 * at once, one per piece of evidence revealed so far.
 */
function paintBlurHoles(all: Hole[]): void {
  if (!blurLayer) return;
  // XOR means two overlapping holes cancel back to opaque, leaving a blurred
  // patch *inside* the evidence. Flagged elements nest in practice -- a logo
  // inside a flagged header -- so drop any hole already contained in another
  // and let the larger one cover it.
  const holes = all.filter((h, i) => !all.some((other, j) => (
    j !== i
    && other.left <= h.left && other.top <= h.top
    && other.left + other.width >= h.left + h.width
    && other.top + other.height >= h.top + h.height
    // A pair of identical rects would otherwise discard both.
    && (other.width * other.height > h.width * h.height || j < i)
  )));
  const images: string[] = [];
  const sizes: string[] = [];
  const positions: string[] = [];
  const composites: string[] = [];
  // Holes first: the first mask layer is the topmost one.
  for (const h of holes) {
    images.push('linear-gradient(#000 0 0)');
    sizes.push(`${h.width + HOLE_PAD * 2}px ${h.height + HOLE_PAD * 2}px`);
    positions.push(`${h.left - HOLE_PAD}px ${h.top - HOLE_PAD}px`);
    composites.push('exclude');
  }
  images.push('linear-gradient(#000 0 0)');
  sizes.push('100% 100%');
  positions.push('0 0');
  composites.push('add');

  const style = blurLayer.style;
  style.setProperty('mask-image', images.join(','));
  style.setProperty('mask-size', sizes.join(','));
  style.setProperty('mask-position', positions.join(','));
  style.setProperty('mask-repeat', 'no-repeat');
  style.setProperty('mask-composite', composites.join(','));
}

function clearOutlines(): void {
  stopListening();
  removeBlur();
  outlineLayer?.remove();
  outlineLayer = null;
  outlineEntries = [];
}

/** Inject Driver.js's stylesheet, once, the first time a highlight is shown. */
function ensureStyles(): void {
  if (styleElement?.isConnected) return;
  styleElement = document.createElement('style');
  styleElement.dataset.phishExt = 'driver-css';
  styleElement.textContent = driverCss + EXTRA_CSS;
  (document.head ?? document.documentElement).append(styleElement);
}

/**
 * Close the popover without ending the warning.
 *
 * The page returns to a fully readable state: popover gone, blur gone. The
 * outlines stay -- what has been revealed so far remains marked -- and the
 * monitor keeps running, so the next escalation re-presents a popover with
 * the action buttons. Nothing is logged: this is deliberately not a decision,
 * unlike Dismiss.
 */
export function hidePopover(): void {
  tearingDownInternally = true;
  activeHighlight?.destroy();
  tearingDownInternally = false;
  activeHighlight = null;
  removeBlur();
}

/** True while a popover is on screen. False once Skip has closed it, which
 *  lets the caller schedule a re-present rather than leaving the participant
 *  without access to the action buttons. */
export function isPopoverVisible(): boolean {
  return activeHighlight !== null;
}

/** Destroy any highlight currently on screen, and remove its stylesheet. */
/** Full teardown: popover, outlines, blur, injected styles. Used when the
 *  whole warning ends -- not between stages, which keep their layers and
 *  update in place (see highlightEvidence). */
export function clearHighlight(): void {
  tearingDownInternally = true;
  activeHighlight?.destroy();
  tearingDownInternally = false;
  activeHighlight = null;
  currentOptions = null;
  clearOutlines();
  styleElement?.remove();
  styleElement = null;
}

/** Humanize an internal reason enum into a fallback heading. */
function humanizeReason(reason: string): string {
  return reason
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/**
 * Popover body: the reason, plus a one-line domain comparison so the claim can
 * be checked rather than just believed.
 */
function describe(flagged: FlaggedElement, comparison?: BrandComparison): string {
  const reason = escapeHtml(flagged.note ?? '');
  if (!comparison) return reason;

  // Typeface evidence disproves itself best by naming the real font; anything
  // else is best checked against the domain.
  const [bad, good] =
    flagged.element === 'typeface' && comparison.fontFamily
      ? [flagged.note?.match(/sets ([^.]+)\./)?.[1] ?? 'this page', comparison.fontFamily]
      : [comparison.actualDomain, comparison.officialDomain];

  return (
    `${reason}<div class="phish-compare">`
    + `<span class="phish-compare-bad">${escapeHtml(bad)}</span>`
    + `<span class="phish-compare-vs">vs</span>`
    + `<span class="phish-compare-good">${escapeHtml(good)}</span>`
    + `</div>`
  );
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);
}

function stepForElement(
  flagged: FlaggedElement,
  offerNext: boolean,
  comparison?: BrandComparison,
): DriveStep {
  return {
    element: flagged.selector || undefined,
    // Without a usable selector Driver.js shows the popover unanchored rather
    // than failing on a missing node.
    skipMissingElement: true,
    popover: {
      title: flagged.title ?? humanizeReason(flagged.reason),
      description: describe(flagged, comparison),
      side: 'right',
      align: 'start',
      popoverClass: 'phish-popover',
      // 'Next' pulls the *next* piece of evidence (advancing the stage) -- it
      // is not paging through a tour of evidence already on screen. No
      // progress text for the same reason: there is no "X of Y" to browse.
      showButtons: offerNext ? ['next'] : [],
      nextBtnText: 'Next',
    },
  };
}

/**
 * Spotlight exactly the evidence revealed so far.
 *
 * Called fresh on each stage transition with that stage's slice, rather than
 * loading the full evidence set into one up-front multi-step tour. A tour the
 * participant could page through would let them reach evidence the current
 * stage has not revealed yet, which would defeat the whole design.
 */
export interface HighlightOptions {
  /** Reveal the next piece of evidence. Omitted at the final stage. */
  onNext?: () => void;
  /**
   * Draw the outlines but no popover. Used at the confirmation stage, where
   * the modal is already asking for a decision -- a popover beside it would
   * be two things talking at once.
   */
  outlinesOnly?: boolean;
  /** Side-by-side context shown in the popover. */
  comparison?: BrandComparison;
  /**
   * Terminal actions. Every stage must offer a way out: the number of stages
   * someone sees is a measurement of how much evidence they needed, so a
   * participant who has already decided must be able to act immediately
   * rather than being walked through the remaining evidence.
   */
  actions?: WarningActions;
  /**
   * Close this popover without ending the warning.
   *
   * Deliberately distinct from Dismiss. A popover can sit over something the
   * participant wants to read, and wanting it out of the way is not the same
   * as having decided about the page -- so this is not logged as a decision,
   * and the outlines and the escalation both continue.
   */
  onSkip?: () => void;
}

/** A footer button matching the popover's own styling. */
function footerButton(label: string, tone: 'plain' | 'strong', onClick: () => void): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.className = tone === 'strong' ? 'phish-btn phish-btn-strong' : 'phish-btn';
  button.addEventListener('click', onClick);
  return button;
}

export function highlightEvidence(
  evidence: FlaggedElement[],
  options: HighlightOptions = {},
): void {
  currentOptions = options;
  const { onNext, comparison, actions, outlinesOnly, onSkip } = options;

  ensureStyles();

  // Everything revealed so far that maps to an element stays outlined, updated
  // in place: stages append boxes and re-cut the blur mask rather than
  // tearing the layer down, so a stage transition never blinks the blur off
  // and back on. Some evidence (the domain, reused wording) is not a thing on
  // the page, so it gets a popover but no outline -- it still has to be shown.
  syncOutlines(evidence, !outlinesOnly);

  // The confirmation stage needs no popover (the modal asks for the decision);
  // drop the driver and the blur, and let the outlines stand behind the modal.
  if (outlinesOnly) {
    hidePopover();
    return;
  }

  const newest = evidence[evidence.length - 1];
  if (!newest) return;

  // One driver instance lives for the whole warning. Each stage moves its
  // spotlight to the newest piece of evidence with `highlight()`, which
  // animates the stage path between elements and re-renders the popover --
  // instead of the old destroy-and-recreate, which replayed the overlay's
  // fade-in, re-scrolled the page and rebuilt the blur on every click.
  if (!activeHighlight) {
    activeHighlight = driver({
      // No transition animation. The animated variant interpolates the
      // full-viewport overlay SVG across 400ms, and every one of those frames
      // invalidates the full-viewport backdrop-filter blur sitting on top of
      // it -- a whole-page re-rasterization per frame, per stage click, which
      // read as slow and glitchy. Snapping is instant and the popover mounts
      // immediately (the driver-simple class also drops the popover's own
      // fade), so a stage change costs one frame instead of twenty-five.
      animate: false,
      // Dim the page around the spotlit element. Dimming and click-blocking are
      // separate concerns: the overlay is set to pointer-events:none, so the
      // page darkens but stays fully usable. Driver cuts a hole around the
      // current element, which is what makes the evidence jump out.
      overlayOpacity: 0.45,
      // An animated scroll animates the blur mask's repaint along with it.
      // Snapping once reads as steadier than gliding under a frost layer.
      smoothScroll: false,
      stageRadius: 8,
      stagePadding: 6,
      showProgress: false,
      // Explicit buttons are the only way out. Closing on an outside click made
      // any stray click on the page log a dismissal the participant never chose.
      allowClose: false,
      // Advancing means "reveal more evidence", which is the monitor's business.
      onNextClick: () => currentOptions?.onNext?.(),
      // Safety net for a teardown this module did not initiate. With
      // allowClose disabled, driver.js cannot destroy itself (ESC and the
      // close button both check allowClose), so in practice every destroy
      // here is internal -- the guard just keeps that invariant honest.
      onDestroyed: () => {
        if (!tearingDownInternally) currentOptions?.actions?.onDismiss();
      },
      // Driver.js only knows next/previous/close, so the other exits are added
      // to the footer directly. The popover DOM is rebuilt per highlight, so
      // this runs fresh each stage and cannot accumulate buttons.
      onPopoverRender: (popover) => {
        const opts = currentOptions;
        if (!opts?.actions) return;
        popover.footerButtons.prepend(
          footerButton('Go Back', 'strong', opts.actions.onGoBack),
          footerButton('Dismiss', 'plain', opts.actions.onDismiss),
          ...(opts.onSkip ? [footerButton('Skip', 'plain', opts.onSkip)] : []),
        );
      },
    });
  }

  activeHighlight.highlight(stepForElement(newest, Boolean(onNext), comparison));
}
