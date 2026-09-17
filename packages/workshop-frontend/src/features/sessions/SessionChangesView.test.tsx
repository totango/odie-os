// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { EditorView } from '@codemirror/view'
import { EditorState } from '@codemirror/state'
import { expect, it, vi } from 'vitest'
import { SessionChangesView } from './SessionChangesView'
import { parseOpenCodeChanges } from './openCodeChanges'

vi.mock('../../ThemeContext', () => ({ useTheme: () => ({ resolvedThemeMode: 'light' }) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

it('renders pinned runtime patches read-only and navigates to omitted files without inventing content', async () => {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  const changes = parseOpenCodeChanges([
    { file: 'a.ts', additions: 1, deletions: 1, status: 'modified', patch: '@@ -1 +1 @@\n-old\n+new\n' },
    { file: 'b.png', additions: 0, deletions: 0, patch: 'Binary files a/b.png and b/b.png differ' },
  ])
  try {
    await act(async () => root.render(<SessionChangesView changes={changes} loading={false} />))
    const view = EditorView.findFromDOM(container.querySelector('.cm-editor') as HTMLElement)!
    expect(view.state.doc.toString()).toBe('@@ -1 +1 @@\n-old\n+new\n')
    expect(view.state.facet(EditorState.readOnly)).toBe(true)
    expect(view.state.facet(EditorView.editable)).toBe(false)
    await act(async () => [...container.querySelectorAll('button')].find(button => button.textContent === 'Next file')!.click())
    expect(container.textContent).toContain('Binary changes cannot be displayed')
    expect(container.querySelector('.cm-editor')).toBeNull()
    await act(async () => root.render(<SessionChangesView loading={false} error="Diff unavailable" />))
    expect(container.querySelector('[role="alert"]')?.textContent).toBe('Diff unavailable')
    expect(container.textContent).not.toContain('No changes.')
  } finally {
    await act(async () => root.unmount())
    container.remove()
  }
})
