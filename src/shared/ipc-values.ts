import type { HistoryKeep, HubPage, OverlayPrefs, StoredKind } from './ipc'

/**
 * The few values (as against types) that the windows share with the main process.
 *
 * They live apart from the message schemas so that a page can use them without the
 * validation library behind those schemas being bundled into it.
 */

export const DEFAULT_OVERLAY_PREFS: OverlayPrefs = {
  sounds: true,
  volume: 0.45,
  pillAtRest: true,
  key: 'fn',
  pausedUntil: null,
}

export const HUB_PAGES: readonly HubPage[] = [
  'home',
  'history',
  'cleanup',
  'settings',
  'privacy',
  'about',
]

export const HISTORY_KEEPS: readonly HistoryKeep[] = ['session', 'week', 'month', 'forever']

export const STORED_KINDS: readonly StoredKind[] = ['history', 'recordings', 'log', 'counts']

/**
 * The most rows the History page asks for, and is given, at once. A longer history is
 * searched, not scrolled. One number for both: main refuses a larger request.
 */
export const MOST_HISTORY_ROWS = 500
