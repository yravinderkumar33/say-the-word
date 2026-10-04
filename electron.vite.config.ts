import { resolve } from 'node:path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// electron-vite 5.0.0 draws the progress line for isolated preload entries with
// terminal-only calls (clearLine, cursorTo, moveCursor) and crashes when stdout is
// piped, as it is in CI and in scripts. No-ops keep non-interactive builds working.
if (!process.stdout.isTTY) {
  const stdout = process.stdout as unknown as Record<string, unknown>
  for (const method of ['clearLine', 'cursorTo', 'moveCursor']) {
    stdout[method] ??= () => true
  }
}

const alias = { '@shared': resolve(__dirname, 'src/shared') }

// electron-vite 5 predates Electron 44, so the build targets are set explicitly
// (Electron 44 embeds Node 24 and Chromium 152).
export default defineConfig({
  main: {
    resolve: { alias },
    build: { target: 'node24' },
  },
  preload: {
    resolve: { alias },
    build: {
      target: 'node24',
      rollupOptions: {
        input: {
          overlay: resolve(__dirname, 'src/preload/overlay.ts'),
          hub: resolve(__dirname, 'src/preload/hub.ts'),
        },
      },
      // One self-contained file per preload, so `sandbox: true` works.
      isolatedEntries: true,
      externalizeDeps: false,
    },
  },
  renderer: {
    resolve: { alias },
    plugins: [react(), tailwindcss()],
    build: {
      target: 'chrome152',
      rollupOptions: {
        input: {
          overlay: resolve(__dirname, 'src/renderer/overlay.html'),
          hub: resolve(__dirname, 'src/renderer/hub.html'),
        },
      },
    },
  },
})
