/**
 * Typed messaging helpers for background ↔ content ↔ offscreen communication.
 *
 * In Manifest V3, the three extension contexts communicate via
 * `browser.runtime.sendMessage` / `browser.runtime.onMessage`.
 *
 * Communication flows:
 *
 *   Background ──────────────────► Offscreen
 *     COMPUTE_PHASH                    → PHASH_RESULT
 *     MATCH_LOGOS                      → LOGO_MATCH_RESULT   (stub)
 *
 *   Background ──────────────────► Content
 *     DETECTED                         (verdict -> warning UI)
 *     GET_FEATURES                     → FEATURES_RESULT     (DOM pull)
 *     EXTENSION_DISABLED               (tear down any warning)
 *
 *   Content ─────────────────────► Background
 *     PAGE_READY (vestigial)           SET_BADGE
 *     LEFT_PAGE                        SUBMITTED
 *     GO_BACK                          RESCAN
 *
 *   Popup ───────────────────────► Background
 *     RESCAN                           GET_ENABLED → ENABLED_STATUS
 *     SET_ENABLED                      GET_TAB_STATUS → TAB_STATUS
 *     REPORT_FALSE_POSITIVE            → REPORT_RESULT
 *
 * The logs page reads storage directly and needs no messaging. All message
 * types are defined in src/lib/types.ts.
 */

export type { ExtensionMessage } from '@/lib/types';
