# Changelog

## Unreleased

- Tests no longer need a DSH source checkout: the UI components they render are vendored, unmodified, in `tests/vendor/ui-primitives` (MIT). The plugin itself is unchanged.

## 0.2.1

- README: permanent deletion removes local copies only; DSH uploads the session log to the official DeepSeek API by default and how to turn that off; images uploaded to DeepSeek are not deleted remotely by DSH.
- Internal release notes are no longer part of the repository.

## 0.2.0

- A session opened in this DSH run no longer refuses "Move to trash": it is hidden at once (archived) and moves into the trash at the next DSH start, before any session opens. Every safety check still runs then; a move that cannot run yet waits for the following start.
- Settings → Session trash lists these pending moves and can cancel one, which puts the previous archive and pin state back.
- Moving a pending session again once DSH no longer holds it completes the move right away.
- The "in use" refusal now only means another process writes the session.

## 0.1.0

First release (npm package `dsh-plugin-session-trash`).

- "Move to trash" in each session's sidebar menu, with a confirmation.
- Settings → Session trash: list, restore (with the previous archive and pin state), and permanent deletion or emptying after a second confirmation. Nothing is removed automatically.
- Subagent sessions move and restore with their conversation; forks stay.
- Refuses sessions with running work, sessions opened in this DSH run, and sessions another process is writing; each refusal names its reason and changes nothing.
- Same-volume moves only; permanent deletion removes only files DSH writes, without recursive removal; interrupted moves roll back at the next start.
- Calls go through the authenticated `/api` gateway.
- DSH 0.2.x (`>=0.2.0-rc.2 <0.3.0`); macOS and Linux.
