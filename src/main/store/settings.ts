import {
  closeSync,
  copyFileSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'

const dictionaryEntrySchema = z.object({ from: z.string(), to: z.string() })
const microphoneSchema = z.object({ deviceId: z.string().min(1), label: z.string() })

export const settingsSchema = z.object({
  version: z.literal(1),
  /** Device id of the chosen microphone, or null to follow the system default. */
  microphoneId: z.string().nullable().default(null),
  /** Evaluation mode: save each dictation's recording and text to disk. Off unless chosen. */
  evaluationRecording: z.boolean().default(false),
  /** Verbatim pastes the recognizer's text; Cleaned tidies it with rules and a local model. */
  mode: z.enum(['verbatim', 'cleaned']).default('verbatim'),
  /** The Ollama model Cleaned mode uses, or null for none (rules only). */
  cleanupModel: z.string().nullable().default('qwen3.5:4b'),
  ollamaUrl: z.string().default('http://127.0.0.1:11434'),
  /** Set only by typing in a server that is not on this machine, with the warning that goes with it. */
  allowRemoteOllama: z.boolean().default(false),
  /** "When you hear this, write that." Applied in both modes. */
  dictionary: z.array(dictionaryEntrySchema).default([]),
  /**
   * The order of preference among microphones: the first one that is connected is
   * used. Empty follows the system default. Each is kept with the name it had, so that
   * one that is not connected can still be listed.
   */
  microphoneOrder: z.array(microphoneSchema).default([]),
  /** The key that starts a dictation: `Fn`, or Control and Option together. */
  dictationKey: z.enum(['fn', 'ctrlOption']).default('fn'),
  sounds: z.boolean().default(true),
  /** How loud the cues are, from 0 to 1. */
  soundVolume: z.number().min(0).max(1).default(0.45),
  /** False: the pill is drawn only while dictating, or when it has something to say. */
  pillAtRest: z.boolean().default(true),
  showInDock: z.boolean().default(false),
  /** How long the speech model stays in memory after the last dictation. */
  modelKeep: z.enum(['tenMinutes', 'hour', 'always']).default('tenMinutes'),
  /**
   * How long dictations are kept. `session`: in memory only. Anything else writes what
   * was said to disk, and is only ever set after a system dialog has asked.
   */
  historyKeep: z.enum(['session', 'week', 'month', 'forever']).default('session'),
  /** While true, new dictations are not added to the history. */
  historyPaused: z.boolean().default(false),
  /**
   * Whether the steps of the first launch are still to be gone through (`pending`), or
   * are being shown once more at the user's asking (`again`). Absent in a file written
   * before there were any: such an install is taken to be set up.
   */
  firstRun: z.enum(['pending', 'again', 'done']).optional(),
})
export type Settings = z.infer<typeof settingsSchema>
export type SettingsPatch = Partial<Omit<Settings, 'version'>>

export const DEFAULT_SETTINGS: Settings = settingsSchema.parse({ version: 1 })

/**
 * The user's settings, kept as one small JSON file that can be read and edited by hand.
 * A missing or unreadable file means defaults; it is never a reason to fail.
 *
 * A file edited by hand can have one thing wrong with it. That costs the entry that is
 * wrong, not the whole file: the rest is kept, the log says which entries were left
 * out, and the file as it was is copied aside before anything is written over it.
 */
export class SettingsStore {
  private current: Settings
  /** True when the file on disk held something that was not used, and has not been copied aside yet. */
  private keepOriginal = false
  /** True when there was a settings file to read when the app started: this is not a first launch. */
  private found = false
  /** The entries the file itself holds a usable value for. The others are defaults. */
  private readonly statedInFile = new Set<string>()

  constructor(private readonly filePath: string) {
    this.current = this.read()
  }

  /** False on the very first launch, before anything has been saved. */
  get existedAtLaunch(): boolean {
    return this.found
  }

  /** Where the file is copied before a damaged one is written over. */
  get asidePath(): string {
    return `${this.filePath}.before-repair`
  }

  get(): Settings {
    return this.current
  }

  /**
   * True when the settings file itself says what this entry is. False when the value in
   * force is only the default: there is no file, the file could not be used, the entry in
   * it could not, or a build that does not know the entry wrote the file without it.
   *
   * It matters where acting on a default would destroy something: "keep the history only
   * until I quit" deletes what is on disk, and must be a choice someone made.
   */
  stated(name: keyof Settings): boolean {
    return this.statedInFile.has(name)
  }

  /**
   * Changes settings and saves them. A change takes effect only once it is on disk: if
   * the file cannot be written this throws, and the settings in force stay as they
   * were. What the app does, what its menu shows and what the file says then still
   * agree, and the change can be tried again.
   */
  update(patch: SettingsPatch): Settings {
    const next = settingsSchema.parse({ ...this.current, ...patch })
    const persisted: Omit<Settings, 'historyKeep'> & { historyKeep?: Settings['historyKeep'] } = {
      ...next,
    }
    if (!this.stated('historyKeep') && patch.historyKeep === undefined) delete persisted.historyKeep
    this.write(persisted)
    this.current = next
    this.statedInFile.clear()
    for (const name of Object.keys(persisted)) this.statedInFile.add(name)
    return next
  }

  private read(): Settings {
    let text: string
    try {
      text = readFileSync(this.filePath, 'utf8')
    } catch {
      return DEFAULT_SETTINGS
    }
    this.found = true

    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      return this.damaged('is not valid JSON, so the defaults are used', DEFAULT_SETTINGS)
    }
    const whole = settingsSchema.safeParse(raw)
    if (whole.success) {
      for (const name of Object.keys(settingsSchema.shape)) {
        if (name in (raw as Record<string, unknown>)) this.statedInFile.add(name)
      }
      return whole.data
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return this.damaged('does not hold settings, so the defaults are used', DEFAULT_SETTINGS)
    }

    const source = raw as Record<string, unknown>
    if (source['version'] !== 1) {
      // Written by another version of the app: its entries may not mean the same thing.
      return this.damaged('is from another version of the app, so the defaults are used', {
        ...DEFAULT_SETTINGS,
      })
    }

    // Entry by entry: what can be used is kept.
    const kept: Record<string, unknown> = { version: 1 }
    const leftOut: string[] = []
    for (const [name, schema] of Object.entries(settingsSchema.shape)) {
      if (name === 'version' || !(name in source)) continue
      let value = source[name]
      if (name === 'dictionary' && Array.isArray(value)) {
        const usable = value.filter((entry) => dictionaryEntrySchema.safeParse(entry).success)
        if (usable.length < value.length) leftOut.push('part of dictionary')
        value = usable
      }
      const entry = schema.safeParse(value)
      if (entry.success) {
        kept[name] = entry.data
        this.statedInFile.add(name)
      } else leftOut.push(name)
    }
    // Names only: the values may be personal (dictionary words, a server address).
    return this.damaged(
      `has entries that could not be used (${leftOut.join(', ')}); the rest was kept`,
      settingsSchema.parse(kept),
    )
  }

  private damaged(what: string, settings: Settings): Settings {
    console.error(`[settings] the settings file ${what}`)
    this.keepOriginal = true
    return settings
  }

  private write(
    settings: Omit<Settings, 'historyKeep'> & { historyKeep?: Settings['historyKeep'] },
  ): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    if (this.keepOriginal) {
      // The file held something that was not used. It is about to be written over, so
      // what was there is kept beside it.
      try {
        copyFileSync(this.filePath, this.asidePath)
        console.error(`[settings] the file as it was has been kept as ${this.asidePath}`)
      } catch {
        // Nothing to keep, or nowhere to keep it: the settings are still saved.
      }
    }
    // Written to a temporary file first, and onto the disk itself before it takes the
    // file's place: a crash cannot leave half a file, nor an empty one.
    const temporary = `${this.filePath}.tmp`
    const file = openSync(temporary, 'w')
    try {
      writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`)
      fsyncSync(file)
    } finally {
      closeSync(file)
    }
    renameSync(temporary, this.filePath)
    // Only now is what was there written over: until then, the next write copies it aside.
    this.keepOriginal = false
  }
}
