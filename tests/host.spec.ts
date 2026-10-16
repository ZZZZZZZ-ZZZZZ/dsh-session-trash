/**
 * The trash service over the published DSH 0.2.0-rc.2 packages: real JSONL
 * session storage, real Workspace registry over JSON storage, and the real
 * Typert gateway dispatching the plugin's strict descriptors. Sessions are
 * generated into temporary roots; a "restart" boots a fresh composition over
 * the same directories.
 */

import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import SessionTrash, { encodeSegment } from '../src/index.ts'

// The registry leaves the activity families empty; providers merge their own keys.
declare module '@deepseek-ai/dsh-workspace/types' {
  interface SessionActivityKindMap {
    turn: true
  }
}

const EVENTS = [
  { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
  { type: 'turn/end', seq: SessionSeq(1), time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
] as const

const contexts: Context[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

interface Fixture {
  readonly base: string
  readonly sessions: string
  readonly trash: string
  readonly data: string
  readonly project: string
}

async function fixture(): Promise<Fixture> {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'dsh-session-trash-')))
  dirs.push(base)
  const project = join(base, 'project')
  await mkdir(project)
  return { base, sessions: join(base, 'sessions'), trash: join(base, 'session-trash'), data: join(base, 'data'), project }
}

/** Write one materialized session through a short-lived backend instance. */
async function seed(f: Fixture, id: string, createdAt: number, lineage: Partial<SessionHeader> = {}): Promise<void> {
  const ctx = new Context()
  await ctx.plugin(JsonlSessionPersistence, { root: f.sessions, compression: 'none' })
  const handle = await ctx.sessionPersistence.create({
    version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt, cwd: f.project, isSeeded: false, ...lineage,
  })
  await handle.append([...EVENTS])
  await handle.close()
  await ctx.fiber.dispose()
}

/** One application start: storage, JSONL sessions, Workspace registry, Typert, and the plugin. */
async function boot(f: Fixture, config: { trashDirectory?: string } = { trashDirectory: f.trash }) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Storage)
  await ctx.plugin(StorageJson, { root: f.data })
  await ctx.plugin(StorageDomain, { backend: 'json' })
  await ctx.plugin(JsonlSessionPersistence, { root: f.sessions, compression: 'none' })
  await ctx.plugin(WorkspaceRegistry)
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(TypertGatewayService, {})
  const fiber = ctx.plugin(SessionTrash, config)
  await fiber.await()
  const call = (method: string, args: Record<string, unknown> = {}) =>
    ctx.typertGateway.invoke({ namespace: 'sessionTrash', method, args })
  return { ctx, fiber, registry: ctx.workspaceRegistry, persistence: ctx.sessionPersistence, call }
}

async function restart(f: Fixture, app: Awaited<ReturnType<typeof boot>>) {
  await app.ctx.fiber.dispose()
  contexts.splice(contexts.indexOf(app.ctx), 1)
  return boot(f)
}

async function storedIds(app: Awaited<ReturnType<typeof boot>>): Promise<string[]> {
  return (await app.persistence.list()).map(snapshot => String(snapshot.header.id)).sort()
}

function sessionDir(f: Fixture, id: string): string {
  return join(f.sessions, `--${f.project.replace(/^\//, '').replace(/[\\/:]+/g, '-')}--`, encodeSegment(id))
}

async function moveToTrash(app: Awaited<ReturnType<typeof boot>>, sessionId: string, title = `Title of ${sessionId}`) {
  return await app.call('moveToTrash', { request: { sessionId, title } }) as { entry: { entryId: string; sessionCount: number } }
}

async function entries(app: Awaited<ReturnType<typeof boot>>) {
  return (await app.call('listTrash') as { entries: { entryId: string; sessionId: string; title: string }[] }).entries
}

async function pendingMoves(app: Awaited<ReturnType<typeof boot>>) {
  return (await app.call('listTrash') as { pending: { pendingId: string; sessionId: string; title: string }[] }).pending
}

/**
 * Make DSH hold these sessions open in this run, as a resumed Agent does.
 * @returns the held set; clearing it releases them.
 */
