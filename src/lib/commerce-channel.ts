import { useLocation } from 'react-router'

export type CommerceChannel = 'menu' | 'store'

export function channelFromPath(pathname: string): CommerceChannel {
  return pathname.startsWith('/t/') ? 'store' : 'menu'
}

export function useCommerceChannel(): CommerceChannel {
  return channelFromPath(useLocation().pathname)
}

export function commercePath(slug: string, channel: CommerceChannel = 'menu', suffix = '') {
  return `/${channel === 'store' ? 't' : 'r'}/${encodeURIComponent(slug)}${suffix}`
}

/** Menu keys intentionally keep their original spelling for existing carts/retries. */
export function commerceStorageKey(prefix: string, slug: string, channel: CommerceChannel = 'menu') {
  return `mozzi:${prefix}:${channel === 'store' ? 'store:' : ''}${slug}`
}
