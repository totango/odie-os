// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { Activity, act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const editor = vi.hoisted(() => ({ code: 0, diff: 0 }))
vi.mock('./CodeEditor', () => {
  editor.code++
  return { default: ({ text }: { text: string }) => <pre data-testid="code">{text}</pre> }
})
vi.mock('./CodeDiffEditor', () => {
  editor.diff++
  return { default: ({ text }: { text: string }) => <pre data-testid="diff">{text}</pre> }
})
vi.mock('@cloudflare/kumo', () => ({ useKumoToastManager: () => ({ add: vi.fn<() => void>() }) }))
vi.mock('./FileSidebar', () => ({ default: ({ files, onFileSelect }: {
  files: string[]; onFileSelect: (file: string) => void;
}) => <nav>{files.map(file => <button key={file} onClick={() => onFileSelect(file)}>{file}</button>)}</nav> }))
vi.mock('./components/WorkshopControls', () => ({
  WorkshopButton: (props: ComponentProps<'button'>) => <button {...props} />,
  WorkshopIconButton: (props: ComponentProps<'button'>) => <button {...props} />,
}))
import GadgetCodeInterface from './GadgetCodeInterface'

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
    const getCodeAtCommit = vi.fn<() => Promise<{ files: string[][] }>>(async () => ({ files: [['client.js', 'committed']] }))
    const onHasCodeChange = vi.fn<(value: boolean) => void>()
    const show = (isVisible: boolean) => act(async () => root.render(<GadgetCodeInterface
      overseer={{ getCodeAtCommit } as never} workpieceId={1} headCommitId="lazy-first"
      isVisible={isVisible} isAgentActive={false} onHasCodeChange={onHasCodeChange} />))
    await show(false)
    expect(onHasCodeChange).toHaveBeenLastCalledWith(true)
    expect(editor.code).toBe(0)
    expect(editor.diff).toBe(0)
    await show(true)
    await vi.waitFor(() => expect(container.querySelector('[data-testid="code"]')?.textContent).toBe('committed'))
    expect(getCodeAtCommit).toHaveBeenCalledTimes(1)
  })

  it('retains selected file through Activity reveal and replaces immutable head content', async () => {
    const getCodeAtCommit = vi.fn<(commit: string) => Promise<{ files: string[][] }>>(async (commit: string) => ({ files: [
      ['client.js', 'client'], ['server.js', commit],
    ] }))
    const overseer = { getCodeAtCommit }
    const show = (mode: 'visible' | 'hidden', headCommitId = 'lazy-head') => act(async () => root.render(
      <Activity mode={mode}><GadgetCodeInterface overseer={overseer as never} workpieceId={1}
        headCommitId={headCommitId} isAgentActive={false} /></Activity>))
    await show('visible')
    await act(async () => container.querySelectorAll<HTMLButtonElement>('nav button')[1].click())
    await show('hidden')
    await show('visible')
    expect(container.querySelector('[data-testid="code"]')?.textContent).toBe('lazy-head')
    await show('visible', 'lazy-next')
    expect(container.querySelector('[data-testid="code"]')?.textContent).toBe('lazy-next')
  })

  it('distinguishes failed head reads from empty code and retries without reloading', async () => {
    const getCodeAtCommit = vi.fn<() => Promise<{ files: string[][] }>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ files: [] })
    const onHasCodeChange = vi.fn<(value: boolean) => void>()
    await act(async () => root.render(<GadgetCodeInterface overseer={{ getCodeAtCommit } as never}
      workpieceId={1} headCommitId="lazy-retry" isAgentActive={false} onHasCodeChange={onHasCodeChange} />))
    expect(onHasCodeChange).not.toHaveBeenCalledWith(false)
    const retry = [...container.querySelectorAll('button')].find(button => /try again/i.test(button.textContent ?? ''))
    expect(retry).toBeDefined()
    await act(async () => retry!.click())
    expect(onHasCodeChange).toHaveBeenLastCalledWith(false)
    expect(container.textContent).toContain('No files yet')
  })
})
