import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, waitFor } from '@testing-library/react'
import type { AuthChangeEvent, Session } from '@supabase/supabase-js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AuthProvider, useAuth } from './AuthProvider'

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  onAuthStateChange: vi.fn(),
  unsubscribe: vi.fn(),
  rpc: vi.fn(),
  from: vi.fn(),
  assurance: vi.fn(),
  callback: null as ((event: AuthChangeEvent, session: Session | null) => void) | null,
}))

vi.mock('../../lib/env', () => ({
  env: { isSupabaseConfigured: true },
}))

vi.mock('../../lib/supabase/client', () => ({
  supabase: {
    auth: {
      getSession: mocks.getSession,
      onAuthStateChange: mocks.onAuthStateChange,
      mfa: { getAuthenticatorAssuranceLevel: mocks.assurance },
      signOut: vi.fn(),
    },
    from: mocks.from,
    rpc: mocks.rpc,
  },
}))

function Probe() {
  const auth = useAuth()
  return <span>{auth.loading ? 'loading' : auth.user?.id ?? 'anonymous'}</span>
}

describe('AuthProvider initialization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.callback = null
    mocks.onAuthStateChange.mockImplementation((callback) => {
      mocks.callback = callback
      return { data: { subscription: { unsubscribe: mocks.unsubscribe } } }
    })
    mocks.from.mockImplementation((table: string) => {
      if (table === 'profiles') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  id: '10000000-0000-4000-8000-000000000001',
                  full_name: 'Admin',
                  email: 'admin@example.com',
                  active: true,
                },
                error: null,
              }),
            }),
          }),
        }
      }
      return {
        select: () => ({
          eq: async () => ({ data: [], error: null }),
        }),
      }
    })
    mocks.rpc.mockResolvedValue({
      data: {
        userId: '10000000-0000-4000-8000-000000000001',
        isSuperAdmin: false,
        aal: 'aal1',
        memberships: [],
      },
      error: null,
    })
    mocks.assurance.mockResolvedValue({ data: { currentLevel: 'aal1' }, error: null })
  })

  it('uses INITIAL_SESSION as the single access bootstrap', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <AuthProvider><Probe /></AuthProvider>
      </QueryClientProvider>,
    )
    const session = {
      user: { id: '10000000-0000-4000-8000-000000000001' },
    } as Session

    await act(async () => {
      mocks.callback?.('INITIAL_SESSION', session)
    })
    await waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(1))

    await act(async () => {
      mocks.callback?.('SIGNED_IN', session)
    })
    await new Promise((resolve) => window.setTimeout(resolve, 0))

    expect(mocks.getSession).not.toHaveBeenCalled()
    expect(mocks.rpc).toHaveBeenCalledTimes(1)
  })
})
