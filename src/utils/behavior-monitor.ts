import type { FlaggedElement } from '@/lib/types';

/**
 * Progressive Reveal's hesitation monitor.
 *
 * ## The model
 *
 * Progressive Reveal is ONE self-contained condition with internal
 * stages -- not a fallback chain, and not the other four conditions firing in
 * sequence. A participant assigned to it never experiences banner/modal/
 * tooltip/icon as conditions; those renderers are reused as *containers*
 * inside its stages, which is invisible to the participant.
 *
 * Every stage advances two things together, never one alone: how much
 * evidence is revealed, and how insistently it is presented.
 *
 * The ladder is NOT a fixed four steps. Its length is derived from the
 * verdict:
 *
 *   stage 1          watching. Toolbar badge only, no evidence shown.
 *   stage 1 + k      the k-th piece of evidence, outlined on the page
 *                    (k = 1..N, earlier outlines staying up)
 *   stage N + 2      everything outlined + a confirmation modal that
 *                    requires an explicit decision
 *
 * so `finalStage(total) = total + 2`. A page yielding 6 pieces of evidence
 * runs 8 stages; one yielding 2 runs 4.
 *
 * It is dynamic because the evidence count is: one page gives a copied logo,
 * a lookalike domain, reused wording, a matching palette and a hotlinked
 * asset, another gives two of those. Pinning the ladder at four steps would
 * mean either cramming several pieces into one stage or padding empty ones,
 * and both destroy the measurement -- the number of stages someone sees is
 * meant to record how much evidence they needed before reacting.
 *
 * ## Escalation is lazy
 *
 * A stage advances only while hesitation keeps actively firing. Someone who
 * reads the stage 1 icon and leaves has *completed* the interaction -- they
 * should never see the later stages, and "acted at stage 1" is the result, not a
 * failure to escalate. Idle is not hesitation either: a tab left open while
 * the participant walks away must not march itself to a modal, so dwell only
 * counts while the page is visible and they have interacted recently.
 *
 * This module owns signals and the state machine only. It does no rendering:
 * it hands the caller a stage plus the slice of evidence that stage should
 * reveal, and the caller composes the existing renderers. Keeping it that way
 * is what stops per-stage rendering logic being duplicated here.
 */

/**
 * Stages are 1-based and their count depends on the verdict:
 *
 *   stage 1            watching. Toolbar badge, no evidence shown.
 *   stage 1 + k        the k-th piece of evidence revealed on the page
 *                      (k = 1..N, outlines accumulating)
 *   stage N + 2        every piece shown, and a final decision is required.
 *
 * So a verdict with 5 pieces of evidence runs 1 + 5 + 1 = 7 stages. Evidence
 * depth is the whole ladder; the only container change is the confirmation at
 * the end, once there is nothing left to reveal.
 */
export type EscalationStage = number;

const FIRST_STAGE: EscalationStage = 1;

/** Evidence revealed at a stage: none while watching, then one more each step. */
function evidenceCountAt(stage: EscalationStage, total: number): number {
  if (stage <= 1) return 0;
  return Math.min(stage - 1, total);
}

/** The last stage: everything revealed, decision required. */
function finalStage(total: number): EscalationStage {
  return total + 2;
}

// -- Tunables ---------------------------------------------------------------
// Starting values, to be tuned from pilot data and then FROZEN before real
// collection: changing them mid-study makes participants non-comparable, the
// same hazard as re-randomising assignment and just as invisible afterwards.

/** Dwell (ms) at stage 1 before the first piece of evidence appears. */
const WATCH_DWELL_MS = 6000;

/** Dwell (ms) between one piece of evidence and the next. */
const EVIDENCE_DWELL_MS = 6000;

/** Dwell (ms) after the last piece before the confirmation is required. */
const CONFIRM_DWELL_MS = 8000;

