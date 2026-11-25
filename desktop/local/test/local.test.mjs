import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocket } from "ws";
import { createDesktopRelay } from "../server.js";
import { LIMITS } from "../../relay/src/index.js";

const KEY = "local-test-key-only-more-than-32-characters";
const origin = "https://schafferai.com";
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(condition) {
  for (let i = 0; i < 100; i++) { if (condition()) return; await pause(10); }
  assert.fail("Expected WebSocket event did not arrive");
}
async function fixture(t) {
  let clock = Date.now();
  const relay = createDesktopRelay({ producerKey: KEY, now: () => clock });
  const address = await relay.listen(0);
  assert.equal(address.address, "127.0.0.1");
  t.after(() => relay.close());
  const base = `http://127.0.0.1:${address.port}`;
  return { relay, base, advance: ms => { clock += ms; },
    connect: async (role, headers = {}) => {
      const ws = new WebSocket(`${base.replace("http:", "ws:")}/${role}`, { headers: {
        Origin: origin, ...(role === "agent" ? { Authorization: `Bearer ${KEY}` } : {}), ...headers,
      } });
      ws.messages = [];
      ws.on("message", (bytes, binary) => ws.messages.push(binary ? bytes : JSON.parse(bytes.toString())));
      ws.on("error", () => {});
      await once(ws, "open");
      return ws;
    },
    health: async () => { const res = await fetch(`${base}/health`, { headers: { Origin: origin } }); return { res, value: await res.json() }; },
  };
}
function tell(ws, value) { ws.send(JSON.stringify(value)); }
async function ready(agent, relay) {
  tell(agent, { type: "hello", ready: true, width: 1200, height: 800,
    state: "ready", screenRecording: true, accessibility: true });
  await until(() => relay.status().ready);
}
function denied(url, headers) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.on("error", () => {});
    ws.on("unexpected-response", (_req, response) => { const code = response.statusCode; response.destroy(); ws.terminate(); resolve(code); });
    ws.on("open", () => { ws.terminate(); reject(new Error("Expected rejection")); });
  });
}

test("real unauthenticated viewer handshake and fresh ready status", async t => {
  const f = await fixture(t);
  const viewer = await f.connect("viewer");
  await until(() => viewer.messages.length > 0);
  assert.equal(viewer.messages[0].available, false);
  const agent = await f.connect("agent");
  await until(() => agent.messages.some(message => message.type === "viewers" && message.count === 1));
  assert.equal(f.relay.status().ready, false);
  await ready(agent, f.relay);
  const { res, value } = await f.health();
  assert.equal(value.available, true);
  assert.equal(value.ready, true);
  assert.equal(res.headers.get("Cache-Control"), "no-store, max-age=0");
  assert.equal(res.headers.get("Access-Control-Allow-Origin"), origin);
});

test("producer auth rejected; no arbitrary route or target and no unsafe Origin", async t => {
  const f = await fixture(t);
  const wsBase = f.base.replace("http:", "ws:");
  assert.equal(await denied(`${wsBase}/agent`, {}), 401);
  assert.equal(await denied(`${wsBase}/agent`, { Authorization: "Bearer invalid" }), 401);
  assert.equal(await denied(`${wsBase}/viewer`, { Origin: "https://unrelated.example" }), 403);
  assert.equal(await denied(`${wsBase}/viewer?host=127.0.0.1`, { Origin: origin }), 404);
  for (const path of ["/shell", "/exec", "/launch", "/file", "/health?target=anything"]) {
    assert.equal((await fetch(f.base + path)).status, 404);
  }
  assert.equal((await fetch(f.base + "/health", { method: "POST" })).status, 405);
  const preflight = await fetch(f.base + "/health", { method: "OPTIONS", headers: { Origin: origin } });
  assert.equal(preflight.status, 204);
});

test("actual JPEG stream is transient and fixed-target input reaches only producer", async t => {
  const f = await fixture(t);
  const agent = await f.connect("agent");
  const viewer = await f.connect("viewer");
  await ready(agent, f.relay);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  agent.send(jpeg);
  await until(() => viewer.messages.some(Buffer.isBuffer));
  assert.deepEqual(viewer.messages.find(Buffer.isBuffer), jpeg);
  const event = { type: "pointer", action: "down", x: 0.3, y: 0.4, button: 0 };
  tell(viewer, { type: "input", event });
  await until(() => agent.messages.some(value => value.type === "input" && value.event.type === "pointer"));
  assert.deepEqual(agent.messages.find(value => value.type === "input" && value.event.type === "pointer").event, event);
  const later = await f.connect("viewer");
  await until(() => later.messages.length > 0);
  assert.equal(later.messages.some(Buffer.isBuffer), false);
});

