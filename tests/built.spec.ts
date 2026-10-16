/**
 * The published artifacts: `lib/index.js` as the Host Loader would import it,
 * and `lib/client.js` evaluated the way the page's module loader evaluates a
 * plugin bundle. Run after `pnpm run build`.
 */

import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Storage from '@deepseek-ai/dsh-storage'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'

const LIB = new URL('../lib/', import.meta.url)
const contexts: Context[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe.skipIf(!existsSync(new URL('index.js', LIB)))('built artifacts', () => {
  it('lib/index.js moves and restores a session through the Typert gateway', async () => {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'dsh-session-trash-built-')))
    dirs.push(base)
    const project = join(base, 'project')
    await mkdir(project)
    const sessions = join(base, 'sessions')

    const seed = new Context()
    await seed.plugin(JsonlSessionPersistence, { root: sessions, compression: 'none' })
    const handle = await seed.sessionPersistence.create({
      version: SESSION_FORMAT_VERSION, id: SessionId('built'), createdAt: 1, cwd: project, isSeeded: false,
    })
    await handle.append([
      { type: 'turn/start', seq: SessionSeq(0), time: 1, data: { turn: 1 } },
      { type: 'turn/end', seq: SessionSeq(1), time: 2, data: { turn: 1, reason: { kind: 'completed' } } },
    ])
    await handle.close()
    await seed.fiber.dispose()

    // The artifact exports the same class the source does; the source type stands in for its declarations.
    const built = await import(new URL('index.js', LIB).href) as typeof import('../src/index.ts')
    const ctx = new Context()
    contexts.push(ctx)
    await ctx.plugin(Storage)
    await ctx.plugin(StorageJson, { root: join(base, 'data') })
    await ctx.plugin(StorageDomain, { backend: 'json' })
    await ctx.plugin(JsonlSessionPersistence, { root: sessions, compression: 'none' })
    await ctx.plugin(WorkspaceRegistry)
    await ctx.plugin(TypertRegistry)
    await ctx.plugin(TypertGatewayService, {})
    await ctx.plugin(built.default, { trashDirectory: join(base, 'trash') }).await()

    const call = (method: string, args: Record<string, unknown> = {}) =>
      ctx.typertGateway.invoke({ namespace: 'sessionTrash', method, args })
    const moved = await call('moveToTrash', { request: { sessionId: 'built', title: 'Built' } }) as { entry: { entryId: string } }
    expect((await ctx.sessionPersistence.list()).length).toBe(0)
    await call('restore', { request: { entryId: moved.entry.entryId } })
    expect((await ctx.sessionPersistence.list()).map(snapshot => snapshot.header.id)).toEqual(['built'])
  })

  it('lib/client.js registers through the page module loader and requires only page modules', async () => {
    const source = await readFile(new URL('client.js', LIB), 'utf8')
    const pageModules = new Set([
      'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-ui-primitives',
    ])
    const requested: string[] = []
    const nodeRequire = createRequire(import.meta.url)
    let registered: { id: string; factory: (require: (id: string) => unknown) => Record<string, unknown> } | undefined
    runInNewContext(source, { window: { __ModuleLoader__: { load: (row: typeof registered) => { registered = row } } } })
    expect(registered?.id).toBe('dsh-plugin-session-trash')
    const exports = registered!.factory((id) => {
      requested.push(id)
      if (!pageModules.has(id)) throw new Error(`not a page module: ${id}`)
      return id === '@deepseek-ai/dsh-client-ui-primitives' ? {} : nodeRequire(id)
    })
    expect(exports.name).toBe('dsh-plugin-session-trash/client')
    expect(exports.inject).toEqual(['slots', 'locale', 'remote'])
    expect(typeof exports.apply).toBe('function')
    expect(requested.every(id => pageModules.has(id))).toBe(true)
  })
})
