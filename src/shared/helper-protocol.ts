import { z } from 'zod'

/**
 * The JSON-lines contract with the Swift helper. The Swift side of the same contract
 * is `native/flow-helper/Sources/FlowHelperCore/HelperProtocol.swift`.
 *
 * Everything the helper writes is validated here before the app acts on it.
 */

/** Bumped whenever a message changes shape; the helper reports its own in `ready`. */
export const HELPER_PROTOCOL_VERSION = 3

// --- Messages the helper sends on its own -------------------------------------------

export const helperReadySchema = z.object({
  type: z.literal('ready'),
  protocol: z.number().int(),
  accessibilityTrusted: z.boolean(),
  tapInstalled: z.boolean(),
})
export type HelperReady = z.infer<typeof helperReadySchema>

/** `t` is the key event's time in milliseconds since boot. */
const bindingDownSchema = z.object({
  type: z.literal('bindingDown'),
  id: z.string(),
  t: z.number(),
})
const bindingUpSchema = z.object({
  type: z.literal('bindingUp'),
  id: z.string(),
  t: z.number(),
  /** `released` normally; `tapReset` when the tap was disabled and key state was lost. */
  reason: z.string(),
})
const interruptedSchema = z.object({
  type: z.literal('interrupted'),
  id: z.string(),
  t: z.number(),
})
const cancelSchema = z.object({ type: z.literal('cancel'), t: z.number() })
const tapStateSchema = z.object({
  type: z.literal('tapState'),
  installed: z.boolean(),
  reason: z.string(),
})
const pasteSettledSchema = z.object({
  type: z.literal('pasteSettled'),
  pasteId: z.number().int(),
  /** True when what was on the clipboard before the paste is on it again. */
  restored: z.boolean(),
  /**
   * Why it is not: `copiedSince` (the user copied something after the paste, and keeps
   * it), `notSaved` (the clipboard could not be copied whole, so the pasted text is
   * still on it) or `failed` (the pasteboard would not take the copy back).
   */
  reason: z.string().optional(),
})

export const helperEventSchema = z.discriminatedUnion('type', [
  bindingDownSchema,
  bindingUpSchema,
  interruptedSchema,
  cancelSchema,
  tapStateSchema,
  pasteSettledSchema,
])
export type HelperEvent = z.infer<typeof helperEventSchema>

// --- Requests and replies ---------------------------------------------------------

export const helperReplySchema = z.object({
  id: z.number().int(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z.string().optional(),
})
export type HelperReply = z.infer<typeof helperReplySchema>

export interface HelperRequest {
  id: number
  type: string
  [field: string]: unknown
}

export const targetResultSchema = z.object({
  /** -1 when nothing was frontmost; a paste with it is always refused. */
  targetId: z.number().int(),
  secure: z.boolean(),
  /** What marked the field as a password field: `element` or `secureInput`. */
  secureReason: z.string().optional(),
  /** Secure Event Input is on but was ignored: the app kept it on while it was not in front. */
  secureInputStuck: z.boolean().optional(),
  hasElement: z.boolean(),
  hasWindow: z.boolean().optional(),
  bundleId: z.string().optional(),
  appName: z.string().optional(),
})
export type TargetResult = z.infer<typeof targetResultSchema>

/**
 * `expired`: the helper got to the paste, or got back from reading the clipboard, after
 * the time the request said the app would stop waiting. Nothing was pasted.
 */
export const pasteOutcomeSchema = z.enum([
  'pasted',
  'targetChanged',
  'secureField',
  'noPostAccess',
  'expired',
])
export type PasteOutcome = z.infer<typeof pasteOutcomeSchema>
export const pasteResultSchema = z.object({
  outcome: pasteOutcomeSchema,
  /**
   * Why a paste was refused. `targetChanged`: which part of the destination differs
   * (app, window, element…). `secureField`: what marked it as one. `noPostAccess`:
   * what the permission checks said. `expired`: where the time ran out. Never anything
   * about the text.
   */
  detail: z.string().optional(),
})
export type PasteResult = z.infer<typeof pasteResultSchema>

export const permissionsResultSchema = z.object({
  accessibilityTrusted: z.boolean(),
  postEventAccess: z.boolean(),
  tapInstalled: z.boolean(),
  secureInput: z.boolean(),
})
export type PermissionsResult = z.infer<typeof permissionsResultSchema>

export const installTapResultSchema = z.object({
  tapInstalled: z.boolean(),
  accessibilityTrusted: z.boolean(),
})
export type InstallTapResult = z.infer<typeof installTapResultSchema>

/** Everything the helper can write to stdout. Anything else on that pipe is ignored. */
export const helperMessageSchema = z.union([
  helperReadySchema,
  helperEventSchema,
  helperReplySchema,
])
export type HelperMessage = z.infer<typeof helperMessageSchema>
