/**
 * Host half of `dsh-plugin-session-trash`: the `sessionTrash` service and its four
 * Remote methods. Moving a conversation hides it with the official
 * `archiveSession`, then moves its log directory (and its subagent sessions')
 * into the trash. Restoring moves them back and undoes the archive and pin
 * changes the move made; purging deletes the trash entry's files and drops the
 * conversation from the registry's archive set, pin set, and Workspace
 * accounts. See `trash-store.ts` for the filesystem rules.
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { tryLockExclusive } from '@deepseek-ai/node-addon-system/flock'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-typert-registry'
import type {} from '@deepseek-ai/dsh-workspace'
import {
  SESSION_TRASH_DESCRIPTORS, SESSION_TRASH_NAMESPACE, SESSION_TRASH_PACKAGE,
  type MoveToTrashRequest, type MoveToTrashResult, type PendingMoveRequest, type PendingMoveResult,
  type PendingMoveView, type TrashEntryRequest, type TrashEntryResult, type TrashEntryView, type TrashListResult,
} from './protocol.ts'
import { TrashStore, TrashStoreError, type PendingRecord, type TrashEntry } from './trash-store.ts'

export type * from './protocol.ts'
export { TrashStore, TrashStoreError, encodeSegment } from './trash-store.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionTrash: SessionTrash
  }
  interface Events {
    /**
     * Session Controller's removal notice, relayed to every Client. Declared
     * here with the same signature so this plugin need not depend on it.
     * @param sessionId - the session no longer listed.
     * @mode emit
     */
    'api-session/removed'(sessionId: SessionId): void
  }
}

/** Plugin configuration. */
export interface Config {
  /**
   * Directory holding trash entries. Defaults to `session-trash` under the
   * DSH home. Must be outside the session root and on the same volume.
   */
  trashDirectory?: string
}

const JSONL_BACKEND = 'session-persistence-jsonl'

/** The JSONL backend's root from its public `config`, or `undefined` for another backend. */
function jsonlRoot(backend: object): string | undefined {
  if (Reflect.get(backend, 'name') !== JSONL_BACKEND) return undefined
  const config: unknown = Reflect.get(backend, 'config')
  const root: unknown = typeof config === 'object' && config !== null ? Reflect.get(config, 'root') : undefined
  return typeof root === 'string' ? root : undefined
}

function view(entry: TrashEntry): TrashEntryView {
  const { manifest } = entry
  return {
    entryId: manifest.entryId,
    sessionId: manifest.sessionId,
    title: manifest.title,
    ...manifest.cwd === undefined ? {} : { cwd: manifest.cwd },
    deletedAt: manifest.deletedAt,
    sessionCount: manifest.sessions.length,
    sizeBytes: entry.sizeBytes,
  }
}

function pendingView(record: PendingRecord): PendingMoveView {
  return {
    pendingId: record.pendingId,
    sessionId: record.sessionId,
    title: record.title,
    ...record.cwd === undefined ? {} : { cwd: record.cwd },
    requestedAt: record.requestedAt,
  }
}

function remoteFailure(error: unknown): unknown {
  if (!(error instanceof TrashStoreError)) return error
  switch (error.kind) {
    case 'not-found': return new RemoteError('session-trash/not-found', error.message, { id: error.subject }, { cause: error })
    case 'in-use': return new RemoteError('session-trash/session-in-use', error.message, { sessionId: error.subject }, { cause: error })
    case 'restore-conflict': return new RemoteError('session-trash/restore-conflict', error.message, { sessionId: error.subject }, { cause: error })
    case 'refused': return new RemoteError('session-trash/refused', error.message, { reason: error.message }, { cause: error })
  }
}

/**
 * The session trash service (`ctx.sessionTrash`). Operations run one at a
 * time. Every refusal happens before any file or registry state changes.
 */
export class SessionTrash extends TypertRemoteService {
  static inject = ['sessionPersistence', 'workspaceRegistry', 'typert']

