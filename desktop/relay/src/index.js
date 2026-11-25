// Public desktop access is intentional. AGENT_KEY authenticates only the fixed
// Mac producer; visitors need no account, password, or possession of a token.
// Frames live only in WebSocket sends. No frame, input, or credential is stored.
export const LIMITS = Object.freeze({
  freshnessMs: 35_000,
  maxViewers: 2,
  maxFrameBytes: 2 * 1024 * 1024,
  maxControlBytes: 16_384,
  maxFramesPerSecond: 8,
  maxInputsPerSecond: 120,
  maxStatusPerSecond: 8,
});

const SITE_ORIGINS = new Set([
  "https://schafferai.com",
  "https://www.schafferai.com",
]);
const MODIFIERS = new Set(["Shift", "Control", "Alt", "Meta"]);
const OPEN = 1;

export function allowedOrigin(origin) {
  if (SITE_ORIGINS.has(origin)) return true;
  try {
    const url = new URL(origin);
    return url.origin === origin && url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch {
    return false;
  }
}

function headers(request, contentType = "application/json") {
  const out = {
    "Content-Type": contentType,
    "Cache-Control": "no-store, max-age=0",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Vary": "Origin",
  };
  const origin = request.headers.get("Origin");
  if (allowedOrigin(origin)) out["Access-Control-Allow-Origin"] = origin;
  return out;
}

function json(request, value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: headers(request) });
}

// Compare hashes rather than branching on the first mismatching secret byte.
async function producerAuthorized(request, env) {
  const configured = env.AGENT_KEY;
  if (typeof configured !== "string" || configured.length < 32) return false;
  const bearer = request.headers.get("Authorization") || "";
  if (!bearer.startsWith("Bearer ") || bearer.length > 256) return false;
  const encoder = new TextEncoder();
  const [given, expected] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(bearer.slice(7))),
    crypto.subtle.digest("SHA-256", encoder.encode(configured)),
  ]);
  const a = new Uint8Array(given), b = new Uint8Array(expected);
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) mismatch |= a[i] ^ b[i];
  return mismatch === 0;
}