/**
 * Dwell only escalates if the participant interacted within this window (and
 * the page is visible). This is what makes escalation lazy rather than a plain
 * timer -- an abandoned tab stops progressing instead of reaching a modal
 * nobody is looking at.
 */
const ENGAGEMENT_WINDOW_MS = 10_000;

/**
 * Beyond the first reveal, dwell alone is not enough: a *hesitation* signal
 * (cursor approaching the credential field, focus landing in it, typing) must
 * have fired since the current stage appeared.
 *
 * Without this, any mouse movement anywhere on the page counted as engagement,
 * so evidence marched forward on a 6-second clock whether or not the
 * participant was still heading for the credentials -- which is the thing the
 * escalation is supposed to be responding to. Someone who reads the first
 * piece of evidence and stops now stays where they are; the count of stages
 * they saw stays a measurement of what they needed, not of how long they left
 * the tab open.
 */
const REQUIRE_HESITATION_AFTER_FIRST_REVEAL = true;

/** Minimum gap between signal-driven escalations. */
const SIGNAL_COOLDOWN_MS = 1500;

/** How often the dwell check re-evaluates. */
const TICK_MS = 500;

// -- API --------------------------------------------------------------------

/**
 * What caused a stage to be entered.
 * - 'start'  the monitor beginning at stage 1
 * - 'auto'   hesitation signals pushed the participant forward
 * - 'manual' the participant asked for more evidence ("Next")
 *
 * Worth keeping distinct in the log: evidence someone *sought out* is a
 * different behaviour from evidence that was pushed at them, and the two
 * should not be pooled when comparing conditions.
 */
export type EscalationTrigger = 'start' | 'auto' | 'manual';

/** A hesitation signal the monitor observed, for the study log. */
export type HesitationSignal = 'approached' | 'focused' | 'typed';

export interface BehaviorMonitorOptions {
  /** The full evidence set; each stage reveals a prefix of it. */
  flaggedElements: FlaggedElement[];
  /**
   * Called on entering every stage, including stage 1 at start. Receives the
   * stage, exactly the evidence that stage should show, and what caused it.
   */
  onEscalate: (
    stage: EscalationStage,
    evidenceSlice: FlaggedElement[],
    trigger: EscalationTrigger,
  ) => void;
  /**
   * Called when a hesitation signal is observed: the cursor approached the
   * credential field, focus landed in it, or the participant started typing
   * into it. The monitor only uses these to escalate; logging them is the
   * caller's job (they fire even when the escalation is rate-limited).
   */
  onSignal?: (signal: HesitationSignal) => void;
}

export interface BehaviorMonitor {
  /**
   * Report a hesitation signal observed by the shared engagement tracker.
   *
   * The monitor deliberately does not detect these itself: they are the
   * study's primary outcome and must be measured identically for every
   * condition, so one tracker owns detection and Progressive Reveal is simply
   * the only condition that also *acts* on them.
   */
  noteHesitation(signal: HesitationSignal): void;
  /** The stage currently showing -- log this alongside terminal actions. */
  currentStage(): EscalationStage;
  /** True while evidence remains to reveal (i.e. a "Next" should be offered). */
  hasMoreEvidence(): boolean;
  /** True once everything is revealed and a decision is being asked for. */
  isFinalStage(): boolean;
  /** Participant-initiated advance. Not rate-limited: it is an explicit ask. */
  advance(): void;
  /** Remove every listener and timer. Idempotent. */
  destroy(): void;
}

