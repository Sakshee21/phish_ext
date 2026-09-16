// ── Brand reference dataset (per brand, generated at build time) ──

import type { WarningCondition } from '@/lib/conditions';
import type { LoggedResult } from '@/utils/interaction-log';

export interface BrandReference {
  /** Brand identifier, e.g. "paypal", "google" */
  id: string;
  /** Human-readable brand name */
  name: string;
  /** Pre-computed perceptual hash of the real login page */
  phash: string;
  /** Optional pHash per capture viewport, keyed e.g. "1280x800". Layer 1
   *  compares against the closest viewport to tolerate window-size drift. */
  phashByViewport?: Record<string, string>;
  /** Hamming-distance threshold for a "close" match (<= 5 for pHash) */
  phashThreshold: number;
  /** List of legitimate domains (e.g. ["paypal.com", "paypalobjects.com"]) */
  allowedDomains: string[];
  /** Second-level domains that should NOT appear except as allowedDomains */
  protectedBrands: string[];
  /** Dominant color palette (hex strings) */
  colors: string[];
  /** Brand-specific keywords found on the real login page */
  keywords: string[];
  /** Base64-encoded logo template image (embedded in brands.json) */
  logoTemplate: string;
  /**
   * Small JPEG data URL of the real brand page, bundled by tools/generate.py.
   * Detection makes no network calls, so this is the only way to show someone
   * what the genuine site actually looks like. Absent on older datasets.
   */
  referenceThumbnail?: string;
  /** Computed font-family of the real brand page. */
  fontFamily?: string;
}

// ── Detection pipeline output ──

export type FlagReason = 'visual_similarity' | 'domain_mismatch' | 'logo_match' | 'form_layout' | 'color_scheme' | 'brand_keywords' | 'typosquatting';

export interface FlaggedElement {
  /** What was flagged */
  element: string;
  /** Why it was flagged (internal classification) */
  reason: FlagReason;
  /** Optional CSS selector or bounding box to highlight */
  selector?: string;
  /** Optional user-facing popover heading (e.g. "Logo appears copied") */
  title?: string;
  /** Optional per-element explanation shown in the warning popover */
  note?: string;
}

/** What the genuine brand looks like, for showing beside the suspicious page. */
export interface BrandComparison {
  name: string;
  /** The brand's primary official domain. */
  officialDomain: string;
  /** The hostname actually serving this page. */
  actualDomain: string;
  /** Data URL of the real page, if the dataset has one. */
  thumbnail?: string;
  /** The brand's real colour palette. */
  colors: string[];
  /** The real site's font stack, if the dataset has it. */
  fontFamily?: string;
}

export interface DetectionResult {
  /** 0.0 (safe) – 1.0 (definitely phishing) */
  riskScore: number;
  /** Brand that triggered the match, or null if no match */
  matchedBrand: string | null;
  /** Specific elements that triggered the flag */
  flaggedElements: FlaggedElement[];
  /** Human-readable explanation of the verdict */
  reasoning: string;
  /** Side-by-side context: what the real brand looks like. */
  comparison?: BrandComparison;
  /**
   * The raw signals behind the verdict, persisted in the interaction log so
   * a researcher can see which layers fired (and how hard) -- the live
   * screenshot pHash + distance, the text keyword match, the domain check.
   * The warning UI ignores it; it exists for logging and offline analysis.
   */
  signals?: DetectionSignals;
}

/** Raw Layer 1/2/3 signals, captured at pipeline time for the study log. */
export interface DetectionSignals {
  /** Perceptual hash of the live screenshot (Layer 1 input). */
  phash?: string;
  /** Hamming distance to the nearest brand reference (out of 64 bits). */
  visualDistance?: number;
  /**
   * How the brand was identified from page text (Layer 3). 'context' means
   * the brand is never named in the page text: the match rests on distinctive
   * wording plus colour/typeface corroboration.
   */
  nameMatch?: 'exact' | 'lookalike' | 'context';
  /** Brand keywords found in the page text. */
  matchedKeywords?: string[];
  /** For a lookalike name: which brand token and which page word. */
  lookalike?: { brandToken: string; pageWord: string };
  /** Layer 2 domain legitimacy outcome. */
  domain?: {
    hostname: string;
    flagReason?: 'domain_mismatch' | 'typosquatting';
    /** The official domain the hostname is suspiciously close to, if any. */
    matchedAllowedDomain?: string;
    /** Edit distance to that domain (0 for homoglyphs). */
    distance?: number;
  };
}

