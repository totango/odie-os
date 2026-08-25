import { Link } from '@tanstack/react-router'
import { AppWindow, Blueprint } from '@phosphor-icons/react'

type LibrarySection = 'apps' | 'templates'
type TemplateView = 'featured' | 'yours'

const tabClass = (active: boolean) => [
  'press inline-flex h-9 items-center gap-2 rounded-lg px-3 text-[13px] font-medium transition-colors',
  active
    ? 'bg-kumo-contrast text-kumo-inverse'
    : 'text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default',
].join(' ')

const viewClass = (active: boolean) => [
  'press inline-flex h-8 items-center rounded-lg px-3 text-[12px] font-medium transition-colors',
  active
    ? 'bg-kumo-fill text-kumo-strong'
    : 'text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default',
].join(' ')

export default function LibraryHeader({
  section,
  templateView,
}: {
  section: LibrarySection
  templateView?: TemplateView
}) {
  return (
    <header className="px-3 pt-6 sm:pt-10">
      <h1 className="text-2xl font-semibold tracking-tight text-kumo-default">Library</h1>
      <p className="mt-1 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle">
        Build apps for your work, or start from a reusable template.
      </p>
      <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-b border-kumo-line pb-3">
        <nav className="flex items-center gap-1" aria-label="Library sections">
          <Link
            to="/outputs"
            search={{ createBlueprint: undefined }}
            aria-current={section === 'apps' ? 'page' : undefined}
            className={tabClass(section === 'apps')}
          >
            <AppWindow size={15} /> Apps
          </Link>
          <Link
            to="/explore"
            aria-current={section === 'templates' ? 'page' : undefined}
            className={tabClass(section === 'templates')}
          >
            <Blueprint size={15} /> Templates
          </Link>
        </nav>
        {section === 'templates' && (
          <nav className="flex items-center gap-1" aria-label="Template views">
            <Link
              to="/explore"
              aria-current={templateView === 'featured' ? 'page' : undefined}
              className={viewClass(templateView === 'featured')}
            >
              Featured
            </Link>
            <Link
              to="/blueprints"
              aria-current={templateView === 'yours' ? 'page' : undefined}
              className={viewClass(templateView === 'yours')}
            >
              Yours
            </Link>
          </nav>
        )}
      </div>
    </header>
  )
}