function holdOpen(app: Awaited<ReturnType<typeof boot>>, ...ids: string[]): Set<string> {
  const held = new Set(ids)
  app.ctx.provide('sessions', { get: (id: string) => held.has(id) ? {} : undefined, list: () => [] } as never)
  return held
}

describe('session trash: move, restore, purge', () => {
  it('moves a conversation into the trash, keeps it there across a restart, and restores it', async () => {
    const f = await fixture()
    await seed(f, 'keep', 100)
    await seed(f, 'doomed', 200)
    await writeFile(join(f.project, 'main.py'), 'print("hi")')
    let app = await boot(f)
    const workspace = app.registry.list()[0]!
    await app.registry.pinSession(SessionId('doomed'))
    const removed: string[] = []
    app.ctx.on('api-session/removed', (id) => { removed.push(id) })

    const { entry } = await moveToTrash(app, 'doomed', 'Old chat')
    expect(entry.sessionCount).toBe(1)
    expect(existsSync(sessionDir(f, 'doomed'))).toBe(false)
    expect(existsSync(join(f.trash, entry.entryId, 'entry.json'))).toBe(true)
    expect(await storedIds(app)).toEqual(['keep'])
    expect(app.registry.archivedSessionIds).toEqual(['doomed'])
    expect(app.registry.pinnedSessionIds).toEqual([])
    expect(removed).toEqual(['doomed'])
    expect(await entries(app)).toMatchObject([{ entryId: entry.entryId, sessionId: 'doomed', title: 'Old chat' }])

    app = await restart(f, app)
    expect(await storedIds(app)).toEqual(['keep'])
    expect(await entries(app)).toHaveLength(1)

    expect(await app.call('restore', { request: { entryId: entry.entryId } })).toEqual({ sessionIds: ['doomed'] })
    expect(await storedIds(app)).toEqual(['doomed', 'keep'])
    expect(app.registry.archivedSessionIds).toEqual([])
    expect(app.registry.pinnedSessionIds).toEqual(['doomed'])
    expect([...app.registry.list()[0]!.sessionIds].sort()).toEqual(['doomed', 'keep'])
    expect(await entries(app)).toEqual([])
    expect(await readdir(f.trash)).toEqual([])
    const reader = await app.persistence.open(SessionId('doomed'), 'read')
    expect((await reader.read()).events.map(event => event.seq)).toEqual([0, 1])
    await reader.close()
    expect(await readdir(f.project)).toEqual(['main.py'])
    expect(workspace.id).toBe(app.registry.list()[0]!.id)
  })

  it('reports a restore as done when only the pin could not be put back', async () => {
    const f = await fixture()
    await seed(f, 'pinned', 100)
    const app = await boot(f)
    await app.registry.pinSession(SessionId('pinned'))
    const { entry } = await moveToTrash(app, 'pinned')
    const pin = vi.spyOn(app.registry, 'pinSession').mockRejectedValueOnce(new Error('registry write failed'))
    expect(await app.call('restore', { request: { entryId: entry.entryId } })).toEqual({ sessionIds: ['pinned'] })
    expect(pin).toHaveBeenCalledOnce()
    expect(await storedIds(app)).toEqual(['pinned'])
    expect(await entries(app)).toEqual([])
  })

  it('keeps an archived conversation archived after a restore', async () => {
    const f = await fixture()
    await seed(f, 'archived', 100)
    const app = await boot(f)
    await app.registry.archiveSession(SessionId('archived'))
    const { entry } = await moveToTrash(app, 'archived')
    await app.call('restore', { request: { entryId: entry.entryId } })
    expect(app.registry.archivedSessionIds).toEqual(['archived'])
  })

  it('purges an entry permanently and drops every registry reference; it stays gone after a restart', async () => {
    const f = await fixture()
    await seed(f, 'keep', 100)
    await seed(f, 'doomed', 200)
    let app = await boot(f)
    const { entry } = await moveToTrash(app, 'doomed')

    expect(await app.call('purge', { request: { entryId: entry.entryId } })).toEqual({ sessionIds: ['doomed'] })
    expect(await readdir(f.trash)).toEqual([])
    expect(app.registry.archivedSessionIds).toEqual([])
    expect(await entries(app)).toEqual([])

    app = await restart(f, app)
    expect(await storedIds(app)).toEqual(['keep'])
    expect(app.registry.archivedSessionIds).toEqual([])
    expect(app.registry.list()[0]!.sessionIds).toEqual(['keep'])
    const accounts = JSON.parse(await readFile(join(f.data, 'workspace.json'), 'utf8')) as unknown
    expect(JSON.stringify(accounts)).not.toContain('doomed')
  })

  it('moves subagent sessions with their conversation and leaves forks', async () => {
    const f = await fixture()
    await seed(f, 'parent', 100)
    await seed(f, 'child', 110, { parentSession: SessionId('parent'), origin: 'subagent' })
    await seed(f, 'grandchild', 120, { parentSession: SessionId('child'), origin: 'subagent' })
    await seed(f, 'fork', 130, { parentSession: SessionId('parent') })
    const app = await boot(f)

    const { entry } = await moveToTrash(app, 'parent')
    expect(entry.sessionCount).toBe(3)
    expect(await storedIds(app)).toEqual(['fork'])
    await app.call('restore', { request: { entryId: entry.entryId } })
    expect(await storedIds(app)).toEqual(['child', 'fork', 'grandchild', 'parent'])
  })
})

