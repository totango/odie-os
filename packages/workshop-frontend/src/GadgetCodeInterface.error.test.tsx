// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ButtonHTMLAttributes } from 'react'
import { createRoot } from 'react-dom/client'
import { afterAll, describe, expect, it, vi } from 'vitest'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

const imports = vi.hoisted(() => {
  const deferred = () => {
    let reject!: (error: Error) => void
    const promise = new Promise<never>((_, fail) => { reject = fail })
    return { promise, reject, loads: 0 }
  }
  return { code: deferred(), diff: deferred() }
})

vi.mock('./CodeEditor', async () => {
  imports.code.loads++
  return await imports.code.promise
})
vi.mock('./CodeDiffEditor', async () => {
  imports.diff.loads++
  return await imports.diff.promise
})
vi.mock('@cloudflare/kumo', () => ({
  useKumoToastManager: () => ({ add: vi.fn<() => void>() }),
}))
vi.mock('./FileSidebar', () => ({
  default: ({ files, onFileSelect }: { files: string[]; onFileSelect: (filename: string) => void }) => (
    <nav aria-label="Files">{files.map(file => <button key={file} onClick={() => onFileSelect(file)}>{file}</button>)}</nav>
  ),
}))
vi.mock('./components/WorkshopControls', () => ({
  WorkshopButton: (props: ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />,
  WorkshopIconButton: (props: ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props} />,
}))

import GadgetCodeInterface from './GadgetCodeInterface'

describe('editor import failures', () => {
  it.each(['code', 'diff'] as const)('contains a rejected %s import without disposing code sync', async (kind) => {
    const container = document.createElement('div')
    document.body.append(container)
    const caught = vi.fn<() => void>()
    const root = createRoot(container, { onCaughtError: caught })
    let commitId = `error-${kind}`
    const files = new Map([['client.js', 'client'], ['server.js', 'server']])
    const overseer = {
      getCodeAtCommit: vi.fn<() => Promise<{ files: [string, string][] }>>(async () => ({ files: [...files] })),
    }
    const hasCode = vi.fn<(value: boolean) => void>()
    const render = (isVisible: boolean) => act(async () => {
      root.render(<>
        <button>Workspace chat</button>
        <GadgetCodeInterface overseer={overseer as never} workpieceId={1} headCommitId={commitId} isAgentActive={false}
          chatChanges={kind === 'diff' ? { chatId: 7, rowsThrough: 0 } : undefined}
          selectedChatId={kind === 'diff' ? 7 : null} isVisible={isVisible} onHasCodeChange={hasCode} />
      </>)
    })

    try {
      await render(false)
      expect(imports[kind].loads).toBe(0)
      expect(hasCode).toHaveBeenLastCalledWith(true)
      await render(true)
      await vi.waitFor(() => expect(imports[kind].loads).toBe(1))
      expect(container.textContent).toContain('Loading editor...')
      const chat = container.querySelector('button')
      const sidebar = container.querySelector('nav')

      await act(async () => { imports[kind].reject(new Error(`${kind} chunk unavailable`)) })
      expect(caught).toHaveBeenCalled()
      expect(container.querySelector('[role="alert"]')?.textContent).toContain('Reload the page to try again')
      expect(container.textContent).toContain('switching files cannot retry this load')
      expect(container.textContent).toContain('Reload page')
      expect(container.textContent).toContain('Reloading may lose unsent messages and unsaved changes.')
      expect(container.querySelector('button')).toBe(chat)
      expect(container.querySelector('nav')).toBe(sidebar)

      await act(async () => {
        sidebar!.querySelectorAll('button')[1].click()
      })
      expect(container.textContent).toContain('server.js')
      expect(container.querySelector('[aria-label="Download server.js"]')).not.toBeNull()
      expect(container.querySelector('[role="alert"]')).not.toBeNull()
      expect(imports[kind].loads).toBe(1)

      files.set('incoming.js', 'still syncing')
      commitId += '-next'
      await render(true)
      expect(container.querySelector('nav')!.textContent).toContain('incoming.js')
      expect(hasCode).toHaveBeenLastCalledWith(true)
      expect(overseer.getCodeAtCommit).toHaveBeenCalledTimes(2)
      await act(async () => root.render(null))
    } finally {
      act(() => root.unmount())
      container.remove()
    }
  })
})
