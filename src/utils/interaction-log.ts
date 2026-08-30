/**
 * Interaction logging for the warning layer.
 *
 * Every time a warning is shown / dismissed / bypassed / backed-away-from, the
 * content script appends an event to `browser.storage.local` under a single
 * key. This is the raw material for the evaluation study (which warning design
 * makes users stop before entering credentials).
 */

import type { BrandComparison, DetectionResult, FlaggedElement } from '@/lib/types';
import type { WarningCondition } from '@/lib/conditions';

export type InteractionEventType =
  | 'shown'
  | 'dismissed'
  | 'proceeded'
  | 'went-back'
  | 'escalated'
  /**
   * Terminal event for the most common safe reaction: the participant simply
   * leaves the page (navigate away, close the tab, hit back) while a warning
   * is active. Without it, a participant who reacted at the first stage is
   * indistinguishable from one who ignored the warning entirely -- see the
   * `pagehide` handler in content.ts.
   */
  | 'left-page'
  // ── Engagement micro-events (every condition) ──
  // The behavior monitor already detects these; they were only used to drive
  // escalation and never logged. Logged with a minimal payload (no result
  // snapshot) so a researcher can study hesitation mechanics, not just timing.
  /** Cursor entered the ~120 px zone around the credential field. */
  | 'approached'
  /** Focus landed in the password field while a warning was active. */
  | 'focused'
  /** First keystroke in the password field (once per focus session). */
  | 'typed'
  /**
   * Credentials were submitted on a flagged page -- the outcome the whole
   * study is about. Distinct from 'typed': someone can type and think better
   * of it, and only submission actually hands the credentials over.
   */
  | 'submitted';

/**
 * A sanitized snapshot of the verdict, so a researcher can see *why* each
 * warning fired. The reference thumbnail (a base64 JPEG, ~23 KB per brand) and
 * per-element CSS selectors are stripped to keep events small; the rest of the
 * DetectionResult is kept as-is.
 */
export interface LoggedResult {
  reasoning?: string;
  signals?: DetectionResult['signals'];
  flaggedElements?: Array<Pick<FlaggedElement, 'element' | 'reason' | 'title' | 'note'>>;
  comparison?: Omit<BrandComparison, 'thumbnail'>;
}

export interface InteractionEvent {
  type: InteractionEventType;
  /** Milliseconds since epoch when the action happened. */
  ts: number;
  /** Page URL the warning was about. */
  url: string;
  riskScore: number;
  matchedBrand: string | null;
  /** Which warning-design condition was active (null if unknown). */
  condition: WarningCondition | null;
  /** Progressive Reveal stage reached; present on PR events. */
  stage?: number;
  /**
   * Groups every event of one flagged page-load into a single visit, so the
   * stages of one warning can be studied together. Minted when the warning is
   * shown. Absent only on events recorded before this field existed.
   */
  visitId?: string;
  /** For 'escalated': whether the participant pulled the next stage ('manual')
   *  or was pushed by hesitation signals ('auto'). */
  trigger?: 'auto' | 'manual';
  /** The detection detail behind this warning. Stored once per visit on the
   *  `shown` event; omitted on escalated/terminal events and micro-events. */
  result?: LoggedResult;
}

const STORAGE_KEY = 'phish_interactions';
const MAX_EVENTS = 500;

/**
 * Writes to `phish_interactions` are serialized through this chain.
 *
 * logInteraction can be called concurrently in normal use -- a burst of
 * engagement micro-events, an escalation racing a terminal action, a
 * `pagehide` LEFT_PAGE landing while a content script is mid-write, or two
 * tabs flagging at once. The storage read-modify-write would interleave
 * without this and silently drop events (last writer wins).
 */
let writeChain: Promise<void> = Promise.resolve();

/** Build the persisted snapshot, dropping the bulky/private bits. */
function sanitizeResult(result: DetectionResult): LoggedResult {
  const logged: LoggedResult = { reasoning: result.reasoning, signals: result.signals };

  if (result.flaggedElements.length > 0) {
    logged.flaggedElements = result.flaggedElements.map((f) => ({
      element: f.element,
      reason: f.reason,
      ...(f.title ? { title: f.title } : {}),
      ...(f.note ? { note: f.note } : {}),
    }));
  }

  if (result.comparison) {
    const c = result.comparison;
    logged.comparison = {
      name: c.name,
      officialDomain: c.officialDomain,
      actualDomain: c.actualDomain,
      colors: c.colors,
      ...(c.fontFamily ? { fontFamily: c.fontFamily } : {}),
    };
  }

  return logged;
}

function appendEvent(
  type: InteractionEventType,
  result: DetectionResult,
  url: string,
  options: InteractionLogInput,
): Promise<void> {
  const task = async (): Promise<void> => {
    const stored = await browser.storage.local.get(STORAGE_KEY);
    const events: InteractionEvent[] = Array.isArray(stored[STORAGE_KEY])
      ? stored[STORAGE_KEY]
      : [];

    events.push({
      type,
      ts: Date.now(),
      url,
      riskScore: result.riskScore,
      matchedBrand: result.matchedBrand,
      condition: options.condition ?? null,
      visitId: options.visitId,
      ...(options.stage != null ? { stage: options.stage } : {}),
      ...(options.trigger ? { trigger: options.trigger } : {}),
      ...(options.includeResult === false ? {} : { result: sanitizeResult(result) }),
    });

    if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
    await browser.storage.local.set({ [STORAGE_KEY]: events });
  };
  return task();
}

/** Per-event logging context shared by every call site. */
export interface InteractionLogInput {
  /** Which warning-design condition was active. */
  condition?: WarningCondition | null;
  /** Progressive Reveal stage reached. */
  stage?: number;
  /** For 'escalated': 'manual' (participant pulled it) vs 'auto' (pushed). */
  trigger?: 'auto' | 'manual';
  /** The visit this event belongs to (one per flagged page-load). */
  visitId: string;
  /**
   * False for micro-events and for escalated/terminal events, which carry no
   * detection snapshot -- it's stored once per visit on the `shown` event.
   */
  includeResult?: boolean;
}

/**
 * Append an interaction event to the log. Bounded to the most recent
 * `MAX_EVENTS` entries so the stored payload stays small. Never throws — a
 * logging failure shouldn't break the warning flow.
 */
export async function logInteraction(
  type: InteractionEventType,
  result: DetectionResult,
  url: string,
  options: InteractionLogInput,
): Promise<void> {
  const run = writeChain.then(() => appendEvent(type, result, url, options));
  // Keep the chain alive even if one write fails.
  writeChain = run.catch(() => {});
  try {
    await run;
  } catch (err) {
    // Most often this is a content script that outlived its extension (any
    // rebuild with the tab still open) -- harmless while developing, but it
    // means a lost data point, so say so rather than swallowing it.
    const stale = String(err).includes('Extension context invalidated');
    console.warn(
      stale
        ? '[phish_ext] Interaction NOT logged - this tab is running a stale content script. Reload the page after reloading the extension.'
        : '[phish_ext] Failed to log interaction:',
      stale ? '' : err,
    );
  }
}