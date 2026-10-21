import { defineConfig } from 'wxt';
import { loadEnv } from 'vite';

/**
 * Submission-site origin injected into the app as WXT_SUBMISSION_SITE. Dev
 * builds use the local site; production uses the deployed one. An empty value
 * would disable the "Send to study" button.
 */
const DEV_SUBMISSION_SITE = 'http://localhost:3000';
const PROD_SUBMISSION_SITE = 'https://phishoff-site.vercel.app';

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

/**
 * Jev (TypeSafe) runtime adjudication is optional.
 *
 * The extension calls the study site's `/api/jev` proxy, not TypeSafe
 * directly: TypeSafe rejects `chrome-extension://` origins at the CORS
 * preflight, and a proxy also keeps the API key out of a distributed bundle.
 * Set `JEV_ENDPOINT` only to override the proxy origin.
 */
const env = loadEnv(mode, process.cwd(), '');
const jevModel = process.env.TYPESAFE_MODEL ?? env.TYPESAFE_MODEL ?? 'jev-1.14.0';
const submissionSite = isProduction ? PROD_SUBMISSION_SITE : DEV_SUBMISSION_SITE;
const jevEndpoint =
  process.env.JEV_ENDPOINT ?? env.JEV_ENDPOINT ?? `${submissionSite}/api/jev`;
const jevProxyToken = process.env.JEV_PROXY_TOKEN ?? env.JEV_PROXY_TOKEN ?? '';
const jevEnabled =
  process.env.JEV_ENABLED ?? env.JEV_ENABLED ?? (jevProxyToken ? 'true' : 'false');

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
    permissions: ['storage', 'tabs', 'offscreen', 'webNavigation'],
    commands: {
      rescan: {
        suggested_key: { default: 'Ctrl+Shift+H' },
        description: 'Re-run phishing detection on the current page',
      },
    },
  },
  vite: () => ({
    define: {
      'import.meta.env.WXT_SUBMISSION_SITE': JSON.stringify(submissionSite),
      'import.meta.env.WXT_TYPESAFE_MODEL': JSON.stringify(jevModel),
      'import.meta.env.WXT_JEV_ENDPOINT': JSON.stringify(jevEndpoint),
      'import.meta.env.WXT_JEV_PROXY_TOKEN': JSON.stringify(jevProxyToken),
      'import.meta.env.WXT_JEV_ENABLED': JSON.stringify(jevEnabled),
    },
  }),
});
