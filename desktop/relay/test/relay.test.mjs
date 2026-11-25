import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import worker, { DesktopRoom, LIMITS, normalizeInput } from "../src/index.js";

if (!globalThis.crypto) globalThis.crypto = webcrypto;
const NativeResponse = globalThis.Response;
// Node's Fetch implementation forbids status 101. Workers returns the accepted
// WebSocket on that response, so represent that one platform operation here.
globalThis.Response = class {
  constructor(body, init = {}) {
    if (init.status === 101) {
      this.status = 101;
      this.webSocket = init.webSocket;
      this.headers = new Headers(init.headers);
    } else return new NativeResponse(body, init);
  }
};

class Socket {
  readyState = 1;
  sent = [];
  meta = null;
  serializeAttachment(value) { this.meta = structuredClone(value); }
  deserializeAttachment() { return structuredClone(this.meta); }
  send(value) { this.sent.push(value); }
  close(code, reason) { this.readyState = 3; this.closeCode = code; this.closeReason = reason; }
}
globalThis.WebSocketPair = class {
  constructor() { this[0] = new Socket(); this[1] = new Socket(); }
};
class Context {
  ws = [];
  acceptWebSocket(socket, tags) { socket.tags = tags; this.ws.push(socket); }
  getWebSockets(tag) { return this.ws.filter(socket => !tag || socket.tags.includes(tag)); }
  get storage() { throw new Error("Desktop frames and events must never be archived"); }
}

const KEY = "test-only-agent-key-with-at-least-32-bytes";
const origin = "https://schafferai.com";
function request(path, options = {}) {
  return new Request(`https://relay.example${path}`, { ...options, headers: {
    Origin: origin, Upgrade: "websocket", ...options.headers,
  } });
}
function setup() {
  const ctx = new Context();
  const env = { AGENT_KEY: KEY };
  return { ctx, env, room: new DesktopRoom(ctx, env) };
}
async function connect(room, ctx, role, headers = {}) {
  const response = await room.fetch(request(`/${role}`, {
    headers: { ...(role === "agent" ? { Authorization: `Bearer ${KEY}` } : {}), ...headers },
  }));
  return { response, socket: response.status === 101 ? ctx.ws.at(-1) : null };
}
function jsonSent(socket) { return socket.sent.filter(value => typeof value === "string").map(JSON.parse); }
async function ready(room, agent) {
  await room.webSocketMessage(agent, JSON.stringify({
    type: "hello", ready: true, width: 1280, height: 800,
    screenRecording: true, accessibility: true, state: "ready", message: "Desktop ready",
  }));
}

test("producer authentication is required before reaching the fixed room", async () => {
  let calls = 0;
  const env = { AGENT_KEY: KEY, DESKTOP: {
    idFromName(name) { assert.equal(name, "owner-mac"); return name; },
    get() { calls++; return { fetch: async () => new NativeResponse("ok") }; },
  } };
  for (const headers of [{}, { Authorization: "Bearer wrong" }, { Authorization: `Basic ${KEY}` }]) {
    const response = await worker.fetch(request("/agent", { headers }), env);
    assert.equal(response.status, 401);
  }
  assert.equal(calls, 0);
  assert.equal((await worker.fetch(request("/agent", { headers: { Authorization: `Bearer ${KEY}` } }), env)).status, 200);
  assert.equal(calls, 1);
  assert.equal((await worker.fetch(request("/agent", { headers: { Authorization: `Bearer ${KEY}` } }), { ...env, AGENT_KEY: undefined })).status, 401);
});

test("visitor uses no authentication and initially sees honest offline status", async () => {
  const { ctx, room } = setup();
  const { response, socket } = await connect(room, ctx, "viewer");
  assert.equal(response.status, 101);
  assert.equal(response.headers.get("Cache-Control"), "no-store, max-age=0");
  assert.equal(jsonSent(socket)[0].available, false);
  assert.equal(jsonSent(socket)[0].ready, false);
  assert.equal((await room.fetch(request("/viewer", { headers: { Origin: "https://unrelated.example" } }))).status, 403);
  assert.equal((await room.fetch(request("/viewer", { headers: { Origin: "http://localhost:8123" } }))).status, 101);
});

