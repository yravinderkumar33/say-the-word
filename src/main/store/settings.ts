import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'

const dictionaryEntrySchema = z.object({ from: z.string(), to: z.string() })

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
})
export type Settings = z.infer<typeof settingsSchema>

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

  constructor(private readonly filePath: string) {
    this.current = this.read()
  }

  /** Where the file is copied before a damaged one is written over. */
  get asidePath(): string {
    return `${this.filePath}.before-repair`
  }

  get(): Settings {
    return this.current
  }

  update(patch: Partial<Omit<Settings, 'version'>>): Settings {
    this.current = settingsSchema.parse({ ...this.current, ...patch })
    this.write()
    return this.current
  }

  private read(): Settings {
    let text: string
    try {
      text = readFileSync(this.filePath, 'utf8')
    } catch {
      return DEFAULT_SETTINGS
    }

    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      return this.damaged('is not valid JSON, so the defaults are used', DEFAULT_SETTINGS)
    }
    const whole = settingsSchema.safeParse(raw)
    if (whole.success) return whole.data
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
      if (entry.success) kept[name] = entry.data
      else leftOut.push(name)
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

  private write(): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    if (this.keepOriginal) {
      // The file held something that was not used. It is about to be written over, so
      // what was there is kept beside it.
      this.keepOriginal = false
      try {
        copyFileSync(this.filePath, this.asidePath)
        console.error(`[settings] the file as it was has been kept as ${this.asidePath}`)
      } catch {
        // Nothing to keep, or nowhere to keep it: the settings are still saved.
      }
    }
    // Written to a temporary file first, so a crash mid-write cannot leave half a file.
    const temporary = `${this.filePath}.tmp`
    writeFileSync(temporary, `${JSON.stringify(this.current, null, 2)}\n`)
    renameSync(temporary, this.filePath)
  }
}
