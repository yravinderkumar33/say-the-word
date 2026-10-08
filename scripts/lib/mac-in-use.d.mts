export function busyWith(assertions: string): string | null
export function dictationAppIn(processes: string, electron: string): string | null
export function mayTakeTheKeyboard(options: {
  idleFor: number
  evenIfInUse?: boolean
}): Promise<boolean>
