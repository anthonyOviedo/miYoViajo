import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [],
  publicDir: 'public',
  build: {
    outDir: process.env.BUILD_OUTDIR || 'dist',
  },
});
