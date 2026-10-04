// A stand-in for the Swift helper, for testing the bridge without any OS access.
// It speaks the same JSON-lines protocol and can be told to misbehave.
import { createInterface } from 'node:readline'

const protocol = Number(process.env.FAKE_HELPER_PROTOCOL ?? 2)
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`)

// Stray output that is not part of the protocol must be ignored by the bridge.
process.stdout.write('not json at all\n')
process.stdout.write('{"unrelated":"object"}\n')
send({ type: 'ready', protocol, accessibilityTrusted: true, tapInstalled: true })

const lines = createInterface({ input: process.stdin })
lines.on('line', (line) => {
  const request = JSON.parse(line)
  switch (request.type) {
    case 'ping':
      return send({ id: request.id, ok: true, result: { pong: true } })
    case 'configure':
      // Echo the table back as an event, so a test can see what arrived.
      send({ id: request.id, ok: true, result: { bindings: request.bindings.length } })
      return send({
        type: 'tapState',
        installed: true,
        reason: `configured:${request.bindings.length}`,
      })
    case 'armEscape':
      return send({ id: request.id, ok: true, result: {} })
    case 'captureTarget':
      return send({
        id: request.id,
        ok: true,
        result: { targetId: 7, secure: false, hasElement: true, bundleId: 'com.example.app' },
      })
    case 'paste':
      send({
        id: request.id,
        ok: true,
        result:
          request.text === 'refuse'
            ? { outcome: 'targetChanged', detail: 'window' }
            : { outcome: 'pasted' },
      })
      return send({ type: 'pasteSettled', pasteId: request.pasteId, restored: true })
    case 'checkPermissions':
      // Used by tests as "do something bad": the mode is chosen by environment variable.
      if (process.env.FAKE_HELPER_MODE === 'crash') process.exit(3)
      if (process.env.FAKE_HELPER_MODE === 'silent') return undefined
      if (process.env.FAKE_HELPER_MODE === 'malformed') {
        return send({ id: request.id, ok: true, result: { accessibilityTrusted: 'yes' } })
      }
      return send({
        id: request.id,
        ok: true,
        result: {
          accessibilityTrusted: true,
          postEventAccess: true,
          tapInstalled: true,
          secureInput: false,
        },
      })
    case 'emit':
      send({ id: request.id, ok: true, result: {} })
      return send(request.event)
    default:
      return send({ id: request.id, ok: false, error: `unknown request type: ${request.type}` })
  }
})
lines.on('close', () => {
  // A stuck helper: it does not notice that its input has closed.
  if (process.env.FAKE_HELPER_MODE === 'stubborn') return setInterval(() => {}, 1_000)
  return process.exit(0)
})