export function createBehaviorMonitor(options: BehaviorMonitorOptions): BehaviorMonitor {
  const { flaggedElements, onEscalate } = options;

  let stage: EscalationStage = FIRST_STAGE;
  let disposed = false;
  let stageEnteredAt = Date.now();
  let lastInteractionAt = Date.now();
  let lastSignalEscalation = 0;
  /** When a hesitation signal last fired (approach / focus / typing). */
  let lastHesitationAt = 0;
  let tick: number | null = null;

  const total = flaggedElements.length;
  const LAST_STAGE = finalStage(total);

  const evidenceFor = (s: EscalationStage): FlaggedElement[] =>
    flaggedElements.slice(0, evidenceCountAt(s, total));

  /** How long the current stage waits before advancing on its own. */
  function dwellFor(s: EscalationStage): number {
    if (s <= 1) return WATCH_DWELL_MS;
    // The step that would reveal the last item leads into the confirmation.
    return evidenceCountAt(s, total) >= total ? CONFIRM_DWELL_MS : EVIDENCE_DWELL_MS;
  }

  function enterStage(next: EscalationStage, trigger: EscalationTrigger): void {
    stage = next;
    stageEnteredAt = Date.now();
    onEscalate(stage, evidenceFor(stage), trigger);
  }

  function escalate(trigger: EscalationTrigger = 'auto'): void {
    if (disposed || stage >= LAST_STAGE) return;
    enterStage(stage + 1, trigger);
  }

  /**
   * Escalation from a discrete signal, rate-limited so a burst of keystrokes
   * cannot jump several stages at once.
   */
  function signalEscalate(): void {
    const now = Date.now();
    lastHesitationAt = now;
    if (now - lastSignalEscalation < SIGNAL_COOLDOWN_MS) return;
    lastSignalEscalation = now;
    escalate();
  }

  const noteInteraction = () => {
    lastInteractionAt = Date.now();
  };

  /** Still-here-and-engaged check that gates dwell-based escalation. */
  function isEngaged(): boolean {
    return (
      document.visibilityState === 'visible'
      && Date.now() - lastInteractionAt <= ENGAGEMENT_WINDOW_MS
    );
  }

  function onTick(): void {
    if (disposed || stage >= LAST_STAGE) return;
    if (Date.now() - stageEnteredAt < dwellFor(stage)) return;
    // Dwell is up, but only escalate if they are actually still here. If not,
    // the stage persists -- it does not skip ahead once they come back.
    if (!isEngaged()) {
      stageEnteredAt = Date.now();
      return;
    }
    // Past the first reveal, require that they are still moving toward the
    // credentials. Reading the evidence and stopping ends the escalation.
    if (REQUIRE_HESITATION_AFTER_FIRST_REVEAL && stage > 1 && lastHesitationAt < stageEnteredAt) {
      return;
    }
    escalate();
  }

  /** Any activity at all, which only keeps the engagement window alive. */
  function onActivity(): void {
    noteInteraction();
  }

  /** A hesitation signal from the shared tracker: they are still heading for
   *  the credentials, so the next piece of evidence is warranted. */
  function noteHesitation(_signal: HesitationSignal): void {
    if (disposed) return;
    noteInteraction();
    signalEscalate();
  }

  function destroy(): void {
    if (disposed) return;
    disposed = true;
    if (tick != null) {
      clearInterval(tick);
      tick = null;
    }
    window.removeEventListener('mousemove', onActivity);
    window.removeEventListener('scroll', onActivity, true);
    document.removeEventListener('keydown', onActivity, true);
    document.removeEventListener('visibilitychange', noteInteraction);
    window.removeEventListener('pagehide', destroy);
  }

  window.addEventListener('mousemove', onActivity, { passive: true });
  window.addEventListener('scroll', onActivity, { passive: true, capture: true });
  document.addEventListener('keydown', onActivity, true);
  document.addEventListener('visibilitychange', noteInteraction);
  // Navigating away or closing the tab stops the monitor rather than letting
  // listeners leak into the next page.
  window.addEventListener('pagehide', destroy);

  tick = window.setInterval(onTick, TICK_MS);
  enterStage(FIRST_STAGE, 'start');

  return {
    noteHesitation,
    currentStage: () => stage,
    // Something is still unrevealed, or the confirmation has yet to appear.
    hasMoreEvidence: () => stage < LAST_STAGE,
    isFinalStage: () => stage >= LAST_STAGE,
    advance: () => escalate('manual'),
    destroy,
  };
}
