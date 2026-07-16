import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const isFilePreview = process.env.FILE_PREVIEW === '1';

export default defineConfig({
  base: isFilePreview ? './' : process.env.GITHUB_ACTIONS ? '/four-kingdoms/' : '/',
  plugins: [react()],
  server: { port: 5173 },
  build: { target: 'es2022', outDir: isFilePreview ? 'dist-file' : 'dist' },
});
