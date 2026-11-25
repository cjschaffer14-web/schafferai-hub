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

  function buildGoogleVoiceUrl(page) {
    const path = ['calls', 'messages', 'voicemail', 'settings'].includes(page) ? page : 'calls';
    return GV_BASE + '/' + path + '?' + GV_ACCOUNT;
  }

  function buildGoogleVoiceCallUrl(rawNumber) {
    const number = normalizeE164(rawNumber);
    // Google's documented call URL. The explicit account path keeps the call
    // action through Google's account redirect; authuser selects the work user.
    return number ? GV_BASE + '/u/0/calls?' + GV_ACCOUNT + '&a=nc,' + encodeURIComponent(number)
      : buildGoogleVoiceUrl('calls');
  }

  function buildGoogleVoiceSmsUrl() {
    return buildGoogleVoiceUrl('messages');
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
      connectBtn: doc.getElementById('phoneConnectBtn'),
      settingsBtn: doc.getElementById('phoneSettingsBtn'),
      settingsPane: doc.getElementById('phoneSettingsPane'),
      sessionExpires: doc.getElementById('phoneSessionExpires'),
      testToneBtn: doc.getElementById('phoneTestToneBtn'),
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
      localControls: doc.getElementById('phoneLocalControls'),
      controls: doc.getElementById('phoneControls'),
      hangupBtn: doc.getElementById('phoneHangupBtn'),
      muteCallBtn: doc.getElementById('phoneMuteCallBtn'),
      volumeInput: doc.getElementById('phoneVolumeInput'),
      volumeValue: doc.getElementById('phoneVolumeValue'),
      volumeLabel: doc.getElementById('phoneVolumeLabel'),
      controlHelp: doc.getElementById('phoneControlHelp'),
      micTestBtn: doc.getElementById('phoneMicTestBtn'),
      openGvMessagesBtn: doc.getElementById('phoneGvMessagesBtn'),
      openGvVoicemailBtn: doc.getElementById('phoneGvVoicemailBtn'),
      openGvSettingsBtn: doc.getElementById('phoneGvSettingsBtn'),
      lineNumber: doc.getElementById('phoneLineNumber'),
      lineState: doc.getElementById('phoneLineState'),
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

    let mode = opts.defaultMode === 'ailine' ? 'ailine' : 'gvoice';
    let device = null;
    let deviceRegistered = false;
    let devicePromise = null;
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
    let authGeneration = 0;
    let phoneGeneration = 0;
    let statusLoading = false;
    let inboxLoading = false;
    let reconnectTimer = null;
    let reconnectAttempt = 0;
    let reconnectNeeded = false;
    let phoneWasConnected = false;
    const reconnectDelays = [2000, 5000, 15000, 30000];
    const later = opts.setTimeout || setTimeout;
    const cancelLater = opts.clearTimeout || clearTimeout;

    function cancelReconnect() {
      if (reconnectTimer !== null) cancelLater(reconnectTimer);
      reconnectTimer = null;
    }

    function scheduleReconnect() {
      if (!reconnectNeeded || deviceRegistered || devicePromise || reconnectTimer !== null || activeCall || pendingIncoming || callStarting || !(phoneWasConnected || els.drawer.classList.contains('open'))) return;
      const generation = phoneGeneration;
      const delay = reconnectDelays[Math.min(reconnectAttempt++, reconnectDelays.length - 1)];
      reconnectTimer = later(async () => {
        reconnectTimer = null;
        if (generation !== phoneGeneration || activeCall || pendingIncoming || callStarting || deviceRegistered || devicePromise || !(phoneWasConnected || els.drawer.classList.contains('open'))) return;
        try { await ensureGoogleDevice(); }
        catch (_) { if (generation === phoneGeneration && !activeCall) setStatus('Google Voice disconnected. Reconnecting…'); }
        finally { if (generation === phoneGeneration) scheduleReconnect(); }
      }, delay);
    }


    function setStatus(text) {
      if (els.statusLine) els.statusLine.textContent = text;
    }

    function renderLineStatus() {
      const authed = workAuth.hasSession();
      const gv = lastVoiceStatus && lastVoiceStatus.google_voice;
      const number = gv && normalizeE164(gv.phone_number);
      if (els.lineNumber) els.lineNumber.textContent = number || '+13026359389';
      if (els.lineState) els.lineState.textContent = deviceRegistered ? 'Connected' : 'Not connected';
    }

    function fmtSec(sec) {
      const m = String(Math.floor(sec / 60)).padStart(2, '0');
      const s = String(sec % 60).padStart(2, '0');
      return m + ':' + s;
    }

    function renderActionLinks() {
      if (els.actionLinks) els.actionLinks.innerHTML = '';
    }

    function updateCallButtons() {
      const inCall = Boolean(activeCall);
      const isRec = Boolean(recorder && recorder.state === 'recording');
      const authed = workAuth.hasSession();
      if (els.dialInput) els.dialInput.readOnly = inCall || !!pendingIncoming;
      if (els.backspaceBtn) els.backspaceBtn.disabled = inCall || !!pendingIncoming;
      renderLineStatus();
      [els.openGvMessagesBtn, els.openGvVoicemailBtn, els.openGvSettingsBtn].forEach(b => { if (b) b.disabled = false; });
      if (els.checkStatusBtn) {
        els.checkStatusBtn.disabled = !authed || statusLoading;
        els.checkStatusBtn.textContent = statusLoading ? 'Checking…' : 'Refresh status';
      }
      if (els.syncInboxBtn) {
        els.syncInboxBtn.disabled = !authed || inboxLoading;
        els.syncInboxBtn.textContent = inboxLoading ? 'Syncing…' : 'Sync work inbox';
      }
      if (els.localControls) els.localControls.style.display = '';
      if (els.controls) els.controls.style.display = inCall || isRec || voiceTurnPending || mode === 'ailine' ? '' : 'none';
      const localAudio = true;
      const setupRequired = false;
      if (els.connectBtn) { els.connectBtn.disabled = !!devicePromise || deviceRegistered || !!activeCall || !!pendingIncoming; els.connectBtn.textContent = deviceRegistered ? 'Receiving Google Voice calls' : devicePromise ? 'Connecting…' : 'Connect Google Voice'; }
      if (els.testToneBtn) { els.testToneBtn.style.display = inCall && mode === 'gvoice' ? '' : 'none'; els.testToneBtn.disabled = !inCall; }
      if (deviceRegistered && els.lineState) els.lineState.textContent = 'Connected';
      if (els.hangupBtn) {
        els.hangupBtn.style.display = '';
        els.hangupBtn.disabled = !(inCall || isRec || voiceTurnPending || mode === 'ailine');
        els.hangupBtn.textContent = mode === 'ailine' ? 'Stop voice' : 'End call';
      }
      if (els.muteCallBtn) {
        els.muteCallBtn.style.display = '';
        els.muteCallBtn.disabled = !(inCall || isRec);
        const muted = inCall ? Boolean(activeCall.isMuted && activeCall.isMuted())
          : Boolean(isRec && recStream && recStream.getAudioTracks().every(t => !t.enabled));
        els.muteCallBtn.textContent = muted ? 'Unmute' : 'Mute';
        els.muteCallBtn.setAttribute('aria-pressed', String(muted));
      }
      if (els.volumeInput) els.volumeInput.disabled = !localAudio;
      if (els.volumeLabel) els.volumeLabel.textContent = mode === 'ailine' ? 'Reply volume' : 'Volume';
      if (els.micTestBtn) els.micTestBtn.disabled = inCall || isRec || callStarting;
      if (els.controlHelp) els.controlHelp.style.display = '';
      if (els.controlHelp) els.controlHelp.textContent = mode === 'gvoice'
        ? 'Calls use your Google Voice line. Keep this website open to receive calls. Mute, volume, and End call control this call.'
        : mode === 'ailine' ? 'Speak records a voice message to Work AI. Mute pauses your microphone; Stop voice cancels the turn and stops replies.'
          : 'Calls and audio controls are available in Google Voice.';
      [els.modeGvoiceBtn, els.modeAiLineBtn, els.modeWebrtcBtn].forEach(b => {
        if (b) b.disabled = inCall || isRec || callStarting || voiceTurnPending;
      });
      if (els.primaryCallBtn) {
        els.primaryCallBtn.disabled = (mode === 'ailine' && !authed) || !!activeCall || !!pendingIncoming || setupRequired || callStarting || voiceTurnPending;
        if (mode === 'gvoice') {
          els.primaryCallBtn.textContent = inCall ? 'In call' : callStarting ? 'Calling…' : 'Call';
        } else if (mode === 'ailine') {
          els.primaryCallBtn.textContent = isRec ? '⏹ Send Spoken Turn' : '🎙️ Speak to Work AI';
        } else {
          els.primaryCallBtn.textContent = inCall ? 'In Call…' : setupRequired ? 'Phone setup required' : '📞 Call';
        }
      }
      renderActionLinks();
    }

    function setMode(nextMode) {
      mode = nextMode === 'ailine' ? 'ailine' : 'gvoice';
      if (els.modeAiLineBtn) els.modeAiLineBtn.classList.toggle('active', mode === 'ailine');
      updateCallButtons();
      if (mode === 'ailine' && !workAuth.hasSession()) {
        setStatus('Sign in to use Work AI voice.');
        return;
      }
      if (mode === 'gvoice') {
        setStatus(deviceRegistered ? 'Google Voice online · Calls stay inside this website.' : 'Connect Google Voice to make and receive calls inside this website.');
      } else if (mode === 'ailine') {
        setStatus('Work AI Voice Line · Works right inside this tab on any computer (tap Speak)');
      }
    }

    function toggleDrawer(forceOpen) {
      const open = typeof forceOpen === 'boolean' ? forceOpen : !els.drawer.classList.contains('open');
      els.drawer.classList.toggle('open', open);
      [els.openBtn, els.topOpenBtn].forEach(b => {
        if (!b) return;
        b.classList.toggle('active', open);
        b.setAttribute('aria-expanded', String(open));
      });
      const input = mode === 'gvoice' ? els.dialInput : !workAuth.hasSession() ? els.passwordInput : null;
      if (open && input && typeof input.focus === 'function') input.focus();
      if (open && mode === 'gvoice' && !deviceRegistered && !devicePromise) ensureGoogleDevice().catch(error => setStatus(error && error.message || 'Phone connection unavailable.'));
    }

    function openGoogleVoice(rawNumber) {
      setMode('gvoice');
      if (els.dialInput && rawNumber) els.dialInput.value = String(rawNumber);
      toggleDrawer(true);
      return true;
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
      if (els.dialInput) els.dialInput.value = normalizeE164(label) || '';
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
        scheduleReconnect();
      };
      if (call && typeof call.on === 'function') {
        call.on('accept', connected);
        call.on('ringing', () => { if (activeCall === call) setStatus('Ringing · ' + label); });
        call.on('audio', audio => { if (activeCall === call) { remoteAudio = audio; audio.volume = playbackVolume; } });
        call.on('disconnect', cleanup);
        call.on('cancel', cleanup);
        call.on('error', (err) => {
          if (activeCall !== call) return;
          cleanup();
          setStatus('Call error: ' + (err && err.message || 'disconnected'));
        });
      }
      if (call && typeof call.status === 'function' && call.status() === 'open') connected();
    }

    async function ensureGoogleDevice() {
      if (device && deviceRegistered) return device;
      if (devicePromise) return devicePromise;
      cancelReconnect();
      const generation = phoneGeneration;
      const current = () => generation === phoneGeneration;
      devicePromise = (async () => {
        setStatus('Connecting Google Voice…');
        const config = await workAuth.googlePhoneSession();
        if (!current()) return null;
        if (!win.SchafferGoogleSip || !win.SchafferGoogleSip.Device) throw new Error('The Google phone client did not load. Refresh this page.');
        if (device) { const previous = device; device = null; try { previous.destroy(); } catch (_) {} }
        const instance = new win.SchafferGoogleSip.Device(config);
        device = instance;
        const live = () => current() && device === instance;
        instance.on('registered', () => {
          if (!live()) return;
          deviceRegistered = true;
          phoneWasConnected = true; reconnectNeeded = false; reconnectAttempt = 0; cancelReconnect();
          if (els.sessionExpires) els.sessionExpires.textContent = 'Google session expires ' + new Date(config.expiresAt).toLocaleString() + '. Keep this website open to receive calls.';
          lastVoiceStatus = Object.assign({}, lastVoiceStatus, {google_voice:{phone_number:config.phoneNumber}});
          updateCallButtons();
          if (!activeCall) setStatus('Ready to call.');
        });
        instance.on('unregistered', () => { if (!live()) return; deviceRegistered = false; reconnectNeeded = true; updateCallButtons(); if (!activeCall && !pendingIncoming) setStatus('Google Voice disconnected. Reconnecting…'); scheduleReconnect(); });
        instance.on('diagnostics', data => { if (live()) win.googlePhoneDiagnostics = Object.freeze(Object.assign({}, data)); });
        instance.on('incoming', call => {
          if (!live() || activeCall || pendingIncoming || recorder || voiceTurnPending) { call.reject(); return; }
          pendingIncoming = call;
          if (els.dialInput) els.dialInput.value = normalizeE164(call.parameters.From) || '';
          setMode('gvoice'); toggleDrawer(true);
          if (els.incomingBanner) els.incomingBanner.classList.add('visible');
          if (els.incomingLabel) els.incomingLabel.textContent = 'Incoming Google Voice call from ' + (call.parameters.From || 'Unknown');
          setStatus('Incoming call · Answer inside this website.');
          const clear = () => { if (!live() || pendingIncoming !== call) return; pendingIncoming = null; if (els.incomingBanner) els.incomingBanner.classList.remove('visible'); updateCallButtons(); setStatus('Incoming call ended.'); scheduleReconnect(); };
          call.on('disconnect', clear); call.on('cancel', clear); call.on('reject', clear);
          updateCallButtons();
        });
        await instance.register();
        if (!live()) { instance.destroy(); return null; }
        return instance;
      })();
      updateCallButtons();
      try { return await devicePromise; }
      catch (error) { if (current()) reconnectNeeded = true; throw error; }
      finally { if (current()) { devicePromise = null; updateCallButtons(); scheduleReconnect(); } }
    }

    async function handlePrimaryCall() {
      if (callStarting || activeCall || pendingIncoming || voiceTurnPending) return;
      if (mode === 'ailine') { await handleAiVoiceTurn(); return; }
      const raw = els.dialInput ? els.dialInput.value.trim() : '';
      const number = normalizeE164(raw);
      if (!raw || !/^[+\d\s().-]+$/.test(raw) || !number) { setStatus('Enter a valid phone number before calling.'); return; }
      callStarting = true; updateCallButtons();
      const generation = phoneGeneration;
      try {
        const currentDevice = await ensureGoogleDevice();
        if (!currentDevice) return;
        setStatus('Calling ' + number + ' with Google Voice…');
        const call = await currentDevice.connect({params:{To:number}});
        if (generation !== phoneGeneration) { call.disconnect(); return; }
        attachCallHandlers(call, number);
      } catch (error) { setStatus('Call could not start: ' + (error && error.message || 'phone connection unavailable')); }
      finally { callStarting = false; updateCallButtons(); scheduleReconnect(); }
    }

    async function handleCheckStatus() {
      if (!workAuth.requireSession() || statusLoading) return;
      const generation = authGeneration;
      statusLoading = true;
      updateCallButtons();
      setStatus('Checking work-account voice integrations…');
      try {
        const data = await workAuth.request({ action: 'voice_status' });
        if (generation !== authGeneration || !workAuth.hasSession()) return;
        if (!data || !data.ok) {
          setStatus((data && data.error) || 'Could not read voice status.');
          return;
        }
        lastVoiceStatus = data;
        updateCallButtons();
        const gv = data.google_voice || {};
        renderActionLinks();
        if (mode === 'gvoice') {
          setStatus('Google Voice · ' + (gv.number_assigned ? gv.phone_number : 'Check number in Google Voice') + ' · c@schafferai.com. Calls and audio controls stay in this website.');
          return;
        }
      } catch (err) {
        if (generation !== authGeneration || !workAuth.hasSession()) return;
        setStatus(err && err.code === 'AUTH_REQUIRED' ? 'Sign in required.' : 'Voice status check failed.');
      } finally {
        if (generation === authGeneration) {
          statusLoading = false;
          updateCallButtons();
        }
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
        const date = new Date(item.date);
        if (item.date && !Number.isNaN(date.getTime())) {
          const time = doc.createElement('time');
          time.className = 'phone-inbox-date';
          time.dateTime = date.toISOString();
          time.textContent = date.toLocaleString();
          card.appendChild(time);
        }
        card.appendChild(body);

        if (item.can_reply_sms && item.message_id) {
          const row = doc.createElement('div');
          row.className = 'phone-reply-row';
          const inp = doc.createElement('input');
          inp.className = 'glass-input';
          inp.placeholder = 'Reply via Google Voice SMS…';
          inp.setAttribute('aria-label', 'Reply to ' + (item.subject || item.from || 'Google Voice message'));
          inp.maxLength = 800;
          const btn = doc.createElement('button');
          btn.type = 'button';
          btn.className = 'glass-btn';
          btn.textContent = 'Reply';
          btn.addEventListener('click', async () => {
            if (!workAuth.requireSession()) return;
            const replyText = inp.value.trim();
            if (!replyText || btn.disabled) return;
            const generation = authGeneration;
            btn.disabled = true;
            try {
              const res = await workAuth.request({ action: 'voice_reply', message_id: item.message_id, body: replyText });
              if (generation !== authGeneration || !workAuth.hasSession()) return;
              if (res && res.ok) {
                inp.value = '';
                setStatus('Reply submitted to the Google Voice email gateway. Check Google Voice for delivery.');
              } else {
                setStatus((res && res.error) || 'SMS reply failed.');
              }
            } catch (_) {
              if (generation !== authGeneration || !workAuth.hasSession()) return;
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
      if (!workAuth.requireSession() || inboxLoading) return;
      const generation = authGeneration;
      inboxLoading = true;
      updateCallButtons();
      setStatus('Syncing Google Voice SMS & voicemail from c@schafferai.com…');
      try {
        const res = await workAuth.request({ action: 'voice_inbox', limit: 10 });
        if (generation !== authGeneration || !workAuth.hasSession()) return;
        if (res && res.ok) {
          renderInboxItems(res.items || []);
          setStatus('Synced ' + (res.count || 0) + ' Google Voice item(s) from c@schafferai.com.');
        } else {
          setStatus((res && res.error) || 'Inbox sync failed.');
        }
      } catch (err) {
        if (generation !== authGeneration || !workAuth.hasSession()) return;
        setStatus(err && err.code === 'AUTH_REQUIRED' ? 'Sign in required.' : 'Inbox sync failed.');
      } finally {
        if (generation === authGeneration) {
          inboxLoading = false;
          updateCallButtons();
        }
      }
    }

    function teardown() {
      authGeneration++;
      phoneGeneration++;
      reconnectNeeded = false; phoneWasConnected = false; reconnectAttempt = 0; cancelReconnect();
      deviceRegistered = false;
      devicePromise = null;
      if (win) win.googlePhoneDiagnostics = Object.freeze({registered:false});
      statusLoading = false;
      inboxLoading = false;
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
      // Work-account logout clears private content without interrupting the public phone.
      authGeneration++;
      statusLoading = false;
      inboxLoading = false;
      if (els.loginRow) els.loginRow.style.display = authed ? 'none' : 'flex';
      if (!authed) {
        voiceTurnGeneration++;
        voiceTurnPending = false;
        stopRecordingClip();
        releaseRecorderStream();
        onStopPlayback();
        lastVoiceStatus = null;
        statusCheckedForSession = false;
        if (els.inboxList) els.inboxList.innerHTML = '';
        if (!activeCall && !pendingIncoming && !devicePromise) setStatus(deviceRegistered ? 'Ready to call.' : 'Enter a number and press Call.');
      } else if (!(optsArg && optsArg.skipAutoStatus) && !statusCheckedForSession && !activeCall && !pendingIncoming) {
        statusCheckedForSession = true;
        handleCheckStatus().catch(() => {});
      }
      updateCallButtons();
    }

    if (els.openBtn) els.openBtn.addEventListener('click', () => toggleDrawer());
    if (els.topOpenBtn) els.topOpenBtn.addEventListener('click', () => toggleDrawer());
    if (els.closeBtn) els.closeBtn.addEventListener('click', () => toggleDrawer(false));
    els.drawer.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      toggleDrawer(false);
      const opener = els.topOpenBtn || els.openBtn;
      if (opener && typeof opener.focus === 'function') opener.focus();
    });
    if (els.loginBtn) els.loginBtn.addEventListener('click', handleInlineLogin);
    if (els.passwordInput) {
      els.passwordInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          handleInlineLogin();
        }
      });
    }
    if (els.modeGvoiceBtn) els.modeGvoiceBtn.addEventListener('click', () => setMode('gvoice'));
    if (els.modeAiLineBtn) els.modeAiLineBtn.addEventListener('click', () => setMode('ailine'));

    if (els.dialInput) {
      els.dialInput.addEventListener('input', updateCallButtons);
      els.dialInput.addEventListener('keydown', event => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        handlePrimaryCall();
      });
    }

    if (els.keypad) {
      els.keypad.addEventListener('click', (e) => {
        const keyBtn = e.target && e.target.closest ? e.target.closest('[data-digit]') : null;
        const digit = keyBtn && keyBtn.dataset ? keyBtn.dataset.digit : (e.target && e.target.dataset && e.target.dataset.digit);
        if (!digit) return;
        playDtmf(win, digit);
        if (els.dialInput && !activeCall && !pendingIncoming) {
          if ((els.dialInput.value || '').length < 32) els.dialInput.value = (els.dialInput.value || '') + digit;
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
    if (els.settingsBtn) els.settingsBtn.addEventListener('click', () => {
      if (!els.settingsPane) return;
      const open = els.settingsPane.hidden;
      els.settingsPane.hidden = !open;
      els.settingsBtn.setAttribute('aria-expanded', String(open));
    });
    if (els.connectBtn) els.connectBtn.addEventListener('click', async () => {
      try { await ensureGoogleDevice(); } catch (error) { setStatus('Google Voice unavailable: ' + (error && error.message || 'phone service offline')); }
    });
    if (els.testToneBtn) els.testToneBtn.addEventListener('click', async () => {
      if (activeCall && typeof activeCall.testTone === 'function') {
        await activeCall.testTone();
        els.testToneBtn.textContent = activeCall.tone ? 'Stop test tone' : 'Send test tone';
      }
    });
    if (els.answerBtn) els.answerBtn.addEventListener('click', () => {
      if (!pendingIncoming) return;
      const call = pendingIncoming; pendingIncoming = null;
      if (els.incomingBanner) els.incomingBanner.classList.remove('visible');
      attachCallHandlers(call, call.parameters.From || 'Incoming Google Voice call');
      call.accept();
    });
    if (els.declineBtn) els.declineBtn.addEventListener('click', () => {
      if (!pendingIncoming) return;
      pendingIncoming.reject(); pendingIncoming = null;
      if (els.incomingBanner) els.incomingBanner.classList.remove('visible');
      setStatus('Incoming call declined.'); updateCallButtons(); scheduleReconnect();
    });
    if (els.syncInboxBtn) els.syncInboxBtn.addEventListener('click', handleSyncInbox);
    if (els.checkStatusBtn) els.checkStatusBtn.addEventListener('click', handleCheckStatus);

    setAuthenticated(workAuth.hasSession(), { skipAutoStatus: true });
    updateCallButtons();

    return { teardown, setAuthenticated, toggleDrawer, setMode, openGoogleVoice, getPlaybackVolume: () => playbackVolume };
  }

  const api = {
    init,
    normalizeE164,
    buildGoogleVoiceCallUrl,
    buildGoogleVoiceSmsUrl,
    buildGoogleVoiceUrl
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SchafferWebPhone = api;
})(typeof window !== 'undefined' ? window : globalThis);
