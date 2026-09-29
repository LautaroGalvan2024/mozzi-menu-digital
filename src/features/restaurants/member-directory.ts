import { z } from 'zod'
import { supabase } from '../../lib/supabase/client'

const memberRowsSchema = z.array(z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  role: z.enum(['restaurant_admin', 'order_manager']),
  status: z.enum(['invited', 'active', 'suspended']),
  created_at: z.string(),
}))

const profileRowsSchema = z.array(z.object({
  id: z.string().uuid(),
  full_name: z.string(),
  email: z.string(),
  active: z.boolean(),
}))

type MemberRow = z.infer<typeof memberRowsSchema>[number]
type ProfileRow = z.infer<typeof profileRowsSchema>[number]

export type RestaurantMemberWithProfile = MemberRow & {
  profiles: Omit<ProfileRow, 'id'> | null
}

export function mergeRestaurantMembersWithProfiles(
  members: MemberRow[],
  profiles: ProfileRow[],
): RestaurantMemberWithProfile[] {
  const profilesById = new Map(profiles.map(({ id, ...profile }) => [id, profile]))
  return members.map((member) => ({
    ...member,
    profiles: profilesById.get(member.user_id) ?? null,
  }))
}

export async function listRestaurantMembers(restaurantId: string): Promise<RestaurantMemberWithProfile[]> {
  const { data: memberData, error: membersError } = await supabase
    .from('restaurant_members')
    .select('id,user_id,role,status,created_at')
    .eq('restaurant_id', restaurantId)
    .order('created_at')

  if (membersError) throw new Error('No se pudieron cargar los usuarios.')
  const parsedMembers = memberRowsSchema.safeParse(memberData)
  if (!parsedMembers.success) throw new Error('No se pudieron cargar los usuarios.')
  const members = parsedMembers.data
  if (members.length === 0) return []

  const userIds = [...new Set(members.map((member) => member.user_id))]
  const { data: profileData, error: profilesError } = await supabase
    .from('profiles')
    .select('id,full_name,email,active')
    .in('id', userIds)

  if (profilesError) throw new Error('No se pudieron cargar los usuarios.')
  const parsedProfiles = profileRowsSchema.safeParse(profileData)
  if (!parsedProfiles.success) throw new Error('No se pudieron cargar los usuarios.')
  return mergeRestaurantMembersWithProfiles(members, parsedProfiles.data)
}
