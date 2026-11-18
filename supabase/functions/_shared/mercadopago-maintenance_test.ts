import { type ExpirationReport, PaymentMaintenanceService } from "./mercadopago-maintenance.ts";
import { assert, assertEquals } from "./test-assert.ts";

const expiration: ExpirationReport = {
  expired: 2,
  blocked: 1,
  blockedCountCapped: false,
  locked: 0,
  failed: 0,
  scanned: 2,
  purgedTokens: 0,
};

Deno.test("maintenance expires stock before a provider failure and continues other merchants", async () => {
  const events: string[] = [];
  const service = new PaymentMaintenanceService({
    expire: () => {
      events.push("expire");
      return Promise.resolve(expiration);
    },
    list: () => Promise.resolve([{ attemptId: "bad" }, { attemptId: "healthy" }]),
    reconcile: (attempt) => {
      events.push(`reconcile:${attempt.attemptId}`);
      return attempt.attemptId === "bad"
        ? Promise.reject(new Error("provider failure"))
        : Promise.resolve();
    },
    finish: (attemptId, succeeded) => {
      events.push(`finish:${attemptId}:${succeeded}`);
      return Promise.resolve();
    },
    failed: (attemptId) => {
      events.push(`failed:${attemptId}`);
    },
  });
  const result = await service.run(10);
  assertEquals(events[0], "expire");
  assert(events.includes("finish:bad:false"));
  assert(events.includes("finish:healthy:true"));
  assertEquals(result.expired, 2);
  assertEquals(result.reconciled, 1);
  assertEquals(result.failed, 1);
  assertEquals(result.deferred, 0);
  assertEquals(result.expiration.blocked, 1);
});

Deno.test("maintenance budget stops additional work without losing expiration metrics", async () => {
  let time = 0;
  let attempts = 0;
  const service = new PaymentMaintenanceService({
    expire: () => Promise.resolve(expiration),
    list: () =>
      Promise.resolve(Array.from({ length: 10 }, (_, index) => ({ attemptId: String(index) }))),
    reconcile: () => {
      attempts++;
      time = 50;
      return Promise.resolve();
    },
    finish: () => Promise.resolve(),
    failed: () => {},
    now: () => time,
  }, 40);
  const result = await service.run(10);
  assertEquals(attempts, 1);
  assertEquals(result.reconciled, 1);
  assertEquals(result.deferred, 9);
  assertEquals(result.expired, 2);
});

Deno.test("maintenance aborts in-flight provider work and records a retry after the deadline", async () => {
  const completions: boolean[] = [];
  const service = new PaymentMaintenanceService({
    expire: () => Promise.resolve(expiration),
    list: () => Promise.resolve([{ attemptId: "slow" }]),
    reconcile: (_attempt, signal) =>
      new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    finish: (_attemptId, succeeded) => {
      completions.push(succeeded);
      return Promise.resolve();
    },
    failed: () => {},
  }, 10);
  const result = await service.run(1);
  assertEquals(result.deferred, 1);
  assertEquals(result.reconciled, 0);
  assertEquals(completions, [false]);
  assertEquals(result.expired, 2);
});

Deno.test("a bookkeeping failure is visible without abandoning other merchants", async () => {
  const service = new PaymentMaintenanceService({
    expire: () => Promise.resolve(expiration),
    list: () => Promise.resolve([{ attemptId: "bad" }, { attemptId: "healthy" }]),
    reconcile: () => Promise.resolve(),
    finish: (id) =>
      id === "bad" ? Promise.reject(new Error("database failure")) : Promise.resolve(),
    failed: () => {},
  });
  const result = await service.run(10);
  assertEquals(result.reconciled, 2);
  assertEquals(result.failed, 1);
  assertEquals(result.deferred, 0);
});
