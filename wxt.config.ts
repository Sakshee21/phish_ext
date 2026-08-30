import { defineConfig } from 'wxt';

/**
 * The Google OAuth client used by chrome.identity.getAuthToken for the
 * "Send to study" upload. Create it in Google Cloud Console (Credentials ->
 * Create OAuth client ID -> application type "Chrome Extension") and paste the
 * client ID here. Use the extension's ID: for an unpacked dev build that's the
 * ID shown in chrome://extensions; switch to the store ID for production.
 */
const GOOGLE_OAUTH_CLIENT_ID = '719116932154-2jahk0njff3h7fokf4bov757vgc6avat.apps.googleusercontent.com';

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
    oauth2: {
      client_id: GOOGLE_OAUTH_CLIENT_ID,
      scopes: ['https://www.googleapis.com/auth/userinfo.email'],
    },
    commands: {
      rescan: {
        suggested_key: { default: 'Ctrl+Shift+H' },
        description: 'Re-run phishing detection on the current page',
      },
    },
  },
});
