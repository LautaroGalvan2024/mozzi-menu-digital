import type { Session, User } from '@supabase/supabase-js'
import { useQueryClient } from '@tanstack/react-query'
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PropsWithChildren,
} from 'react'
import { z } from 'zod'
import { env } from '../../lib/env'
import { supabase } from '../../lib/supabase/client'
import type { Membership, Profile } from '../../types/domain'

const profileSchema = z.object({
  id: z.string().uuid(),
  full_name: z.string(),
  email: z.string(),
  active: z.boolean(),
})

const membershipSchema = z.object({
  id: z.string().uuid(),
  restaurant_id: z.string().uuid(),
  role: z.enum(['restaurant_admin', 'order_manager']),
  status: z.enum(['invited', 'active', 'suspended']),
  restaurants: z.object({
    id: z.string().uuid(),
    name: z.string(),
    slug: z.string(),
    status: z.enum(['draft', 'active', 'suspended']),
  }),
})

const actorAuthorizationSchema = z.object({
  userId: z.string().uuid(),
  isSuperAdmin: z.boolean(),
  aal: z.enum(['aal1', 'aal2']).nullable().optional(),
  memberships: z.array(
    z.object({
      restaurantId: z.string().uuid(),
      role: z.enum(['restaurant_admin', 'order_manager']),
      status: z.enum(['invited', 'active', 'suspended']),
    }),
  ),
})

interface AuthContextValue {
  session: Session | null
  user: User | null
  profile: Profile | null
  memberships: Membership[]
  isSuperAdmin: boolean
  assuranceLevel: 'aal1' | 'aal2' | null
  accessError: string | null
  loading: boolean
  refreshAccess: () => Promise<void>
  signOut: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

function normalizeAssuranceLevel(value: unknown): 'aal1' | 'aal2' | null {
  if (value === 'aal1') return 'aal1'
  if (value === 'aal2') return 'aal2'
  return null
}

export function AuthProvider({ children }: PropsWithChildren) {
  const queryClient = useQueryClient()
  const accessRequest = useRef(0)
  const principalId = useRef<string | null>(null)
  const [session, setSession] = useState<Session | null>(null)
  const [profile, setProfile] = useState<Profile | null>(null)
  const [memberships, setMemberships] = useState<Membership[]>([])
  const [isSuperAdmin, setIsSuperAdmin] = useState(false)
  const [assuranceLevel, setAssuranceLevel] = useState<'aal1' | 'aal2' | null>(
    null,
  )
  const [accessError, setAccessError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const loadAccess = useCallback(async (activeSession: Session | null) => {
    const requestId = ++accessRequest.current
    if (!activeSession || !env.isSupabaseConfigured) {
      setProfile(null)
      setMemberships([])
      setIsSuperAdmin(false)
      setAssuranceLevel(null)
      setAccessError(null)
      setLoading(false)
      return
    }

    setLoading(true)
    setAccessError(null)
    const [profileResult, membershipsResult, authorizationResult, aalResult] =
      await Promise.all([
        supabase
          .from('profiles')
          .select('id,full_name,email,active')
          .eq('id', activeSession.user.id)
          .maybeSingle(),
        supabase
          .from('restaurant_members')
          .select(
            'id,restaurant_id,role,status,restaurants!inner(id,name,slug,status)',
          )
          .eq('user_id', activeSession.user.id),
        supabase.rpc('get_actor_authorization'),
        supabase.auth.mfa.getAuthenticatorAssuranceLevel(),
      ])

    if (requestId !== accessRequest.current) return

    const parsedProfile = profileSchema.safeParse(profileResult.data)
    setProfile(
      parsedProfile.success
        ? {
            id: parsedProfile.data.id,
            fullName: parsedProfile.data.full_name,
            email: parsedProfile.data.email,
            active: parsedProfile.data.active,
          }
        : null,
    )

    const parsedAuthorization = actorAuthorizationSchema.safeParse(
      authorizationResult.data,
    )
    const authorizationIsValid =
      parsedAuthorization.success &&
      parsedAuthorization.data.userId === activeSession.user.id
    const parsedMemberships = z.array(membershipSchema).safeParse(
      membershipsResult.data ?? [],
    )
    const authorizationFailed = Boolean(
      profileResult.error ||
        membershipsResult.error ||
        authorizationResult.error ||
        aalResult.error ||
        !authorizationIsValid ||
        !parsedMemberships.success,
    )

    const authorizedMemberships = authorizationIsValid
      ? parsedAuthorization.data.memberships
      : []
    setMemberships(
      parsedMemberships.success && authorizationIsValid
        ? parsedMemberships.data
            .filter((membership) =>
              authorizedMemberships.some(
                (authorized) =>
                  authorized.restaurantId === membership.restaurant_id &&
                  authorized.role === membership.role &&
                  authorized.status === membership.status,
              ),
            )
            .map((membership) => ({
              id: membership.id,
              restaurantId: membership.restaurant_id,
              restaurantName: membership.restaurants.name,
              restaurantSlug: membership.restaurants.slug,
              restaurantStatus: membership.restaurants.status,
              role: membership.role,
              status: membership.status,
            }))
        : [],
    )
    setIsSuperAdmin(
      authorizationIsValid && parsedAuthorization.data.isSuperAdmin,
    )
    const apiAssuranceLevel = normalizeAssuranceLevel(
      aalResult.data?.currentLevel,
    )
    const snapshotAssuranceLevel = authorizationIsValid
      ? normalizeAssuranceLevel(parsedAuthorization.data.aal)
      : null
    setAssuranceLevel(
      apiAssuranceLevel === 'aal2' && snapshotAssuranceLevel === 'aal2'
        ? 'aal2'
        : apiAssuranceLevel === 'aal1' || snapshotAssuranceLevel === 'aal1'
          ? 'aal1'
          : null,
    )
    setAccessError(
      authorizationFailed && parsedProfile.data?.active
        ? 'No pudimos verificar tus permisos. Reintentá antes de continuar.'
        : null,
    )
    setLoading(false)
  }, [])

  useEffect(() => {
    let mounted = true
    void supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return
      const nextPrincipalId = data.session?.user.id ?? null
      if (principalId.current !== nextPrincipalId) queryClient.clear()
      principalId.current = nextPrincipalId
      setSession(data.session)
      void loadAccess(data.session)
    })
    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      const nextPrincipalId = nextSession?.user.id ?? null
      if (principalId.current !== nextPrincipalId) {
        queryClient.clear()
        setProfile(null)
        setMemberships([])
        setIsSuperAdmin(false)
        setAssuranceLevel(null)
        setAccessError(null)
      }
      principalId.current = nextPrincipalId
      setLoading(true)
      setSession(nextSession)
      window.setTimeout(() => void loadAccess(nextSession), 0)
    })
    return () => {
      mounted = false
      data.subscription.unsubscribe()
    }
  }, [loadAccess, queryClient])

  const value = useMemo<AuthContextValue>(
    () => ({
      session,
      user: session?.user ?? null,
      profile,
      memberships,
      isSuperAdmin,
      assuranceLevel,
      accessError,
      loading,
      refreshAccess: () => loadAccess(session),
      signOut: async () => {
        await supabase.auth.signOut()
      },
    }),
    [
      assuranceLevel,
      accessError,
      isSuperAdmin,
      loadAccess,
      loading,
      memberships,
      profile,
      session,
    ],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth debe usarse dentro de AuthProvider')
  return value
}
