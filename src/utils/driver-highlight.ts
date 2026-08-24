import { driver, type DriveStep } from 'driver.js';
// `?inline` gives the stylesheet as a string instead of a side-effecting
// import. A plain `import 'driver.js/dist/driver.css'` gets bundled into the
// content script's stylesheet, which WXT injects via the manifest on *every*
// page the content script matches -- so a security extension would be putting
// visible styling infrastructure on every page a participant visits, flagged
// or not. Injected on demand instead: see `ensureStyles()`.
import driverCss from 'driver.js/dist/driver.css?inline';

import type { FlaggedElement } from '@/lib/types';

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
    .filter((t): t is { flagged: FlaggedElement; el: HTMLElement } => Boolean(t?.el));
  if (targets.length === 0) return;

  outlineLayer = document.createElement('div');
  outlineLayer.id = OUTLINE_ID;
  outlineLayer.style.cssText =
    'position:fixed;inset:0;pointer-events:none;z-index:2147483646;';

  const boxes = targets.map(({ flagged }, index) => {
    const box = document.createElement('div');
    box.style.cssText =
      'position:absolute;border:3px solid #b3261e;border-radius:6px;'
      + 'box-shadow:0 0 0 3px rgba(179,38,30,0.25);transition:all .15s ease;';
    const label = document.createElement('div');
    label.textContent = `${index + 1}. ${flagged.title ?? flagged.element}`;
    label.style.cssText =
      'position:absolute;top:-24px;left:-3px;background:#b3261e;color:#fff;'
      + 'font:600 11px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;'
      + 'padding:1px 8px;border-radius:4px;white-space:nowrap;';
    box.append(label);
    outlineLayer!.append(box);
    return box;
  });

  document.body.append(outlineLayer);

  repositionOutlines = () => {
    targets.forEach(({ el }, i) => {
      const rect = el.getBoundingClientRect();
      const box = boxes[i];
      if (!box) return;
      box.style.left = `${rect.left - 3}px`;
      box.style.top = `${rect.top - 3}px`;
      box.style.width = `${rect.width}px`;
      box.style.height = `${rect.height}px`;
    });
  };
  repositionOutlines();
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
  styleElement.textContent = driverCss;
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

function stepForElement(flagged: FlaggedElement, offerNext: boolean): DriveStep {
  return {
    element: flagged.selector || undefined,
    // Without a usable selector Driver.js shows the popover unanchored rather
    // than failing on a missing node.
    skipMissingElement: true,
    popover: {
      title: flagged.title ?? humanizeReason(flagged.reason),
      description: flagged.note ?? '',
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
export function highlightEvidence(evidence: FlaggedElement[], onNext?: () => void): void {
  clearHighlight();

  if (evidence.length === 0) return;

  ensureStyles();

  // Everything revealed so far that maps to an element stays outlined. Some
  // evidence (the domain, reused wording) is not a thing on the page, so it
  // gets a popover but no outline -- it still has to be shown.
  drawOutlines(evidence.filter((f) => f.selector));
  const newest = evidence[evidence.length - 1]!;

  activeHighlight = driver({
    steps: [stepForElement(newest, Boolean(onNext))],
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
