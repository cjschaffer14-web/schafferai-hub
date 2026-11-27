// A public, fixed-Mac HTTP transport with a WebSocket-compatible browser API.
// Viewer IDs track short-lived leases. They are not sign-in or secret links.
const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const FRAME_FRESH_MS = 3000;
const INPUT_LIMIT = 128;
const FRAME_INTERVAL_MS = 125, INTERACTION_FRAME_MS = 60, INTERACTION_BOOST_MS = 1000;
const INPUT_COALESCE_MS = 8;
const MAX_STREAM_FRAMES = 12, MAX_STREAM_HEADER_BYTES = 1024;
const MAX_STREAM_BYTES = MAX_STREAM_FRAMES * (MAX_FRAME_BYTES + MAX_STREAM_HEADER_BYTES + 4) + MAX_STREAM_HEADER_BYTES + 8;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export class HTTPDesktopTransport {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  constructor(relayUrl, options = {}) {
    const url = new URL(relayUrl);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) {
      throw new TypeError('The desktop relay must use HTTPS');
    }
    this.url = url.origin;
    this.readyState = HTTPDesktopTransport.CONNECTING;
    this.binaryType = 'blob';
    this.onopen = null; this.onmessage = null; this.onerror = null; this.onclose = null;
    this._fetch = options.fetch || globalThis.fetch.bind(globalThis);
    this._setTimeout = options.setTimeout || globalThis.setTimeout.bind(globalThis);
    this._clearTimeout = options.clearTimeout || globalThis.clearTimeout.bind(globalThis);
    this._queueMicrotask = options.queueMicrotask || globalThis.queueMicrotask.bind(globalThis);
    this._now = options.now || Date.now;
    this._frameStream = options.frameStream === true;
    this._epoch = 0; this._readinessEpoch = 0; this._id = null;
    this._requests = new Set(); this._frameTimer = null; this._pulseTimer = null;
    this._frameBusy = false; this._lastFrameStartedAt = 0; this._interactionUntil = 0;
    this._status = {type: 'status', available: false, ready: false};
    this._lastFrameID = ''; this._lastFrameAt = 0; this._frameUsable = false;
    this._inputQueue = []; this._inputBusy = false; this._inputTimer = null; this._inputMicrotask = null;
    queueMicrotask(() => this._open());
  }

  get viewerId() { return this.readyState === HTTPDesktopTransport.OPEN ? this._id : null; }

  _isOpen(epoch = this._epoch) { return this.readyState === HTTPDesktopTransport.OPEN && epoch === this._epoch; }
  _emit(name, event) { return this[name]?.(event); }
  _emitStatus(status = this._status) {
    if (this.readyState === HTTPDesktopTransport.OPEN) this._emit('onmessage', {data: JSON.stringify({...status, type: 'status'})});
  }
  _acceptStatus(status) {
    if (!isObject(status) || typeof status.available !== 'boolean' || typeof status.ready !== 'boolean') {
      throw new Error('The desktop relay returned an invalid status');
    }
    this._status = {...status, type: 'status'};
    if (!status.available || !status.ready) {
      this._readinessEpoch++;
      this._frameUsable = false;
      this._lastFrameAt = 0;
      this._inputQueue = [];
      this._cancelInputFlush();
    }
    this._emitStatus();
  }
  _frameIsFresh() {
    return this._frameUsable && this._status.available && this._status.ready &&
      this._lastFrameAt > 0 && this._now() - this._lastFrameAt <= FRAME_FRESH_MS;
  }
  _staleFrame() {
    if (!this._frameUsable) return;
    this._frameUsable = false;
    this._inputQueue = [];
    this._cancelInputFlush();
    this._emitStatus({...this._status, ready: false, message: 'Waiting for a fresh desktop frame…'});
  }

  async _request(path, init, consume, timeout = 6000) {
    const controller = new AbortController();
    this._requests.add(controller);
    const timer = this._setTimeout(() => controller.abort(), timeout);
    try {
      const response = await this._fetch(`${this.url}${path}`, {
        ...init, cache: 'no-store', credentials: 'omit', redirect: 'error', signal: controller.signal,
      });
      return await consume(response, controller.signal);
    } finally {
      this._clearTimeout(timer); this._requests.delete(controller);
    }
  }
  async _post(path, value, timeout = 6000) {
    return this._request(path, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(value)}, async response => {
      if (!response.ok) throw new Error(`Desktop request failed (${response.status})`);
      if (!response.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) {
        throw new Error('The desktop relay did not return JSON');
      }
      const data = await response.json();
      if (!isObject(data)) throw new Error('The desktop relay returned an invalid response');
      return data;
    }, timeout);
  }
  async _open() {
    const epoch = this._epoch;
    try {
      const data = await this._post('/viewer/open', {});
      if (typeof data.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(data.id)) {
        throw new Error('The desktop relay did not create a viewer lease');
      }
      if (this.readyState !== HTTPDesktopTransport.CONNECTING || epoch !== this._epoch) {
        this._closeLease(data.id); return;
      }
      this._id = data.id;
      this.readyState = HTTPDesktopTransport.OPEN;
      this._emit('onopen', {type: 'open'});
      if (!this._isOpen(epoch)) return;
      this._acceptStatus(data.status);
      this._pollFrame();
      this._pulseTimer = this._setTimeout(() => this._pulse(), 5000);
    } catch (error) {
      if (epoch === this._epoch) this._fail(error.message || 'Could not connect to the desktop');
    }
  }
  async _pulse() {
    const epoch = this._epoch;
    if (!this._isOpen(epoch)) return;
    try {
      const status = await this._post('/viewer/pulse', {id: this._id});
      if (this._isOpen(epoch)) this._acceptStatus(status);
    } catch (error) { if (this._isOpen(epoch)) this._fail(error.message || 'The desktop lease expired'); }
    finally { if (this._isOpen(epoch)) this._pulseTimer = this._setTimeout(() => this._pulse(), 5000); }
  }
  async _pollFrame() {
    if (this._frameStream) return this._pollFrameStream();
    return this._pollJPEG();
  }
  async _pollJPEG() {
    const epoch = this._epoch, readinessEpoch = this._readinessEpoch;
    if (!this._isOpen(epoch) || this._frameBusy) return;
    this._frameBusy = true; this._frameTimer = null;
    this._lastFrameStartedAt = this._now();
    try {
      if (!this._status.available || !this._status.ready) return;
      const query = new URLSearchParams({id: this._id});
      if (this._lastFrameID) query.set('after', this._lastFrameID);
      const startedAt = this._now();
      const frame = await this._request(`/frame?${query}`, {method: 'GET', headers: {Accept: 'image/jpeg'}}, async response => {
        if (response.status === 204 || response.status === 304) return null;
        if (!response.ok) throw new Error(`Desktop frame request failed (${response.status})`);
        if (response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'image/jpeg') {
          throw new Error('The desktop relay returned a non-image response');
        }
        const length = Number(response.headers.get('Content-Length'));
        if (Number.isFinite(length) && length > MAX_FRAME_BYTES) throw new Error('The desktop frame is too large');
        const id = response.headers.get('X-Frame-ID');
        if (!id || id.length > 160 || /[\u0000-\u001f]/.test(id)) throw new Error('The desktop frame has no valid identity');
        const blob = await response.blob();
        if (blob.size < 4 || blob.size > MAX_FRAME_BYTES) throw new Error('The desktop frame is outside its size limit');
        const start = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
        const end = new Uint8Array(await blob.slice(-2).arrayBuffer());
        if (start[0] !== 0xff || start[1] !== 0xd8 || end[0] !== 0xff || end[1] !== 0xd9) {
          throw new Error('The desktop frame is not a JPEG');
        }
        const ageHeader = response.headers.get('X-Frame-Age-Ms');
        const age = ageHeader === null ? 0 : Number(ageHeader);
        if (!Number.isFinite(age) || age < 0 || age + this._now() - startedAt > FRAME_FRESH_MS) return null;
        return {blob, id};
      }, FRAME_FRESH_MS);
      if (!this._isOpen(epoch) || readinessEpoch !== this._readinessEpoch || !this._status.available || !this._status.ready) return;
      if (!frame) { if (this._lastFrameAt && this._now() - this._lastFrameAt > FRAME_FRESH_MS) this._staleFrame(); return; }
      this._lastFrameID = frame.id;
      this._lastFrameAt = this._now();
      this._frameUsable = true;
      this._emitStatus(); // Readiness always precedes the JPEG it authorizes.
      if (this._isOpen(epoch) && this._frameUsable) await this._emit('onmessage', {data: frame.blob});
    } catch (error) { if (this._isOpen(epoch)) this._fail(error.message || 'The desktop stream stopped'); }
    finally { this._frameBusy = false; if (this._isOpen(epoch)) this._scheduleFrame(); }
  }
  async _pollFrameStream() {
    const epoch = this._epoch, readinessEpoch = this._readinessEpoch;
    if (!this._isOpen(epoch) || this._frameBusy) return;
    this._frameBusy = true; this._frameTimer = null;
    const startedAt = this._lastFrameStartedAt = this._now();
    try {
      if (!this._status.available || !this._status.ready) return;
      const query = new URLSearchParams({id: this._id});
      if (this._lastFrameID) query.set('after', this._lastFrameID);
      await this._request(`/frames?${query}`, {method: 'GET', headers: {Accept: 'application/x-schaffer-frames'}}, async (response, signal) => {
        // Only an endpoint that is absent can select the existing JPEG fallback.
        // Never reinterpret an HTML/sign-in/error body as a frame stream.
        if (response.status === 404 || response.status === 405) { this._frameStream = false; return; }
        if (!response.ok) throw new Error(`Desktop frame stream failed (${response.status})`);
        if (response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/x-schaffer-frames') throw new Error('The desktop relay returned an invalid frame stream');
        const length = Number(response.headers.get('Content-Length'));
        if (Number.isFinite(length) && length > MAX_STREAM_BYTES) throw new Error('The desktop frame stream is too large');
        if (!response.body?.getReader) throw new Error('The desktop frame stream has no readable body');
        const reader = response.body.getReader();
        let chunk = new Uint8Array(), offset = 0, received = 0, frames = 0, lastOffset = 0, statusSeen = false;
        const decoder = new TextDecoder('utf-8', {fatal: true});
        const cancel = () => { Promise.resolve(reader.cancel()).catch(() => {}); };
        signal.addEventListener('abort', cancel, {once: true});
        const read = async count => {
          const output = new Uint8Array(count); let copied = 0;
          while (copied < count) {
            if (signal.aborted || this._now() - startedAt > FRAME_FRESH_MS) throw new Error('The desktop frame stream timed out');
            if (offset === chunk.length) {
              const next = await reader.read();
              if (signal.aborted) throw new Error('The desktop frame stream was aborted');
              if (next.done) throw new Error('The desktop frame stream ended unexpectedly');
              if (!(next.value instanceof Uint8Array)) throw new Error('Invalid desktop frame stream bytes');
              chunk = next.value; offset = 0; received += chunk.byteLength;
              if (received > MAX_STREAM_BYTES) throw new Error('The desktop frame stream is too large');
              if (!chunk.length) continue;
            }
            const amount = Math.min(count - copied, chunk.length - offset);
            output.set(chunk.subarray(offset, offset + amount), copied); offset += amount; copied += amount;
          }
          return output;
        };
        const current = () => this._isOpen(epoch) && readinessEpoch === this._readinessEpoch && this._status.available && this._status.ready;
        const render = async blob => {
          let interrupted;
          const aborted = new Promise((_, reject) => { interrupted = () => reject(new Error('The desktop frame stream was aborted')); });
          signal.addEventListener('abort', interrupted, {once: true});
          try {
            if (signal.aborted) throw new Error('The desktop frame stream was aborted');
            await Promise.race([Promise.resolve(this._emit('onmessage', {data: blob})), aborted]);
          } finally { signal.removeEventListener('abort', interrupted); }
        };
        try {
          while (this._isOpen(epoch)) {
            const prefix = await read(4), headerLength = new DataView(prefix.buffer).getUint32(0, false);
            if (headerLength === 0) {
              if (offset !== chunk.length) throw new Error('Unexpected data after desktop frame stream end');
              break;
            }
            if (statusSeen || headerLength > MAX_STREAM_HEADER_BYTES) throw new Error('Invalid desktop frame stream header');
            let header; try { header = JSON.parse(decoder.decode(await read(headerLength))); } catch { throw new Error('Invalid desktop frame stream metadata'); }
            if (!isObject(header)) throw new Error('Invalid desktop frame stream metadata');
            if (header.type === 'status') {
              if (header.byteLength !== 0) throw new Error('Invalid desktop stream status');
              if (this._isOpen(epoch)) this._acceptStatus(header);
              statusSeen = true; continue;
            }
            const elapsed = this._now() - startedAt;
            if (header.type !== 'frame' || !UUID.test(header.id || '') || !Number.isSafeInteger(header.byteLength) || header.byteLength < 4 || header.byteLength > MAX_FRAME_BYTES || !Number.isFinite(header.ageMs) || header.ageMs < 0 || !Number.isFinite(header.offsetMs) || header.offsetMs < lastOffset || header.offsetMs > elapsed) throw new Error('Invalid desktop frame stream metadata');
            if (++frames > MAX_STREAM_FRAMES) throw new Error('The desktop frame stream contains too many images');
            lastOffset = header.offsetMs;
            const bytes = await read(header.byteLength);
            if (bytes[0] !== 255 || bytes[1] !== 216 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) throw new Error('The desktop stream image is not a JPEG');
            if (!current() || header.id === this._lastFrameID) continue;
            const age = () => header.ageMs + Math.max(0, this._now() - startedAt - header.offsetMs);
            if (age() > FRAME_FRESH_MS) continue;
            this._emitStatus();
            await render(new Blob([bytes], {type: 'image/jpeg'}));
            if (!current()) continue;
            if (age() > FRAME_FRESH_MS) {
              this._frameUsable = false; this._inputQueue = []; this._cancelInputFlush();
              this._emitStatus({...this._status, ready: false, message: 'Waiting for a fresh desktop frame…'}); continue;
            }
            this._lastFrameID = header.id; this._lastFrameAt = this._now() - age(); this._frameUsable = true;
          }
        } finally { signal.removeEventListener('abort', cancel); cancel(); }
      }, FRAME_FRESH_MS);
      if (this._isOpen(epoch) && this._lastFrameAt && this._now() - this._lastFrameAt > FRAME_FRESH_MS) this._staleFrame();
    } catch (error) { if (this._isOpen(epoch)) this._fail(error.message || 'The desktop frame stream stopped'); }
    finally { this._frameBusy = false; if (this._isOpen(epoch)) this._scheduleFrame(); }
  }
  _scheduleFrame() {
    if (!this._isOpen() || this._frameBusy) return;
    this._clearTimeout(this._frameTimer);
    const interval = this._now() < this._interactionUntil ? INTERACTION_FRAME_MS : FRAME_INTERVAL_MS;
    const delay = this._frameStream && this._status.available && this._status.ready ? 0 : Math.max(0, this._lastFrameStartedAt + interval - this._now());
    this._frameTimer = this._setTimeout(() => { this._frameTimer = null; this._pollFrame(); }, delay);
  }
  _boostFrames() {
    this._interactionUntil = this._now() + INTERACTION_BOOST_MS;
    this._scheduleFrame();
  }
  _cancelInputFlush() {
    this._clearTimeout(this._inputTimer); this._inputTimer = null;
    this._inputMicrotask = null;
  }
  _scheduleInputs(critical) {
    if (this._inputBusy) return;
    if (critical) {
      this._clearTimeout(this._inputTimer); this._inputTimer = null;
      if (this._inputMicrotask !== null) return;
      const token = {epoch: this._epoch}; this._inputMicrotask = token;
      // One microtask preserves a synchronous shortcut chord as one batch.
      this._queueMicrotask(() => {
        if (this._inputMicrotask !== token) return;
        this._inputMicrotask = null;
        if (this._isOpen(token.epoch)) this._drainInputs();
      });
    } else if (this._inputTimer === null && this._inputMicrotask === null) {
      this._inputTimer = this._setTimeout(() => { this._inputTimer = null; this._drainInputs(); }, INPUT_COALESCE_MS);
    }
  }

  send(message) {
    if (this.readyState !== HTTPDesktopTransport.OPEN) return false;
    if (typeof message !== 'string' || message.length > 16_384) throw new TypeError('Invalid desktop input');
    const value = JSON.parse(message);
    if (!isObject(value) || value.type !== 'input' || !isObject(value.event)) throw new TypeError('Invalid desktop input');
    const event = value.event;
    if (event.type !== 'release' && !this._frameIsFresh()) { this._staleFrame(); return false; }
    const entry = {event, queuedAt: this._now()};
    if (event.type === 'release') this._inputQueue = [entry];
    else {
      const previous = this._inputQueue.at(-1);
      if (event.type === 'pointer' && event.action === 'move' && previous?.event.type === 'pointer' && previous.event.action === 'move') {
        previous.event = event;
      } else if (event.type === 'scroll' && previous?.event.type === 'scroll') {
        previous.event.deltaX = Math.max(-2000, Math.min(2000, previous.event.deltaX + event.deltaX));
        previous.event.deltaY = Math.max(-2000, Math.min(2000, previous.event.deltaY + event.deltaY));
      } else this._inputQueue.push(entry);
    }
    if (this._inputQueue.length > INPUT_LIMIT) { this._fail('Desktop input queue overflowed'); return false; }
    this._boostFrames();
    const coalescible = event.type === 'scroll' || event.type === 'pointer' && event.action === 'move';
    this._scheduleInputs(!coalescible);
    return true;
  }
  async _drainInputs() {
    if (this._inputBusy) return;
    this._inputBusy = true;
    const epoch = this._epoch;
    try {
      while (this._isOpen(epoch) && this._inputQueue.length) {
        if (this._now() - this._inputQueue[0].queuedAt > 1000) throw new Error('Delayed desktop input was discarded');
        const batch = [];
        while (this._inputQueue.length && batch.length < 64) {
          const candidate = [...batch, this._inputQueue[0]];
          const payload = JSON.stringify({id: this._id, events: candidate.map(entry => entry.event)});
          if (new TextEncoder().encode(payload).length > 12 * 1024) break;
          batch.push(this._inputQueue.shift());
        }
        if (!batch.length) throw new Error('Desktop input exceeds the request size limit');
        if (batch.some(entry => entry.event.type !== 'release') && !this._frameIsFresh()) throw new Error('Desktop input lost its fresh frame');
        // A mutation is attempted exactly once. Unknown outcomes close the lease.
        await this._post('/input', {id: this._id, events: batch.map(entry => entry.event)}, 1000);
      }
    } catch (error) { if (this._isOpen(epoch)) this._fail(error.message || 'Desktop input could not be confirmed'); }
    finally { this._inputBusy = false; }
  }
  _fail(message) {
    if (this.readyState >= HTTPDesktopTransport.CLOSING) return;
    this._emit('onerror', {type: 'error', message});
    this.close(1011, message);
  }
  _closeLease(id) {
    if (!id) return;
    // These are best-effort terminal requests, never input retries. Closing the
    // lease also discards queued events and releases held input server-side.
    for (const [path, body] of [
      ['/input', {id, event: {type: 'release'}}], ['/viewer/close', {id}],
    ]) {
      try {
        Promise.resolve(this._fetch(`${this.url}${path}`, {
          method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body),
          credentials: 'omit', cache: 'no-store', redirect: 'error', keepalive: true,
        })).catch(() => {});
      } catch { /* The server lease expires even if the browser is offline. */ }
    }
  }
  close(code = 1000, reason = 'Disconnected') {
    if (this.readyState >= HTTPDesktopTransport.CLOSING) return;
    this.readyState = HTTPDesktopTransport.CLOSING;
    this._epoch++; this._readinessEpoch++;
    this._clearTimeout(this._frameTimer); this._clearTimeout(this._pulseTimer);
    this._cancelInputFlush();
    for (const request of this._requests) request.abort();
    this._requests.clear(); this._inputQueue = []; this._frameUsable = false;
    this._closeLease(this._id);
    this.readyState = HTTPDesktopTransport.CLOSED;
    queueMicrotask(() => this._emit('onclose', {type: 'close', code, reason, wasClean: code === 1000}));
  }
}
