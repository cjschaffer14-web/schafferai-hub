import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { readFileSync, readdirSync } from "node:fs";
import { webcrypto } from "node:crypto";
import worker, { LIMITS } from "../worker/index.js";
globalThis.crypto ||= webcrypto;

// Execute the actual generated migrations and every D1 SQL statement using
// SQLite. This avoids maintaining a fake SQL parser that mirrors the Worker.
const PYTHON = `import sqlite3,json,sys
c=sqlite3.connect(':memory:',isolation_level=None);c.row_factory=sqlite3.Row
def query(q):
 before=c.total_changes
 cursor=c.execute(q['sql'],q.get('args',[]))
 rows=[dict(x) for x in cursor.fetchall()] if cursor.description else []
 return {'results':rows,'meta':{'changes':c.total_changes-before}}
for line in sys.stdin:
 try:
  q=json.loads(line)
  if q.get('migrate') is not None:c.executescript(q['migrate']);out={'ok':True}
  elif 'batch' in q:
   c.execute('BEGIN')
   try:out=[query(x) for x in q['batch']];c.execute('COMMIT')
   except: c.execute('ROLLBACK');raise
  else:out=query(q)
  print(json.dumps({'value':out}),flush=True)
 except Exception as e:print(json.dumps({'error':str(e)}),flush=True)
`;
class Database {
  constructor() {
    this.pending = []; this.child = spawn("python3", ["-u", "-c", PYTHON], { stdio: ["pipe", "pipe", "inherit"] });
    createInterface({ input: this.child.stdout }).on("line", line => {
      const value = JSON.parse(line), task = this.pending.shift();
      value.error ? task.reject(new Error(value.error)) : task.resolve(value.value);
    });
  }
  execute(q) { return new Promise((resolve, reject) => { this.pending.push({ resolve, reject }); this.child.stdin.write(JSON.stringify(q) + "\n"); }); }
  prepare(sql) {
    const db = this;
    return { sql, args: [], bind(...args) { this.args = args; return this; },
      async first() { return (await db.execute({ sql: this.sql, args: this.args })).results[0] || null; },
      run() { return db.execute({ sql: this.sql, args: this.args }); },
      all() { return db.execute({ sql: this.sql, args: this.args }); } };
  }
  batch(queries) { return this.execute({ batch: queries.map(q => ({ sql: q.sql, args: q.args })) }); }
  close() { this.child.stdin.end(); }
}
class Bucket {
  objects = new Map();
  async put(key, bytes, options) {
    if (this.beforePut) { const hook = this.beforePut; this.beforePut = null; await hook(); }
    this.objects.set(key, { bytes: new Uint8Array(bytes), ...options });
  }
  async get(key) { const object = this.objects.get(key); return object ? { body: object.bytes, customMetadata: object.customMetadata } : null; }
  async delete(key) { this.objects.delete(key); }
}
const KEY = "test-only-http-producer-key-more-than-32-characters";
async function fixture(t) {
  const DB = new Database(), BUCKET = new Bucket(), env = { DB, BUCKET, AGENT_KEY: KEY };
  const migrationRoot = new URL("../drizzle/", import.meta.url);
  const sql = readdirSync(migrationRoot).filter(name => name.endsWith(".sql")).sort().map(name => readFileSync(new URL(name, migrationRoot), "utf8")).join("\n");
  await DB.execute({ migrate: sql }); t.after(() => DB.close());
  const original = Date.now; let now = original(); Date.now = () => now; t.after(() => { Date.now = original; });
  const epoch = crypto.randomUUID();
  async function call(path, method = "GET", value, auth = false, extra = {}) {
    const binary = value instanceof Uint8Array;
    const request = new Request("https://relay.example" + path, { method,
      headers: { Origin: "https://schafferai.com", ...(value !== undefined ? { "Content-Type": binary ? "image/jpeg" : "application/json" } : {}), ...(auth ? { Authorization: "Bearer " + KEY } : {}), ...extra },
      ...(value !== undefined ? { body: binary ? value : JSON.stringify(value) } : {}) });
    return worker.fetch(request, env);
  }
  async function connect() { assert.equal((await call("/agent/connect", "POST", { epoch }, true)).status, 200); }
  async function ready(value = true) { assert.equal((await call("/agent/status", "POST", { epoch, status: { type: "status", ready: value, state: value ? "ready" : "locked", width: 1200, height: 800, screenRecording: value, accessibility: value } }, true)).status, 200); }
  async function open() { const response = await call("/viewer/open", "POST", {}); assert.equal(response.status, 200); return (await response.json()).id; }
  async function poll(after = 0) { const response = await call(`/agent/poll?epoch=${epoch}&after=${after}`, "GET", undefined, true); assert.equal(response.status, 200); return response.json(); }
  return { DB, BUCKET, env, epoch, call, connect, ready, open, poll, advance: ms => { now += ms; } };
}

