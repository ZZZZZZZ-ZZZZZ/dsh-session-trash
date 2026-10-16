import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";
import { dshHomePath } from "@deepseek-ai/dsh-home-paths";
import { RemoteError, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { tryLockExclusive } from "@deepseek-ai/node-addon-system/flock";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, realpath, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
//#region src/protocol.ts
/** Typert namespace and Cordis service key of the trash service. */
const SESSION_TRASH_NAMESPACE = "sessionTrash";
/** npm package that owns the Remote methods. */
const SESSION_TRASH_PACKAGE = "dsh-plugin-session-trash";
function strict(typeSymbol, parse) {
	const schema = { parse };
	return {
		mode: "strict",
		typeSymbol,
		create: () => schema
	};
}
function record(value, what) {
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${what} must be an object`);
	return value;
}
function exactKeys(value, required, optional, what) {
	for (const key of required) if (!(key in value)) throw new TypeError(`${what}.${key} is required`);
	for (const key of Object.keys(value)) if (!required.includes(key) && !optional.includes(key)) throw new TypeError(`${what}.${key} is not allowed`);
}
function text(value, what, maxLength) {
	if (typeof value !== "string" || value.length === 0 || value.length > maxLength) throw new TypeError(`${what} must be a non-empty string of at most ${String(maxLength)} characters`);
	return value;
}
const UUID$1 = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function uuid(value, what) {
	if (typeof value !== "string" || !UUID$1.test(value)) throw new TypeError(`${what} must be a lowercase UUID`);
	return value;
}
/**
* Validate a trash entry id: a lowercase UUID, so it can never name a path
* outside the trash directory.
* @param value - untrusted value.
* @returns the entry id.
*/
function parseEntryId(value) {
	return uuid(value, "entryId");
}
function parseMoveRequest(value) {
	const body = record(value, "request");
	exactKeys(body, ["sessionId", "title"], [], "request");
	return {
		sessionId: text(body.sessionId, "request.sessionId", 512),
		title: text(body.title, "request.title", 1e3)
	};
}
function parseEntryRequest(value) {
	const body = record(value, "request");
	exactKeys(body, ["entryId"], [], "request");
	return { entryId: parseEntryId(body.entryId) };
}
function parseEntryView(value) {
	const body = record(value, "entry");
	exactKeys(body, [
		"entryId",
		"sessionId",
		"title",
		"deletedAt",
		"sessionCount",
		"sizeBytes"
	], ["cwd"], "entry");
	for (const key of [
		"deletedAt",
		"sessionCount",
		"sizeBytes"
	]) {
		const field = body[key];
		if (typeof field !== "number" || !Number.isSafeInteger(field) || field < 0) throw new TypeError(`entry.${key} must be a non-negative integer`);
	}
	return {
		entryId: parseEntryId(body.entryId),
		sessionId: text(body.sessionId, "entry.sessionId", 512),
		title: text(body.title, "entry.title", 1e3),
		...body.cwd === void 0 ? {} : { cwd: text(body.cwd, "entry.cwd", 4096) },
		deletedAt: body.deletedAt,
		sessionCount: body.sessionCount,
		sizeBytes: body.sizeBytes
	};
}
function parsePendingRequest(value) {
	const body = record(value, "request");
	exactKeys(body, ["pendingId"], [], "request");
	return { pendingId: uuid(body.pendingId, "request.pendingId") };
}
function parsePendingView(value) {
	const body = record(value, "pending");
	exactKeys(body, [
		"pendingId",
		"sessionId",
		"title",
		"requestedAt"
	], ["cwd"], "pending");
	if (typeof body.requestedAt !== "number" || !Number.isSafeInteger(body.requestedAt) || body.requestedAt < 0) throw new TypeError("pending.requestedAt must be a non-negative integer");
	return {
		pendingId: uuid(body.pendingId, "pending.pendingId"),
		sessionId: text(body.sessionId, "pending.sessionId", 512),
		title: text(body.title, "pending.title", 1e3),
		...body.cwd === void 0 ? {} : { cwd: text(body.cwd, "pending.cwd", 4096) },
		requestedAt: body.requestedAt
	};
}
function parseIds(value, what) {
	if (!Array.isArray(value)) throw new TypeError(`${what} must be an array`);
	return value.map((id, index) => text(id, `${what}[${String(index)}]`, 512));
}
const T = `${SESSION_TRASH_PACKAGE}/types`;
const requestCodecs = {
	move: strict(`${T}#MoveToTrashRequest`, parseMoveRequest),
	entry: strict(`${T}#TrashEntryRequest`, parseEntryRequest),
	pending: strict(`${T}#PendingMoveRequest`, parsePendingRequest)
};
const resultCodecs = {
	move: strict(`${T}#MoveToTrashResult`, (value) => {
		const body = record(value, "result");
		if ("pending" in body) {
			exactKeys(body, ["pending"], [], "result");
			return { pending: parsePendingView(body.pending) };
		}
		exactKeys(body, ["entry"], [], "result");
		return { entry: parseEntryView(body.entry) };
	}),
	list: strict(`${T}#TrashListResult`, (value) => {
		const body = record(value, "result");
		exactKeys(body, ["entries", "pending"], [], "result");
		if (!Array.isArray(body.entries)) throw new TypeError("result.entries must be an array");
		if (!Array.isArray(body.pending)) throw new TypeError("result.pending must be an array");
		return {
			entries: body.entries.map(parseEntryView),
			pending: body.pending.map(parsePendingView)
		};
	}),
	cancel: strict(`${T}#PendingMoveResult`, (value) => {
		const body = record(value, "result");
		exactKeys(body, ["sessionId"], [], "result");
		return { sessionId: text(body.sessionId, "result.sessionId", 512) };
	}),
	entry: strict(`${T}#TrashEntryResult`, (value) => {
		const body = record(value, "result");
		exactKeys(body, ["sessionIds"], [], "result");
		return { sessionIds: parseIds(body.sessionIds, "result.sessionIds") };
	})
};
function descriptor(method, parameters, result) {
	return {
		id: `${SESSION_TRASH_PACKAGE}#${SESSION_TRASH_NAMESPACE}/${method}`,
		service: SESSION_TRASH_NAMESPACE,
		namespace: SESSION_TRASH_NAMESPACE,
		method,
		invocation: { kind: "direct" },
		parameters: parameters.map((parameter) => ({
			name: parameter.name,
			wire: parameter.name,
			source: "json",
			codec: parameter.codec
		})),
		result,
		sourceLocation: {
			file: `${SESSION_TRASH_PACKAGE}/lib/index.js`,
			line: 1,
			column: 1
		}
	};
}
/** The Remote methods, in one list shared by the Host registration and the Client mount. */
const SESSION_TRASH_DESCRIPTORS = [
	descriptor("moveToTrash", [{
		name: "request",
		codec: requestCodecs.move
	}], resultCodecs.move),
	descriptor("listTrash", [], resultCodecs.list),
	descriptor("restore", [{
		name: "request",
		codec: requestCodecs.entry
	}], resultCodecs.entry),
	descriptor("purge", [{
		name: "request",
		codec: requestCodecs.entry
	}], resultCodecs.entry),
	descriptor("cancelPending", [{
		name: "request",
		codec: requestCodecs.pending
	}], resultCodecs.cancel)
];
//#endregion
//#region src/trash-store.ts
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
/** Name of the manifest inside a trash entry. */
const MANIFEST = "entry.json";
const MANIFEST_VERSION = 1;
const LOCK = "session.lock";
const STAGING_PREFIX = ".staging-";
const PENDING_FILE = /^\.pending-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/;
const GENERATION = /^session(?:\.v[1-9][0-9]*)?\.jsonl(?:\.zstd)?$/;
const PUBLISH_TEMPORARY = /^session(?:\.v[1-9][0-9]*)?\.jsonl(?:\.zstd)?\.[0-9a-f]{12}\.tmp$/;
const MIGRATION_TEMPORARY = /^session\.migration\.[0-9a-f]{16}\.jsonl(?:\.zstd)?\.tmp$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A refusal that left the session root and the trash unchanged. */
var TrashStoreError = class extends Error {
	kind;
	subject;
	/**
	* @param kind - failure class the service maps to a Remote code.
	* @param subject - the session or entry id the failure names.
	* @param message - human-readable reason.
	*/
	constructor(kind, subject, message) {
		super(message);
		this.kind = kind;
		this.subject = subject;
		this.name = "TrashStoreError";
	}
};
function parsePending(value, pendingId) {
	const bad = (reason) => {
		throw new TrashStoreError("refused", pendingId, `pending move "${pendingId}" is invalid: ${reason}`);
	};
	if (typeof value !== "object" || value === null) return bad("not an object");
	const body = value;
	if (body.version !== MANIFEST_VERSION || body.pendingId !== pendingId) return bad("version or id");
	if (typeof body.sessionId !== "string" || body.sessionId === "" || typeof body.title !== "string" || body.title === "") return bad("session");
	if (body.cwd !== void 0 && typeof body.cwd !== "string") return bad("cwd");
	if (typeof body.requestedAt !== "number" || !Number.isSafeInteger(body.requestedAt)) return bad("requestedAt");
	if (typeof body.wasArchived !== "boolean" || typeof body.wasPinned !== "boolean") return bad("flags");
	return {
		version: MANIFEST_VERSION,
		pendingId,
		sessionId: body.sessionId,
		title: body.title,
		...body.cwd === void 0 ? {} : { cwd: body.cwd },
		requestedAt: body.requestedAt,
		wasArchived: body.wasArchived,
		wasPinned: body.wasPinned
	};
}
/**
* Encode a session id into the JSONL backend's directory segment, matching
* `encodeSegment` in `@deepseek-ai/dsh-session-persistence-jsonl` (MIT): safe
* code units stay literal, `.`/`..` and every other unit become `~XXXX`.
* @param raw - session id.
* @returns the single path segment.
*/
function encodeSegment(raw) {
	if (raw.length === 0) throw new Error("cannot encode an empty path segment");
	if (raw === ".") return "~002E";
	if (raw === "..") return "~002E~002E";
	let out = "";
	for (let i = 0; i < raw.length; i++) {
		const code = raw.charCodeAt(i);
		const ch = String.fromCharCode(code);
		out += ch !== "~" && /^[A-Za-z0-9._-]$/.test(ch) ? ch : `~${code.toString(16).toUpperCase().padStart(4, "0")}`;
	}
	return out;
}
function isSegment(value) {
	return typeof value === "string" && value !== "" && value !== "." && value !== ".." && !value.includes("/") && !value.includes("\\") && !value.includes("\0");
}
function isErrno(error, ...codes) {
	return codes.includes(error?.code ?? "");
}
/** Whether `child` is strictly inside `parent` (both absolute). */
function isInside(parent, child) {
	const rel = relative(parent, child);
	return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}
/**
* Check that the session root and the trash root are absolute, distinct, and
* neither contains the other. The JSONL backend treats every directory under
* its root as a project directory, so a trash inside it would make trashed
* sessions visible again.
* @param sessionRoot - the JSONL backend's configured root.
* @param trashRoot - the trash directory.
*/
function assertRoots(sessionRoot, trashRoot) {
	if (!isAbsolute(sessionRoot) || !isAbsolute(trashRoot)) throw new Error("session-trash: both roots must be absolute paths");
	const session = resolve(sessionRoot);
	const trash = resolve(trashRoot);
	if (session === trash || isInside(session, trash) || isInside(trash, session)) throw new Error(`session-trash: trash directory "${trash}" must be outside the session root "${session}" and must not contain it`);
}
/** Classify one session directory's entries; reject anything the backend does not write. */
async function classifySessionDirectory(dir, subject) {
	const files = [];
	let hasGeneration = false;
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		if (!entry.isFile()) throw new TrashStoreError("refused", subject, `unexpected non-file entry "${entry.name}" in "${dir}"`);
		if (GENERATION.test(entry.name)) hasGeneration = true;
		else if (entry.name !== LOCK && !PUBLISH_TEMPORARY.test(entry.name) && !MIGRATION_TEMPORARY.test(entry.name)) throw new TrashStoreError("refused", subject, `unexpected entry "${entry.name}" in "${dir}"`);
		files.push(join(dir, entry.name));
	}
	return {
		files,
		hasGeneration
	};
}
/** Require `path` and every directory between it and `base` to be plain directories inside `base`. */
async function assertPlainDirectories(base, path, subject) {
	if (!isInside(base, path)) throw new TrashStoreError("refused", subject, `"${path}" is outside "${base}"`);
	let current = path;
	while (current !== base) {
		const info = await lstat(current);
		if (info.isSymbolicLink() || !info.isDirectory()) throw new TrashStoreError("refused", subject, `"${current}" is not a plain directory`);
		current = dirname(current);
	}
	const [realBase, realPath] = await Promise.all([realpath(base), realpath(path)]);
	if (!isInside(realBase, realPath)) throw new TrashStoreError("refused", subject, `"${path}" resolves outside "${base}"`);
}
async function exists(path) {
	try {
		await lstat(path);
		return true;
	} catch (error) {
		if (isErrno(error, "ENOENT")) return false;
		throw error;
	}
}
async function syncDirectory(path) {
	if (process.platform === "win32") return;
	const handle = await open(path, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}
function parseManifest(value, entryId) {
	const bad = (reason) => {
		throw new TrashStoreError("refused", entryId, `trash entry "${entryId}" has an invalid manifest: ${reason}`);
	};
	if (typeof value !== "object" || value === null) return bad("not an object");
	const body = value;
	if (body.version !== MANIFEST_VERSION) return bad(`unsupported version ${String(body.version)}`);
	if (body.entryId !== entryId) return bad("entry id mismatch");
	if (typeof body.sessionId !== "string" || body.sessionId === "") return bad("sessionId");
	if (typeof body.title !== "string" || body.title === "") return bad("title");
	if (body.cwd !== void 0 && typeof body.cwd !== "string") return bad("cwd");
	if (typeof body.deletedAt !== "number" || !Number.isSafeInteger(body.deletedAt)) return bad("deletedAt");
	if (typeof body.wasArchived !== "boolean" || typeof body.wasPinned !== "boolean") return bad("flags");
	if (!Array.isArray(body.sessions) || body.sessions.length === 0) return bad("sessions");
	const sessions = body.sessions.map((item) => {
		const session = item;
		if (typeof session !== "object" || session === null || typeof session.sessionId !== "string" || !isSegment(session.project) || session.dirName !== encodeSegment(session.sessionId)) return bad("session record");
		return {
			sessionId: session.sessionId,
			project: session.project,
			dirName: session.dirName
		};
	});
	if (sessions[sessions.length - 1]?.sessionId !== body.sessionId) return bad("the conversation must be the last session");
	return {
		version: MANIFEST_VERSION,
		entryId,
		sessionId: body.sessionId,
		title: body.title,
		...body.cwd === void 0 ? {} : { cwd: body.cwd },
		deletedAt: body.deletedAt,
		wasArchived: body.wasArchived,
		wasPinned: body.wasPinned,
		sessions
	};
}
/** Filesystem operations over one session root and one trash root. */
var TrashStore = class {
	tryLock;
	now;
	sessionRoot;
	trashRoot;
	/**
	* @param sessionRoot - the JSONL backend's root directory.
	* @param trashRoot - directory holding trash entries; created on first move.
	* @param tryLock - exclusive non-blocking lock on a file descriptor.
	* @param now - clock for `deletedAt`.
	*/
	constructor(sessionRoot, trashRoot, tryLock, now = Date.now) {
		this.tryLock = tryLock;
		this.now = now;
		assertRoots(sessionRoot, trashRoot);
		this.sessionRoot = resolve(sessionRoot);
		this.trashRoot = resolve(trashRoot);
	}
	/**
	* Find the one directory that stores a session.
	* @param sessionId - the session.
	* @returns its project segment and absolute directory, or `undefined` when no log exists.
	*/
	async locate(sessionId) {
		const dirName = encodeSegment(sessionId);
		const matches = [];
		let projects;
		try {
			projects = (await readdir(this.sessionRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
		} catch (error) {
			if (isErrno(error, "ENOENT")) return void 0;
			throw error;
		}
		for (const project of projects) {
			const dir = join(this.sessionRoot, project, dirName);
			if (await exists(dir)) matches.push({
				project,
				dir
			});
		}
		if (matches.length > 1) throw new TrashStoreError("refused", sessionId, `session "${sessionId}" appears in several project directories`);
		return matches[0];
	}
	/**
	* Move a conversation and its subagent sessions into a new trash entry.
	* Every session is located, classified, and locked before the first rename;
	* a failure after that renames the moved directories back.
	* @param input - what to move and the facts a restore needs.
	* @returns the published entry.
	*/
	async moveToTrash(input) {
		if (input.sessionIds[input.sessionIds.length - 1] !== input.sessionId) throw new Error("session-trash: the conversation must be the last session to move");
		const planned = [];
		try {
			for (const sessionId of input.sessionIds) {
				const found = await this.locate(sessionId);
				if (found === void 0) {
					if (sessionId === input.sessionId) throw new TrashStoreError("not-found", sessionId, `session "${sessionId}" has no stored log`);
					continue;
				}
				await assertPlainDirectories(this.sessionRoot, found.dir, sessionId);
				const { hasGeneration } = await classifySessionDirectory(found.dir, sessionId);
				if (!hasGeneration) throw new TrashStoreError("refused", sessionId, `"${found.dir}" holds no session log`);
				const lock = await this.lock(found.dir, sessionId);
				planned.push({
					session: {
						sessionId,
						project: found.project,
						dirName: encodeSegment(sessionId)
					},
					dir: found.dir,
					lock
				});
			}
			await mkdir(this.trashRoot, {
				recursive: true,
				mode: 448
			});
			await this.assertTrashRoot();
			await this.assertSameDevice(input.sessionId);
			const entryId = randomUUID();
			const staging = join(this.trashRoot, `${STAGING_PREFIX}${entryId}`);
			const manifest = {
				version: MANIFEST_VERSION,
				entryId,
				sessionId: input.sessionId,
				title: input.title,
				...input.cwd === void 0 ? {} : { cwd: input.cwd },
				deletedAt: this.now(),
				wasArchived: input.wasArchived,
				wasPinned: input.wasPinned,
				sessions: planned.map((item) => item.session)
			};
			await mkdir(staging, { mode: 448 });
			await writeFile(join(staging, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, {
				mode: 384,
				flag: "wx"
			});
			const moved = [];
			const published = join(this.trashRoot, entryId);
			try {
				for (const item of planned) {
					const target = join(staging, item.session.project, item.session.dirName);
					await mkdir(dirname(target), {
						recursive: true,
						mode: 448
					});
					await rename(item.dir, target);
					moved.push({
						from: item.dir,
						to: target
					});
				}
				await rename(staging, published);
			} catch (error) {
				for (const item of moved.reverse()) await rename(item.to, item.from);
				await this.removeStagingShell(staging, manifest);
				throw error;
			}
			await syncDirectory(this.trashRoot);
			return {
				manifest,
				sizeBytes: await this.entrySize(published, manifest)
			};
		} finally {
			for (const item of planned) await item.lock.close();
		}
	}
	/**
	* Read every published entry, newest first. An entry whose manifest cannot
	* be read is skipped and reported through `onInvalid`.
	* @param onInvalid - receives each unreadable entry and its error.
	* @returns the entries.
	*/
	async list(onInvalid = () => {}) {
		let names;
		try {
			names = (await readdir(this.trashRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory() && UUID.test(entry.name)).map((entry) => entry.name);
		} catch (error) {
			if (isErrno(error, "ENOENT")) return [];
			throw error;
		}
		const entries = [];
		for (const entryId of names) try {
			const dir = join(this.trashRoot, entryId);
			const manifest = await this.readManifest(dir, entryId);
			entries.push({
				manifest,
				sizeBytes: await this.entrySize(dir, manifest)
			});
		} catch (error) {
			onInvalid(entryId, error);
		}
		return entries.sort((left, right) => right.manifest.deletedAt - left.manifest.deletedAt);
	}
	/**
	* Read one published entry's manifest.
	* @param entryId - the entry.
	* @returns its manifest.
	*/
	async manifest(entryId) {
		return this.readManifest(await this.entryDir(entryId), entryId);
	}
	/**
	* Move an entry's sessions back to their recorded places and remove the
	* entry. Every destination is checked before the first rename; a session
	* already back in place (an interrupted earlier restore) is skipped.
	* @param entryId - the entry.
	* @returns the entry's manifest.
	*/
	async restore(entryId) {
		const dir = await this.entryDir(entryId);
		const manifest = await this.readManifest(dir, entryId);
		const plan = [];
		for (const session of manifest.sessions) {
			const from = join(dir, session.project, session.dirName);
			const to = join(this.sessionRoot, session.project, session.dirName);
			const held = await exists(from);
			const occupied = await exists(to);
			if (held && occupied) throw new TrashStoreError("restore-conflict", session.sessionId, `"${to}" already exists`);
			if (!held) {
				if (occupied) continue;
				throw new TrashStoreError("refused", entryId, `trash entry "${entryId}" is missing session "${session.sessionId}"`);
			}
			await assertPlainDirectories(this.trashRoot, from, entryId);
			await classifySessionDirectory(from, entryId);
			plan.push({
				from,
				to
			});
		}
		await mkdir(this.sessionRoot, {
			recursive: true,
			mode: 448
		});
		const moved = [];
		try {
			for (const item of plan) {
				await mkdir(dirname(item.to), {
					recursive: true,
					mode: 448
				});
				await assertPlainDirectories(this.sessionRoot, dirname(item.to), entryId);
				await rename(item.from, item.to);
				moved.push(item);
			}
		} catch (error) {
			for (const item of moved.reverse()) await rename(item.to, item.from);
			throw error;
		}
		await this.removeEntryShell(dir, manifest);
		return manifest;
	}
	/**
	* Permanently delete an entry. Every file is classified before the first
	* unlink; an unrecognized file refuses the purge with nothing removed.
	* @param entryId - the entry.
	* @returns the entry's manifest.
	*/
	async purge(entryId) {
		const dir = await this.entryDir(entryId);
		const manifest = await this.readManifest(dir, entryId);
		const sessionDirs = [];
		for (const session of manifest.sessions) {
			const sessionDir = join(dir, session.project, session.dirName);
			if (!await exists(sessionDir)) continue;
			await assertPlainDirectories(this.trashRoot, sessionDir, entryId);
			sessionDirs.push({
				dir: sessionDir,
				files: (await classifySessionDirectory(sessionDir, entryId)).files
			});
		}
		await this.assertEntryHoldsOnly(dir, manifest);
		for (const item of sessionDirs) {
			for (const file of item.files) await unlink(file);
			await rmdir(item.dir);
		}
		await this.removeEntryShell(dir, manifest);
		return manifest;
	}
	/**
	* Roll back moves a crash interrupted: every staging directory's sessions go
	* back to their recorded places when those are free, then the staging
	* directory is removed. A staging directory that cannot be rolled back
	* cleanly is left in place and reported.
	* @param report - receives each staging directory that needs attention.
	* @returns how many staging directories were rolled back.
	*/
	async recoverStaging(report) {
		let names;
		try {
			names = (await readdir(this.trashRoot)).filter((name) => name.startsWith(STAGING_PREFIX));
		} catch (error) {
			if (isErrno(error, "ENOENT")) return 0;
			throw error;
		}
		let recovered = 0;
		for (const name of names) {
			const staging = join(this.trashRoot, name);
			const entryId = name.slice(9);
			try {
				if (!UUID.test(entryId)) throw new Error("not a staging directory this plugin created");
				const manifest = await this.readManifest(staging, entryId);
				for (const session of manifest.sessions) {
					const from = join(staging, session.project, session.dirName);
					const to = join(this.sessionRoot, session.project, session.dirName);
					if (!await exists(from)) continue;
					if (await exists(to)) throw new Error(`"${to}" exists; both copies kept`);
					await assertPlainDirectories(this.trashRoot, from, entryId);
					await mkdir(dirname(to), {
						recursive: true,
						mode: 448
					});
					await rename(from, to);
				}
				await this.removeStagingShell(staging, manifest);
				recovered += 1;
			} catch (error) {
				if (await this.removeEmptyStaging(staging)) recovered += 1;
				else report(staging, error);
			}
		}
		return recovered;
	}
	/**
	* Remove a staging directory a crash left before any session moved into it:
	* it holds nothing, or only a (possibly partial) manifest. Anything else stays.
	* @returns whether the directory was removed.
	*/
	async removeEmptyStaging(staging) {
		const info = await lstat(staging);
		if (info.isSymbolicLink() || !info.isDirectory()) return false;
		const entries = await readdir(staging, { withFileTypes: true });
		if (entries.some((entry) => entry.name !== "entry.json" || !entry.isFile())) return false;
		if (entries.length > 0) await unlink(join(staging, MANIFEST));
		await rmdir(staging);
		return true;
	}
	/**
	* Record a pending move. A conversation already pending keeps its first
	* record, so a repeated request changes nothing.
	* @param input - the conversation and its state before it was archived.
	* @returns the record now on disk.
	*/
	async addPending(input) {
		const existing = (await this.listPending()).find((record) => record.sessionId === input.sessionId);
		if (existing !== void 0) return existing;
		await mkdir(this.trashRoot, {
			recursive: true,
			mode: 448
		});
		await this.assertTrashRoot();
		const record = {
			version: MANIFEST_VERSION,
			pendingId: randomUUID(),
			sessionId: input.sessionId,
			title: input.title,
			...input.cwd === void 0 ? {} : { cwd: input.cwd },
			requestedAt: this.now(),
			wasArchived: input.wasArchived,
			wasPinned: input.wasPinned
		};
		const path = join(this.trashRoot, `.pending-${record.pendingId}.json`);
		const temporary = `${path}.tmp`;
		await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, {
			mode: 384,
			flag: "wx"
		});
		await rename(temporary, path);
		await syncDirectory(this.trashRoot);
		return record;
	}
	/**
	* Read every pending move, newest first. An unreadable record is skipped
	* and reported through `onInvalid`.
	* @param onInvalid - receives each unreadable record and its error.
	* @returns the records.
	*/
	async listPending(onInvalid = () => {}) {
		let names;
		try {
			names = await readdir(this.trashRoot);
		} catch (error) {
			if (isErrno(error, "ENOENT")) return [];
			throw error;
		}
		const records = [];
		for (const name of names) {
			const pendingId = PENDING_FILE.exec(name)?.[1];
			if (pendingId === void 0) continue;
			try {
				records.push(await this.readPending(pendingId));
			} catch (error) {
				onInvalid(pendingId, error);
			}
		}
		return records.sort((left, right) => right.requestedAt - left.requestedAt);
	}
	/**
	* Remove one pending move's record.
	* @param pendingId - the record.
	* @returns the removed record.
	*/
	async removePending(pendingId) {
		const record = await this.readPending(pendingId);
		await unlink(this.pendingPath(pendingId));
		await syncDirectory(this.trashRoot);
		return record;
	}
	pendingPath(pendingId) {
		if (!UUID.test(pendingId)) throw new TrashStoreError("not-found", pendingId, `no pending move "${pendingId}"`);
		return join(this.trashRoot, `.pending-${pendingId}.json`);
	}
	async readPending(pendingId) {
		const path = this.pendingPath(pendingId);
		let info;
		try {
			info = await lstat(path);
		} catch (error) {
			if (isErrno(error, "ENOENT")) throw new TrashStoreError("not-found", pendingId, `no pending move "${pendingId}"`);
			throw error;
		}
		if (!info.isFile()) throw new TrashStoreError("refused", pendingId, `"${path}" is not a plain file`);
		let value;
		try {
			value = JSON.parse(await readFile(path, "utf8"));
		} catch (error) {
			throw new TrashStoreError("refused", pendingId, `pending move "${pendingId}" is not JSON: ${String(error)}`);
		}
		return parsePending(value, pendingId);
	}
	async lock(dir, sessionId) {
		const path = join(dir, LOCK);
		const handle = await open(path, "a", 384);
		try {
			try {
				await this.tryLock(handle.fd);
			} catch (error) {
				if (isErrno(error, "EAGAIN", "EWOULDBLOCK")) throw new TrashStoreError("in-use", sessionId, `session "${sessionId}" is being written by another owner`);
				throw error;
			}
			const [held, current] = await Promise.all([handle.stat({ bigint: true }), stat(path, { bigint: true })]);
			if (held.ino !== current.ino || held.dev !== current.dev) throw new TrashStoreError("in-use", sessionId, `session "${sessionId}" lock file changed while locking`);
			return handle;
		} catch (error) {
			await handle.close();
			throw error;
		}
	}
	async assertTrashRoot() {
		const info = await lstat(this.trashRoot);
		if (info.isSymbolicLink() || !info.isDirectory()) throw new TrashStoreError("refused", this.trashRoot, `trash directory "${this.trashRoot}" is not a plain directory`);
		const [realSession, realTrash] = await Promise.all([realpath(this.sessionRoot), realpath(this.trashRoot)]);
		if (realSession === realTrash || isInside(realSession, realTrash) || isInside(realTrash, realSession)) throw new TrashStoreError("refused", this.trashRoot, "trash directory and session root overlap after resolving links");
	}
	async assertSameDevice(subject) {
		const [session, trash] = await Promise.all([stat(this.sessionRoot), stat(this.trashRoot)]);
		if (session.dev !== trash.dev) throw new TrashStoreError("refused", subject, "trash directory is on another volume; moving would need a copy");
	}
	async entryDir(entryId) {
		if (!UUID.test(entryId)) throw new TrashStoreError("not-found", entryId, `no trash entry "${entryId}"`);
		const dir = join(this.trashRoot, entryId);
		if (!await exists(dir)) throw new TrashStoreError("not-found", entryId, `no trash entry "${entryId}"`);
		await assertPlainDirectories(this.trashRoot, dir, entryId);
		return dir;
	}
	async readManifest(dir, entryId) {
		let raw;
		try {
			raw = await readFile(join(dir, MANIFEST), "utf8");
		} catch (error) {
			if (isErrno(error, "ENOENT")) throw new TrashStoreError("refused", entryId, `trash entry "${entryId}" has no manifest`);
			throw error;
		}
		let value;
		try {
			value = JSON.parse(raw);
		} catch (error) {
			throw new TrashStoreError("refused", entryId, `trash entry "${entryId}" manifest is not JSON: ${String(error)}`);
		}
		return parseManifest(value, entryId);
	}
	async entrySize(dir, manifest) {
		let total = 0;
		for (const session of manifest.sessions) {
			const sessionDir = join(dir, session.project, session.dirName);
			let names;
			try {
				names = await readdir(sessionDir);
			} catch (error) {
				if (isErrno(error, "ENOENT")) continue;
				throw error;
			}
			for (const name of names) total += (await lstat(join(sessionDir, name))).size;
		}
		return total;
	}
	/** Require an entry to hold only its manifest and the recorded project directories. */
	async assertEntryHoldsOnly(dir, manifest) {
		const projects = new Set(manifest.sessions.map((session) => session.project));
		for (const entry of await readdir(dir, { withFileTypes: true })) {
			if (entry.name === "entry.json" && entry.isFile()) continue;
			if (entry.isDirectory() && projects.has(entry.name)) {
				const recorded = new Set(manifest.sessions.filter((session) => session.project === entry.name).map((session) => session.dirName));
				for (const child of await readdir(join(dir, entry.name))) if (!recorded.has(child)) throw new TrashStoreError("refused", manifest.entryId, `unexpected entry "${child}" in trash entry`);
				continue;
			}
			throw new TrashStoreError("refused", manifest.entryId, `unexpected entry "${entry.name}" in trash entry`);
		}
	}
	/** Remove an entry's now-empty project directories, its manifest, and the entry directory. */
	async removeEntryShell(dir, manifest) {
		for (const project of new Set(manifest.sessions.map((session) => session.project))) try {
			await rmdir(join(dir, project));
		} catch (error) {
			if (!isErrno(error, "ENOENT")) throw error;
		}
		await unlink(join(dir, MANIFEST));
		await rmdir(dir);
		await syncDirectory(this.trashRoot);
	}
	async removeStagingShell(staging, manifest) {
		await this.removeEntryShell(staging, manifest);
	}
};
//#endregion
//#region src/index.ts
/**
* Host half of `dsh-plugin-session-trash`: the `sessionTrash` service and its four
* Remote methods. Moving a conversation hides it with the official
* `archiveSession`, then moves its log directory (and its subagent sessions')
* into the trash. Restoring moves them back and undoes the archive and pin
* changes the move made; purging deletes the trash entry's files and drops the
* conversation from the registry's archive set, pin set, and Workspace
* accounts. See `trash-store.ts` for the filesystem rules.
*/
const JSONL_BACKEND = "session-persistence-jsonl";
/** The JSONL backend's root from its public `config`, or `undefined` for another backend. */
function jsonlRoot(backend) {
	if (Reflect.get(backend, "name") !== JSONL_BACKEND) return void 0;
	const config = Reflect.get(backend, "config");
	const root = typeof config === "object" && config !== null ? Reflect.get(config, "root") : void 0;
	return typeof root === "string" ? root : void 0;
}
function view(entry) {
	const { manifest } = entry;
	return {
		entryId: manifest.entryId,
		sessionId: manifest.sessionId,
		title: manifest.title,
		...manifest.cwd === void 0 ? {} : { cwd: manifest.cwd },
		deletedAt: manifest.deletedAt,
		sessionCount: manifest.sessions.length,
		sizeBytes: entry.sizeBytes
	};
}
function pendingView(record) {
	return {
		pendingId: record.pendingId,
		sessionId: record.sessionId,
		title: record.title,
		...record.cwd === void 0 ? {} : { cwd: record.cwd },
		requestedAt: record.requestedAt
	};
}
function remoteFailure(error) {
	if (!(error instanceof TrashStoreError)) return error;
	switch (error.kind) {
		case "not-found": return new RemoteError("session-trash/not-found", error.message, { id: error.subject }, { cause: error });
		case "in-use": return new RemoteError("session-trash/session-in-use", error.message, { sessionId: error.subject }, { cause: error });
		case "restore-conflict": return new RemoteError("session-trash/restore-conflict", error.message, { sessionId: error.subject }, { cause: error });
		case "refused": return new RemoteError("session-trash/refused", error.message, { reason: error.message }, { cause: error });
	}
}
/**
* The session trash service (`ctx.sessionTrash`). Operations run one at a
* time. Every refusal happens before any file or registry state changes.
*/
var SessionTrash = class extends TypertRemoteService {
	config;
	static inject = [
		"sessionPersistence",
		"workspaceRegistry",
		"typert"
	];
	static Config = z.object({ trashDirectory: z.string().description("Directory holding trash entries; default `<DSH home>/session-trash`.") });
	store;
	unsupported;
	tail = Promise.resolve();
	/**
	* @param ctx - Host context with session persistence, the Workspace registry, and the Typert registry.
	* @param config - plugin configuration.
	*/
	constructor(ctx, config = {}) {
		super(ctx, SESSION_TRASH_NAMESPACE);
		this.config = config;
	}
	async [Service.init]() {
		const root = jsonlRoot(this.ctx.sessionPersistence);
		if (process.platform === "win32") this.unsupported = "Windows is not supported: the session write lock cannot be checked there";
		else if (root === void 0) this.unsupported = "session persistence is not the JSONL backend";
		else {
			this.store = new TrashStore(root, this.config.trashDirectory ?? dshHomePath("session-trash"), tryLockExclusive);
			const recovered = await this.store.recoverStaging((path, error) => {
				this.ctx.logger.warn(`session-trash: interrupted move at "${path}" needs attention: ${String(error)}`);
			});
			if (recovered > 0) this.ctx.logger.info(`session-trash: rolled back ${String(recovered)} interrupted move(s)`);
			await this.processPending(this.store);
		}
		if (this.unsupported !== void 0) this.ctx.logger.warn(`session-trash: disabled — ${this.unsupported}`);
		const dispose = this.ctx.typert.register({
			package: SESSION_TRASH_PACKAGE,
			face: "host",
			schemas: [],
			model: {
				services: [],
				events: [],
				objects: []
			},
			invocations: SESSION_TRASH_DESCRIPTORS
		});
		this.ctx.effect(() => dispose, "session-trash: Remote methods");
	}
	/**
	* Move a conversation and its subagent sessions to the trash. Refused while
	* any of them runs work or another owner holds its write lock. A
	* conversation DSH opened in this run cannot move while DSH holds it: it is
	* archived now and recorded as a pending move that the next start completes.
	* @param request - the conversation and its display title.
	* @returns the new trash entry, or the pending move.
	*/
	moveToTrash(request) {
		return this.serial(async (store) => {
			const sessionId = request.sessionId;
			const headers = (await this.ctx.sessionPersistence.list()).map((snapshot) => snapshot.header);
			const header = headers.find((candidate) => candidate.id === sessionId);
			if (header === void 0) throw new RemoteError("session-trash/not-found", `session "${sessionId}" has no stored log`, { id: sessionId });
			const targets = descendantsFirst(sessionId, headers);
			await this.assertIdle(targets);
			const registry = this.ctx.workspaceRegistry;
			const earlier = (await store.listPending()).find((record) => record.sessionId === sessionId);
			const wasArchived = earlier?.wasArchived ?? registry.archivedSessionIds.includes(sessionId);
			const wasPinned = earlier?.wasPinned ?? registry.pinnedSessionIds.includes(sessionId);
			const cwd = header.cwd === void 0 ? {} : { cwd: header.cwd };
			if (!registry.archivedSessionIds.includes(sessionId)) await registry.archiveSession(sessionId);
			if (this.heldOpen(targets)) try {
				return { pending: pendingView(await store.addPending({
					sessionId,
					title: request.title,
					...cwd,
					wasArchived,
					wasPinned
				})) };
			} catch (error) {
				if (earlier === void 0) await this.restoreRegistryState(sessionId, wasArchived, wasPinned);
				throw error;
			}
			let entry;
			try {
				entry = await store.moveToTrash({
					sessionId,
					title: request.title,
					...cwd,
					wasArchived,
					wasPinned,
					sessionIds: targets
				});
			} catch (error) {
				if (earlier === void 0) await this.restoreRegistryState(sessionId, wasArchived, wasPinned);
				throw error;
			}
			if (earlier !== void 0) await this.bestEffort(`removing pending move "${earlier.pendingId}"`, async () => {
				await store.removePending(earlier.pendingId);
			});
			for (const session of entry.manifest.sessions) this.ctx.emit("api-session/removed", session.sessionId);
			return { entry: view(entry) };
		});
	}
	/**
	* Cancel a pending move: drop its record and put the archive and pin state back.
	* @param request - the pending move.
	* @returns the conversation it concerned.
	*/
	cancelPending(request) {
		return this.serial(async (store) => {
			const record = await store.removePending(request.pendingId);
			await this.restoreRegistryState(record.sessionId, record.wasArchived, record.wasPinned);
			return { sessionId: record.sessionId };
		});
	}
	/**
	* List the trash and the pending moves, newest first.
	* @returns every readable entry and pending move.
	*/
	listTrash() {
		return this.serial(async (store) => {
			const warn = (id, error) => {
				this.ctx.logger.warn(`session-trash: skipped unreadable record "${id}": ${String(error)}`);
			};
			const entries = await store.list(warn);
			const pending = await store.listPending(warn);
			return {
				entries: entries.map(view),
				pending: pending.map(pendingView)
			};
		});
	}
	/**
	* Put an entry's sessions back and undo the archive and pin changes the move made.
	* @param request - the entry.
	* @returns the restored session ids.
	*/
	restore(request) {
		return this.serial(async (store) => {
			const manifest = await store.restore(request.entryId);
			await this.restoreRegistryState(manifest.sessionId, manifest.wasArchived, manifest.wasPinned);
			return { sessionIds: manifest.sessions.map((session) => session.sessionId) };
		});
	}
	/**
	* Permanently delete an entry, then drop its sessions from the registry.
	* @param request - the entry.
	* @returns the deleted session ids.
	*/
	purge(request) {
		return this.serial(async (store) => {
			const manifest = await store.purge(request.entryId);
			const registry = this.ctx.workspaceRegistry;
			for (const session of manifest.sessions) {
				const id = session.sessionId;
				await this.bestEffort(`forgetting session "${id}"`, async () => {
					await registry.unarchiveSession(id);
					await registry.unpinSession(id);
					for (const workspace of registry.list()) await workspace.detachSession(id);
				});
			}
			return { sessionIds: manifest.sessions.map((session) => session.sessionId) };
		});
	}
	/** Refuse while a target runs work; activity cannot be deferred safely. */
	async assertIdle(targets) {
		for (const target of targets) {
			const activity = await this.ctx.waterfall("workspace/session-activity", { sessionId: target }, () => Promise.resolve([]));
			if (activity.length > 0) throw new RemoteError("session-trash/session-active", `session "${target}" is running work`, {
				sessionId: target,
				activity: activity.map((entry) => String(entry.kind))
			});
		}
	}
	/** Whether this DSH process holds any target open (a live Session it keeps until restart). */
	heldOpen(targets) {
		const live = this.ctx.get("sessions");
		return targets.some((target) => live?.get(target) !== void 0);
	}
	/**
	* Complete the pending moves at startup, before the user opens sessions. A
	* move that cannot run yet (held, running work, refused) stays pending and
	* is retried at the next start; a conversation that no longer exists drops
	* its record. Never fails the plugin start.
	*/
	async processPending(store) {
		let records;
		try {
			records = await store.listPending((id, error) => {
				this.ctx.logger.warn(`session-trash: skipped unreadable pending move "${id}": ${String(error)}`);
			});
		} catch (error) {
			this.ctx.logger.warn(`session-trash: reading pending moves failed: ${String(error)}`);
			return;
		}
		if (records.length === 0) return;
		let headers;
		try {
			headers = (await this.ctx.sessionPersistence.list()).map((snapshot) => snapshot.header);
		} catch (error) {
			this.ctx.logger.warn(`session-trash: pending moves wait: listing sessions failed: ${String(error)}`);
			return;
		}
		for (const record of records) {
			const sessionId = record.sessionId;
			try {
				if (!headers.some((header) => header.id === sessionId)) {
					await store.removePending(record.pendingId);
					this.ctx.logger.warn(`session-trash: session "${sessionId}" no longer exists; dropped its pending move`);
					continue;
				}
				const targets = descendantsFirst(sessionId, headers);
				if (this.heldOpen(targets)) continue;
				await this.assertIdle(targets);
				const entry = await store.moveToTrash({
					sessionId,
					title: record.title,
					...record.cwd === void 0 ? {} : { cwd: record.cwd },
					wasArchived: record.wasArchived,
					wasPinned: record.wasPinned,
					sessionIds: targets
				});
				await store.removePending(record.pendingId);
				for (const session of entry.manifest.sessions) this.ctx.emit("api-session/removed", session.sessionId);
				this.ctx.logger.info(`session-trash: moved pending session "${sessionId}" to the trash`);
			} catch (error) {
				this.ctx.logger.warn(`session-trash: pending move of "${sessionId}" stays pending: ${String(error)}`);
			}
		}
	}
	/** Put a conversation's archive and pin membership back to what the move recorded. */
	async restoreRegistryState(sessionId, wasArchived, wasPinned) {
		const registry = this.ctx.workspaceRegistry;
		await this.bestEffort(`restoring archive and pin state of session "${sessionId}"`, async () => {
			if (!wasArchived) await registry.unarchiveSession(sessionId);
			if (wasPinned) await registry.pinSession(sessionId);
		});
	}
	async bestEffort(what, operation) {
		try {
			await operation();
		} catch (error) {
			this.ctx.logger.warn(`session-trash: ${what} failed: ${String(error)}`);
		}
	}
	serial(operation) {
		const run = async () => {
			if (this.store === void 0) throw new RemoteError("session-trash/unsupported", this.unsupported ?? "session trash is not ready", { reason: this.unsupported ?? "not ready" });
			try {
				return await operation(this.store);
			} catch (error) {
				throw remoteFailure(error);
			}
		};
		const result = this.tail.then(run, run);
		this.tail = result.catch(() => void 0);
		return result;
	}
};
/**
* The conversation and its subagent descendants by durable lineage, deepest
* first and the conversation last. Forks carry `parentSession` without the
* `subagent` origin and stay.
* @param sessionId - the conversation.
* @param headers - every stored session header.
* @returns session ids to move.
*/
function descendantsFirst(sessionId, headers) {
	const children = /* @__PURE__ */ new Map();
	for (const header of headers) {
		if (header.origin !== "subagent" || header.parentSession === void 0) continue;
		children.set(header.parentSession, [...children.get(header.parentSession) ?? [], header.id]);
	}
	const ordered = [];
	const visited = /* @__PURE__ */ new Set();
	const visit = (id) => {
		if (visited.has(id)) return;
		visited.add(id);
		for (const child of children.get(id) ?? []) visit(child);
		ordered.push(id);
	};
	visit(sessionId);
	return ordered;
}
//#endregion
export { SessionTrash, SessionTrash as default, TrashStore, TrashStoreError, descendantsFirst, encodeSegment };
