// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { Activity, act, useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { WorkspacePresentation } from './WorkspacePresentation'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('retains DOM through transport loss and resumes effects with only the new authority', async () => {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const first = vi.fn<() => void>()
  const second = vi.fn<() => void>()
  const disposed = vi.fn<() => void>()
  const Probe = ({ connect }: { connect: () => void }) => {
    useEffect(() => { connect(); return disposed }, [connect])
    return <textarea defaultValue="draft" />
  }
  const show = (connect?: () => void, key = 'workspace-a', mode: 'visible' | 'hidden' = 'visible') =>
    act(async () => root.render(<Activity mode={mode}><WorkspacePresentation key={key} fallback={<p>Reconnecting</p>}>
      {connect ? <Probe connect={connect} /> : undefined}
    </WorkspacePresentation></Activity>))
  try {
    await show(first)
    const textarea = container.querySelector('textarea')!
    textarea.value = 'unsaved draft'
    textarea.setSelectionRange(2, 5)
    await show(first, 'workspace-a', 'hidden')
    await show()
    expect(first).toHaveBeenCalledOnce()
    expect(disposed).toHaveBeenCalledOnce()
    await show(second)
    expect(container.querySelector('textarea')).toBe(textarea)
    expect(textarea.value).toBe('unsaved draft')
    expect(textarea.selectionStart).toBe(2)
    expect(second).toHaveBeenCalledOnce()
    expect(first).toHaveBeenCalledOnce()
    await show(second, 'workspace-b')
    expect(container.querySelector('textarea')).not.toBe(textarea)
    expect(container.querySelector('textarea')!.value).toBe('draft')
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
})
