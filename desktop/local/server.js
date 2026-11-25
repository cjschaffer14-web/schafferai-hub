import { createServer } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { WebSocket, WebSocketServer } from "ws";
import { normalizeInput, LIMITS, allowedOrigin } from "../relay/src/index.js";

const STATES = new Set(["ready", "paused", "locked", "permissions_required", "error"]);
const encoder = new TextEncoder();
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const onlyKeys = (value, names) => Object.keys(value).every(key => names.includes(key));
const dimension = value => Number.isInteger(value) && value >= 0 && value <= 32768;

function consume(meta, key, maximum, now) {
  const slot = Math.floor(now / 1000);
  const previous = meta[key];
  meta[key] = !previous || previous.slot !== slot ? { slot, count: 1 } : { slot, count: previous.count + 1 };
  return meta[key].count <= maximum;
}

function authorized(header, key) {
  if (typeof header !== "string" || !header.startsWith("Bearer ") || header.length > 256) return false;
  const digest = value => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(header.slice(7)), digest(key));
}

export function createDesktopRelay({ producerKey, now = Date.now } = {}) {
  if (typeof producerKey !== "string" || producerKey.length < 32 || producerKey.length > 249) {
    throw new Error("Private relay config needs a producerKey of 32..249 characters");
  }
  let agent = null;
  const viewers = new Set();
  const metadata = new WeakMap();
  const wss = new WebSocketServer({ noServer: true, maxPayload: LIMITS.maxFrameBytes, perMessageDeflate: false });

  function currentAgent() {
    return agent?.readyState === WebSocket.OPEN ? agent : null;
  }
  function status() {
    const producer = currentAgent();
    const meta = producer ? metadata.get(producer) : {};
    const time = now();
    const available = !!producer && Number.isFinite(meta.lastSeen) &&
      time >= meta.lastSeen && time - meta.lastSeen <= LIMITS.freshnessMs;
    const ready = available && meta.ready === true;
    return { type: "status", available, ready, connected: !!producer, viewers: viewers.size,
      width: available ? meta.width || 0 : 0, height: available ? meta.height || 0 : 0,
      state: !available ? "offline" : meta.state || (ready ? "ready" : "permissions_required"),
      screenRecording: available && meta.screenRecording === true,
      accessibility: available && meta.accessibility === true,
      message: !producer ? "Mac is offline" : !available ? "Mac heartbeat expired" :
        meta.message || (ready ? "Mac is available" : "Mac desktop is not ready"),
    };
  }
  function send(socket, value, binary = false) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    // Never retain a backlog of old desktop frames for a slow connection.
    if (binary && socket.bufferedAmount > LIMITS.maxFrameBytes) {
      disconnect(socket, 1013, "Viewer connection too slow");
      return false;
    }
    try {
      socket.send(binary ? value : JSON.stringify(value), { binary }, error => {
        if (error) disconnect(socket, 1011, "Connection error");
      });
      return true;
    } catch { disconnect(socket, 1011, "Connection error"); return false; }
  }
  function broadcastStatus() { const value = status(); for (const viewer of viewers) send(viewer, value); }
  function countViewers() { send(currentAgent(), { type: "viewers", count: viewers.size }); }
  function cleanup(socket) {
    const meta = metadata.get(socket);
    if (!meta || meta.closed) return;
    meta.closed = true;
    if (socket === agent) agent = null;
    if (viewers.delete(socket)) {
      send(currentAgent(), { type: "input", event: { type: "release" } });
      countViewers();
    }
    broadcastStatus();
  }
  function disconnect(socket, code = 1008, reason = "Invalid message") {
    cleanup(socket);
    try { socket.close(code, reason); } catch { socket.terminate(); }
  }
  function handleProducer(socket, bytes, isBinary) {
    const meta = metadata.get(socket);
    if (socket !== agent || meta.closed) return;
    if (isBinary) {
      if (bytes.length < 4 || bytes.length > LIMITS.maxFrameBytes || bytes[0] !== 0xff ||
          bytes[1] !== 0xd8 || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) {
        return disconnect(socket, 1009, "Frame must be a bounded JPEG");
      }
      if (consume(meta, "frames", LIMITS.maxFramesPerSecond, now()) && status().ready) {
        for (const viewer of viewers) send(viewer, bytes, true);
      }
      return;
    }
    if (bytes.length > LIMITS.maxControlBytes) return disconnect(socket, 1009, "Message too large");
    let value;
    try { value = JSON.parse(bytes.toString()); } catch { return disconnect(socket); }
    if (!object(value) || !["hello", "status", "heartbeat"].includes(value.type) ||
        !consume(meta, "statuses", LIMITS.maxStatusPerSecond, now())) return disconnect(socket);
    if (value.ready !== undefined && typeof value.ready !== "boolean") return disconnect(socket);
    if (value.width !== undefined && !dimension(value.width)) return disconnect(socket);
    if (value.height !== undefined && !dimension(value.height)) return disconnect(socket);
    if (value.state !== undefined && !STATES.has(value.state)) return disconnect(socket);
    if (value.message !== undefined && (typeof value.message !== "string" || value.message.length > 240)) return disconnect(socket);
    for (const key of ["screenRecording", "accessibility"]) {
      if (value[key] !== undefined && typeof value[key] !== "boolean") return disconnect(socket);
    }
    meta.lastSeen = now();
    for (const key of ["ready", "width", "height", "state", "screenRecording", "accessibility", "message"]) {
      if (value[key] !== undefined) meta[key] = value[key];
    }
    broadcastStatus();
  }
  function handleViewer(socket, bytes, isBinary) {
    const meta = metadata.get(socket);
    if (meta.closed) return;
    if (isBinary) return disconnect(socket, 1003, "Viewer input must be JSON");
    if (bytes.length > LIMITS.maxControlBytes) return disconnect(socket, 1009, "Message too large");
    if (!consume(meta, "inputs", LIMITS.maxInputsPerSecond, now())) return disconnect(socket, 1008, "Input rate exceeded");
    let value;
    try { value = JSON.parse(bytes.toString()); } catch { return disconnect(socket); }
    if (!object(value)) return disconnect(socket);
    if (value.type === "ping" && onlyKeys(value, ["type"])) return send(socket, status());
    if (value.type !== "input" || !onlyKeys(value, ["type", "event"])) return disconnect(socket);
    const event = normalizeInput(value.event);
    if (!event) return disconnect(socket);
    if (event.type === "release" || status().ready) send(currentAgent(), { type: "input", event });
    else send(socket, status());
  }
  function responseHeaders(request) {
    const headers = { "Content-Type": "application/json", "Cache-Control": "no-store, max-age=0",
      "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", Vary: "Origin" };
    if (allowedOrigin(request.headers.origin)) headers["Access-Control-Allow-Origin"] = request.headers.origin;
    return headers;
  }
  function reply(request, response, code, value) {
    response.writeHead(code, responseHeaders(request)); response.end(JSON.stringify(value));
  }
  const server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
    const path = request.url;
    if (path !== "/health") return reply(request, response, 404, { error: "Not found" });
    if (request.method === "OPTIONS") {
      if (!allowedOrigin(request.headers.origin)) return reply(request, response, 403, { error: "Origin not allowed" });
      response.writeHead(204, { ...responseHeaders(request), "Access-Control-Allow-Methods": "GET, OPTIONS" });
      return response.end();
    }
    if (request.method !== "GET") return reply(request, response, 405, { error: "Method not allowed" });
    reply(request, response, 200, status());
  });
  server.headersTimeout = 5000;
  server.requestTimeout = 10000;
  server.keepAliveTimeout = 5000;
  server.on("upgrade", (request, socket, head) => {
    function reject(code, message) {
      const body = JSON.stringify({ error: message });
      socket.end(`HTTP/1.1 ${code} ${code === 401 ? "Unauthorized" : code === 403 ? "Forbidden" : code === 429 ? "Too Many Requests" : "Bad Request"}\r\nConnection: close\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nContent-Length: ${encoder.encode(body).length}\r\n\r\n${body}`);
    }
    if (request.method !== "GET" || !["/agent", "/viewer"].includes(request.url)) return reject(404, "Not found");
    const role = request.url === "/agent" ? "agent" : "viewer";
    if (role === "agent" && !authorized(request.headers.authorization, producerKey)) return reject(401, "Producer not authorized");
    // This is a browser-origin check, not visitor authentication.
    if (role === "viewer" && !allowedOrigin(request.headers.origin)) return reject(403, "Origin not allowed");
    if (role === "viewer" && viewers.size >= LIMITS.maxViewers) return reject(429, "Two desktop viewers are already connected");
    wss.handleUpgrade(request, socket, head, ws => {
      metadata.set(ws, { role, ready: false });
      ws.on("pong", () => { const meta = metadata.get(ws); if (meta) meta.awaitingPong = false; });
      if (role === "agent") {
        if (agent) disconnect(agent, 1000, "Mac reconnected");
        agent = ws;
      } else viewers.add(ws);
      ws.on("message", (bytes, isBinary) => role === "agent" ? handleProducer(ws, bytes, isBinary) : handleViewer(ws, bytes, isBinary));
      ws.on("close", () => cleanup(ws));
      ws.on("error", () => cleanup(ws));
      send(ws, role === "viewer" ? status() : { type: "viewers", count: viewers.size });
      if (role === "viewer") countViewers();
      broadcastStatus();
    });
  });
  // A small freshness sweep only publishes state changes; no screenshots saved.
  // It also frees abandoned viewer slots instead of keeping native capture alive.
  let lastAvailability = false;
  const sweep = setInterval(() => {
    const available = status().available;
    if (available !== lastAvailability) { lastAvailability = available; broadcastStatus(); }
    for (const viewer of viewers) {
      const meta = metadata.get(viewer);
      if (meta.awaitingPong) { cleanup(viewer); viewer.terminate(); }
      else { meta.awaitingPong = true; viewer.ping(); }
    }
  }, 15_000);
  sweep.unref();
  server.on("close", () => clearInterval(sweep));
  return {
    server, status,
    async listen(port = 8794) {
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
      return server.address();
    },
    async close() {
      clearInterval(sweep);
      for (const ws of wss.clients) ws.terminate();
      await new Promise(resolve => wss.close(resolve));
      if (server.listening) await new Promise(resolve => server.close(resolve));
    },
  };
}

async function main() {
  const args = process.argv.slice(2);
  let configPath, port = 8794;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--config") configPath = args[++i];
    else if (args[i] === "--port") port = Number(args[++i]);
    else throw new Error("Usage: node server.js --config /private/config.json [--port 8794]");
  }
  if (!configPath || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Private config path and valid port required");
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const relay = createDesktopRelay({ producerKey: config.producerKey });
  await relay.listen(port);
  console.log(`Desktop-only relay listening on http://127.0.0.1:${port}`);
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => relay.close().then(() => process.exit(0)));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => { console.error("Desktop relay could not start; check private config and port availability"); process.exitCode = 1; });
}
