/**
 * Filesystem side of the session trash, independent of Cordis.
 *
 * Layout. The JSONL backend stores one session per directory
 * `<sessionRoot>/<project>/<encoded-id>/`. A trash entry is
 * `<trashRoot>/<entryId>/` holding `entry.json` plus each moved session
 * directory at the same relative path `<project>/<encoded-id>`. A move first
 * builds `<trashRoot>/.staging-<entryId>/` and publishes it with one rename,
 * so a crash leaves either a staging directory (rolled back at the next start)
 * or a complete entry.
 *
 * Safety rules every operation follows:
 * - Paths are derived, never taken from the caller: an entry id must be a UUID
 *   and manifest segments must be single path segments.
 * - A session directory and every path above it up to the configured root must
 *   be a plain directory (no symbolic link) and resolve inside that root.
 * - A session directory may contain only files the JSONL backend writes
 *   (canonical generations, its publish temporaries, `session.lock`); any other
 *   entry refuses the operation before anything changes.
 * - Moves use `rename(2)` only; a cross-device trash refuses instead of copying.
 * - A move holds each session's `session.lock` with a non-blocking `flock(2)`,
 *   so a session another writer (this process or another) holds is refused.
 * - Permanent deletion unlinks the classified files one by one and removes
 *   directories with non-recursive `rmdir`; nothing uses recursive removal.
 */

import { randomUUID } from 'node:crypto'
import type { FileHandle } from 'node:fs/promises'
import { lstat, mkdir, open, readdir, readFile, realpath, rename, rmdir, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

/** Name of the manifest inside a trash entry. */
export const MANIFEST = 'entry.json'
const MANIFEST_VERSION = 1
const LOCK = 'session.lock'
const STAGING_PREFIX = '.staging-'
const PENDING_FILE = /^\.pending-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/
const GENERATION = /^session(?:\.v[1-9][0-9]*)?\.jsonl(?:\.zstd)?$/
const PUBLISH_TEMPORARY = /^session(?:\.v[1-9][0-9]*)?\.jsonl(?:\.zstd)?\.[0-9a-f]{12}\.tmp$/
const MIGRATION_TEMPORARY = /^session\.migration\.[0-9a-f]{16}\.jsonl(?:\.zstd)?\.tmp$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Why an operation stopped before changing anything. */
export type TrashFailureKind = 'not-found' | 'in-use' | 'refused' | 'restore-conflict'

/** A refusal that left the session root and the trash unchanged. */
export class TrashStoreError extends Error {
  /**
   * @param kind - failure class the service maps to a Remote code.
   * @param subject - the session or entry id the failure names.
   * @param message - human-readable reason.
   */
  constructor(readonly kind: TrashFailureKind, readonly subject: string, message: string) {
    super(message)
    this.name = 'TrashStoreError'
  }
}

/** One session directory recorded in a manifest, relative to the session root. */
export interface ManifestSession {
  readonly sessionId: string
  readonly project: string
  readonly dirName: string
}

/** Contents of `entry.json`. */
export interface TrashManifest {
  readonly version: typeof MANIFEST_VERSION
  readonly entryId: string
  readonly sessionId: string
  readonly title: string
  readonly cwd?: string
  readonly deletedAt: number
  readonly wasArchived: boolean
  readonly wasPinned: boolean
  /** Subagent descendants first, the conversation itself last. */
  readonly sessions: readonly ManifestSession[]
}

/** A listed entry: its manifest plus the bytes it holds. */
export interface TrashEntry {
  readonly manifest: TrashManifest
  readonly sizeBytes: number
}

/**
 * A move DSH could not take yet because it held the conversation open: the
 * conversation is archived and moves at the next start. Stored as
 * `<trashRoot>/.pending-<pendingId>.json`.
 */
export interface PendingRecord {
  readonly version: typeof MANIFEST_VERSION
  readonly pendingId: string
  readonly sessionId: string
  readonly title: string
  readonly cwd?: string
  readonly requestedAt: number
  /** Archive and pin membership before the request archived the conversation. */
  readonly wasArchived: boolean
  readonly wasPinned: boolean
}

/** Facts recorded with a pending move. */
export type PendingInput = Omit<PendingRecord, 'version' | 'pendingId' | 'requestedAt'>

function parsePending(value: unknown, pendingId: string): PendingRecord {
  const bad = (reason: string): never => {
    throw new TrashStoreError('refused', pendingId, `pending move "${pendingId}" is invalid: ${reason}`)
  }
  if (typeof value !== 'object' || value === null) return bad('not an object')
  const body = value as Record<string, unknown>
  if (body.version !== MANIFEST_VERSION || body.pendingId !== pendingId) return bad('version or id')
  if (typeof body.sessionId !== 'string' || body.sessionId === '' || typeof body.title !== 'string' || body.title === '') return bad('session')
  if (body.cwd !== undefined && typeof body.cwd !== 'string') return bad('cwd')
  if (typeof body.requestedAt !== 'number' || !Number.isSafeInteger(body.requestedAt)) return bad('requestedAt')
  if (typeof body.wasArchived !== 'boolean' || typeof body.wasPinned !== 'boolean') return bad('flags')
  return {
    version: MANIFEST_VERSION, pendingId, sessionId: body.sessionId, title: body.title,
    ...body.cwd === undefined ? {} : { cwd: body.cwd },
    requestedAt: body.requestedAt, wasArchived: body.wasArchived, wasPinned: body.wasPinned,
  }
}

/** Facts recorded with a move. */
export interface MoveInput {
  readonly sessionId: string
  readonly title: string
  readonly cwd?: string
  readonly wasArchived: boolean
  readonly wasPinned: boolean
  /** Session ids to move, subagent descendants first and `sessionId` last. */
  readonly sessionIds: readonly string[]
}

/** Lock primitive: resolve when the descriptor holds an exclusive lock, reject with EAGAIN/EWOULDBLOCK on contention. */
export type TryLock = (fd: number) => Promise<void>

/**
 * Encode a session id into the JSONL backend's directory segment, matching
 * `encodeSegment` in `@deepseek-ai/dsh-session-persistence-jsonl` (MIT): safe
 * code units stay literal, `.`/`..` and every other unit become `~XXXX`.
 * @param raw - session id.
 * @returns the single path segment.
 */
export function encodeSegment(raw: string): string {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    out += ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch) ? ch : `~${code.toString(16).toUpperCase().padStart(4, '0')}`
  }
  return out
}

