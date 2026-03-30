import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [],
  build: {
    outDir: process.env.BUILD_OUTDIR || 'dist',
  },
});
