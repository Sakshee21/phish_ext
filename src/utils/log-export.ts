/**
 * Build the JSON payload a participant exports from the logs page.
 *
 * Pure and dependency-free so the shape is easy to unit-test and safe to
 * change without touching the page's DOM. The payload carries only study
 * fields -- the visits (each with its nested events and derived metrics) plus
 * minimal attribution (participant id, assigned condition, extension version,
 * export time). No device/browser info, so an export is the least identifying
 * thing that still lets a researcher group a participant's sessions.
 *
 * Schema history:
 * - 1: flat event stream.
 * - 2: each event carried the per-warning detail snapshot (`result`).
 * - 3: flat `events` replaced by a structured `visits` array with per-visit
 *      metrics (see `src/utils/visits.ts`).
 */

import type { ConditionAssignment } from '@/utils/condition-assignment';
import type { Visit } from '@/utils/visits';

export interface LogExport {
  schemaVersion: 3;
  /** ISO timestamp of when the export was produced. */
  exportedAt: string;
  /** Extension version the events were recorded under. */
  extensionVersion: string;
  /** Stable per-install id, so exports from one participant group together. */
  participantId: string;
  /** The participant's study condition, if it was ever assigned. */
  conditionAssignment?: ConditionAssignment;
  /**
   * The study, grouped by flagged page-load. Each visit carries its events
   * and derived metrics (time to react, engagement duration, stages reached,
   * escalation/micro-event counts). Respects the filters the participant
   * chose; a visit's `complete` flag says whether it was exported whole.
   */
  visits: Visit[];
}

export interface BuildLogExportInput {
  visits: Visit[];
  participantId: string | null;
  conditionAssignment: ConditionAssignment | null;
  extensionVersion: string;
}

export function buildLogExport(input: BuildLogExportInput): LogExport {
  const { visits, participantId, conditionAssignment, extensionVersion } = input;
  return {
    schemaVersion: 3,
    exportedAt: new Date().toISOString(),
    extensionVersion,
    participantId: participantId ?? 'unknown',
    ...(conditionAssignment ? { conditionAssignment } : {}),
    visits,
  };
}