  static Config: z<Config> = z.object({
    trashDirectory: z.string().description('Directory holding trash entries; default `<DSH home>/session-trash`.'),
  })

  private store: TrashStore | undefined
  private unsupported: string | undefined
  private tail: Promise<unknown> = Promise.resolve()

  /**
   * @param ctx - Host context with session persistence, the Workspace registry, and the Typert registry.
   * @param config - plugin configuration.
   */
  constructor(ctx: Context, private readonly config: Config = {}) {
    super(ctx, SESSION_TRASH_NAMESPACE)
  }

  protected async [Service.init](): Promise<void> {
    const root = jsonlRoot(this.ctx.sessionPersistence)
    if (process.platform === 'win32') {
      this.unsupported = 'Windows is not supported: the session write lock cannot be checked there'
    } else if (root === undefined) {
      this.unsupported = 'session persistence is not the JSONL backend'
    } else {
      this.store = new TrashStore(root, this.config.trashDirectory ?? dshHomePath('session-trash'), tryLockExclusive)
      const recovered = await this.store.recoverStaging((path, error) => {
        this.ctx.logger.warn(`session-trash: interrupted move at "${path}" needs attention: ${String(error)}`)
      })
      if (recovered > 0) this.ctx.logger.info(`session-trash: rolled back ${String(recovered)} interrupted move(s)`)
      await this.processPending(this.store)
    }
    if (this.unsupported !== undefined) this.ctx.logger.warn(`session-trash: disabled — ${this.unsupported}`)
    const dispose = this.ctx.typert.register({
      package: SESSION_TRASH_PACKAGE,
      face: 'host',
      schemas: [],
      model: { services: [], events: [], objects: [] },
      invocations: SESSION_TRASH_DESCRIPTORS,
    })
    this.ctx.effect(() => dispose, 'session-trash: Remote methods')
  }

  /**
   * Move a conversation and its subagent sessions to the trash. Refused while
   * any of them runs work or another owner holds its write lock. A
   * conversation DSH opened in this run cannot move while DSH holds it: it is
   * archived now and recorded as a pending move that the next start completes.
   * @param request - the conversation and its display title.
   * @returns the new trash entry, or the pending move.
   */
  moveToTrash(request: MoveToTrashRequest): Promise<MoveToTrashResult> {
    return this.serial(async (store) => {
      const sessionId = request.sessionId as SessionId
      const headers = (await this.ctx.sessionPersistence.list()).map(snapshot => snapshot.header)
      const header = headers.find(candidate => candidate.id === sessionId)
      if (header === undefined) throw new RemoteError('session-trash/not-found', `session "${sessionId}" has no stored log`, { id: sessionId })
      const targets = descendantsFirst(sessionId, headers)
      await this.assertIdle(targets)
      const registry = this.ctx.workspaceRegistry
      // A conversation already pending was archived by its first request; its record keeps the earlier state.
      const earlier = (await store.listPending()).find(record => record.sessionId === sessionId)
      const wasArchived = earlier?.wasArchived ?? registry.archivedSessionIds.includes(sessionId)
      const wasPinned = earlier?.wasPinned ?? registry.pinnedSessionIds.includes(sessionId)
      const cwd = header.cwd === undefined ? {} : { cwd: header.cwd }
      if (!registry.archivedSessionIds.includes(sessionId)) await registry.archiveSession(sessionId)

      if (this.heldOpen(targets)) {
        try {
          return { pending: pendingView(await store.addPending({ sessionId, title: request.title, ...cwd, wasArchived, wasPinned })) }
        } catch (error: unknown) {
          if (earlier === undefined) await this.restoreRegistryState(sessionId, wasArchived, wasPinned)
          throw error
        }
      }

      let entry: TrashEntry
      try {
        entry = await store.moveToTrash({ sessionId, title: request.title, ...cwd, wasArchived, wasPinned, sessionIds: targets })
      } catch (error: unknown) {
        // Nothing moved: put the archive and pin sets back, keeping the move's own failure as the error.
        if (earlier === undefined) await this.restoreRegistryState(sessionId, wasArchived, wasPinned)
        throw error
      }
      if (earlier !== undefined) await this.bestEffort(`removing pending move "${earlier.pendingId}"`, async () => { await store.removePending(earlier.pendingId) })
      for (const session of entry.manifest.sessions) this.ctx.emit('api-session/removed', session.sessionId as SessionId)
      return { entry: view(entry) }
    })
  }

