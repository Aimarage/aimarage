import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: { '~~': fileURLToPath(new URL('.', import.meta.url)).replace(/\/$/, '') },
  },
  test: {
    include: ['tests/unit/**/*.test.ts'],
    env: {
      NODE_ENV: 'test',
      HOSTED: '',
      TZ: 'Europe/Vienna',
      LLM_API_KEY: '',
      LLM_BASE_URL: '',
    },
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})