test("public viewer has no login; producer and arbitrary targets are fenced", async t => {
  const f = await fixture(t);
  assert.equal((await f.call("/agent/connect", "POST", { epoch: f.epoch })).status, 401);
  assert.equal((await f.call("/viewer/open", "POST", {})).status, 503);
  assert.equal((await f.call("/exec", "POST", { command: "whoami" })).status, 404);
  assert.equal((await f.call("/health?host=127.0.0.1")).status, 400);
  assert.equal((await f.call("/health", "GET", undefined, false, { Origin: "https://other.example" })).status, 403);
  await f.connect(); await f.ready(); const id = await f.open(); assert.match(id, /^[a-f0-9-]{36}$/);
  const response = await f.call("/health"); assert.equal((await response.json()).ready, true);
  assert.equal(response.headers.get("Cache-Control"), "no-store, max-age=0");
  assert.equal((await f.call("/viewer/pulse", "POST", { id })).status, 200);
});

test("latest frame overwrites one cache object; TTL, unchanged and close delete", async t => {
  const f = await fixture(t); await f.connect(); await f.ready(); const id = await f.open();
  const a = crypto.randomUUID(), b = crypto.randomUUID(), jpeg = new Uint8Array([255, 216, 0, 255, 217]);
  for (const frameId of [a, b]) assert.equal((await f.call(`/agent/frame?epoch=${f.epoch}&id=${frameId}`, "PUT", jpeg, true)).status, 200);
  assert.equal(f.BUCKET.objects.size, 1);
  const response = await f.call(`/frame?id=${id}`); assert.equal(response.status, 200); assert.equal(response.headers.get("X-Frame-ID"), b);
  assert.equal(response.headers.get("X-Frame-Age-Ms"), "0"); assert.deepEqual(new Uint8Array(await response.arrayBuffer()), jpeg);
  assert.equal((await f.call(`/frame?id=${id}&after=${b}`)).status, 304);
  f.advance(LIMITS.frameTtlMs + 1); assert.equal((await f.call(`/frame?id=${id}`)).status, 204); assert.equal(f.BUCKET.objects.size, 0);
  assert.equal((await f.call(`/agent/frame?epoch=${f.epoch}&id=${crypto.randomUUID()}`, "PUT", jpeg, true)).status, 200);
  assert.equal((await f.call("/viewer/close", "POST", { id })).status, 200); assert.equal(f.BUCKET.objects.size, 0);
});

test("batch order, acknowledgement, invalid all-or-nothing and event TTL", async t => {
  const f = await fixture(t); await f.connect(); await f.ready(); const id = await f.open();
  const events = [{ type: "key", action: "down", key: "a", code: "KeyA" }, { type: "key", action: "up", key: "a", code: "KeyA" }];
  assert.equal((await f.call("/input", "POST", { id, events: [...events, { type: "exec", command: "whoami" }] })).status, 400);
  assert.equal((await f.poll()).events.length, 0);
  assert.equal((await f.call("/input", "POST", { id, events })).status, 200);
  const result = await f.poll(); assert.equal(result.events.length, 2);
  assert.deepEqual(result.events.map(x => x.event.action), ["down", "up"]); assert.ok(result.events[1].id > result.events[0].id);
  assert.equal(typeof result.events[0].id, "number"); assert.ok(result.events[0].expiresAt > Date.now());
  assert.equal((await f.poll(result.events[1].id)).events.length, 0);
  assert.equal((await f.call("/input", "POST", { id, event: { type: "text", text: "private transient text" } })).status, 200);
  f.advance(LIMITS.inputTtlMs + 1); assert.equal((await f.poll()).events.length, 0);
  assert.equal((await f.DB.prepare("SELECT COUNT(*) AS count FROM desktop_events").first()).count, 0);
});

