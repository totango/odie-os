import { useEffect, useState } from 'react'
import { RpcTarget } from 'capnweb'
import type { ConnectedAccountsSubscriber } from '@gadgets/workshop-shared/api'
import type { AccountDescription, SupportedResource, VendorDescription } from '@gadgets/workshop-shared/gatekeeper'
import { useAuthenticatedApi } from '../AuthContext'

export type GitHubConnectionState =
  | { state: 'loading' }
  | { state: 'missing' }
  | { state: 'connected'; accountId: number; label: string }
  | { state: 'expired'; accountId: number; label: string }

export function useGitHubConnection(): GitHubConnectionState {
  const { authenticatedApi } = useAuthenticatedApi()
  const [status, setStatus] = useState<GitHubConnectionState>({ state: 'loading' })

  useEffect(() => {
    let cancelled = false
    let subscription: { [Symbol.dispose](): void } | null = null
    const accounts = new Map<number, { label: string; valid: boolean }>()

    const publish = (ready = false) => {
      if (cancelled) return
      const valid = [...accounts].find(([, account]) => account.valid)
      if (valid) {
        setStatus({ state: 'connected', accountId: valid[0], label: valid[1].label })
        return
      }
      const expired = accounts.entries().next().value as [number, { label: string; valid: boolean }] | undefined
      if (expired) {
        setStatus({ state: 'expired', accountId: expired[0], label: expired[1].label })
      } else if (ready) {
        setStatus({ state: 'missing' })
      }
    }

    class GitHubSubscriber extends RpcTarget implements ConnectedAccountsSubscriber {
      add(
        id: number,
        description: AccountDescription,
        vendor: VendorDescription,
        _supportedResources: SupportedResource[] = [],
        credentialsValid = true,
        vendorId = '',
      ) {
        if (vendorId !== 'github') return
        accounts.set(id, {
          label: description.uniqueName ?? description.displayName ?? vendor.displayName,
          valid: credentialsValid,
        })
        publish()
      }

      remove(id: number) {
        accounts.delete(id)
        publish(true)
      }

      ready() {
        publish(true)
      }
    }

    authenticatedApi.subscribeConnectedAccounts(new GitHubSubscriber()).then((stub) => {
      if (cancelled) stub[Symbol.dispose]()
      else subscription = stub
    }).catch(() => {
      if (!cancelled) setStatus({ state: 'missing' })
    })

    return () => {
      cancelled = true
      subscription?.[Symbol.dispose]()
    }
  }, [authenticatedApi])

  return status
}
