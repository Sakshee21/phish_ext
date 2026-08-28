/**
 * Manual test for visit grouping + metrics (src/utils/visits.ts).
 *
 * Runs on synthetic interaction events, no browser needed:
 *   node --experimental-strip-types scripts/test-visits.ts
 *   (pnpm test:visits)
 */

import { groupVisits, type Visit } from '../src/utils/visits.ts';
import type { InteractionEvent } from '../src/utils/interaction-log.ts';

let failures = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? '✅' : '❌'} ${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}

const resultStub = { reasoning: 'test verdict' };

function ev(partial: Partial<InteractionEvent> & Pick<InteractionEvent, 'type' | 'ts' | 'url' | 'visitId'>): InteractionEvent {
  return {
    riskScore: 0.9,
    matchedBrand: 'paypal',
    condition: 'progressive',
    ...partial,
  };
}

// ── Visit A: a full progressive visit ──
const visitA: InteractionEvent[] = [
  ev({ type: 'shown', ts: 1000, visitId: 'a', stage: 1, result: resultStub }),
  ev({ type: 'approached', ts: 2200, visitId: 'a', stage: 1 }),
  ev({ type: 'focused', ts: 2600, visitId: 'a', stage: 1 }),
  ev({ type: 'escalated', ts: 4000, visitId: 'a', stage: 2, trigger: 'auto' }),
  ev({ type: 'typed', ts: 5200, visitId: 'a', stage: 2 }),
  ev({ type: 'escalated', ts: 8000, visitId: 'a', stage: 3, trigger: 'manual' }),
  ev({ type: 'went-back', ts: 9000, visitId: 'a', stage: 3 }),
];

// ── Visit B: static banner visit, dismissed ──
const visitB: InteractionEvent[] = [
  ev({ type: 'shown', ts: 100, visitId: 'b', condition: 'banner' }),
  ev({ type: 'dismissed', ts: 1500, visitId: 'b', condition: 'banner' }),
];

// ── Visit C: warning shown, no terminal action recorded ──
const visitC: InteractionEvent[] = [
  ev({ type: 'shown', ts: 200, visitId: 'c' }),
];

// ── A legacy event with no visitId: must be dropped, not shown as a visit ──
const legacy = ev({ type: 'shown', ts: 50, visitId: undefined as unknown as string });

const all = [...visitA, ...visitB, ...visitC, legacy];
const visits = groupVisits(all);
const byId = new Map(visits.map((v) => [v.visitId, v]));
const a = byId.get('a');
const b = byId.get('b');
const c = byId.get('c');

check('drops no-visitId (legacy) events', visits.length, 3);
check('legacy event never surfaces as a visit', visits.some((v) => v.visitId.startsWith('legacy')), false);
check('visits sorted newest first', visits.map((v) => v.visitId), ['a', 'c', 'b']);

const aMetrics = a!.metrics;
check('timeToReactMs', aMetrics.timeToReactMs, 8000);
check('engagedMs', aMetrics.engagedMs, 8000);
check('timeToFirstSignalMs', aMetrics.timeToFirstSignalMs, 1200);
check('stagesReached', aMetrics.stagesReached, 3);
check('escalationCount', aMetrics.escalationCount, 2);
check('manualAdvances', aMetrics.manualAdvances, 1);
check('approachCount', aMetrics.approachCount, 1);
check('focusCount', aMetrics.focusCount, 1);
check('typedCount', aMetrics.typedCount, 1);
check('terminalType (A)', aMetrics.terminalType, 'went-back');
check('eventCount (A)', a!.eventCount, 7);
check('visit header from shown (A)', a!.matchedBrand, 'paypal');
check('complete when unfiltered (A)', a!.complete, true);

check('timeToReactMs (B)', b!.metrics.timeToReactMs, 1400);
check('terminalType (B)', b!.metrics.terminalType, 'dismissed');
check('stagesReached null (B)', b!.metrics.stagesReached, null);

check('timeToReactMs null (C)', c!.metrics.timeToReactMs, null);
check('terminalType null (C)', c!.metrics.terminalType, null);
check('engagedMs (C)', c!.metrics.engagedMs, 0);

// ── Filtering: only the shown event of visit A included -> incomplete ──
const partialVisits = groupVisits([visitA[0]!], all);
const partialA = partialVisits[0]!;
check('complete false when filtered', partialA.complete, false);
check('filtered visit eventCount', partialA.eventCount, 1);

console.log(failures === 0 ? '\n✅ All visit-metric checks passed' : `\n❌ ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);