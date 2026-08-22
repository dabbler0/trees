import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

// The whole point of this build is a single, self-contained HTML file that
// can be opened directly (file://) or dropped anywhere without a server.
export default defineConfig({
  plugins: [viteSingleFile()],
  build: {
    target: 'es2020',
    assetsInlineLimit: 100_000_000,
    cssCodeSplit: false,
    outDir: 'dist',
  },
});