function isSegment(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && value !== '.' && value !== '..'
    && !value.includes('/') && !value.includes('\\') && !value.includes('\0')
}

function isErrno(error: unknown, ...codes: string[]): boolean {
  return codes.includes((error as NodeJS.ErrnoException | null)?.code ?? '')
}

/** Whether `child` is strictly inside `parent` (both absolute). */
function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * Check that the session root and the trash root are absolute, distinct, and
 * neither contains the other. The JSONL backend treats every directory under
 * its root as a project directory, so a trash inside it would make trashed
 * sessions visible again.
 * @param sessionRoot - the JSONL backend's configured root.
 * @param trashRoot - the trash directory.
 */
export function assertRoots(sessionRoot: string, trashRoot: string): void {
  if (!isAbsolute(sessionRoot) || !isAbsolute(trashRoot)) throw new Error('session-trash: both roots must be absolute paths')
  const session = resolve(sessionRoot)
  const trash = resolve(trashRoot)
  if (session === trash || isInside(session, trash) || isInside(trash, session)) {
    throw new Error(`session-trash: trash directory "${trash}" must be outside the session root "${session}" and must not contain it`)
  }
}

/** Classify one session directory's entries; reject anything the backend does not write. */
async function classifySessionDirectory(dir: string, subject: string): Promise<{ files: string[]; hasGeneration: boolean }> {
  const files: string[] = []
  let hasGeneration = false
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isFile()) {
      throw new TrashStoreError('refused', subject, `unexpected non-file entry "${entry.name}" in "${dir}"`)
    }
    if (GENERATION.test(entry.name)) hasGeneration = true
    else if (entry.name !== LOCK && !PUBLISH_TEMPORARY.test(entry.name) && !MIGRATION_TEMPORARY.test(entry.name)) {
      throw new TrashStoreError('refused', subject, `unexpected entry "${entry.name}" in "${dir}"`)
    }
    files.push(join(dir, entry.name))
  }
  return { files, hasGeneration }
}

