/* Work-account authorization client. The server verifies every protected request. */
(function (root) {
  'use strict';
  const SESSION_KEY = 'schafferai_work_session_v1';
  const PRIVATE_ACTIONS = new Set([
    'chat', 'tts', 'send_text', 'rtc_signal', 'twilio_call', 'twilio_sms', 'poll_events',
    'voice_status', 'voice_inbox', 'voice_reply', 'voice_token', 'voice_turn'
  ]);
  class AuthRequiredError extends Error {
    constructor() { super('Sign in to use private work-account tools.'); this.code = 'AUTH_REQUIRED'; }
  }
  function create(options) {
    const fetchImpl = options.fetchImpl || root.fetch.bind(root);
    const storage = options.storage;
    const now = options.now || Date.now;
    const changed = options.onChange || function () {};
    const required = options.onRequired || function () {};
    let session = null, generation = 0;
    try {
      const saved = JSON.parse(storage.getItem(SESSION_KEY) || 'null');
      if (saved && typeof saved.token === 'string' && saved.token.length >= 32 && Number.isFinite(saved.expiresAt) && saved.expiresAt > now() && saved.expiresAt <= now() + 70 * 60 * 1000) session = saved;
      else storage.removeItem(SESSION_KEY);
    } catch (_) { session = null; }
    function clear() {
      generation++; session = null;
      try { storage.removeItem(SESSION_KEY); } catch (_) {}
      changed({ authenticated: false, expiresAt: null });
    }
    function hasSession() {
      if (session && session.expiresAt <= now()) clear();
      return !!session;
    }
    function requireSession() {
      if (hasSession()) return true;
      required();
      return false;
    }
    async function post(payload) {
      // Deliberately no retry: a lost response must not repeat a paid/mutating action.
      const encoded = JSON.stringify(payload);
      if (encoded.length > 32768) throw new Error('Request is too large. Shorten the message and try again.');
      const res = await fetchImpl(options.endpoint, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: encoded, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
      let data;
      try { data = await res.json(); } catch (_) { throw new Error('Work service returned an unreadable response.'); }
      if (res.status === 401 || res.status === 403 || (data && data.code === 'AUTH_REQUIRED')) {
        throw new AuthRequiredError();
      }
      if (!res.ok && res.status) throw new Error('Work service request failed.');
      return data;
    }
    function sessionChanged() { const error = new Error('Session changed; response discarded. The request was not retried.'); error.code = 'SESSION_CHANGED'; return error; }
    async function guardedPost(payload, issuedGeneration) {
      try { return await post(payload); } catch (error) {
        if (issuedGeneration !== generation) throw sessionChanged();
        if (error.code === 'AUTH_REQUIRED') { clear(); required(); }
        throw error;
      }
    }
    async function login(password) {
      if (typeof password !== 'string' || !password || password.length > 256) throw new Error('Enter the website password.');
      const issuedGeneration = generation;
      const data = await guardedPost({ action: 'auth_login', password: password }, issuedGeneration);
      if (issuedGeneration !== generation) throw sessionChanged();
      const expiresAt = Date.parse(data && data.expires_at);
      if (!data || data.ok !== true || data.authenticated !== true || typeof data.token !== 'string' || data.token.length < 32 || !Number.isFinite(expiresAt) || expiresAt <= now() || expiresAt > now() + 70 * 60 * 1000) {
        clear(); throw new Error(data && data.error || 'Sign in failed.');
      }
      generation++; session = { token: data.token, expiresAt: expiresAt };
      try { storage.setItem(SESSION_KEY, JSON.stringify(session)); } catch (_) {}
      changed({ authenticated: true, expiresAt: expiresAt });
      return { authenticated: true, expiresAt: expiresAt };
    }
    async function ping() {
      const payload = { action: 'ping' };
      if (hasSession()) payload.token = session.token;
      const issuedGeneration = generation;
      const data = await guardedPost(payload, issuedGeneration);
      if (issuedGeneration !== generation) return { ok: false, stale: true };
      if ((!data || data.authenticated !== true) && session) clear();
      return data;
    }
    async function request(payload) {
      const action = payload && payload.action || 'chat';
      if (!PRIVATE_ACTIONS.has(action)) throw new Error('Unsupported private website action.');
      if (!requireSession()) throw new AuthRequiredError();
      const issuedGeneration = generation;
      const data = await guardedPost(Object.assign({}, payload, { action: action, token: session.token }), issuedGeneration);
      if (issuedGeneration !== generation || !hasSession()) throw sessionChanged();
      return data;
    }
    async function googlePhoneSession() {
      // Public calling is intentionally independent of private work-account sign-in.
      const gateway = 'https://schafferai-phone-gateway.cjschaffer14.chatgpt.site';
      let response;
      try {
        response = await fetchImpl(gateway + '/session', {
          method: 'POST', cache: 'no-store', credentials: 'omit', redirect: 'error',
          referrerPolicy: 'no-referrer',
          signal: root.AbortSignal && root.AbortSignal.timeout ? root.AbortSignal.timeout(15000) : undefined
        });
      } catch (_) { throw new Error('The Google phone service is unavailable. Try reconnecting.'); }
      let data;
      try { data = await response.json(); } catch (_) { throw new Error('The Google phone service returned an unreadable response.'); }
      if (!response.ok || !data || data.ok !== true) throw new Error(data && data.code === 'GOOGLE_SESSION_EXPIRED' ? 'The Google Voice connection needs renewal.' : 'The Google phone connection failed.');
      let socket;
      try { socket = new URL(data.websocketUrl); } catch (_) { throw new Error('The Google phone session is invalid.'); }
      if (typeof data.uri !== 'string' || !data.authorizationUsername || !data.authorizationPassword || !Number.isFinite(data.expiresAt) || data.expiresAt <= now() || socket.origin !== 'wss://schafferai-phone-gateway.cjschaffer14.chatgpt.site' || socket.pathname !== '/sip' || socket.username || socket.password || socket.hash || !/^[A-Za-z0-9_-]{43}$/.test(socket.searchParams.get('ticket') || '') || [...socket.searchParams.keys()].length !== 1) throw new Error('The Google phone session is invalid.');
      return data;
    }
    return { login: login, request: request, ping: ping, googlePhoneSession: googlePhoneSession, clear: clear, hasSession: hasSession, requireSession: requireSession };
  }
  const api = { create: create, AuthRequiredError: AuthRequiredError, SESSION_KEY: SESSION_KEY };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SchafferWorkAuth = api;
})(typeof window !== 'undefined' ? window : globalThis);
