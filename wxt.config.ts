import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Screen Recorder',
    description: 'Local-first screen recorder with offscreen capture',
    permissions: ['offscreen', 'storage', 'downloads', 'tabs', 'tabCapture'],
  },
  webExt: {
    chromiumArgs: ['--user-data-dir=./.wxt/chrome-data'],
  },
});
