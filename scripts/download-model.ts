// Downloads the default speech model (about 671 MB) into the shared models folder.
// Safe to interrupt and run again: it resumes, and verifies every file's checksum.
//
//   npm run models:download
import { DEFAULT_MODEL } from '../src/main/stt/model-catalog'
import { adoptModel, downloadModel, modelDir, totalBytes } from '../src/main/stt/model-store'
import { modelsRoot } from '../src/main/stt/models-dir'

async function main(): Promise<void> {
  const root = modelsRoot()
  const megabytes = (bytes: number): string => (bytes / 1_000_000).toFixed(0)

  // Files already on disk are checked, not fetched again: a damaged one is removed here
  // and downloaded below.
  const adoption = await adoptModel(root, DEFAULT_MODEL)
  if (adoption.ready) {
    console.log(`${DEFAULT_MODEL.label} is already downloaded: ${modelDir(root, DEFAULT_MODEL)}`)
    return
  }
  for (const name of adoption.check?.damaged ?? []) {
    console.log(`${name} did not match its checksum and will be downloaded again.`)
  }

  console.log(`Downloading ${DEFAULT_MODEL.label} (${megabytes(totalBytes(DEFAULT_MODEL))} MB)…`)
  let lastReport = 0
  await downloadModel(root, DEFAULT_MODEL, {
    onProgress: (progress) => {
      const now = Date.now()
      if (now - lastReport < 5_000 && progress.overallBytes < progress.overallTotal) return
      lastReport = now
      console.log(
        `  ${megabytes(progress.overallBytes)} / ${megabytes(progress.overallTotal)} MB  (${progress.file})`,
      )
    },
  })
  console.log(`Done. Verified and stored in ${modelDir(root, DEFAULT_MODEL)}`)
  console.log(`Licence: ${DEFAULT_MODEL.licence}`)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error)
  console.error('Run the command again to resume.')
  process.exit(1)
})
