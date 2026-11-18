import { ApiError } from "./errors.ts";
import { createRequestHandler, jsonResponse } from "./http.ts";
import { assert, assertEquals } from "./test-assert.ts";

async function withTestOrigin(action: () => Promise<void>) {
  const previous = Deno.env.get("APP_ALLOWED_ORIGINS");
  Deno.env.set("APP_ALLOWED_ORIGINS", "https://shop.example.test");
  try {
    await action();
  } finally {
    if (previous === undefined) Deno.env.delete("APP_ALLOWED_ORIGINS");
    else Deno.env.set("APP_ALLOWED_ORIGINS", previous);
  }
}

function request(body = "{}", origin = "https://shop.example.test") {
  return new Request("https://edge.example.test/private-value?token=private-value", {
    method: "POST",
    headers: { origin, authorization: "Bearer private-value", "content-type": "application/json" },
    body,
  });
}

Deno.test("HTTP failures correlate without logging secrets, request bodies or internal errors", () =>
  withTestOrigin(async () => {
    const logs: string[] = [];
    const original = console.error;
    console.error = (value: string) => {
      logs.push(value);
    };
    try {
      const handler = createRequestHandler({
        name: "create-order",
        maxBodyBytes: 1024,
        handler: () => {
          throw new Error("private-value");
        },
      });
      const response = await handler(request('{"customer":"private-value"}'));
      const body = await response.json();
      assertEquals(response.status, 500);
      assertEquals(body.error.code, "INTERNAL_ERROR");
      assertEquals(response.headers.get("X-Request-Id"), body.requestId);
      assertEquals(response.headers.get("Access-Control-Expose-Headers"), "X-Request-Id");
      assertEquals(logs.length, 1);
      const event = JSON.parse(logs[0]!);
      assertEquals(event.requestId, body.requestId);
      assertEquals(event.route, "create-order");
      assertEquals(event.status, 500);
      assert(event.durationMs >= 0);
      assert(!logs.join("").includes("private-value"));
      assert(!JSON.stringify(body).includes("private-value"));
    } finally {
      console.error = original;
    }
  }));

Deno.test("HTTP reader enforces the route's one limit and memoizes its body", () =>
  withTestOrigin(async () => {
    let completed = 0;
    const handler = createRequestHandler({
      name: "test",
      maxBodyBytes: 7,
      handler: async (_request, context) => {
        const first = await context.readJson();
        assertEquals(await context.readJson(), first);
        completed++;
        return jsonResponse(first, 201);
      },
    });
    const success = await handler(request('{"a":1}'));
    assertEquals(success.status, 201);
    assertEquals(await success.json(), { a: 1 });
    assert(success.headers.has("X-Request-Id"));
    const original = console.warn;
    console.warn = () => {};
    try {
      const failure = await handler(request('{"a":12}'));
      assertEquals(failure.status, 413);
      assertEquals((await failure.json()).error.code, "PAYLOAD_TOO_LARGE");
      assertEquals(completed, 1);
    } finally {
      console.warn = original;
    }
  }));

Deno.test("HTTP preserves public errors and denies CORS before invoking business logic", () =>
  withTestOrigin(async () => {
    let calls = 0;
    const handler = createRequestHandler({
      name: "test",
      maxBodyBytes: 32,
      handler: () => {
        calls++;
        throw new ApiError(409, "CONFLICT", "Reintentá.", { retryable: true });
      },
    });
    const original = console.warn;
    console.warn = () => {};
    try {
      const denied = await handler(request("{}", "https://other.example.test"));
      assertEquals(denied.status, 403);
      assertEquals(denied.headers.get("Access-Control-Allow-Origin"), null);
      assertEquals(calls, 0);
      const response = await handler(request());
      assertEquals(response.status, 409);
      assertEquals((await response.json()).error, {
        code: "CONFLICT",
        message: "Reintentá.",
        details: { retryable: true },
      });
      assertEquals(calls, 1);
      const preflight = await handler(
        new Request("https://edge.example.test", {
          method: "OPTIONS",
          headers: { origin: "https://shop.example.test" },
        }),
      );
      assertEquals(preflight.status, 204);
      assertEquals(calls, 1);
    } finally {
      console.warn = original;
    }
  }));
