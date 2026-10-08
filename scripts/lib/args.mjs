// The switches a script is given, read strictly. A switch that is misspelt, or given
// without its value, or with a value it cannot take, stops the script and says why. Read
// loosely, `--when-idle=120` was taken for no wait at all, and a test that takes the
// keyboard started at once; `--repeat` with no number ran nothing and passed.
import { parseArgs } from 'node:util'

/**
 * Reads `args` against `options`, which are as node:util's `parseArgs` takes them, with
 * one more type: `number`, a whole number of at least `min` (1 unless said). Throws on
 * a switch it does not know, a value that is missing or is not such a number, and a
 * word that belongs to no switch.
 */
export function parseSwitches(options, args) {
  const asParsed = Object.fromEntries(
    Object.entries(options).map(([name, option]) => [
      name,
      option.type === 'number' ? { type: 'string' } : option,
    ]),
  )
  const { values } = parseArgs({ args, options: asParsed, strict: true })
  for (const [name, option] of Object.entries(options)) {
    if (option.type !== 'number' || values[name] === undefined) continue
    const min = option.min ?? 1
    if (!/^\d+$/.test(values[name]) || Number(values[name]) < min) {
      throw new Error(`--${name} takes a whole number of ${min} or more, not "${values[name]}"`)
    }
    values[name] = Number(values[name])
  }
  return values
}

/** `parseSwitches` of this script's own arguments. A mistake in them ends the script. */
export function switches(options) {
  try {
    return parseSwitches(options, process.argv.slice(2))
  } catch (error) {
    const known = Object.entries(options).map(([name, option]) =>
      option.type === 'boolean' ? `--${name}` : `--${name} <${option.type}>`,
    )
    console.error(`${error.message}\nThe switches it takes: ${known.join(', ')}`)
    process.exit(1)
  }
}
