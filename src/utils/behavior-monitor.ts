import type { FlaggedElement } from '@/lib/types';

/**
 * Progressive Reveal's hesitation monitor.
 *
 * ## The model
 *
 * Progressive Reveal is ONE self-contained condition with four internal
 * stages -- not a fallback chain, and not the other four conditions firing in
 * sequence. A participant assigned to it never experiences banner/modal/
 * tooltip/icon as conditions; those renderers are reused as *containers*
 * inside its stages, which is invisible to the participant.
 *
 * Every stage advances two things together, never one alone:
 *
 *   stage 1  0 evidence items  + passive icon      (watching for a reaction)
 *   stage 2  1 evidence item   + on-page highlight (light-touch annotation)
 *   stage 3  2 evidence items  + banner
 *   stage 4  all evidence      + blocking modal    (forces a decision)
 *
 * So stage 3 is never "the same one item, but louder" -- more evidence *and*
 * a louder container, in lockstep. That pairing is what the study is testing.
 *
 * ## Escalation is lazy
 *
 * A stage advances only while hesitation keeps actively firing. Someone who
 * reads the stage 1 icon and leaves has *completed* the interaction -- they
 * should never see stages 2-4, and "acted at stage 1" is the result, not a
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

/** Distance (px) from the credential field's box that counts as approaching. */
const APPROACH_PX = 120;

/**
 * Dwell only escalates if the participant interacted within this window (and
 * the page is visible). This is what makes escalation lazy rather than a plain
 * timer -- an abandoned tab stops progressing instead of reaching a modal
 * nobody is looking at.
 */
const ENGAGEMENT_WINDOW_MS = 10_000;

/** Minimum gap between signal-driven escalations. */
const SIGNAL_COOLDOWN_MS = 1500;

/** mousemove sampling interval (ms). */
const MOVE_THROTTLE_MS = 150;

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
}

export interface BehaviorMonitor {
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

/**
 * The *visible* credential field whose vicinity counts as intent to enter
 * credentials, or null if none is on screen.
 *
 * Visibility is essential here. A login form inside a collapsed panel still
 * matches the selector, but a hidden element reports its rect at (0,0) with no
 * size -- so "within 120px of the password field" silently becomes "within
 * 120px of the top-left corner of the window", and moving the mouse up there
 * escalates for no reason. With no visible field there is no approach to
 * detect, and the signal is simply off.
 */
function credentialField(): HTMLElement | null {
  const candidates = [
    ...Array.from(document.querySelectorAll<HTMLElement>('input[type="password"]')),
    ...Array.from(document.querySelectorAll<HTMLElement>('input:not([type="hidden"])')),
  ];
  for (const el of candidates) {
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') continue;
    return el;
  }
  return null;
}

export function createBehaviorMonitor(options: BehaviorMonitorOptions): BehaviorMonitor {
  const { flaggedElements, onEscalate } = options;

  let stage: EscalationStage = FIRST_STAGE;
  let disposed = false;
  let stageEnteredAt = Date.now();
  let lastInteractionAt = Date.now();
  let lastSignalEscalation = 0;
  let lastMoveSampledAt = 0;
  let wasNearField = false;
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
   * cannot jump straight from stage 1 to stage 4.
   */
  function signalEscalate(): void {
    const now = Date.now();
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
    escalate();
  }

  function onMove(event: MouseEvent): void {
    noteInteraction();
    const now = Date.now();
    if (now - lastMoveSampledAt < MOVE_THROTTLE_MS) return;
    lastMoveSampledAt = now;

    const field = credentialField();
    if (!field) return;
    const box = field.getBoundingClientRect();
    const dx = Math.max(box.left - event.clientX, 0, event.clientX - box.right);
    const dy = Math.max(box.top - event.clientY, 0, event.clientY - box.bottom);
    const near = Math.hypot(dx, dy) <= APPROACH_PX;

    // Fire on *entering* the zone, not continuously while inside it.
    if (near && !wasNearField) signalEscalate();
    wasNearField = near;
  }

  function onFocusIn(event: FocusEvent): void {
    noteInteraction();
    const target = event.target;
    if (target instanceof HTMLElement && target.matches('input[type="password"]')) {
      signalEscalate();
    }
  }

  function onKeyDown(): void {
    noteInteraction();
    const active = document.activeElement;
    // Typing into the password field despite a warning is the strongest signal
    // available: hesitation has been overridden by intent.
    if (active instanceof HTMLElement && active.matches('input[type="password"]')) {
      signalEscalate();
    }
  }

  function destroy(): void {
    if (disposed) return;
    disposed = true;
    if (tick != null) {
      clearInterval(tick);
      tick = null;
    }
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('scroll', noteInteraction, true);
    document.removeEventListener('focusin', onFocusIn, true);
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('visibilitychange', noteInteraction);
    window.removeEventListener('pagehide', destroy);
  }

  window.addEventListener('mousemove', onMove, { passive: true });
  window.addEventListener('scroll', noteInteraction, { passive: true, capture: true });
  document.addEventListener('focusin', onFocusIn, true);
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('visibilitychange', noteInteraction);
  // Navigating away or closing the tab stops the monitor rather than letting
  // listeners leak into the next page.
  window.addEventListener('pagehide', destroy);

  tick = window.setInterval(onTick, TICK_MS);
  enterStage(FIRST_STAGE, 'start');

  return {
    currentStage: () => stage,
    // Something is still unrevealed, or the confirmation has yet to appear.
    hasMoreEvidence: () => stage < LAST_STAGE,
    isFinalStage: () => stage >= LAST_STAGE,
    advance: () => escalate('manual'),
    destroy,
  };
}
