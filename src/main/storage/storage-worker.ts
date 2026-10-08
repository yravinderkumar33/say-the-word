import { createBirpc } from 'birpc'
import type { StorageFunctions } from '@shared/storage-protocol'
import { StorageService } from './storage-service'

// `node:sqlite` says at every start that it is experimental. Said in this process, the
// line would reach the app's log each time: it is left out, and every other warning is
// passed on. Node announces a warning on the next turn, so this is in place in time.
process.removeAllListeners('warning')
process.on('warning', (warning) => {
  if (warning.name === 'ExperimentalWarning' && /SQLite/i.test(warning.message)) return
  console.error(`${warning.name}: ${warning.message}`)
})

const parent = process.parentPort
const service = new StorageService()
createBirpc<Record<string, never>, StorageFunctions>(
  {
    request(op, args) {
      const { answer, exit } = service.handle({ op, args })
      // Asked to finish: the process ends once the answer has been sent on its way.
      if (exit) setImmediate(() => process.exit(0))
      return answer
    },
  },
  {
    post: (data) => parent.postMessage(data),
    on: (fn) => parent.on('message', ({ data }) => fn(data)),
  },
)
