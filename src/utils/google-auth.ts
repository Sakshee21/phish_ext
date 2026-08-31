/**
 * Google authentication for uploads, via `chrome.identity`.
 *
 * The extension never handles passwords: the participant's Google session is
 * used through the browser's own OAuth flow (see the `oauth2` client in
 * wxt.config.ts), and every upload carries that token for the submission site
 * to verify. Both consumers -- the study-log upload (logs viewer) and the
 * false-positive report (popup) -- go through here so the token handling,
 * including the stale-token retry, exists exactly once.
 */

/**
 * Run `attempt` with a fresh-enough Google access token.
 *
 * A cached token can predate the email scope being granted (or simply
 * expire). In that case the first call fails with a token error: drop the
 * cached token, request consent again, and retry once so the participant
 * gets a fresh consent screen instead of an error.
 */
export async function withGoogleToken<T>(attempt: (token: string) => Promise<T>): Promise<T> {
  const first = await browser.identity.getAuthToken({ interactive: true });
  if (!first.token) throw new Error('Google sign-in returned no token.');
  try {
    return await attempt(first.token);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/session|invalid|token/i.test(msg)) throw err;
    await browser.identity.removeCachedAuthToken({ token: first.token });
    const fresh = await browser.identity.getAuthToken({ interactive: true });
    if (!fresh.token) throw new Error('Google sign-in returned no token.');
    return await attempt(fresh.token);
  }
}
