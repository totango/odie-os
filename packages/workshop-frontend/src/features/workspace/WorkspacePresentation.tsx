import { Activity, useState, type ReactNode } from 'react'

/** Mounted within the principal-keyed AuthProvider and keyed again by workspace. Transport
 * absence hides the last presentation and tears down its effects. Fresh children replace
 * the old props before Activity reconnects the effects; old capabilities never resume. */
export const WorkspacePresentation = ({ children, fallback }: {
  children?: ReactNode; fallback?: ReactNode
}) => {
  const [retained, setRetained] = useState(children)
  if (children !== undefined && children !== retained) setRetained(children)
  return <>
    <Activity mode={children === undefined ? 'hidden' : 'visible'}>{children ?? retained}</Activity>
    {children === undefined && fallback}
  </>
}
