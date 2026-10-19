import { defineConfig } from 'vite';

export default defineConfig({
  clearScreen: false,
  server: { host: '127.0.0.1', port: 43170, strictPort: true },
  build: { target: 'safari16' },
});