/** Require `path` and every directory between it and `base` to be plain directories inside `base`. */
async function assertPlainDirectories(base: string, path: string, subject: string): Promise<void> {
  if (!isInside(base, path)) throw new TrashStoreError('refused', subject, `"${path}" is outside "${base}"`)
  let current = path
  while (current !== base) {
    const info = await lstat(current)
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new TrashStoreError('refused', subject, `"${current}" is not a plain directory`)
    }
    current = dirname(current)
  }
  const [realBase, realPath] = await Promise.all([realpath(base), realpath(path)])
  if (!isInside(realBase, realPath)) throw new TrashStoreError('refused', subject, `"${path}" resolves outside "${base}"`)
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error: unknown) {
    if (isErrno(error, 'ENOENT')) return false
    throw error
  }
}

async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return
  const handle = await open(path, 'r')
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function parseManifest(value: unknown, entryId: string): TrashManifest {
  const bad = (reason: string): never => {
    throw new TrashStoreError('refused', entryId, `trash entry "${entryId}" has an invalid manifest: ${reason}`)
  }
  if (typeof value !== 'object' || value === null) return bad('not an object')
  const body = value as Record<string, unknown>
  if (body.version !== MANIFEST_VERSION) return bad(`unsupported version ${String(body.version)}`)
  if (body.entryId !== entryId) return bad('entry id mismatch')
  if (typeof body.sessionId !== 'string' || body.sessionId === '') return bad('sessionId')
  if (typeof body.title !== 'string' || body.title === '') return bad('title')
  if (body.cwd !== undefined && typeof body.cwd !== 'string') return bad('cwd')
  if (typeof body.deletedAt !== 'number' || !Number.isSafeInteger(body.deletedAt)) return bad('deletedAt')
  if (typeof body.wasArchived !== 'boolean' || typeof body.wasPinned !== 'boolean') return bad('flags')
  if (!Array.isArray(body.sessions) || body.sessions.length === 0) return bad('sessions')
  const sessions = body.sessions.map((item: unknown): ManifestSession => {
    const session = item as Record<string, unknown> | null
    if (typeof session !== 'object' || session === null || typeof session.sessionId !== 'string'
      || !isSegment(session.project) || session.dirName !== encodeSegment(session.sessionId)) {
      return bad('session record')
    }
    return { sessionId: session.sessionId, project: session.project, dirName: session.dirName }
  })
  if (sessions[sessions.length - 1]?.sessionId !== body.sessionId) return bad('the conversation must be the last session')
  return {
    version: MANIFEST_VERSION,
    entryId,
    sessionId: body.sessionId,
    title: body.title,
    ...body.cwd === undefined ? {} : { cwd: body.cwd },
    deletedAt: body.deletedAt,
    wasArchived: body.wasArchived,
    wasPinned: body.wasPinned,
    sessions,
  }
}

/** Filesystem operations over one session root and one trash root. */
export class TrashStore {
  readonly sessionRoot: string
  readonly trashRoot: string

  /**
   * @param sessionRoot - the JSONL backend's root directory.
   * @param trashRoot - directory holding trash entries; created on first move.
   * @param tryLock - exclusive non-blocking lock on a file descriptor.
   * @param now - clock for `deletedAt`.
   */
  constructor(sessionRoot: string, trashRoot: string, private readonly tryLock: TryLock, private readonly now: () => number = Date.now) {
    assertRoots(sessionRoot, trashRoot)
    this.sessionRoot = resolve(sessionRoot)
    this.trashRoot = resolve(trashRoot)
  }

  /**
   * Find the one directory that stores a session.
   * @param sessionId - the session.
   * @returns its project segment and absolute directory, or `undefined` when no log exists.
   */
  async locate(sessionId: string): Promise<{ project: string; dir: string } | undefined> {
    const dirName = encodeSegment(sessionId)
    const matches: { project: string; dir: string }[] = []
    let projects: string[]
    try {
      projects = (await readdir(this.sessionRoot, { withFileTypes: true }))
        .filter(entry => entry.isDirectory()).map(entry => entry.name)
    } catch (error: unknown) {
      if (isErrno(error, 'ENOENT')) return undefined
      throw error
    }
    for (const project of projects) {
      const dir = join(this.sessionRoot, project, dirName)
      if (await exists(dir)) matches.push({ project, dir })
    }
    if (matches.length > 1) {
      throw new TrashStoreError('refused', sessionId, `session "${sessionId}" appears in several project directories`)
    }
    return matches[0]
  }

