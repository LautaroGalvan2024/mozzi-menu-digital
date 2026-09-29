import type { SupabaseClient, User } from "./deps.ts";
import { z } from "./deps.ts";
import { createUserClient } from "./clients.ts";
import { ApiError, databaseApiError } from "./errors.ts";

const membershipSchema = z.object({
  restaurantId: z.string().uuid(),
  role: z.enum(["restaurant_admin", "order_manager"]),
  status: z.enum(["invited", "active", "suspended"]),
}).strict();

const actorAuthorizationSchema = z.object({
  userId: z.string().uuid(),
  isSuperAdmin: z.boolean(),
  aal: z.string().nullable().optional(),
  memberships: z.array(membershipSchema),
}).strict();

export type ActorAuthorization = z.infer<typeof actorAuthorizationSchema>;

export type VerifiedActor = {
  token: string;
  user: User;
  client: SupabaseClient;
  authorization: ActorAuthorization;
};

export function parseBearerAuthorization(request: Request): { token: string; header: string } {
  const header = request.headers.get("authorization")?.trim();
  if (!header) throw new ApiError(401, "AUTH_REQUIRED", "Iniciá sesión para continuar.");
  const match = /^Bearer\s+([^\s]+)$/i.exec(header);
  if (!match?.[1] || match[1].length > 8192) {
    throw new ApiError(401, "INVALID_AUTH", "La sesión no es válida.");
  }
  return { token: match[1], header: `Bearer ${match[1]}` };
}

export async function verifyActor(request: Request): Promise<VerifiedActor> {
  const { token, header } = parseBearerAuthorization(request);
  const client = createUserClient(header);
  const { data: userData, error: userError } = await client.auth.getUser(token);
  if (userError || !userData.user) {
    throw new ApiError(401, "INVALID_AUTH", "La sesión venció o no es válida.");
  }

  const { data: authorizationData, error: authorizationError } = await client.rpc(
    "get_actor_authorization",
  );
  if (authorizationError) throw databaseApiError(authorizationError);
  const parsed = actorAuthorizationSchema.safeParse(authorizationData);
  if (!parsed.success || parsed.data.userId !== userData.user.id) {
    throw new ApiError(403, "AUTHORIZATION_UNAVAILABLE", "No se pudieron verificar tus permisos.");
  }

  return {
    token,
    user: userData.user,
    client,
    authorization: parsed.data,
  };
}

export async function requireAal2(actor: VerifiedActor): Promise<void> {
  const { data, error } = await actor.client.auth.mfa.getAuthenticatorAssuranceLevel(actor.token);
  if (error || data.currentLevel !== "aal2") {
    throw new ApiError(
      403,
      "MFA_REQUIRED",
      "Completá la verificación en dos pasos para continuar.",
    );
  }
}

export async function requireSuperAdmin(request: Request): Promise<VerifiedActor> {
  const actor = await verifyActor(request);
  if (!actor.authorization.isSuperAdmin) {
    throw new ApiError(403, "FORBIDDEN", "No tenés permisos para realizar esta acción.");
  }
  await requireAal2(actor);
  return actor;
}

export function activeRestaurantRole(
  actor: VerifiedActor,
  restaurantId: string,
): "restaurant_admin" | "order_manager" | undefined {
  return actor.authorization.memberships.find(
    (membership) => membership.restaurantId === restaurantId && membership.status === "active",
  )?.role;
}
