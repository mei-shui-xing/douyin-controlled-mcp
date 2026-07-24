import assert from "node:assert/strict";

process.env.MCP_ACCESS_TOKEN = "fixture-access-token-that-is-long-and-private";

const {
  applyCors,
  requireMcpAuthentication,
} = await import("./http-security.js");
const { decideSessionCapacity } = await import("./mcp-session-policy.js");

type MockResponse = {
  statusCode: number;
  body: unknown;
  headers: Map<string, string>;
  ended: boolean;
  status(code: number): MockResponse;
  json(body: unknown): MockResponse;
  end(): void;
  setHeader(name: string, value: string): void;
};

function response(): MockResponse {
  return {
    statusCode: 200,
    body: null,
    headers: new Map(),
    ended: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    end() {
      this.ended = true;
    },
    setHeader(name, value) {
      this.headers.set(name.toLowerCase(), value);
    },
  };
}

function request(input: {
  headers?: Record<string, string>;
  query?: Record<string, string>;
  method?: string;
}) {
  const headers = Object.fromEntries(
    Object.entries(input.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return {
    method: input.method ?? "POST",
    query: input.query ?? {},
    ip: "127.0.0.1",
    socket: { remoteAddress: "127.0.0.1" },
    header(name: string) {
      return headers[name.toLowerCase()];
    },
  } as any;
}

{
  const res = response();
  let nextCalled = false;
  applyCors(
    request({ headers: { origin: "https://evil.example" } }),
    res as any,
    () => { nextCalled = true; },
  );
  assert.equal(res.statusCode, 403);
  assert.equal(nextCalled, false);
}

{
  const res = response();
  let nextCalled = false;
  applyCors(
    request({ headers: { origin: "https://chatgpt.com" } }),
    res as any,
    () => { nextCalled = true; },
  );
  assert.equal(nextCalled, true);
  assert.equal(res.headers.get("access-control-allow-origin"), "https://chatgpt.com");
}

{
  const res = response();
  let nextCalled = false;
  requireMcpAuthentication(
    request({ headers: { authorization: "Bearer wrong" } }),
    res as any,
    () => { nextCalled = true; },
  );
  assert.equal(res.statusCode, 401);
  assert.equal(nextCalled, false);
}

for (const authenticatedRequest of [
  request({ headers: { authorization: "Bearer fixture-access-token-that-is-long-and-private" } }),
  request({ query: { access_token: "fixture-access-token-that-is-long-and-private" } }),
]) {
  const res = response();
  let nextCalled = false;
  requireMcpAuthentication(
    authenticatedRequest,
    res as any,
    () => { nextCalled = true; },
  );
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, 200);
}

{
  const now = 1_000_000;
  const expired = decideSessionCapacity({
    sessions: [
      { id: "expired-a", createdAt: 0, lastSeenAt: 100 },
      { id: "expired-b", createdAt: 0, lastSeenAt: 200 },
    ],
    now,
    ttlMs: 10_000,
    idleEvictionMs: 1_000,
    maxSessions: 2,
  });
  assert.deepEqual(expired.expiredIds, ["expired-a", "expired-b"]);
  assert.equal(expired.capacityAvailable, true);
}

{
  const now = 1_000_000;
  const replaceIdle = decideSessionCapacity({
    sessions: [
      { id: "oldest-idle", createdAt: 10, lastSeenAt: now - 10_000 },
      { id: "newer-idle", createdAt: 20, lastSeenAt: now - 5_000 },
    ],
    now,
    ttlMs: 60_000,
    idleEvictionMs: 1_000,
    maxSessions: 2,
  });
  assert.equal(replaceIdle.evictId, "oldest-idle");
  assert.equal(replaceIdle.capacityAvailable, true);
}

{
  const now = 1_000_000;
  const freshAtCapacity = decideSessionCapacity({
    sessions: [
      { id: "fresh", createdAt: now - 100, lastSeenAt: now - 100 },
    ],
    now,
    ttlMs: 60_000,
    idleEvictionMs: 1_000,
    maxSessions: 1,
  });
  assert.equal(freshAtCapacity.evictId, null);
  assert.equal(freshAtCapacity.capacityAvailable, false);
  const pendingAtCapacity = decideSessionCapacity({
    sessions: [],
    now,
    ttlMs: 60_000,
    idleEvictionMs: 1_000,
    maxSessions: 1,
    pendingInitializations: 1,
  });
  assert.equal(pendingAtCapacity.capacityAvailable, false);
}

console.log("HTTP_SECURITY_FIXTURES=PASS");