  /**
   * Move a conversation and its subagent sessions into a new trash entry.
   * Every session is located, classified, and locked before the first rename;
   * a failure after that renames the moved directories back.
   * @param input - what to move and the facts a restore needs.
   * @returns the published entry.
   */
  async moveToTrash(input: MoveInput): Promise<TrashEntry> {
    if (input.sessionIds[input.sessionIds.length - 1] !== input.sessionId) {
      throw new Error('session-trash: the conversation must be the last session to move')
    }
    const planned: { session: ManifestSession; dir: string; lock: FileHandle }[] = []
    try {
      for (const sessionId of input.sessionIds) {
        const found = await this.locate(sessionId)
        if (found === undefined) {
          if (sessionId === input.sessionId) throw new TrashStoreError('not-found', sessionId, `session "${sessionId}" has no stored log`)
          continue
        }
        await assertPlainDirectories(this.sessionRoot, found.dir, sessionId)
        const { hasGeneration } = await classifySessionDirectory(found.dir, sessionId)
        if (!hasGeneration) throw new TrashStoreError('refused', sessionId, `"${found.dir}" holds no session log`)
        const lock = await this.lock(found.dir, sessionId)
        planned.push({ session: { sessionId, project: found.project, dirName: encodeSegment(sessionId) }, dir: found.dir, lock })
      }
      await mkdir(this.trashRoot, { recursive: true, mode: 0o700 })
      await this.assertTrashRoot()
      await this.assertSameDevice(input.sessionId)

      const entryId = randomUUID()
      const staging = join(this.trashRoot, `${STAGING_PREFIX}${entryId}`)
      const manifest: TrashManifest = {
        version: MANIFEST_VERSION,
        entryId,
        sessionId: input.sessionId,
        title: input.title,
        ...input.cwd === undefined ? {} : { cwd: input.cwd },
        deletedAt: this.now(),
        wasArchived: input.wasArchived,
        wasPinned: input.wasPinned,
        sessions: planned.map(item => item.session),
      }
      await mkdir(staging, { mode: 0o700 })
      await writeFile(join(staging, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
      const moved: { from: string; to: string }[] = []
      const published = join(this.trashRoot, entryId)
      try {
        for (const item of planned) {
          const target = join(staging, item.session.project, item.session.dirName)
          await mkdir(dirname(target), { recursive: true, mode: 0o700 })
          await rename(item.dir, target)
          moved.push({ from: item.dir, to: target })
        }
        // The entry becomes visible, and the move final, at this rename.
        await rename(staging, published)
      } catch (error: unknown) {
        for (const item of moved.reverse()) await rename(item.to, item.from)
        await this.removeStagingShell(staging, manifest)
        throw error
      }
      await syncDirectory(this.trashRoot)
      return { manifest, sizeBytes: await this.entrySize(published, manifest) }
    } finally {
      for (const item of planned) await item.lock.close()
    }
  }

  /**
   * Read every published entry, newest first. An entry whose manifest cannot
   * be read is skipped and reported through `onInvalid`.
   * @param onInvalid - receives each unreadable entry and its error.
   * @returns the entries.
   */
  async list(onInvalid: (entryId: string, error: unknown) => void = () => {}): Promise<TrashEntry[]> {
    let names: string[]
    try {
      names = (await readdir(this.trashRoot, { withFileTypes: true }))
        .filter(entry => entry.isDirectory() && UUID.test(entry.name)).map(entry => entry.name)
    } catch (error: unknown) {
      if (isErrno(error, 'ENOENT')) return []
      throw error
    }
    const entries: TrashEntry[] = []
    for (const entryId of names) {
      try {
        const dir = join(this.trashRoot, entryId)
        const manifest = await this.readManifest(dir, entryId)
        entries.push({ manifest, sizeBytes: await this.entrySize(dir, manifest) })
      } catch (error: unknown) {
        onInvalid(entryId, error)
      }
    }
    return entries.sort((left, right) => right.manifest.deletedAt - left.manifest.deletedAt)
  }

  /**
   * Read one published entry's manifest.
   * @param entryId - the entry.
   * @returns its manifest.
   */
  async manifest(entryId: string): Promise<TrashManifest> {
    return this.readManifest(await this.entryDir(entryId), entryId)
  }

  /**
   * Move an entry's sessions back to their recorded places and remove the
   * entry. Every destination is checked before the first rename; a session
   * already back in place (an interrupted earlier restore) is skipped.
   * @param entryId - the entry.
   * @returns the entry's manifest.
   */
  async restore(entryId: string): Promise<TrashManifest> {
    const dir = await this.entryDir(entryId)
    const manifest = await this.readManifest(dir, entryId)
    const plan: { from: string; to: string }[] = []
    for (const session of manifest.sessions) {
      const from = join(dir, session.project, session.dirName)
      const to = join(this.sessionRoot, session.project, session.dirName)
      const held = await exists(from)
      const occupied = await exists(to)
      if (held && occupied) {
        throw new TrashStoreError('restore-conflict', session.sessionId, `"${to}" already exists`)
      }
      if (!held) {
        if (occupied) continue
        throw new TrashStoreError('refused', entryId, `trash entry "${entryId}" is missing session "${session.sessionId}"`)
      }
      await assertPlainDirectories(this.trashRoot, from, entryId)
      await classifySessionDirectory(from, entryId)
      plan.push({ from, to })
    }
    await mkdir(this.sessionRoot, { recursive: true, mode: 0o700 })
    const moved: { from: string; to: string }[] = []
    try {
      for (const item of plan) {
        await mkdir(dirname(item.to), { recursive: true, mode: 0o700 })
        await assertPlainDirectories(this.sessionRoot, dirname(item.to), entryId)
        await rename(item.from, item.to)
        moved.push(item)
      }
    } catch (error: unknown) {
      for (const item of moved.reverse()) await rename(item.to, item.from)
      throw error
    }
    await this.removeEntryShell(dir, manifest)
    return manifest
  }

  /**
   * Permanently delete an entry. Every file is classified before the first
   * unlink; an unrecognized file refuses the purge with nothing removed.
   * @param entryId - the entry.
   * @returns the entry's manifest.
   */
  async purge(entryId: string): Promise<TrashManifest> {
    const dir = await this.entryDir(entryId)
    const manifest = await this.readManifest(dir, entryId)
    const sessionDirs: { dir: string; files: string[] }[] = []
    for (const session of manifest.sessions) {
      const sessionDir = join(dir, session.project, session.dirName)
      if (!await exists(sessionDir)) continue
      await assertPlainDirectories(this.trashRoot, sessionDir, entryId)
      sessionDirs.push({ dir: sessionDir, files: (await classifySessionDirectory(sessionDir, entryId)).files })
    }
    await this.assertEntryHoldsOnly(dir, manifest)
    for (const item of sessionDirs) {
      for (const file of item.files) await unlink(file)
      await rmdir(item.dir)
    }
    await this.removeEntryShell(dir, manifest)
    return manifest
  }

  /**
   * Roll back moves a crash interrupted: every staging directory's sessions go
   * back to their recorded places when those are free, then the staging
   * directory is removed. A staging directory that cannot be rolled back
   * cleanly is left in place and reported.
   * @param report - receives each staging directory that needs attention.
   * @returns how many staging directories were rolled back.
   */
  async recoverStaging(report: (path: string, error: unknown) => void): Promise<number> {
    let names: string[]
    try {
      names = (await readdir(this.trashRoot)).filter(name => name.startsWith(STAGING_PREFIX))
    } catch (error: unknown) {
      if (isErrno(error, 'ENOENT')) return 0
      throw error
    }
    let recovered = 0
    for (const name of names) {
      const staging = join(this.trashRoot, name)
      const entryId = name.slice(STAGING_PREFIX.length)
      try {
        if (!UUID.test(entryId)) throw new Error('not a staging directory this plugin created')
        const manifest = await this.readManifest(staging, entryId)
        for (const session of manifest.sessions) {
          const from = join(staging, session.project, session.dirName)
          const to = join(this.sessionRoot, session.project, session.dirName)
          if (!await exists(from)) continue
          if (await exists(to)) throw new Error(`"${to}" exists; both copies kept`)
          await assertPlainDirectories(this.trashRoot, from, entryId)
          await mkdir(dirname(to), { recursive: true, mode: 0o700 })
          await rename(from, to)
        }
        await this.removeStagingShell(staging, manifest)
        recovered += 1
      } catch (error: unknown) {
        if (await this.removeEmptyStaging(staging)) recovered += 1
        else report(staging, error)
      }
    }
    return recovered
  }

  /**
   * Remove a staging directory a crash left before any session moved into it:
   * it holds nothing, or only a (possibly partial) manifest. Anything else stays.
   * @returns whether the directory was removed.
   */
  private async removeEmptyStaging(staging: string): Promise<boolean> {
    const info = await lstat(staging)
    if (info.isSymbolicLink() || !info.isDirectory()) return false
    const entries = await readdir(staging, { withFileTypes: true })
    if (entries.some(entry => entry.name !== MANIFEST || !entry.isFile())) return false
    if (entries.length > 0) await unlink(join(staging, MANIFEST))
    await rmdir(staging)
    return true
  }

  /**
   * Record a pending move. A conversation already pending keeps its first
   * record, so a repeated request changes nothing.
   * @param input - the conversation and its state before it was archived.
   * @returns the record now on disk.
   */
  async addPending(input: PendingInput): Promise<PendingRecord> {
    const existing = (await this.listPending()).find(record => record.sessionId === input.sessionId)
    if (existing !== undefined) return existing
    await mkdir(this.trashRoot, { recursive: true, mode: 0o700 })
    await this.assertTrashRoot()
    const record: PendingRecord = {
      version: MANIFEST_VERSION, pendingId: randomUUID(), sessionId: input.sessionId, title: input.title,
      ...input.cwd === undefined ? {} : { cwd: input.cwd },
      requestedAt: this.now(), wasArchived: input.wasArchived, wasPinned: input.wasPinned,
    }
    const path = join(this.trashRoot, `.pending-${record.pendingId}.json`)
    const temporary = `${path}.tmp`
    await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    await rename(temporary, path)
    await syncDirectory(this.trashRoot)
    return record
  }

  /**
   * Read every pending move, newest first. An unreadable record is skipped
   * and reported through `onInvalid`.
   * @param onInvalid - receives each unreadable record and its error.
   * @returns the records.
   */
  async listPending(onInvalid: (pendingId: string, error: unknown) => void = () => {}): Promise<PendingRecord[]> {
    let names: string[]
    try {
      names = await readdir(this.trashRoot)
    } catch (error: unknown) {
      if (isErrno(error, 'ENOENT')) return []
      throw error
    }
    const records: PendingRecord[] = []
    for (const name of names) {
      const pendingId = PENDING_FILE.exec(name)?.[1]
      if (pendingId === undefined) continue
      try {
        records.push(await this.readPending(pendingId))
      } catch (error: unknown) {
        onInvalid(pendingId, error)
      }
    }
    return records.sort((left, right) => right.requestedAt - left.requestedAt)
  }

  /**
   * Remove one pending move's record.
   * @param pendingId - the record.
   * @returns the removed record.
   */
  async removePending(pendingId: string): Promise<PendingRecord> {
    const record = await this.readPending(pendingId)
    await unlink(this.pendingPath(pendingId))
    await syncDirectory(this.trashRoot)
    return record
  }

  private pendingPath(pendingId: string): string {
    if (!UUID.test(pendingId)) throw new TrashStoreError('not-found', pendingId, `no pending move "${pendingId}"`)
    return join(this.trashRoot, `.pending-${pendingId}.json`)
  }

  private async readPending(pendingId: string): Promise<PendingRecord> {
    const path = this.pendingPath(pendingId)
    let info
    try {
      info = await lstat(path)
    } catch (error: unknown) {
      if (isErrno(error, 'ENOENT')) throw new TrashStoreError('not-found', pendingId, `no pending move "${pendingId}"`)
      throw error
    }
    if (!info.isFile()) throw new TrashStoreError('refused', pendingId, `"${path}" is not a plain file`)
    let value: unknown
    try {
      value = JSON.parse(await readFile(path, 'utf8'))
    } catch (error: unknown) {
      throw new TrashStoreError('refused', pendingId, `pending move "${pendingId}" is not JSON: ${String(error)}`)
    }
    return parsePending(value, pendingId)
  }

  private async lock(dir: string, sessionId: string): Promise<FileHandle> {
    const path = join(dir, LOCK)
    const handle = await open(path, 'a', 0o600)
    try {
      try {
        await this.tryLock(handle.fd)
      } catch (error: unknown) {
        if (isErrno(error, 'EAGAIN', 'EWOULDBLOCK')) {
          throw new TrashStoreError('in-use', sessionId, `session "${sessionId}" is being written by another owner`)
        }
        throw error
      }
      // A lock names an inode; a lock file replaced meanwhile proves nothing.
      const [held, current] = await Promise.all([handle.stat({ bigint: true }), stat(path, { bigint: true })])
      if (held.ino !== current.ino || held.dev !== current.dev) {
        throw new TrashStoreError('in-use', sessionId, `session "${sessionId}" lock file changed while locking`)
      }
      return handle
    } catch (error: unknown) {
      await handle.close()
      throw error
    }
  }

  private async assertTrashRoot(): Promise<void> {
    const info = await lstat(this.trashRoot)
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new TrashStoreError('refused', this.trashRoot, `trash directory "${this.trashRoot}" is not a plain directory`)
    }
    const [realSession, realTrash] = await Promise.all([realpath(this.sessionRoot), realpath(this.trashRoot)])
    if (realSession === realTrash || isInside(realSession, realTrash) || isInside(realTrash, realSession)) {
      throw new TrashStoreError('refused', this.trashRoot, 'trash directory and session root overlap after resolving links')
    }
  }

  private async assertSameDevice(subject: string): Promise<void> {
    const [session, trash] = await Promise.all([stat(this.sessionRoot), stat(this.trashRoot)])
    if (session.dev !== trash.dev) {
      throw new TrashStoreError('refused', subject, 'trash directory is on another volume; moving would need a copy')
    }
  }

  private async entryDir(entryId: string): Promise<string> {
    if (!UUID.test(entryId)) throw new TrashStoreError('not-found', entryId, `no trash entry "${entryId}"`)
    const dir = join(this.trashRoot, entryId)
    if (!await exists(dir)) throw new TrashStoreError('not-found', entryId, `no trash entry "${entryId}"`)
    await assertPlainDirectories(this.trashRoot, dir, entryId)
    return dir
  }

  private async readManifest(dir: string, entryId: string): Promise<TrashManifest> {
    let raw: string
    try {
      raw = await readFile(join(dir, MANIFEST), 'utf8')
    } catch (error: unknown) {
      if (isErrno(error, 'ENOENT')) throw new TrashStoreError('refused', entryId, `trash entry "${entryId}" has no manifest`)
      throw error
    }
    let value: unknown
    try {
      value = JSON.parse(raw)
    } catch (error: unknown) {
      throw new TrashStoreError('refused', entryId, `trash entry "${entryId}" manifest is not JSON: ${String(error)}`)
    }
    return parseManifest(value, entryId)
  }

  private async entrySize(dir: string, manifest: TrashManifest): Promise<number> {
    let total = 0
    for (const session of manifest.sessions) {
      const sessionDir = join(dir, session.project, session.dirName)
      let names: string[]
      try {
        names = await readdir(sessionDir)
      } catch (error: unknown) {
        if (isErrno(error, 'ENOENT')) continue
        throw error
      }
      for (const name of names) total += (await lstat(join(sessionDir, name))).size
    }
    return total
  }

  /** Require an entry to hold only its manifest and the recorded project directories. */
  private async assertEntryHoldsOnly(dir: string, manifest: TrashManifest): Promise<void> {
    const projects = new Set(manifest.sessions.map(session => session.project))
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === MANIFEST && entry.isFile()) continue
      if (entry.isDirectory() && projects.has(entry.name)) {
        const recorded = new Set(manifest.sessions.filter(session => session.project === entry.name).map(session => session.dirName))
        for (const child of await readdir(join(dir, entry.name))) {
          if (!recorded.has(child)) throw new TrashStoreError('refused', manifest.entryId, `unexpected entry "${child}" in trash entry`)
        }
        continue
      }
      throw new TrashStoreError('refused', manifest.entryId, `unexpected entry "${entry.name}" in trash entry`)
    }
  }

  /** Remove an entry's now-empty project directories, its manifest, and the entry directory. */
  private async removeEntryShell(dir: string, manifest: TrashManifest): Promise<void> {
    for (const project of new Set(manifest.sessions.map(session => session.project))) {
      try {
        await rmdir(join(dir, project))
      } catch (error: unknown) {
        if (!isErrno(error, 'ENOENT')) throw error
      }
    }
    await unlink(join(dir, MANIFEST))
    await rmdir(dir)
    await syncDirectory(this.trashRoot)
  }

  private async removeStagingShell(staging: string, manifest: TrashManifest): Promise<void> {
    await this.removeEntryShell(staging, manifest)
  }
}
