const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../http-transport.js'), 'utf8');
const modulePromise = import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const settle = () => new Promise(resolve => setImmediate(resolve));
const ready = {available: true, ready: true, audio: {available: true, captureReady: true, microphoneReady: true}};
const json = value => new Response(JSON.stringify(value), {headers: {'Content-Type': 'application/json'}});
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const image = byte => new Uint8Array([255, 216, byte, 255, 217]);
const end = new Uint8Array(4);
const concat = (...values) => {
  const output = new Uint8Array(values.reduce((sum, value) => sum + value.length, 0)); let offset = 0;
  for (const value of values) { output.set(value, offset); offset += value.length; } return output;
};
function packet(header, body = new Uint8Array()) {
  const bytes = new TextEncoder().encode(JSON.stringify(header)), prefix = new Uint8Array(4);
  new DataView(prefix.buffer).setUint32(0, bytes.length, false); return concat(prefix, bytes, body);
}
const frame = (n, overrides = {}, bytes = image(n)) => packet({type: 'frame', id: id(n), ageMs: 0, offsetMs: 0, byteLength: bytes.length, ...overrides}, bytes);
function response(parts, options = {}) {
  let controller, cancelled = false;
  const body = new ReadableStream({start(value) { controller = value; for (const part of parts) value.enqueue(part); if (!options.hold) value.close(); }, cancel() { cancelled = true; }});
  return {response: new Response(body, {headers: {'Content-Type': 'application/x-schaffer-frames', ...options.headers}}),
    push: value => controller.enqueue(value), finish: () => controller.close(), cancelled: () => cancelled};
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return {promise, resolve}; }
async function harness(options = {}) {
  const {HTTPDesktopTransport} = await modulePromise;
  const calls = [], events = [], timers = new Map(); let now = 100000, timer = 0;
  const transport = new HTTPDesktopTransport('https://relay.example', {frameStream: true, now: () => now,
    setTimeout(fn, delay) { timers.set(++timer, {fn, due: now + delay}); return timer; }, clearTimeout(key) { timers.delete(key); },
    fetch: async (url, init) => {
      const parsed = new URL(url), call = {path: parsed.pathname, query: parsed.searchParams, init, body: init.body ? JSON.parse(init.body) : null, at: now}; calls.push(call);
      const custom = options.fetch?.(call); if (custom !== undefined) return custom;
      if (call.path === '/viewer/open') return json({id: 'viewer-lease', status: ready});
      if (call.path === '/viewer/pulse') return json(ready);
      if (call.path === '/frames') return response([end]).response;
      if (call.path === '/frame') return new Response(image(9), {headers: {'Content-Type': 'image/jpeg', 'X-Frame-ID': id(9), 'X-Frame-Age-Ms': '0'}});
      return json({ok: true});
    }});
  for (const type of ['open', 'message', 'error', 'close']) transport[`on${type}`] = event => {
    events.push({type, ...event}); if (type === 'message') return options.onmessage?.(event);
  };
  await settle();
  return {transport, calls, events, frames: () => events.filter(event => event.data instanceof Blob),
    statuses: () => events.filter(event => typeof event.data === 'string').map(event => JSON.parse(event.data)),
    inputs: () => calls.filter(call => call.path === '/input' && call.body.events),
    send: event => transport.send(JSON.stringify({type: 'input', event})),
    async tick(ms) { now += ms; for (const [key, task] of [...timers]) if (task.due <= now) { timers.delete(key); task.fn(); } await settle(); }};
}

test('stream framing survives every byte boundary and emits readiness before the JPEG', async () => {
  const bytes = concat(frame(1), end), parts = Array.from(bytes, byte => new Uint8Array([byte]));
  const h = await harness({fetch: call => call.path === '/frames' ? response(parts).response : undefined});
  assert.equal(h.frames().length, 1); assert.equal(h.transport.readyState, 1);
  const position = h.events.findIndex(event => event.data instanceof Blob); assert.equal(JSON.parse(h.events[position - 1].data).ready, true);
  const request = h.calls.find(call => call.path === '/frames'); assert.equal(request.query.get('id'), 'viewer-lease'); assert.equal(request.query.has('after'), false);
  assert.equal(request.init.headers.Accept, 'application/x-schaffer-frames');
  assert.equal(request.init.credentials, 'omit'); assert.equal(request.init.redirect, 'error');
  assert.equal(new Headers(request.init.headers).has('Authorization'), false); h.transport.close();
});

