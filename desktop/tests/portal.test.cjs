const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const source = fs.readFileSync(path.join(__dirname, '..', 'portal.js'), 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const settle = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function portal(options = {}) {
  const elements = new Map(), intervals = [], timeouts = new Map(), sockets = [], draws = [];
  let now = 100000, timerId = 0;
  class Target {
    constructor() {
      this.events = new Map(); this.hidden = false; this.disabled = false;
      this.value = ''; this.textContent = ''; this.width = 300; this.height = 150;
      const classes = new Set();
      this.classList = {add: x => classes.add(x), remove: x => classes.delete(x), contains: x => classes.has(x)};
    }
    addEventListener(name, callback) {
      const callbacks = this.events.get(name) || [];
      callbacks.push(callback); this.events.set(name, callbacks);
    }
    emit(name, detail = {}) {
      const event = {preventDefault() {}, getModifierState() { return false; }, pointerId: 1, button: 0, key: 'a', code: 'KeyA', deltaX: 0, deltaY: 20, deltaMode: 0, ...detail};
      for (const cb of this.events.get(name) || []) cb(event);
    }
    setAttribute(name, value) { this[name] = value; }
    getBoundingClientRect() { return options.rect || {left: 120, top: 80, width: 720, height: 450}; }
    getContext() { return {clearRect() {}, drawImage: bitmap => draws.push(bitmap)}; }
    setPointerCapture() {}
    focus() { this.focused = true; }
    async requestFullscreen() {}
  }
  const doc = new Target();
  doc.hidden = false;
  doc.getElementById = id => {
    if (!elements.has(id)) elements.set(id, new Target());
    return elements.get(id);
  };
  doc.exitFullscreen = async () => {};
  const win = new Target();
  class Socket {
    static OPEN = 1;
    constructor(url) { this.url = url; this.readyState = 0; this.sent = []; sockets.push(this); }
    open() { this.readyState = 1; this.onopen?.(); }
    receive(data) { this.onmessage?.({data}); }
    send(data) { this.sent.push(JSON.parse(data)); }
    close(code, reason) { this.readyState = 3; this.closed = {code, reason}; }
    remoteClose() { this.readyState = 3; this.onclose?.(); }
  }
  const fetcher = options.fetch || (async url => ({ok: true, json: async () => url === './config.json' ? {relayUrl: 'https://desktop.example.test'} : {available: true, ready: true}}));
  const bitmapFactory = options.bitmap || (async () => ({width: 1440, height: 900, close() {}}));
  await new AsyncFunction('document', 'window', 'fetch', 'WebSocket', 'Blob', 'createImageBitmap', 'setInterval', 'setTimeout', 'clearTimeout', 'Date', 'URL', 'AbortSignal', source)(
    doc, win, fetcher, Socket, Blob, bitmapFactory,
    (fn, period) => { intervals.push({fn, period}); return intervals.length; },
    (fn, delay) => { const id = ++timerId; timeouts.set(id, {fn, due: now + delay}); return id; },
    id => timeouts.delete(id),
    {now: () => now}, URL, AbortSignal,
  );
  const el = id => doc.getElementById(id);
  return {
    el, doc, win, sockets, draws,
    advance(ms) {
      now += ms;
      for (const [id, timeout] of [...timeouts]) {
        if (timeout.due <= now) { timeouts.delete(id); timeout.fn(); }
      }
      for (const interval of intervals.filter(x => x.period === 2000)) interval.fn();
    },
    open() {
      el('connect').emit('click'); const ws = sockets.at(-1); ws.open();
      ws.receive(JSON.stringify({type: 'status', available: true, ready: true})); return ws;
    },
    async frame(ws = sockets.at(-1)) { ws.receive(new Blob(['JPEG fixture'])); await settle(); },
  };
}

function attemptInput(harness) {
  harness.el('screen').emit('keydown');
  harness.el('screen').emit('wheel');
  harness.el('text').value = 'test';
  harness.el('text-form').emit('submit');
}
const mutations = ws => ws.sent.filter(message => message.type === 'input' && message.event.type !== 'release');

test('opening a socket does not allow input before a real desktop frame', async () => {
  const h = await portal(); const ws = h.open();
  attemptInput(h); h.advance(40);
  assert.deepEqual(mutations(ws), []);
});

test('rendered desktop coordinates map to normalized source coordinates', async () => {
  const h = await portal(); const ws = h.open(); await h.frame();
  assert.equal(h.el('screen').width, 1440); assert.equal(h.el('screen').height, 900);
  h.el('screen').emit('pointerdown', {clientX: 480, clientY: 305});
  assert.deepEqual(mutations(ws).at(-1).event, {type: 'pointer', action: 'down', button: 0, x: .5, y: .5});
  h.el('screen').emit('pointerup', {clientX: 9999, clientY: -10});
  assert.deepEqual(mutations(ws).at(-1).event, {type: 'pointer', action: 'up', button: 0, x: 1, y: 0});
});

test('blur releases held input without replaying it', async () => {
  const h = await portal(); const ws = h.open(); await h.frame();
  h.el('screen').emit('keydown'); h.win.emit('blur');
  assert.equal(ws.sent.at(-1).event.type, 'release');
  const sent = ws.sent.length; await settle();
  assert.equal(ws.sent.length, sent);
});

test('hidden pages release keys then close the connection', async () => {
  const h = await portal(); const ws = h.open(); await h.frame();
  h.el('screen').emit('keydown'); h.doc.hidden = true; h.doc.emit('visibilitychange');
  assert.equal(ws.sent.at(-1).event.type, 'release');
  assert.equal(ws.closed.code, 1000);
  assert.equal(h.el('screen').classList.contains('live'), false);
  const sent = ws.sent.length; attemptInput(h);
  assert.equal(ws.sent.length, sent);
});

test('a stale stream blocks every input path until a fresh frame arrives', async () => {
  const h = await portal(); const ws = h.open(); await h.frame();
  h.advance(11000);
  assert.equal(h.el('screen').classList.contains('live'), false);
  assert.equal(ws.sent.at(-1).event.type, 'release');
  const sent = mutations(ws).length; attemptInput(h);
  assert.equal(mutations(ws).length, sent);
});

test('unavailable desktop status blocks input and discards an in-flight old frame', async () => {
  const pending = deferred(); const h = await portal({bitmap: () => pending.promise});
  const ws = h.open(); ws.receive(new Blob(['pending JPEG']));
  ws.receive(JSON.stringify({type: 'status', available: true, ready: false, message: 'Mac locked'}));
  pending.resolve({width: 1440, height: 900, close() {}}); await settle();
  assert.equal(h.el('screen').classList.contains('live'), false);
  assert.equal(h.draws.length, 0);
  attemptInput(h); assert.deepEqual(mutations(ws), []);
});

test('old socket frames and input are not replayed after reconnect', async () => {
  const h = await portal(); const first = h.open(); await h.frame();
  h.el('screen').emit('keydown'); h.el('disconnect').emit('click');
  await settle(); const second = h.open();
  first.receive(new Blob(['old socket JPEG'])); await settle();
  assert.equal(h.el('screen').classList.contains('live'), false);
  assert.deepEqual(mutations(second), []);
  await h.frame(second);
  assert.equal(h.el('screen').classList.contains('live'), true);
  assert.deepEqual(mutations(second), []);
});

test('a JPEG arriving before producer readiness is ignored', async () => {
  const h = await portal(); h.el('connect').emit('click');
  const ws = h.sockets.at(-1); ws.open();
  await h.frame(ws);
  assert.equal(h.draws.length, 0);
  assert.equal(h.el('screen').classList.contains('live'), false);
  ws.receive(JSON.stringify({type: 'status', available: true, ready: true}));
  await h.frame(ws);
  assert.equal(h.draws.length, 1);
});

test('a late health response cannot overwrite a new live connection', async () => {
  const pending = deferred(); let healthCalls = 0;
  const h = await portal({fetch: async url => {
    if (url === './config.json') return {ok: true, json: async () => ({relayUrl: 'https://desktop.example.test'})};
    healthCalls++;
    if (healthCalls === 2) return pending.promise;
    return {ok: true, json: async () => ({available: true, ready: true})};
  }});
  const first = h.open(); await h.frame(first);
  h.el('disconnect').emit('click');
  const second = h.open(); await h.frame(second);
  const liveStatus = h.el('status').textContent;
  pending.resolve({ok: true, json: async () => ({available: false, ready: false, message: 'Old offline response'})});
  await settle();
  assert.equal(h.el('status').textContent, liveStatus);
  assert.equal(h.el('screen').classList.contains('live'), true);
});

test('an unavailable status invalidates old decoding even if readiness returns first', async () => {
  const pending = deferred(); const h = await portal({bitmap: () => pending.promise});
  const ws = h.open(); ws.receive(new Blob(['older JPEG']));
  ws.receive(JSON.stringify({type: 'status', available: true, ready: false}));
  ws.receive(JSON.stringify({type: 'status', available: true, ready: true}));
  pending.resolve({width: 1440, height: 900, close() {}}); await settle();
  assert.equal(h.draws.length, 0);
  assert.equal(h.el('screen').classList.contains('live'), false);
});

test('rapid wheel events coalesce to a bounded scroll update', async () => {
  const h = await portal(); const ws = h.open(); await h.frame();
  for (let i = 0; i < 120; i++) h.el('screen').emit('wheel', {deltaX: 1, deltaY: 20});
  assert.deepEqual(mutations(ws), []);
  h.advance(40);
  assert.deepEqual(mutations(ws).map(x => x.event), [{type: 'scroll', deltaX: 120, deltaY: 2000}]);
});

test('disconnect discards a queued scroll instead of sending it to the next session', async () => {
  const h = await portal(); const first = h.open(); await h.frame();
  h.el('screen').emit('wheel'); h.el('disconnect').emit('click');
  const second = h.open(); await h.frame(second); h.advance(40);
  assert.deepEqual(mutations(first), []);
  assert.deepEqual(mutations(second), []);
});

test('unavailable status discards queued scroll before availability returns', async () => {
  const h = await portal(); const ws = h.open(); await h.frame();
  h.el('screen').emit('wheel');
  ws.receive(JSON.stringify({type: 'status', ready: false, available: true}));
  ws.receive(JSON.stringify({type: 'status', ready: true, available: true}));
  await h.frame(); h.advance(40);
  assert.deepEqual(mutations(ws), []);
});

test('remote socket closure discards queued scroll before reconnect', async () => {
  const h = await portal(); const first = h.open(); await h.frame();
  h.el('screen').emit('wheel'); first.remoteClose();
  const second = h.open(); await h.frame(second); h.advance(40);
  assert.deepEqual(mutations(second), []);
});

test('typing is retained until it can actually be sent to a visible desktop', async () => {
  const h = await portal(); const ws = h.open();
  h.el('text').value = 'Unsent note'; h.el('text-form').emit('submit');
  assert.equal(h.el('text').value, 'Unsent note');
  assert.deepEqual(mutations(ws), []);
  await h.frame(); h.el('text-form').emit('submit');
  assert.equal(h.el('text').value, '');
  assert.deepEqual(mutations(ws).at(-1).event, {type: 'text', text: 'Unsent note'});
});

test('wheel input attempted before a visible frame is never replayed after the frame arrives', async () => {
  const h = await portal(); const ws = h.open();
  h.el('screen').emit('wheel'); await h.frame(); h.advance(40);
  assert.deepEqual(mutations(ws), []);
});
