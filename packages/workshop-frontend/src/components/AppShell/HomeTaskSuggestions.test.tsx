// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import HomeTaskSuggestions from './HomeTaskSuggestions'
import { CREATE_JIRA_ISSUE_PROMPT } from '../../createJiraIssuePrompt'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('HomeTaskSuggestions', () => {
  let container: HTMLDivElement | undefined
  let root: Root | undefined

  afterEach(async () => {
    await act(async () => root?.unmount())
    container?.remove()
    vi.clearAllMocks()
  })

  async function render(onPick = vi.fn<(prompt: string) => void>(), hub: 'ops' | 'revenue' | 'support' = 'ops') {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<HomeTaskSuggestions hub={hub} onPick={onPick} />))
    return { container, onPick }
  }

  it('renders the stable task suggestions', async () => {
    const { container: rendered } = await render()

    expect(rendered.textContent).toContain('Ask about the codebase')
    expect(rendered.textContent).toContain('Investigate a bug')
    expect(rendered.textContent).toContain('Create Jira issue')
    expect(rendered.textContent).not.toContain('Draft Jira from Zendesk')
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

  it('uses the shared approval-backed Jira creation prompt', async () => {
    const { container: rendered, onPick } = await render()
    const button = Array.from(rendered.querySelectorAll('button')).find((candidate) =>
      candidate.textContent?.includes('Create Jira issue'),
    )
    expect(button).toBeTruthy()

    await act(async () => button!.click())

    expect(onPick).toHaveBeenCalledWith(CREATE_JIRA_ISSUE_PROMPT)
    expect(CREATE_JIRA_ISSUE_PROMPT).toContain('project')
    expect(CREATE_JIRA_ISSUE_PROMPT).toContain('jira_create_issue')
    expect(CREATE_JIRA_ISSUE_PROMPT).toContain('Do not request or connect a generic Atlassian MCP')
    expect(CREATE_JIRA_ISSUE_PROMPT).toContain('retain the draft')
    expect(CREATE_JIRA_ISSUE_PROMPT).toContain('requestConnection only for the native Jira site or project resource')
  })

  it('offers internal account research in the revenue hub', async () => {
    const { container: rendered } = await render(undefined, 'revenue')

    expect(rendered.textContent).toContain('Build an account brief')
    expect(rendered.textContent).toContain('Prepare for a customer call')
  })
})
