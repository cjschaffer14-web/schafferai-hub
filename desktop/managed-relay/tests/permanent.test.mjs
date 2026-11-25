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
  assert.equal(batch.chunks.length, 0); assert.equal(f.BUCKET.objects.size, 0);
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
