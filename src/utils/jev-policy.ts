/**
 * Code-owned policy for combining the local verdict with Jev's second opinion.
 *
 * Jev sorts and adjusts; it does not get to invent a verdict from nothing. The
 * local pipeline always runs first, and the policy is deliberately conservative
 * on the suppress side: a missed warning is recoverable, but silencing a real
 * phishing page is not.
 *
 * Thresholds are here (not in the prompt) so they can be reviewed and tuned.
 */

import type { DetectionResult, JevAssessment } from '@/lib/types';

export const JEV_POLICY = {
  /** Below this Choice confidence, keep the local score untouched. */
  minCertainty: 0.6,
  /** At/below this Noul probability, a confident Jev can suppress the warning. */
  suppressBelow: 0.2,
  /** At/above this, a confident Jev can force a warning. */
  escalateAbove: 0.8,
  /** Local score cap when Jev confidently says the page is legitimate. */
  suppressedCap: 0.35,
  /** Local score floor when Jev confidently says the page is phishing. */
  escalatedFloor: 0.8,
} as const;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

/**
 * Apply Jev's assessment to the local result.
 *
 * - Confident "legitimate" → cap the risk below the warning threshold.
 * - Confident "phishing" → raise the risk to at least the warning threshold.
 * - Confident but middling → blend, so Jev nudges rather than overrides.
 * - Low confidence or an error → leave the local verdict exactly as it was.
 */
export function applyJevPolicy(result: DetectionResult, jev: JevAssessment): DetectionResult {
  if (jev.error) return { ...result, jev };

  const local = result.riskScore;
  const probability = jev.phishingProbability;
  const certain = jev.certainty >= JEV_POLICY.minCertainty;

  let risk = local;
  if (certain && probability <= JEV_POLICY.suppressBelow) {
    risk = Math.min(local, JEV_POLICY.suppressedCap);
  } else if (certain && probability >= JEV_POLICY.escalateAbove) {
    risk = Math.max(local, JEV_POLICY.escalatedFloor);
  } else if (certain) {
    // The local score is rule-based and uncalibrated; Jev's probability is the
    // calibrated input. Lean on Jev, but keep the local signal in the blend.
    risk = 0.7 * local + 0.3 * probability;
  }

  return { ...result, riskScore: clamp01(risk), jev };
}
