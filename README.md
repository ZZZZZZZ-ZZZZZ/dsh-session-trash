# dsh-plugin-session-trash · Session Trash

English | [中文](README.zh.md)

A DeepSeek Harness (DSH) plugin that adds **Move to trash** to each session's sidebar menu. Sessions are not deleted outright: they go to a trash, where you can **restore** them from Settings → Session trash, or **delete them permanently after a second confirmation**. The trash is never emptied automatically.

- DSH 0.2.x (`engines.dsh: >=0.2.0-rc.2 <0.3.0`, including the 0.2.1-alpha previews)
- macOS and Linux; on Windows the plugin disables itself (the session write lock cannot be checked there)
- The official JSONL session storage only (the DSH default)

## Install

**Desktop**: open **Plugins** in the sidebar → **Add plugin**, enter one of the following, choose **Install**, then **Enable now** (a new plugin starts switched off):

- the GitHub address `https://github.com/ZZZZZZZ-ZZZZZ/dsh-session-trash`, or `github:ZZZZZZZ-ZZZZZ/dsh-session-trash#v0.2.1` for a fixed version
- the npm package name `dsh-plugin-session-trash`
- the absolute path of a local package such as `/path/to/dsh-plugin-session-trash-0.2.1.tgz` (made by `pnpm pack`)

The repository includes the built `lib/`, so a GitHub install runs no build script. If DSH cannot reach GitHub, use a network that can; the npm mirror DSH offers serves npm packages, not GitHub repositories.

Do not enter the source checkout: its `node_modules` holds development copies of DSH packages that would shadow the ones DSH runs.

**Command line** (optional): install Desktop's own `dsh` command from the application menu **Manage dsh Command…**, quit DSH completely, then run:

```sh
dsh plugin --profile desktop add dsh-plugin-session-trash
```

**Remove** it from the **Plugins** page, or quit DSH and run `dsh plugin --profile desktop remove dsh-plugin-session-trash`. Sessions in the trash stay in `~/.dsh/session-trash/`; removing the plugin does not delete them.

## Use

1. In a session's "…" menu choose **Move to trash** and confirm; the session leaves the sidebar. A session opened in this run is hidden first and moves into the trash the next time DSH starts.
2. Open **Settings → Session trash**:
   - **Restore** puts the session back where it was, with its previous archive and pin state;
   - **Delete permanently** removes the local session logs after a second confirmation;
   - **Empty trash** deletes every entry after confirmation, stopping at the first failure.

## Safety

| Rule | Detail |
|---|---|
| Sessions in use are never moved | Running work (a turn, subagents, background jobs, schedules) refuses the move; so does a session another DSH process writes (its `session.lock` is held) |
| Opened sessions move at the next start | An idle session opened in this run is hidden at once (the official archive) and moves into the trash at the next DSH start, before any session opens; every check still applies then, and a move that cannot run waits for the following start. You can cancel it on the trash page meanwhile |
| Move, never copy | Moving to and from the trash is a same-volume `rename`; a trash on another volume refuses |
| No recursive removal | Permanent deletion unlinks only the files DSH writes in a session directory (log generations, publish temporaries, `session.lock`) and removes directories with non-recursive `rmdir`; any other file refuses the whole deletion |
| Path checks | Entry ids must be UUIDs; session directories and their parents must be plain directories (no symbolic links) that resolve inside the session root; the trash must not be inside the session root |
| Crash safety | A move is prepared in `.staging-<id>` and published by one rename; an interrupted move is rolled back at the next start |
| Authenticated calls | The browser calls through DSH's `/api` gateway (Typert Remote, connection-authenticated); no unauthenticated HTTP route is registered |
| Official APIs | Hiding and restoring use the registry's `archiveSession` / `unarchiveSession` / `pinSession`; DSH's own storage is never rewritten |

Subagent sessions move and restore with their parent; forks are independent conversations and stay. Project folders and workspace files are never touched.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `trashDirectory` | `<DSH home>/session-trash` | Trash directory; outside the session root and on the same volume |

## Permanent deletion is local only

**Delete permanently** removes the copies on this machine. It cannot reach what DSH has already sent to DeepSeek:

- With the official DeepSeek API, DSH uploads the session log along with each request by default (the official `@deepseek-ai/dsh-session-log-deepseek` plugin). Turning off **Settings → General → Upload Session Log when using the official model API** stops later uploads only; turning it back on also uploads what was recorded while it was off.
- Images sent to the official API are uploaded as files that DSH asks DeepSeek to expire after 7 days; DSH does not guarantee their remote deletion.

This plugin makes no network requests and sends nothing anywhere.

## Known limitations

- A session opened in this run moves into the trash only at the next DSH start (a plugin cannot safely release the write ownership DSH holds); until then it is hidden.
- Only session log directories are handled; attachments, caches, and spill files other features keep for a session stay where they are (see the Attachment Library below for attachment usage).
- Relies on the DSH 0.2.x JSONL directory layout; re-verify after a DSH major upgrade.

## Related plugin

**[Attachment Library · dsh-plugin-attachment-library](https://github.com/ZZZZZZZ-ZZZZZ/dsh-attachment-library)**: Session Trash handles session logs only; the images and files attached in conversations stay on this machine. Attachment Library is a read-only page (Settings → Attachment Library) that lists how much space every attachment takes and which conversations still use it, including those in the trash, and can show a file in Finder or open an image in Preview. With both plugins installed, the library counts conversations in the trash too.

Install: in **Plugins → Add plugin**, enter `github:ZZZZZZZ-ZZZZZ/dsh-attachment-library#v0.4.1`.

## Develop

```sh
pnpm install
pnpm run typecheck
pnpm test        # builds lib/ then runs every test
```

`lib/` is committed so a GitHub install can use it directly; after changing sources run `pnpm run build` and commit `lib/` with them.

The client tests render the real 0.2.0-rc.2 UI components from a DSH source checkout at `../dsh-0.2.0-rc.2` (tag `dsh-v0.2.0-rc.2`; see `tests/primitives-shim.ts`), because the published component build only runs inside the DSH page. Tests run against the DSH 0.2.0-rc.2 packages published on npm: real JSONL session storage, the real Workspace registry, and the real Typert gateway, with sessions generated in temporary directories.
