/* eslint-disable @typescript-eslint/no-explicit-any -- React element/hook adapter intentionally accepts arbitrary component state. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as ReactRuntime from 'react'
import type { ReactElement } from 'react'
import type { AppStatus, CleanupFacts } from '@shared/ipc'

// A hook scheduler exercises actual component event handlers without a browser or microphone.
const hooks = vi.hoisted(() => {
  const slots: any[] = []
  let cursor = 0
  let effects: Array<() => void> = []
  return {
    useState(initial: any) {
      const i = cursor++
      if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial
      return [
        slots[i],
        (value: any) => {
          slots[i] = typeof value === 'function' ? value(slots[i]) : value
        },
      ]
    },
    useRef(initial: any) {
      const i = cursor++
      return (slots[i] ??= { current: initial })
    },
    useEffect(effect: () => any, deps?: any[]) {
      const i = cursor++
      const old = slots[i]
      // Without a list of what it depends on, an effect runs after every drawing.
      if (!old || !deps || deps.some((value, at) => !Object.is(value, old.deps[at])))
        effects.push(() => {
          old?.cleanup?.()
          slots[i] = { deps, cleanup: effect() }
        })
    },
    useCallback(fn: any) {
      cursor++
      return fn
    },
    useMemo(make: () => any, deps: any[]) {
      const i = cursor++
      const old = slots[i]
      if (!old || deps.some((value, at) => !Object.is(value, old.deps[at])))
        slots[i] = { deps, value: make() }
      return slots[i].value
    },
    render(component: any, props: any) {
      cursor = 0
      effects = []
      const tree = component(props)
      for (const effect of effects) effect()
      return tree
    },
    reset() {
      for (const item of slots) item?.cleanup?.()
      slots.length = 0
      effects = []
      cursor = 0
    },
  }
})
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof ReactRuntime>()),
  ...hooks,
}))
import { Settings, Volume } from '../../src/renderer/hub/Settings'
import { Cleanup, TryIt } from '../../src/renderer/hub/Cleanup'
import { FirstRun } from '../../src/renderer/hub/FirstRun'
import { HistoryDetail } from '../../src/renderer/hub/HistoryDetail'
import { History } from '../../src/renderer/hub/History'
import { Privacy } from '../../src/renderer/hub/Privacy'
import { Home } from '../../src/renderer/hub/Home'
import { App } from '../../src/renderer/hub/App'
import { AppTile, Field, ProgressBar } from '../../src/renderer/hub/components'
import { RULES_ONLY_LABEL } from '../../src/renderer/hub/cleanup-view'
import { useFacts } from '../../src/renderer/hub/use-facts'
import { entry, status } from './status-fixture'

function find(tree: any, test: (item: any) => boolean): any {
  if (!tree || typeof tree !== 'object') return null
  if (test(tree)) return tree
  for (const child of [tree.props?.children].flat(Infinity)) {
    const result = find(child, test)
    if (result) return result
  }
  return null
}
const input = (tree: ReactElement) => find(tree, (item) => item.type === 'input')
/** Every element in a tree, also those handed to a part as a prop (a notice's actions, say). */
function findAll(tree: any, test: (item: any) => boolean): any[] {
  const found: any[] = []
  const walk = (item: any): void => {
    if (Array.isArray(item)) return item.forEach(walk)
    if (typeof item !== 'object' || item === null || !('$$typeof' in item)) return
    if (test(item)) found.push(item)
    for (const value of Object.values(item.props ?? {})) walk(value)
  }
  walk(tree)
  return found
}
const named = (name: string) => (item: any) =>
  item.type?.name === name || item.type?.type?.name === name
const textOf = (item: any): string =>
  [item?.props?.children]
    .flat(Infinity)
    .filter((part) => typeof part === 'string' || typeof part === 'number')
    .join('')
/** A button of a part, found by what it says. */
const button = (tree: any, words: string) =>
  findAll(
    tree,
    (item) => (named('Button')(item) || item.type === 'button') && textOf(item) === words,
  )[0]
/** What a screen reader is told as it changes, and the eye is not shown. */
const spokenLine = (tree: any) =>
  findAll(
    tree,
    (item) => item.props?.['aria-live'] === 'polite' && item.props?.className === 'only-spoken',
  )
