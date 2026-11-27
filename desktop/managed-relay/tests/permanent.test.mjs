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
    this.pending = []; this.calls = []; this.child = spawn("python3", ["-u", "-c", PYTHON], { stdio: ["pipe", "pipe", "inherit"] });
    createInterface({ input: this.child.stdout }).on("line", line => {
      const value = JSON.parse(line), task = this.pending.shift();
      value.error ? task.reject(new Error(value.error)) : task.resolve(value.value);
    });
  }
  async execute(q) {
    if (this.beforeExecute) await this.beforeExecute(q);
    this.calls.push(q);
    return new Promise((resolve, reject) => { this.pending.push({ resolve, reject }); this.child.stdin.write(JSON.stringify(q) + "\n"); });
  }
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
  async get(key) {
    if (this.beforeGet) { const hook = this.beforeGet; this.beforeGet = null; await hook(); }
    const object = this.objects.get(key);
    if (this.afterGet) { const hook = this.afterGet; this.afterGet = null; await hook(); }
    return object ? { body: object.bytes, customMetadata: object.customMetadata } : null;
  }
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
  const preflight = await f.call("/input", "OPTIONS");
  assert.equal(preflight.status, 204); assert.equal(preflight.headers.get("Access-Control-Max-Age"), "600");
  assert.equal(preflight.headers.get("Access-Control-Allow-Headers"), "Content-Type");
  const denied = await f.call("/input", "OPTIONS", undefined, false, { Origin: "https://other.example" });
  assert.equal(denied.status, 403); assert.equal(denied.headers.get("Access-Control-Max-Age"), null);
});

