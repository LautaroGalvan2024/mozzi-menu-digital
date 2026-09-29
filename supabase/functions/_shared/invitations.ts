import { type SupabaseClient, type User, z } from "./deps.ts";
import { ApiError } from "./errors.ts";

export type InvitationResolution = {
  user: User;
  invited: boolean;
};

async function findAuthUserByEmail(
  admin: SupabaseClient,
  email: string,
): Promise<User | undefined> {
  const { data: profileData, error: profileError } = await admin
    .from("profiles")
    .select("id")
    .eq("email", email)
    .maybeSingle();
  if (profileError) {
    throw new ApiError(
      500,
      "AUTH_DIRECTORY_ERROR",
      "No se pudo consultar el directorio de usuarios.",
    );
  }
  const profile = z.object({ id: z.string().uuid() }).safeParse(profileData);
  if (profile.success) {
    const { data, error } = await admin.auth.admin.getUserById(profile.data.id);
    if (error || !data.user) {
      throw new ApiError(
        500,
        "AUTH_DIRECTORY_ERROR",
        "No se pudo consultar el directorio de usuarios.",
      );
    }
    return data.user;
  }

  // Defensive fallback for a legacy Auth user that predates the profile trigger.
  const matches: User[] = [];
  const perPage = 1_000;
  for (let page = 1; page <= 50; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) {
      throw new ApiError(
        500,
        "AUTH_DIRECTORY_ERROR",
        "No se pudo consultar el directorio de usuarios.",
      );
    }
    for (const user of data.users) {
      if (user.email?.trim().toLowerCase() === email) matches.push(user);
    }
    if (data.users.length < perPage) break;
  }

  if (matches.length > 1) {
    throw new ApiError(
      409,
      "AMBIGUOUS_AUTH_USER",
      "No se pudo resolver el usuario de forma unívoca.",
    );
  }
  return matches[0];
}

export async function resolveOrInviteUser(
  admin: SupabaseClient,
  input: { email: string; fullName: string; redirectTo: string },
): Promise<InvitationResolution> {
  const existing = await findAuthUserByEmail(admin, input.email);
  if (existing) return { user: existing, invited: false };

  const { data, error } = await admin.auth.admin.inviteUserByEmail(input.email, {
    redirectTo: input.redirectTo,
    data: { full_name: input.fullName },
  });
  if (!error && data.user) return { user: data.user, invited: true };

  // A concurrent request may have created the user after the initial exact lookup.
  const raced = await findAuthUserByEmail(admin, input.email);
  if (raced) return { user: raced, invited: false };
  throw new ApiError(502, "INVITATION_FAILED", "No se pudo enviar la invitación.");
}
