'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const { create, SESSION_KEY } = require('./work-auth.js');
const token = 'test-signed-session-'.repeat(4);
function storage(initial = {}) { const map = new Map(Object.entries(initial)); return { getItem: k => map.get(k) || null, setItem: (k,v) => map.set(k,v), removeItem: k => map.delete(k), values: () => [...map.values()] }; }
function response(data, status = 200) { return { ok: status >= 200 && status < 300, status, json: async () => data }; }
function harness(handler) { let clock = Date.UTC(2026,10,24,18);const calls=[], saved=storage(), changes=[];const client=create({endpoint:'https://example.test/work',storage:saved,now:()=>clock,onChange:s=>changes.push(s),fetchImpl:async(url,options)=>{const p=JSON.parse(options.body);calls.push({url,options,payload:p});return handler?handler(p):response(p.action==='auth_login'?{ok:true,authenticated:true,token,expires_at:new Date(clock+3600000).toISOString()}:{ok:true,authenticated:true});}});return {client,calls,saved,changes,advance:ms=>clock+=ms}; }

test('all private actions are rejected before network without a session',async()=>{
 const h=harness();for(const action of ['chat','tts','send_text','rtc_signal','twilio_call','twilio_sms','poll_events'])await assert.rejects(h.client.request({action}),{code:'AUTH_REQUIRED'});assert.equal(h.calls.length,0);
});
test('login stores only expiring session in tab storage and cannot override session in a request',async()=>{
 const h=harness();const secret='fixture-only-input';await h.client.login(secret);assert(h.client.hasSession());assert(!h.saved.values().join('').includes(secret));assert.deepEqual(JSON.parse(h.saved.getItem(SESSION_KEY)),{token,expiresAt:Date.UTC(2026,10,24,19)});await h.client.request({action:'chat',token:'caller-tampered',message:'hi'});assert.equal(h.calls[1].payload.token,token);assert.equal(h.calls[1].options.cache,'no-store');assert.equal(h.calls[1].options.referrerPolicy,'no-referrer');
});
test('wrong login never stores an authenticated session',async()=>{
 const h=harness(()=>response({ok:false,authenticated:false,code:'AUTH_REQUIRED',error:'Unauthorized'}));await assert.rejects(h.client.login('fixture-wrong'),{code:'AUTH_REQUIRED'});assert.equal(h.client.hasSession(),false);assert.equal(h.saved.getItem(SESSION_KEY),null);assert.equal(h.calls.length,1);
});
test('expired session clears storage and blocks the next private call without sending',async()=>{
 const h=harness();await h.client.login('fixture-only-input');h.advance(3600001);await assert.rejects(h.client.request({action:'twilio_sms'}),{code:'AUTH_REQUIRED'});assert.equal(h.calls.length,1);assert.equal(h.saved.getItem(SESSION_KEY),null);
});
test('server rejects session, clears it and never retries the paid action',async()=>{
 let login=true;const h=harness(p=>p.action==='auth_login'?response({ok:true,authenticated:true,token,expires_at:new Date(Date.UTC(2026,10,24,19)).toISOString()}):response({ok:false,authenticated:false,error:'Unauthorized',code:'AUTH_REQUIRED'},401));await h.client.login('fixture-only-input');await assert.rejects(h.client.request({action:'twilio_call'}),{code:'AUTH_REQUIRED'});assert.equal(h.calls.length,2);assert.equal(h.client.hasSession(),false);assert.equal(h.saved.getItem(SESSION_KEY),null);
});
test('network-ambiguous mutation is sent exactly once',async()=>{
 const h=harness(p=>{if(p.action==='auth_login')return response({ok:true,authenticated:true,token,expires_at:new Date(Date.UTC(2026,10,24,19)).toISOString()});throw new Error('connection lost after request');});await h.client.login('fixture-only-input');await assert.rejects(h.client.request({action:'send_text'}),/connection lost/);assert.equal(h.calls.filter(x=>x.payload.action==='send_text').length,1);
});
test('public healthy ping never creates an authenticated client session',async()=>{
 const h=harness(()=>response({ok:true,authenticated:false,requires_token:true}));const p=await h.client.ping();assert.equal(p.ok,true);assert.equal(h.client.hasSession(),false);assert.equal(h.calls[0].payload.token,undefined);
});
test('malformed or unexpectedly long session lifetime is rejected',async()=>{
 for(const expires_at of ['not-a-date','2026-11-24T17:00:00Z','2026-11-25T18:00:00Z']) {const h=harness(()=>response({ok:true,authenticated:true,token,expires_at}));await assert.rejects(h.client.login('fixture-only-input'));assert.equal(h.client.hasSession(),false);}
});
test('unknown actions never reach fetch even when signed in',async()=>{
 const h=harness();await h.client.login('fixture-only-input');await assert.rejects(h.client.request({action:'approve_integration_budget'}),/Unsupported/);assert.equal(h.calls.length,1);
});