  /**
   * Cancel a pending move: drop its record and put the archive and pin state back.
   * @param request - the pending move.
   * @returns the conversation it concerned.
   */
  cancelPending(request: PendingMoveRequest): Promise<PendingMoveResult> {
    return this.serial(async (store) => {
      const record = await store.removePending(request.pendingId)
      await this.restoreRegistryState(record.sessionId as SessionId, record.wasArchived, record.wasPinned)
      return { sessionId: record.sessionId }
    })
  }

  /**
   * List the trash and the pending moves, newest first.
   * @returns every readable entry and pending move.
   */
  listTrash(): Promise<TrashListResult> {
    return this.serial(async (store) => {
      const warn = (id: string, error: unknown): void => {
        this.ctx.logger.warn(`session-trash: skipped unreadable record "${id}": ${String(error)}`)
      }
      const entries = await store.list(warn)
      const pending = await store.listPending(warn)
      return { entries: entries.map(view), pending: pending.map(pendingView) }
    })
  }

  /**
   * Put an entry's sessions back and undo the archive and pin changes the move made.
   * @param request - the entry.
   * @returns the restored session ids.
   */
  restore(request: TrashEntryRequest): Promise<TrashEntryResult> {
    return this.serial(async (store) => {
      const manifest = await store.restore(request.entryId)
      // The files are back at this point; a registry hiccup must not report the restore as failed.
      await this.restoreRegistryState(manifest.sessionId as SessionId, manifest.wasArchived, manifest.wasPinned)
      return { sessionIds: manifest.sessions.map(session => session.sessionId) }
    })
  }

  /**
   * Permanently delete an entry, then drop its sessions from the registry.
   * @param request - the entry.
   * @returns the deleted session ids.
   */
  purge(request: TrashEntryRequest): Promise<TrashEntryResult> {
    return this.serial(async (store) => {
      const manifest = await store.purge(request.entryId)
      // The files are gone at this point; leftover registry ids only hide nothing and are logged.
      const registry = this.ctx.workspaceRegistry
      for (const session of manifest.sessions) {
        const id = session.sessionId as SessionId
        await this.bestEffort(`forgetting session "${id}"`, async () => {
          await registry.unarchiveSession(id)
          await registry.unpinSession(id)
          for (const workspace of registry.list()) await workspace.detachSession(id)
        })
      }
      return { sessionIds: manifest.sessions.map(session => session.sessionId) }
    })
  }

  /** Refuse while a target runs work; activity cannot be deferred safely. */
  private async assertIdle(targets: readonly SessionId[]): Promise<void> {
    for (const target of targets) {
      const activity = await this.ctx.waterfall('workspace/session-activity', { sessionId: target }, () => Promise.resolve([]))
      if (activity.length > 0) {
        throw new RemoteError('session-trash/session-active', `session "${target}" is running work`, {
          sessionId: target, activity: activity.map(entry => String(entry.kind)),
        })
      }
    }
  }

  /** Whether this DSH process holds any target open (a live Session it keeps until restart). */
  private heldOpen(targets: readonly SessionId[]): boolean {
    const live = this.ctx.get('sessions')
    return targets.some(target => live?.get(target) !== undefined)
  }

