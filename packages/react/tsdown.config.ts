import { defineConfig } from 'tsdown';

export default defineConfig({
  platform: 'neutral',
  target: 'es2023',
  dts: { sourcemap: true },
  sourcemap: true,
  outputOptions: { sourcemapExcludeSources: true },
  deps: { neverBundle: ['react', 'react/jsx-runtime', 'react-dom', /^@shortcutkit\//] },
});
