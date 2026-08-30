import { defineConfig } from 'wxt';

/**
 * The Google OAuth clients used by chrome.identity.getAuthToken for the
 * "Send to study" upload. Chrome binds a "Chrome Extension" OAuth client to one
 * extension ID, so two clients exist:
 *   - DEV_OAUTH_CLIENT_ID: authorized for the *pinned* unpacked ID (see
 *     `manifest.key` below), shared by every local/pilot build.
 *   - PROD_OAUTH_CLIENT_ID: authorized for the Web Store's ID, used by
 *     `pnpm build`.
 * Both are public identifiers (not secrets); the only secret is the private
 * half of the pinned key (`dev-key.pem`, gitignored).
 */
const DEV_OAUTH_CLIENT_ID = '719116932154-2jahk0njff3h7fokf4bov757vgc6avat.apps.googleusercontent.com';
const PROD_OAUTH_CLIENT_ID = '719116932154-7gbl5u3rkqj195qpk1gck358mrb1g108.apps.googleusercontent.com';

/**
 * Submission-site origin injected into the app as WXT_SUBMISSION_SITE. Dev
 * builds use the local site; production uses the deployed one. An empty value
 * would disable the "Send to study" button.
 */
const DEV_SUBMISSION_SITE = 'http://localhost:3000';
const PROD_SUBMISSION_SITE = 'https://phishoff-site.vercel.app';

/**
 * Pins the unpacked extension ID so every local build (any folder, any machine,
 * any teammate) resolves to the same ID -- which is what the dev OAuth client
 * is authorized for. The public half is safe to commit; the private key
 * (`dev-key.pem`) is gitignored. The Web Store ignores this and assigns its own
 * ID for the published build.
 */
const PINNED_PUBLIC_KEY =
  'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAuhqGm5pKhTV7vi9yWJGD7IPNIrggde8xR7L0OAYQTe5s2yHEAh3/EKstK7l37oTj98GlpTxVEFKv2MTdjnF2oAfX8HODWrMzTH/jlhUqyzmxlOzgnhPjOyAsQOoaijoxTR0uhTKvcwozxwWuQ3fd3vmmp8yM3fFneQZEfUxB6Ld1U4YvzdRkr6IRaEEVuD+EvE0m0YShBJfOx15O42d+awmDIc4Le5/LVQAMjHWFA38Zg08DMUcvyDlFJpBbGbMik9AIbzPbJOK23ZGFBIOu3/9/wm1Uen/5Q223GPGpfwahhDGejH2bEu+ttL3wGyPrxg42WLMDrehoSS0+j8Q5WwIDAQAB';

/** The WXT mode for this invocation (from --mode, else the command's default). */
function detectMode(): string {
  const args = process.argv.slice(2);
  const flag = args.indexOf('--mode');
  const flagValue = args[flag + 1];
  if (flag !== -1 && flagValue) return flagValue;
  const inline = args.find((a) => a.startsWith('--mode='));
  if (inline) return inline.slice('--mode='.length);
  const command = args.find((a) => ['build', 'dev', 'serve', 'zip'].includes(a));
  return command === 'dev' || command === 'serve' ? 'development' : 'production';
}

const mode = detectMode();
const isProduction = mode === 'production';

export default defineConfig({
  srcDir: 'src',
  manifest: {
    name: 'PhishOff',
    // Chrome shows this on the extension card and in the store listing, and
    // truncates past ~132 characters. Without it the manifest silently falls
    // back to package.json's description.
    description:
      'Detects fake login pages impersonating real brands and highlights exactly what gave them away. Runs entirely on your device.',
    // <all_urls> is needed for tabs.captureVisibleTab on any page, and already
    // covers localhost and 127.0.0.1 -- listing those separately only makes the
    // install-time permission prompt look longer than it is.
    host_permissions: ['<all_urls>'],
    permissions: ['storage', 'tabs', 'offscreen', 'webNavigation', 'identity'],
    key: PINNED_PUBLIC_KEY,
    oauth2: {
      client_id: isProduction ? PROD_OAUTH_CLIENT_ID : DEV_OAUTH_CLIENT_ID,
      scopes: ['https://www.googleapis.com/auth/userinfo.email'],
    },
    commands: {
      rescan: {
        suggested_key: { default: 'Ctrl+Shift+H' },
        description: 'Re-run phishing detection on the current page',
      },
    },
  },
  vite: () => ({
    define: {
      'import.meta.env.WXT_SUBMISSION_SITE': JSON.stringify(
        isProduction ? PROD_SUBMISSION_SITE : DEV_SUBMISSION_SITE,
      ),
    },
  }),
});