test("latest frame overwrites one cache object; TTL, unchanged and close delete", async t => {
  const f = await fixture(t); await f.connect(); await f.ready(); const id = await f.open();
  const a = crypto.randomUUID(), b = crypto.randomUUID(), jpeg = new Uint8Array([255, 216, 0, 255, 217]);
  for (const frameId of [a, b]) assert.equal((await f.call(`/agent/frame?epoch=${f.epoch}&id=${frameId}`, "PUT", jpeg, true)).status, 200);
  assert.equal(f.BUCKET.objects.size, 1);
  const response = await f.call(`/frame?id=${id}`); assert.equal(response.status, 200); assert.equal(response.headers.get("X-Frame-ID"), b);
  assert.equal(response.headers.get("X-Frame-Age-Ms"), "0"); assert.deepEqual(new Uint8Array(await response.arrayBuffer()), jpeg);
  assert.equal((await f.call(`/frame?id=${id}&after=${b}`)).status, 304);
  f.advance(LIMITS.frameTtlMs + 1); assert.equal((await f.call(`/frame?id=${id}`)).status, 204);
  await f.call("/health"); assert.equal(f.BUCKET.objects.size, 0);
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

test("desktop hot routes use bounded round trips and preserve ordered acknowledgement", async t => {
  const f = await fixture(t); await f.connect(); await f.ready(); const id = await f.open();
  const events = [{ type: "key", action: "down", key: "a", code: "KeyA" }, { type: "key", action: "up", key: "a", code: "KeyA" }];
  f.DB.calls = []; assert.equal((await f.call("/input", "POST", { id, events })).status, 200);
  assert.equal(f.DB.calls.length, 2);
  const jpeg = new Uint8Array([255, 216, 255, 217]), frameId = crypto.randomUUID();
  f.DB.calls = []; assert.equal((await f.call(`/agent/frame?epoch=${f.epoch}&id=${frameId}`, "PUT", jpeg, true)).status, 200);
  assert.equal(f.DB.calls.length, 3);
  f.DB.calls = []; const frame = await f.call(`/frame?id=${id}`); assert.equal(frame.status, 200);
  assert.deepEqual(new Uint8Array(await frame.arrayBuffer()), jpeg); assert.equal(f.DB.calls.length, 2);
  f.DB.calls = []; const result = await f.poll(); assert.deepEqual(result.events.map(x => x.event.action), ["down", "up"]);
  assert.equal(f.DB.calls.length, 2); assert.ok(result.events[0].id < result.events[1].id);
  f.DB.calls = []; assert.equal((await f.call(`/agent/frame?epoch=${f.epoch}`, "DELETE", undefined, true)).status, 200);
  assert.equal(f.DB.calls.length, 2);
  f.DB.calls = []; assert.deepEqual((await f.poll(result.events[1].id)).events, []); assert.equal(f.DB.calls.length, 2);
  assert.equal((await f.DB.prepare("SELECT COUNT(*) AS count FROM desktop_events").first()).count, 0);
});

test("concurrent maintenance and poll claim one expired lease exactly once", async t => {
  const f = await fixture(t); await f.connect(); await f.ready(); const expired = await f.open(), live = await f.open();
  for (const id of [expired, live]) assert.equal((await f.call("/input", "POST", { id, event: { type: "text", text: id } })).status, 200);
  await f.DB.prepare("UPDATE desktop_viewers SET expires_at = ? WHERE id = ?").bind(Date.now() - 1, expired).run();
  const [, result] = await Promise.all([f.call("/health"), f.poll()]);
  assert.equal(result.viewers, 1);
  assert.equal(result.events.filter(x => x.event.type === "release").length, 1);
  assert.deepEqual(result.events.filter(x => x.event.type === "text").map(x => x.event.text), [live]);
  assert.equal((await f.DB.prepare("SELECT COUNT(*) AS count FROM desktop_events WHERE viewer_id IS NULL").first()).count, 1);
  await f.poll(result.events.at(-1).id); await f.call("/health");
  assert.equal((await f.DB.prepare("SELECT COUNT(*) AS count FROM desktop_events").first()).count, 0);
});

test("bounded native long poll wakes for input, first viewer, lock and epoch change", async t => {
  const f = await fixture(t); await f.connect(); await f.ready();
  const pause = () => new Promise(resolve => setTimeout(resolve, 70));
  let done = false, pending = f.poll().then(value => { done = true; return value; });
  await pause(); assert.equal(done, false, "idle poll waits for the first viewer");
  const id = await f.open(); assert.equal((await pending).viewers, 1);
  const jpeg = new Uint8Array([255, 216, 255, 217]);
  const put = () => f.call(`/agent/frame?epoch=${f.epoch}&id=${crypto.randomUUID()}`, "PUT", jpeg, true);
  assert.equal((await put()).status, 200);
  f.DB.calls = []; done = false; const start = performance.now(); pending = f.poll().then(value => { done = true; return value; });
  await pause(); assert.equal(done, false, "active poll holds the empty queue");
  assert.equal((await f.call("/input", "POST", { id, event: { type: "pointer", action: "move", x: 0.5, y: 0.5 } })).status, 200);
  const result = await pending; assert.equal(result.events.length, 1); assert.equal(result.events[0].event.type, "pointer");
  assert.ok(performance.now() - start < 700);
  assert.ok(f.DB.calls.reduce((sum, q) => sum + (q.batch?.length || 1), 0) < 100);
  pending = f.poll(result.events[0].id); await pause(); await f.ready(false);
  assert.deepEqual((await pending).events, []);
  await f.ready(); assert.equal((await put()).status, 200);
  pending = f.call(`/agent/poll?epoch=${f.epoch}&after=0`, "GET", undefined, true); await pause();
  const epoch = crypto.randomUUID(); assert.equal((await f.call("/agent/connect", "POST", { epoch }, true)).status, 200);
  assert.equal((await pending).status, 409);
});

test("fetched frame snapshot survives newer publication but not delete, age or lease fences", async t => {
  const f = await fixture(t); await f.connect(); await f.ready(); const id = await f.open();
  const jpeg = new Uint8Array([255, 216, 255, 217]);
  const put = async () => { const next = crypto.randomUUID(); assert.equal((await f.call(`/agent/frame?epoch=${f.epoch}&id=${next}`, "PUT", jpeg, true)).status, 200); return next; };
  const a = await put(); let b;
  f.BUCKET.afterGet = async () => { b = await put(); };
  const snapshot = await f.call(`/frame?id=${id}`); assert.equal(snapshot.status, 200); assert.equal(snapshot.headers.get("X-Frame-ID"), a);
  assert.equal((await f.DB.prepare("SELECT frame_id FROM desktop_agent").first()).frame_id, b);
  f.BUCKET.afterGet = () => f.call(`/agent/frame?epoch=${f.epoch}`, "DELETE", undefined, true);
  assert.equal((await f.call(`/frame?id=${id}`)).status, 204);
  await put(); f.BUCKET.afterGet = async () => { f.advance(LIMITS.frameTtlMs + 1); await put(); };
  assert.equal((await f.call(`/frame?id=${id}`)).status, 204, "newer frame timestamp cannot refresh fetched bytes");
  f.BUCKET.afterGet = async () => { f.advance(LIMITS.leaseMs + 1); };
  assert.equal((await f.call(`/frame?id=${id}`)).status, 410);
});

test("stale housekeeping cannot clear a newer published frame", async t => {
  const f = await fixture(t); await f.connect(); await f.ready(); const id = await f.open();
  const jpeg = new Uint8Array([255, 216, 255, 217]);
  assert.equal((await f.call(`/agent/frame?epoch=${f.epoch}&id=${crypto.randomUUID()}`, "PUT", jpeg, true)).status, 200);
  f.advance(LIMITS.frameTtlMs + 1); const replacement = crypto.randomUUID(); let replaced = false;
  f.DB.beforeExecute = async q => {
    if (!q.batch?.some(item => item.sql.includes("SET frame_at = 0"))) return;
    f.DB.beforeExecute = null;
    assert.equal((await f.call(`/agent/frame?epoch=${f.epoch}&id=${replacement}`, "PUT", jpeg, true)).status, 200); replaced = true;
  };
  assert.equal((await f.call("/health")).status, 200); assert.equal(replaced, true);
  assert.equal((await f.DB.prepare("SELECT frame_id FROM desktop_agent").first()).frame_id, replacement);
  assert.equal(f.BUCKET.objects.size, 1);
  assert.equal((await f.call(`/frame?id=${id}`)).headers.get("X-Frame-ID"), replacement);
  f.BUCKET.beforePut = async () => { f.advance(LIMITS.leaseMs + 1); };
  assert.equal((await f.call(`/agent/frame?epoch=${f.epoch}&id=${crypto.randomUUID()}`, "PUT", jpeg, true)).status, 204);
  assert.equal((await f.DB.prepare("SELECT frame_id FROM desktop_agent").first()).frame_id, replacement, "late expired upload cannot replace the pointer");
  assert.equal(f.BUCKET.objects.size, 1);
});

async function audioFixture(t, options = {}) {
  const f = await fixture(t); await f.connect(); await f.ready();
  const id = await f.open();
  const status = async (captureReady = true, microphoneReady = true) => f.call("/agent/audio/status", "POST", { epoch: f.epoch, status: { captureReady, microphoneReady, virtualInputName: microphoneReady ? "BlackHole 2ch" : "", message: "Synthetic test helper" } }, true);
  assert.equal((await status(options.captureReady ?? true, options.microphoneReady ?? true)).status, 200);
  const control = async (revision, sound, mic, viewerId = id) => f.call("/viewer/audio", "POST", { id: viewerId, revision, sound, mic });
  const pcm = direction => Buffer.alloc(direction === "output" ? 38400 : 6400, 23).toString("base64");
  const upload = (direction, generation, seq, extra = {}) => f.call(direction === "output" ? "/agent/audio" : "/microphone", "POST", { ...(direction === "output" ? { epoch: f.epoch } : { id }), generation, seq, sampleRate: direction === "output" ? 48000 : 16000, channels: direction === "output" ? 2 : 1, encoding: "s16le", pcm: pcm(direction), ...extra }, direction === "output");
  return { ...f, id, status, control, upload, pcm };
}

test("audio is explicit off; independent helper capabilities and one microphone owner", async t => {
  const f = await audioFixture(t, { captureReady: false });
  let health = await f.call("/health").then(r => r.json());
  assert.equal(health.ready, true); assert.equal(health.audio.available, true);
  assert.equal(health.audio.captureReady, false); assert.equal(health.audio.microphoneReady, true);
  assert.equal((await f.control(1, true, false)).status, 409);
  const on = await f.control(1, false, true).then(r => r.json());
  assert.equal(on.mic, true); assert.equal(on.sound, false); assert.equal(on.epoch, f.epoch);
  const second = await f.open(); assert.equal((await f.control(1, false, true, second)).status, 409);
  const state = await f.call("/agent/audio-state", "GET", undefined, true).then(r => r.json());
  assert.equal(state.videoReady, true); assert.equal(state.micActive, true); assert.equal(state.soundViewers, 0);
  assert.equal(state.inputGeneration, on.inputGeneration);
  assert.equal((await f.upload("input", on.inputGeneration, 1)).status, 200);
  const batch = await f.call(`/agent/microphone?epoch=${f.epoch}&generation=${on.inputGeneration}&after=0`, "GET", undefined, true).then(r => r.json());
  assert.equal(batch.sampleRate, 16000); assert.equal(batch.channels, 1); assert.equal(batch.chunks[0].pcm, f.pcm("input"));
  assert.equal((await f.control(2, false, false)).status, 200);
  assert.equal((await f.control(1, false, true)).status, 409, "old ON cannot supersede newer OFF");
  assert.equal((await f.call(`/agent/microphone?epoch=${f.epoch}`, "GET", undefined, true)).status, 409);
  assert.equal(f.BUCKET.objects.size, 0);
  assert.equal((await f.control(2, false, true, second)).status, 200, "ownership released after OFF");
});

test("system sound preserves PCM, sequences, fresh batches and generation fences", async t => {
  const f = await audioFixture(t);
  const on = await f.control(1, true, false).then(r => r.json());
  assert.equal((await f.upload("output", on.outputGeneration, 1, { pcm: "invalid" })).status, 400);
  assert.equal((await f.upload("output", on.outputGeneration, 1)).status, 200, "separate audio body supports >16KiB sound");
  assert.equal((await f.upload("output", on.outputGeneration, 1)).status, 409, "sequence cannot replay");
  let batch = await f.call(`/audio?id=${f.id}&generation=${on.outputGeneration}&after=0`).then(r => r.json());
  assert.equal(batch.sampleRate, 48000); assert.equal(batch.channels, 2); assert.equal(batch.encoding, "s16le");
  assert.deepEqual(batch.chunks, [{ seq: 1, ageMs: 0, pcm: f.pcm("output") }]);
  batch = await f.call(`/audio?id=${f.id}&generation=${on.outputGeneration}&after=1`).then(r => r.json());
  assert.equal(batch.chunks.length, 0);
  for (let seq = 2; seq <= 8; seq++) assert.equal((await f.upload("output", on.outputGeneration, seq)).status, 200);
  batch = await f.call(`/audio?id=${f.id}&generation=${on.outputGeneration}&after=0`).then(r => r.json());
  assert.deepEqual(batch.chunks.map(x => x.seq), [3, 4, 5, 6, 7, 8]);
  assert.equal(f.BUCKET.objects.size, 8); assert.equal(new Set(f.BUCKET.objects.keys()).size, 8);
  f.advance(1201);
  batch = await f.call(`/audio?id=${f.id}&generation=${on.outputGeneration}&after=0`).then(r => r.json());
  assert.equal(batch.chunks.length, 0);
  await f.call("/health"); // Normal maintenance removes objects; audio reads only enforce freshness.
  assert.equal(f.BUCKET.objects.size, 0);
  assert.equal((await f.control(2, false, false)).status, 200);
  assert.equal((await f.upload("output", on.outputGeneration, 9)).status, 409);
});

test("late sound and microphone uploads cannot publish after mute or lock", async t => {
  const f = await audioFixture(t);
  const on = await f.control(1, true, true).then(r => r.json());
  f.BUCKET.beforePut = async () => { assert.equal((await f.control(2, false, false)).status, 200); };
  assert.equal((await f.upload("output", on.outputGeneration, 1)).status, 204);
  assert.equal(f.BUCKET.objects.size, 0);
  const again = await f.control(3, true, true).then(r => r.json());
  f.BUCKET.beforePut = async () => { await f.ready(false); };
  assert.equal((await f.upload("input", again.inputGeneration, 1)).status, 204);
  assert.equal(f.BUCKET.objects.size, 0);
  const state = await f.call("/agent/audio-state", "GET", undefined, true).then(r => r.json());
  assert.equal(state.micActive, false); assert.equal(state.soundViewers, 0); assert.equal(state.audio.available, false);
});

test("helper expiry stops audio without changing healthy desktop readiness", async t => {
  const f = await audioFixture(t), on = await f.control(1, true, true).then(r => r.json());
  assert.equal((await f.upload("input", on.inputGeneration, 1)).status, 200);
  f.advance(8001);
  const health = await f.call("/health").then(r => r.json());
  assert.equal(health.ready, true); assert.equal(health.audio.available, false); assert.equal(health.audio.microphoneReady, false);
  assert.equal(f.BUCKET.objects.size, 0);
  await f.status(); const state = await f.call("/agent/audio-state", "GET", undefined, true).then(r => r.json());
  assert.equal(state.soundViewers, 0); assert.equal(state.micActive, false, "helper return never resumes a previous capture");
  assert.equal((await f.upload("input", on.inputGeneration, 2)).status, 409);
});

test("viewer close and producer replacement delete audio and reject old epochs", async t => {
  const f = await audioFixture(t), on = await f.control(1, true, true).then(r => r.json());
  await f.upload("output", on.outputGeneration, 1); await f.upload("input", on.inputGeneration, 1);
  assert.equal((await f.call("/viewer/close", "POST", { id: f.id })).status, 200); assert.equal(f.BUCKET.objects.size, 0);
  assert.equal((await f.upload("input", on.inputGeneration, 2)).status, 410);
  const newEpoch = crypto.randomUUID(); assert.equal((await f.call("/agent/connect", "POST", { epoch: newEpoch }, true)).status, 200);
  assert.equal((await f.status()).status, 409);
  const state = await f.call("/agent/audio-state", "GET", undefined, true).then(r => r.json());
  assert.equal(state.epoch, newEpoch); assert.equal(state.audio.available, false); assert.equal(state.micActive, false);
});

test("a heartbeat written after request start does not stop active audio", async t => {
  const f = await audioFixture(t), on = await f.control(1, true, true).then(r => r.json());
  let intercepted = false;
  f.DB.beforeExecute = async query => {
    if (!query.sql?.startsWith("SELECT * FROM desktop_audio_state")) return;
    f.DB.beforeExecute = null; intercepted = true;
    f.advance(250);
    await f.DB.prepare("UPDATE desktop_agent SET last_seen = ?").bind(Date.now()).run();
    await f.DB.prepare("UPDATE desktop_audio_state SET last_seen = ?").bind(Date.now()).run();
  };
  const health = await f.call("/health").then(r => r.json());
  assert.equal(intercepted, true); assert.equal(health.ready, true); assert.equal(health.audio.captureReady, true);
  const viewer = await f.DB.prepare("SELECT sound, mic FROM desktop_viewers WHERE id = ?").bind(f.id).first();
  assert.deepEqual(viewer, { sound: 1, mic: 1 });
  const state = await f.call("/agent/audio-state", "GET", undefined, true).then(r => r.json());
  assert.equal(state.outputGeneration, on.outputGeneration); assert.equal(state.inputGeneration, on.inputGeneration);
});

test("an old unready snapshot cannot clear a newer ready helper subscription", async t => {
  const f = await audioFixture(t), on = await f.control(1, true, true).then(r => r.json());
  const readyStatus = JSON.stringify({ captureReady: true, microphoneReady: true, virtualInputName: "BlackHole 2ch", message: "Ready" });
  await f.DB.prepare("UPDATE desktop_audio_state SET status_json = ?").bind('{"captureReady":false,"microphoneReady":false}').run();
  let intercepted = false;
  f.DB.beforeExecute = async query => {
    if (!query.sql?.startsWith("UPDATE desktop_viewers SET sound = CASE")) return;
    f.DB.beforeExecute = null; intercepted = true; f.advance(50);
    await f.DB.prepare("UPDATE desktop_audio_state SET status_json = ?, last_seen = ?").bind(readyStatus, Date.now()).run();
  };
  await f.call("/health"); assert.equal(intercepted, true);
  const viewer = await f.DB.prepare("SELECT sound, mic FROM desktop_viewers WHERE id = ?").bind(f.id).first();
  assert.deepEqual(viewer, { sound: 1, mic: 1 });
  const state = await f.call("/agent/audio-state", "GET", undefined, true).then(r => r.json());
  assert.equal(state.outputGeneration, on.outputGeneration); assert.equal(state.inputGeneration, on.inputGeneration);
});

test("audio hot routes use bounded D1 round trips and preserve server processing age", async t => {
  const f = await audioFixture(t), on = await f.control(1, true, true).then(r => r.json());
  for (const direction of ["output", "input"]) {
    const generation = on[direction + "Generation"], beforeUpload = f.DB.calls.length;
    assert.equal((await f.upload(direction, generation, 1)).status, 200);
    assert.ok(f.DB.calls.length - beforeUpload <= 4, "upload must not run full maintenance");
    const beforeRead = f.DB.calls.length;
    f.BUCKET.beforeGet = async () => { f.advance(150); };
    const path = direction === "output" ? `/audio?id=${f.id}` : `/agent/microphone?epoch=${f.epoch}`;
    const response = await f.call(`${path}&generation=${generation}&after=0`, "GET", undefined, direction === "input");
    assert.equal(response.status, 200); const batch = await response.json();
    assert.ok(f.DB.calls.length - beforeRead <= 4, "read must not run full maintenance");
    assert.equal(batch.processingMs, 150); assert.equal(batch.chunks[0].ageMs, 150);
    assert.equal(batch.chunks[0].pcm, f.pcm(direction));
  }
});

test("a sound viewer muted during an R2 read cannot receive another viewer's audio", async t => {
  const f = await audioFixture(t), on = await f.control(1, true, false).then(r => r.json());
  const second = await f.open(); await f.control(1, true, false, second);
  await f.upload("output", on.outputGeneration, 1);
  f.BUCKET.beforeGet = async () => { assert.equal((await f.control(2, false, false)).status, 200); };
  assert.equal((await f.call(`/audio?id=${f.id}&generation=${on.outputGeneration}`)).status, 409);
  const other = await f.call(`/audio?id=${second}&generation=${on.outputGeneration}`).then(r => r.json());
  assert.equal(other.chunks.length, 1, "remaining active viewer still receives the current generation");
});

test("audio state polling is one read round trip and never advertises expired capture", async t => {
  const f = await audioFixture(t), on = await f.control(1, true, true).then(r => r.json());
  async function state() {
    const before = f.DB.calls.length;
    const response = await f.call("/agent/audio-state", "GET", undefined, true);
    assert.equal(response.status, 200);
    assert.equal(f.DB.calls.length - before, 1, "frequent helper polls must use one batched read");
    return response.json();
  }
  let value = await state();
  assert.equal(value.soundViewers, 1); assert.equal(value.micActive, true);
  assert.equal(value.audio.captureReady, true); assert.equal(value.audio.micInUse, true);
  assert.equal(value.outputGeneration, on.outputGeneration); assert.equal(value.inputGeneration, on.inputGeneration);
  f.advance(8001); value = await state();
  assert.equal(value.videoReady, true); assert.equal(value.soundViewers, 0); assert.equal(value.micActive, false);
  assert.equal(value.audio.captureReady, false); assert.equal(value.audio.microphoneReady, false);
  assert.equal(value.audio.micInUse, false);
  let row = await f.DB.prepare("SELECT output_generation, input_generation FROM desktop_audio_state").first();
  assert.deepEqual(row, { output_generation: on.outputGeneration, input_generation: on.inputGeneration }, "read polling never mutates generation state");
  f.advance(7000);
  await f.DB.prepare("UPDATE desktop_audio_state SET last_seen = ?").bind(Date.now()).run();
  value = await state();
  assert.equal(value.audio.captureReady, true); assert.equal(value.audio.microphoneReady, true);
  assert.equal(value.soundViewers, 0); assert.equal(value.micActive, false, "expired leases cannot activate capture even before maintenance");
  const newEpoch = crypto.randomUUID();
  await f.DB.prepare("UPDATE desktop_agent SET epoch = ?").bind(newEpoch).run();
  value = await state();
  assert.equal(value.epoch, newEpoch); assert.equal(value.audio.available, false);
  assert.equal(value.soundViewers, 0); assert.equal(value.micActive, false);
  assert.equal(value.outputGeneration, null); assert.equal(value.inputGeneration, null, "an old producer epoch cannot supply capture generations");
});
