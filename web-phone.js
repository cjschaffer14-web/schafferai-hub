/* Cloud-native Web Phone controller for https://schafferai.com.
 * Uses only the centralized SchafferWorkAuth client for all backend calls. */
(function (root) {
  'use strict';

  const DTMF_FREQS = {
    '1': [697, 1209], '2': [697, 1336], '3': [697, 1477],
    '4': [770, 1209], '5': [770, 1336], '6': [770, 1477],
    '7': [852, 1209], '8': [852, 1336], '9': [852, 1477],
    '*': [941, 1209], '0': [941, 1336], '#': [941, 1477]
  };

  const TWILIO_SDK_URL = 'https://cdn.jsdelivr.net/npm/@twilio/voice-sdk@2.12.2/dist/twilio.min.js';

  function normalizeE164(raw) {
    const s = String(raw || '').trim();
    if (!s) return '';
    const hasPlus = s.startsWith('+');
    const digits = s.replace(/\D+/g, '');
    if (!digits) return '';
    if (!hasPlus && digits.length === 10) return '+1' + digits;
    if (!hasPlus && digits.length === 11 && digits[0] === '1') return '+' + digits;
    if (digits.length >= 8 && digits.length <= 15) return '+' + digits;
    return '';
  }

  function buildGoogleVoiceCallUrl(rawNumber) {
    const e164 = normalizeE164(rawNumber);
    if (!e164) return 'https://voice.google.com/u/0/calls';
    return 'https://voice.google.com/u/0/calls?a=nc,' + encodeURIComponent(e164);
  }

  function buildGoogleVoiceSmsUrl() {
    return 'https://voice.google.com/u/0/messages';
  }

  function playDtmf(win, digit) {
    const pair = DTMF_FREQS[digit];
    const AudioCtx = win && (win.AudioContext || win.webkitAudioContext);
    if (!pair || !AudioCtx) return;
    try {
      if (!playDtmf._ctx) playDtmf._ctx = new AudioCtx();
      const ctx = playDtmf._ctx;
      const now = ctx.currentTime;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.06, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.13);
      gain.connect(ctx.destination);
      for (const freq of pair) {
        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, now);
        osc.connect(gain);
        osc.start(now);
        osc.stop(now + 0.13);
      }
    } catch (_) {}
  }

  function init(opts) {
    const workAuth = opts.workAuth;
    const doc = opts.document;
    const win = opts.window;
    const onLog = opts.onLog || function () {};

    const els = {
      openBtn: doc.getElementById('phoneDrawerBtn'),
      topOpenBtn: doc.getElementById('topPhoneBtn'),
      closeBtn: doc.getElementById('phoneCloseBtn'),
      drawer: doc.getElementById('webPhoneDrawer'),
      modeGvoiceBtn: doc.getElementById('phoneModeGvoiceBtn'),
      modeWebrtcBtn: doc.getElementById('phoneModeWebrtcBtn'),
      dialInput: doc.getElementById('phoneDialInput'),
      backspaceBtn: doc.getElementById('phoneBackspaceBtn'),
      keypad: doc.getElementById('phoneKeypad'),
      primaryCallBtn: doc.getElementById('phonePrimaryCallBtn'),
      hangupBtn: doc.getElementById('phoneHangupBtn'),
      muteCallBtn: doc.getElementById('phoneMuteCallBtn'),
      openGvMessagesBtn: doc.getElementById('phoneGvMessagesBtn'),
      syncInboxBtn: doc.getElementById('phoneSyncInboxBtn'),
      checkStatusBtn: doc.getElementById('phoneCheckStatusBtn'),
      statusLine: doc.getElementById('phoneStatusLine'),
      inboxList: doc.getElementById('phoneInboxList'),
      incomingBanner: doc.getElementById('phoneIncomingBanner'),
      incomingLabel: doc.getElementById('phoneIncomingLabel'),
      answerBtn: doc.getElementById('phoneAnswerBtn'),
      declineBtn: doc.getElementById('phoneDeclineBtn')
    };

    if (!els.drawer) {
      return { teardown() {}, setAuthenticated() {} };
    }

    let mode = 'gvoice'; // 'gvoice' | 'webrtc'
    let device = null;
    let activeCall = null;
    let pendingIncoming = null;
    let callTimer = null;
    let callSeconds = 0;
    let sdkPromise = null;

    function setStatus(text) {
      if (els.statusLine) els.statusLine.textContent = text;
    }

    function fmtSec(sec) {
      const m = String(Math.floor(sec / 60)).padStart(2, '0');
      const s = String(sec % 60).padStart(2, '0');
      return m + ':' + s;
    }

    function updateCallButtons() {
      const inCall = Boolean(activeCall);
      if (els.hangupBtn) els.hangupBtn.style.display = inCall ? '' : 'none';
      if (els.muteCallBtn) els.muteCallBtn.style.display = inCall ? '' : 'none';
      if (els.primaryCallBtn) {
        els.primaryCallBtn.textContent = mode === 'gvoice'
          ? '📞 Call (Google Voice)'
          : (inCall ? 'In Call…' : '📞 Call (In-Page WebRTC)');
      }
    }

    function setMode(nextMode) {
      mode = nextMode === 'webrtc' ? 'webrtc' : 'gvoice';
      if (els.modeGvoiceBtn) els.modeGvoiceBtn.classList.toggle('active', mode === 'gvoice');
      if (els.modeWebrtcBtn) els.modeWebrtcBtn.classList.toggle('active', mode === 'webrtc');
      updateCallButtons();
      if (mode === 'gvoice') {
        setStatus('Google Voice Starter (c@schafferai.com) · Works on any browser ($0 US VoIP)');
      } else {
        setStatus('In-Page WebRTC Softphone · Sign in & click Call or Check Status');
        if (workAuth.hasSession()) ensureWebRtcDevice().catch(() => {});
      }
    }

    function toggleDrawer(forceOpen) {
      const open = typeof forceOpen === 'boolean' ? forceOpen : !els.drawer.classList.contains('open');
      els.drawer.classList.toggle('open', open);
      if (els.openBtn) els.openBtn.classList.toggle('active', open);
    }

    function openCompanionPopup(url) {
      if (!win || typeof win.open !== 'function') return null;
      return win.open(url, '_blank', 'noopener,noreferrer,width=420,height=700,left=60,top=80');
    }

    function loadTwilioSdk() {
      if (win && win.Twilio && win.Twilio.Device) return Promise.resolve(win.Twilio.Device);
      if (sdkPromise) return sdkPromise;
      sdkPromise = new Promise((resolve, reject) => {
        if (!doc || typeof doc.createElement !== 'function' || !doc.head) {
          reject(new Error('Browser DOM unavailable for WebRTC SDK.'));
          return;
        }
        const s = doc.createElement('script');
        s.src = TWILIO_SDK_URL;
        s.async = true;
        s.onload = () => {
          if (win.Twilio && win.Twilio.Device) resolve(win.Twilio.Device);
          else reject(new Error('Twilio Voice SDK loaded without Device API.'));
        };
        s.onerror = () => {
          sdkPromise = null;
          reject(new Error('Could not load Twilio Voice SDK from CDN.'));
        };
        doc.head.appendChild(s);
      });
      return sdkPromise;
    }

    function stopCallTimer() {
      if (callTimer && typeof clearInterval === 'function') clearInterval(callTimer);
      callTimer = null;
      callSeconds = 0;
    }

    function attachCallHandlers(call, label) {
      activeCall = call;
      updateCallButtons();
      stopCallTimer();
      setStatus('Connected · ' + label + ' · 00:00');
      if (typeof setInterval === 'function') {
        callTimer = setInterval(() => {
          callSeconds++;
          setStatus('Connected · ' + label + ' · ' + fmtSec(callSeconds));
        }, 1000);
      }
      const cleanup = () => {
        activeCall = null;
        stopCallTimer();
        if (els.muteCallBtn) els.muteCallBtn.textContent = 'Mute';
        updateCallButtons();
        setStatus('Call ended.');
      };
      if (call && typeof call.on === 'function') {
        call.on('disconnect', cleanup);
        call.on('cancel', cleanup);
        call.on('error', (err) => {
          cleanup();
          setStatus('Call error: ' + (err && err.message || 'disconnected'));
        });
      }
    }

    async function ensureWebRtcDevice() {
      if (!workAuth.requireSession()) return null;
      if (device) return device;
      setStatus('Requesting WebRTC voice token…');
      const tokData = await workAuth.request({ action: 'voice_token' });
      if (!tokData || !tokData.ok || !tokData.token) {
        const msg = (tokData && tokData.error) || 'In-page WebRTC is not configured yet. Use Google Voice mode.';
        setStatus(msg);
        throw new Error(msg);
      }
      const DeviceCtor = await loadTwilioSdk();
      device = new DeviceCtor(tokData.token, { codecPreferences: ['opus', 'pcmu'] });
      device.on('registered', () => {
        setStatus('WebRTC phone online (' + (tokData.from_number || tokData.identity) + ') · Ready for inbound & outbound calls');
      });
      device.on('error', (err) => {
        setStatus('WebRTC error: ' + (err && err.message || 'unknown'));
      });
      device.on('incoming', (call) => {
        pendingIncoming = call;
        toggleDrawer(true);
        if (els.incomingBanner) els.incomingBanner.classList.add('visible');
        if (els.incomingLabel) els.incomingLabel.textContent = 'Incoming call from ' + ((call.parameters && call.parameters.From) || 'Unknown');
        call.on('cancel', () => {
          pendingIncoming = null;
          if (els.incomingBanner) els.incomingBanner.classList.remove('visible');
          setStatus('Missed incoming call.');
        });
      });
      if (typeof device.register === 'function') await device.register();
      return device;
    }

    async function handlePrimaryCall() {
      if (!workAuth.requireSession()) return;
      const raw = els.dialInput ? els.dialInput.value.trim() : '';
      const e164 = normalizeE164(raw);

      if (mode === 'gvoice') {
        const url = buildGoogleVoiceCallUrl(raw);
        openCompanionPopup(url);
        setStatus(e164
          ? 'Opened Google Voice Web dialer for ' + e164 + ' (uses computer mic & speakers).'
          : 'Opened Google Voice Web phone.');
        onLog('Opened Google Voice Web phone' + (e164 ? ' -> ' + e164 : '') + '.');
        return;
      }

      if (!e164) {
        setStatus('Enter a valid phone number (+1...) first.');
        return;
      }
      try {
        const dev = await ensureWebRtcDevice();
        if (!dev) return;
        setStatus('Dialing ' + e164 + ' in browser…');
        const call = await dev.connect({ params: { To: e164 } });
        attachCallHandlers(call, e164);
      } catch (_) {}
    }

    async function handleCheckStatus() {
      if (!workAuth.requireSession()) return;
      setStatus('Checking work-account voice integrations…');
      try {
        const data = await workAuth.request({ action: 'voice_status' });
        if (!data || !data.ok) {
          setStatus((data && data.error) || 'Could not read voice status.');
          return;
        }
        const gv = data.google_voice || {};
        const tw = data.twilio_webrtc || {};
        const el = data.elevenlabs_tts || {};
        const parts = [
          'Google Voice: ' + (gv.number_assigned ? gv.phone_number : (gv.billing_setup_email_seen ? 'Billing active (assign number in Admin)' : 'Pending setup')),
          'Twilio WebRTC: ' + (tw.browser_webrtc_ready ? ('Ready (' + tw.from_number + ')') : 'Unconfigured'),
          'ElevenLabs TTS: ' + (el.configured ? 'Ready' : 'Browser fallback')
        ];
        setStatus(parts.join(' · '));
      } catch (err) {
        setStatus(err && err.code === 'AUTH_REQUIRED' ? 'Sign in required.' : 'Voice status check failed.');
      }
    }

    function renderInboxItems(items) {
      if (!els.inboxList) return;
      els.inboxList.innerHTML = '';
      if (!items || !items.length) {
        const empty = doc.createElement('div');
        empty.className = 'phone-inbox-empty';
        empty.textContent = 'No forwarded Google Voice SMS or voicemails in Gmail yet. Enable "Forward messages to email" in voice.google.com Settings.';
        els.inboxList.appendChild(empty);
        return;
      }
      items.forEach((item) => {
        const card = doc.createElement('div');
        card.className = 'phone-inbox-item';
        const head = doc.createElement('div');
        head.className = 'phone-inbox-head';
        head.textContent = (item.kind === 'voicemail' ? '📼 ' : item.kind === 'missed_call' ? '📲 ' : '💬 ') + (item.subject || item.from || 'Google Voice');
        const body = doc.createElement('div');
        body.className = 'phone-inbox-body';
        body.textContent = item.text || '(No transcript text)';
        card.appendChild(head);
        card.appendChild(body);

        if (item.can_reply_sms && item.message_id) {
          const row = doc.createElement('div');
          row.className = 'phone-reply-row';
          const inp = doc.createElement('input');
          inp.className = 'glass-input';
          inp.placeholder = 'Reply via Google Voice SMS…';
          const btn = doc.createElement('button');
          btn.type = 'button';
          btn.className = 'glass-btn';
          btn.textContent = 'Reply';
          btn.addEventListener('click', async () => {
            if (!workAuth.requireSession()) return;
            const replyText = inp.value.trim();
            if (!replyText) return;
            btn.disabled = true;
            try {
              const res = await workAuth.request({ action: 'voice_reply', message_id: item.message_id, body: replyText });
              if (res && res.ok) {
                inp.value = '';
                setStatus('SMS reply sent via Google Voice gateway.');
              } else {
                setStatus((res && res.error) || 'SMS reply failed.');
              }
            } catch (_) {
              setStatus('SMS reply outcome unconfirmed; not retried.');
            } finally {
              btn.disabled = false;
            }
          });
          row.appendChild(inp);
          row.appendChild(btn);
          card.appendChild(row);
        }
        els.inboxList.appendChild(card);
      });
    }

    async function handleSyncInbox() {
      if (!workAuth.requireSession()) return;
      setStatus('Syncing Google Voice SMS & voicemail from c@schafferai.com…');
      try {
        const res = await workAuth.request({ action: 'voice_inbox', limit: 10 });
        if (res && res.ok) {
          renderInboxItems(res.items || []);
          setStatus('Synced ' + (res.count || 0) + ' Google Voice item(s) from c@schafferai.com.');
        } else {
          setStatus((res && res.error) || 'Inbox sync failed.');
        }
      } catch (err) {
        setStatus(err && err.code === 'AUTH_REQUIRED' ? 'Sign in required.' : 'Inbox sync failed.');
      }
    }

    function teardown() {
      stopCallTimer();
      if (activeCall && typeof activeCall.disconnect === 'function') {
        try { activeCall.disconnect(); } catch (_) {}
      }
      activeCall = null;
      if (pendingIncoming && typeof pendingIncoming.reject === 'function') {
        try { pendingIncoming.reject(); } catch (_) {}
      }
      pendingIncoming = null;
      if (device) {
        try { if (typeof device.unregister === 'function') device.unregister(); } catch (_) {}
        try { if (typeof device.destroy === 'function') device.destroy(); } catch (_) {}
        device = null;
      }
      if (els.incomingBanner) els.incomingBanner.classList.remove('visible');
      if (els.inboxList) els.inboxList.innerHTML = '';
      updateCallButtons();
    }

    function setAuthenticated(authed) {
      const gated = [els.primaryCallBtn, els.openGvMessagesBtn, els.syncInboxBtn, els.checkStatusBtn];
      gated.forEach((b) => { if (b) b.disabled = !authed; });
      if (!authed) {
        teardown();
        setStatus('Sign in to unlock your work phone & SMS.');
      } else {
        setStatus(mode === 'gvoice'
          ? 'Signed in · Google Voice Starter ready for any computer'
          : 'Signed in · WebRTC softphone ready');
      }
    }

    if (els.openBtn) els.openBtn.addEventListener('click', () => toggleDrawer());
    if (els.topOpenBtn) els.topOpenBtn.addEventListener('click', () => toggleDrawer());
    if (els.closeBtn) els.closeBtn.addEventListener('click', () => toggleDrawer(false));
    if (els.modeGvoiceBtn) els.modeGvoiceBtn.addEventListener('click', () => setMode('gvoice'));
    if (els.modeWebrtcBtn) els.modeWebrtcBtn.addEventListener('click', () => setMode('webrtc'));

    if (els.keypad) {
      els.keypad.addEventListener('click', (e) => {
        const keyBtn = e.target && e.target.closest ? e.target.closest('[data-digit]') : null;
        const digit = keyBtn && keyBtn.dataset ? keyBtn.dataset.digit : (e.target && e.target.dataset && e.target.dataset.digit);
        if (!digit) return;
        playDtmf(win, digit);
        if (els.dialInput) els.dialInput.value = (els.dialInput.value || '') + digit;
        if (activeCall && typeof activeCall.sendDigits === 'function') {
          try { activeCall.sendDigits(digit); } catch (_) {}
        }
      });
    }

    if (els.backspaceBtn) {
      els.backspaceBtn.addEventListener('click', () => {
        if (els.dialInput) els.dialInput.value = String(els.dialInput.value || '').slice(0, -1);
      });
    }

    if (els.primaryCallBtn) els.primaryCallBtn.addEventListener('click', handlePrimaryCall);
    if (els.hangupBtn) {
      els.hangupBtn.addEventListener('click', () => {
        if (activeCall && typeof activeCall.disconnect === 'function') activeCall.disconnect();
      });
    }
    if (els.muteCallBtn) {
      els.muteCallBtn.addEventListener('click', () => {
        if (!activeCall || typeof activeCall.mute !== 'function') return;
        const nextMuted = !(typeof activeCall.isMuted === 'function' && activeCall.isMuted());
        activeCall.mute(nextMuted);
        els.muteCallBtn.textContent = nextMuted ? 'Unmute' : 'Mute';
      });
    }
    if (els.openGvMessagesBtn) {
      els.openGvMessagesBtn.addEventListener('click', () => {
        if (!workAuth.requireSession()) return;
        openCompanionPopup(buildGoogleVoiceSmsUrl());
        setStatus('Opened Google Voice SMS window.');
      });
    }
    if (els.syncInboxBtn) els.syncInboxBtn.addEventListener('click', handleSyncInbox);
    if (els.checkStatusBtn) els.checkStatusBtn.addEventListener('click', handleCheckStatus);

    if (els.answerBtn) {
      els.answerBtn.addEventListener('click', () => {
        if (!pendingIncoming) return;
        const call = pendingIncoming;
        pendingIncoming = null;
        if (els.incomingBanner) els.incomingBanner.classList.remove('visible');
        call.accept();
        attachCallHandlers(call, (call.parameters && call.parameters.From) || 'Inbound Call');
      });
    }
    if (els.declineBtn) {
      els.declineBtn.addEventListener('click', () => {
        if (!pendingIncoming) return;
        pendingIncoming.reject();
        pendingIncoming = null;
        if (els.incomingBanner) els.incomingBanner.classList.remove('visible');
        setStatus('Declined incoming call.');
      });
    }

    setAuthenticated(workAuth.hasSession());
    updateCallButtons();

    return { teardown, setAuthenticated, toggleDrawer, setMode };
  }

  const api = {
    init,
    normalizeE164,
    buildGoogleVoiceCallUrl,
    buildGoogleVoiceSmsUrl
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SchafferWebPhone = api;
})(typeof window !== 'undefined' ? window : globalThis);