describe('session trash: refusals change nothing', () => {
  it('refuses a session another process is writing', async () => {
    const f = await fixture()
    await seed(f, 'foreign', 100)
    const app = await boot(f)
    const other = new Context()
    contexts.push(other)
    await other.plugin(JsonlSessionPersistence, { root: f.sessions, compression: 'none' })
    const writer = await other.sessionPersistence.open(SessionId('foreign'), 'write')

    await expect(moveToTrash(app, 'foreign')).rejects.toMatchObject({ code: 'session-trash/session-in-use', details: { sessionId: 'foreign' } })
    expect(await storedIds(app)).toEqual(['foreign'])
    expect(app.registry.archivedSessionIds).toEqual([])
    expect(existsSync(f.trash) ? await readdir(f.trash) : []).toEqual([])

    await writer.close()
    await moveToTrash(app, 'foreign')
    expect(await storedIds(app)).toEqual([])
  })

  it('still refuses a session that is open and running work', async () => {
    const f = await fixture()
    await seed(f, 'busy-open', 100)
    const app = await boot(f)
    holdOpen(app, 'busy-open')
    app.ctx.on('workspace/session-activity', async (_request, next) => [{ kind: 'turn' }, ...await next()])
    await expect(moveToTrash(app, 'busy-open')).rejects.toMatchObject({ code: 'session-trash/session-active' })
    expect(app.registry.archivedSessionIds).toEqual([])
    expect(await pendingMoves(app)).toEqual([])
  })

  it('refuses a session with running work', async () => {
    const f = await fixture()
    await seed(f, 'busy', 100)
    const app = await boot(f)
    app.ctx.on('workspace/session-activity', async (_request, next) => [{ kind: 'turn' }, ...await next()])
    await expect(moveToTrash(app, 'busy')).rejects.toMatchObject({
      code: 'session-trash/session-active', details: { sessionId: 'busy', activity: ['turn'] },
    })
    expect(await storedIds(app)).toEqual(['busy'])
    expect(app.registry.archivedSessionIds).toEqual([])
  })

  it('refuses a session directory holding a file the backend did not write, and undoes the archive', async () => {
    const f = await fixture()
    await seed(f, 'mixed', 100)
    const app = await boot(f)
    await writeFile(join(sessionDir(f, 'mixed'), 'notes.txt'), 'user data')
    await expect(moveToTrash(app, 'mixed')).rejects.toMatchObject({ code: 'session-trash/refused' })
    expect(await readdir(sessionDir(f, 'mixed'))).toContain('notes.txt')
    expect(await storedIds(app)).toEqual(['mixed'])
    expect(app.registry.archivedSessionIds).toEqual([])
  })

  it('refuses to purge an entry holding an unexpected file, deleting nothing', async () => {
    const f = await fixture()
    await seed(f, 'doomed', 100)
    const app = await boot(f)
    const { entry } = await moveToTrash(app, 'doomed')
    await writeFile(join(f.trash, entry.entryId, 'stray.txt'), 'x')
    await expect(app.call('purge', { request: { entryId: entry.entryId } })).rejects.toMatchObject({ code: 'session-trash/refused' })
    expect(await entries(app)).toHaveLength(1)
  })

  it('refuses a restore when the session already exists again', async () => {
    const f = await fixture()
    await seed(f, 'twice', 100)
    const app = await boot(f)
    const { entry } = await moveToTrash(app, 'twice')
    await seed(f, 'twice', 300)
    await expect(app.call('restore', { request: { entryId: entry.entryId } }))
      .rejects.toMatchObject({ code: 'session-trash/restore-conflict' })
    expect(await entries(app)).toHaveLength(1)
  })

  it('rejects unknown sessions and malformed entry ids at the wire', async () => {
    const f = await fixture()
    await seed(f, 'keep', 100)
    const app = await boot(f)
    await expect(moveToTrash(app, 'ghost')).rejects.toMatchObject({ code: 'session-trash/not-found' })
    await expect(app.call('purge', { request: { entryId: '../sessions' } })).rejects.toThrow()
    await expect(app.call('purge', { request: { entryId: '00000000-0000-4000-8000-000000000000' } }))
      .rejects.toMatchObject({ code: 'session-trash/not-found' })
    await expect(app.call('moveToTrash', { request: { sessionId: 'keep' } })).rejects.toThrow()
    expect(await storedIds(app)).toEqual(['keep'])
  })

  it('refuses to load with a trash directory inside the session root', async () => {
    const f = await fixture()
    const ctx = new Context()
    contexts.push(ctx)
    await expect(boot(f, { trashDirectory: join(f.sessions, 'trash') })).rejects.toThrow(/outside the session root/)
    await ctx.fiber.dispose()
  })
})