test('multiple JPEGs stay sequential through decoding, then reconnect immediately with the last identity', async () => {
  const decoding = deferred(); let streams = 0, rendering = 0;
  const h = await harness({fetch: call => call.path === '/frames' && ++streams === 1 ? response([concat(frame(1), frame(2), end)]).response : undefined,
    onmessage: event => event.data instanceof Blob && ++rendering === 1 ? decoding.promise : undefined});
  assert.equal(h.frames().length, 1); assert.equal(h.send({type: 'text', text: 'wait for rendering'}), false);
  await h.tick(100); assert.equal(streams, 1); assert.equal(h.frames().length, 1);
  decoding.resolve(); await settle(); assert.equal(h.frames().length, 2);
  assert.deepEqual(await Promise.all(h.frames().map(async event => new Uint8Array(await event.data.arrayBuffer())[2])), [1, 2]);
  await h.tick(0); assert.equal(streams, 2);
  assert.equal(h.calls.filter(call => call.path === '/frames')[1].query.get('after'), id(2));
  assert.equal(h.calls.some(call => call.path === '/frame'), false); h.transport.close();
});

test('stream age counts server offset once and still discards genuinely stale images', async () => {
  for (const [ageMs, expected] of [[2500, 1], [2951, 0]]) {
    const pending = deferred(); let streams = 0;
    const h = await harness({fetch: call => call.path === '/frames' && ++streams === 1 ? pending.promise : undefined});
    await h.tick(750); pending.resolve(response([concat(frame(1, {ageMs, offsetMs: 700}), end)]).response); await settle();
    assert.equal(h.frames().length, expected); assert.equal(h.transport.readyState, 1); h.transport.close();
  }
});

test('time receiving the JPEG body consumes the remaining freshness budget', async () => {
  const full = frame(1, {ageMs: 2500}), metadataLength = new DataView(full.buffer).getUint32(0, false) + 4;
  const stream = response([full.slice(0, metadataLength)], {hold: true});
  const h = await harness({fetch: call => call.path === '/frames' ? stream.response : undefined});
  await h.tick(600); stream.push(concat(full.slice(metadataLength), end)); stream.finish(); await settle();
  assert.equal(h.frames().length, 0); assert.equal(h.transport.readyState, 1); h.transport.close();
});

test('duplicate cached image identities do not refresh an older frame', async () => {
  const h = await harness({fetch: call => call.path === '/frames' ? response([concat(frame(1), frame(1), end)]).response : undefined});
  assert.equal(h.frames().length, 1); h.transport.close();
});

for (const [name, bytes] of [
  ['oversized metadata prefix', new Uint8Array([0, 0, 4, 1])],
  ['invalid UTF-8 metadata', new Uint8Array([0, 0, 0, 1, 255])],
  ['non-object metadata', packet([])],
  ['missing server offset', concat(frame(1, {offsetMs: undefined}), end)],
  ['future server offset', concat(frame(1, {offsetMs: 1}), end)],
  ['negative server offset', concat(frame(1, {offsetMs: -1}), end)],
  ['oversized JPEG declaration', frame(1, {byteLength: 2 * 1024 * 1024 + 1})],
  ['invalid JPEG bytes', frame(1, {}, new Uint8Array([0, 0, 0, 0]))],
  ['invalid frame identity', concat(frame(1, {id: 'not-a-uuid'}), end)],
  ['truncated JPEG body', frame(1, {byteLength: 100})],
  ['data after end marker', concat(end, new Uint8Array([1]))],
]) {
  test(`${name} is rejected without selecting the JPEG fallback`, async () => {
    const h = await harness({fetch: call => call.path === '/frames' ? response([bytes]).response : undefined});
    assert.equal(h.frames().length, 0); assert.equal(h.transport.readyState, 3);
    assert.equal(h.calls.some(call => call.path === '/frame'), false);
  });
}

test('more than twelve images cannot create an unbounded stream', async () => {
  const h = await harness({fetch: call => call.path === '/frames' ? response([concat(...Array.from({length: 13}, (_, index) => frame(index + 1)), end)]).response : undefined});
  assert.equal(h.frames().length, 12); assert.equal(h.transport.readyState, 3);
});

