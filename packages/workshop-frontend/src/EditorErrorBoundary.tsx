import { Component, type ReactNode } from 'react'
import { WorkshopButton } from './components/WorkshopControls'

export default class EditorErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError() { return { failed: true } }

  render() {
    if (!this.state.failed) return this.props.children
    return <div role="alert" className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-kumo-subtle">
      <p>The code editor could not load. Reload the page to try again; switching files cannot retry this load.</p>
      <p>Reloading may lose unsent messages and unsaved changes. Download your files and copy your draft before reloading.</p>
      <WorkshopButton onClick={() => window.location.reload()}>Reload page</WorkshopButton>
    </div>
  }
}
