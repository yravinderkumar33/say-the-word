import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { downloadModel, modelDir } from '../../src/main/stt/model-store.ts'

/** Isolated audit evidence. A synthetic stream stalls after delivering one byte. */
async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'flow-audit-download-'))
  const data = Buffer.from('test-model')
  const spec = {
    id: 'model',
    label: 'fixture',
    licence: 'none',
    languages: ['en'],
    files: [
      {
        name: 'fixture.bin',
        url: 'http://fixture.invalid/file',
        bytes: data.length,
        sha256: createHash('sha256').update(data).digest('hex'),
      },
    ],
  }
  let stream: ReadableStreamDefaultController<Uint8Array> | undefined
  // This replaces fetch completely: no connection or DNS request is made.
  const fetchImpl: typeof fetch = async () => {
    // The downloader has already checked for partial content. Make its next write fail.
    await mkdir(join(modelDir(root, spec), 'fixture.bin.partial'))
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          stream = controller
          controller.enqueue(new Uint8Array([1]))
        },
      }),
    )
  }
  try {
    const download = downloadModel(root, spec, { fetchImpl }).then(
      () => ({ done: true, error: null }),
      (error: NodeJS.ErrnoException) => ({ done: true, error: error.code ?? error.message }),
    )
    const early = await Promise.race([
      download,
      new Promise((resolve) => setTimeout(() => resolve({ done: false }), 200)),
    ])
    console.log(JSON.stringify({ check: 'write error while network stalled', after200ms: early }))
    // Let the synthetic response finish so the diagnostic itself never leaves a stalled stream.
    stream?.close()
    console.log(JSON.stringify({ afterNetworkResumes: await download }))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

void main()
