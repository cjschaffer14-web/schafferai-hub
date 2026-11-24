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
  const WORK_ACCOUNT = 'c@schafferai.com';
  const GV_BASE = 'https://voice.google.com';
  const GV_ACCOUNT = 'authuser=' + encodeURIComponent(WORK_ACCOUNT);

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
    if (!e164) return GV_BASE + '/calls?' + GV_ACCOUNT;
    return GV_BASE + '/calls?' + GV_ACCOUNT + '&a=nc,' + encodeURIComponent(e164);
  }

  function buildGoogleVoiceSmsUrl() {
    return GV_BASE + '/messages?' + GV_ACCOUNT;
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

  function blobToBase64(win, blob) {
    return new Promise((resolve, reject) => {
      if (win && typeof win.FileReader === 'function') {
        const reader = new win.FileReader();
        reader.onloadend = () => {
          const s = String(reader.result || '');
          const comma = s.indexOf(',');
          resolve(comma >= 0 ? s.slice(comma + 1) : s);
        };
        reader.onerror = () => reject(new Error('Could not encode audio clip.'));
        reader.readAsDataURL(blob);
        return;
      }
      if (blob && typeof blob.arrayBuffer === 'function' && typeof Buffer !== 'undefined') {
        blob.arrayBuffer().then((ab) => resolve(Buffer.from(ab).toString('base64'))).catch(reject);
        return;
      }
      reject(new Error('Audio encoding unavailable.'));
    });
  }

  function init(opts) {
    const workAuth = opts.workAuth;
    const doc = opts.document;
    const win = opts.window;
    const onLog = opts.onLog || function () {};
    const onLoginSuccess = opts.onLoginSuccess || function () {};
    const onVoiceTurn = opts.onVoiceTurn || function () {};
    const onPlaybackVolume = opts.onPlaybackVolume || function () {};
    const onStopPlayback = opts.onStopPlayback || function () {};

    const els = {
      openBtn: doc.getElementById('phoneDrawerBtn'),
      topOpenBtn: doc.getElementById('topPhoneBtn'),
      closeBtn: doc.getElementById('phoneCloseBtn'),
      drawer: doc.getElementById('webPhoneDrawer'),
      loginRow: doc.getElementById('phoneLoginRow'),
      passwordInput: doc.getElementById('phonePasswordInput'),
      loginBtn: doc.getElementById('phoneLoginBtn'),
      modeGvoiceBtn: doc.getElementById('phoneModeGvoiceBtn'),
      modeAiLineBtn: doc.getElementById('phoneModeAiLineBtn'),
      modeWebrtcBtn: doc.getElementById('phoneModeWebrtcBtn'),
      dialInput: doc.getElementById('phoneDialInput'),
      backspaceBtn: doc.getElementById('phoneBackspaceBtn'),
      keypad: doc.getElementById('phoneKeypad'),
      primaryCallBtn: doc.getElementById('phonePrimaryCallBtn'),
      hangupBtn: doc.getElementById('phoneHangupBtn'),
      muteCallBtn: doc.getElementById('phoneMuteCallBtn'),
      volumeInput: doc.getElementById('phoneVolumeInput'),
      volumeValue: doc.getElementById('phoneVolumeValue'),
      volumeLabel: doc.getElementById('phoneVolumeLabel'),
      controlHelp: doc.getElementById('phoneControlHelp'),
      micTestBtn: doc.getElementById('phoneMicTestBtn'),
      openGvMessagesBtn: doc.getElementById('phoneGvMessagesBtn'),
      syncInboxBtn: doc.getElementById('phoneSyncInboxBtn'),
      checkStatusBtn: doc.getElementById('phoneCheckStatusBtn'),
      actionLinks: doc.getElementById('phoneActionLinks'),
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

    let mode = 'webrtc'; // 'ailine' | 'webrtc'; Google Voice is a separate link
    let device = null;
    let activeCall = null;
    let pendingIncoming = null;
    let callTimer = null;
    let callSeconds = 0;
    let sdkPromise = null;
    let recorder = null;
    let recStream = null;
    let recChunks = [];
    let recStopTimer = null;
    let lastVoiceStatus = null;
    let statusCheckedForSession = false;
    let playbackVolume = 1;
    let remoteAudio = null;
    let callStarting = false;
    let voiceTurnGeneration = 0;
    let voiceTurnPending = false;

    function setStatus(text) {
      if (els.statusLine) els.statusLine.textContent = text;
    }

    function fmtSec(sec) {
      const m = String(Math.floor(sec / 60)).padStart(2, '0');
      const s = String(sec % 60).padStart(2, '0');
      return m + ':' + s;
    }

    function renderActionLinks(rawNumber) {
      if (!els.actionLinks) return;
      els.actionLinks.innerHTML = '';
      if (!workAuth.hasSession()) return;

      const e164 = normalizeE164(rawNumber !== undefined ? rawNumber : (els.dialInput ? els.dialInput.value : ''));
      const gvUrl = buildGoogleVoiceCallUrl(e164);

      const mkLink = (label, href, accent) => {
        const a = doc.createElement('a');
        a.className = 'phone-quick-link' + (accent ? ' accent' : '');
        a.href = href;
        a.target = '_top';
        a.rel = 'noopener noreferrer';
        a.textContent = label;
        els.actionLinks.appendChild(a);
      };

      mkLink('↗ Open Google Voice separately', gvUrl, false);
    }

    function updateCallButtons() {
      const inCall = Boolean(activeCall);
      const isRec = Boolean(recorder && recorder.state === 'recording');
      const authed = workAuth.hasSession();
      const localAudio = mode === 'ailine' || (mode === 'webrtc' && inCall);
      const setupRequired = mode === 'webrtc' && lastVoiceStatus && !lastVoiceStatus.twilio_webrtc?.browser_webrtc_ready;
      if (els.hangupBtn) {
        els.hangupBtn.style.display = '';
        els.hangupBtn.disabled = !authed || !(inCall || isRec || voiceTurnPending || mode === 'ailine');
        els.hangupBtn.textContent = mode === 'ailine' ? 'Stop voice' : 'End call';
      }
      if (els.muteCallBtn) {
        els.muteCallBtn.style.display = '';
        els.muteCallBtn.disabled = !authed || !(inCall || isRec);
        const muted = inCall ? Boolean(activeCall.isMuted && activeCall.isMuted())
          : Boolean(isRec && recStream && recStream.getAudioTracks().every(t => !t.enabled));
        els.muteCallBtn.textContent = muted ? 'Unmute' : 'Mute';
        els.muteCallBtn.setAttribute('aria-pressed', String(muted));
      }
      if (els.volumeInput) els.volumeInput.disabled = !authed || !localAudio;
      if (els.volumeLabel) els.volumeLabel.textContent = mode === 'ailine' ? 'Reply volume' : 'Volume';
      if (els.micTestBtn) els.micTestBtn.disabled = !authed || inCall || isRec || callStarting;
      if (els.controlHelp) els.controlHelp.textContent = mode === 'ailine' ? 'Speak records a voice message to Work AI. Mute pauses your microphone; Stop voice cancels the turn and stops replies.'
          : 'In-page calling requires a configured Twilio line. Mute, End call and Volume work here during a call.';
      [els.modeGvoiceBtn, els.modeAiLineBtn, els.modeWebrtcBtn].forEach(b => {
        if (b) b.disabled = inCall || isRec || callStarting || voiceTurnPending;
      });
      if (els.primaryCallBtn) {
        els.primaryCallBtn.disabled = !authed || setupRequired || callStarting || (mode === 'webrtc' && (inCall || pendingIncoming)) || voiceTurnPending;
        if (mode === 'ailine') {
          els.primaryCallBtn.textContent = isRec ? '⏹ Send Spoken Turn' : '🎙️ Speak to Work AI';
        } else {
          els.primaryCallBtn.textContent = inCall ? 'In Call…' : setupRequired ? 'Phone setup required' : '📞 Call';
        }
      }
      renderActionLinks();
    }

    function setMode(nextMode) {
      mode = nextMode === 'ailine' ? 'ailine' : 'webrtc';
      if (els.modeAiLineBtn) els.modeAiLineBtn.classList.toggle('active', mode === 'ailine');
      if (els.modeWebrtcBtn) els.modeWebrtcBtn.classList.toggle('active', mode === 'webrtc');
      updateCallButtons();
      if (!workAuth.hasSession()) {
        setStatus('Enter your website password above to unlock your phone.');
        return;
      }
      if (mode === 'ailine') {
        setStatus('Work AI Voice Line · Works right inside this tab on any computer (tap Speak)');
      } else {
        setStatus('In-Page WebRTC Softphone · Checking Twilio WebRTC token…');
        ensureWebRtcDevice().catch(() => {});
      }
    }

    function toggleDrawer(forceOpen) {
      const open = typeof forceOpen === 'boolean' ? forceOpen : !els.drawer.classList.contains('open');
      els.drawer.classList.toggle('open', open);
      if (els.openBtn) els.openBtn.classList.toggle('active', open);
      if (open && !workAuth.hasSession() && els.passwordInput && typeof els.passwordInput.focus === 'function') {
        els.passwordInput.focus();
      }
    }

    function openCompanionPopup(url) {
      if (!win || typeof win.open !== 'function') return false;
      try {
        const popup = win.open(url, 'schafferai_gvoice', 'width=520,height=820,left=60,top=80');
        if (popup) {
          try { popup.opener = null; if (typeof popup.focus === 'function') popup.focus(); } catch (_) {}
          return true;
        }
      } catch (_) {}
      return false;
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

    function stopRecordingClip() {
      if (recStopTimer && typeof clearTimeout === 'function') {
        clearTimeout(recStopTimer);
        recStopTimer = null;
      }
      if (recorder && recorder.state === 'recording') {
        try { recorder.stop(); } catch (_) {}
      }
    }

    function releaseRecorderStream() {
      if (recStream && typeof recStream.getTracks === 'function') {
        recStream.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} });
      }
      recStream = null;
      recorder = null;
      recChunks = [];
    }

    async function handleAiVoiceTurn() {
      if (!workAuth.requireSession()) return;
      if (recorder && recorder.state === 'recording') {
        stopRecordingClip();
        return;
      }
      const generation = ++voiceTurnGeneration;
      const nav = (win && win.navigator) || (typeof navigator !== 'undefined' ? navigator : null);
      const MR = (win && win.MediaRecorder) || (typeof MediaRecorder !== 'undefined' ? MediaRecorder : null);
      if (!nav || !nav.mediaDevices || typeof nav.mediaDevices.getUserMedia !== 'function' || !MR) {
        setStatus('Microphone recording is unavailable in this browser.');
        return;
      }
      try {
        recStream = await nav.mediaDevices.getUserMedia({ audio: true, video: false });
        if (generation !== voiceTurnGeneration || !workAuth.hasSession()) {
          releaseRecorderStream();
          return;
        }
        let mimeType = 'audio/webm';
        if (typeof MR.isTypeSupported === 'function') {
          if (MR.isTypeSupported('audio/webm;codecs=opus')) mimeType = 'audio/webm;codecs=opus';
          else if (MR.isTypeSupported('audio/mp4')) mimeType = 'audio/mp4';
        }
        recChunks = [];
        recorder = new MR(recStream, { mimeType, audioBitsPerSecond: 16000 });
        recorder.ondataavailable = (ev) => {
          if (ev.data && ev.data.size > 0) recChunks.push(ev.data);
        };
        recorder.onstop = async () => {
          const chunks = recChunks.slice();
          releaseRecorderStream();
          updateCallButtons();
          if (generation !== voiceTurnGeneration || !chunks.length || !workAuth.hasSession()) return;
          voiceTurnPending = true;
          updateCallButtons();
          setStatus('Transcribing & asking c@schafferai.com…');
          try {
            const BlobCtor = (win && win.Blob) || (typeof Blob !== 'undefined' ? Blob : null);
            const blob = BlobCtor ? new BlobCtor(chunks, { type: mimeType }) : chunks[0];
            const audioB64 = await blobToBase64(win, blob);
            if (generation !== voiceTurnGeneration || !workAuth.hasSession()) return;
            if (!audioB64 || audioB64.length > 28000) {
              setStatus('Clip too long — speak for up to 10 seconds per turn.');
              return;
            }
            const res = await workAuth.request({ action: 'voice_turn', audio_b64: audioB64, mime_type: mimeType });
            if (generation !== voiceTurnGeneration || !workAuth.hasSession()) return;
            if (!res || !res.ok) {
              setStatus((res && res.error) || 'Voice turn failed.');
              return;
            }
            if (res.empty || !res.transcript) {
              setStatus('No speech heard — tap Speak and talk near your mic.');
              return;
            }
            setStatus('Heard: "' + res.transcript.slice(0, 70) + '"');
            onVoiceTurn(res.transcript, res.reply || '', res);
          } catch (err) {
            if (generation === voiceTurnGeneration) setStatus(err && err.code === 'AUTH_REQUIRED' ? 'Sign in required.' : 'Voice turn failed.');
          } finally {
            if (generation === voiceTurnGeneration) voiceTurnPending = false;
            updateCallButtons();
          }
        };
        recorder.start();
        updateCallButtons();
        setStatus('Listening (up to 10s)… Tap "Send Spoken Turn" when finished.');
        if (typeof setTimeout === 'function') {
          recStopTimer = setTimeout(() => stopRecordingClip(), 10000);
        }
      } catch (err) {
        releaseRecorderStream();
        updateCallButtons();
        setStatus('Mic access error: ' + ((err && err.message) || 'allow microphone access'));
      }
    }

    function attachCallHandlers(call, label) {
      activeCall = call;
      updateCallButtons();
      stopCallTimer();
      const connected = () => {
        if (activeCall !== call || callTimer) return;
        setStatus('Connected · ' + label + ' · 00:00');
        if (typeof setInterval === 'function') {
        callTimer = setInterval(() => {
          callSeconds++;
          setStatus('Connected · ' + label + ' · ' + fmtSec(callSeconds));
        }, 1000);
        }
      };
      setStatus('Connecting · ' + label);
      const cleanup = () => {
        if (activeCall !== call) return;
        activeCall = null;
        remoteAudio = null;
        stopCallTimer();
        if (els.muteCallBtn) els.muteCallBtn.textContent = 'Mute';
        updateCallButtons();
        setStatus('Call ended.');
      };
      if (call && typeof call.on === 'function') {
        call.on('accept', connected);
        call.on('ringing', () => setStatus('Ringing · ' + label));
        call.on('audio', audio => { remoteAudio = audio; audio.volume = playbackVolume; });
        call.on('disconnect', cleanup);
        call.on('cancel', cleanup);
        call.on('error', (err) => {
          cleanup();
          setStatus('Call error: ' + (err && err.message || 'disconnected'));
        });
      }
      if (call && typeof call.status === 'function' && call.status() === 'open') connected();
    }

    async function ensureWebRtcDevice() {
      if (!workAuth.requireSession()) return null;
      if (device) return device;
      setStatus('Requesting WebRTC voice token…');
      const tokData = await workAuth.request({ action: 'voice_token' });
      if (!tokData || !tokData.ok || !tokData.token) {
        const msg = (tokData && tokData.error) || 'Browser calling is not configured. Google Voice is available through its separate link.';
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
      if (callStarting || activeCall || voiceTurnPending) return;
      if (!workAuth.requireSession()) {
        if (els.passwordInput && typeof els.passwordInput.focus === 'function') els.passwordInput.focus();
        return;
      }
      if (mode === 'ailine') {
        await handleAiVoiceTurn();
        return;
      }

      const raw = els.dialInput ? els.dialInput.value.trim() : '';
      const e164 = normalizeE164(raw);
      if (raw && !e164) {
        setStatus('Enter a valid phone number before calling.');
        return;
      }

      if (!e164) {
        setStatus('Enter a valid phone number (+1...) first.');
        return;
      }
      try {
        const generation = voiceTurnGeneration;
        callStarting = true;
        updateCallButtons();
        const dev = await ensureWebRtcDevice();
        if (!dev) return;
        setStatus('Dialing ' + e164 + ' in browser…');
        const call = await dev.connect({ params: { To: e164 } });
        if (!workAuth.hasSession() || generation !== voiceTurnGeneration) {
          call.disconnect();
          return;
        }
        attachCallHandlers(call, e164);
      } catch (err) {
        setStatus('Call could not start: ' + (err && err.message || 'check microphone and phone setup'));
      } finally {
        callStarting = false;
        updateCallButtons();
      }
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
        lastVoiceStatus = data;
        updateCallButtons();
        const gv = data.google_voice || {};
        const tw = data.twilio_webrtc || {};
        const el = data.elevenlabs_tts || {};
        renderActionLinks();
        const parts = [
          'Google Voice: ' + (gv.number_assigned ? gv.phone_number : 'Open work account to check line status'),
          'AI Voice Line: Ready' + (el.configured ? ' (ElevenLabs)' : ' (Browser TTS)'),
          'Browser Phone: ' + (tw.browser_webrtc_ready ? ('Configured (' + tw.from_number + ')') : 'Not configured')
        ];
        if (tw.browser_setup && tw.browser_setup.error) parts.push(tw.browser_setup.error);
        if (tw.browser_setup && Array.isArray(tw.browser_setup.available_lines) && !tw.browser_setup.available_lines.length) parts.push('No active Twilio phone number on this account');
        setStatus(parts.join(' · '));
        if (tw.browser_webrtc_ready && mode === 'webrtc') ensureWebRtcDevice().catch(() => {});
      } catch (err) {
        setStatus(err && err.code === 'AUTH_REQUIRED' ? 'Sign in required.' : 'Voice status check failed.');
      }
    }

    async function handleInlineLogin() {
      if (!els.passwordInput || !els.loginBtn || els.loginBtn.disabled) return;
      const pw = els.passwordInput.value;
      els.passwordInput.value = '';
      if (!pw) {
        setStatus('Enter your website password above first.');
        return;
      }
      els.loginBtn.disabled = true;
      setStatus('Verifying website password…');
      try {
        await workAuth.login(pw);
        onLoginSuccess();
      } catch (err) {
        setStatus(err && err.code === 'AUTH_REQUIRED' ? 'Incorrect password.' : ((err && err.message) || 'Sign in failed.'));
      } finally {
        els.loginBtn.disabled = false;
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
      voiceTurnGeneration++;
      voiceTurnPending = false;
      onStopPlayback();
      stopCallTimer();
      stopRecordingClip();
      releaseRecorderStream();
      lastVoiceStatus = null;
      statusCheckedForSession = false;
      if (activeCall && typeof activeCall.disconnect === 'function') {
        try { activeCall.disconnect(); } catch (_) {}
      }
      activeCall = null;
      remoteAudio = null;
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
      if (els.actionLinks) els.actionLinks.innerHTML = '';
      updateCallButtons();
    }

    function setAuthenticated(authed, optsArg) {
      const gated = [els.primaryCallBtn, els.openGvMessagesBtn, els.syncInboxBtn, els.checkStatusBtn];
      gated.forEach((b) => { if (b) b.disabled = !authed; });
      if (els.loginRow) els.loginRow.style.display = authed ? 'none' : 'flex';
      if (!authed) {
        teardown();
        setStatus('Enter your website password above to unlock your work phone & SMS.');
      } else {
        renderActionLinks();
        setStatus(mode === 'ailine'
          ? 'Signed in · Tap Speak to talk live with c@schafferai.com'
          : 'Signed in · Ready');
        if (!(optsArg && optsArg.skipAutoStatus) && !statusCheckedForSession) {
          statusCheckedForSession = true;
          handleCheckStatus().catch(() => {});
        }
      }
      updateCallButtons();
    }

    if (els.openBtn) els.openBtn.addEventListener('click', () => toggleDrawer());
    if (els.topOpenBtn) els.topOpenBtn.addEventListener('click', () => toggleDrawer());
    if (els.closeBtn) els.closeBtn.addEventListener('click', () => toggleDrawer(false));
    if (els.loginBtn) els.loginBtn.addEventListener('click', handleInlineLogin);
    if (els.passwordInput) {
      els.passwordInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          handleInlineLogin();
        }
      });
    }
    if (els.modeGvoiceBtn) els.modeGvoiceBtn.addEventListener('click', () => {
      if (!workAuth.requireSession()) return;
      const opened = openCompanionPopup(buildGoogleVoiceCallUrl(els.dialInput ? els.dialInput.value : ''));
      setStatus(opened ? 'Opened Google Voice separately. Place Google Voice calls in that window.' : 'Popup blocked — use the Open Google Voice link.');
    });
    if (els.modeAiLineBtn) els.modeAiLineBtn.addEventListener('click', () => setMode('ailine'));
    if (els.modeWebrtcBtn) els.modeWebrtcBtn.addEventListener('click', () => setMode('webrtc'));

    if (els.dialInput) {
      els.dialInput.addEventListener('input', () => renderActionLinks());
    }

    if (els.keypad) {
      els.keypad.addEventListener('click', (e) => {
        const keyBtn = e.target && e.target.closest ? e.target.closest('[data-digit]') : null;
        const digit = keyBtn && keyBtn.dataset ? keyBtn.dataset.digit : (e.target && e.target.dataset && e.target.dataset.digit);
        if (!digit) return;
        playDtmf(win, digit);
        if (els.dialInput) {
          els.dialInput.value = (els.dialInput.value || '') + digit;
          renderActionLinks();
        }
        if (activeCall && typeof activeCall.sendDigits === 'function') {
          try { activeCall.sendDigits(digit); } catch (_) {}
        }
      });
    }

    if (els.backspaceBtn) {
      els.backspaceBtn.addEventListener('click', () => {
        if (els.dialInput) {
          els.dialInput.value = String(els.dialInput.value || '').slice(0, -1);
          renderActionLinks();
        }
      });
    }

    if (els.primaryCallBtn) els.primaryCallBtn.addEventListener('click', handlePrimaryCall);
    if (els.hangupBtn) {
      els.hangupBtn.addEventListener('click', () => {
        if (activeCall && typeof activeCall.disconnect === 'function') activeCall.disconnect();
        if (mode === 'ailine') {
          voiceTurnGeneration++;
          voiceTurnPending = false;
          stopRecordingClip();
          releaseRecorderStream();
          onStopPlayback();
          setStatus('Voice stopped.');
          updateCallButtons();
        }
      });
    }
    if (els.muteCallBtn) {
      els.muteCallBtn.addEventListener('click', () => {
        if (!activeCall) {
          if (recStream) {
            const tracks = recStream.getAudioTracks();
            const enabled = !tracks.some(t => t.enabled);
            tracks.forEach(t => { t.enabled = enabled; });
            updateCallButtons();
          }
          return;
        }
        if (typeof activeCall.mute !== 'function') return;
        const nextMuted = !(typeof activeCall.isMuted === 'function' && activeCall.isMuted());
        activeCall.mute(nextMuted);
        els.muteCallBtn.textContent = nextMuted ? 'Unmute' : 'Mute';
        els.muteCallBtn.setAttribute('aria-pressed', String(nextMuted));
      });
    }
    if (els.volumeInput) els.volumeInput.addEventListener('input', () => {
      playbackVolume = Math.max(0, Math.min(1, Number(els.volumeInput.value) / 100));
      if (remoteAudio) remoteAudio.volume = playbackVolume;
      onPlaybackVolume(playbackVolume);
      if (els.volumeValue) els.volumeValue.textContent = Math.round(playbackVolume * 100) + '%';
    });
    if (els.micTestBtn) els.micTestBtn.addEventListener('click', async () => {
      if (!workAuth.requireSession()) return;
      els.micTestBtn.disabled = true;
      setStatus('Waiting for microphone permission. Allow microphone access for this website to continue the test.');
      let stream;
      try {
        stream = await win.navigator.mediaDevices.getUserMedia({ audio: true });
        const track = stream.getAudioTracks()[0];
        setStatus(track ? 'Microphone available: ' + (track.label || 'Default microphone') + '. Make a test call to confirm two-way audio.' : 'No microphone found. Connect a microphone or headset.');
      } catch (_) {
        setStatus('Microphone unavailable. Allow microphone access for this website and connect a microphone or headset.');
      } finally {
        if (stream) stream.getTracks().forEach(t => t.stop());
        updateCallButtons();
      }
    });
    if (els.openGvMessagesBtn) {
      els.openGvMessagesBtn.addEventListener('click', () => {
        if (!workAuth.requireSession()) return;
        const url = buildGoogleVoiceSmsUrl();
        const ok = openCompanionPopup(url);
        if (!ok && els.actionLinks) {
          renderActionLinks();
          const a = doc.createElement('a');
          a.className = 'phone-quick-link accent';
          a.href = url;
          a.target = '_top';
          a.rel = 'noopener noreferrer';
          a.textContent = '↗ Open Google Voice SMS Here';
          els.actionLinks.appendChild(a);
          setStatus('Popup blocked — click "↗ Open Google Voice SMS Here" above.');
        } else {
          setStatus('Opened Google Voice SMS window.');
        }
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

    if (els.modeWebrtcBtn) els.modeWebrtcBtn.classList.add('active');
    setAuthenticated(workAuth.hasSession(), { skipAutoStatus: true });
    updateCallButtons();

    return { teardown, setAuthenticated, toggleDrawer, setMode, getPlaybackVolume: () => playbackVolume };
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
