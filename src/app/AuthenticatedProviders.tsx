import { QueryClientProvider, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import { Outlet } from 'react-router'
import { AuthProvider } from '../features/auth/AuthProvider'
import { syncCatalogInvalidations } from '../lib/catalog-cache'
import { createAppQueryClient } from './query-client'

const authenticatedQueryClient = createAppQueryClient()

function CatalogCacheSync() {
  const client = useQueryClient()
  useEffect(() => syncCatalogInvalidations(client), [client])
  return null
}

export function AuthenticatedProviders() {
  return (
    <QueryClientProvider client={authenticatedQueryClient}>
      <CatalogCacheSync />
      <AuthProvider>
        <Outlet />
      </AuthProvider>
    </QueryClientProvider>
  )
}