describe('session trash: sessions DSH holds open are moved at the next start', () => {
  it('hides an open session now and moves it into the trash at the next start; a restore undoes it all', async () => {
    const f = await fixture()
    await seed(f, 'keep', 100)
    await seed(f, 'open', 200)
    let app = await boot(f)
    await app.registry.pinSession(SessionId('open'))
    holdOpen(app, 'open')

    const result = await app.call('moveToTrash', { request: { sessionId: 'open', title: 'Open chat' } }) as { pending: { pendingId: string } }
    expect(result.pending.pendingId).toMatch(/^[0-9a-f-]{36}$/)
    // Hidden now, files untouched.
    expect(app.registry.archivedSessionIds).toEqual(['open'])
    expect(app.registry.pinnedSessionIds).toEqual([])
    expect(existsSync(sessionDir(f, 'open'))).toBe(true)
    expect(await pendingMoves(app)).toMatchObject([{ sessionId: 'open', title: 'Open chat' }])
    expect(await entries(app)).toEqual([])
    // Asking again keeps the one pending move.
    const again = await app.call('moveToTrash', { request: { sessionId: 'open', title: 'Open chat' } }) as { pending: { pendingId: string } }
    expect(again.pending.pendingId).toBe(result.pending.pendingId)

    app = await restart(f, app)
    expect(existsSync(sessionDir(f, 'open'))).toBe(false)
    expect(await storedIds(app)).toEqual(['keep'])
    expect(await pendingMoves(app)).toEqual([])
    const [entry] = await entries(app)
    expect(entry).toMatchObject({ sessionId: 'open', title: 'Open chat' })

    await app.call('restore', { request: { entryId: entry!.entryId } })
    expect(await storedIds(app)).toEqual(['keep', 'open'])
    expect(app.registry.archivedSessionIds).toEqual([])
    expect(app.registry.pinnedSessionIds).toEqual(['open'])
  })

  it('cancels a pending move and puts the archive and pin state back', async () => {
    const f = await fixture()
    await seed(f, 'open', 100)
    let app = await boot(f)
    await app.registry.pinSession(SessionId('open'))
    holdOpen(app, 'open')
    const { pending } = await app.call('moveToTrash', { request: { sessionId: 'open', title: 'Open chat' } }) as { pending: { pendingId: string } }

    expect(await app.call('cancelPending', { request: { pendingId: pending.pendingId } })).toEqual({ sessionId: 'open' })
    expect(app.registry.archivedSessionIds).toEqual([])
    expect(app.registry.pinnedSessionIds).toEqual(['open'])
    expect(await pendingMoves(app)).toEqual([])
    await expect(app.call('cancelPending', { request: { pendingId: pending.pendingId } }))
      .rejects.toMatchObject({ code: 'session-trash/not-found' })

    app = await restart(f, app)
    expect(await storedIds(app)).toEqual(['open'])
  })

  it('keeps a pending move while another process holds the session, and finishes it at a later start', async () => {
    const f = await fixture()
    await seed(f, 'held', 100)
    let app = await boot(f)
    holdOpen(app, 'held')
    await app.call('moveToTrash', { request: { sessionId: 'held', title: 'Held' } })
    const other = new Context()
    contexts.push(other)
    await other.plugin(JsonlSessionPersistence, { root: f.sessions, compression: 'none' })
    const writer = await other.sessionPersistence.open(SessionId('held'), 'write')

    app = await restart(f, app)
    expect(await storedIds(app)).toEqual(['held'])
    expect(await pendingMoves(app)).toHaveLength(1)
    expect(app.registry.archivedSessionIds).toEqual(['held'])

    await writer.close()
    app = await restart(f, app)
    expect(await storedIds(app)).toEqual([])
    expect(await pendingMoves(app)).toEqual([])
    expect(await entries(app)).toHaveLength(1)
  })

  it('moves a pending session right away when it is no longer held, without waiting for a restart', async () => {
    const f = await fixture()
    await seed(f, 'open', 100)
    const app = await boot(f)
    const held = holdOpen(app, 'open')
    await app.call('moveToTrash', { request: { sessionId: 'open', title: 'Open chat' } })
    held.clear()
    const moved = await moveToTrash(app, 'open')
    expect(moved.entry.sessionCount).toBe(1)
    expect(await pendingMoves(app)).toEqual([])
    await app.call('restore', { request: { entryId: moved.entry.entryId } })
    // The state before the first request comes back, not the archive the pending move made.
    expect(app.registry.archivedSessionIds).toEqual([])
  })

  it('drops a pending move whose session no longer exists', async () => {
    const f = await fixture()
    await seed(f, 'vanished', 100)
    let app = await boot(f)
    holdOpen(app, 'vanished')
    await app.call('moveToTrash', { request: { sessionId: 'vanished', title: 'Gone' } })
    await rm(sessionDir(f, 'vanished'), { recursive: true })
    app = await restart(f, app)
    expect(await pendingMoves(app)).toEqual([])
    expect(await entries(app)).toEqual([])
  })
})

