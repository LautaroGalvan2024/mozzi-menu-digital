import { useQuery } from '@tanstack/react-query'
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
} from 'react'
import { z } from 'zod'
import { supabase } from '../../lib/supabase/client'
import { useAuth } from '../auth/AuthProvider'
import { resolveSelectedChoice } from './selection'

export interface RestaurantChoice {
  id: string
  name: string
  slug: string
  status: 'draft' | 'active' | 'suspended'
  role: 'restaurant_admin' | 'order_manager' | 'super_admin'
}

interface RestaurantScopeValue {
  choices: RestaurantChoice[]
  selected: RestaurantChoice | null
  selectRestaurant: (id: string) => void
  loading: boolean
}

const RestaurantScopeContext = createContext<RestaurantScopeValue | null>(null)
const STORAGE_KEY = 'mozzi:selected-restaurant'

const restaurantRowsSchema = z.array(
  z.object({
    id: z.string().uuid(),
    name: z.string(),
    slug: z.string(),
    status: z.enum(['draft', 'active', 'suspended']),
  }),
)

export function RestaurantScopeProvider({ children }: PropsWithChildren) {
  const auth = useAuth()
  const [selectedId, setSelectedId] = useState(() => localStorage.getItem(STORAGE_KEY))
  const superAdminEnabled = auth.isSuperAdmin && auth.assuranceLevel === 'aal2'
  const superAdminQuery = useQuery({
    queryKey: ['restaurant-scope-choices'],
    enabled: superAdminEnabled,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('restaurants')
        .select('id,name,slug,status')
        .order('name')
      if (error) throw new Error('No se pudieron cargar los restaurantes.')
      return restaurantRowsSchema.parse(data ?? []).map((restaurant) => ({
        ...restaurant,
        role: 'super_admin' as const,
      }))
    },
  })

  const memberChoices = useMemo<RestaurantChoice[]>(
    () =>
      auth.memberships
        .filter((membership) => membership.status === 'active')
        .map((membership) => ({
          id: membership.restaurantId,
          name: membership.restaurantName,
          slug: membership.restaurantSlug,
          status: membership.restaurantStatus,
          role: membership.role,
        })),
    [auth.memberships],
  )

  const choices = useMemo(
    () => auth.isSuperAdmin ? (superAdminQuery.data ?? []) : memberChoices,
    [auth.isSuperAdmin, memberChoices, superAdminQuery.data],
  )
  const selected = resolveSelectedChoice(choices, selectedId, auth.isSuperAdmin)

  useEffect(() => {
    if (selected && selected.id !== selectedId) {
      setSelectedId(selected.id)
      localStorage.setItem(STORAGE_KEY, selected.id)
    }
  }, [selected, selectedId])

  const value = useMemo<RestaurantScopeValue>(
    () => ({
      choices,
      selected,
      loading: superAdminEnabled && superAdminQuery.isLoading,
      selectRestaurant: (id) => {
        if (!choices.some((choice) => choice.id === id)) return
        setSelectedId(id)
        // This is a UI preference only. RLS never trusts it for authorization.
        localStorage.setItem(STORAGE_KEY, id)
      },
    }),
    [choices, selected, superAdminEnabled, superAdminQuery.isLoading],
  )
  return <RestaurantScopeContext.Provider value={value}>{children}</RestaurantScopeContext.Provider>
}

export function useRestaurantScope() {
  const value = useContext(RestaurantScopeContext)
  if (!value) throw new Error('useRestaurantScope requiere RestaurantScopeProvider')
  return value
}
