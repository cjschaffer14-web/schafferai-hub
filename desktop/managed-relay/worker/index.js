// Anonymous public desktop access is intentional. Only the fixed Mac producer
// authenticates. Transient screen and audio content is never logged.
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
async function body(req, limit = 16384) {
  let value; try { value = JSON.parse(new TextDecoder().decode(await bytes(req, limit))); }
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
export function health(agent, viewers, now, audio) {
  // Rows may have been refreshed by another request after this request began.
  now = Math.max(now || 0, Date.now());
  let s = {}; try { s = JSON.parse(agent?.status_json || "{}"); } catch { /* Remain offline. */ }
  const available = !!agent && agent.last_seen > 0 && now >= agent.last_seen && now - agent.last_seen <= LIMITS.freshnessMs;
  const ready = available && s.ready === true;
  return { type: "status", available, ready, connected: available, viewers, ...(audio ? { audio: audioHealth(agent, audio, now) } : {}),
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
const AUDIO_TTL = 1200, HELPER_TTL = 8000;
const readAudio = env => first(env, "SELECT * FROM desktop_audio_state WHERE id = ?", FIXED);
function audioHealth(agent, state, now) {
  now = Math.max(now || 0, Date.now());
  let value = {}; try { value = JSON.parse(state?.status_json || "{}"); } catch {}
  const video = health(agent, 0, now), live = video.ready && video.state === "ready" && state?.epoch === agent?.epoch && state.last_seen > 0 && now >= state.last_seen && now - state.last_seen <= HELPER_TTL;
  return { available: !!live, captureReady: !!live && value.captureReady === true,
    microphoneReady: !!live && value.microphoneReady === true,
    virtualInputName: typeof value.virtualInputName === "string" ? value.virtualInputName : "",
    message: !live ? "Mac audio helper is not ready." : value.message || "Mac audio is ready.",
    micInUse: !!live && !!state.input_owner };
}
async function deleteAudioChunks(env, rows) {
  if (!rows.length) return;
  await env.DB.batch(rows.map(row => stmt(env, "DELETE FROM desktop_audio_chunks WHERE key = ? AND generation = ? AND seq = ?", row.key, row.generation, row.seq)));
  await Promise.all(rows.map(row => env.BUCKET.delete(row.key)));
}
async function clearAllAudio(env) {
  await deleteAudioChunks(env, await all(env, "SELECT * FROM desktop_audio_chunks"));
}
async function syncAudio(env, agent, now) {
  agent = await readAgent(env); // Never let an old request roll a newer producer epoch back.
  if (!agent) { await clearAllAudio(env); return null; }
  await run(env, "INSERT OR IGNORE INTO desktop_audio_state (id, epoch, output_generation, input_generation) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM desktop_agent WHERE id = ? AND epoch = ?)", FIXED, agent.epoch, crypto.randomUUID(), crypto.randomUUID(), FIXED, agent.epoch);
  let state = await readAudio(env);
  if (state.epoch !== agent.epoch) {
    await run(env, "UPDATE desktop_audio_state SET epoch = ?, status_json = '{}', last_seen = 0, output_active = 0, input_owner = '', output_generation = ?, input_generation = ?, output_sequence = 0, input_sequence = 0 WHERE id = ? AND EXISTS (SELECT 1 FROM desktop_agent WHERE id = ? AND epoch = ?)", agent.epoch, crypto.randomUUID(), crypto.randomUUID(), FIXED, FIXED, agent.epoch);
    state = await readAudio(env);
  }
  now = Date.now();
  // Evaluate current capabilities atomically. An older unready snapshot must not
  // clear subscriptions after a concurrent heartbeat has restored readiness.
  const capability = flag => `EXISTS (SELECT 1 FROM desktop_audio_state a JOIN desktop_agent d ON d.id = a.id AND d.epoch = a.epoch WHERE a.id = ? AND a.epoch = desktop_viewers.epoch AND a.last_seen >= ? AND d.last_seen >= ? AND json_extract(a.status_json, '$.${flag}') = 1 AND json_extract(d.status_json, '$.ready') = 1 AND COALESCE(json_extract(d.status_json, '$.state'), 'ready') = 'ready')`;
  await run(env, `UPDATE desktop_viewers SET sound = CASE WHEN ${capability("captureReady")} THEN sound ELSE 0 END, mic = CASE WHEN ${capability("microphoneReady")} THEN mic ELSE 0 END WHERE epoch = ?`, FIXED, now - HELPER_TTL, now - LIMITS.freshnessMs, FIXED, now - HELPER_TTL, now - LIMITS.freshnessMs, agent.epoch);
  // Expressions execute atomically against current leases, rather than the caller's
  // earlier snapshot. A generation changes whenever a direction stops or starts.
  const active = "EXISTS (SELECT 1 FROM desktop_viewers WHERE epoch = desktop_audio_state.epoch AND expires_at >= ? AND sound = 1)";
  const owner = "COALESCE((SELECT id FROM desktop_viewers WHERE epoch = desktop_audio_state.epoch AND expires_at >= ? AND mic = 1 ORDER BY id LIMIT 1), '')";
  await run(env, `UPDATE desktop_audio_state SET output_generation = CASE WHEN output_active != ${active} THEN ? ELSE output_generation END, output_sequence = CASE WHEN output_active != ${active} THEN 0 ELSE output_sequence END, output_active = ${active}, input_generation = CASE WHEN input_owner != ${owner} THEN ? ELSE input_generation END, input_sequence = CASE WHEN input_owner != ${owner} THEN 0 ELSE input_sequence END, input_owner = ${owner} WHERE id = ? AND epoch = ?`, now, crypto.randomUUID(), now, now, now, crypto.randomUUID(), now, now, FIXED, agent.epoch);
  state = await readAudio(env); now = Date.now();
  await deleteAudioChunks(env, await all(env, "SELECT * FROM desktop_audio_chunks WHERE epoch != ? OR created_at < ? OR (direction = 'output' AND generation != ?) OR (direction = 'input' AND generation != ?)", agent.epoch, now - AUDIO_TTL, state.output_generation, state.input_generation));
  return state;
}
function streamResponse(agent, state, direction, chunks = []) {
  return { epoch: agent.epoch, generation: state[direction + "_generation"], sampleRate: direction === "output" ? 48000 : 16000, channels: direction === "output" ? 2 : 1, encoding: "s16le", chunks };
}

// One D1 round trip gives an internally consistent audio/producer/lease snapshot.
// High-rate PCM routes never run lease or object maintenance on their critical path.
async function readAudioContext(env) {
  const result = await env.DB.batch([
    stmt(env, "SELECT * FROM desktop_agent WHERE id = ?", FIXED),
    stmt(env, "SELECT * FROM desktop_audio_state WHERE id = ?", FIXED),
    stmt(env, "SELECT * FROM desktop_viewers WHERE epoch = (SELECT epoch FROM desktop_agent WHERE id = ?)", FIXED),
  ]);
  return { agent: result[0].results?.[0] || null, state: result[1].results?.[0] || null, viewers: result[2].results || [] };
}
async function readAudioState(req, env) {
  const context = await readAudioContext(env), now = Date.now(), { agent } = context;
  const state = context.state?.epoch === agent?.epoch ? context.state : null;
  const viewers = context.viewers.filter(viewer => viewer.epoch === agent?.epoch && viewer.expires_at >= now);
  const video = health(agent, viewers.length, now), audio = audioHealth(agent, state, now);
  const micActive = !!(audio.microphoneReady && state?.input_owner && viewers.some(viewer => viewer.id === state.input_owner && viewer.mic));
  return json(req, { epoch: agent?.epoch || null, videoHealthy: video.available, videoReady: video.ready,
    unlocked: video.ready && video.state === "ready",
    soundViewers: audio.captureReady && state?.output_active ? viewers.filter(viewer => viewer.sound).length : 0,
    micActive, outputGeneration: state?.output_generation || null, inputGeneration: state?.input_generation || null,
    outputSequence: state?.output_sequence || 0, inputSequence: state?.input_sequence || 0,
    audio: { ...audio, micInUse: micActive } });
}
function audioViewer(context, id) {
  if (!UUID.test(id || "")) fail(400, "Valid viewer id required");
  const viewer = context.viewers.find(value => value.id === id && value.epoch === context.agent?.epoch && value.expires_at >= Date.now());
  if (!viewer) fail(410, "Viewer lease expired");
  return viewer;
}
function requireAudio(context, direction, generation, viewerId) {
  const { agent, state, viewers } = context, now = Date.now();
  const capability = audioHealth(agent, state, now);
  if (!state || state.epoch !== agent?.epoch || generation && generation !== state[direction + "_generation"]) fail(409, "Audio generation changed");
  if (direction === "output") {
    if (!capability.captureReady || !state.output_active || !viewers.some(viewer => viewer.sound && viewer.epoch === agent.epoch && viewer.expires_at >= now)) fail(409, "Sound is stopped");
    if (viewerId && !audioViewer(context, viewerId).sound) fail(409, "Sound is stopped");
  } else {
    const owner = viewers.find(viewer => viewer.id === state.input_owner && viewer.mic && viewer.epoch === agent.epoch && viewer.expires_at >= now);
    if (!capability.microphoneReady || !owner || viewerId && owner.id !== viewerId) fail(409, "Microphone is stopped");
  }
}
function audioGate(direction, epoch, generation, viewerId, now) {
  const flag = direction === "output" ? "captureReady" : "microphoneReady";
  const subscription = direction === "output"
    ? "output_active = 1 AND EXISTS (SELECT 1 FROM desktop_viewers v WHERE v.epoch = desktop_audio_state.epoch AND v.expires_at >= ? AND v.sound = 1)"
    : "input_owner = ? AND EXISTS (SELECT 1 FROM desktop_viewers v WHERE v.id = desktop_audio_state.input_owner AND v.epoch = desktop_audio_state.epoch AND v.expires_at >= ? AND v.mic = 1)";
  return {
    sql: `id = ? AND epoch = ? AND ${direction}_generation = ? AND last_seen >= ? AND json_extract(status_json, '$.${flag}') = 1 AND ${subscription} AND EXISTS (SELECT 1 FROM desktop_agent d WHERE d.id = desktop_audio_state.id AND d.epoch = desktop_audio_state.epoch AND d.last_seen >= ? AND json_extract(d.status_json, '$.ready') = 1 AND COALESCE(json_extract(d.status_json, '$.state'), 'ready') = 'ready')`,
    args: [FIXED, epoch, generation, now - HELPER_TTL, ...(direction === "input" ? [viewerId] : []), now, now - LIMITS.freshnessMs],
  };
}
function normalizePcm(value, direction) {
  const expected = direction === "output" ? 38400 : 6400;
  if (value.encoding !== "s16le" || value.sampleRate !== (direction === "output" ? 48000 : 16000) || value.channels !== (direction === "output" ? 2 : 1) || !Number.isSafeInteger(value.seq) || value.seq < 1 || value.seq > 2147483647 || !UUID.test(value.generation || "") || typeof value.pcm !== "string" || value.pcm.length !== Math.ceil(expected / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value.pcm)) fail(400, "Invalid PCM audio chunk");
  let decoded; try { decoded = atob(value.pcm); } catch { fail(400, "Invalid PCM encoding"); }
  if (decoded.length !== expected || btoa(decoded) !== value.pcm) fail(400, "Invalid PCM length");
  return Uint8Array.from(decoded, c => c.charCodeAt(0));
}
async function uploadAudio(req, env, context, value, direction, receivedAt, viewerId) {
  const { agent, state } = context, now = Date.now();
  const pcm = normalizePcm(value, direction), generation = direction + "_generation", sequence = direction + "_sequence", slotField = direction + "_slot", countField = direction + "_count";
  requireAudio(context, direction, value.generation, viewerId);
  const slot = Math.floor(now / 1000);
  const reserveGate = audioGate(direction, agent.epoch, value.generation, viewerId, now);
  const reserved = await run(env, `UPDATE desktop_audio_state SET ${sequence} = ?, ${countField} = CASE WHEN ${slotField} = ? THEN ${countField} + 1 ELSE 1 END, ${slotField} = ? WHERE ${sequence} < ? AND (${slotField} != ? OR ${countField} < 10) AND ${reserveGate.sql}`, value.seq, slot, slot, value.seq, slot, ...reserveGate.args);
  if (!changed(reserved)) fail(409, "Audio sequence, rate or generation changed");
  const key = `desktop-audio/${agent.epoch}/${direction}/${value.generation}/${value.seq}.pcm`;
  await env.BUCKET.put(key, pcm, { httpMetadata: { contentType: "application/octet-stream", cacheControl: "no-store" }, customMetadata: { generation: value.generation, seq: String(value.seq) } });
  if (Date.now() - receivedAt > AUDIO_TTL) { await env.BUCKET.delete(key); return empty(req, 204); }
  const publishGate = audioGate(direction, agent.epoch, value.generation, viewerId, Date.now());
  const published = await run(env, `INSERT OR REPLACE INTO desktop_audio_chunks (key, epoch, direction, generation, seq, created_at) SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM desktop_audio_state WHERE ${publishGate.sql})`, key, agent.epoch, direction, value.generation, value.seq, receivedAt, ...publishGate.args);
  if (!changed(published)) { await env.BUCKET.delete(key); return empty(req, 204); }
  return json(req, { accepted: true, seq: value.seq, generation: value.generation });
}
async function readAudioChunks(req, env, context, direction, generation, after, startedAt, viewerId) {
  const { agent, state } = context;
  if (!Number.isSafeInteger(after) || after < 0) fail(400, "Valid audio sequence required");
  requireAudio(context, direction, generation, viewerId);
  const rows = await all(env, "SELECT * FROM desktop_audio_chunks WHERE epoch = ? AND direction = ? AND generation = ? AND seq > ? AND created_at >= ? ORDER BY seq DESC LIMIT 6", agent.epoch, direction, state[direction + "_generation"], after, Date.now() - AUDIO_TTL);
  const payloads = await Promise.all(rows.reverse().map(async row => {
    const chunk = await env.BUCKET.get(row.key);
    if (!chunk || chunk.customMetadata?.generation !== row.generation || chunk.customMetadata?.seq !== String(row.seq)) return null;
    const data = new Uint8Array(await new Response(chunk.body).arrayBuffer());
    const expected = direction === "output" ? 38400 : 6400;
    if (data.length !== expected) return null;
    let binary = ""; for (const byte of data) binary += String.fromCharCode(byte);
    return { row, pcm: btoa(binary) };
  }));
  // A mute/lock while R2 reads were pending must invalidate the whole response.
  const latest = await readAudioContext(env);
  if (latest.agent?.epoch !== agent.epoch) fail(409, "Producer epoch changed");
  requireAudio(latest, direction, state[direction + "_generation"], viewerId);
  const now = Date.now(), chunks = payloads.filter(value => value && now >= value.row.created_at && now - value.row.created_at <= AUDIO_TTL)
    .map(({ row, pcm }) => ({ seq: row.seq, ageMs: now - row.created_at, pcm }));
  return json(req, { ...streamResponse(agent, state, direction, chunks), processingMs: Math.max(0, now - startedAt) });
}

async function handleAudio(req, env, url, path, startedAt) {
  if (path === "/agent/audio" || path === "/microphone") {
    const output = path === "/agent/audio", value = await body(req, output ? 71680 : 16384);
    if (!keys(value, [output ? "epoch" : "id", "generation", "seq", "sampleRate", "channels", "encoding", "pcm"])) fail(400, "Unknown audio field");
    if (!output && !UUID.test(value.id || "")) fail(400, "Valid viewer id required");
    const context = await readAudioContext(env);
    if (output) requireEpoch(value.epoch, context.agent); else audioViewer(context, value.id);
    return uploadAudio(req, env, context, value, output ? "output" : "input", startedAt, output ? undefined : value.id);
  }
  const output = path === "/audio", id = output ? url.searchParams.get("id") : undefined;
  if (output && !UUID.test(id || "")) fail(400, "Valid viewer id required");
  const context = await readAudioContext(env);
  if (output) audioViewer(context, id); else requireEpoch(url.searchParams.get("epoch"), context.agent);
  return readAudioChunks(req, env, context, output ? "output" : "input", url.searchParams.get("generation"), Number(url.searchParams.get("after") || 0), startedAt, id);
}

async function cleanup(env, now) {
  const agent = await readAgent(env);
  const expired = await all(env, "SELECT id FROM desktop_viewers WHERE expires_at < ?", now);
  await env.DB.batch([stmt(env, "DELETE FROM desktop_events WHERE expires_at < ? OR (viewer_id IS NOT NULL AND viewer_id NOT IN (SELECT id FROM desktop_viewers WHERE expires_at >= ?))", now, now), stmt(env, "DELETE FROM desktop_viewers WHERE expires_at < ?", now)]);
  if (agent && expired.length) await release(env, agent.epoch, now);
  const count = await countViewers(env, agent?.epoch, now);
  if (agent?.frame_key && (!health(agent, count, now).ready || count === 0 || now - agent.frame_at > LIMITS.frameTtlMs)) await clearFrame(env, agent);
  const current = await readAgent(env);
  return { agent: current, count, audio: await syncAudio(env, current, now) };
}
function requireEpoch(epoch, agent) { if (!UUID.test(epoch || "")) fail(400, "Valid epoch required"); if (!agent || agent.epoch !== epoch) fail(409, "Producer epoch changed"); }
async function requireViewer(env, id, agent, now) {
  if (!UUID.test(id || "")) fail(400, "Valid viewer id required");
  const viewer = await first(env, "SELECT * FROM desktop_viewers WHERE id = ? AND epoch = ? AND expires_at >= ?", id, agent?.epoch || "", now);
  if (!viewer) fail(410, "Viewer lease expired"); return viewer;
}
const ROUTES = new Map([["/health", "GET"], ["/agent/connect", "POST"], ["/agent/status", "POST"], ["/agent/poll", "GET"], ["/agent/frame", "PUT,DELETE"], ["/agent/disconnect", "POST"], ["/viewer/open", "POST"], ["/viewer/pulse", "POST"], ["/viewer/close", "POST"], ["/input", "POST"], ["/frame", "GET"], ["/viewer/audio", "POST"], ["/audio", "GET"], ["/microphone", "POST"], ["/agent/audio-state", "GET"], ["/agent/audio/status", "POST"], ["/agent/audio", "POST"], ["/agent/microphone", "GET"]]);
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
  const query = path === "/agent/poll" ? ["epoch", "after"] : path === "/agent/frame" ? ["epoch", "id"] : path === "/frame" ? ["id", "after"] : path === "/audio" ? ["id", "generation", "after"] : path === "/agent/microphone" ? ["epoch", "generation", "after"] : [];
  if ([...url.searchParams.keys()].some(k => !query.includes(k))) fail(400, "Unknown query parameter");
  if (["/audio", "/agent/audio", "/microphone", "/agent/microphone"].includes(path)) return handleAudio(req, env, url, path, now);
  if (path === "/agent/audio-state") return readAudioState(req, env);
  const { agent, count, audio } = await cleanup(env, now);
  if (path === "/health") return json(req, { ...health(agent, count, now, audio), audio: audioHealth(agent, audio, now) });
  if (path === "/agent/audio/status") {
    const v = await body(req); requireEpoch(v.epoch, agent);
    const s = v.status;
    if (!keys(v, ["epoch", "status"]) || !object(s) || !keys(s, ["captureReady", "microphoneReady", "virtualInputName", "message"]) || typeof s.captureReady !== "boolean" || typeof s.microphoneReady !== "boolean" || typeof s.virtualInputName !== "string" || s.virtualInputName.length > 80 || typeof s.message !== "string" || s.message.length > 240) fail(400, "Invalid audio helper status");
    await run(env, "UPDATE desktop_audio_state SET status_json = ?, last_seen = ? WHERE id = ? AND epoch = ?", JSON.stringify(s), Date.now(), FIXED, agent.epoch);
    const state = await syncAudio(env, await readAgent(env), now);
    return json(req, { epoch: agent.epoch, audio: audioHealth(agent, state, now) });
  }
  if (path === "/viewer/audio") {
    const v = await body(req), viewer = await requireViewer(env, v.id, agent, now);
    if (!keys(v, ["id", "revision", "sound", "mic"]) || !Number.isSafeInteger(v.revision) || v.revision < 1 || v.revision > 2147483647 || (v.sound !== undefined && typeof v.sound !== "boolean") || (v.mic !== undefined && typeof v.mic !== "boolean")) fail(400, "Invalid audio controls");
    const sound = v.sound === undefined ? !!viewer.sound : v.sound, mic = v.mic === undefined ? !!viewer.mic : v.mic;
    const capability = audioHealth(agent, audio, now);
    if (sound && !capability.captureReady) fail(409, "Mac system audio is not ready");
    if (mic && !capability.microphoneReady) fail(409, "Mac virtual microphone is not ready");
    const updated = await run(env, "UPDATE desktop_viewers SET sound = ?, mic = ?, audio_revision = ? WHERE id = ? AND epoch = ? AND expires_at >= ? AND audio_revision < ? AND (? = 0 OR NOT EXISTS (SELECT 1 FROM desktop_viewers WHERE epoch = ? AND expires_at >= ? AND mic = 1 AND id != ?))", Number(sound), Number(mic), v.revision, viewer.id, agent.epoch, now, v.revision, Number(mic), agent.epoch, now, viewer.id);
    if (!changed(updated)) fail(409, "Audio controls changed or microphone is in use");
    const state = await syncAudio(env, await readAgent(env), now), current = await requireViewer(env, viewer.id, agent, now);
    return json(req, { epoch: agent.epoch, sound: !!current.sound, mic: !!current.mic, revision: current.audio_revision,
      outputGeneration: state.output_generation, inputGeneration: state.input_generation, audio: audioHealth(agent, state, now) });
  }

  if (path === "/agent/connect") {
    const v = await body(req); if (!keys(v, ["epoch"]) || !UUID.test(v.epoch || "")) fail(400, "Valid epoch required");
    await env.DB.batch([stmt(env, "DELETE FROM desktop_events"), stmt(env, "DELETE FROM desktop_viewers"), stmt(env, "INSERT INTO desktop_agent (id, epoch, status_json, last_seen, frame_at, frame_id, frame_key, frames_slot, frames_count) VALUES (?, ?, ?, ?, 0, '', '', 0, 0) ON CONFLICT(id) DO UPDATE SET epoch = excluded.epoch, status_json = excluded.status_json, last_seen = excluded.last_seen, frame_at = 0, frame_id = '', frame_key = '', frames_slot = 0, frames_count = 0", FIXED, v.epoch, '{"ready":false}', now)]);
    if (agent?.frame_key) await env.BUCKET.delete(agent.frame_key); await clearAllAudio(env); await run(env, "DELETE FROM desktop_audio_state"); return json(req, { epoch: v.epoch, viewers: 0 });
  }
  if (path === "/agent/status") {
    const v = await body(req); requireEpoch(v.epoch, agent); const s = normalizeStatus(v.status); if (!s) fail(400, "Invalid desktop status");
    await run(env, "UPDATE desktop_agent SET status_json = ?, last_seen = ? WHERE id = ? AND epoch = ?", JSON.stringify({ ...JSON.parse(agent.status_json || "{}"), ...s }), Date.now(), FIXED, agent.epoch);
    if (!s.ready) { await clearFrame(env, agent); await run(env, "DELETE FROM desktop_events WHERE epoch = ?", agent.epoch); await syncAudio(env, await readAgent(env), now); }
    return json(req, { epoch: agent.epoch, viewers: count });
  }
  if (path === "/agent/disconnect") {
    const v = await body(req); requireEpoch(v.epoch, agent);
    await env.DB.batch([stmt(env, "DELETE FROM desktop_events WHERE epoch = ?", agent.epoch), stmt(env, "DELETE FROM desktop_viewers WHERE epoch = ?", agent.epoch), stmt(env, "UPDATE desktop_agent SET last_seen = 0, status_json = ? WHERE id = ? AND epoch = ?", '{"ready":false}', FIXED, agent.epoch)]);
    await clearFrame(env, agent); await clearAllAudio(env); await run(env, "DELETE FROM desktop_audio_state"); return json(req, { disconnected: true });
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
    if (!health(agent, count, now, audio).ready || count === 0) return empty(req, 204);
    const frame = await bytes(req, LIMITS.maxFrameBytes);
    if (frame.length < 4 || frame[0] !== 255 || frame[1] !== 216 || frame.at(-2) !== 255 || frame.at(-1) !== 217) fail(400, "JPEG required");
    const slot = Math.floor(now / 1000);
    const quota = await run(env, "UPDATE desktop_agent SET frames_count = CASE WHEN frames_slot = ? THEN frames_count + 1 ELSE 1 END, frames_slot = ? WHERE id = ? AND epoch = ? AND (frames_slot != ? OR frames_count < 8)", slot, slot, FIXED, agent.epoch, slot);
    if (!changed(quota)) return empty(req, 204);
    const key = `desktop/${agent.epoch}/${id}-${crypto.randomUUID()}.jpg`;
    await env.BUCKET.put(key, frame, { httpMetadata: { contentType: "image/jpeg", cacheControl: "no-store" }, customMetadata: { frameId: id } });
    const latest = await readAgent(env), viewers = await countViewers(env, agent.epoch, Date.now());
    if (latest?.epoch !== agent.epoch || latest.frame_revision !== agent.frame_revision || !health(latest, viewers, Date.now()).ready || viewers === 0) { await env.BUCKET.delete(key); return empty(req, 204); }
    const published = await run(env, "UPDATE desktop_agent SET frame_at = ?, frame_id = ?, frame_key = ? WHERE id = ? AND epoch = ? AND frame_revision = ? AND last_seen >= ? AND json_extract(status_json, '$.ready') = 1 AND EXISTS (SELECT 1 FROM desktop_viewers WHERE epoch = ? AND expires_at >= ?)", Date.now(), id, key, FIXED, agent.epoch, agent.frame_revision, Date.now() - LIMITS.freshnessMs, agent.epoch, Date.now());
    if (!changed(published)) { await env.BUCKET.delete(key); return empty(req, 204); }
    if (agent.frame_key && agent.frame_key !== key) await env.BUCKET.delete(agent.frame_key); return json(req, { id });
  }
  if (path === "/viewer/open") {
    await body(req); if (!health(agent, count, now, audio).ready) return json(req, { error: "Mac desktop is not ready", status: health(agent, count, now, audio) }, 503);
    const id = crypto.randomUUID();
    const created = await run(env, "INSERT INTO desktop_viewers (id, epoch, expires_at) SELECT ?, ?, ? WHERE (SELECT COUNT(*) FROM desktop_viewers WHERE epoch = ? AND expires_at >= ?) < 2 AND EXISTS (SELECT 1 FROM desktop_agent WHERE id = ? AND epoch = ? AND last_seen >= ? AND json_extract(status_json, '$.ready') = 1)", id, agent.epoch, now + LIMITS.leaseMs, agent.epoch, now, FIXED, agent.epoch, now - LIMITS.freshnessMs);
    if (!changed(created)) fail(429, "Desktop viewer limit reached"); return json(req, { id, status: health(agent, count + 1, now, audio) });
  }
  if (["/viewer/pulse", "/viewer/close", "/input"].includes(path)) {
    const v = await body(req), viewer = await requireViewer(env, v.id, agent, now);
    if (path === "/viewer/pulse") { await run(env, "UPDATE desktop_viewers SET expires_at = ? WHERE id = ? AND epoch = ?", now + LIMITS.leaseMs, viewer.id, agent.epoch); return json(req, health(agent, count, now, audio)); }
    if (path === "/viewer/close") {
      await env.DB.batch([stmt(env, "DELETE FROM desktop_events WHERE viewer_id = ?", viewer.id), stmt(env, "DELETE FROM desktop_viewers WHERE id = ?", viewer.id)]);
      await release(env, agent.epoch, now); if (count <= 1) await clearFrame(env, agent); await syncAudio(env, await readAgent(env), now); return json(req, { closed: true });
    }
    if (!keys(v, ["id", "event", "events"]) || (v.event === undefined) === (v.events === undefined)) fail(400, "Provide one event or one events batch");
    const raw = v.event === undefined ? v.events : [v.event];
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > 64) fail(400, "Input batch must contain 1 to 64 events");
    const events = raw.map(normalizeInput); if (events.some(event => !event)) fail(400, "Invalid desktop input");
    const requireReady = events.some(event => event.type !== "release") ? 1 : 0;
    if (requireReady && !health(agent, count, now, audio).ready) fail(409, "Mac desktop is not ready");
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
    if (!health(agent, count, now, audio).ready || !agent.frame_id || now - agent.frame_at > LIMITS.frameTtlMs) return empty(req, 204);
    if (url.searchParams.get("after") === agent.frame_id) return empty(req, 304);
    const frame = await env.BUCKET.get(agent.frame_key); if (!frame || frame.customMetadata?.frameId !== agent.frame_id) return empty(req, 204);
    return new Response(frame.body, { headers: { ...headers(req, "image/jpeg"), "X-Frame-ID": agent.frame_id, "X-Frame-Age-Ms": String(Math.max(0, Date.now() - agent.frame_at)) } });
  }
  fail(404, "Not found");
}
