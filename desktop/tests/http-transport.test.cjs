const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'http-transport.js'), 'utf8');
const modulePromise = import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const settle = () => new Promise(resolve => setImmediate(resolve));
const ready = {available: true, ready: true, message: 'Mac is ready'};
const json = (value, status = 200) => new Response(JSON.stringify(value), {status, headers: {'Content-Type': 'application/json'}});
const jpeg = (id = 'frame-1', extraHeaders = {}) => new Response(new Uint8Array([0xff, 0xd8, 0x11, 0x22, 0xff, 0xd9]), {
  status: 200, headers: {'Content-Type': 'image/jpeg', 'X-Frame-ID': id, 'X-Frame-Age-Ms': '0', ...extraHeaders},
});
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return {promise, resolve, reject};
}
async function harness(options = {}) {
  const {HTTPDesktopTransport} = await modulePromise;
  const calls = [], events = [], timers = new Map();
  let now = 100000, timerID = 0, frameID = 0;
  const fetcher = async (url, init) => {
    const parsed = new URL(url), body = init.body ? JSON.parse(init.body) : null;
    const call = {url, path: parsed.pathname, query: parsed.searchParams, body, init}; calls.push(call);
    if (options.fetch) {
      const value = options.fetch(call);
      if (value !== undefined) return value;
    }
    switch (parsed.pathname) {
      case '/viewer/open': return json({id: 'viewer-lease-1', status: ready});
      case '/viewer/pulse': return json(ready);
      case '/frame': return jpeg(`frame-${++frameID}`);
      case '/input': return json({ok: true});
      case '/viewer/close': return json({ok: true});
      default: throw new Error('Unexpected endpoint');
    }
  };
  const transport = new HTTPDesktopTransport('https://desktop.example.test', {
    fetch: fetcher, now: () => now,
    setTimeout(fn, delay) { const id = ++timerID; timers.set(id, {fn, due: now + delay}); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  for (const type of ['open', 'message', 'error', 'close']) transport[`on${type}`] = event => events.push({type, ...event});
  await settle();
  return {
    transport, calls, events,
    frames: () => events.filter(event => event.type === 'message' && event.data instanceof Blob),
    statuses: () => events.filter(event => event.type === 'message' && typeof event.data === 'string').map(event => JSON.parse(event.data)),
    inputs: () => calls.filter(call => call.path === '/input' && call.body.events),
    send(event) { return transport.send(JSON.stringify({type: 'input', event})); },
    async tick(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) if (timer.due <= now) { timers.delete(id); timer.fn(); }
      await settle();
    },
  };
}

test('anonymous HTTP viewing emits readiness before JPEG and sends no visitor credential', async () => {
  const h = await harness();
  assert.equal(h.transport.readyState, 1);
  assert.equal(h.frames().length, 1);
  const frameIndex = h.events.findIndex(event => event.data instanceof Blob);
  assert.equal(JSON.parse(h.events[frameIndex - 1].data).ready, true);
  assert.equal(h.calls[0].path, '/viewer/open');
  assert.deepEqual(h.calls[0].body, {});
  for (const call of h.calls) {
    assert.equal(call.init.credentials, 'omit');
    assert.equal(new Headers(call.init.headers).has('Authorization'), false);
    assert.equal(call.init.redirect, 'error');
  }
  h.transport.close();
});

test('frame polling is sequential and includes only the last frame identity', async () => {
  const next = deferred(); let frames = 0;
  const h = await harness({fetch: call => {
    if (call.path === '/frame' && ++frames === 2) return next.promise;
  }});
  await h.tick(250); assert.equal(frames, 2);
  assert.equal(h.calls.filter(call => call.path === '/frame')[1].query.get('after'), 'frame-1');
  await h.tick(250); assert.equal(frames, 2);
  next.resolve(new Response(null, {status: 304})); await settle();
  assert.equal(h.frames().length, 1);
  h.transport.close();
});

test('viewer pulse renews the same public lease and propagates unavailable status', async () => {
  const h = await harness({fetch: call => call.path === '/viewer/pulse' ? json({available: true, ready: false, message: 'Mac is locked'}) : undefined});
  await h.tick(5000);
  const pulse = h.calls.find(call => call.path === '/viewer/pulse');
  assert.deepEqual(pulse.body, {id: 'viewer-lease-1'});
  assert.equal(h.statuses().at(-1).ready, false);
  assert.equal(h.send({type: 'key', action: 'down', key: 'a', code: 'KeyA'}), false);
  h.transport.close();
});

test('input batches retain key/button order while only adjacent moves and scrolls coalesce', async () => {
  const h = await harness();
  const down = {type: 'pointer', action: 'down', x: .1, y: .1, button: 0};
  const keyDown = {type: 'key', action: 'down', key: 'a', code: 'KeyA'};
  const keyUp = {...keyDown, action: 'up'};
  h.send(down);
  h.send({type: 'pointer', action: 'move', x: .2, y: .2});
  h.send({type: 'pointer', action: 'move', x: .3, y: .3});
  h.send(keyDown);
  h.send({type: 'pointer', action: 'move', x: .4, y: .4});
  h.send({type: 'pointer', action: 'move', x: .5, y: .5});
  h.send({type: 'scroll', deltaX: 2, deltaY: 3}); h.send({type: 'scroll', deltaX: 4, deltaY: 5});
  h.send(keyUp); h.send({...down, action: 'up'});
  assert.equal(h.inputs().length, 0);
  await h.tick(10);
  assert.equal(h.inputs().length, 1);
  assert.deepEqual(h.inputs()[0].body.events, [down,
    {type: 'pointer', action: 'move', x: .3, y: .3}, keyDown,
    {type: 'pointer', action: 'move', x: .5, y: .5},
    {type: 'scroll', deltaX: 6, deltaY: 8}, keyUp, {...down, action: 'up'},
  ]);
  h.transport.close();
});

test('an ambiguous input failure closes the lease without retrying or replaying input', async () => {
  const h = await harness({fetch: call => {
    if (call.path === '/input' && call.body.events) return Promise.reject(new Error('Network outcome unknown'));
  }});
  h.send({type: 'key', action: 'down', key: 'a', code: 'KeyA'});
  await h.tick(10); await h.tick(5000);
  assert.equal(h.inputs().length, 1);
  assert.equal(h.transport.readyState, 3);
  assert.equal(h.events.filter(event => event.type === 'error').length, 1);
  const close = h.calls.find(call => call.path === '/viewer/close');
  assert.deepEqual(close.body, {id: 'viewer-lease-1'});
  assert.equal(close.init.keepalive, true);
  assert.equal(h.calls.some(call => call.path === '/input' && call.body.event?.type === 'release' && call.init.keepalive), true);
});

test('queued input older than one second is discarded before any mutation is attempted', async () => {
  const h = await harness(); h.send({type: 'key', action: 'down', key: 'a', code: 'KeyA'});
  await h.tick(1100);
  assert.equal(h.inputs().length, 0);
  assert.equal(h.transport.readyState, 3);
});

test('one in-flight batch prevents later input from overtaking it', async () => {
  const pending = deferred(); let batches = 0;
  const h = await harness({fetch: call => {
    if (call.path === '/input' && call.body.events && ++batches === 1) return pending.promise;
  }});
  h.send({type: 'key', action: 'down', key: 'a', code: 'KeyA'}); await h.tick(10);
  h.send({type: 'key', action: 'up', key: 'a', code: 'KeyA'}); await h.tick(20);
  assert.equal(h.inputs().length, 1);
  pending.resolve(json({ok: true})); await settle();
  assert.equal(h.inputs().length, 2);
  assert.equal(h.inputs()[0].body.events[0].action, 'down');
  assert.equal(h.inputs()[1].body.events[0].action, 'up');
  h.transport.close();
});

test('Unicode-heavy batches stay below the encoded HTTP body cap without losing order', async () => {
  const h = await harness();
  const event = {type: 'text', text: '😀'.repeat(1000)};
  for (let i = 0; i < 10; i++) h.send(event);
  await h.tick(10);
  assert.equal(h.inputs().length, 4);
  assert.equal(h.inputs().flatMap(call => call.body.events).length, 10);
  for (const call of h.inputs()) assert.ok(Buffer.byteLength(call.init.body, 'utf8') <= 12 * 1024);
  h.transport.close();
});

test('an input request exceeding one second is aborted once and never retried', async () => {
  const h = await harness({fetch: call => {
    if (call.path !== '/input' || !call.body.events) return;
    return new Promise((resolve, reject) => call.init.signal.addEventListener('abort', () => reject(new Error('Aborted')), {once: true}));
  }});
  h.send({type: 'key', action: 'down', key: 'a', code: 'KeyA'});
  await h.tick(10); await h.tick(1001); await h.tick(1000);
  assert.equal(h.inputs().length, 1);
  assert.equal(h.inputs()[0].init.signal.aborted, true);
  assert.equal(h.transport.readyState, 3);
});

test('close aborts frame/status requests and ignores a late JPEG response', async () => {
  const pending = deferred();
  const h = await harness({fetch: call => call.path === '/frame' ? pending.promise : undefined});
  const frameCall = h.calls.find(call => call.path === '/frame');
  h.transport.close(); assert.equal(frameCall.init.signal.aborted, true);
  pending.resolve(jpeg()); await settle();
  assert.equal(h.frames().length, 0);
  assert.equal(h.events.filter(event => event.type === 'close').length, 1);
});

test('closing while open is pending cleans up the late-created lease without opening', async () => {
  const pending = deferred();
  const h = await harness({fetch: call => call.path === '/viewer/open' ? pending.promise : undefined});
  h.transport.close(); pending.resolve(json({id: 'late-lease', status: ready})); await settle();
  assert.equal(h.events.some(event => event.type === 'open'), false);
  assert.equal(h.calls.some(call => call.path === '/viewer/close' && call.body.id === 'late-lease'), true);
});

test('a pulse that removes readiness invalidates an earlier frame still being fetched', async () => {
  const pending = deferred();
  const h = await harness({fetch: call => {
    if (call.path === '/frame') return pending.promise;
    if (call.path === '/viewer/pulse') return json({available: true, ready: false});
  }});
  await h.tick(5000); pending.resolve(jpeg()); await settle();
  assert.equal(h.frames().length, 0);
  assert.equal(h.statuses().at(-1).ready, false);
  h.transport.close();
});

for (const [name, response] of [
  ['HTML sign-in page', () => new Response('<html>Sign in</html>', {headers: {'Content-Type': 'text/html'}})],
  ['overlarge declared JPEG', () => jpeg('large', {'Content-Length': String(2 * 1024 * 1024 + 1)})],
  ['overlarge actual JPEG body', () => new Response(new Uint8Array(2 * 1024 * 1024 + 1), {headers: {'Content-Type': 'image/jpeg', 'X-Frame-ID': 'large-body'}})],
  ['invalid JPEG bytes', () => new Response('not a jpeg', {headers: {'Content-Type': 'image/jpeg', 'X-Frame-ID': 'bad'}})],
  ['missing frame identity', () => new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), {headers: {'Content-Type': 'image/jpeg'}})],
]) {
  test(`${name} is rejected and never rendered`, async () => {
    const h = await harness({fetch: call => call.path === '/frame' ? response() : undefined});
    assert.equal(h.frames().length, 0);
    assert.equal(h.transport.readyState, 3);
    assert.equal(h.events.some(event => event.type === 'error'), true);
  });
}

test('old image age is rejected even when the response is otherwise a JPEG', async () => {
  const h = await harness({fetch: call => call.path === '/frame' ? jpeg('old', {'X-Frame-Age-Ms': '4000'}) : undefined});
  assert.equal(h.frames().length, 0);
  assert.equal(h.send({type: 'text', text: 'must stay local'}), false);
  h.transport.close();
});

test('a stale unchanged frame removes readiness and blocks unseen input', async () => {
  let frames = 0;
  const h = await harness({fetch: call => call.path === '/frame' && ++frames > 1 ? new Response(null, {status: 204}) : undefined});
  assert.equal(h.frames().length, 1);
  await h.tick(3100);
  assert.equal(h.statuses().at(-1).ready, false);
  assert.equal(h.send({type: 'text', text: 'must stay local'}), false);
  assert.equal(h.inputs().length, 0);
  h.transport.close();
});
