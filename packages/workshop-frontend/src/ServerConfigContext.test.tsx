// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { afterEach, describe, expect, it } from 'vitest'
import { act, useState, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { DEFAULT_SITE_NAME, type ServerConfig } from '@gadgets/workshop-shared/api'
import {
  ServerConfigContext,
  ServerConfigUpdateContext,
  useServerConfig,
  useServerConfigUpdater,
  useSiteName,
} from './ServerConfigContext'

const BASE_CONFIG: ServerConfig = {
  authVendors: [],
  passwordAuthEnabled: true,
  cloudflareLimitsEnabled: false,
  signupsEnabled: true,
  siteName: 'Original',
  siteLogo: { url: '/api/site-logo?v=old' },
  announcement: '',
  banner: '',
  bannerColor: 'neutral',
  accentColor: '',
  enabledHubs: ['ops', 'revenue', 'support'],
}

describe('ServerConfigContext updater', () => {
  let container: HTMLDivElement | null = null
  let root: Root | null = null

  afterEach(() => {
    act(() => root?.unmount())
    container?.remove()
    root = null
    container = null
  })

  function render(element: ReactNode) {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    act(() => root!.render(element))
  }

  it('patches current config through the provider while preserving blank site-name fallback', () => {
    function Harness() {
      const [config, setConfig] = useState<ServerConfig | null>(BASE_CONFIG)
      return (
        <ServerConfigUpdateContext.Provider value={(update) => setConfig(current => current && { ...current, ...update })}>
          <ServerConfigContext.Provider value={config}>
            <Probe />
          </ServerConfigContext.Provider>
        </ServerConfigUpdateContext.Provider>
      )
    }
    function Probe() {
      const config = useServerConfig()
      const siteName = useSiteName()
      const updateConfig = useServerConfigUpdater()
      return (
        <>
          <span id="name">{siteName}</span>
          <span id="logo">{config?.siteLogo?.url ?? 'none'}</span>
          <button onClick={() => updateConfig({ siteName: '', siteLogo: undefined })}>patch</button>
        </>
      )
    }

    render(<Harness />)
    expect(container!.querySelector('#name')!.textContent).toBe('Original')
    expect(container!.querySelector('#logo')!.textContent).toBe('/api/site-logo?v=old')

    act(() => (container!.querySelector('button') as HTMLButtonElement).click())
    expect(container!.querySelector('#name')!.textContent).toBe(DEFAULT_SITE_NAME)
    expect(container!.querySelector('#logo')!.textContent).toBe('none')
  })

  it('has a safe no-op default updater outside the provider', () => {
    let updateConfig: ReturnType<typeof useServerConfigUpdater> | undefined
    function Probe() {
      updateConfig = useServerConfigUpdater()
      return null
    }
    render(<Probe />)
    expect(() => updateConfig?.({ siteName: 'ignored' })).not.toThrow()
  })
})
