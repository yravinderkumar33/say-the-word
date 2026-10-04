import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: { '@shared': fileURLToPath(new URL('./src/shared', import.meta.url)) },
  },
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/renderer/**/*.test.ts'],
    environment: 'node',
  },
})
