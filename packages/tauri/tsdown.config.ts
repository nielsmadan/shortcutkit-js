import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['guest-js/index.ts'],
  platform: 'neutral',
  target: 'es2023',
  dts: { sourcemap: true },
  sourcemap: true,
  outputOptions: { sourcemapExcludeSources: true },
});
