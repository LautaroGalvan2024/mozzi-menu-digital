import { ApiError } from "./errors.ts";
import { readJson } from "./http.ts";
import { assertEquals, assertRejects } from "./test-assert.ts";

Deno.test("JSON reader enforces actual byte length even without Content-Length", async () => {
  const request = new Request("https://functions.example.test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value: "1234567890" }),
  });
  await assertRejects(
    () => readJson(request, 8),
    (error) => error instanceof ApiError && error.status === 413,
  );
});

Deno.test("JSON reader rejects non-JSON media types", async () => {
  const request = new Request("https://functions.example.test", {
    method: "POST",
    headers: { "Content-Type": "text/plain" },
    body: "{}",
  });
  await assertRejects(
    () => readJson(request, 1_024),
    (error) => error instanceof ApiError && error.status === 415,
  );
});

Deno.test("JSON reader returns parsed objects", async () => {
  const request = new Request("https://functions.example.test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: '{"ok":true}',
  });
  assertEquals(await readJson(request, 1_024), { ok: true });
});

function streamedRequest(
  chunks: readonly Uint8Array[],
  headers: Record<string, string> = {},
  onCancel?: () => void | Promise<void>,
) {
  const state = { reads: 0, cancellations: 0 };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[state.reads++];
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
    cancel() {
      state.cancellations++;
      return onCancel?.();
    },
  }, { highWaterMark: 0 });
  return {
    state,
    request: new Request("https://functions.example.test", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body,
    }),
  };
}

Deno.test("JSON reader stops and cancels at the first chunk exceeding the actual limit", async () => {
  const declarations: Record<string, string>[] = [{}, { "Content-Length": "1" }];
  for (const headers of declarations) {
    const { request, state } = streamedRequest(
      Array.from({ length: 100 }, () => new Uint8Array(4)),
      headers,
    );
    await assertRejects(
      () => readJson(request, 8),
      (error) => error instanceof ApiError && error.status === 413,
    );
    assertEquals(state.reads, 3);
    assertEquals(state.cancellations, 1);
    assertEquals(request.body?.locked, false);
  }
});

Deno.test("JSON reader rejects an oversized declaration without pulling the body", async () => {
  for (const length of ["9", "99999999999999999999999999999"]) {
    const { request, state } = streamedRequest([new TextEncoder().encode("{}")], {
      "Content-Length": length,
    });
    await assertRejects(
      () => readJson(request, 8),
      (error) => error instanceof ApiError && error.status === 413,
    );
    assertEquals(state.reads, 0);
    assertEquals(state.cancellations, 1);
  }
});

Deno.test("JSON reader rejects malformed Content-Length without reading", async () => {
  for (const length of ["-1", "1.5", "1e2", "2, 2", "invalid"]) {
    const { request, state } = streamedRequest([new TextEncoder().encode("{}")], {
      "Content-Length": length,
    });
    await assertRejects(
      () => readJson(request, 1_024),
      (error) => error instanceof ApiError && error.status === 400,
    );
    assertEquals(state.reads, 0);
    assertEquals(state.cancellations, 1);
  }
});

Deno.test("JSON reader counts UTF-8 bytes and accepts the exact limit across split characters", async () => {
  const expected = { text: "ñ😀" };
  const bytes = new TextEncoder().encode(JSON.stringify(expected));
  const chunks = Array.from(bytes, (byte) => new Uint8Array([byte]));
  const exact = streamedRequest(chunks);
  assertEquals(await readJson(exact.request, bytes.byteLength), expected);
  assertEquals(exact.request.body?.locked, false);

  const excessive = streamedRequest(chunks);
  await assertRejects(
    () => readJson(excessive.request, bytes.byteLength - 1),
    (error) => error instanceof ApiError && error.status === 413,
  );
  assertEquals(excessive.state.cancellations, 1);
});

Deno.test("JSON reader handles many small chunks without changing the parsed body", async () => {
  const expected = { text: "a".repeat(20_000) };
  const bytes = new TextEncoder().encode(JSON.stringify(expected));
  const { request } = streamedRequest(Array.from(bytes, (byte) => new Uint8Array([byte])));
  assertEquals(await readJson(request, bytes.byteLength), expected);
});

Deno.test("JSON reader rejects empty, malformed JSON and invalid UTF-8 bodies", async () => {
  for (
    const chunks of [
      [],
      [new TextEncoder().encode("{")],
      [new Uint8Array([0x22, 0xc3, 0x22])],
      [new Uint8Array([0x22, 0xc3])],
    ]
  ) {
    const { request } = streamedRequest(chunks);
    await assertRejects(
      () => readJson(request, 1_024),
      (error) => error instanceof ApiError && error.status === 400 && error.code === "INVALID_JSON",
    );
    assertEquals(request.body?.locked, false);
  }
  const noBody = new Request("https://functions.example.test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  await assertRejects(
    () => readJson(noBody, 1_024),
    (error) => error instanceof ApiError && error.code === "INVALID_JSON",
  );
});

Deno.test("JSON reader preserves the size error when cancellation rejects or stays pending", async () => {
  for (
    const onCancel of [
      () => Promise.reject(new Error("private transport detail")),
      () => new Promise<void>(() => {}),
    ]
  ) {
    const { request, state } = streamedRequest([new Uint8Array(9)], {}, onCancel);
    await assertRejects(
      () => readJson(request, 8),
      (error) => error instanceof ApiError && error.status === 413,
    );
    assertEquals(state.cancellations, 1);
    assertEquals(request.body?.locked, false);
  }
});

Deno.test("JSON reader sanitizes stream failures and releases its reader", async () => {
  const request = new Request("https://functions.example.test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("private transport detail"));
      },
    }, { highWaterMark: 0 }),
  });
  await assertRejects(
    () => readJson(request, 1_024),
    (error) =>
      error instanceof ApiError && error.status === 400 &&
      !error.message.includes("private transport detail"),
  );
  assertEquals(request.body?.locked, false);
});
