/* global console, process */
/**
 * Isolated source-component state probes. No Electron launch, real microphone,
 * settings/clipboard mutation, network, or OS UI. Exact private component bodies
 * are loaded from current source; a minimal synchronous hook scheduler exercises
 * their state/effect dependencies. These are not DOM or hardware tests.
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as zod from 'zod'
import vm from 'node:vm'
import assert from 'node:assert/strict'
import ts from 'typescript'
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

function hooks() {
  const slots = []
  let cursor = 0
  let pending = []
  return {
    useState(initial) {
      const i = cursor++
      if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial
      return [
        slots[i],
        (next) => {
          slots[i] = typeof next === 'function' ? next(slots[i]) : next
        },
      ]
    },
    useEffect(effect, deps) {
      const i = cursor++
      const old = slots[i]
      if (!old || !deps || deps.some((value, at) => !Object.is(value, old.deps[at]))) {
        pending.push(() => {
          old?.cleanup?.()
          slots[i] = { deps, cleanup: effect() }
        })
      }
    },
    render(component, props) {
      cursor = 0
      pending = []
      const tree = component(props)
      const effects = pending
      pending = []
      for (const effect of effects) effect()
      return tree
    },
  }
}
const React = {
  createElement: (type, props, ...children) => ({
    type,
    props: props ?? {},
    children: children.flat(Infinity),
  }),
}
function sourceComponent(path, name, next, scope) {
  const source = readFileSync(join(root, path), 'utf8')
  const body = source.slice(
    source.indexOf(`function ${name}(`),
    source.indexOf(`function ${next}(`),
  )
  assert(body.startsWith(`function ${name}(`), 'component boundaries changed')
  const js = ts.transpileModule(body, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.None,
      jsx: ts.JsxEmit.React,
    },
  }).outputText
  const context = { React, ...scope }
  vm.runInNewContext(`${js};globalThis.component = ${name}`, context)
  return context.component
}
function find(tree, test) {
  if (!tree || typeof tree !== 'object') return null
  if (test(tree)) return tree
  for (const child of tree.children ?? []) {
    const found = find(child, test)
    if (found) return found
  }
  return null
}
function strings(tree) {
  if (typeof tree === 'string') return [tree]
  return (tree?.children ?? []).flatMap(strings)
}

{
  const h = hooks()
  const volume = sourceComponent('src/renderer/hub/Settings.tsx', 'Volume', 'PillChoice', h)
  const requested = []
  const props = { value: 0.6, onCommit: (value) => requested.push(value) }
  let tree = h.render(volume, props)
  find(tree, (item) => item.type === 'input').props.onChange({ target: { value: '80' } })
  tree = h.render(volume, props)
  find(tree, (item) => item.type === 'input').props.onPointerUp()
  // Main refuses to save, and refresh sends the unchanged authoritative value.
  tree = h.render(volume, { ...props, value: 0.6 })
  const shown = find(tree, (item) => item.type === 'input').props.value
  assert.equal(requested[0], 0.8)
  assert.equal(shown, 80)
  console.log('REPRODUCED volume failure: authoritative=60%, slider=80%, commit requests=1')
}

{
  const h = hooks()
  const starts = []
  const mic = {
    start: (id) => starts.push(id),
    stop() {},
    heard: false,
    level: 0,
    sound: false,
    problem: null,
  }
  const component = sourceComponent('src/renderer/hub/FirstRun.tsx', 'MicrophoneStep', 'CheckRow', {
    ...h,
    useMicTest: () => mic,
    StepHead() {},
    Keys() {},
    Button() {},
    PopUp() {},
    Meter() {},
    DoneLine() {},
    ProblemIcon() {},
    CheckRow() {},
    PRODUCT_NAME: 'QA App',
    CHECK_FOR_MS: 60_000,
    NOTHING_HEARD_AFTER_MS: 10_000,
    SYSTEM_DEFAULT: '',
    microphoneName: (s) => s,
    setTimeout: () => 1,
    clearTimeout() {},
  })
  const props = {
    heading: { current: null },
    keyLabel: 'Fn',
    heard: false,
    onHeard() {},
    onChanged() {},
    onSkip() {},
    status: {
      microphone: 'granted',
      microphoneInUse: 'device-A',
      microphones: [
        { deviceId: 'device-A', label: 'A' },
        { deviceId: 'device-B', label: 'B' },
      ],
    },
  }
  h.render(component, props)
  h.render(component, { ...props, heard: true })
  const tree = h.render(component, {
    ...props,
    heard: true,
    status: { ...props.status, microphoneInUse: 'device-B' },
  })
  const selected = find(
    tree,
    (item) => item.props.label === 'Microphone' && Array.isArray(item.props.options),
  )
  const success = strings(tree).includes('Heard you. The microphone works.')
  assert.deepEqual(starts, ['device-A'])
  assert.equal(selected.props.value, 'device-B')
  assert(success)
  console.log(
    'REPRODUCED microphone change: selected=device-B, tests started=1 (only device-A), success message=true',
  )
}

async function cleanupSelectionRace() {
  const handlers = new Map()
  const exportsHub = {}
  const js = ts.transpileModule(readFileSync(join(root, 'src/main/hub/wire-hub.ts'), 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText
  vm.runInNewContext(js, {
    exports: exportsHub,
    console: { log() {}, error() {} },
    require: (id) => {
      if (id === 'electron') return { Menu: {} }
      if (id === 'zod') return zod
      if (id === '@shared/ipc')
        return {
          IPC: new Proxy({}, { get: (_, key) => key }),
          HISTORY_KEEPS: ['session', 'week', 'month', 'forever'],
          STORED_KINDS: ['history', 'recordings', 'log', 'counts'],
        }
      if (id === '@shared/keycodes') return { DICTATION_KEYS: ['fn', 'ctrlOption'] }
      if (id === '../security')
        return { handleFromOwnPages: (channel, handler) => handlers.set(channel, handler) }
      if (id === '../privacy/stored' || id === './ollama-address' || id === './questions') return {}
      throw new Error(`Unexpected probe dependency ${id}`)
    },
  })
  let resolveFacts
  let selected = 'initial'
  const writes = []
  const pending = new Promise((resolve) => {
    resolveFacts = resolve
  })
  exportsHub.wireHub({
    settings: {},
    history: {},
    usage: {},
    ask() {},
    doors: {},
    dictation: { cleanupFacts: () => pending },
    changeSettings: (patch) => {
      selected = patch.cleanupModel
      writes.push(selected)
      return true
    },
    settingsChanged() {},
  })
  const choose = handlers.get('cleanupChooseModel')
  const oldRequest = choose({}, 'model-A')
  await choose({}, null)
  assert.equal(selected, null)
  resolveFacts({ models: [{ name: 'model-A' }] })
  await oldRequest
  assert.equal(selected, 'model-A')
  assert.deepEqual(writes, [null, 'model-A'])
  console.log(
    'REPRODUCED model-selection race: latest choice=null, final saved choice=model-A, writes=2',
  )
}
cleanupSelectionRace().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
