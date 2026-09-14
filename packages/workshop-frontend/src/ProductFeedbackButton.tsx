import { ChatCenteredDots } from '@phosphor-icons/react'
import SidebarItem from './components/AppShell/SidebarItem'

/** Primary navigation entry for the authenticated feature request board. */
export default function ProductFeedbackButton({ collapsed = false }: { collapsed?: boolean }) {
  return <SidebarItem
    to="/requests"
    label="Feature requests"
    icon={<ChatCenteredDots size={14} weight="regular" />}
    matchPrefix
    collapsed={collapsed}
  />
}
