// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

type TestAppInfo = { platform: 'macos' | 'ios' | 'android' | 'other'; version: string }

const state = vi.hoisted(() => ({
  runtime: {
    kind: 'tauri' as 'tauri' | 'web',
    apiOrigin: new URL('https://odie-os-native-api.odie-os.workers.dev'),
    getNativeAppInfo: vi.fn<() => Promise<TestAppInfo>>(async () => ({ platform: 'macos', version: '1.0.0' })),
    openExternal: vi.fn<(url: string) => Promise<void>>(async () => {}),
  },
}))

vi.mock('../../runtime', () => ({ getWorkshopRuntime: () => state.runtime }))

import NativeUpdateCard, { isNewerVersion } from './NativeUpdateCard'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('NativeUpdateCard', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    state.runtime.kind = 'tauri'
    state.runtime.getNativeAppInfo.mockResolvedValue({ platform: 'macos', version: '1.0.0' })
    state.runtime.getNativeAppInfo.mockClear()
    state.runtime.openExternal.mockClear()
  })

  async function render(metadataVersion = '1.1.0', collapsed = false) {
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => init?.method === 'HEAD'
      ? new Response(null)
      : Response.json({
          version: metadataVersion,
          url: `/downloads/mac/OdieOS-${metadataVersion}-${'a'.repeat(64)}.dmg`,
          sha256: 'a'.repeat(64),
        })))
    const container = document.createElement('div')
    const root = createRoot(container)
    await act(async () => root.render(<NativeUpdateCard collapsed={collapsed} />))
    await act(async () => {})
    return { container, root }
  }

  it('compares bounded numeric app versions', () => {
    expect(isNewerVersion('1.2.0', '1.1.9')).toBe(true)
    expect(isNewerVersion('1.0', '1.0.0')).toBe(false)
    expect(isNewerVersion('1.9007199254740993', '1.9007199254740992')).toBe(true)
    expect(isNewerVersion('1.0.0-beta', '1.0.0')).toBe(false)
  })

  it('offers the known DMG when a newer macOS release exists', async () => {
    const { container, root } = await render()
    const button = container.querySelector<HTMLButtonElement>('button[aria-label="Download Odie OS 1.1.0 update"]')
    expect(button?.textContent).toContain('Update available')
    await act(async () => button?.click())
    expect(state.runtime.openExternal).toHaveBeenCalledWith(`https://odie-os-native-api.odie-os.workers.dev/downloads/mac/OdieOS-1.1.0-${'a'.repeat(64)}.dmg`)
    await act(async () => root.unmount())
  })

  it('stays hidden on non-macOS platforms and when already current', async () => {
    state.runtime.getNativeAppInfo.mockResolvedValueOnce({ platform: 'ios', version: '1.0.0' })
    let rendered = await render()
    expect(rendered.container.textContent).toBe('')
    await act(async () => rendered.root.unmount())

    rendered = await render('1.0.0')
    expect(rendered.container.textContent).toBe('')
    await act(async () => rendered.root.unmount())
  })

  it('does not check for desktop updates in the web app', async () => {
    state.runtime.kind = 'web'
    const rendered = await render()
    expect(rendered.container.textContent).toBe('')
    expect(state.runtime.getNativeAppInfo).not.toHaveBeenCalled()
    await act(async () => rendered.root.unmount())
  })

  it('uses an accessible compact control in the collapsed sidebar', async () => {
    const { container, root } = await render('2.0.0', true)
    const button = container.querySelector('button')
    expect(button?.getAttribute('aria-label')).toBe('Download Odie OS 2.0.0 update')
    expect(button?.getAttribute('title')).toBe('Update available')
    await act(async () => root.unmount())
  })

  it('rejects metadata that is not tied to its versioned installer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      version: '2.0.0',
      url: '/downloads/mac/OdieOS-latest.dmg',
      sha256: 'invalid',
    })))
    const container = document.createElement('div')
    const root = createRoot(container)
    await act(async () => root.render(<NativeUpdateCard collapsed={false} />))
    await act(async () => {})
    expect(container.textContent).toBe('')
    await act(async () => root.unmount())
  })
})
