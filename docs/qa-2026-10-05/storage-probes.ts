/** Independent QA reproductions. Uses only synthetic data and temporary folders. */
import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HistoryStore, dayOf } from '../../src/main/history/history-store'
import { SettingsStore } from '../../src/main/store/settings'
import { storedRows } from '../../src/renderer/hub/privacy-view'
import type { HistoryEntry, PrivacyFacts } from '../../src/shared/ipc'

const NOW = Date.UTC(2026, 9, 5, 12)
const DAY = 86_400_000
const root = mkdtempSync(join(tmpdir(), 'flow-qa-storage-'))
const results: Record<string, unknown>[] = []
const entry = (id: string, endedAt = NOW): HistoryEntry => ({
  id,
  endedAt,
  app: 'QA fixture',
  outcome: 'pasted',
  fetched: null,
  mode: 'verbatim',
  note: null,
  heard: 'Synthetic QA fixture.',
  written: 'Synthetic QA fixture.',
  failure: null,
  audioMs: 1_000,
  timings: { releaseToTextMs: 100, tidyMs: null, pasteMs: 10 },
})
const history = (dir: string) =>
  new HistoryStore({ dir, keep: 'forever', paused: false, now: () => NOW })
const writeDay = (dir: string, day: string, entries: HistoryEntry[]) => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${day}.json`), JSON.stringify({ version: 1, entries }))
}

try {
  // A normal preference save must not turn an unknown destructive default into consent.
  {
    const dir = join(root, 'fallback', 'history')
    const settingsPath = join(root, 'fallback', 'settings.json')
    history(dir).put(entry('preserved'))
    writeFileSync(settingsPath, '{broken')
    const settings = new SettingsStore(settingsPath)
    const first = new HistoryStore({
      dir,
      keep: settings.get().historyKeep,
      keepIsKnown: settings.stated('historyKeep'),
      paused: false,
    })
    assert.equal(first.leftOnDisk, 1)
    settings.update({ sounds: false })
    const nextSettings = new SettingsStore(settingsPath)
    const next = new HistoryStore({
      dir,
      keep: nextSettings.get().historyKeep,
      keepIsKnown: nextSettings.stated('historyKeep'),
      paused: false,
    })
    assert.equal(next.count, 0)
    assert.equal(existsSync(join(dir, `${dayOf(NOW)}.json`)), false)
    results.push({
      probe: 'unrelated_setting_after_corrupt_settings',
      firstLaunchPreservedFiles: 1,
      nextLaunchRemainingFiles: next.leftOnDisk,
      savedHistoryKeep: nextSettings.get().historyKeep,
      historyChoiceWasMade: false,
    })
  }

  // Migration must publish the destination before deleting its only source.
  {
    const dir = join(root, 'migration')
    const source = join(dir, '2026-10-04.json')
    writeDay(dir, '2026-10-04', [entry('migrating')])
    mkdirSync(join(dir, '2026-10-05.json', 'write-obstruction'), { recursive: true })
    const first = history(dir)
    assert.equal(first.count, 1)
    assert.equal(first.diskProblem, true)
    assert.equal(existsSync(source), false)
    const next = history(dir)
    assert.equal(next.count, 0)
    results.push({
      probe: 'migration_destination_write_failure',
      firstLaunchRows: first.count,
      writeFailureReported: first.diskProblem,
      sourceStillPresent: existsSync(source),
      nextLaunchRows: next.count,
    })
  }

  // A later successful day write must not mark an unsaved earlier day as healthy.
  {
    const dir = join(root, 'dirty-day')
    mkdirSync(dir)
    const first = history(dir)
    chmodSync(dir, 0o500)
    first.put(entry('lost-prior-day', NOW - DAY))
    assert.equal(first.diskProblem, true)
    chmodSync(dir, 0o700)
    first.put(entry('saved-today'))
    assert.equal(first.diskProblem, false)
    const next = history(dir)
    assert.equal(next.count, 1)
    assert.equal(next.get('lost-prior-day'), null)
    results.push({
      probe: 'successful_other_day_clears_unsaved_warning',
      rowsBeforeRestart: first.count,
      diskProblemBeforeRestart: first.diskProblem,
      rowsAfterRestart: next.count,
    })
  }

  // An unreadable history file still contains private bytes and must remain deletable.
  {
    const dir = join(root, 'unreadable')
    writeDay(dir, dayOf(NOW), [entry('truncated')])
    const file = join(dir, `${dayOf(NOW)}.json`)
    writeFileSync(file, readFileSync(file, 'utf8').slice(0, -1))
    const first = history(dir)
    const facts: PrivacyFacts = {
      recognizer: 'QA',
      contacted: [],
      history: {
        keep: first.keep,
        count: first.count,
        onDisk: first.onDisk,
        bytes: first.bytesOnDisk(),
        left: first.leftOnDisk,
      },
      recordings: { saving: false, count: 0, bytes: 0 },
      log: { bytes: 0 },
      counts: { bytes: 0 },
      problem: null,
    }
    const row = storedRows(facts).find((r) => r.kind === 'history')!
    assert.equal(row.canDelete, false)
    assert.ok(first.bytesOnDisk() > 0)
    chmodSync(dir, 0o500)
    const cleared = first.clear()
    chmodSync(dir, 0o700)
    assert.equal(cleared.failed, 0)
    assert.equal(first.leftOnDisk, 0)
    assert.equal(existsSync(file), true)
    results.push({
      probe: 'unreadable_history_unaccounted',
      listedRows: first.count,
      bytesStillOnDisk: first.bytesOnDisk(),
      historyDeleteEnabled: row.canDelete,
      failedDeletionsReported: cleared.failed,
      fileStillPresent: existsSync(file),
    })
  }

  console.log(JSON.stringify(results, null, 2))
} finally {
  for (const name of ['dirty-day', 'unreadable']) {
    const dir = join(root, name)
    if (existsSync(dir)) chmodSync(dir, 0o700)
  }
  rmSync(root, { recursive: true, force: true })
}
