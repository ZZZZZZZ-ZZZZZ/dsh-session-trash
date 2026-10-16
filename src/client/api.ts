/**
 * Browser access to the `sessionTrash` Remote methods. The contribution is
 * mounted on `ctx.remote`, so every call travels the Connection's
 * authenticated `/api` route. Failures come back as Remote results and are
 * turned into localized messages here.
 */

import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import {
  SESSION_TRASH_DESCRIPTORS, SESSION_TRASH_NAMESPACE, SESSION_TRASH_PACKAGE,
  type MoveToTrashRequest, type MoveToTrashResult, type PendingMoveRequest, type PendingMoveResult,
  type TrashEntryRequest, type TrashEntryResult, type TrashListResult,
} from '../protocol.ts'
import type { SessionTrashKey } from './locales.ts'

/** The mounted `remote.sessionTrash` namespace. */
export interface SessionTrashRemote {
  moveToTrash(request: MoveToTrashRequest): Promise<RemoteResult<MoveToTrashResult>>
  listTrash(): Promise<RemoteResult<TrashListResult>>
  restore(request: TrashEntryRequest): Promise<RemoteResult<TrashEntryResult>>
  purge(request: TrashEntryRequest): Promise<RemoteResult<TrashEntryResult>>
  cancelPending(request: PendingMoveRequest): Promise<RemoteResult<PendingMoveResult>>
}

/** Contribution mounted on `ctx.remote`. */
export const SESSION_TRASH_REMOTE = { package: SESSION_TRASH_PACKAGE, descriptors: SESSION_TRASH_DESCRIPTORS }

/** Namespace service key under which the Client Remote publishes the methods. */
export const REMOTE_SERVICE = `remote.${SESSION_TRASH_NAMESPACE}`

/** Translate function bound to this plugin's namespace; the shared `cancel`/`close` words come from the common vocabulary. */
export type Translate = (key: SessionTrashKey | 'cancel' | 'close', params?: Record<string, string | number>) => string

/** A failed call, already localized. */
export class TrashActionError extends Error {
  /**
   * @param message - localized text for the user.
   * @param code - Remote failure code, when the Host answered with one.
   */
  constructor(message: string, readonly code: string | undefined) {
    super(message)
    this.name = 'TrashActionError'
  }
}

/**
 * Unwrap a Remote result, mapping each failure code to localized copy.
 * @param result - the Remote result.
 * @param t - translate function.
 * @returns the value of a successful call.
 */
export function unwrap<T>(result: RemoteResult<T>, t: Translate): T {
  if (result.ok) return result.value
  const { error } = result
  const details: unknown = error.details
  const field = (name: string): string => {
    const value: unknown = typeof details === 'object' && details !== null ? Reflect.get(details, name) : undefined
    return typeof value === 'string' ? value : ''
  }
  const code: string = error.code
  switch (code) {
    case 'session-trash/unsupported': throw new TrashActionError(t('error.unsupported', { reason: field('reason') }), code)
    case 'session-trash/not-found': throw new TrashActionError(t('error.notFound'), code)
    case 'session-trash/session-active': throw new TrashActionError(t('error.active'), code)
    case 'session-trash/session-in-use': throw new TrashActionError(t('error.inUse'), code)
    case 'session-trash/refused': throw new TrashActionError(t('error.refused', { reason: field('reason') }), code)
    case 'session-trash/restore-conflict': throw new TrashActionError(t('error.conflict'), code)
    default: throw new TrashActionError(t('error.failed', { message: `${code}: ${error.message}` }), code)
  }
}

/**
 * Format a byte count for the trash list.
 * @param bytes - byte count.
 * @returns a short human-readable size.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit] as string}`
}
