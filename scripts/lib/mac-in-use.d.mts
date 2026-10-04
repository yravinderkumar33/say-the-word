export function idleSeconds(): number
export function busyWith(assertions: string): string | null
export function macBusyWith(): string | null
export function waitUntilFree(options: {
  idleFor: number
  maxWaitMs: number
  ignoreCalls?: boolean
}): Promise<string | null>
export function mayTakeTheKeyboard(options: {
  idleFor: number
  evenIfInUse?: boolean
}): Promise<boolean>
