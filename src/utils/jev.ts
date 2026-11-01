/**
 * Jev (TypeSafe) runtime adjudication — optional Layer 4.
 *
 * The local pipeline runs first and always produces a verdict. When Jev is
 * enabled, this module sends the page evidence and the local candidate to the
 * study site's `/api/jev` proxy, which forwards it to
 * `POST https://api.typesafe.ai/v1/systemone` with the server-side key.
 *
 * We go through the proxy because TypeSafe rejects `chrome-extension://`
 * origins at the CORS preflight, and because a proxy keeps the API key out of
 * a distributed extension bundle.
 *
 * Docs:
 * - API: https://docs.typesafe.ai/api
 * - State: https://docs.typesafe.ai/concepts/state
 * - Primitives: https://docs.typesafe.ai/primitives
 * - Confidence: https://docs.typesafe.ai/confidence
 *
 * Jev does not generate text. Everything here is a typed value, probability,
 * or confidence; the warning UI's prose stays owned by the local pipeline.
 */

import type {
  BrandReference,
  DetectionSignals,
  DOMFeatures,
  JevAssessment,
} from '@/lib/types';

const ENDPOINT = import.meta.env.WXT_JEV_ENDPOINT || '';
const PROXY_TOKEN = import.meta.env.WXT_JEV_PROXY_TOKEN || '';
const MODEL = import.meta.env.WXT_TYPESAFE_MODEL || 'jev-1.14.0';
const ENABLED = String(import.meta.env.WXT_JEV_ENABLED ?? 'false') === 'true';

const PROMPT_VERSION = 'runtime-adjudication-v1';
const TIMEOUT_MS = 3_000;
const CACHE_TTL_MS = 5 * 60_000;

/**
 * One request, several atomic judgments. Question ids are for our code only;
 * each `instructions` is the full question Jev sees.
 */
const QUESTIONS = {
  is_phishing: {
    type: 'noul',
    instructions:
      'Is the page at `page.url` a phishing page that impersonates ' +
      '`candidate.brandName`? A phishing page copies the brand to collect ' +
      'credentials or other sensitive information while being served from a ' +
      'domain the brand does not control. A legitimate login page, an article ' +
      'about the brand, or a page that merely mentions it is not phishing.',
    criteria: {
      true: 'The page is a deceptive impersonation of the brand.',
      false: 'The page is legitimate, unrelated, or merely mentions the brand.',
    },
  },
  verdict: {
    type: 'choice',
    instructions: 'What is the page at `page.url`?',
    criteria: {
      phishing:
        'A deceptive page impersonating the candidate brand, typically to collect credentials.',
      legitimate:
        'A genuine page of the candidate brand, or a benign page that is not impersonating it.',
      uncertain: 'The evidence is mixed or insufficient to decide.',
    },
  },
  impersonation: {
    type: 'score',
    instructions:
      'How strong is the evidence that the page deliberately impersonates ' +
      '`candidate.brandName`, rather than coincidentally resembling it?',
    criteria: [
      'No evidence of impersonation.',
      'Weak or coincidental resemblance.',
      'Strong evidence: copied branding, wording, or layout.',
      'Definitive: copied assets and a lookalike domain, or an explicit brand claim.',
    ],
  },
  brand_presented: {
    type: 'choice',
    instructions:
      'Which brand does the page present itself as, based on `page` and ' +
      '`candidate`? Choose `candidate_brand` when the page claims to be ' +
      '`candidate.brandName`, `different_brand` when it clearly presents a ' +
      'different brand, and `no_brand` when it presents no brand.',
    criteria: {
      candidate_brand: 'The page presents itself as the candidate brand.',
      different_brand: 'The page presents itself as a different brand.',
      no_brand: 'The page presents no recognizable brand.',
    },
  },
} as const;

interface JevAnswer {
  noul?: number;
  choice?: string;
  confidence?: number;
  score?: number;
}

interface JevResponse {
  model?: string;
  answers?: Record<string, JevAnswer>;
}

export interface JevCandidateInput {
  url: string;
  features: DOMFeatures | null;
  brand: BrandReference;
  localRiskScore: number;
  signals: DetectionSignals;
  flaggedElements: Array<{ element: string; title?: string; note?: string }>;
}

