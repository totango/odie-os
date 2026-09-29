// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { Activity, act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const editor = vi.hoisted(() => ({ code: 0, diff: 0 }))
vi.mock('./features/code/CodeEditor', () => {
  editor.code++
  return { default: ({ text }: { text: string }) => <pre data-testid="code">{text}</pre> }
})
vi.mock('./features/code/CodeDiffEditor', () => {
  editor.diff++
  return { default: ({ text }: { text: string }) => <pre data-testid="diff">{text}</pre> }
})
vi.mock('@cloudflare/kumo', () => ({ useKumoToastManager: () => ({ add: vi.fn<() => void>() }) }))
vi.mock('./features/code/FileBrowser', () => ({ isOpenableKind: (kind: string) => kind === 'file' || kind === 'executable', default: ({ tree, onFileSelect }: {
  tree: { leaves: ReadonlyMap<string, string> }; onFileSelect: (file: string) => void;
}) => <nav>{[...tree.leaves.keys()].map(file => <button key={file} onClick={() => onFileSelect(file)}>{file}</button>)}</nav> }))
vi.mock('./components/WorkshopControls', () => ({
  WorkshopButton: (props: ComponentProps<'button'>) => <button {...props} />,
  WorkshopIconButton: (props: ComponentProps<'button'>) => <button {...props} />,
}))
import WorkpieceCodeInterface from './features/code/WorkpieceCodeInterface'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('Git code view lifecycle', () => {
  let root: Root
  let container: HTMLDivElement
  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('loads authoritative code while hidden and defers editor imports until visible', async () => {
    const listTree = vi.fn<() => Promise<object[]>>(async () => [{ name: 'client.js', kind: 'file' }])
    const readFilesAtCommit = vi.fn<() => Promise<unknown[]>>(async () => [['client.js', { kind: 'text', text: 'committed' }]])
    const onHasCodeChange = vi.fn<(value: boolean) => void>()
    const show = (isVisible: boolean) => act(async () => root.render(<WorkpieceCodeInterface
      overseer={{ listTree, readFilesAtCommit } as never} summary={{ id: 1, type: 'gadget', title: 'App', commitId: 'lazy-first' }}
      isVisible={isVisible} isAgentActive={false} onHasCodeChange={onHasCodeChange} />))
    await show(false)
    expect(onHasCodeChange).toHaveBeenLastCalledWith(true)
    expect(editor.code).toBe(0)
    expect(editor.diff).toBe(0)
    await show(true)
    await vi.waitFor(() => expect(container.querySelector('[data-testid="code"]')?.textContent).toBe('committed'))
    expect(listTree).toHaveBeenCalledTimes(1)
    expect(readFilesAtCommit).toHaveBeenCalledTimes(1)
  })

  it('retains selected file through Activity reveal and replaces immutable head content', async () => {
    const listTree = async () => [{ name: 'client.js', kind: 'file' }, { name: 'server.js', kind: 'file' }]
    const readFilesAtCommit = async (commit: string, paths: string[]) => paths.map(path => [path, { kind: 'text', text: path === 'client.js' ? 'client' : commit }])
    const overseer = { listTree, readFilesAtCommit }
    const show = (mode: 'visible' | 'hidden', headCommitId = 'lazy-head') => act(async () => root.render(
      <Activity mode={mode}><WorkpieceCodeInterface overseer={overseer as never} summary={{ id: 1, type: 'gadget', title: 'App', commitId: headCommitId }}
        isAgentActive={false} /></Activity>))
    await show('visible')
    await act(async () => container.querySelectorAll<HTMLButtonElement>('nav button')[1].click())
    await show('hidden')
    await show('visible')
    expect(container.querySelector('[data-testid="code"]')?.textContent).toBe('lazy-head')
    await show('visible', 'lazy-next')
    expect(container.querySelector('[data-testid="code"]')?.textContent).toBe('lazy-next')
  })

  it('distinguishes failed head reads from empty code and retries without reloading', async () => {
    const listTree = vi.fn<() => Promise<unknown[]>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce([])
    const onHasCodeChange = vi.fn<(value: boolean) => void>()
    await act(async () => root.render(<WorkpieceCodeInterface overseer={{ listTree } as never}
      summary={{ id: 1, type: 'gadget', title: 'App', commitId: 'lazy-retry' }} isAgentActive={false} onHasCodeChange={onHasCodeChange} />))
    expect(onHasCodeChange).not.toHaveBeenCalledWith(false)
    const retry = [...container.querySelectorAll('button')].find(button => /try again/i.test(button.textContent ?? ''))
    expect(retry).toBeDefined()
    await act(async () => retry!.click())
    expect(onHasCodeChange).toHaveBeenLastCalledWith(false)
    expect(container.textContent).toContain('No files yet')
  })
})
