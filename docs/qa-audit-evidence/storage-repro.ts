import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SettingsStore } from '../../src/main/store/settings.ts'
import { downloadModel, isModelReady, modelDir } from '../../src/main/stt/model-store.ts'

/** Isolated audit evidence. Every file is synthetic and lives in a fresh temporary folder. */
async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'flow-audit-storage-'))
  try {
    const path = join(dir, 'settings.json')
    const store = new SettingsStore(path)
    store.update({ mode: 'verbatim' })
    // Force a filesystem write failure without changing permissions or filling a disk.
    await mkdir(`${path}.tmp`)
    let failure = ''
    try {
      store.update({ mode: 'cleaned' })
    } catch (error) {
      failure = (error as NodeJS.ErrnoException).code ?? 'unknown'
    }
    console.log(
      JSON.stringify({
        check: 'failed settings write',
        failure,
        memory: store.get().mode,
        persisted: (JSON.parse(await readFile(path, 'utf8')) as { mode: string }).mode,
      }),
    )

    const data = Buffer.from('original model fixture')
    const sha256 = createHash('sha256').update(data).digest('hex')
    const spec = {
      id: 'fixture',
      label: 'fixture',
      licence: 'none',
      languages: ['en'],
      files: [
        {
          name: 'model.bin',
          url: 'http://fixture.invalid/model.bin',
          bytes: data.length,
          sha256,
        },
      ],
    }
    let fetchCalls = 0
    // This replaces fetch completely: no connection or DNS request is made.
    const fetchImpl: typeof fetch = async () => {
      fetchCalls++
      return new Response(data)
    }
    await downloadModel(dir, spec, { fetchImpl })
    const modelPath = join(modelDir(dir, spec), 'model.bin')
    await writeFile(modelPath, Buffer.alloc(data.length, 0))
    const ready = await isModelReady(dir, spec)
    fetchCalls = 0
    await downloadModel(dir, spec, { fetchImpl })
    console.log(
      JSON.stringify({
        check: 'same-sized model corruption',
        ready,
        repairFetchCalls: fetchCalls,
        actualChecksumMatches:
          createHash('sha256')
            .update(await readFile(modelPath))
            .digest('hex') === sha256,
      }),
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

void main()
