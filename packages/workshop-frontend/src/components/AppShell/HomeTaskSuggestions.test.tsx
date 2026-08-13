// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import HomeTaskSuggestions from './HomeTaskSuggestions'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('HomeTaskSuggestions', () => {
  let container: HTMLDivElement | undefined
  let root: Root | undefined

  afterEach(async () => {
    await act(async () => root?.unmount())
    container?.remove()
    vi.clearAllMocks()
  })

  async function render(onPick = vi.fn<(prompt: string) => void>()) {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<HomeTaskSuggestions onPick={onPick} />))
    return { container, onPick }
  }

  it('renders the stable task suggestions', async () => {
    const { container: rendered } = await render()

    expect(rendered.textContent).toContain('Ask about the codebase')
    expect(rendered.textContent).toContain('Investigate a bug')
    expect(rendered.textContent).toContain('Create Jira from Zendesk')
    expect(rendered.textContent).toContain('Summarize customer impact')
    expect(rendered.querySelectorAll('button')).toHaveLength(4)
  })

  it('only reports the picked prompt to the caller', async () => {
    const { container: rendered, onPick } = await render()
    const button = Array.from(rendered.querySelectorAll('button')).find((candidate) =>
      candidate.textContent?.includes('Investigate a bug'),
    )
    expect(button).toBeTruthy()

    await act(async () => button!.click())

    expect(onPick).toHaveBeenCalledOnce()
    expect(onPick.mock.calls[0]?.[0]).toContain('Investigate a bug in the codebase')
  })
})
