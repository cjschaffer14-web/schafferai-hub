// Anonymous public desktop access is intentional. Only the fixed Mac producer
// authenticates. Frames overwrite one epoch-specific object; never log content.
export const LIMITS = Object.freeze({ freshnessMs: 35000, leaseMs: 15000,
  inputTtlMs: 2000, frameTtlMs: 3000, maxFrameBytes: 2097152, maxViewers: 2 });
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const encoder = new TextEncoder(), FIXED = "owner-mac";
const object = x => x !== null && typeof x === "object" && !Array.isArray(x);
const keys = (x, names) => Object.keys(x).every(k => names.includes(k));
const range = (x, a, b) => typeof x === "number" && Number.isFinite(x) && x >= a && x <= b;
const stmt = (env, sql, ...args) => env.DB.prepare(sql).bind(...args);
const first = (env, sql, ...args) => stmt(env, sql, ...args).first();
const run = (env, sql, ...args) => stmt(env, sql, ...args).run();
const all = async (env, sql, ...args) => (await stmt(env, sql, ...args).all()).results || [];
const changed = result => Number(result?.meta?.changes || 0) > 0;
function fail(status, message) { const e = new Error(message); e.status = status; throw e; }
export function allowedOrigin(origin) {
  if (["https://schafferai.com", "https://www.schafferai.com"].includes(origin)) return true;
  try { const u = new URL(origin); return u.origin === origin && u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname); }
  catch { return false; }
}
function headers(req, type = "application/json") {
  const h = { "Content-Type": type, "Cache-Control": "no-store, max-age=0", "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer", "Access-Control-Expose-Headers": "X-Frame-ID, X-Frame-Age-Ms", Vary: "Origin" };
  const origin = req.headers.get("Origin"); if (allowedOrigin(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}
const json = (req, value, status = 200) => new Response(JSON.stringify(value), { status, headers: headers(req) });
const empty = (req, status) => new Response(null, { status, headers: headers(req) });
async function bytes(req, limit) {
  if (Number(req.headers.get("Content-Length")) > limit) fail(413, "Payload too large");
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader(), chunks = []; let size = 0;
  while (true) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength;
    if (size > limit) { await reader.cancel(); fail(413, "Payload too large"); } chunks.push(value); }
  const out = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; } return out;
}
async function body(req) {
  let value; try { value = JSON.parse(new TextDecoder().decode(await bytes(req, 16384))); }
  catch (e) { if (e.status) throw e; fail(400, "Invalid JSON"); }
  if (!object(value)) fail(400, "JSON object required"); return value;
}
async function authorized(req, env) {
  const auth = req.headers.get("Authorization") || "";
  if (typeof env.AGENT_KEY !== "string" || env.AGENT_KEY.length < 32 || !auth.startsWith("Bearer ") || auth.length > 256) return false;
  const [a, b] = await Promise.all([auth.slice(7), env.AGENT_KEY].map(x => crypto.subtle.digest("SHA-256", encoder.encode(x))));
  const aa = new Uint8Array(a), bb = new Uint8Array(b); let diff = 0;
  for (let i = 0; i < aa.length; i++) diff |= aa[i] ^ bb[i]; return diff === 0;
}
export function normalizeInput(e) {
  if (!object(e)) return null;
  if (e.type === "release" && keys(e, ["type"])) return { type: "release" };
  if (e.type === "pointer" && keys(e, ["type", "action", "x", "y", "button"]) && ["move", "down", "up"].includes(e.action) && range(e.x, 0, 1) && range(e.y, 0, 1) && (e.button === undefined || Number.isInteger(e.button) && range(e.button, 0, 2))) return { type: "pointer", action: e.action, x: e.x, y: e.y, button: e.button ?? 0 };
  if (e.type === "scroll" && keys(e, ["type", "deltaX", "deltaY"]) && range(e.deltaX, -3000, 3000) && range(e.deltaY, -3000, 3000)) return { type: "scroll", deltaX: e.deltaX, deltaY: e.deltaY };
  if (e.type === "key" && keys(e, ["type", "action", "key", "code", "modifiers"]) && ["down", "up"].includes(e.action) && typeof e.key === "string" && e.key.length >= 1 && e.key.length <= 40 && (e.code === undefined || typeof e.code === "string" && /^[A-Za-z0-9]{1,32}$/.test(e.code)) && (e.modifiers === undefined || Array.isArray(e.modifiers) && e.modifiers.length <= 4 && e.modifiers.every(x => ["Shift", "Control", "Alt", "Meta"].includes(x)))) return { type: "key", action: e.action, key: e.key, code: e.code || "", modifiers: [...new Set(e.modifiers || [])] };
  if (e.type === "text" && keys(e, ["type", "text"]) && typeof e.text === "string" && e.text.length >= 1 && e.text.length <= 2000 && !e.text.includes("\0")) return { type: "text", text: e.text };
  return null;
}
export function normalizeStatus(s) {
  if (!object(s) || !["hello", "status", "heartbeat"].includes(s.type) || typeof s.ready !== "boolean") return null;
  const out = { ready: s.ready };
  for (const k of ["width", "height"]) { if (s[k] !== undefined && (!Number.isInteger(s[k]) || !range(s[k], 0, 32768))) return null; if (s[k] !== undefined) out[k] = s[k]; }
  if (s.state !== undefined && !["ready", "paused", "locked", "permissions_required", "error"].includes(s.state)) return null;
  if (s.state !== undefined) out.state = s.state;
  for (const k of ["screenRecording", "accessibility"]) { if (s[k] !== undefined && typeof s[k] !== "boolean") return null; if (s[k] !== undefined) out[k] = s[k]; }
  if (s.message !== undefined && (typeof s.message !== "string" || s.message.length > 240)) return null;
  if (s.message !== undefined) out.message = s.message; return out;
}
const readAgent = env => first(env, "SELECT * FROM desktop_agent WHERE id = ?", FIXED);
const countViewers = async (env, epoch, now) => Number((await first(env, "SELECT COUNT(*) AS count FROM desktop_viewers WHERE epoch = ? AND expires_at >= ?", epoch || "", now))?.count || 0);
export function health(agent, viewers, now) {
  let s = {}; try { s = JSON.parse(agent?.status_json || "{}"); } catch { /* Remain offline. */ }
  const available = !!agent && agent.last_seen > 0 && now >= agent.last_seen && now - agent.last_seen <= LIMITS.freshnessMs;
  const ready = available && s.ready === true;
  return { type: "status", available, ready, connected: available, viewers,
    width: available ? s.width || 0 : 0, height: available ? s.height || 0 : 0,
    state: !available ? "offline" : s.state || (ready ? "ready" : "permissions_required"),
    screenRecording: available && s.screenRecording === true, accessibility: available && s.accessibility === true,
    message: !agent ? "Mac is offline" : !available ? "Mac heartbeat expired" : s.message || (ready ? "Mac is available" : "Mac desktop is not ready") };
}
async function clearFrame(env, agent) {
  if (!agent) return;
  await run(env, "UPDATE desktop_agent SET frame_at = 0, frame_id = '', frame_key = '', frame_revision = frame_revision + 1 WHERE id = ? AND epoch = ?", FIXED, agent.epoch);
  if (agent.frame_key) await env.BUCKET.delete(agent.frame_key);
}
const release = (env, epoch, now) => run(env, "INSERT INTO desktop_events (epoch, viewer_id, event_json, expires_at) VALUES (?, NULL, ?, ?)", epoch, '{"type":"release"}', now + LIMITS.inputTtlMs);
async function cleanup(env, now) {
  const agent = await readAgent(env);
  const expired = await all(env, "SELECT id FROM desktop_viewers WHERE expires_at < ?", now);
  await env.DB.batch([stmt(env, "DELETE FROM desktop_events WHERE expires_at < ? OR (viewer_id IS NOT NULL AND viewer_id NOT IN (SELECT id FROM desktop_viewers WHERE expires_at >= ?))", now, now), stmt(env, "DELETE FROM desktop_viewers WHERE expires_at < ?", now)]);
  if (agent && expired.length) await release(env, agent.epoch, now);
  const count = await countViewers(env, agent?.epoch, now);
  if (agent?.frame_key && (!health(agent, count, now).ready || count === 0 || now - agent.frame_at > LIMITS.frameTtlMs)) await clearFrame(env, agent);
  return { agent: await readAgent(env), count };
}
function requireEpoch(epoch, agent) { if (!UUID.test(epoch || "")) fail(400, "Valid epoch required"); if (!agent || agent.epoch !== epoch) fail(409, "Producer epoch changed"); }
async function requireViewer(env, id, agent, now) {
  if (!UUID.test(id || "")) fail(400, "Valid viewer id required");
  const viewer = await first(env, "SELECT * FROM desktop_viewers WHERE id = ? AND epoch = ? AND expires_at >= ?", id, agent?.epoch || "", now);
  if (!viewer) fail(410, "Viewer lease expired"); return viewer;
}
const ROUTES = new Map([["/health", "GET"], ["/agent/connect", "POST"], ["/agent/status", "POST"], ["/agent/poll", "GET"], ["/agent/frame", "PUT,DELETE"], ["/agent/disconnect", "POST"], ["/viewer/open", "POST"], ["/viewer/pulse", "POST"], ["/viewer/close", "POST"], ["/input", "POST"], ["/frame", "GET"]]);
export default { async fetch(req, env) { try { return await handle(req, env); } catch (e) { return json(req, { error: e.status ? e.message : "Relay unavailable" }, e.status || 503); } } };
async function handle(req, env) {
  const url = new URL(req.url), path = url.pathname, now = Date.now();
  if (!ROUTES.has(path)) fail(404, "Not found");
  if (path.startsWith("/agent/")) { if (!await authorized(req, env)) fail(401, "Producer not authorized"); }
  else {
    const origin = req.headers.get("Origin"); if (origin && !allowedOrigin(origin)) fail(403, "Origin not allowed");
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...headers(req), "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" } });
  }
  if (!ROUTES.get(path).split(",").includes(req.method)) fail(405, "Method not allowed");
  const query = path === "/agent/poll" ? ["epoch", "after"] : path === "/agent/frame" ? ["epoch", "id"] : path === "/frame" ? ["id", "after"] : [];
  if ([...url.searchParams.keys()].some(k => !query.includes(k))) fail(400, "Unknown query parameter");
  const { agent, count } = await cleanup(env, now);
  if (path === "/health") return json(req, health(agent, count, now));
  if (path === "/agent/connect") {
    const v = await body(req); if (!keys(v, ["epoch"]) || !UUID.test(v.epoch || "")) fail(400, "Valid epoch required");
    await env.DB.batch([stmt(env, "DELETE FROM desktop_events"), stmt(env, "DELETE FROM desktop_viewers"), stmt(env, "INSERT INTO desktop_agent (id, epoch, status_json, last_seen, frame_at, frame_id, frame_key, frames_slot, frames_count) VALUES (?, ?, ?, ?, 0, '', '', 0, 0) ON CONFLICT(id) DO UPDATE SET epoch = excluded.epoch, status_json = excluded.status_json, last_seen = excluded.last_seen, frame_at = 0, frame_id = '', frame_key = '', frames_slot = 0, frames_count = 0", FIXED, v.epoch, '{"ready":false}', now)]);
    if (agent?.frame_key) await env.BUCKET.delete(agent.frame_key); return json(req, { epoch: v.epoch, viewers: 0 });
  }
  if (path === "/agent/status") {
    const v = await body(req); requireEpoch(v.epoch, agent); const s = normalizeStatus(v.status); if (!s) fail(400, "Invalid desktop status");
    await run(env, "UPDATE desktop_agent SET status_json = ?, last_seen = ? WHERE id = ? AND epoch = ?", JSON.stringify({ ...JSON.parse(agent.status_json || "{}"), ...s }), now, FIXED, agent.epoch);
    if (!s.ready) { await clearFrame(env, agent); await run(env, "DELETE FROM desktop_events WHERE epoch = ?", agent.epoch); }
    return json(req, { epoch: agent.epoch, viewers: count });
  }
  if (path === "/agent/disconnect") {
    const v = await body(req); requireEpoch(v.epoch, agent);
    await env.DB.batch([stmt(env, "DELETE FROM desktop_events WHERE epoch = ?", agent.epoch), stmt(env, "DELETE FROM desktop_viewers WHERE epoch = ?", agent.epoch), stmt(env, "UPDATE desktop_agent SET last_seen = 0, status_json = ? WHERE id = ? AND epoch = ?", '{"ready":false}', FIXED, agent.epoch)]);
    await clearFrame(env, agent); return json(req, { disconnected: true });
  }
  if (path === "/agent/poll") {
    requireEpoch(url.searchParams.get("epoch"), agent); const after = Number(url.searchParams.get("after") || 0);
    if (!Number.isSafeInteger(after) || after < 0) fail(400, "Valid acknowledgement required");
    await run(env, "DELETE FROM desktop_events WHERE epoch = ? AND id <= ?", agent.epoch, after);
    const rows = await all(env, "SELECT id, event_json, expires_at FROM desktop_events WHERE epoch = ? AND expires_at >= ? AND (viewer_id IS NULL OR viewer_id IN (SELECT id FROM desktop_viewers WHERE epoch = ? AND expires_at >= ?)) ORDER BY id LIMIT 64", agent.epoch, now, agent.epoch, now);
    const events = []; let size = 0;
    for (const r of rows) { const event = { id: r.id, event: JSON.parse(r.event_json), expiresAt: r.expires_at }; const length = encoder.encode(JSON.stringify(event)).length; if (size + length > 60000) break; size += length; events.push(event); }
    return json(req, { epoch: agent.epoch, viewers: count, events });
  }
  if (path === "/agent/frame") {
    requireEpoch(url.searchParams.get("epoch"), agent);
    if (req.method === "DELETE") { await clearFrame(env, agent); return json(req, { cleared: true }); }
    const id = url.searchParams.get("id"); if (!UUID.test(id || "")) fail(400, "Valid frame id required");
    if (!health(agent, count, now).ready || count === 0) return empty(req, 204);
    const frame = await bytes(req, LIMITS.maxFrameBytes);
    if (frame.length < 4 || frame[0] !== 255 || frame[1] !== 216 || frame.at(-2) !== 255 || frame.at(-1) !== 217) fail(400, "JPEG required");
    const slot = Math.floor(now / 1000);
    const quota = await run(env, "UPDATE desktop_agent SET frames_count = CASE WHEN frames_slot = ? THEN frames_count + 1 ELSE 1 END, frames_slot = ? WHERE id = ? AND epoch = ? AND (frames_slot != ? OR frames_count < 8)", slot, slot, FIXED, agent.epoch, slot);
    if (!changed(quota)) return empty(req, 204);
    const key = `desktop/${agent.epoch}/latest.jpg`;
    await env.BUCKET.put(key, frame, { httpMetadata: { contentType: "image/jpeg", cacheControl: "no-store" }, customMetadata: { frameId: id } });
    const latest = await readAgent(env), viewers = await countViewers(env, agent.epoch, Date.now());
    if (latest?.epoch !== agent.epoch || latest.frame_revision !== agent.frame_revision || !health(latest, viewers, Date.now()).ready || viewers === 0) { await env.BUCKET.delete(key); return empty(req, 204); }
    const published = await run(env, "UPDATE desktop_agent SET frame_at = ?, frame_id = ?, frame_key = ? WHERE id = ? AND epoch = ? AND frame_revision = ? AND last_seen >= ? AND json_extract(status_json, '$.ready') = 1 AND EXISTS (SELECT 1 FROM desktop_viewers WHERE epoch = ? AND expires_at >= ?)", Date.now(), id, key, FIXED, agent.epoch, agent.frame_revision, Date.now() - LIMITS.freshnessMs, agent.epoch, Date.now());
    if (!changed(published)) { await env.BUCKET.delete(key); return empty(req, 204); } return json(req, { id });
  }
  if (path === "/viewer/open") {
    await body(req); if (!health(agent, count, now).ready) return json(req, { error: "Mac desktop is not ready", status: health(agent, count, now) }, 503);
    const id = crypto.randomUUID();
    const created = await run(env, "INSERT INTO desktop_viewers (id, epoch, expires_at) SELECT ?, ?, ? WHERE (SELECT COUNT(*) FROM desktop_viewers WHERE epoch = ? AND expires_at >= ?) < 2 AND EXISTS (SELECT 1 FROM desktop_agent WHERE id = ? AND epoch = ? AND last_seen >= ? AND json_extract(status_json, '$.ready') = 1)", id, agent.epoch, now + LIMITS.leaseMs, agent.epoch, now, FIXED, agent.epoch, now - LIMITS.freshnessMs);
    if (!changed(created)) fail(429, "Desktop viewer limit reached"); return json(req, { id, status: health(agent, count + 1, now) });
  }
  if (["/viewer/pulse", "/viewer/close", "/input"].includes(path)) {
    const v = await body(req), viewer = await requireViewer(env, v.id, agent, now);
    if (path === "/viewer/pulse") { await run(env, "UPDATE desktop_viewers SET expires_at = ? WHERE id = ? AND epoch = ?", now + LIMITS.leaseMs, viewer.id, agent.epoch); return json(req, health(agent, count, now)); }
    if (path === "/viewer/close") {
      await env.DB.batch([stmt(env, "DELETE FROM desktop_events WHERE viewer_id = ?", viewer.id), stmt(env, "DELETE FROM desktop_viewers WHERE id = ?", viewer.id)]);
      await release(env, agent.epoch, now); if (count <= 1) await clearFrame(env, agent); return json(req, { closed: true });
    }
    if (!keys(v, ["id", "event", "events"]) || (v.event === undefined) === (v.events === undefined)) fail(400, "Provide one event or one events batch");
    const raw = v.event === undefined ? v.events : [v.event];
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > 64) fail(400, "Input batch must contain 1 to 64 events");
    const events = raw.map(normalizeInput); if (events.some(event => !event)) fail(400, "Invalid desktop input");
    const requireReady = events.some(event => event.type !== "release") ? 1 : 0;
    if (requireReady && !health(agent, count, now).ready) fail(409, "Mac desktop is not ready");
    const slot = Math.floor(now / 1000);
    const batchId = crypto.randomUUID();
    // The quota reservation and all event inserts form one D1 transaction. A
    // per-batch nonce makes a failed reservation insert zero events atomically.
    const result = await env.DB.batch([
      stmt(env, "UPDATE desktop_viewers SET inputs_count = CASE WHEN inputs_slot = ? THEN inputs_count + ? ELSE ? END, inputs_slot = ?, batch_id = ? WHERE id = ? AND epoch = ? AND expires_at >= ? AND (inputs_slot != ? OR inputs_count + ? <= 120) AND EXISTS (SELECT 1 FROM desktop_agent WHERE id = ? AND epoch = ? AND (? = 0 OR (last_seen >= ? AND json_extract(status_json, '$.ready') = 1)))", slot, events.length, events.length, slot, batchId, viewer.id, agent.epoch, now, slot, events.length, FIXED, agent.epoch, requireReady, now - LIMITS.freshnessMs),
      ...events.map(event => stmt(env, "INSERT INTO desktop_events (epoch, viewer_id, event_json, expires_at) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM desktop_viewers WHERE id = ? AND epoch = ? AND batch_id = ?)", agent.epoch, viewer.id, JSON.stringify(event), now + LIMITS.inputTtlMs, viewer.id, agent.epoch, batchId)),
    ]);
    if (!changed(result[0])) fail(429, "Input rate exceeded or desktop no longer ready");
    return json(req, { accepted: true, count: events.length });
  }
  if (path === "/frame") {
    await requireViewer(env, url.searchParams.get("id"), agent, now);
    if (!health(agent, count, now).ready || !agent.frame_id || now - agent.frame_at > LIMITS.frameTtlMs) return empty(req, 204);
    if (url.searchParams.get("after") === agent.frame_id) return empty(req, 304);
    const frame = await env.BUCKET.get(agent.frame_key); if (!frame || frame.customMetadata?.frameId !== agent.frame_id) return empty(req, 204);
    return new Response(frame.body, { headers: { ...headers(req, "image/jpeg"), "X-Frame-ID": agent.frame_id, "X-Frame-Age-Ms": String(Math.max(0, Date.now() - agent.frame_at)) } });
  }
  fail(404, "Not found");
}