test("stale or locked producer rejects input but receives release", async t => {
  const f = await fixture(t);
  const agent = await f.connect("agent");
  const viewer = await f.connect("viewer");
  await ready(agent, f.relay);
  tell(agent, { type: "status", ready: false, state: "locked" });
  await until(() => f.relay.status().state === "locked");
  agent.messages.length = 0;
  tell(viewer, { type: "input", event: { type: "text", text: "blocked" } });
  tell(viewer, { type: "input", event: { type: "release" } });
  await until(() => agent.messages.some(value => value.type === "input"));
  assert.deepEqual(agent.messages.filter(value => value.type === "input"), [{ type: "input", event: { type: "release" } }]);
  await ready(agent, f.relay);
  f.advance(LIMITS.freshnessMs + 1);
  assert.equal((await f.health()).value.available, false);
  tell(viewer, { type: "ping" });
  await until(() => viewer.messages.at(-1)?.available === false);
  agent.messages.length = 0;
  tell(viewer, { type: "input", event: { type: "key", action: "down", key: "a" } });
  await pause(30);
  assert.equal(agent.messages.some(value => value.type === "input"), false);
});

test("viewer cap, disconnect release, capture demand, and producer reconnect", async t => {
  const f = await fixture(t);
  const agent = await f.connect("agent");
  const first = await f.connect("viewer");
  await f.connect("viewer");
  assert.equal(await denied(`${f.base.replace("http:", "ws:")}/viewer`, { Origin: origin }), 429);
  agent.messages.length = 0;
  first.close();
  await until(() => agent.messages.some(value => value.type === "viewers" && value.count === 1));
  assert.ok(agent.messages.some(value => value.type === "input" && value.event.type === "release"));
  const newAgent = await f.connect("agent");
  await until(() => agent.readyState === WebSocket.CLOSED);
  assert.equal(f.relay.status().ready, false);
  await until(() => newAgent.messages.some(value => value.type === "viewers" && value.count === 1));
});

test("malformed input cannot forward commands and bounds/rates close offending viewers", async t => {
  const f = await fixture(t);
  const agent = await f.connect("agent");
  await ready(agent, f.relay);
  for (const event of [
    { type: "exec", command: "whoami" },
    { type: "pointer", action: "down", x: -1, y: 0 },
    { type: "text", text: "x".repeat(2001) },
    { type: "key", action: "down", key: "a", host: "localhost" },
  ]) {
    const viewer = await f.connect("viewer");
    const closed = once(viewer, "close");
    tell(viewer, { type: "input", event });
    assert.equal((await closed)[0], 1008);
  }
  assert.equal(agent.messages.some(value => value.event?.command), false);
  const binaryViewer = await f.connect("viewer");
  const binaryClosed = once(binaryViewer, "close");
  binaryViewer.send(Buffer.from([1, 2]));
  assert.equal((await binaryClosed)[0], 1003);
  const viewer = await f.connect("viewer");
  const closed = once(viewer, "close");
  for (let i = 0; i <= LIMITS.maxInputsPerSecond; i++) tell(viewer, { type: "ping" });
  assert.equal((await closed)[0], 1008);
});

test("producer frames capped without backlog; binary does not refresh heartbeat", async t => {
  const f = await fixture(t);
  const agent = await f.connect("agent");
  const viewer = await f.connect("viewer");
  await ready(agent, f.relay);
  viewer.messages.length = 0;
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  for (let i = 0; i < LIMITS.maxFramesPerSecond + 3; i++) agent.send(jpeg);
  await until(() => viewer.messages.filter(Buffer.isBuffer).length === LIMITS.maxFramesPerSecond);
  await pause(30);
  assert.equal(viewer.messages.filter(Buffer.isBuffer).length, LIMITS.maxFramesPerSecond);
  f.advance(LIMITS.freshnessMs + 1);
  agent.send(jpeg);
  await pause(30);
  assert.equal(f.relay.status().available, false);
  assert.equal(viewer.messages.filter(Buffer.isBuffer).length, LIMITS.maxFramesPerSecond);
});
