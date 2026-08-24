/**
 * Interaction logging for the warning layer.
 *
 * Every time a warning is shown / dismissed / bypassed / backed-away-from, the
 * content script appends an event to `browser.storage.local` under a single
 * key. This is the raw material for the evaluation study (which warning design
 * makes users stop before entering credentials).
 */

import type { DetectionResult } from '@/lib/types';
import type { WarningCondition } from '@/lib/conditions';

export type InteractionEventType = 'shown' | 'dismissed' | 'proceeded' | 'went-back' | 'escalated';

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
  /** Progressive Reveal stage reached (1-4); present for PR events. */
  stage?: number;
}

const STORAGE_KEY = 'phish_interactions';
const MAX_EVENTS = 500;

/**
 * Append an interaction event to the log. Bounded to the most recent
 * `MAX_EVENTS` entries so the stored payload stays small. Never throws — a
 * logging failure shouldn't break the warning flow.
 */
export async function logInteraction(
  type: InteractionEventType,
  result: Pick<DetectionResult, 'riskScore' | 'matchedBrand'>,
  url: string,
  condition: WarningCondition | null = null,
  stage?: number,
): Promise<void> {
  try {
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
      condition,
      ...(stage != null ? { stage } : {}),
    });

    if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
    await browser.storage.local.set({ [STORAGE_KEY]: events });
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