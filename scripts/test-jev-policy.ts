/**
 * Policy tests for the optional Jev layer. Pure functions, no network.
 * Run with: pnpm test:jev-policy
 */

import assert from 'node:assert/strict';
import { applyJevPolicy, JEV_POLICY } from '../src/utils/jev-policy.ts';

const localResult = {
  riskScore: 0.9,
  matchedBrand: 'paypal',
  flaggedElements: [],
  reasoning: 'Local pipeline verdict.',
};

function jev(overrides = {}) {
  return {
    model: 'jev-1.14.0',
    promptVersion: 'test',
    phishingProbability: 0.5,
    verdict: 'uncertain',
    certainty: 0.9,
    impersonationLikelihood: 1,
    brandPresented: 'candidate_brand',
    latencyMs: 100,
    ...overrides,
  };
}

// Confident "legitimate" suppresses a local false positive (but never below 0).
const suppressed = applyJevPolicy(
  localResult,
  jev({ phishingProbability: 0.02, verdict: 'legitimate', certainty: 0.98 }),
);
assert.ok(
  suppressed.riskScore <= JEV_POLICY.suppressedCap,
  `expected risk <= ${JEV_POLICY.suppressedCap}, got ${suppressed.riskScore}`,
);
assert.ok(suppressed.riskScore < 0.5, 'suppressed verdict must not render a warning');

// Confident "phishing" escalates a borderline local verdict.
const escalated = applyJevPolicy(
  { ...localResult, riskScore: 0.6 },
  jev({ phishingProbability: 0.95, verdict: 'phishing', certainty: 0.95 }),
);
assert.ok(
  escalated.riskScore >= JEV_POLICY.escalatedFloor,
  `expected risk >= ${JEV_POLICY.escalatedFloor}, got ${escalated.riskScore}`,
);

// Low confidence leaves the local verdict untouched.
const unchanged = applyJevPolicy(
  localResult,
  jev({ phishingProbability: 0.02, certainty: 0.2 }),
);
assert.equal(unchanged.riskScore, localResult.riskScore);

// A failed call never changes the verdict, and the error is kept for the log.
const failed = applyJevPolicy(localResult, jev({ error: 'timeout', certainty: 0 }));
assert.equal(failed.riskScore, localResult.riskScore);
assert.equal(failed.jev?.error, 'timeout');

// A confident but middling answer blends instead of overriding.
const blended = applyJevPolicy(
  { ...localResult, riskScore: 0.8 },
  jev({ phishingProbability: 0.5, certainty: 0.9 }),
);
assert.ok(Math.abs(blended.riskScore - 0.71) < 1e-9, `expected 0.71, got ${blended.riskScore}`);

console.log('jev-policy: all assertions passed');
