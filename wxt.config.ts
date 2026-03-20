import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Screen Recorder',
    description: 'Local-first screen recorder with offscreen capture',
    permissions: ['offscreen', 'storage', 'downloads', 'tabs', 'tabCapture', 'scripting'],
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
  },
  webExt: {
    chromiumArgs: ['--user-data-dir=./.wxt/chrome-data'],
  },
});