const tick = async () => {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}
afterEach(() => {
  hooks.reset()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
describe('Volume acknowledgements (QA-13)', () => {
  it('reconciles repeated failures even when the authoritative prop never changes', async () => {
    const props = { value: 0.6, onCommit: vi.fn(async () => ({ ok: false, appliedVolume: 0.6 })) }
    for (const asked of [80, 90]) {
      let tree = hooks.render(Volume, props)
      input(tree).props.onChange({ target: { value: String(asked) } })
      tree = hooks.render(Volume, props)
      input(tree).props.onPointerUp()
      await tick()
      tree = hooks.render(Volume, props)
      expect(input(tree).props.value).toBe(60)
    }
    expect(props.onCommit).toHaveBeenCalledTimes(2)
  })
  it('does not let an older acknowledgement overwrite a newer edit, including a return to the original value', async () => {
    const replies: Array<(value: any) => void> = []
    const props = {
      value: 0.6,
      onCommit: vi.fn(() => new Promise<any>((resolve) => replies.push(resolve))),
    }
    let tree = hooks.render(Volume, props)
    input(tree).props.onChange({ target: { value: '80' } })
    tree = hooks.render(Volume, props)
    input(tree).props.onPointerUp()
    tree = hooks.render(Volume, props)
    input(tree).props.onChange({ target: { value: '60' } })
    tree = hooks.render(Volume, props)
    input(tree).props.onPointerUp()
    expect(replies.length).toBe(2)
    replies[1]!({ ok: true, appliedVolume: 0.6 })
    await tick()
    replies[0]!({ ok: true, appliedVolume: 0.8 })
    await tick()
    expect(input(hooks.render(Volume, props)).props.value).toBe(60)
  })
})
describe('comparison identity (QA-12)', () => {
  it('reruns unchanged input on config change, ignores stale results, and does not restart on identical polling', async () => {
    vi.useFakeTimers()
    const replies: Array<(value: any) => void> = []
    const ask = vi.fn(() => new Promise((resolve) => replies.push(resolve)))
    vi.stubGlobal('window', { flowHub: { tryCleanup: ask } })
    const facts = {
      identity: 'a',
      host: 'localhost',
      chosen: 'a',
      ollama: 'running',
      refusal: null,
    } as CleanupFacts
    let tree = hooks.render(TryIt, { facts })
    input(tree).props.onChange({ target: { value: 'synthetic sentence' } })
    hooks.render(TryIt, { facts })
    await vi.advanceTimersByTimeAsync(600)
    hooks.render(TryIt, { facts: { ...facts, identity: 'b', chosen: 'b' } })
    await vi.advanceTimersByTimeAsync(600)
    expect(ask).toHaveBeenCalledTimes(2)
    replies[0]!({
      identity: 'a',
      verbatim: { text: 'QA_STALE_SENTINEL', ms: 0 },
      rules: { text: 'QA_STALE_SENTINEL', ms: 0 },
      cleaned: null,
    })
    await tick()
    tree = hooks.render(TryIt, { facts: { ...facts, identity: 'b', chosen: 'b' } })
    expect(JSON.stringify(tree).includes('QA_STALE_SENTINEL')).toBe(false)
    hooks.render(TryIt, { facts: { ...facts, identity: 'b', chosen: 'b' } })
    await vi.advanceTimersByTimeAsync(600)
    expect(ask).toHaveBeenCalledTimes(2)
  })
})
describe('Try it while what Ollama says comes and goes', () => {
  const facts = {
    identity: 'a',
    host: 'localhost',
    chosen: 'a',
    ollama: 'running',
    refusal: null,
  } as CleanupFacts
  const answer = (identity: string, text: string) => ({
    identity,
    verbatim: { text, ms: 0 },
    rules: { text, ms: 0 },
    cleaned: null,
  })

  it('a moment of "not running" does not cut a comparison off half-way', async () => {
    vi.useFakeTimers()
    const replies: Array<(value: any) => void> = []
    const ask = vi.fn(() => new Promise((resolve) => replies.push(resolve)))
    vi.stubGlobal('window', { flowHub: { tryCleanup: ask } })
    const tree = hooks.render(TryIt, { facts })
    input(tree).props.onChange({ target: { value: 'synthetic sentence' } })
    hooks.render(TryIt, { facts })
    await vi.advanceTimersByTimeAsync(600)
    // While the model writes, the status says for a moment that Ollama is not there.
    hooks.render(TryIt, { facts: { ...facts, identity: 'gone', ollama: 'notRunning' } })
    hooks.render(TryIt, { facts })
    await vi.advanceTimersByTimeAsync(600)
    expect(ask).toHaveBeenCalledTimes(1)

    replies[0]!(answer('a', 'FIRST_ANSWER'))
    await tick()
    expect(JSON.stringify(hooks.render(TryIt, { facts }))).toContain('FIRST_ANSWER')
  })

  it('an answer about facts that changed meanwhile is not left hanging: it is asked for again', async () => {
    vi.useFakeTimers()
    const replies: Array<(value: any) => void> = []
    const ask = vi.fn(() => new Promise((resolve) => replies.push(resolve)))
    vi.stubGlobal('window', { flowHub: { tryCleanup: ask } })
    const tree = hooks.render(TryIt, { facts })
    input(tree).props.onChange({ target: { value: 'synthetic sentence' } })
    hooks.render(TryIt, { facts })
    await vi.advanceTimersByTimeAsync(600)
    // The digest changed while the comparison ran: its answer is about the old one.
    replies[0]!(answer('a', 'OLD_DIGEST'))
    await tick()
    const later = { ...facts, identity: 'a2' }
    hooks.render(TryIt, { facts: later })
    hooks.render(TryIt, { facts: later })
    await vi.advanceTimersByTimeAsync(600)
    expect(ask).toHaveBeenCalledTimes(2)
    replies[1]!(answer('a2', 'NEW_DIGEST'))
    await tick()
    const shown = JSON.stringify(hooks.render(TryIt, { facts: later }))
    expect(shown).toContain('NEW_DIGEST')
    expect(shown).not.toContain('OLD_DIGEST')
    // Settled: nothing more is asked while the facts stand.
    hooks.render(TryIt, { facts: later })
    await vi.advanceTimersByTimeAsync(600)
    expect(ask).toHaveBeenCalledTimes(2)
  })
})

describe('onboarding microphone authorization (QA-11)', () => {
  it('ties "Heard you" to the microphone in use, and to nothing else that comes and goes', async () => {
    vi.useFakeTimers()
    const listeners = new Map<string, (event?: unknown) => void>()
    let devices = [
      { kind: 'audioinput', deviceId: 'default', groupId: 'built-in' },
      { kind: 'audioinput', deviceId: 'A', groupId: 'a' },
      { kind: 'audioinput', deviceId: 'B', groupId: 'b' },
      { kind: 'audiooutput', deviceId: 'speaker', groupId: 's' },
    ]
    vi.stubGlobal('window', {
      addEventListener: (name: string, fn: any) => listeners.set(name, fn),
      removeEventListener: () => {},
    })
    vi.stubGlobal('navigator', {
      mediaDevices: {
        addEventListener: (name: string, fn: any) => listeners.set(name, fn),
        removeEventListener: () => {},
        enumerateDevices: async () => devices,
      },
    })
    const devicesChange = async (next: typeof devices) => {
      devices = next
      listeners.get('devicechange')!()
      await tick()
    }
    const props = {
      status: { ...status(), microphone: 'granted' as const, microphoneInUse: 'A' },
      onChanged: () => {},
    }
    hooks.render(FirstRun, props)
    await tick()
    listeners.get('flow-test-step')!({ detail: 'microphone' } as any)
    let tree: ReactElement = hooks.render(FirstRun, props)
    const step = () => find(tree, (item) => item.type?.name === 'MicrophoneStep')
    step().props.onHeard()
    tree = hooks.render(FirstRun, props)
    expect(step().props.heard).toBe(true)
    const heardOfA = step().props.onHeard

    // A speaker comes and goes, and so does a microphone nobody chose: A was still heard.
    await devicesChange([
      ...devices,
      { kind: 'audiooutput', deviceId: 'headphones', groupId: 'h' },
      { kind: 'audioinput', deviceId: 'C', groupId: 'c' },
    ])
    tree = hooks.render(FirstRun, props)
    expect(step().props.heard).toBe(true)

    // Another microphone chosen: B has not been heard, and a late word about A is not B's.
    const onB = { ...props, status: { ...props.status, microphoneInUse: 'B' } }
    tree = hooks.render(FirstRun, onB)
    expect(step().props.heard).toBe(false)
    // The step is not put together again for it: the keyboard stays on the pop-up it was on.
    expect(step().key).toBe(null)
    heardOfA()
    tree = hooks.render(FirstRun, onB)
    expect(step().props.heard).toBe(false)

    // A is unplugged: what was heard of it no longer counts when it is chosen again.
    await devicesChange(devices.filter((device) => device.deviceId !== 'A'))
    tree = hooks.render(FirstRun, props)
    expect(step().props.heard).toBe(false)

    // Following the system default: another default is another microphone.
    const following = { ...props, status: { ...props.status, microphoneInUse: null } }
    tree = hooks.render(FirstRun, following)
    step().props.onHeard()
    tree = hooks.render(FirstRun, following)
    expect(step().props.heard).toBe(true)
    await devicesChange(
      devices.map((device) =>
        device.deviceId === 'default' ? { ...device, groupId: 'b' } : device,
      ),
    )
    tree = hooks.render(FirstRun, following)
    expect(step().props.heard).toBe(false)

    // The permission withdrawn: nothing is heard.
    step().props.onHeard()
    tree = hooks.render(FirstRun, {
      ...following,
      status: { ...following.status, microphone: 'denied' as const },
    })
    expect(step().props.heard).toBe(false)
  })
})

/** The first run, on one of its steps, with the main process answering as given. */
async function firstRunAt(
  step: string,
  props: { status: AppStatus; onChanged: () => void },
  flowHub: Record<string, unknown> = {},
) {
  const listeners = new Map<string, (event?: unknown) => void>()
  vi.stubGlobal('window', {
    addEventListener: (name: string, fn: any) => listeners.set(name, fn),
    removeEventListener: () => {},
    flowHub,
  })
  vi.stubGlobal('navigator', {
    mediaDevices: {
      addEventListener: () => {},
      removeEventListener: () => {},
      enumerateDevices: async () => [],
    },
  })
  hooks.render(FirstRun, props)
  await tick()
  listeners.get('flow-test-step')!({ detail: step })
  return hooks.render(FirstRun, props)
}

/** One part of a page, drawn on its own, once its first answers are in. */
async function drawn(part: any) {
  hooks.reset()
  hooks.render(part.type, part.props)
  await tick()
  return hooks.render(part.type, part.props)
}

const cleanupFacts = (change: Partial<CleanupFacts> = {}): CleanupFacts => ({
  ollama: 'notInstalled',
  host: '127.0.0.1',
  local: true,
  models: [],
  chosen: 'qwen3.5:4b',
  refusal: null,
  alternative: null,
  typicalMs: null,
  ...change,
})

describe('the Cleaned step of the setup guide (hub-1)', () => {
  const answering = (facts: CleanupFacts) => ({
    getCleanupFacts: vi.fn(async () => facts),
    chooseCleanupModel: vi.fn(async () => ({ status: 'applied', chosen: null })),
    setMode: vi.fn(async () => {}),
  })
  const skipOf = (page: any) =>
    findAll(page, (item) => named('FootButton')(item) && textOf(item).startsWith('Skip'))[0]

  it('shown again, is skipped without changing the mode, and says which mode is kept', async () => {
    const hub = answering(cleanupFacts())
    const props = { status: status({ firstRun: 'again', mode: 'cleaned' }), onChanged: vi.fn() }
    const skip = skipOf(await firstRunAt('cleaned', props, hub))

    expect(textOf(skip)).toBe('Skip and keep Cleaned')
    skip.props.onClick()
    await tick()
    expect(hub.setMode).not.toHaveBeenCalled()
  })

  it('on a first run, is skipped by keeping Verbatim', async () => {
    const hub = answering(cleanupFacts())
    const props = { status: status({ firstRun: 'first' }), onChanged: vi.fn() }
    const skip = skipOf(await firstRunAt('cleaned', props, hub))

    expect(textOf(skip)).toBe('Skip and keep Verbatim')
    skip.props.onClick()
    await tick()
    expect(hub.setMode).toHaveBeenCalledWith('verbatim')
  })

  it('with Ollama not there, "Use Cleaned" sets the mode and leaves the model as it was', async () => {
    const hub = answering(cleanupFacts())
    const props = { status: status({ firstRun: 'first' }), onChanged: vi.fn() }
    button(await firstRunAt('cleaned', props, hub), 'Use Cleaned').props.onClick()
    await tick()
    await tick()

    expect(hub.chooseCleanupModel).not.toHaveBeenCalled()
    expect(hub.setMode).toHaveBeenCalledWith('cleaned')
  })

  it('shows the model the setting names as chosen while Ollama is not there to list it', async () => {
    const props = { status: status({ firstRun: 'again' }), onChanged: vi.fn() }
    const page = await firstRunAt('cleaned', props, answering(cleanupFacts()))
    const step = await drawn(findAll(page, named('CleanedStep'))[0])
    const choices = findAll(step, named('ModelChoice'))

    expect(choices.map((choice) => [choice.props.name, choice.props.chosen])).toEqual([
      ['qwen3.5:4b', true],
      [RULES_ONLY_LABEL, false],
    ])
    // One stop for Tab in the group: the option chosen (hub-14).
    expect(choices.map((choice) => choice.type(choice.props).props.tabIndex)).toEqual([0, -1])
  })
})

describe('Ollama, as the first run and the Cleanup page show it (hub-5)', () => {
  it('is said in the words of the Cleanup page, and a server elsewhere is not "this Mac"', async () => {
    const elsewhere = cleanupFacts({
      ollama: 'running',
      host: '192.168.1.20',
      local: false,
      models: [{ name: 'llama3.2:3b', bytes: 2_000_000_000 }],
      chosen: 'llama3.2:3b',
    })
    const props = { status: status({ firstRun: 'again' }), onChanged: vi.fn() }
    const page = await firstRunAt('cleaned', props, { getCleanupFacts: async () => elsewhere })
    const said = JSON.stringify(await drawn(findAll(page, named('CleanedStep'))[0]))

    expect(said).toContain('Running at 192.168.1.20, which is not this Mac')
    expect(said).not.toContain('Nothing leaves this Mac')
    expect(said).not.toContain('Runs on this Mac')
  })

  it('leaves no "Starting Ollama…" timer behind, when Start is pressed again or the page goes', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', {
      flowHub: {
        getCleanupFacts: async () => cleanupFacts({ ollama: 'notRunning' }),
        startOllama: () => new Promise<void>(() => {}),
      },
    })
    const props = { status: status(), onChanged: vi.fn() }
    hooks.render(Cleanup, props)
    await tick()
    const start = button(hooks.render(Cleanup, props), 'Start Ollama')
    start.props.onClick()
    start.props.onClick()
    hooks.reset()

    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('when the main process does not answer (hub-7)', () => {
  it('a page that does not ask by itself asks again after a failure, and knows that it failed', async () => {
    vi.useFakeTimers()
    const ask = vi
      .fn()
      .mockRejectedValueOnce(new Error('the storage process stopped'))
      .mockResolvedValue('an answer')
    const Asking = () => useFacts(ask, null)
    hooks.render(Asking, {})
    await tick()
    expect(hooks.render(Asking, {})).toMatchObject({ facts: null, failed: true })

    await vi.advanceTimersByTimeAsync(5_000)
    hooks.render(Asking, {})
    await tick()
    expect(ask).toHaveBeenCalledTimes(2)
    expect(hooks.render(Asking, {})).toMatchObject({ facts: 'an answer', failed: false })
  })

  it('the History page says that its list could not be read, with the way to ask again', async () => {
    const getHistory = vi.fn(async () => {
      throw new Error('SECRET_ERROR_TEXT')
    })
    vi.stubGlobal('window', { flowHub: { getHistory } })
    const props = {
      status: status({ history: { count: 3 } }),
      shown: true,
      onChanged: vi.fn(),
      onOpen: vi.fn(),
    }
    hooks.render(History, props)
    await tick()
    const page = hooks.render(History, props)

    expect(JSON.stringify(page)).toContain('The history could not be read.')
    expect(JSON.stringify(page)).not.toContain('SECRET_ERROR_TEXT')
    button(page, 'Try Again').props.onClick()
    hooks.render(History, props)
    expect(getHistory).toHaveBeenCalledTimes(2)
  })

  it('an opened dictation says so when a Delete fails, and stays open', async () => {
    vi.stubGlobal('window', {
      flowHub: {
        getHistoryEntry: async () => entry(),
        deleteHistoryEntry: async () => {
          throw new Error('SECRET_ERROR_TEXT')
        },
      },
    })
    const props = {
      id: 'a-1',
      status: status(),
      onBack: vi.fn(),
      onChanged: vi.fn(),
      onPage: vi.fn(),
    }
    hooks.render(HistoryDetail, props)
    await tick()
    button(hooks.render(HistoryDetail, props), 'Delete').props.onClick()
    await tick()
    const said = JSON.stringify(hooks.render(HistoryDetail, props))

    expect(props.onBack).not.toHaveBeenCalled()
    expect(said).toContain('This dictation could not be deleted.')
    expect(said).not.toContain('SECRET_ERROR_TEXT')
  })

  it('an opened dictation says Copied for the whole time after each copy', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('window', {
      flowHub: { getHistoryEntry: async () => entry(), copyHistoryEntry: async () => true },
    })
    const props = {
      id: 'a-1',
      status: status(),
      onBack: vi.fn(),
      onChanged: vi.fn(),
      onPage: vi.fn(),
    }
    hooks.render(HistoryDetail, props)
    await tick()
    const copy = () =>
      findAll(
        hooks.render(HistoryDetail, props),
        (item) => named('Button')(item) && ['Copy', 'Copied'].includes(textOf(item)),
      )[0]

    copy().props.onClick()
    await tick()
    expect(textOf(copy())).toBe('Copied')
    await vi.advanceTimersByTimeAsync(1_000)
    copy().props.onClick()
    await tick()
    await vi.advanceTimersByTimeAsync(600)
    expect(textOf(copy())).toBe('Copied')
    await vi.advanceTimersByTimeAsync(1_000)
    expect(textOf(copy())).toBe('Copy')
  })

  it('the Privacy page says that its facts could not be read, with the way to ask again', async () => {
    const ask = vi.fn(async () => {
      throw new Error('SECRET_ERROR_TEXT')
    })
    vi.stubGlobal('window', { flowHub: { getPrivacyFacts: ask } })
    const props = { status: status(), onChanged: vi.fn() }
    hooks.render(Privacy, props)
    await tick()
    const page = hooks.render(Privacy, props)

    expect(JSON.stringify(page)).toContain('The facts could not be read.')
    button(page, 'Try Again').props.onClick()
    hooks.render(Privacy, props)
    expect(ask).toHaveBeenCalledTimes(2)
  })

  it('the window says in plain words that the status could not be read, never what the error said', async () => {
    vi.stubGlobal('window', {
      flowHub: {
        getStatus: async () => {
          throw new Error('SECRET_ERROR_TEXT')
        },
        onPrivacyReset: () => () => {},
        onNavigate: () => () => {},
      },
    })
    hooks.render(App, {})
    await tick()
    const said = JSON.stringify(hooks.render(App, {}))

    expect(said).not.toContain('SECRET_ERROR_TEXT')
    expect(said).toContain('The status could not be read.')
  })

  it('the Ollama address says in plain words that it could not be saved', async () => {
    const change = vi.fn(async () => {
      throw new Error('SECRET_ERROR_TEXT')
    })
    vi.stubGlobal('window', { flowHub: { changePreference: change } })
    const props = { status: status(), onChanged: vi.fn() }
    const advanced = findAll(hooks.render(Settings, props), named('Advanced'))[0]
    hooks.reset()
    const field = () => findAll(hooks.render(advanced.type, advanced.props), named('Field'))[0]
    field().props.onChange('http://localhost:11434')
    field().props.onCommit()
    await tick()
    const said = JSON.stringify(hooks.render(advanced.type, advanced.props))

    expect(change).toHaveBeenCalledTimes(1)
    expect(advanced.props.onChanged).toHaveBeenCalled()
    expect(said).toContain('The address could not be saved.')
    expect(said).not.toContain('SECRET_ERROR_TEXT')
  })

  it('a field commits an edit once, though Return and then leaving it both commit', () => {
    const onCommit = vi.fn()
    const props = {
      label: 'Ollama address',
      value: 'http://127.0.0.1:11434',
      onChange: () => {},
      onCommit,
    }
    input(hooks.render(Field, props)).props.onChange({
      target: { value: 'http://localhost:11434' },
    })
    input(hooks.render(Field, props)).props.onKeyDown({ key: 'Enter' })
    input(hooks.render(Field, props)).props.onBlur()
    expect(onCommit).toHaveBeenCalledTimes(1)

    // Left again without an edit: there is nothing to commit.
    input(hooks.render(Field, props)).props.onBlur()
    expect(onCommit).toHaveBeenCalledTimes(1)
  })
})

describe('what a screen reader is told as the speech model downloads (hub-2)', () => {
  const downloading = (progress: number, change: Partial<AppStatus> = {}) =>
    status({
      ...change,
      speech: { state: 'modelMissing', modelDownloaded: false, downloadProgress: progress },
    })

  it('Home tells of a change in a line of its own, without the figure that moves', () => {
    const at = (progress: number) =>
      spokenLine(
        hooks.render(Home, {
          status: downloading(progress),
          onChanged: () => {},
          onPage: () => {},
          onOpen: () => {},
        }),
      ).map(textOf)

    expect(at(0.3)).toEqual(['Downloading the speech model'])
    expect(at(0.33)).toEqual(at(0.3))
  })

  it('the first run tells of a change of the bar at its foot, without the figures that move', async () => {
    const props = { status: downloading(0.3, { firstRun: 'first' }), onChanged: vi.fn() }
    const page = await firstRunAt('welcome', props)
    const bar = findAll(page, named('ModelBar'))[0]

    expect(spokenLine(page).map(textOf)).toEqual(['Downloading the speech model'])
    expect(bar.type(bar.props).props.role).toBeUndefined()
  })
})

describe('what a screen reader is told of the parts (hub-14)', () => {
  it('an app tile is an image, with the app’s name', () => {
    expect(AppTile({ name: 'Slack' }).props).toMatchObject({ role: 'img', 'aria-label': 'Slack' })
  })

  it('a progress bar has a name', () => {
    expect(ProgressBar({ value: 0.5, label: 'Downloading the speech model' }).props).toMatchObject({
      'aria-label': 'Downloading the speech model',
    })
  })

  it('the choice of when the pill is shown is one stop for Tab: the option chosen', () => {
    const settings = hooks.render(Settings, { status: status(), onChanged: () => {} })
    const choices = findAll(settings, named('PillChoice'))

    expect(choices.map((choice) => choice.type(choice.props).props.tabIndex)).toEqual([0, -1])
  })
})

describe('what was said is marked, so that a picture leaves it blank (hub-15)', () => {
  it('the practice box of the first run', async () => {
    const props = { status: status({ firstRun: 'first' }), onChanged: vi.fn() }
    const page = await firstRunAt('try', props)
    const step = await drawn(findAll(page, named('TryStep'))[0])

    expect(findAll(step, (item) => item.type === 'textarea')[0].props).toHaveProperty('data-said')
  })

  it('the sentence and its results in Try it, and not its hints', async () => {
    vi.useFakeTimers()
    const result = (text: string) => ({ text, ms: 1 })
    vi.stubGlobal('window', {
      flowHub: {
        tryCleanup: async () => ({
          verbatim: result('SYNTHETIC_VERBATIM'),
          rules: result('SYNTHETIC_RULES'),
          cleaned: null,
        }),
      },
    })
    const facts = cleanupFacts({ ollama: 'running', chosen: null })
    input(hooks.render(TryIt, { facts })).props.onChange({ target: { value: 'synthetic' } })
    hooks.render(TryIt, { facts })
    await vi.advanceTimersByTimeAsync(600)
    await tick()
    const tree = hooks.render(TryIt, { facts })
    const marked = findAll(tree, (item) => item.type === 'span' && 'data-said' in item.props)

    expect(marked.map(textOf)).toEqual(['SYNTHETIC_VERBATIM', 'SYNTHETIC_RULES'])
    expect(input(tree).props).toHaveProperty('data-said')
  })
})
