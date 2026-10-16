/**
 * Wire protocol shared by the Host service and the browser half: request and
 * result types, the `sessionTrash` Typert invocation descriptors with strict
 * codecs, and the Remote failure codes. Everything here is plain data and
 * validation; it imports no Node or browser API, so both builds include it.
 * Calls travel the Connection's authenticated `/api` route, never an
 * unauthenticated web route.
 */

import type { InvocationDescriptor, TypertCodec, TypertSchema } from '@deepseek-ai/dsh-typert-protocol'

/** Typert namespace and Cordis service key of the trash service. */
export const SESSION_TRASH_NAMESPACE = 'sessionTrash'

/** npm package that owns the Remote methods. */
export const SESSION_TRASH_PACKAGE = 'dsh-plugin-session-trash'

/** One conversation in the trash, with any subagent sessions moved alongside it. */
export interface TrashEntryView {
  /** Opaque trash entry identity (a UUID). */
  readonly entryId: string
  /** The conversation the user moved to the trash. */
  readonly sessionId: string
  /** Display title captured when the conversation was moved. */
  readonly title: string
  /** Project directory of the conversation, when its header named one. */
  readonly cwd?: string
  /** Move time, epoch milliseconds. */
  readonly deletedAt: number
  /** Session logs held by the entry: the conversation plus its subagent sessions. */
  readonly sessionCount: number
  /** Total bytes of the entry's session files. */
  readonly sizeBytes: number
}

/**
 * A conversation DSH held open when the user moved it: it is archived (hidden)
 * now and moves into the trash at the next DSH start, before any session opens.
 */
export interface PendingMoveView {
  /** Opaque pending-move identity (a UUID). */
  readonly pendingId: string
  readonly sessionId: string
  readonly title: string
  readonly cwd?: string
  /** Request time, epoch milliseconds. */
  readonly requestedAt: number
}

/** Move one conversation to the trash. */
export interface MoveToTrashRequest {
  readonly sessionId: string
  /** Row title shown later in the trash list. */
  readonly title: string
}

/** Result of a move: the new trash entry, or a pending move when DSH holds the conversation open. */
export type MoveToTrashResult =
  | { readonly entry: TrashEntryView }
  | { readonly pending: PendingMoveView }

/** Address one trash entry. */
export interface TrashEntryRequest {
  readonly entryId: string
}

/** Address one pending move. */
export interface PendingMoveRequest {
  readonly pendingId: string
}

/** The conversation a cancelled pending move put back. */
export interface PendingMoveResult {
  readonly sessionId: string
}

/** The trash contents and the pending moves, each newest first. */
export interface TrashListResult {
  readonly entries: readonly TrashEntryView[]
  readonly pending: readonly PendingMoveView[]
}

/** Session logs a restore or purge affected. */
export interface TrashEntryResult {
  readonly sessionIds: readonly string[]
}

/** Remote failure codes thrown by the service. */
export type SessionTrashErrorCode =
  | 'session-trash/unsupported'
  | 'session-trash/not-found'
  | 'session-trash/session-active'
  | 'session-trash/session-in-use'
  | 'session-trash/refused'
  | 'session-trash/restore-conflict'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The composition or platform cannot move sessions safely; nothing changed. */
    'session-trash/unsupported': { readonly reason: string }
    /** No such conversation or trash entry. */
    'session-trash/not-found': { readonly id: string }
    /** The conversation or a subagent session still runs work; nothing changed. */
    'session-trash/session-active': { readonly sessionId: string; readonly activity: readonly string[] }
    /** Another owner (usually another DSH process) holds the log's write lock; nothing changed. */
    'session-trash/session-in-use': { readonly sessionId: string }
    /** Storage holds an entry this plugin does not recognize, or a path check failed; nothing changed. */
    'session-trash/refused': { readonly reason: string }
    /** A session already exists where a restore would put it back; nothing changed. */
    'session-trash/restore-conflict': { readonly sessionId: string }
  }
}

function strict<T>(typeSymbol: string, parse: (value: unknown) => T): TypertCodec {
  const schema: TypertSchema<T> = { parse }
  return { mode: 'strict', typeSymbol, create: () => schema }
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new TypeError(`${what} must be an object`)
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[], what: string): void {
  for (const key of required) if (!(key in value)) throw new TypeError(`${what}.${key} is required`)
  for (const key of Object.keys(value)) {
    if (!required.includes(key) && !optional.includes(key)) throw new TypeError(`${what}.${key} is not allowed`)
  }
}

function text(value: unknown, what: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength) {
    throw new TypeError(`${what} must be a non-empty string of at most ${String(maxLength)} characters`)
  }
  return value
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function uuid(value: unknown, what: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new TypeError(`${what} must be a lowercase UUID`)
  return value
}

/**
 * Validate a trash entry id: a lowercase UUID, so it can never name a path
 * outside the trash directory.
 * @param value - untrusted value.
 * @returns the entry id.
 */
export function parseEntryId(value: unknown): string {
  return uuid(value, 'entryId')
}

function parseMoveRequest(value: unknown): MoveToTrashRequest {
  const body = record(value, 'request')
  exactKeys(body, ['sessionId', 'title'], [], 'request')
  return { sessionId: text(body.sessionId, 'request.sessionId', 512), title: text(body.title, 'request.title', 1000) }
}

function parseEntryRequest(value: unknown): TrashEntryRequest {
  const body = record(value, 'request')
  exactKeys(body, ['entryId'], [], 'request')
  return { entryId: parseEntryId(body.entryId) }
}

