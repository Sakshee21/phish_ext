import { defineConfig } from 'wxt';

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
});
