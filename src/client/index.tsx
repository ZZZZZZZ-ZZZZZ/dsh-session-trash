/**
 * Browser half of `dsh-plugin-session-trash`. It mounts the `sessionTrash` Remote
 * methods on `ctx.remote` and contributes three entries through official
 * slots: a "Move to trash" row in each Session's sidebar menu, the
 * confirmation that row raises (`shell.overlay`), and the "Session trash"
 * settings page (`settings.section`).
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import {
  REMOTE_SERVICE, SESSION_TRASH_REMOTE, unwrap, type SessionTrashRemote, type Translate,
} from './api.ts'
import {
  createStore, MoveToTrashDialog, MoveToTrashMenuItem, TrashSection,
  type MoveOutcome, type MoveRequest, type TrashContents,
} from './components.tsx'
import { en, zh, type SessionTrashKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    sessionTrash: SessionTrashKey
  }
}

/** Locale namespace of this plugin's copy. */
export const NS = 'sessionTrash'

/** Client plugin name. */
export const name = 'dsh-plugin-session-trash/client'

/** Client services this plugin needs. */
export const inject = ['slots', 'locale', 'remote']

/** The part of the Client sessions service used to re-list rows after a restore. */
interface SessionsRefresh {
  refresh(): Promise<void>
}

/**
 * Install the Remote contribution and the three slot entries.
 * @param ctx - Client root Context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'session-trash: dictionaries')
  const t: Translate = ctx.locale.bind(NS)

  const mounted = ctx.remote.$mount(SESSION_TRASH_REMOTE)
  ctx.effect(() => () => { void mounted.then(dispose => dispose()) }, 'session-trash: Remote methods')
  const remote = async (): Promise<SessionTrashRemote> => {
    await mounted
    return ctx.get(REMOTE_SERVICE) as SessionTrashRemote
  }
  const refreshSessions = async (): Promise<void> => {
    const sessions = ctx.get('sessions') as SessionsRefresh | undefined
    await sessions?.refresh()
  }

  const moveRequests = createStore<MoveRequest | null>(null)
  const moveToTrash = async (request: MoveRequest): Promise<MoveOutcome> => {
    // The wire accepts titles up to 1000 characters; a longer row title is shortened, not refused.
    const title = request.title.length > 1000 ? `${request.title.slice(0, 999)}…` : request.title
    const result = unwrap(await (await remote()).moveToTrash({ sessionId: request.sessionId, title }), t)
    await refreshSessions()
    return 'pending' in result ? 'pending' : 'moved'
  }
  const listTrash = async (): Promise<TrashContents> => unwrap(await (await remote()).listTrash(), t)
  const cancelPending = async (pendingId: string): Promise<void> => {
    unwrap(await (await remote()).cancelPending({ pendingId }), t)
    await refreshSessions()
  }
  const restore = async (entryId: string): Promise<void> => {
    unwrap(await (await remote()).restore({ entryId }), t)
    await refreshSessions()
  }
  const purge = async (entryId: string): Promise<void> => {
    unwrap(await (await remote()).purge({ entryId }), t)
  }

  ctx.slots.inject('sidebar.workspaces.session.menu.item', () => ctx.slots.register({
    name: 'sidebar.workspaces.session.menu.item',
    id: 'session-trash.move',
    order: 470,
    locale: NS,
  }, props => (
    <MoveToTrashMenuItem
      sessionId={props.sessionId}
      displayTitle={props.displayTitle}
      useMenuOpenState={props.useMenuOpenState}
      requestMove={(request) => { moveRequests.set(request) }}
      untitled={props.sessionId}
      t={t}
    />
  )))

  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'session-trash.move-confirm',
    locale: NS,
  }, () => <MoveToTrashDialog requests={moveRequests} moveToTrash={moveToTrash} t={t} />))

  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'session-trash',
    order: 70,
    label: () => t('section.nav'),
    locale: NS,
  }, () => <TrashSection listTrash={listTrash} restore={restore} purge={purge} cancelPending={cancelPending} t={t} />))
}