export async function validateRequest(request, env) {
  const url = new URL(request.url);
  if (url.search || !["/health", "/agent", "/viewer"].includes(url.pathname)) {
    return json(request, { error: "Not found" }, 404);
  }
  if (request.method === "OPTIONS" && url.pathname === "/health") {
    if (!allowedOrigin(request.headers.get("Origin"))) return json(request, { error: "Origin not allowed" }, 403);
    return new Response(null, { status: 204, headers: {
      ...headers(request), "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    } });
  }
  if (request.method !== "GET") return json(request, { error: "Method not allowed" }, 405);
  if (url.pathname === "/agent") {
    if (!await producerAuthorized(request, env)) return json(request, { error: "Producer not authorized" }, 401);
  }
  if (url.pathname === "/viewer" && !allowedOrigin(request.headers.get("Origin"))) {
    return json(request, { error: "Origin not allowed" }, 403);
  }
  if (url.pathname !== "/health" && request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return json(request, { error: "WebSocket upgrade required" }, 426);
  }
  return null;
}

export default {
  async fetch(request, env) {
    const invalid = await validateRequest(request, env);
    if (invalid) return invalid;
    // One immutable room. URL/query/body can never select a machine or target.
    const room = env.DESKTOP.get(env.DESKTOP.idFromName("owner-mac"));
    return room.fetch(request);
  },
};

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function onlyKeys(value, keys) {
  return Object.keys(value).every(key => keys.includes(key));
}

function finiteIn(value, min, max) {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

// Only concrete desktop input crosses the relay. No commands, app/file paths,
// target addresses, arbitrary URLs, scripts, or executable payloads are defined.
export function normalizeInput(event) {
  if (!object(event)) return null;
  if (event.type === "release" && onlyKeys(event, ["type"])) return { type: "release" };
  if (event.type === "pointer" && onlyKeys(event, ["type", "action", "x", "y", "button"]) &&
      ["move", "down", "up"].includes(event.action) &&
      finiteIn(event.x, 0, 1) && finiteIn(event.y, 0, 1) &&
      (event.button === undefined || (Number.isInteger(event.button) && finiteIn(event.button, 0, 2)))) {
    return { type: "pointer", action: event.action, x: event.x, y: event.y, button: event.button ?? 0 };
  }
  if (event.type === "scroll" && onlyKeys(event, ["type", "deltaX", "deltaY"]) &&
      finiteIn(event.deltaX, -3000, 3000) && finiteIn(event.deltaY, -3000, 3000)) {
    return { type: "scroll", deltaX: event.deltaX, deltaY: event.deltaY };
  }
  if (event.type === "key" && onlyKeys(event, ["type", "action", "key", "code", "modifiers"]) &&
      ["down", "up"].includes(event.action) && typeof event.key === "string" &&
      event.key.length >= 1 && event.key.length <= 40 &&
      (event.code === undefined || (typeof event.code === "string" && /^[A-Za-z0-9]{1,32}$/.test(event.code))) &&
      (event.modifiers === undefined || (Array.isArray(event.modifiers) && event.modifiers.length <= 4 &&
        event.modifiers.every(modifier => MODIFIERS.has(modifier))))) {
    return { type: "key", action: event.action, key: event.key, code: event.code || "",
      modifiers: [...new Set(event.modifiers || [])] };
  }
  if (event.type === "text" && onlyKeys(event, ["type", "text"]) &&
      typeof event.text === "string" && event.text.length >= 1 && event.text.length <= 2000 && !event.text.includes("\0")) {
    return { type: "text", text: event.text };
  }
  return null;
}

function attachment(ws) {
  return ws.deserializeAttachment() || {};
}

function send(ws, value) {
  try {
    if (ws.readyState !== OPEN) return false;
    ws.send(typeof value === "string" || value instanceof ArrayBuffer ? value : JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function close(ws, code = 1008, reason = "Invalid message") {
  const meta = attachment(ws);
  meta.closed = true;
  ws.serializeAttachment(meta);
  try { ws.close(code, reason); } catch { /* Already closing. */ }
}

function consume(meta, key, maximum, now) {
  const slot = Math.floor(now / 1000);
  const old = meta[key];
  const next = !old || old.slot !== slot ? { slot, count: 1 } : { slot, count: old.count + 1 };
  meta[key] = next;
  return next.count <= maximum;
}

export class DesktopRoom {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  sockets(role) {
    return this.ctx.getWebSockets(role).filter(ws => ws.readyState === OPEN && !attachment(ws).closed);
  }

  availability(now = Date.now()) {
    const agent = this.sockets("agent")[0];
    const meta = agent ? attachment(agent) : {};
    const fresh = !!agent && typeof meta.lastSeen === "number" &&
      now >= meta.lastSeen && now - meta.lastSeen <= LIMITS.freshnessMs;
    const available = fresh;
    const ready = available && meta.ready === true;
    return {
      type: "status", available, ready,
      connected: !!agent, viewers: this.sockets("viewer").length,
      width: available ? meta.width || 0 : 0,
      height: available ? meta.height || 0 : 0,
      state: !available ? "offline" : meta.state || (ready ? "ready" : "permissions_required"),
      screenRecording: available && meta.screenRecording === true,
      accessibility: available && meta.accessibility === true,
      message: !agent ? "Mac is offline" : !fresh ? "Mac heartbeat expired" :
        meta.message || (ready ? "Mac is available" : "Mac desktop is not ready"),
    };
  }

  broadcastStatus() {
    const status = this.availability();
    for (const viewer of this.sockets("viewer")) send(viewer, status);
  }

  updateViewerCount() {
    const count = this.sockets("viewer").length;
    for (const agent of this.sockets("agent")) send(agent, { type: "viewers", count });
  }

  async fetch(request) {
    // Defense in depth if the DO is invoked directly via another binding.
    const invalid = await validateRequest(request, this.env);
    if (invalid) return invalid;
    const path = new URL(request.url).pathname;
    if (path === "/health") return json(request, this.availability());
    const role = path === "/agent" ? "agent" : "viewer";
    if (role === "viewer" && this.sockets("viewer").length >= LIMITS.maxViewers) {
      return json(request, { error: "Two desktop viewers are already connected" }, 429);
    }
    // Reconnecting the authenticated Mac replaces its previous connection.
    if (role === "agent") {
      for (const previous of this.sockets("agent")) close(previous, 1000, "Mac reconnected");
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [role]);
    server.serializeAttachment({ role, joinedAt: Date.now(), lastSeen: 0, ready: false });
    if (role === "viewer") send(server, this.availability());
    this.updateViewerCount();
    this.broadcastStatus();
    return new Response(null, { status: 101, webSocket: client, headers: headers(request) });
  }

  async webSocketMessage(ws, message) {
    const meta = attachment(ws);
    if (meta.closed || !["agent", "viewer"].includes(meta.role)) return;
    const now = Date.now();
    if (typeof message !== "string") {
      if (meta.role !== "agent") return this.disconnect(ws, 1003, "Viewer input must be JSON");
      const bytes = new Uint8Array(message);
      if (bytes.byteLength < 4 || bytes.byteLength > LIMITS.maxFrameBytes ||
          bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) {
        return this.disconnect(ws, 1009, "Frame must be a bounded JPEG");
      }
      const permitted = consume(meta, "frames", LIMITS.maxFramesPerSecond, now);
      ws.serializeAttachment(meta);
      // Drop excess frames rather than enqueue old screenshots.
      if (permitted && this.availability(now).ready) {
        for (const viewer of this.sockets("viewer")) send(viewer, message);
      }
      return;
    }
    if (new TextEncoder().encode(message).length > LIMITS.maxControlBytes) {
      return this.disconnect(ws, 1009, "Message too large");
    }
    let value;
    try { value = JSON.parse(message); } catch { return this.disconnect(ws); }
    if (!object(value)) return this.disconnect(ws);
    if (meta.role === "agent") {
      if (!["hello", "status", "heartbeat"].includes(value.type) ||
          !consume(meta, "statuses", LIMITS.maxStatusPerSecond, now)) return this.disconnect(ws);
      if (value.ready !== undefined && typeof value.ready !== "boolean") return this.disconnect(ws);
      if (value.width !== undefined && (!Number.isInteger(value.width) || !finiteIn(value.width, 0, 32768))) return this.disconnect(ws);
      if (value.height !== undefined && (!Number.isInteger(value.height) || !finiteIn(value.height, 0, 32768))) return this.disconnect(ws);
      if (value.message !== undefined && (typeof value.message !== "string" || value.message.length > 240)) return this.disconnect(ws);
      if (value.state !== undefined && !["ready", "paused", "locked", "permissions_required", "error"].includes(value.state)) return this.disconnect(ws);
      for (const field of ["screenRecording", "accessibility"]) {
        if (value[field] !== undefined && typeof value[field] !== "boolean") return this.disconnect(ws);
      }
      meta.lastSeen = now;
      for (const name of ["ready", "width", "height", "message", "state", "screenRecording", "accessibility"]) {
        if (value[name] !== undefined) meta[name] = value[name];
      }
      ws.serializeAttachment(meta);
      this.broadcastStatus();
      return;
    }
    if (!consume(meta, "inputs", LIMITS.maxInputsPerSecond, now)) return this.disconnect(ws, 1008, "Input rate exceeded");
    ws.serializeAttachment(meta);
    if (value.type === "ping" && onlyKeys(value, ["type"])) {
      send(ws, this.availability(now));
      return;
    }
    if (value.type !== "input" || !onlyKeys(value, ["type", "event"])) return this.disconnect(ws);
    const event = normalizeInput(value.event);
    if (!event) return this.disconnect(ws);
    const agent = this.sockets("agent")[0];
    if (agent && (event.type === "release" || this.availability(now).ready)) {
      send(agent, { type: "input", event });
    } else send(ws, this.availability(now));
  }

  disconnect(ws, code = 1008, reason = "Invalid message") {
    const role = attachment(ws).role;
    close(ws, code, reason);
    if (role === "viewer") {
      for (const agent of this.sockets("agent")) send(agent, { type: "input", event: { type: "release" } });
      this.updateViewerCount();
    }
    this.broadcastStatus();
  }

  async webSocketClose(ws, code, reason, wasClean) {
    const valid = code >= 1000 && code < 5000 && ![1004, 1005, 1006, 1015].includes(code);
    // A close reason has a 123-byte limit; 30 UTF-16 code units stay below it.
    this.disconnect(ws, valid ? code : 1000, valid ? reason.slice(0, 30) : "Connection closed");
  }

  async webSocketError(ws) {
    this.disconnect(ws, 1011, "Connection error");
  }
}