// ── DOM features extracted by the content script ──

/**
 * A concrete element on the page that a warning can point at (Layer 3's
 * "element localization"). The selector is resolved against the same document
 * the content script read it from, so it stays valid for the warning UI.
 */
export interface ElementLocation {
  /** CSS selector resolving to this element on the current page. */
  selector: string;
  /** What the element is. */
  kind: 'logo' | 'login-form' | 'password-field' | 'external-asset' | 'brand-text' | 'color-block';
  /** Extra context: a logo's src/alt, or the host an asset is loaded from. */
  detail?: string;
}


export interface DOMFeatures {
  url: string;
  /** Present login form fields (input[type=password], etc.) */
  hasLoginForm: boolean;
  /** Number of password-type input fields */
  passwordFieldCount: number;
  /**
   * The page collects credentials, whether or not a password box is present.
   *
   * Two-step logins (Shopify, Google, Microsoft) ask for the identifier first,
   * so a clone's first screen has only an email field. Gating identification
   * on a password field misses that entire class of phishing page.
   */
  hasCredentialField?: boolean;
  /** src attributes of any <img> elements that look like logos */
  logoCandidates: string[];
  /** Dominant CSS colours extracted from the page */
  dominantColors: string[];
  /** Text content keywords (first 500 chars of visible text) */
  pageKeywords: string[];
  /** Page <title> */
  title: string;
  /**
   * window.devicePixelRatio of the page. Layer 1 needs it to convert the
   * captureVisibleTab screenshot (device pixels) into CSS pixels for the
   * fixed CSS-px hash band. Chromium folds page zoom into this value, which
   * matches what the capture actually contains.
   */
  devicePixelRatio?: number;
  /** Computed font-family of the page body, for comparison with the brand's. */
  fontFamily?: string;
  /** Elements a warning can highlight (logo, login form, password field). */
  elements: ElementLocation[];
}

// ── Message types for the three-way communication ──
// background ↔ offscreen

export interface ComputePHashMessage {
  type: 'COMPUTE_PHASH';
  /** Base64-encoded PNG screenshot data */
  imageData: string;
  /**
   * Ratio the screenshot was captured at (`window.devicePixelRatio`, which in
   * Chromium also folds in browser zoom). The hash band is measured in CSS
   * pixels, so this converts it to image pixels. Absent/invalid → treated as 1.
   */
  devicePixelRatio?: number;
}

export interface PHashResultMessage {
  type: 'PHASH_RESULT';
  /** Computed pHash string */
  hash: string;
}

export interface MatchLogosMessage {
  type: 'MATCH_LOGOS';
  imageData: string;
  brandId: string;
}

export interface LogoMatchResultMessage {
  type: 'LOGO_MATCH_RESULT';
  matches: Array<{ x: number; y: number; width: number; height: number }>;
}

// background → content / content → background

export interface DetectedMessage {
  type: 'DETECTED';
  result: DetectionResult;
  /**
   * Per-visit id minted by the background when the verdict was computed. The
   * content script attaches every interaction of this warning to it, and the
   * popup's false-positive report references the same visit.
   */
  visitId: string;
}

export interface PageReadyMessage {
  type: 'PAGE_READY';
  url: string;
  features: DOMFeatures;
}

// background → content (pull DOM features on demand, Layer 3 input)
export interface GetFeaturesMessage {
  type: 'GET_FEATURES';
}

export interface FeaturesResultMessage {
  type: 'FEATURES_RESULT';
  features: DOMFeatures;
}

