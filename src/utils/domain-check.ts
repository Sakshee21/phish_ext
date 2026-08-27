/**
 * Domain legitimacy checks (Layer 2).
 *
 * Runs in the background service worker. Pure string operations, no DOM needed.
 *
 * ## Checks performed
 *
 * 1. **Allowlist check** — is the current domain in the brand's list of known
 *    legitimate domains? If yes, site is considered safe for that brand.
 *
 * 2. **Homoglyph detection** — substitute visually similar characters:
 *    - 0 ↔ o, 1 ↔ l, ɑ ↔ a, í ↔ i, etc.
 *    - Then check if the transformed domain matches an allowed domain.
 *    - If yes, the original domain is a homoglyph attack.
 *
 * 3. **Levenshtein distance** — if the domain is close to an allowed domain
 *    (edit distance ≤ 2), and not on the allowlist itself, it's likely
 *    typosquatting (e.g. "paypa1.com" vs "paypal.com").
 *
 * ## Levenshtein distance
 *
 * The minimum number of single-character edits (insertions, deletions,
 * substitutions) required to change one string into another.
 *
 * Implementation: standard dynamic programming O(n·m).
 */

import type { BrandReference } from '@/lib/types';

/**
 * Compute Levenshtein edit distance between two strings.
 */
export function levenshtein(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  const d = new Array<number>(n + 1).fill(0);
  let prev = 0;

  for (let j = 0; j <= n; j++) d[j] = j;

  for (let i = 1; i <= m; i++) {
    prev = d[0]!;
    d[0] = i;
    for (let j = 1; j <= n; j++) {
      const temp = d[j]!;
      d[j] = a[i - 1] === b[j - 1]
        ? prev
        : 1 + Math.min(d[j]!, d[j - 1]!, prev);
      prev = temp;
    }
  }

  return d[n]!;
}

/**
 * Homoglyph character substitution map.
 * Maps visually confusable characters to their ASCII equivalent.
 *
 * TODO: Expand this map with more substitutions.
 * Reference: https://www.unicode.org/Public/security/latest/confusables.txt
 */
const HOMOGLYPH_MAP: Record<string, string> = {
  '0': 'o',
  '1': 'l',
  'ɑ': 'a',
  'а': 'a', // Cyrillic 'а'
  'е': 'e', // Cyrillic 'е'
  'о': 'o', // Cyrillic 'о'
  'р': 'p', // Cyrillic 'р'
  'с': 'c', // Cyrillic 'с'
  'í': 'i',
  'ì': 'i',
  'î': 'i',
  'ï': 'i',
  'ā': 'a',
  'á': 'a',
  'ă': 'a',
};

/**
 * Normalize a domain string by replacing homoglyph characters.
 */
export function normalizeHomoglyphs(domain: string): string {
  return domain
    .toLowerCase()
    .split('')
    .map((ch) => HOMOGLYPH_MAP[ch] ?? ch)
    .join('');
}

/**
 * Result of a lookalike-domain check.
 */
export interface LookalikeResult {
  matched: string;
  reason: 'typosquatting' | 'homoglyph' | 'exact';
  /** Edit distance to the matched domain (0 for homoglyphs -- they are
   *  identical once visually-confusable characters are normalised). */
  distance: number;
}

/**
 * Check if a candidate domain is likely a lookalike of any of the allowed domains.
 *
 * Returns the matched allowed domain if suspicious, or null if safe.
 */
export function checkDomain(
  currentDomain: string,
  allowedDomains: string[],
  maxLevenshtein: number = 2,
): LookalikeResult | null {
  const normalized = normalizeHomoglyphs(currentDomain);

  for (const allowed of allowedDomains) {
    if (currentDomain === allowed) {
      return null; // Exact match → safe
    }
    const normalizedAllowed = normalizeHomoglyphs(allowed);
    if (normalized === normalizedAllowed) {
      return { matched: allowed, reason: 'homoglyph', distance: 0 };
    }
    const distance = levenshtein(normalized, normalizedAllowed);
    if (distance <= maxLevenshtein) {
      return { matched: allowed, reason: 'typosquatting', distance };
    }
  }

  return null;
}

// ── Layer 2: full domain-legitimacy check for a matched brand ──

export interface DomainCheckResult {
  isSuspicious: boolean;
  /** Parsed hostname of the checked URL (lowercased). */
  hostname: string;
  /** Internal classification when suspicious. */
  flagReason?: 'domain_mismatch' | 'typosquatting';
  /** User-facing explanation. */
  reason?: string;
  /** The allowed domain the page's hostname is suspiciously close to, if any. */
  matchedAllowedDomain?: string;
  /** Edit distance to `matchedAllowedDomain` (0 for homoglyphs). */
  distance?: number;
}

/**
 * Check whether the hostname of `url` is legitimate for the given brand.
 * Runs in the background service worker — pure string operations, testable in
 * isolation (no browser APIs).
 *
 * Semantics (Layer 2 of the detection pipeline):
 * - **Exact match**, or a **subdomain** of an allowed domain → safe
 *   (e.g. `www.paypal.com`, `login.paypal.com`).
 * - **Homoglyph / typosquat** of an allowed domain (reuses `checkDomain`,
 *   Levenshtein distance ≤ 2) → suspicious (e.g. `paypa1.com`).
 * - **Anything else** → suspicious: the page is branded as the target brand
 *   but hosted on a domain the brand doesn't officially use.
 */
export function checkDomainLegitimacy(
  url: string,
  brand: Pick<BrandReference, 'allowedDomains'>,
): DomainCheckResult {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
    // Ignore trailing-dot root references (effectively the same host).
    if (hostname.endsWith('.')) hostname = hostname.slice(0, -1);
  } catch {
    hostname = '';
  }

  if (!hostname) {
    return {
      isSuspicious: true,
      hostname,
      flagReason: 'domain_mismatch',
      reason: 'The page domain could not be determined.',
    };
  }

  const allowed = brand.allowedDomains.map((d) => d.toLowerCase());

  // 1. Allowlist: exact match or subdomain of an allowed domain → safe.
  const isOfficial = allowed.some((d) => hostname === d || hostname.endsWith(`.${d}`));
  if (isOfficial) {
    return { isSuspicious: false, hostname };
  }

  // 2. Homoglyph / typosquatting lookalike of an allowed domain.
  const lookalike = checkDomain(hostname, allowed); // maxLevenshtein defaults to 2
  if (lookalike) {
    const isHomoglyph = lookalike.reason === 'homoglyph';
    return {
      isSuspicious: true,
      hostname,
      flagReason: 'typosquatting',
      matchedAllowedDomain: lookalike.matched,
      distance: lookalike.distance,
      reason: isHomoglyph
        ? `It uses visually similar characters to the official "${lookalike.matched}" domain.`
        : `It is close to the official "${lookalike.matched}" domain (within a couple of characters).`,
    };
  }

  // 3. Otherwise: branded page on an unofficial domain.
  return {
    isSuspicious: true,
    hostname,
    flagReason: 'domain_mismatch',
    reason: `Official domains: ${allowed.join(', ')}.`,
  };
}
