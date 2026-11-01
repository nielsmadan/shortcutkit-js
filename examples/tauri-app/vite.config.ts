import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  envPrefix: ['VITE_', 'SHORTCUTKIT_'],
  server: { host: '127.0.0.1', port: 43173, strictPort: true },
  build: { target: 'safari16' },
});
