import { z } from 'zod'
import { supabase } from '../../lib/supabase/client'

const profileRowsSchema = z.array(z.object({
  id: z.string().uuid(),
  full_name: z.string(),
  email: z.string(),
  active: z.boolean(),
  created_at: z.string(),
}))

const platformRoleRowsSchema = z.array(z.object({
  user_id: z.string().uuid(),
  role: z.literal('super_admin'),
}))

const membershipRowsSchema = z.array(z.object({
  user_id: z.string().uuid(),
  role: z.enum(['restaurant_admin', 'order_manager']),
  status: z.enum(['invited', 'active', 'suspended']),
  restaurants: z.object({ name: z.string() }).nullable(),
}))

type ProfileRow = z.infer<typeof profileRowsSchema>[number]
type PlatformRoleRow = z.infer<typeof platformRoleRowsSchema>[number]
type MembershipRow = z.infer<typeof membershipRowsSchema>[number]

export type PlatformDirectoryUser = ProfileRow & {
  platform_user_roles: Array<Pick<PlatformRoleRow, 'role'>>
  restaurant_members: Array<Omit<MembershipRow, 'user_id'>>
}

export function mergePlatformDirectory(
  profiles: ProfileRow[],
  roles: PlatformRoleRow[],
  memberships: MembershipRow[],
): PlatformDirectoryUser[] {
  const rolesByUser = new Map<string, Array<Pick<PlatformRoleRow, 'role'>>>()
  for (const { user_id: userId, role } of roles) {
    const entries = rolesByUser.get(userId) ?? []
    entries.push({ role })
    rolesByUser.set(userId, entries)
  }

  const membershipsByUser = new Map<string, Array<Omit<MembershipRow, 'user_id'>>>()
  for (const { user_id: userId, ...membership } of memberships) {
    const entries = membershipsByUser.get(userId) ?? []
    entries.push(membership)
    membershipsByUser.set(userId, entries)
  }

  return profiles.map((profile) => ({
    ...profile,
    platform_user_roles: rolesByUser.get(profile.id) ?? [],
    restaurant_members: membershipsByUser.get(profile.id) ?? [],
  }))
}

export async function listPlatformDirectoryUsers(): Promise<PlatformDirectoryUser[]> {
  const [profilesResult, rolesResult, membershipsResult] = await Promise.all([
    supabase.from('profiles').select('id,full_name,email,active,created_at').order('created_at', { ascending: false }),
    supabase.from('platform_user_roles').select('user_id,role'),
    supabase.from('restaurant_members').select('user_id,role,status,restaurants(name)'),
  ])

  if (profilesResult.error || rolesResult.error || membershipsResult.error) {
    throw new Error('No se pudieron cargar los usuarios.')
  }

  const profiles = profileRowsSchema.safeParse(profilesResult.data)
  const roles = platformRoleRowsSchema.safeParse(rolesResult.data)
  const memberships = membershipRowsSchema.safeParse(membershipsResult.data)
  if (!profiles.success || !roles.success || !memberships.success) {
    throw new Error('No se pudieron cargar los usuarios.')
  }

  return mergePlatformDirectory(
    profiles.data,
    roles.data,
    memberships.data,
  )
}
