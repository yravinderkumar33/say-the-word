import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Ollama as a thing installed on this Mac: whether it is there, and how to start it.
 * It is a separate app that the user installs; this app neither includes nor installs it.
 */

const APP_PLACES = ['/Applications/Ollama.app', join(homedir(), 'Applications', 'Ollama.app')]
/** Where the command-line tool is put by Ollama's own installer, and by Homebrew. */
const TOOL_PLACES = ['/usr/local/bin/ollama', '/opt/homebrew/bin/ollama']

export interface OllamaInstall {
  /** The app's bundle, when it is installed as an app. */
  app: string | null
  /** The command-line tool, when that is installed. */
  tool: string | null
}

export function findOllama(exists: (path: string) => boolean = existsSync): OllamaInstall {
  return {
    app: APP_PLACES.find((place) => exists(place)) ?? null,
    tool: TOOL_PLACES.find((place) => exists(place)) ?? null,
  }
}

export function isInstalled(install: OllamaInstall): boolean {
  return install.app !== null || install.tool !== null
}

/**
 * Starts Ollama, in the background: the app if it is installed as one (without
 * bringing it to the front), otherwise its server from the command-line tool.
 * Returns false when there is nothing to start.
 */
export function startOllama(install: OllamaInstall = findOllama()): boolean {
  if (install.app) {
    // `-g`: not brought to the front. `-j`: started hidden.
    execFile('/usr/bin/open', ['-g', '-j', '-a', install.app], (error) => {
      if (error) console.error(`[cleanup] Ollama could not be started: ${error.message}`)
    })
    return true
  }
  if (install.tool) {
    const server = spawn(install.tool, ['serve'], { detached: true, stdio: 'ignore' })
    server.on('error', (error) => {
      console.error(`[cleanup] Ollama could not be started: ${error.message}`)
    })
    // It is the user's Ollama, not a part of this app: it runs on after the app quits.
    server.unref()
    return true
  }
  return false
}
