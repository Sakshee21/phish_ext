/**
 * Group interaction events into visits and derive per-visit metrics.
 *
 * Pure and dependency-free (no browser APIs), so it runs identically in the
 * logs page, the export builder, and the Node test script. A "visit" is one
 * flagged page-load: every event tagged with the same `visitId` (the `shown`,
 * any `escalated` stages, engagement micro-events, and the terminal action).
 *
 * Events without a `visitId` are **ignored**. They can only come from
 * old-format data or a stale content script (one that survived an extension
 * reload, which keeps running pre-`visitId` code and writes directly to the
 * same storage key). Such events cannot be grouped into a meaningful visit, so
 * showing them as single-event visits is noise -- the "one page, many batches"
 * failure mode. They are excluded from grouping and export instead.
 *
 * Metrics are computed over whatever events are passed in. When a caller
 * filters the stream (logs page filters, export), a visit's `complete` flag
 * records whether the whole stored visit made it into the result -- an
 * unfiltered export is the only one with fully correct metrics.
 */

import type { InteractionEvent, InteractionEventType } from '@/utils/interaction-log';

const TERMINAL_TYPES: ReadonlySet<InteractionEventType> = new Set([
  'dismissed',
  'proceeded',
  'went-back',
  'left-page',
]);

const SIGNAL_TYPES: ReadonlySet<InteractionEventType> = new Set([
  'approached',
  'focused',
  'typed',
]);

/** Per-visit study metrics, derived from the event stream. */
export interface VisitMetrics {
  /** ms from the warning being shown to the terminal action, or null if the
   *  participant never acted (e.g. the page just went away). */
  timeToReactMs: number | null;
  /** ms from shown to the last event of the visit -- time spent in the
   *  engagement, including escalations. */
  engagedMs: number;
  /** ms from shown to the first engagement micro-event, or null if none. */
  timeToFirstSignalMs: number | null;
  /** Highest Progressive Reveal stage reached, or null for static conditions. */
  stagesReached: number | null;
  /** Number of 'escalated' events. */
  escalationCount: number;
  /** Escalations the participant pulled themselves ('manual'), not pushed. */
  manualAdvances: number;
  approachCount: number;
  focusCount: number;
  typedCount: number;
  /**
   * Times credentials were actually submitted on this flagged page.
   *
   * The study's primary outcome. Kept separate from typedCount because typing
   * and submitting are different decisions -- someone can type and think
   * better of it, and only submission hands the credentials over.
   */
  submittedCount: number;
  /** The terminal event type, or null if the visit has no terminal action. */
  terminalType: InteractionEventType | null;
}

export interface Visit {
  /** The grouping key -- the `visitId` of the events it contains. */
  visitId: string;
  url: string;
  matchedBrand: string | null;
  riskScore: number;
  condition: InteractionEvent['condition'];
  /** ts of the 'shown' event that started the visit. */
  firstShownAt: number;
  /** ts of the last event in the visit. */
  lastEventAt: number;
  eventCount: number;
  /** Whether the whole stored visit is included (false when filtered). */
  complete: boolean;
  /** Detection snapshot lifted from the 'shown' event. */
  result?: InteractionEvent['result'];
  metrics: VisitMetrics;
  /** The visit's events, oldest first. */
  events: InteractionEvent[];
}

function groupCount(visitId: string, events: InteractionEvent[]): number {
  return events.reduce((n, e) => (e.visitId === visitId ? n + 1 : n), 0);
}

function computeMetrics(
  sorted: InteractionEvent[],
  firstShownAt: number,
  lastEventAt: number,
  terminal: InteractionEvent | null,
): VisitMetrics {
  const terminalType = terminal?.type ?? null;
  const firstSignal = sorted.find((e) => SIGNAL_TYPES.has(e.type)) ?? null;

  let stagesReached: number | null = null;
  let escalationCount = 0;
  let manualAdvances = 0;
  let approachCount = 0;
  let focusCount = 0;
  let typedCount = 0;
  let submittedCount = 0;

  for (const e of sorted) {
    if (e.type === 'escalated') {
      escalationCount++;
      if (e.trigger === 'manual') manualAdvances++;
    }
    if (e.type === 'approached') approachCount++;
    if (e.type === 'focused') focusCount++;
    if (e.type === 'typed') typedCount++;
    if (e.type === 'submitted') submittedCount++;
    if (e.stage != null && (stagesReached === null || e.stage > stagesReached)) {
      stagesReached = e.stage;
    }
  }

  return {
    timeToReactMs: terminal && terminalType ? terminal.ts - firstShownAt : null,
    engagedMs: lastEventAt - firstShownAt,
    timeToFirstSignalMs: firstSignal ? firstSignal.ts - firstShownAt : null,
    stagesReached,
    escalationCount,
    manualAdvances,
    approachCount,
    focusCount,
    typedCount,
    submittedCount,
    terminalType,
  };
}

/**
 * Group events into visits (newest visit first) with derived metrics.
 *
 * @param events     The events to include (possibly filtered).
 * @param fullEvents The complete stored stream, for the `complete` flag.
 *                   Defaults to `events`, i.e. everything is included.
 */
export function groupVisits(events: InteractionEvent[], fullEvents: InteractionEvent[] = events): Visit[] {
  const groups = new Map<string, InteractionEvent[]>();
  events.forEach((e) => {
    // Old-format / stale-script events have no visitId and cannot be grouped
    // into a real visit -- ignore them rather than surfacing fake ones.
    if (!e.visitId) return;
    const group = groups.get(e.visitId) ?? [];
    group.push(e);
    groups.set(e.visitId, group);
  });

  const visits: Visit[] = [];
  for (const [key, group] of groups) {
    const sorted = [...group].sort((a, b) => a.ts - b.ts);
    const shown = sorted.find((e) => e.type === 'shown') ?? sorted[0];
    if (!shown) continue;

    const lastEventAt = sorted[sorted.length - 1]!.ts;
    const terminal = [...sorted].reverse().find((e) => TERMINAL_TYPES.has(e.type)) ?? null;

    visits.push({
      visitId: key,
      url: shown.url,
      matchedBrand: shown.matchedBrand,
      riskScore: shown.riskScore,
      condition: shown.condition,
      firstShownAt: shown.ts,
      lastEventAt,
      eventCount: sorted.length,
      complete: sorted.length === groupCount(key, fullEvents),
      // The detection snapshot is stored once per visit, on the `shown`
      // event. Fall back to any event that still carries one, so a
      // type-filtered export that excludes `shown` doesn't lose it.
      result: shown.result ?? sorted.find((e) => e.result)?.result,
      metrics: computeMetrics(sorted, shown.ts, lastEventAt, terminal),
      events: sorted,
    });
  }

  return visits.sort((a, b) => b.firstShownAt - a.firstShownAt);
}