test("two leases, expiry releases controls, epoch change drops all old state", async t => {
  const f = await fixture(t); await f.connect(); await f.ready(); const id = await f.open(); await f.open();
  assert.equal((await f.call("/viewer/open", "POST", {})).status, 429);
  f.advance(LIMITS.leaseMs + 1); assert.equal((await f.call("/viewer/pulse", "POST", { id })).status, 410);
  const result = await f.poll(); assert.equal(result.viewers, 0); assert.ok(result.events.some(x => x.event.type === "release"));
  const newEpoch = crypto.randomUUID(); assert.equal((await f.call("/agent/connect", "POST", { epoch: newEpoch }, true)).status, 200);
  assert.equal((await f.call(`/agent/poll?epoch=${f.epoch}`, "GET", undefined, true)).status, 409);
  assert.equal((await f.call("/health").then(r => r.json())).ready, false);
  assert.equal((await f.DB.prepare("SELECT COUNT(*) AS count FROM desktop_events").first()).count, 0);
});

test("stale and not-ready statuses clear latest frame and queued inputs", async t => {
  const f = await fixture(t); await f.connect(); await f.ready(); const id = await f.open();
  const jpeg = new Uint8Array([255, 216, 255, 217]);
  await f.call(`/agent/frame?epoch=${f.epoch}&id=${crypto.randomUUID()}`, "PUT", jpeg, true);
  await f.call("/input", "POST", { id, event: { type: "text", text: "hello" } });
  await f.ready(false); assert.equal(f.BUCKET.objects.size, 0); assert.equal((await f.poll()).events.length, 0);
  assert.equal((await f.call("/input", "POST", { id, event: { type: "text", text: "blocked" } })).status, 409);
  assert.equal((await f.call("/input", "POST", { id, event: { type: "release" } })).status, 200);
  await f.ready(); f.advance(LIMITS.freshnessMs + 1);
  assert.equal((await f.call("/health").then(r => r.json())).available, false);
});

test("late in-flight upload cannot republish after DELETE or native lock", async t => {
  const f = await fixture(t); await f.connect(); await f.ready(); await f.open();
  const jpeg = new Uint8Array([255, 216, 255, 217]);
  for (const pause of [() => f.call(`/agent/frame?epoch=${f.epoch}`, "DELETE", undefined, true), () => f.ready(false)]) {
    await f.ready(); f.BUCKET.beforePut = pause;
    assert.equal((await f.call(`/agent/frame?epoch=${f.epoch}&id=${crypto.randomUUID()}`, "PUT", jpeg, true)).status, 204);
    assert.equal(f.BUCKET.objects.size, 0);
    assert.equal((await f.DB.prepare("SELECT frame_id FROM desktop_agent").first()).frame_id, "");
  }
});

test("event quota is measured across batches atomically; frame overflow drops", async t => {
  const f = await fixture(t); await f.connect(); await f.ready(); const id = await f.open();
  const event = { type: "pointer", action: "move", x: 0.5, y: 0.5 };
  assert.equal((await f.call("/input", "POST", { id, events: Array(64).fill(event) })).status, 200);
  assert.equal((await f.call("/input", "POST", { id, events: Array(57).fill(event) })).status, 429);
  assert.equal((await f.poll()).events.length, 64);
  const jpeg = new Uint8Array([255, 216, 255, 217]);
  for (let i = 0; i < 8; i++) assert.equal((await f.call(`/agent/frame?epoch=${f.epoch}&id=${crypto.randomUUID()}`, "PUT", jpeg, true)).status, 200);
  assert.equal((await f.call(`/agent/frame?epoch=${f.epoch}&id=${crypto.randomUUID()}`, "PUT", jpeg, true)).status, 204);
  assert.equal(f.BUCKET.objects.size, 1);
});

test("disconnect immediately invalidates leases and clears cached private data", async t => {
  const f = await fixture(t); await f.connect(); await f.ready(); const id = await f.open();
  await f.call(`/agent/frame?epoch=${f.epoch}&id=${crypto.randomUUID()}`, "PUT", new Uint8Array([255, 216, 255, 217]), true);
  await f.call("/input", "POST", { id, event: { type: "text", text: "private" } });
  assert.equal((await f.call("/agent/disconnect", "POST", { epoch: f.epoch }, true)).status, 200);
  assert.equal((await f.call("/health").then(r => r.json())).available, false); assert.equal(f.BUCKET.objects.size, 0);
  assert.equal((await f.call("/viewer/pulse", "POST", { id })).status, 410);
  assert.equal((await f.DB.prepare("SELECT COUNT(*) AS count FROM desktop_events").first()).count, 0);
});
