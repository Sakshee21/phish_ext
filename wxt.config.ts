import { defineConfig } from 'wxt';

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
      'import.meta.env.WXT_SUBMISSION_SITE': JSON.stringify(
        isProduction ? PROD_SUBMISSION_SITE : DEV_SUBMISSION_SITE,
      ),
    },
  }),
});
