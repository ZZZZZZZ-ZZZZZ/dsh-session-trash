// @vitest-environment jsdom
/**
 * Browser half: the menu row, the move confirmation, the trash settings page,
 * and the plugin's slot registrations. Remote calls are stubbed at the
 * `remote.sessionTrash` namespace the plugin reads after mounting.
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ComponentType } from 'react'
import type { TrashEntryView } from '../src/protocol.ts'
import { SESSION_TRASH_DESCRIPTORS } from '../src/protocol.ts'
import { formatBytes, unwrap, type Translate } from '../src/client/api.ts'
import { createStore, MoveToTrashDialog, MoveToTrashMenuItem, TrashSection, type MoveRequest } from '../src/client/components.tsx'
import { en, zh } from '../src/client/locales.ts'
import * as plugin from '../src/client/index.tsx'

afterEach(cleanup)

const common: Record<string, string> = { cancel: '取消', close: '关闭' }
const t: Translate = (key, params = {}) => {
  const template = (zh as Record<string, string>)[key] ?? common[key] ?? key
  return template.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`))
}

const entry = (id: string, title: string, deletedAt = 1_700_000_000_000): TrashEntryView => ({
  entryId: `00000000-0000-4000-8000-00000000000${id}`, sessionId: `session-${id}`, title,
  cwd: '/projects/alpha', deletedAt, sessionCount: 1, sizeBytes: 2048,
})

describe('locales', () => {
  it('have the same keys in Chinese and English', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zh).sort())
  })
})

describe('menu row and move confirmation', () => {
  it('closes the menu, then asks for the confirmation with the row title', () => {
    const setMenuOpen = vi.fn()
    const requestMove = vi.fn()
    render(
      <MoveToTrashMenuItem
        sessionId="s1" displayTitle="Old chat" useMenuOpenState={() => [true, setMenuOpen]}
        requestMove={requestMove} untitled="s1" t={t}
      />,
    )
    const row = screen.getByRole('menuitem', { name: '移到回收站' })
    expect(row.className).toMatch(/danger/)
    fireEvent.click(row)
    expect(setMenuOpen).toHaveBeenCalledWith(false)
    expect(requestMove).toHaveBeenCalledWith({ sessionId: 's1', title: 'Old chat' })
  })

  it('moves only after the confirmation, and keeps the dialog open with the reason on failure', async () => {
    const requests = createStore<MoveRequest | null>(null)
    const moveToTrash = vi.fn<(request: MoveRequest) => Promise<'moved' | 'pending'>>()
      .mockRejectedValueOnce(new Error('此会话正在被使用'))
      .mockResolvedValueOnce('moved')
    render(<MoveToTrashDialog requests={requests} moveToTrash={moveToTrash} t={t} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    act(() => { requests.set({ sessionId: 's1', title: 'Old chat' }) })
    expect(screen.getByRole('dialog').textContent).toContain('“Old chat”')
    expect(moveToTrash).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: '移到回收站' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('此会话正在被使用') })
    expect(requests.get()).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: '移到回收站' }))
    await waitFor(() => { expect(requests.get()).toBeNull() })
    expect(moveToTrash).toHaveBeenCalledTimes(2)
  })

  it('tells the user when the move waits for the next DSH start', async () => {
    const requests = createStore<MoveRequest | null>(null)
    const moveToTrash = vi.fn(async () => 'pending' as const)
    render(<MoveToTrashDialog requests={requests} moveToTrash={moveToTrash} t={t} />)
    act(() => { requests.set({ sessionId: 's1', title: 'Open chat' }) })
    fireEvent.click(screen.getByRole('button', { name: '移到回收站' }))
    const notice = await screen.findByRole('dialog', { name: '已从侧栏隐藏' })
    expect(notice.textContent).toContain('下次启动 DSH 时会自动移入回收站')
    expect(requests.get()).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '知道了' }))
    expect(requests.get()).toBeNull()
  })

  it('Cancel settles without moving', () => {
    const requests = createStore<MoveRequest | null>({ sessionId: 's1', title: 'Old chat' })
    const moveToTrash = vi.fn(async () => 'moved' as const)
    render(<MoveToTrashDialog requests={requests} moveToTrash={moveToTrash} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(requests.get()).toBeNull()
    expect(moveToTrash).not.toHaveBeenCalled()
  })
})

describe('trash settings page', () => {
  it('lists entries, restores one, and purges another only after a second confirmation', async () => {
    let entries = [entry('1', 'First'), entry('2', 'Second')]
    const listTrash = vi.fn(async () => ({ entries, pending: [] }))
    const restore = vi.fn(async (id: string) => { entries = entries.filter(item => item.entryId !== id) })
    const purge = vi.fn(async (id: string) => { entries = entries.filter(item => item.entryId !== id) })
    render(<TrashSection listTrash={listTrash} restore={restore} purge={purge} cancelPending={vi.fn()} t={t} />)

    await screen.findByText('First')
    expect(screen.getAllByText('项目：/projects/alpha')).toHaveLength(2)
    expect(screen.getAllByText('1 个会话记录，2.0 KB')).toHaveLength(2)

    fireEvent.click(screen.getAllByRole('button', { name: '恢复' })[0]!)
    await waitFor(() => { expect(screen.queryByText('First')).toBeNull() })
    expect(restore).toHaveBeenCalledWith(entry('1', 'First').entryId)

    fireEvent.click(screen.getByRole('button', { name: '永久删除' }))
    const dialog = screen.getByRole('dialog', { name: '永久删除此会话？' })
    expect(dialog.textContent).toContain('“Second”')
    expect(purge).not.toHaveBeenCalled()
    fireEvent.click(screen.getAllByRole('button', { name: '永久删除' }).at(-1)!)
    await screen.findByText('回收站是空的')
    expect(purge).toHaveBeenCalledWith(entry('2', 'Second').entryId)
  })

  it('empties the trash after confirmation and stops at the first failure', async () => {
    let entries = [entry('1', 'First'), entry('2', 'Second'), entry('3', 'Third')]
    const listTrash = vi.fn(async () => ({ entries, pending: [] }))
    const purge = vi.fn(async (id: string) => {
      if (id === entry('2', 'Second').entryId) throw new Error('为安全起见已停止操作')
      entries = entries.filter(item => item.entryId !== id)
    })
    render(<TrashSection listTrash={listTrash} restore={vi.fn()} purge={purge} cancelPending={vi.fn()} t={t} />)
    await screen.findByText('Third')

    fireEvent.click(screen.getByRole('button', { name: '清空回收站' }))
    expect(screen.getByRole('dialog').textContent).toContain('全部 3 个会话')
    fireEvent.click(screen.getByRole('button', { name: '全部永久删除' }))
    await waitFor(() => { expect(screen.getByRole('alert').textContent).toBe('为安全起见已停止操作') })
    expect(purge).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    await waitFor(() => { expect(screen.queryByText('First')).toBeNull() })
    expect(screen.getByText('Second')).toBeTruthy()
    expect(screen.getByText('Third')).toBeTruthy()
  })
})

describe('pending moves on the trash page', () => {
  it('lists pending moves and cancels one without a confirmation', async () => {
    let pending = [{ pendingId: '11111111-2222-4333-8444-555555555555', sessionId: 's9', title: 'Open chat', requestedAt: 1_700_000_000_000 }]
    const listTrash = vi.fn(async () => ({ entries: [], pending }))
    const cancelPending = vi.fn(async () => { pending = [] })
    render(<TrashSection listTrash={listTrash} restore={vi.fn()} purge={vi.fn()} cancelPending={cancelPending} t={t} />)
    const list = await screen.findByRole('list', { name: '等待移入（下次启动 DSH 时生效）' })
    expect(list.textContent).toContain('Open chat')
    fireEvent.click(screen.getByRole('button', { name: '撤销' }))
    await waitFor(() => { expect(screen.queryByText('Open chat')).toBeNull() })
    expect(cancelPending).toHaveBeenCalledWith('11111111-2222-4333-8444-555555555555')
    expect(screen.getByText('回收站是空的')).toBeTruthy()
  })
})

describe('Remote results', () => {
  it('maps each failure code to its message and passes values through', () => {
    expect(unwrap({ ok: true, value: 7 }, t)).toBe(7)
    const failure = (code: string, details: Record<string, unknown> = {}) =>
      ({ ok: false, error: { code, message: 'm', details } }) as never
    expect(() => unwrap(failure('session-trash/session-in-use'), t)).toThrow(zh['error.inUse'])
    expect(() => unwrap(failure('session-trash/session-active'), t)).toThrow(zh['error.active'])
    expect(() => unwrap(failure('session-trash/refused', { reason: 'unexpected entry "notes.txt"' }), t))
      .toThrow('unexpected entry "notes.txt"')
    expect(() => unwrap(failure('gateway/internal'), t)).toThrow('gateway/internal: m')
  })

  it('formats sizes', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KB')
    expect(formatBytes(50 * 1024 * 1024)).toBe('50 MB')
  })
})

describe('plugin apply', () => {
  it('mounts the Remote methods and registers the three slot entries; disposal unmounts', async () => {
    const registrations: { options: Record<string, unknown>; component: ComponentType<never> }[] = []
    const injected: string[] = []
    const effects: (() => void)[] = []
    const unmount = vi.fn(async () => {})
    const mount = vi.fn(async () => unmount)
    const remote = { listTrash: vi.fn(async () => ({ ok: true, value: { entries: [entry('1', 'First')], pending: [] } })) }
    const ctx = {
      effect: (setup: () => () => void) => { effects.push(setup()) },
      locale: { register: vi.fn(() => () => {}), bind: () => t },
      remote: { $mount: mount },
      get: (key: string) => key === 'remote.sessionTrash' ? remote : undefined,
      slots: {
        inject: (slot: string, setup: () => () => void) => { injected.push(slot); effects.push(setup()) },
        register: (options: Record<string, unknown>, component: ComponentType<never>) => {
          registrations.push({ options, component })
          return () => {}
        },
      },
    }
    plugin.apply(ctx as never)
    expect(plugin.inject).toEqual(['slots', 'locale', 'remote'])
    expect(mount).toHaveBeenCalledWith({ package: 'dsh-plugin-session-trash', descriptors: SESSION_TRASH_DESCRIPTORS })
    expect(injected).toEqual(['sidebar.workspaces.session.menu.item', 'shell.overlay', 'settings.section'])
    expect(registrations.map(item => [item.options.name, item.options.id, item.options.order])).toEqual([
      ['sidebar.workspaces.session.menu.item', 'session-trash.move', 470],
      ['shell.overlay', 'session-trash.move-confirm', undefined],
      ['settings.section', 'session-trash', 70],
    ])
    expect((registrations[2]!.options.label as () => string)()).toBe('会话回收站')

    const Section = registrations[2]!.component as ComponentType
    render(<Section />)
    await screen.findByText('First')
    expect(remote.listTrash).toHaveBeenCalled()

    for (const dispose of effects) dispose()
    await Promise.resolve()
    await Promise.resolve()
    expect(unmount).toHaveBeenCalledOnce()
  })
})
