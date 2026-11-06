import { fileURLToPath, URL } from 'node:url'

import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      buffer: fileURLToPath(new URL('./node_modules/buffer/index.js', import.meta.url)),
      string_decoder: fileURLToPath(new URL('./node_modules/string_decoder/lib/string_decoder.js', import.meta.url)),
    },
  },
  worker: {
    format: 'es',
  },
  build: {
    target: 'es2022',
  },
})