function parseEntryView(value: unknown): TrashEntryView {
  const body = record(value, 'entry')
  exactKeys(body, ['entryId', 'sessionId', 'title', 'deletedAt', 'sessionCount', 'sizeBytes'], ['cwd'], 'entry')
  const numbers = ['deletedAt', 'sessionCount', 'sizeBytes'] as const
  for (const key of numbers) {
    const field = body[key]
    if (typeof field !== 'number' || !Number.isSafeInteger(field) || field < 0) throw new TypeError(`entry.${key} must be a non-negative integer`)
  }
  return {
    entryId: parseEntryId(body.entryId),
    sessionId: text(body.sessionId, 'entry.sessionId', 512),
    title: text(body.title, 'entry.title', 1000),
    ...body.cwd === undefined ? {} : { cwd: text(body.cwd, 'entry.cwd', 4096) },
    deletedAt: body.deletedAt as number,
    sessionCount: body.sessionCount as number,
    sizeBytes: body.sizeBytes as number,
  }
}

function parsePendingRequest(value: unknown): PendingMoveRequest {
  const body = record(value, 'request')
  exactKeys(body, ['pendingId'], [], 'request')
  return { pendingId: uuid(body.pendingId, 'request.pendingId') }
}

function parsePendingView(value: unknown): PendingMoveView {
  const body = record(value, 'pending')
  exactKeys(body, ['pendingId', 'sessionId', 'title', 'requestedAt'], ['cwd'], 'pending')
  if (typeof body.requestedAt !== 'number' || !Number.isSafeInteger(body.requestedAt) || body.requestedAt < 0) {
    throw new TypeError('pending.requestedAt must be a non-negative integer')
  }
  return {
    pendingId: uuid(body.pendingId, 'pending.pendingId'),
    sessionId: text(body.sessionId, 'pending.sessionId', 512),
    title: text(body.title, 'pending.title', 1000),
    ...body.cwd === undefined ? {} : { cwd: text(body.cwd, 'pending.cwd', 4096) },
    requestedAt: body.requestedAt,
  }
}

function parseIds(value: unknown, what: string): readonly string[] {
  if (!Array.isArray(value)) throw new TypeError(`${what} must be an array`)
  return value.map((id, index) => text(id, `${what}[${String(index)}]`, 512))
}

const T = `${SESSION_TRASH_PACKAGE}/types`
const requestCodecs = {
  move: strict(`${T}#MoveToTrashRequest`, parseMoveRequest),
  entry: strict(`${T}#TrashEntryRequest`, parseEntryRequest),
  pending: strict(`${T}#PendingMoveRequest`, parsePendingRequest),
}
const resultCodecs = {
  move: strict(`${T}#MoveToTrashResult`, (value): MoveToTrashResult => {
    const body = record(value, 'result')
    if ('pending' in body) {
      exactKeys(body, ['pending'], [], 'result')
      return { pending: parsePendingView(body.pending) }
    }
    exactKeys(body, ['entry'], [], 'result')
    return { entry: parseEntryView(body.entry) }
  }),
  list: strict(`${T}#TrashListResult`, (value) => {
    const body = record(value, 'result')
    exactKeys(body, ['entries', 'pending'], [], 'result')
    if (!Array.isArray(body.entries)) throw new TypeError('result.entries must be an array')
    if (!Array.isArray(body.pending)) throw new TypeError('result.pending must be an array')
    return { entries: body.entries.map(parseEntryView), pending: body.pending.map(parsePendingView) }
  }),
  cancel: strict(`${T}#PendingMoveResult`, (value) => {
    const body = record(value, 'result')
    exactKeys(body, ['sessionId'], [], 'result')
    return { sessionId: text(body.sessionId, 'result.sessionId', 512) }
  }),
  entry: strict(`${T}#TrashEntryResult`, (value) => {
    const body = record(value, 'result')
    exactKeys(body, ['sessionIds'], [], 'result')
    return { sessionIds: parseIds(body.sessionIds, 'result.sessionIds') }
  }),
}

function descriptor(method: string, parameters: readonly { name: string; codec: TypertCodec }[], result: TypertCodec): InvocationDescriptor {
  return {
    id: `${SESSION_TRASH_PACKAGE}#${SESSION_TRASH_NAMESPACE}/${method}`,
    service: SESSION_TRASH_NAMESPACE,
    namespace: SESSION_TRASH_NAMESPACE,
    method,
    invocation: { kind: 'direct' as const },
    parameters: parameters.map(parameter => ({
      name: parameter.name, wire: parameter.name, source: 'json' as const, codec: parameter.codec,
    })),
    result,
    sourceLocation: { file: `${SESSION_TRASH_PACKAGE}/lib/index.js`, line: 1, column: 1 },
  }
}

/** The Remote methods, in one list shared by the Host registration and the Client mount. */
export const SESSION_TRASH_DESCRIPTORS: readonly InvocationDescriptor[] = [
  descriptor('moveToTrash', [{ name: 'request', codec: requestCodecs.move }], resultCodecs.move),
  descriptor('listTrash', [], resultCodecs.list),
  descriptor('restore', [{ name: 'request', codec: requestCodecs.entry }], resultCodecs.entry),
  descriptor('purge', [{ name: 'request', codec: requestCodecs.entry }], resultCodecs.entry),
  descriptor('cancelPending', [{ name: 'request', codec: requestCodecs.pending }], resultCodecs.cancel),
]