const cache = new Map<string, { at: number; value: JevAssessment }>();

export function isJevEnabled(): boolean {
  return ENABLED && Boolean(ENDPOINT);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function num(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * Build the state. Study variables (condition, participant id) are excluded:
 * Jev judges the page, not the experiment assignment.
 */
function buildState(input: JevCandidateInput): Record<string, unknown> {
  const features = input.features;
  return {
    page: {
      url: input.url,
      hostname: hostnameOf(input.url),
      title: features?.title ?? null,
      excerpt: features?.pageExcerpt ?? null,
      hasLoginForm: features?.hasLoginForm ?? null,
      hasCredentialField: features?.hasCredentialField ?? null,
      passwordFieldCount: features?.passwordFieldCount ?? null,
      dominantColors: features?.dominantColors ?? [],
      fontFamily: features?.fontFamily ?? null,
      externalAssetHosts: (features?.elements ?? [])
        .filter((element) => element.kind === 'external-asset' && element.detail)
        .map((element) => element.detail),
    },
    candidate: {
      brand: input.brand.id,
      brandName: input.brand.name,
      officialDomains: input.brand.allowedDomains,
      localRiskScore: input.localRiskScore,
      signals: input.signals,
      flaggedElements: input.flaggedElements,
    },
  };
}

async function postJev(body: unknown): Promise<JevResponse> {
  let lastError: unknown;

  // One retry only: the local verdict is already available, so waiting longer
  // is worse than falling back.
  for (let attempt = 0; attempt < 2; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(PROXY_TOKEN ? { 'x-phishoff-token': PROXY_TOKEN } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if ((res.status === 429 || res.status === 529) && attempt === 0) {
        lastError = new Error(`Jev HTTP ${res.status}`);
        await new Promise((resolve) => setTimeout(resolve, 300));
        continue;
      }

      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Jev HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ''}`);
      }

      return (await res.json()) as JevResponse;
    } catch (err) {
      lastError = err;
      if (attempt === 1) break;
      await new Promise((resolve) => setTimeout(resolve, 300));
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function compose(data: JevResponse, latencyMs: number): JevAssessment {
  const answers = data.answers ?? {};
  const verdictAnswer = answers.verdict;
  const brandAnswer = answers.brand_presented;

  const verdict =
    verdictAnswer?.choice === 'phishing'
      ? 'phishing'
      : verdictAnswer?.choice === 'legitimate'
        ? 'legitimate'
        : 'uncertain';

  const brandPresented =
    brandAnswer?.choice === 'candidate_brand'
      ? 'candidate_brand'
      : brandAnswer?.choice === 'different_brand'
        ? 'different_brand'
        : 'no_brand';

  return {
    model: data.model || MODEL,
    promptVersion: PROMPT_VERSION,
    phishingProbability: clamp01(num(answers.is_phishing?.noul, 0.5)),
    verdict,
    certainty: clamp01(num(verdictAnswer?.confidence, 0)),
    impersonationLikelihood: Math.max(0, Math.min(3, num(answers.impersonation?.score, 0))),
    brandPresented,
    latencyMs,
  };
}

function emptyAssessment(latencyMs: number, error: string): JevAssessment {
  return {
    model: MODEL,
    promptVersion: PROMPT_VERSION,
    phishingProbability: 0.5,
    verdict: 'uncertain',
    certainty: 0,
    impersonationLikelihood: 0,
    brandPresented: 'no_brand',
    latencyMs,
    error,
  };
}

/**
 * Score a candidate verdict. Returns null when Jev is disabled; otherwise
 * always returns an assessment (with `error` on failure) so the caller can log
 * the attempt and keep the local verdict.
 */
export async function scoreCandidate(input: JevCandidateInput): Promise<JevAssessment | null> {
  if (!isJevEnabled()) return null;

  const cacheKey = `${input.url}|${input.brand.id}`;
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;

  const started = Date.now();
  try {
    const data = await postJev({
      model: MODEL,
      state: buildState(input),
      questions: QUESTIONS,
    });
    const assessment = compose(data, Date.now() - started);
    cache.set(cacheKey, { at: Date.now(), value: assessment });
    return assessment;
  } catch (err) {
    return emptyAssessment(
      Date.now() - started,
      err instanceof Error ? err.message : String(err),
    );
  }
}
