import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { LEGACY_DATA_NAME } from '@shared/product'

/**
 * Where evaluation recordings go. Like the speech models, the folder is shared by
 * every build of the app and sits outside the repository, so a recording of someone's
 * voice cannot be committed by accident. `WHISPER_FLOW_EVAL_DIR` overrides it.
 */
export function evaluationDir(): string {
  const override = process.env['WHISPER_FLOW_EVAL_DIR']
  if (override) return override
  return join(homedir(), 'Library', 'Application Support', LEGACY_DATA_NAME, 'evaluation')
}

const KEPT_NAMES = 64

/**
 * Evaluation mode: saves each dictation so the recognizer (and later the cleanup) can
 * be judged on the user's own voice. It is off unless the user switches it on, and it
 * is the one place where the app writes what was said to disk.
 *
 * For a dictation named `20261003-214512-7` three files are written:
 *
 *   …-7.wav        the recording, written by the speech worker
 *   …-7.txt        what the recognizer heard, for the user to correct into what they meant
 *   …-7.heard.txt  the same text again, never edited, so the two can be compared later
 */
export class EvaluationRecorder {
  private readonly names = new Map<number, string>()

  constructor(
    readonly dir: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** The WAV file a session's recording should be written to. The same for every call. */
  audioPath(session: number): string {
    return join(this.dir, `${this.nameOf(session)}.wav`)
  }

  /** Saves what the recognizer heard for this session, beside its recording. */
  saveText(session: number, text: string): void {
    const name = this.nameOf(session)
    mkdirSync(this.dir, { recursive: true, mode: 0o700 })
    writeFileSync(join(this.dir, `${name}.txt`), `${text}\n`, { mode: 0o600 })
    writeFileSync(join(this.dir, `${name}.heard.txt`), `${text}\n`, { mode: 0o600 })
  }

  paths(session: number): string[] {
    const name = this.nameOf(session)
    return ['.wav', '.txt', '.heard.txt'].map((extension) => join(this.dir, name + extension))
  }

  private nameOf(session: number): string {
    let name = this.names.get(session)
    if (!name) {
      name = `${stamp(this.now())}-${session}`
      this.names.set(session, name)
      while (this.names.size > KEPT_NAMES) {
        const oldest = this.names.keys().next().value
        if (oldest === undefined) break
        this.names.delete(oldest)
      }
    }
    return name
  }
}

/** Local date and time as `YYYYMMDD-HHMMSS`, so the files sort in the order they were made. */
function stamp(date: Date): string {
  const two = (value: number): string => String(value).padStart(2, '0')
  return (
    `${date.getFullYear()}${two(date.getMonth() + 1)}${two(date.getDate())}-` +
    `${two(date.getHours())}${two(date.getMinutes())}${two(date.getSeconds())}`
  )
}
