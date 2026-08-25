import { createFileRoute } from '@tanstack/react-router'
import BlueprintList from '../components/BlueprintList'
import { useDocumentTitle } from '../useDocumentTitle'
import LibraryHeader from '../components/library/LibraryHeader'

/**
 * "Blueprints" — the user's own + saved blueprints, laid out like the Workspaces page. Discovering
 * new blueprints lives on the separate Explore page, linked from the list's toolbar (alongside
 * Upload, so the two actions line up) and from the rail's bottom nav.
 */
export const Route = createFileRoute('/blueprints')({
  component: BlueprintsRoutePage,
})

function BlueprintsRoutePage() {
  useDocumentTitle('Templates')
  return (
    <div className="mx-auto flex h-full w-full max-w-5xl flex-col px-3 sm:px-10">
      <LibraryHeader section="templates" templateView="yours" />
      <div className="min-h-0 flex-1">
        <BlueprintList />
      </div>
    </div>
  )
}
