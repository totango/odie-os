import { ODIE_PRODUCTION_ORIGIN } from './WorkshopRuntime'

export type NativeDeepLink =
  | { kind: 'spa-route'; path: string }
  | { kind: 'oauth-return'; handle: string }

const CLAIMED_STATIC_PATHS = new Set([
  '/',
  '/admin',
  '/blueprints',
  '/context',
  '/explore',
  '/gatekeepers',
  '/getting-started',
  '/outputs',
  '/profile',
  '/providers',
  '/sessions',
  '/signup',
  '/workspaces',
])

const CLAIMED_PREFIXES = ['/gatekeepers/', '/blueprint/', '/gadget/', '/workspace/']
const EXCLUDED_PREFIXES = ['/api', '/blueprint-screenshot', '/gatekeeper/', '/.well-known/', '/native/oauth-start/', '/assets/']
const OAUTH_RETURN_PREFIX = '/native/oauth-return/'
const MAX_DEEP_LINK_LENGTH = 4096
const SHARE_FRAGMENT_PATTERN = /^#share=[A-Za-z0-9_-]{16,512}$/

function parseShareFragment(hash: string, path: string): string | null {
  if (!hash) return ''
  if (!path.startsWith('/workspace/')) return null
  return SHARE_FRAGMENT_PATTERN.test(hash) ? hash : null
}

export function parseNativeDeepLink(rawUrl: string, expectedOrigin = ODIE_PRODUCTION_ORIGIN): NativeDeepLink | null {
  if (rawUrl.length > MAX_DEEP_LINK_LENGTH) return null
  let url: URL
  let expected: URL
  try {
    url = new URL(rawUrl)
    expected = new URL(expectedOrigin)
  } catch {
    return null
  }

  if (url.protocol !== 'https:' || url.origin !== expected.origin) return null
  if (url.username || url.password) return null

  const path = url.pathname || '/'
  if (EXCLUDED_PREFIXES.some(prefix => path === prefix.slice(0, -1) || path.startsWith(prefix))) return null

  if (path.startsWith(OAUTH_RETURN_PREFIX)) {
    if (url.hash) return null
    let handle: string
    try {
      handle = decodeURIComponent(path.slice(OAUTH_RETURN_PREFIX.length))
    } catch {
      return null
    }
    if (!/^[A-Za-z0-9_-]{16,256}$/.test(handle)) return null
    return { kind: 'oauth-return', handle }
  }

  const shareFragment = parseShareFragment(url.hash, path)
  if (url.hash && !shareFragment) return null

  if (CLAIMED_STATIC_PATHS.has(path) || CLAIMED_PREFIXES.some(prefix => path.startsWith(prefix))) {
    return { kind: 'spa-route', path: `${path}${url.search}${shareFragment ?? ''}` }
  }

  return null
}

export const verifiedLinkMatrix = {
  claimed: [...CLAIMED_STATIC_PATHS, ...CLAIMED_PREFIXES.map(prefix => `${prefix}*`), `${OAUTH_RETURN_PREFIX}*`],
  excluded: ['/api', '/api/*', '/blueprint-screenshot', '/blueprint-screenshot/*', '/gatekeeper/*', '/.well-known/*', '/assets/*', '/native/oauth-start/*'],
}
