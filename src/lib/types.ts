// ── Brand reference dataset (per brand, generated at build time) ──

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

export interface DetectionResult {
  /** 0.0 (safe) – 1.0 (definitely phishing) */
  riskScore: number;
  /** Brand that triggered the match, or null if no match */
  matchedBrand: string | null;
  /** Specific elements that triggered the flag */
  flaggedElements: FlaggedElement[];
  /** Human-readable explanation of the verdict */
  reasoning: string;
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
  kind: 'logo' | 'login-form' | 'password-field';
  /** Extra context, e.g. a logo's src or alt text. */
  detail?: string;
}


export interface DOMFeatures {
  url: string;
  /** Present login form fields (input[type=password], etc.) */
  hasLoginForm: boolean;
  /** Number of password-type input fields */
  passwordFieldCount: number;
  /** src attributes of any <img> elements that look like logos */
  logoCandidates: string[];
  /** Dominant CSS colours extracted from the page */
  dominantColors: string[];
  /** Text content keywords (first 500 chars of visible text) */
  pageKeywords: string[];
  /** Page <title> */
  title: string;
  /** Elements a warning can highlight (logo, login form, password field). */
  elements: ElementLocation[];
}

// ── Message types for the three-way communication ──
// background ↔ offscreen

export interface ComputePHashMessage {
  type: 'COMPUTE_PHASH';
  /** Base64-encoded PNG screenshot data */
  imageData: string;
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

// content → background (warning banner actions)
export interface GoBackMessage {
  type: 'GO_BACK';
}

// popup → background (re-run the pipeline on the active tab after a condition change)
export interface RescanMessage {
  type: 'RESCAN';
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
  | GoBackMessage
  | RescanMessage;