describe('session trash: crash recovery', () => {
  it('removes a staging directory a crash left before anything moved', async () => {
    const f = await fixture()
    await seed(f, 'kept', 100)
    const half = join(f.trash, '.staging-11111111-2222-4333-8444-555555555555')
    const empty = join(f.trash, '.staging-66666666-7777-4888-8999-000000000000')
    await mkdir(half, { recursive: true })
    await mkdir(empty, { recursive: true })
    await writeFile(join(half, 'entry.json'), '{"version":1,"entr')
    const app = await boot(f)
    expect(await readdir(f.trash)).toEqual([])
    expect(await storedIds(app)).toEqual(['kept'])
  })

  it('keeps a staging directory that holds anything besides a manifest', async () => {
    const f = await fixture()
    await seed(f, 'kept', 100)
    const odd = join(f.trash, '.staging-11111111-2222-4333-8444-555555555555')
    await mkdir(join(odd, 'something'), { recursive: true })
    await boot(f)
    expect(await readdir(f.trash)).toEqual(['.staging-11111111-2222-4333-8444-555555555555'])
  })

  it('rolls an interrupted move back at the next start', async () => {
    const f = await fixture()
    await seed(f, 'interrupted', 100)
    let app = await boot(f)
    const { entry } = await moveToTrash(app, 'interrupted')
    // Turn the published entry back into the staging state a crash would leave.
    await rename(join(f.trash, entry.entryId), join(f.trash, `.staging-${entry.entryId}`))
    app = await restart(f, app)
    expect(await storedIds(app)).toEqual(['interrupted'])
    expect(await readdir(f.trash)).toEqual([])
  })
})