class Element {
 constructor(id){this.id=id;this.handlers={};this.style={};this.disabled=false;this.value='';this.dataset={};this.children=[];this.textContent='';this.className='';this.scrollHeight=0;this.attributes={};const s=new Set();this.classList={add:(...ks)=>ks.forEach(k=>s.add(k)),remove:(...ks)=>ks.forEach(k=>s.delete(k)),contains:k=>s.has(k),toggle:(k,on)=>{const v=on===undefined?!s.has(k):on;v?s.add(k):s.delete(k);return v;}};}
 addEventListener(k,f){(this.handlers[k]??=[]).push(f);}setAttribute(k,v){this.attributes[k]=v;}querySelectorAll(){return this.buttons||[];}appendChild(x){this.children.push(x);}focus(){this.focused=true;}contains(){return false;}click(){if(!this.disabled)return this.emit('click');}emit(k,e={}){return Promise.all((this.handlers[k]||[]).map(f=>f(Object.assign({preventDefault(){},stopPropagation(){},target:this},e))));}
}
function page(options = {}){
 const html=fs.readFileSync(path.join(__dirname,'index.html'),'utf8');const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);const elements=Object.fromEntries(ids.map(id=>[id,new Element(id)]));elements.quickPrompts.buttons=[new Element('chip')];const initialMarkup=html.match(/<div class="chat-messages" id="chatMessages">([\s\S]*?)<\/div>\s*<div class="status-thinking"/)[1];elements.chatMessages.innerHTML=initialMarkup;const local=storage({schafferai_work_token:'legacy-untrusted'}),session=storage(options.restoreSession?{[SESSION_KEY]:JSON.stringify({token,expiresAt:Date.now()+3600000})}:{});const calls=[],timers=[];let media=0;const window={location:{search:'?token=url-untrusted&password=discarded&x=1',pathname:'/',hash:'#view'},history:{replaceState:(a,b,url)=>window.cleanUrl=url},addEventListener(){},speechSynthesis:{cancel(){},speak(){}}};const document={getElementById:id=>elements[id],querySelectorAll:()=>[],addEventListener(){},createElement:t=>new Element(t)};const context={window,document,localStorage:local,sessionStorage:session,URL,URLSearchParams,Set,console,Date,setInterval:(f,ms)=>{timers.push({f,ms});return timers.length;},clearInterval(){},navigator:{mediaDevices:{getUserMedia:async()=>{media++;throw new Error('unexpected microphone');}}},fetch:async(url,options)=>{const p=JSON.parse(options.body);calls.push(p);if(p.action==='auth_login')return response({ok:true,authenticated:true,token,expires_at:new Date(Date.now()+3600000).toISOString()});return response({ok:true,authenticated:!!p.token,requires_token:true,account:'work',version:'test',reply:'reply',events:[],signals:[]});}};context.globalThis=context;window.fetch=context.fetch;vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(__dirname,'work-auth.js'),'utf8'),context);context.SchafferWorkAuth=window.SchafferWorkAuth;vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1],context);return {elements,local,session,calls,timers,window,initialMarkup,media:()=>media};
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));
test('signed-out page starts only public ping, removes legacy and URL credentials, and locks every private control',async()=>{
 const h=page();await flush();assert.deepEqual(h.calls.map(p=>p.action),['ping']);assert.equal(h.local.getItem('schafferai_work_token'),null);assert.equal(h.window.cleanUrl,'/?x=1#view');assert.equal(h.session.getItem(SESSION_KEY),null);assert(h.elements.authBanner.classList.contains('visible'));for(const id of ['sendBtn','callAiBtn','rtcJoinBtn','phoneSyncInboxBtn','phoneCheckStatusBtn','textModeBtn'])assert.equal(h.elements[id].disabled,true,id);for(const id of ['phoneCallBtn','phoneSmsBtn','callAiBtn','rtcJoinBtn'])await h.elements[id].emit('click');h.elements.chatInput.value='private request';await h.elements.chatForm.emit('submit');await flush();assert.deepEqual(h.calls.map(p=>p.action),['ping']);assert.equal(h.media(),0);
});
test('page login and logout use server session; polling stops and paid actions remain blocked after logout',async()=>{
 const h=page();await flush();h.elements.tokenInput.value='fixture-only-input';await h.elements.saveTokenBtn.emit('click');assert.equal(h.elements.tokenInput.value,'');assert.equal(h.elements.sendBtn.disabled,false);assert(h.session.getItem(SESSION_KEY));await h.elements.tokenBtn.emit('click');assert.equal(h.session.getItem(SESSION_KEY),null);assert.equal(h.elements.sendBtn.disabled,true);const count=h.calls.length;await h.elements.phoneCallBtn.emit('click');for(const t of h.timers.filter(t=>t.ms===4000))await t.f();assert.equal(h.calls.length,count);
});
test('all protected page requests use central auth client, with no embedded credential/default or direct fetch bypass',()=>{
 const html=fs.readFileSync(path.join(__dirname,'index.html'),'utf8');assert(!html.includes('fetch('));assert(!html.includes('state.token'));assert(!/password\s*[:=]\s*["']password["']/.test(html));assert(!/localStorage\.(?:getItem|setItem)\(STORAGE_TOKEN/.test(html));assert(html.includes('src="./work-auth.js"'));for(const action of ['chat','tts','send_text','rtc_signal','poll_events'])assert(html.includes('workAuth.request({ action: "'+action+'"'),action);
});
test('logout discards an in-flight private response instead of showing data after logout',async()=>{
 let finish;const h=harness(p=>p.action==='auth_login'?response({ok:true,authenticated:true,token,expires_at:new Date(Date.UTC(2026,10,24,19)).toISOString()}):new Promise(resolve=>finish=()=>resolve(response({ok:true,reply:'private result'}))));await h.client.login('fixture-only-input');const pending=h.client.request({action:'chat',message:'private'});h.client.clear();finish();await assert.rejects(pending,{code:'SESSION_CHANGED'});assert.equal(h.client.hasSession(),false);assert.equal(h.calls.length,2);
});
test('logout during login discards the later session response',async()=>{
 let finish;const h=harness(()=>new Promise(resolve=>finish=()=>resolve(response({ok:true,authenticated:true,token,expires_at:new Date(Date.UTC(2026,10,24,19)).toISOString()}))));const pending=h.client.login('fixture-only-input');h.client.clear();finish();await assert.rejects(pending,{code:'SESSION_CHANGED'});assert.equal(h.saved.getItem(SESSION_KEY),null);
});
test('oversized protected requests are rejected before fetch without replay',async()=>{
 const h=harness();await h.client.login('fixture-only-input');await assert.rejects(h.client.request({action:'chat',message:'x'.repeat(33000)}),/too large/);assert.equal(h.calls.length,1);
});
test('login rate-limit/service diagnostics remain distinct from wrong-password errors',async()=>{
 const h=harness(()=>response({ok:false,authenticated:false,error:'Sign in is temporarily rate limited.',code:'AUTH_RATE_LIMIT'}));await assert.rejects(h.client.login('fixture-only-input'),/rate limited/);assert.equal(h.client.hasSession(),false);
});

test('signed-in page replaces only the stale locked placeholder and preserves existing conversation content',async()=>{
 const h=page();await flush();h.elements.tokenInput.value='fixture-only-input';await h.elements.saveTokenBtn.emit('click');assert.equal(h.elements.chatMessages.innerHTML,'<div class="msg sys">Signed in. Private work tools are ready.</div>');assert(!h.elements.chatMessages.innerHTML.includes('tools are locked'));const history='<div class="msg user">Keep this conversation</div>';h.elements.chatMessages.innerHTML=history;h.elements.tokenInput.value='fixture-only-input';await h.elements.saveTokenBtn.emit('click');assert.equal(h.elements.chatMessages.innerHTML,history);
});

test('cached session restoration replaces the real whitespace-wrapped initial sign-in notice without another login',async()=>{
 const h=page({restoreSession:true});assert(h.initialMarkup.startsWith('\n'));assert(/\s$/.test(h.initialMarkup));assert(h.initialMarkup.includes('Public website · sign in'));await flush();assert.equal(h.elements.chatMessages.innerHTML,'<div class="msg sys">Signed in. Private work tools are ready.</div>');assert.equal(h.elements.sendBtn.disabled,false);assert.deepEqual(h.calls.map(p=>p.action),['ping']);assert.equal(h.calls[0].token,token);
});

const WebPhone = require('./web-phone.js');
test('web-phone module contains no direct fetch bypass and normalizes E.164 & Google Voice URLs', () => {
  const src = fs.readFileSync(path.join(__dirname, 'web-phone.js'), 'utf8');
  assert(!src.includes('fetch('));
  assert.equal(WebPhone.normalizeE164('(267) 264-7302'), '+12672647302');
  assert.equal(WebPhone.normalizeE164('1-215-555-0199'), '+12155550199');
  assert.equal(WebPhone.buildGoogleVoiceCallUrl('267-264-7302'), 'https://voice.google.com/u/0/calls?authuser=c%40schafferai.com&a=nc,%2B12672647302');
  assert.equal(WebPhone.buildGoogleVoiceCallUrl(''), 'https://voice.google.com/calls?authuser=c%40schafferai.com');
});

test('all web-phone backend actions are blocked without a session', async () => {
  const h = harness();
  for (const action of ['voice_status', 'voice_inbox', 'voice_reply', 'voice_token', 'voice_turn']) {
    await assert.rejects(h.client.request({ action }), { code: 'AUTH_REQUIRED' });
  }
  assert.equal(h.calls.length, 0);
});

test('inline phone drawer login unlocks phone and popup-blocked Google Voice renders a clearly separate direct link', async () => {
  const h = harness((p) => {
    if (p.action === 'auth_login') return response({ ok: true, authenticated: true, token, expires_at: new Date(Date.UTC(2026, 10, 24, 19)).toISOString() });
    if (p.action === 'voice_status') return response({ ok: true, google_voice: { billing_setup_email_seen: true, number_assigned: false }, twilio_webrtc: { browser_webrtc_ready: false }, elevenlabs_tts: { configured: true } });
    return response({ ok: true });
  });
  const ids = ['phoneDrawerBtn', 'topPhoneBtn', 'phoneCloseBtn', 'webPhoneDrawer', 'phoneLoginRow', 'phonePasswordInput', 'phoneLoginBtn', 'phoneModeGvoiceBtn', 'phoneModeAiLineBtn', 'phoneModeWebrtcBtn', 'phoneDialInput', 'phoneBackspaceBtn', 'phoneKeypad', 'phonePrimaryCallBtn', 'phoneHangupBtn', 'phoneMuteCallBtn', 'phoneGvMessagesBtn', 'phoneSyncInboxBtn', 'phoneCheckStatusBtn', 'phoneActionLinks', 'phoneStatusLine', 'phoneInboxList', 'phoneIncomingBanner', 'phoneIncomingLabel', 'phoneAnswerBtn', 'phoneDeclineBtn'];
  const els = Object.fromEntries(ids.map((id) => [id, new Element(id)]));
  els.phoneDialInput.value = '2672647302';
  const doc = { getElementById: (id) => els[id], createElement: (t) => new Element(t) };
  const win = { open: () => null }; // Simulates Electron webview blocking popups
  let loginHookCalled = 0;
  const ctrl = WebPhone.init({ workAuth: h.client, document: doc, window: win, onLoginSuccess: () => { loginHookCalled++; ctrl.setAuthenticated(true); } });

  assert.equal(els.phoneLoginRow.style.display, 'flex');
  els.phonePasswordInput.value = 'fixture-only-input';
  await els.phoneLoginBtn.emit('click');
  await flush();
  assert.equal(loginHookCalled, 1);
  assert.equal(els.phoneLoginRow.style.display, 'none');

  await els.phonePrimaryCallBtn.emit('click');
  assert(els.phoneStatusLine.textContent.includes('Popup blocked'));
  const hrefs = els.phoneActionLinks.children.map((a) => a.href);
  assert(!hrefs.includes('https://admin.google.com/ac/voice'));
  assert(hrefs.includes('https://voice.google.com/u/0/calls?authuser=c%40schafferai.com&a=nc,%2B12672647302'));
  assert(!hrefs.some(url => url.startsWith('tel:')));
});

test('web-phone UI gates calls on auth, opens Google Voice companion, syncs inbox, and tears down WebRTC on logout', async () => {
  const opened = [];
  let destroyed = 0, disconnected = 0;
  class FakeDevice {
    constructor(jwt) { this.jwt = jwt; this.handlers = {}; }
    on(k, fn) { this.handlers[k] = fn; }
    async register() { if (this.handlers.registered) this.handlers.registered(); }
    async connect({ params }) {
      this.lastDial = params.To;
      return {
        on() {},
        sendDigits(d) { this.digits = (this.digits || '') + d; },
        disconnect() { disconnected++; }
      };
    }
    unregister() {}
    destroy() { destroyed++; }
  }
  const h = harness((p) => {
    if (p.action === 'auth_login') return response({ ok: true, authenticated: true, token, expires_at: new Date(Date.UTC(2026, 10, 24, 19)).toISOString() });
    if (p.action === 'voice_token') return response({ ok: true, token: 'jwt.tok.sig', identity: 'cj_schaffer_web', from_number: '+12675550100' });
    if (p.action === 'voice_inbox') return response({ ok: true, count: 1, items: [{ kind: 'sms', subject: 'SMS from +12675550199', text: 'Hello', message_id: 'm1', can_reply_sms: true }] });
    if (p.action === 'voice_status') return response({ ok: true, google_voice: { billing_setup_email_seen: true, number_assigned: false }, twilio_webrtc: { browser_webrtc_ready: true, from_number: '+12675550100' }, elevenlabs_tts: { configured: true } });
    return response({ ok: true });
  });

  const ids = ['phoneDrawerBtn', 'topPhoneBtn', 'phoneCloseBtn', 'webPhoneDrawer', 'phoneModeGvoiceBtn', 'phoneModeWebrtcBtn', 'phoneDialInput', 'phoneBackspaceBtn', 'phoneKeypad', 'phonePrimaryCallBtn', 'phoneHangupBtn', 'phoneMuteCallBtn', 'phoneGvMessagesBtn', 'phoneSyncInboxBtn', 'phoneCheckStatusBtn', 'phoneStatusLine', 'phoneInboxList', 'phoneIncomingBanner', 'phoneIncomingLabel', 'phoneAnswerBtn', 'phoneDeclineBtn'];
  const els = Object.fromEntries(ids.map((id) => [id, new Element(id)]));
  els.phoneDialInput.value = '2672647302';
  const doc = { getElementById: (id) => els[id], createElement: (t) => new Element(t) };
  const win = { open: (url) => opened.push(url), Twilio: { Device: FakeDevice } };

  const ctrl = WebPhone.init({ workAuth: h.client, document: doc, window: win, defaultMode:'webrtc' });
  assert.equal(els.phonePrimaryCallBtn.disabled, true);

  await h.client.login('fixture-only-input');
  ctrl.setAuthenticated(true);
  assert.equal(els.phonePrimaryCallBtn.disabled, false);

  await els.phoneModeGvoiceBtn.emit('click');
  assert.deepEqual(opened, ['https://voice.google.com/u/0/calls?authuser=c%40schafferai.com&a=nc,%2B12672647302']);

  await els.phoneSyncInboxBtn.emit('click');
  assert.equal(els.phoneInboxList.children.length, 1);
  await els.phoneCheckStatusBtn.emit('click');
  assert(els.phoneStatusLine.textContent.includes('Browser Phone: Configured'));

  await els.phoneModeWebrtcBtn.emit('click');
  await flush();
  await els.phonePrimaryCallBtn.emit('click');
  assert(els.phoneStatusLine.textContent.includes('Connecting · +12672647302'));

  h.client.clear();
  ctrl.setAuthenticated(false);
  assert.equal(disconnected, 1);
  assert.equal(destroyed, 1);
  assert.equal(els.phonePrimaryCallBtn.disabled, true);
});

test('call controls stay visible, never fake Google Voice control, and follow real in-page call events', async () => {
  let connected = 0, muted = false, popups = 0;
  const events = {};
  const call = { on: (name, fn) => { events[name] = fn; }, isMuted: () => muted,
    mute: value => { muted = value; }, disconnect: () => events.disconnect() };
  class Device {
    on() {} async register() {} unregister() {} destroy() {}
    async connect() { connected++; return call; }
  }
  const ids = [...fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8').matchAll(/\bid="(phone[^"]+|webPhoneDrawer)"/g)].map(m => m[1]);
  ids.push('phoneDialInput'); // Optional input in the reusable in-page controller fixture.
  const els = Object.fromEntries(ids.map(id => [id, new Element(id)]));
  const auth = { hasSession: () => true, requireSession: () => true, request: async ({action}) =>
    action === 'voice_token' ? {ok:true, token:'fixture', identity:'owner'} : {ok:true} };
  let released = 0;
  const ctrl = WebPhone.init({defaultMode:'webrtc', workAuth:auth, document:{getElementById:id=>els[id], createElement:t=>new Element(t)},
    window:{open:()=>{popups++;}, Twilio:{Device}, navigator:{mediaDevices:{getUserMedia:async()=>({getAudioTracks:()=>[{label:'Headset'}], getTracks:()=>[{stop:()=>released++}]})}}}});
  assert.equal(els.phoneMuteCallBtn.style.display, '');
  assert.equal(els.phoneHangupBtn.style.display, '');
  assert.equal(els.phoneMuteCallBtn.disabled, true);
  assert.equal(els.phoneHangupBtn.disabled, true);
  assert.equal(els.phoneVolumeInput.disabled, true);
  assert.match(els.phoneControlHelp.textContent, /Mute, End call and Volume work here/);
  await els.phoneMicTestBtn.emit('click');
  assert.match(els.phoneStatusLine.textContent, /Headset/);
  assert.equal(released, 1);
  els.phoneDialInput.value = '2155550199';
  await els.phonePrimaryCallBtn.emit('click');
  assert.match(els.phoneStatusLine.textContent, /Connecting/);
  assert.equal(els.phonePrimaryCallBtn.disabled, true);
  await els.phonePrimaryCallBtn.emit('click');
  assert.equal(connected, 1);
  assert.equal(popups, 0, 'Call must dial in-page without opening a website');
  events.ringing(); assert.match(els.phoneStatusLine.textContent, /Ringing/);
  events.accept(); assert.match(els.phoneStatusLine.textContent, /Connected/);
  assert.equal(els.phoneMuteCallBtn.disabled, false);
  await els.phoneMuteCallBtn.emit('click');
  assert.equal(muted, true); assert.equal(els.phoneMuteCallBtn.attributes['aria-pressed'], 'true');
  const audio = {volume:1}; events.audio(audio);
  els.phoneVolumeInput.value='35'; await els.phoneVolumeInput.emit('input');
  assert.equal(audio.volume, .35); assert.equal(els.phoneVolumeValue.textContent, '35%');
  await els.phoneHangupBtn.emit('click');
  assert.match(els.phoneStatusLine.textContent, /Call ended/);
  assert.equal(els.phoneHangupBtn.disabled, true);
  ctrl.teardown();
});


test('unconfigured phone has a visible setup state and never opens a page from Call', async () => {
  const ids = [...fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8').matchAll(/\bid="(phone[^"]+|webPhoneDrawer)"/g)].map(m => m[1]);
  const els = Object.fromEntries(ids.map(id => [id, new Element(id)]));
  let popups = 0, tokens = 0;
  const auth = {hasSession:()=>true, requireSession:()=>true, request:async ({action})=>{
    if(action==='voice_token'){tokens++;return {ok:false,error:'Not configured'};}
    return {ok:true,twilio_webrtc:{browser_webrtc_ready:false,browser_setup:{available_lines:[]}}};
  }};
  WebPhone.init({defaultMode:'webrtc',workAuth:auth,document:{getElementById:id=>els[id],createElement:t=>new Element(t)},window:{open:()=>{popups++;}}});
  await els.phoneCheckStatusBtn.emit('click');
  assert.equal(els.phonePrimaryCallBtn.disabled,true);
  assert.equal(els.phonePrimaryCallBtn.textContent,'Phone setup required');
  assert.match(els.phoneStatusLine.textContent,/No active Twilio phone number/);
  await els.phonePrimaryCallBtn.click();
  assert.equal(popups,0);assert.equal(tokens,0);
});


test('the deployed phone defaults to Google Voice without requesting Twilio or exposing inactive call controls', async () => {
 const html=fs.readFileSync(path.join(__dirname,'index.html'),'utf8');
 assert(!html.includes('id="phoneModeWebrtcBtn"'));
 assert(!html.includes('Phone (Twilio)'));
 assert(!html.includes('action: "twilio_call"'));assert(!html.includes('action: "twilio_sms"'));
 const ids=[...html.matchAll(/\bid="(phone[^"]+|webPhoneDrawer)"/g)].map(m=>m[1]);
 const els=Object.fromEntries(ids.map(id=>[id,new Element(id)]));const requested=[],opened=[];
 const auth={hasSession:()=>true,requireSession:()=>true,request:async p=>{requested.push(p.action);return {ok:true,google_voice:{number_assigned:true,phone_number:'+13026359389'},twilio_webrtc:{browser_webrtc_ready:false}};}};
 WebPhone.init({workAuth:auth,document:{getElementById:id=>els[id],createElement:t=>new Element(t)},window:{open:url=>{opened.push(url);return {focus(){}};}}});
 await els.phoneCheckStatusBtn.emit('click');
 assert.equal(els.phoneLocalControls.style.display,'none');assert.equal(els.phonePrimaryCallBtn.disabled,false);
 assert.equal(els.phonePrimaryCallBtn.textContent,'Open Google Voice ↗');
 assert.match(els.phoneStatusLine.textContent,/Google Voice/);assert(!els.phoneStatusLine.textContent.includes('Twilio'));
 await els.phonePrimaryCallBtn.emit('click');
 assert.equal(opened.length,1);assert.match(opened[0],/authuser=c%40schafferai.com/);
 assert.deepEqual(requested,['voice_status']);
});

function googlePanel({ signedIn = false, popupBlocked = false, handler } = {}) {
 const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
 const els = Object.fromEntries([...html.matchAll(/\bid="([^"]+)"/g)].map(m => [m[1], new Element(m[1])]));
 for (const el of Object.values(els)) {
  Object.defineProperty(el, 'innerHTML', { set() { this.children = []; }, get() { return ''; } });
 }
 const requests = [], opened = [];
 let authenticated = signedIn;
 const auth = { hasSession: () => authenticated, requireSession: () => authenticated, request: async p => {
  requests.push(p.action);
  return handler ? handler(p) : { ok: true, google_voice: { phone_number: '+13026359389' } };
 }};
 const ctrl = WebPhone.init({workAuth: auth, document: {getElementById: id => els[id], createElement: t => new Element(t)},
  window: {open: url => {opened.push(url); return popupBlocked ? null : {focus(){}};}}});
 return {els, requests, opened, ctrl, logout() { authenticated = false; ctrl.setAuthenticated(false); }};
}

test('Google handles its own sign-in: calls, messages, voicemail and settings open without exposing the private backend', async () => {
 const h = googlePanel();
 for (const [id, route] of [['phonePrimaryCallBtn','calls'],['phoneGvMessagesBtn','messages'],['phoneGvVoicemailBtn','voicemail'],['phoneGvSettingsBtn','settings']]) {
  assert.equal(h.els[id].disabled, false);
  await h.els[id].click();
  assert.equal(h.opened.at(-1), 'https://voice.google.com/' + route + '?authuser=c%40schafferai.com');
 }
 await h.els.phoneSyncInboxBtn.emit('click');
 await h.els.phoneCheckStatusBtn.emit('click');
 assert.deepEqual(h.requests, []);
 assert.equal(h.els.phoneSyncInboxBtn.disabled, true);
 assert.equal(h.els.phoneCheckStatusBtn.disabled, true);
 assert.equal(h.els.phoneLineNumber.textContent, 'Work phone');
});

test('a blocked popup provides a safe direct link to the exact requested Google Voice page', async () => {
 const h = googlePanel({popupBlocked: true});
 for (const [id, route] of [['phonePrimaryCallBtn','calls'],['phoneGvMessagesBtn','messages'],['phoneGvVoicemailBtn','voicemail'],['phoneGvSettingsBtn','settings']]) {
  await h.els[id].click();
  assert.match(h.els.phoneStatusLine.textContent, /Popup blocked/);
  const link = h.els.phoneActionLinks.children[0];
  assert.equal(link.href, 'https://voice.google.com/' + route + '?authuser=c%40schafferai.com');
  assert.equal(link.target, '_blank');
  assert.equal(link.rel, 'noopener noreferrer');
 }
 assert.equal(WebPhone.buildGoogleVoiceUrl('//evil.example'), WebPhone.buildGoogleVoiceCallUrl());
});

test('late status and inbox responses after logout cannot restore private data or overwrite the sign-in state', async () => {
 const pending = {};
 const h = googlePanel({signedIn: true, handler: p => new Promise(resolve => pending[p.action] = resolve)});
 const status = h.els.phoneCheckStatusBtn.emit('click');
 const inbox = h.els.phoneSyncInboxBtn.emit('click');
 assert.equal(h.els.phoneCheckStatusBtn.disabled, true);
 assert.equal(h.els.phoneSyncInboxBtn.disabled, true);
 await h.els.phoneCheckStatusBtn.emit('click');
 await h.els.phoneSyncInboxBtn.emit('click');
 assert.deepEqual(h.requests, ['voice_status', 'voice_inbox']);
 h.logout();
 const signedOutStatus = h.els.phoneStatusLine.textContent;
 pending.voice_status({ok:true, google_voice:{phone_number:'+13026359389'}});
 pending.voice_inbox({ok:true, items:[{subject:'Private message',text:'Private content'}],count:1});
 await Promise.all([status, inbox]);
 assert.equal(h.els.phoneLineNumber.textContent, 'Work phone');
 assert.equal(h.els.phoneInboxList.children.length, 0);
 assert.equal(h.els.phoneStatusLine.textContent, signedOutStatus);
 assert.equal(h.els.phoneCheckStatusBtn.disabled, true);
});

test('status shows a line on record without claiming verified call readiness; Escape closes the panel', async () => {
 const h = googlePanel({signedIn: true});
 await h.els.phoneCheckStatusBtn.click();
 assert.equal(h.els.phoneLineNumber.textContent, '+13026359389');
 assert.match(h.els.phoneLineState.textContent, /Confirm your current number/);
 await h.els.topPhoneBtn.click();
 assert.equal(h.els.topPhoneBtn.attributes['aria-expanded'], 'true');
 await h.els.webPhoneDrawer.emit('keydown', {key:'Escape'});
 assert.equal(h.els.topPhoneBtn.attributes['aria-expanded'], 'false');
 assert.equal(h.els.topPhoneBtn.focused, true);
 h.logout();
 assert.equal(h.els.phoneLineNumber.textContent, 'Work phone');
});

test('the website Call button sends the entered number to Google once and rejects invalid destinations', async () => {
 const h = googlePanel();
 h.els.phoneDialInput.value = '(267) 264-7302';
 await h.els.phoneDialInput.emit('input');
 assert.equal(h.opened.length, 0);
 assert.equal(h.els.phonePrimaryCallBtn.textContent, 'Call with Google Voice ↗');
 await h.els.phonePrimaryCallBtn.click();
 assert.deepEqual(h.opened, ['https://voice.google.com/u/0/calls?authuser=c%40schafferai.com&a=nc,%2B12672647302']);
 assert.deepEqual(h.requests, []);
 h.els.phoneDialInput.value = 'invalid number';
 await h.els.phonePrimaryCallBtn.click();
 assert.equal(h.opened.length, 1);
 assert.match(h.els.phoneStatusLine.textContent, /valid phone number/);
});