test("availability requires live producer and fresh heartbeat; ready remains false until explicit", async () => {
  const { ctx, room } = setup();
  const { socket: agent } = await connect(room, ctx, "agent");
  assert.equal(room.availability().available, false);
  await room.webSocketMessage(agent, JSON.stringify({ type: "heartbeat", ready: false, state: "permissions_required", message: "Screen recording permission needed" }));
  assert.equal(room.availability().available, true);
  assert.equal(room.availability().ready, false);
  await ready(room, agent);
  const lastSeen = agent.deserializeAttachment().lastSeen;
  assert.equal(room.availability(lastSeen + LIMITS.freshnessMs).ready, true);
  assert.equal(room.availability(lastSeen + LIMITS.freshnessMs + 1).available, false);
  agent.readyState = 3;
  assert.equal(room.availability(lastSeen).available, false);
});

test("hibernation restores metadata from accepted sockets without persisting screenshots", async () => {
  const { ctx, env, room } = setup();
  const { socket: agent } = await connect(room, ctx, "agent");
  const { socket: viewer } = await connect(room, ctx, "viewer");
  await ready(room, agent);
  const resumed = new DesktopRoom(ctx, env);
  assert.equal(resumed.availability().ready, true);
  const frame = new Uint8Array([0xff, 0xd8, 0, 0xff, 0xd9]).buffer;
  await resumed.webSocketMessage(agent, frame);
  assert.equal(viewer.sent.at(-1), frame);
  assert.equal(Object.values(agent.deserializeAttachment()).some(value => value instanceof ArrayBuffer), false);
  // New viewers get status, never a saved screenshot or old input.
  const { socket: later } = await connect(resumed, ctx, "viewer");
  assert.equal(later.sent.some(value => value instanceof ArrayBuffer), false);
});

test("only bounded fixed-target desktop events are forwarded", async () => {
  const { ctx, room } = setup();
  const { socket: agent } = await connect(room, ctx, "agent");
  const { socket: viewer } = await connect(room, ctx, "viewer");
  await ready(room, agent);
  agent.sent.length = 0;
  const event = { type: "pointer", action: "down", x: 0.25, y: 0.8, button: 0 };
  await room.webSocketMessage(viewer, JSON.stringify({ type: "input", event }));
  assert.deepEqual(jsonSent(agent), [{ type: "input", event }]);
  for (const bad of [
    { type: "exec", command: "whoami" },
    { type: "open", path: "/Applications/Terminal.app" },
    { type: "pointer", action: "down", x: -1, y: 0.2 },
    { type: "pointer", action: "down", x: 0.1, y: Infinity },
    { type: "pointer", action: "down", x: 0.1, y: 0.2, host: "127.0.0.1" },
    { type: "key", action: "down", key: "A", modifiers: ["Execute"] },
    { type: "text", text: "x".repeat(2001) },
  ]) assert.equal(normalizeInput(bad), null);
  const before = agent.sent.length;
  await room.webSocketMessage(viewer, JSON.stringify({ type: "input", event: { type: "exec", command: "whoami" } }));
  assert.equal(viewer.closeCode, 1008);
  assert.deepEqual(jsonSent(agent).slice(before).find(value => value.type === "input"), { type: "input", event: { type: "release" } });
  assert.equal(jsonSent(agent).some(value => value.event?.command), false);
});

test("no command endpoint or alternate target can be selected", async () => {
  const { room } = setup();
  for (const path of ["/exec", "/shell", "/launch", "/file", "/viewer?host=localhost", "/health?target=other-mac"]) {
    assert.equal((await room.fetch(request(path))).status, 404);
  }
  assert.equal((await room.fetch(request("/viewer", { method: "POST" }))).status, 405);
});

test("viewer disconnect releases input and updates producer capture demand", async () => {
  const { ctx, room } = setup();
  const { socket: agent } = await connect(room, ctx, "agent");
  const { socket: viewer } = await connect(room, ctx, "viewer");
  assert.deepEqual(jsonSent(agent).at(-1), { type: "viewers", count: 1 });
  await ready(room, agent);
  agent.sent.length = 0;
  await room.webSocketMessage(viewer, JSON.stringify({ type: "input", event: { type: "release" } }));
  assert.deepEqual(jsonSent(agent)[0], { type: "input", event: { type: "release" } });
  await room.webSocketClose(viewer, 1000, "Done", true);
  assert.deepEqual(jsonSent(agent).at(-1), { type: "viewers", count: 0 });
  assert.equal(room.availability().viewers, 0);
});