// content → background (toolbar badge; content scripts cannot call action.*)
export interface SetBadgeMessage {
  type: 'SET_BADGE';
  /** Badge text, or null to clear it. */
  text: string | null;
}

// content → background (terminal event when the participant leaves the page
// while a warning is active). Sent fire-and-forget on `pagehide`, because a
// page context about to be torn down can't await a storage write; the
// background does the actual logging.
/**
 * Credentials were actually submitted on a flagged page.
 *
 * Sent to the background rather than logged in place: submitting starts a
 * navigation, so a storage write from the content script would usually not
 * finish. Same reason as LEFT_PAGE.
 */
export interface SubmittedMessage {
  type: 'SUBMITTED';
  result: DetectionResult;
  condition: WarningCondition | null;
  stage?: number;
  visitId: string;
  url: string;
}

export interface LeftPageMessage {
  type: 'LEFT_PAGE';
  result: DetectionResult;
  condition: WarningCondition | null;
  /** Progressive Reveal stage reached, if the active condition was progressive. */
  stage?: number;
  /** The visit this page-load belonged to, so the terminal event groups
   *  with its 'shown' and escalation events. */
  visitId: string;
  url: string;
}

// content → background (warning banner actions)
export interface GoBackMessage {
  type: 'GO_BACK';
}

// popup → background (re-run the pipeline on the active tab after a condition change)
export interface RescanMessage {
  type: 'RESCAN';
}

// popup ↔ background (enable/disable the extension for casual browsing)
export interface GetEnabledMessage {
  type: 'GET_ENABLED';
}

export interface EnabledStatusMessage {
  type: 'ENABLED_STATUS';
  enabled: boolean;
}

export interface SetEnabledMessage {
  type: 'SET_ENABLED';
  enabled: boolean;
}

// background → content (protection was turned off: tear down any warning UI)
export interface ExtensionDisabledMessage {
  type: 'EXTENSION_DISABLED';
}

// popup ↔ background (false-positive reporting)

/**
 * The active tab's last verdict, stored by the background after each
 * pipeline run. `result` is the sanitized snapshot (no thumbnail or CSS
 * selectors) -- exactly what a false-positive report needs to carry.
 */
export interface TabVerdict {
  visitId: string;
  url: string;
  hostname: string;
  matchedBrand: string | null;
  riskScore: number;
  /** Whether the domain layer called the page suspicious -- a warning fired. */
  isSuspicious: boolean;
  condition: WarningCondition | null;
  /** Already reported from the popup: one report per visit. */
  reported: boolean;
  ts: number;
  result: LoggedResult;
}

// popup → background (ask for the active tab's last verdict)
export interface GetTabStatusMessage {
  type: 'GET_TAB_STATUS';
  tabId: number;
}

// background → popup (answer to GET_TAB_STATUS)
export interface TabStatusMessage {
  type: 'TAB_STATUS';
  entry: TabVerdict | null;
}

// popup → background (submit a false-positive report for the active tab)
export interface ReportFalsePositiveMessage {
  type: 'REPORT_FALSE_POSITIVE';
  tabId: number;
}

// background → popup (answer to REPORT_FALSE_POSITIVE)
export interface ReportResultMessage {
  type: 'REPORT_RESULT';
  ok: boolean;
  error?: string;
  /** The visit was already reported; the UI shows the reported state. */
  alreadyReported?: boolean;
}

export type ExtensionMessage =
  | ComputePHashMessage
  | PHashResultMessage
  | MatchLogosMessage
  | LogoMatchResultMessage
  | DetectedMessage
  | PageReadyMessage
  | GetFeaturesMessage
  | FeaturesResultMessage
  | SetBadgeMessage
  | LeftPageMessage
  | SubmittedMessage
  | GoBackMessage
  | RescanMessage
  | GetEnabledMessage
  | EnabledStatusMessage
  | SetEnabledMessage
  | ExtensionDisabledMessage
  | GetTabStatusMessage
  | TabStatusMessage
  | ReportFalsePositiveMessage
  | ReportResultMessage;
