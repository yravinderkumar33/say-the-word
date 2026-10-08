export type Switch = { type: 'boolean' } | { type: 'string' } | { type: 'number'; min?: number }
export type Switches<T extends Record<string, Switch>> = {
  [K in keyof T]?: T[K] extends { type: 'boolean' }
    ? boolean
    : T[K] extends { type: 'number' }
      ? number
      : string
}
export function parseSwitches<const T extends Record<string, Switch>>(
  options: T,
  args: readonly string[],
): Switches<T>
export function switches<const T extends Record<string, Switch>>(options: T): Switches<T>