test("not-ready or stale agent rejects control but still receives release", async () => {
  const { ctx, room } = setup();
  const { socket: agent } = await connect(room, ctx, "agent");
  const { socket: viewer } = await connect(room, ctx, "viewer");
  await room.webSocketMessage(agent, JSON.stringify({ type: "status", ready: false, state: "locked" }));
  agent.sent.length = 0;
  await room.webSocketMessage(viewer, JSON.stringify({ type: "input", event: { type: "text", text: "blocked" } }));
  assert.equal(agent.sent.length, 0);
  await room.webSocketMessage(viewer, JSON.stringify({ type: "input", event: { type: "release" } }));
  assert.deepEqual(jsonSent(agent), [{ type: "input", event: { type: "release" } }]);
  await ready(room, agent);
  const staleAt = agent.deserializeAttachment().lastSeen + LIMITS.freshnessMs + 1;
  const original = Date.now;
  Date.now = () => staleAt;
  try {
    agent.sent.length = 0;
    await room.webSocketMessage(viewer, JSON.stringify({ type: "input", event: { type: "key", action: "down", key: "a" } }));
    assert.equal(agent.sent.length, 0);
    assert.equal(jsonSent(viewer).at(-1).available, false);
  } finally { Date.now = original; }
});

test("at most two viewers; an authenticated reconnect replaces only the old producer", async () => {
  const { ctx, room } = setup();
  const { socket: oldAgent } = await connect(room, ctx, "agent");
  const { socket: first } = await connect(room, ctx, "viewer");
  await connect(room, ctx, "viewer");
  assert.equal((await connect(room, ctx, "viewer")).response.status, 429);
  const { socket: agent } = await connect(room, ctx, "agent");
  assert.equal(oldAgent.readyState, 3);
  assert.equal(room.sockets("agent").length, 1);
  assert.equal(room.sockets("agent")[0], agent);
  assert.equal(first.readyState, 1);
  assert.deepEqual(jsonSent(agent).at(-1), { type: "viewers", count: 2 });
});

test("oversized/binary viewer messages and rapid input are bounded", async () => {
  for (const message of [new Uint8Array([1, 2]).buffer, "x".repeat(LIMITS.maxControlBytes + 1)]) {
    const { ctx, room } = setup();
    const { socket } = await connect(room, ctx, "viewer");
    await room.webSocketMessage(socket, message);
    assert.equal(socket.readyState, 3);
  }
  const { ctx, room } = setup();
  const { socket } = await connect(room, ctx, "viewer");
  const original = Date.now;
  Date.now = () => 100_000;
  try {
    for (let i = 0; i <= LIMITS.maxInputsPerSecond; i++) await room.webSocketMessage(socket, '{"type":"ping"}');
    assert.equal(socket.closeCode, 1008);
  } finally { Date.now = original; }
});

test("only ready producer JPEGs are broadcast; excess frames are dropped", async () => {
  const { ctx, room } = setup();
  const { socket: agent } = await connect(room, ctx, "agent");
  const { socket: viewer } = await connect(room, ctx, "viewer");
  const frame = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer;
  await room.webSocketMessage(agent, frame);
  assert.equal(viewer.sent.some(value => value instanceof ArrayBuffer), false);
  const original = Date.now;
  Date.now = () => original() + 2000;
  try {
    await ready(room, agent);
    viewer.sent.length = 0;
    for (let i = 0; i < LIMITS.maxFramesPerSecond + 3; i++) await room.webSocketMessage(agent, frame);
    assert.equal(viewer.sent.filter(value => value instanceof ArrayBuffer).length, LIMITS.maxFramesPerSecond);
    assert.equal(agent.readyState, 1);
  } finally { Date.now = original; }
  await room.webSocketMessage(agent, new Uint8Array([1, 2, 3, 4]).buffer);
  assert.equal(agent.closeCode, 1009);
});

test("health never caches and supports only the known web origins", async () => {
  const { room } = setup();
  const response = await room.fetch(request("/health"));
  assert.equal(response.headers.get("Cache-Control"), "no-store, max-age=0");
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), origin);
  assert.equal((await response.json()).available, false);
  const preflight = await room.fetch(request("/health", { method: "OPTIONS" }));
  assert.equal(preflight.status, 204);
  assert.equal((await room.fetch(request("/health", { method: "OPTIONS", headers: { Origin: "https://evil.example" } }))).status, 403);
});