  /**
   * Complete the pending moves at startup, before the user opens sessions. A
   * move that cannot run yet (held, running work, refused) stays pending and
   * is retried at the next start; a conversation that no longer exists drops
   * its record. Never fails the plugin start.
   */
  private async processPending(store: TrashStore): Promise<void> {
    let records: PendingRecord[]
    try {
      records = await store.listPending((id, error) => {
        this.ctx.logger.warn(`session-trash: skipped unreadable pending move "${id}": ${String(error)}`)
      })
    } catch (error: unknown) {
      this.ctx.logger.warn(`session-trash: reading pending moves failed: ${String(error)}`)
      return
    }
    if (records.length === 0) return
    let headers: SessionHeader[]
    try {
      headers = (await this.ctx.sessionPersistence.list()).map(snapshot => snapshot.header)
    } catch (error: unknown) {
      this.ctx.logger.warn(`session-trash: pending moves wait: listing sessions failed: ${String(error)}`)
      return
    }
    for (const record of records) {
      const sessionId = record.sessionId as SessionId
      try {
        if (!headers.some(header => header.id === sessionId)) {
          await store.removePending(record.pendingId)
          this.ctx.logger.warn(`session-trash: session "${sessionId}" no longer exists; dropped its pending move`)
          continue
        }
        const targets = descendantsFirst(sessionId, headers)
        if (this.heldOpen(targets)) continue
        await this.assertIdle(targets)
        const entry = await store.moveToTrash({
          sessionId, title: record.title, ...record.cwd === undefined ? {} : { cwd: record.cwd },
          wasArchived: record.wasArchived, wasPinned: record.wasPinned, sessionIds: targets,
        })
        await store.removePending(record.pendingId)
        for (const session of entry.manifest.sessions) this.ctx.emit('api-session/removed', session.sessionId as SessionId)
        this.ctx.logger.info(`session-trash: moved pending session "${sessionId}" to the trash`)
      } catch (error: unknown) {
        this.ctx.logger.warn(`session-trash: pending move of "${sessionId}" stays pending: ${String(error)}`)
      }
    }
  }

  /** Put a conversation's archive and pin membership back to what the move recorded. */
  private async restoreRegistryState(sessionId: SessionId, wasArchived: boolean, wasPinned: boolean): Promise<void> {
    const registry = this.ctx.workspaceRegistry
    await this.bestEffort(`restoring archive and pin state of session "${sessionId}"`, async () => {
      if (!wasArchived) await registry.unarchiveSession(sessionId)
      if (wasPinned) await registry.pinSession(sessionId)
    })
  }

  private async bestEffort(what: string, operation: () => Promise<void>): Promise<void> {
    try {
      await operation()
    } catch (error: unknown) {
      this.ctx.logger.warn(`session-trash: ${what} failed: ${String(error)}`)
    }
  }

  private serial<T>(operation: (store: TrashStore) => Promise<T>): Promise<T> {
    const run = async (): Promise<T> => {
      if (this.store === undefined) {
        throw new RemoteError('session-trash/unsupported', this.unsupported ?? 'session trash is not ready', { reason: this.unsupported ?? 'not ready' })
      }
      try {
        return await operation(this.store)
      } catch (error: unknown) {
        throw remoteFailure(error)
      }
    }
    const result = this.tail.then(run, run)
    this.tail = result.catch(() => undefined)
    return result
  }
}

/**
 * The conversation and its subagent descendants by durable lineage, deepest
 * first and the conversation last. Forks carry `parentSession` without the
 * `subagent` origin and stay.
 * @param sessionId - the conversation.
 * @param headers - every stored session header.
 * @returns session ids to move.
 */
export function descendantsFirst(sessionId: SessionId, headers: readonly SessionHeader[]): SessionId[] {
  const children = new Map<SessionId, SessionId[]>()
  for (const header of headers) {
    if (header.origin !== 'subagent' || header.parentSession === undefined) continue
    children.set(header.parentSession, [...children.get(header.parentSession) ?? [], header.id])
  }
  const ordered: SessionId[] = []
  const visited = new Set<SessionId>()
  const visit = (id: SessionId): void => {
    if (visited.has(id)) return
    visited.add(id)
    for (const child of children.get(id) ?? []) visit(child)
    ordered.push(id)
  }
  visit(sessionId)
  return ordered
}

export default SessionTrash
