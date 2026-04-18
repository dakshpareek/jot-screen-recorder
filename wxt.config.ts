import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Jot — Screen Recorder',
    description: 'Local-first screen recorder with offscreen capture',
    icons: {
      '16': 'logo/icon-16.png',
      '32': 'logo/icon-32.png',
      '48': 'logo/icon-48.png',
      '96': 'logo/icon-96.png',
      '128': 'logo/icon-128.png',
    },
    action: {
      default_icon: {
        '16': 'logo/icon-16.png',
        '32': 'logo/icon-32.png',
        '48': 'logo/icon-48.png',
        '128': 'logo/icon-128.png',
      },
    },
    permissions: ['offscreen', 'storage', 'downloads', 'tabCapture', 'scripting'],
    host_permissions: ['<all_urls>'],
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
  },
  webExt: {
    chromiumArgs: ['--user-data-dir=./.wxt/chrome-data'],
  },
});
