export interface ProcessFacts {
  isRunning?: (pid: number) => boolean
  started?: (pid: number) => string | null
}
export function outputLock(
  note: string,
  facts?: ProcessFacts,
): { take(what: string, pid?: number): string | null }
export function take(what: string, pid?: number): string | null
