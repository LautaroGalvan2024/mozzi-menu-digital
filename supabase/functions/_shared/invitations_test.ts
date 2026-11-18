import { type SupabaseClient } from "./deps.ts";
import { RestaurantInvitations } from "./invitations.ts";
import { assertEquals, assertRejects } from "./test-assert.ts";

const userId = "492fde43-71da-42ce-83ff-c2bfa97bbb89";
const restaurantId = "3722aaab-e26c-425e-b416-f988d41bb80a";
const email = "fixture@example.test";
const leaseId = "09e16fed-d0ba-4983-899c-f7353dbe2951";

Deno.test("identity resolution prepares an unconfirmed user without sending email", async () => {
  const calls: unknown[] = [];
  const admin = {
    rpc(name: string, args: unknown) {
      calls.push([name, args]);
      return { data: null };
    },
    auth: {
      admin: {
        createUser(args: unknown) {
          calls.push(args);
          return { data: { user: { id: userId, email } } };
        },
      },
    },
  } as unknown as SupabaseClient;
  assertEquals((await new RestaurantInvitations(admin).resolve(email, "Fixture")).id, userId);
  assertEquals(calls, [["find_auth_user_by_email", { p_email: email }], {
    email,
    email_confirm: false,
    user_metadata: { full_name: "Fixture" },
  }]);
});

Deno.test("concurrent creation resolves the winning identity and rejects mismatched directory results", async () => {
  let lookups = 0;
  let returnedEmail = email;
  const admin = {
    rpc() {
      return { data: lookups++ ? userId : null };
    },
    auth: {
      admin: {
        createUser() {
          return { data: { user: null }, error: { message: "duplicate" } };
        },
        getUserById() {
          return { data: { user: { id: userId, email: returnedEmail } } };
        },
      },
    },
  } as unknown as SupabaseClient;
  const invitations = new RestaurantInvitations(admin);
  assertEquals((await invitations.resolve(email, "Fixture")).id, userId);
  returnedEmail = "different@example.test";
  await assertRejects(() => invitations.resolve(email, "Fixture"));
});

Deno.test("email delivery requires a lease and records provider success or failure", async () => {
  for (const mode of ["busy", "sent", "failed", "network", "wrong_identity"]) {
    const calls: string[] = [];
    const admin = {
      rpc(name: string, args: Record<string, unknown>) {
        calls.push(name);
        if (name === "claim_restaurant_invitation") {
          assertEquals(args, {
            p_restaurant_id: restaurantId,
            p_user_id: userId,
            p_resend: true,
            p_expected_role: "order_manager",
          });
          return {
            data: mode === "busy"
              ? null
              : { leaseId, userId: mode === "wrong_identity" ? restaurantId : userId, email },
          };
        }
        assertEquals(args, { p_lease_id: leaseId, p_success: mode === "sent" });
        return { data: true };
      },
      auth: {
        admin: {
          inviteUserByEmail(address: string, options: unknown) {
            calls.push("send");
            assertEquals(address, email);
            assertEquals(options, { redirectTo: "https://example.test/auth/callback" });
            if (mode === "network") throw new Error("disconnected");
            return {
              data: { user: { id: userId } },
              error: mode === "failed" ? { message: "SMTP" } : null,
            };
          },
        },
      },
    } as unknown as SupabaseClient;
    const delivery = await new RestaurantInvitations(admin).deliver(
      restaurantId,
      userId,
      "https://example.test/auth/callback",
      "order_manager",
      true,
    );
    assertEquals(delivery, {
      invitationSent: mode === "sent",
      deliveryPending: !["busy", "sent"].includes(mode),
    });
    assertEquals(
      calls,
      mode === "busy" || mode === "wrong_identity"
        ? ["claim_restaurant_invitation"]
        : ["claim_restaurant_invitation", "send", "finish_restaurant_invitation"],
    );
  }
});