test('a stream status control preserves audio health and blocks control until readiness returns', async () => {
  const status = {type: 'status', available: true, ready: false, message: 'Mac locked', audio: {available: false, captureReady: false}, byteLength: 0};
  const h = await harness({fetch: call => call.path === '/frames' ? response([concat(packet(status), end)]).response : undefined});
  assert.equal(h.statuses().at(-1).message, 'Mac locked'); assert.deepEqual(h.statuses().at(-1).audio, status.audio);
  assert.equal(h.send({type: 'key', action: 'down', key: 'a', code: 'KeyA'}), false);
  await h.tick(100); assert.equal(h.calls.filter(call => call.path === '/frames').length, 1); h.transport.close();
});

test('a readiness change during JPEG decoding invalidates the old stream even if readiness returns', async () => {
  const decoding = deferred(); const h = await harness({fetch: call => call.path === '/frames' ? response([concat(frame(1), frame(2), end)]).response : undefined,
    onmessage: event => event.data instanceof Blob ? decoding.promise : undefined});
  h.transport._acceptStatus({available: true, ready: false, message: 'Mac locked'});
  h.transport._acceptStatus(ready); decoding.resolve(); await settle();
  assert.equal(h.frames().length, 1); assert.equal(h.transport._lastFrameID, '');
  assert.equal(h.send({type: 'text', text: 'no stale replay'}), false); h.transport.close();
});

test('disconnect aborts a blocked reader and discards pending input', async () => {
  const stream = response([frame(1)], {hold: true});
  const h = await harness({fetch: call => call.path === '/frames' ? stream.response : undefined});
  h.send({type: 'key', action: 'down', key: 'a', code: 'KeyA'}); h.transport.close(); await settle(); await h.tick(5000);
  assert.equal(stream.cancelled(), true); assert.equal(h.inputs().length, 0);
  assert.equal(h.calls.filter(call => call.path === '/frames').length, 1);
  assert.equal(h.events.filter(event => event.type === 'close').length, 1);
});

test('the three-second deadline also interrupts a JPEG consumer that never finishes', async () => {
  const decoding = deferred(), stream = response([frame(1)], {hold: true});
  const h = await harness({fetch: call => call.path === '/frames' ? stream.response : undefined,
    onmessage: event => event.data instanceof Blob ? decoding.promise : undefined});
  await h.tick(3000); assert.equal(h.transport.readyState, 3); assert.equal(stream.cancelled(), true);
  decoding.resolve(); await settle(); assert.equal(h.transport._lastFrameID, '');
});

for (const status of [404, 405]) {
  test(`HTTP ${status} before body decoding selects the existing JPEG path only once`, async () => {
    const absent = {status, get body() { throw new Error('An absent endpoint body must not be decoded'); }};
    const h = await harness({fetch: call => call.path === '/frames' ? absent : undefined});
    await h.tick(125); assert.equal(h.calls.filter(call => call.path === '/frames').length, 1);
    assert.equal(h.calls.filter(call => call.path === '/frame').length, 1); assert.equal(h.frames().length, 1);
    assert.equal(h.transport.readyState, 1); h.transport.close();
  });
}

test('an HTML response is never a streaming fallback or a delivered image', async () => {
  const h = await harness({fetch: call => call.path === '/frames' ? new Response('<html>Sign in</html>', {headers: {'Content-Type': 'text/html'}}) : undefined});
  assert.equal(h.transport.readyState, 3); assert.equal(h.frames().length, 0); assert.equal(h.calls.some(call => call.path === '/frame'), false);
});

test('streaming retains the immediate, ordered shortcut input path', async () => {
  const stream = response([frame(1)], {hold: true});
  const h = await harness({fetch: call => call.path === '/frames' ? stream.response : undefined});
  const chord = [{action: 'down', key: 'Meta', code: 'MetaLeft'}, {action: 'down', key: ' ', code: 'Space'}, {action: 'up', key: ' ', code: 'Space'}, {action: 'up', key: 'Meta', code: 'MetaLeft'}].map(event => ({type: 'key', ...event}));
  for (const event of chord) h.send(event); assert.equal(h.inputs().length, 0); await settle();
  assert.equal(h.inputs().length, 1); assert.deepEqual(h.inputs()[0].body.events, chord);
  assert.equal(h.inputs()[0].at, h.calls[0].at); h.transport.close();
});
