import { driver, type DriveStep } from 'driver.js';
// `?inline` gives the stylesheet as a string instead of a side-effecting
// import. A plain `import 'driver.js/dist/driver.css'` gets bundled into the
// content script's stylesheet, which WXT injects via the manifest on *every*
// page the content script matches -- so a security extension would be putting
// visible styling infrastructure on every page a participant visits, flagged
// or not. Injected on demand instead: see `ensureStyles()`.
import driverCss from 'driver.js/dist/driver.css?inline';

import type { BrandComparison, FlaggedElement } from '@/lib/types';

/**
 * Driver.js adapter for Progressive Reveal's stage 2 container.
 *
 * Used *only* by Progressive Reveal. The four static conditions each show
 * exactly one thing and never a spotlight -- a participant assigned to
 * 'banner' sees a banner, full stop.
 *
 * Stage 2 is defined as a light-touch on-page annotation revealing exactly one
 * piece of evidence, so the tour chrome is deliberately stripped: no overlay
 * dimming, no next/previous buttons, no "Evidence X of Y" progress text. All
 * of those imply a browsable set of items, which is precisely the wrong signal
 * at a stage that has revealed one.
 */

let activeHighlight: ReturnType<typeof driver> | null = null;
let styleElement: HTMLStyleElement | null = null;
let outlineLayer: HTMLElement | null = null;
let repositionOutlines: (() => void) | null = null;

const OUTLINE_ID = 'phish-ext-evidence-outlines';

/** Styling for our popover additions, appended to Driver.js's own stylesheet. */
const EXTRA_CSS = `
.phish-popover .driver-popover-title { color: #b3261e; font-size: 13.5px; }
.phish-popover .driver-popover-description { font-size: 12.5px; line-height: 1.5; color: #3c4043; }
.phish-popover .phish-compare {
  display: flex; align-items: center; gap: 6px; margin-top: 8px;
  font: 600 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace;
}
.phish-popover .phish-compare-bad {
  background: rgba(179,38,30,0.09); color: #8c1d18;
  border: 1px solid rgba(179,38,30,0.25); border-radius: 4px; padding: 2px 6px;
}
.phish-popover .phish-compare-good {
  background: rgba(30,125,52,0.09); color: #155d27;
  border: 1px solid rgba(30,125,52,0.25); border-radius: 4px; padding: 2px 6px;
}
.phish-popover .phish-compare-vs { color: #9aa0a6; font-weight: 500; }
`;

/**
 * Draw a persistent outline over every element revealed so far.
 *
 * Driver.js spotlights one element at a time, but evidence *accumulates*:
 * once the logo has been called out it stays called out while later stages
 * add more. These outlines are that memory -- absolutely-positioned boxes
 * tracking each element, so several can be marked at once.
 */
function drawOutlines(evidence: FlaggedElement[]): void {
  clearOutlines();
  const targets = evidence
    .map((f) => (f.selector ? { flagged: f, el: document.querySelector<HTMLElement>(f.selector) } : null))
    .filter((t): t is { flagged: FlaggedElement; el: HTMLElement } => {
      if (!t?.el) return false;
      // A hidden element (a collapsed login panel, say) would draw a 0x0 box
      // pointing at nothing. Skip rather than mark something invisible.
      const rect = t.el.getBoundingClientRect();
      return rect.width >= 2 && rect.height >= 2;
    });
  if (targets.length === 0) return;

  outlineLayer = document.createElement('div');
  outlineLayer.id = OUTLINE_ID;
  outlineLayer.style.cssText =
    'position:fixed;inset:0;pointer-events:none;z-index:2147483646;';

  const boxes = targets.map(({ flagged }, index) => {
    const box = document.createElement('div');
    box.style.cssText =
      // border-box so the 2px border sits inside the measured box -- otherwise
      // the outline renders 4px wider than the element it is framing.
      'position:absolute;box-sizing:border-box;border:2px solid #b3261e;border-radius:6px;'
      + 'background:rgba(179,38,30,0.06);'
      + 'box-shadow:0 0 0 3px rgba(179,38,30,0.18), 0 2px 10px rgba(0,0,0,0.12);'
      + 'transition:all .15s ease;';
    const label = document.createElement('div');
    label.textContent = `${index + 1}. ${flagged.title ?? flagged.element}`;
    label.style.cssText =
      'position:absolute;top:-23px;left:-2px;background:#b3261e;color:#fff;'
      + 'font:600 11px/1.7 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;'
      + 'padding:1px 9px;border-radius:5px 5px 5px 0;white-space:nowrap;'
      + 'box-shadow:0 2px 6px rgba(0,0,0,0.2);max-width:280px;overflow:hidden;'
      + 'text-overflow:ellipsis;';
    box.append(label);
    outlineLayer!.append(box);
    return box;
  });

  document.body.append(outlineLayer);

  /** 3px of breathing room on every side, hence +6 on each dimension. */
  const PAD = 3;

  const place = () => {
    targets.forEach(({ el }, i) => {
      const rect = el.getBoundingClientRect();
      const box = boxes[i];
      if (!box) return;
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
    });
  };

  // Scroll fires far faster than the screen repaints; coalescing to one
  // update per frame keeps the outlines locked to their elements instead of
  // lagging behind them.
  let frame = 0;
  repositionOutlines = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      place();
    });
  };
  place();
  window.addEventListener('scroll', repositionOutlines, true);
  window.addEventListener('resize', repositionOutlines);
}

function clearOutlines(): void {
  if (repositionOutlines) {
    window.removeEventListener('scroll', repositionOutlines, true);
    window.removeEventListener('resize', repositionOutlines);
    repositionOutlines = null;
  }
  outlineLayer?.remove();
  outlineLayer = null;
}

/** Inject Driver.js's stylesheet, once, the first time a highlight is shown. */
function ensureStyles(): void {
  if (styleElement?.isConnected) return;
  styleElement = document.createElement('style');
  styleElement.dataset.phishExt = 'driver-css';
  styleElement.textContent = driverCss + EXTRA_CSS;
  (document.head ?? document.documentElement).append(styleElement);
}

/** Destroy any highlight currently on screen, and remove its stylesheet. */
export function clearHighlight(): void {
  activeHighlight?.destroy();
  activeHighlight = null;
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
export function highlightEvidence(
  evidence: FlaggedElement[],
  onNext?: () => void,
  comparison?: BrandComparison,
): void {
  clearHighlight();

  if (evidence.length === 0) return;

  ensureStyles();

  // Everything revealed so far that maps to an element stays outlined. Some
  // evidence (the domain, reused wording) is not a thing on the page, so it
  // gets a popover but no outline -- it still has to be shown.
  drawOutlines(evidence.filter((f) => f.selector));
  const newest = evidence[evidence.length - 1]!;

  activeHighlight = driver({
    steps: [stepForElement(newest, Boolean(onNext), comparison)],
    // Light touch: outline the element, do not dim the page around it.
    overlayOpacity: 0,
    smoothScroll: true,
    stageRadius: 8,
    stagePadding: 6,
    showProgress: false,
    showButtons: onNext ? ['next'] : [],
    allowClose: true,
    // Advancing means "reveal more evidence", which is the monitor's business.
    // Driver.js must not step within its own (single-step) tour.
    onNextClick: () => onNext?.(),
  });

  activeHighlight.drive();
}
