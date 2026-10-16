/**
 * The plugin's React surfaces: the "Move to trash" row of a Session's sidebar
 * menu, the confirmation it raises in `shell.overlay`, and the Session trash
 * settings page. Every destructive step asks first; a failed call leaves the
 * dialog open with the reason and changes nothing on screen.
 */

import { useCallback, useEffect, useState } from 'react'
import { Button, IconTrashOutlineRegular, MenuItemButton, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PendingMoveView, TrashEntryView } from '../protocol.ts'
import { formatBytes, type Translate } from './api.ts'

/** A pending "move to trash" confirmation. */
export interface MoveRequest {
  readonly sessionId: string
  readonly title: string
}

/** Subscribable value shared between the plugin and its surfaces. */
export interface Store<T> {
  get(): T
  set(value: T): void
  subscribe(listener: () => void): () => void
}

/**
 * Create a minimal subscribable value.
 * @param initial - starting value.
 * @returns the store.
 */
export function createStore<T>(initial: T): Store<T> {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    get: () => value,
    set: (next) => {
      value = next
      for (const listener of listeners) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

function useStore<T>(store: Store<T>): T {
  const [value, setValue] = useState(store.get())
  useEffect(() => store.subscribe(() => { setValue(store.get()) }), [store])
  return value
}

const styles = {
  section: { display: 'flex', flexDirection: 'column', gap: 16, padding: '4px 0' },
  header: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 },
  title: { margin: 0, fontSize: 16, fontWeight: 600 },
  subtitle: { margin: 0, fontSize: 14, fontWeight: 600 },
  muted: { margin: '4px 0 0', fontSize: 13, opacity: 0.7, lineHeight: 1.5 },
  actions: { display: 'flex', gap: 8, flexShrink: 0 },
  list: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 },
  row: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
    padding: '10px 12px', borderRadius: 10, border: '1px solid var(--dsw-alias-border-default, rgba(127,127,127,0.25))',
  },
  rowText: { minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 },
  rowTitle: { fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  meta: { fontSize: 12, opacity: 0.65, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  error: { fontSize: 13, color: 'var(--dsw-alias-text-error, #d4380d)', lineHeight: 1.5 },
  status: { fontSize: 13, opacity: 0.75 },
} as const

/** Props of the sidebar menu row. */
export interface MoveMenuItemProps {
  readonly sessionId: string
  readonly displayTitle: string
  readonly useMenuOpenState: () => readonly [boolean, (open: boolean) => void]
  readonly requestMove: (request: MoveRequest) => void
  readonly untitled: string
  readonly t: Translate
}

/**
 * Menu row: close the menu, then ask for the move confirmation.
 * @param props - row identity, the menu state hook, and the request callback.
 * @returns the row.
 */
export function MoveToTrashMenuItem({ sessionId, displayTitle, useMenuOpenState, requestMove, untitled, t }: MoveMenuItemProps) {
  const [, setMenuOpen] = useMenuOpenState()
  return (
    <MenuItemButton
      danger
      icon={<IconTrashOutlineRegular size={14} />}
      onSelect={() => {
        setMenuOpen(false)
        requestMove({ sessionId, title: displayTitle === '' ? untitled : displayTitle })
      }}
    >
      {t('menu.moveToTrash')}
    </MenuItemButton>
  )
}

/** How a confirmed move ended: moved now, or pending until DSH restarts. */
export type MoveOutcome = 'moved' | 'pending'

/** Props of the move confirmation overlay. */
export interface MoveDialogProps {
  readonly requests: Store<MoveRequest | null>
  readonly moveToTrash: (request: MoveRequest) => Promise<MoveOutcome>
  readonly t: Translate
}

/**
 * Overlay entry: nothing until a move is requested, then one dialog per request.
 * @param props - the request store, the move hop, and the translate function.
 * @returns the dialog, or null.
 */
export function MoveToTrashDialog({ requests, moveToTrash, t }: MoveDialogProps) {
  const request = useStore(requests)
  if (request === null) return null
  return <MoveForm key={request.sessionId} request={request} moveToTrash={moveToTrash} onSettle={() => { requests.set(null) }} t={t} />
}

function MoveForm({ request, moveToTrash, onSettle, t }: {
  request: MoveRequest
  moveToTrash: (request: MoveRequest) => Promise<MoveOutcome>
  onSettle: () => void
  t: Translate
}) {
  const [pending, setPending] = useState(false)
  const [deferred, setDeferred] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const close = () => { if (!pending) onSettle() }
  const confirm = () => {
    setPending(true)
    setError(null)
    moveToTrash(request).then((outcome) => {
      setPending(false)
      if (outcome === 'pending') setDeferred(true)
      else onSettle()
    }, (reason: unknown) => {
      setPending(false)
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  }
  if (deferred) {
    return (
      <Modal
        open
        onClose={onSettle}
        closeLabel={t('close')}
        title={t('move.deferredTitle')}
        description={t('move.deferredDesc', { title: request.title })}
        footer={<Button variant="primary" onClick={onSettle}>{t('move.deferredOk')}</Button>}
      />
    )
  }
  return (
    <Modal
      open
      onClose={close}
      closeLabel={t('close')}
      title={t('move.title')}
      description={t('move.desc', { title: request.title })}
      footer={(
        <>
          <Button variant="outline" disabled={pending} onClick={close}>{t('cancel')}</Button>
          <Button variant="primary" disabled={pending} onClick={confirm}>{t('move.action')}</Button>
        </>
      )}
    >
      {pending && <div role="status" style={styles.status}>{t('move.pending')}</div>}
      {error !== null && <div role="alert" style={styles.error}>{error}</div>}
    </Modal>
  )
}

/** The trash contents the settings page shows. */
export interface TrashContents {
  readonly entries: readonly TrashEntryView[]
  readonly pending: readonly PendingMoveView[]
}

/** Props of the settings page. */
export interface TrashSectionProps {
  readonly listTrash: () => Promise<TrashContents>
  readonly restore: (entryId: string) => Promise<void>
  readonly purge: (entryId: string) => Promise<void>
  readonly cancelPending: (pendingId: string) => Promise<void>
  readonly t: Translate
}

type Confirmation =
  | { readonly kind: 'purge'; readonly entry: TrashEntryView }
  | { readonly kind: 'empty'; readonly entries: readonly TrashEntryView[] }

/**
 * The Session trash settings page: the list, restore, and the two confirmed
 * permanent deletions.
 * @param props - the Remote hops and the translate function.
 * @returns the page.
 */
export function TrashSection({ listTrash, restore, purge, cancelPending, t }: TrashSectionProps) {
  const [entries, setEntries] = useState<readonly TrashEntryView[] | null>(null)
  const [pendingMoves, setPendingMoves] = useState<readonly PendingMoveView[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null)

  const reload = useCallback(async () => {
    setError(null)
    try {
      const contents = await listTrash()
      setEntries(contents.entries)
      setPendingMoves(contents.pending)
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason))
    }
  }, [listTrash])
  useEffect(() => { void reload() }, [reload])

  const restoreEntry = (entry: TrashEntryView) => {
    setBusy(entry.entryId)
    setError(null)
    restore(entry.entryId).then(reload, (reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => { setBusy(null) })
  }

  const cancelMove = (move: PendingMoveView) => {
    setBusy(move.pendingId)
    setError(null)
    cancelPending(move.pendingId).then(reload, (reason: unknown) => {
      setError(reason instanceof Error ? reason.message : String(reason))
    }).finally(() => { setBusy(null) })
  }

  const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  return (
    <section style={styles.section} aria-label={t('section.title')}>
      <div style={styles.header}>
        <div>
          <h2 style={styles.title}>{t('section.title')}</h2>
          <p style={styles.muted}>{t('section.desc')}</p>
        </div>
        <div style={styles.actions}>
          <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => { void reload() }}>{t('section.refresh')}</Button>
          <Button
            size="sm"
            variant="outline"
            disabled={busy !== null || entries === null || entries.length === 0}
            onClick={() => { if (entries !== null) setConfirmation({ kind: 'empty', entries }) }}
          >
            {t('section.emptyTrash')}
          </Button>
        </div>
      </div>
      {error !== null && <div role="alert" style={styles.error}>{error}</div>}
      {entries === null && error === null && <div role="status" style={styles.status}>{t('section.loading')}</div>}
      {pendingMoves.length > 0 && (
        <div style={styles.section}>
          <h3 style={styles.subtitle}>{t('section.pendingTitle')}</h3>
          <ul style={styles.list} aria-label={t('section.pendingTitle')}>
            {pendingMoves.map(move => (
              <li key={move.pendingId} style={styles.row}>
                <div style={styles.rowText}>
                  <span style={styles.rowTitle} title={move.title}>{move.title}</span>
                  <span style={styles.meta}>{t('pending.requestedAt', { time: dateFormat.format(new Date(move.requestedAt)) })}</span>
                  {move.cwd !== undefined && <span style={styles.meta} title={move.cwd}>{t('entry.cwd', { cwd: move.cwd })}</span>}
                </div>
                <div style={styles.actions}>
                  <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => { cancelMove(move) }}>
                    {t('pending.cancel')}
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
      {entries !== null && entries.length === 0 && <p style={styles.muted}>{t('section.empty')}</p>}
      {entries !== null && entries.length > 0 && (
        <ul style={styles.list}>
          {entries.map(entry => (
            <li key={entry.entryId} style={styles.row}>
              <div style={styles.rowText}>
                <span style={styles.rowTitle} title={entry.title}>{entry.title}</span>
                <span style={styles.meta}>{t('entry.deletedAt', { time: dateFormat.format(new Date(entry.deletedAt)) })}</span>
                {entry.cwd !== undefined && <span style={styles.meta} title={entry.cwd}>{t('entry.cwd', { cwd: entry.cwd })}</span>}
                <span style={styles.meta}>{t('entry.size', { sessions: entry.sessionCount, size: formatBytes(entry.sizeBytes) })}</span>
              </div>
              <div style={styles.actions}>
                <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => { restoreEntry(entry) }}>
                  {t('entry.restore')}
                </Button>
                <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => { setConfirmation({ kind: 'purge', entry }) }}>
                  {t('entry.purge')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {confirmation !== null && (
        <PurgeDialog
          confirmation={confirmation}
          purge={purge}
          t={t}
          onSettle={(changed) => {
            setConfirmation(null)
            if (changed) void reload()
          }}
        />
      )}
    </section>
  )
}

function PurgeDialog({ confirmation, purge, onSettle, t }: {
  confirmation: Confirmation
  purge: (entryId: string) => Promise<void>
  onSettle: (changed: boolean) => void
  t: Translate
}) {
  const [progress, setProgress] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [changed, setChanged] = useState(false)
  const targets = confirmation.kind === 'purge' ? [confirmation.entry] : confirmation.entries
  const pending = progress !== null
  const close = () => { if (!pending) onSettle(changed) }
  const confirm = async () => {
    setError(null)
    for (let index = 0; index < targets.length; index += 1) {
      setProgress(index)
      try {
        await purge((targets[index] as TrashEntryView).entryId)
        setChanged(true)
      } catch (reason: unknown) {
        // Stop at the first failure: the rest stay in the trash untouched.
        setProgress(null)
        setChanged(true)
        setError(reason instanceof Error ? reason.message : String(reason))
        return
      }
    }
    setProgress(null)
    onSettle(true)
  }
  const single = confirmation.kind === 'purge'
  return (
    <Modal
      open
      onClose={close}
      closeLabel={t('close')}
      title={single ? t('purge.title') : t('emptyTrash.title')}
      description={single
        ? t('purge.desc', { title: confirmation.entry.title, sessions: confirmation.entry.sessionCount })
        : t('emptyTrash.desc', { count: targets.length })}
      footer={(
        <>
          <Button variant="outline" disabled={pending} onClick={close}>{t('cancel')}</Button>
          <Button variant="primary" disabled={pending} onClick={() => { void confirm() }}>
            {single ? t('purge.action') : t('emptyTrash.action')}
          </Button>
        </>
      )}
    >
      {pending && (
        <div role="status" style={styles.status}>
          {single ? t('purge.pending') : t('emptyTrash.pending', { done: progress, count: targets.length })}
        </div>
      )}
      {error !== null && <div role="alert" style={styles.error}>{error}</div>}
    </Modal>
  )
}
