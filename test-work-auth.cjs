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
    action === 'voice_token' ? {ok:true, token:'fixture', identity:'owner',from_number:'+12155550100'} : {ok:true} };
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



function inlinePhone({signedIn=true, tokenHandler}={}) {
 const html=fs.readFileSync(path.join(__dirname,'index.html'),'utf8');
 const els=Object.fromEntries([...html.matchAll(/\bid="([^"]+)"/g)].map(m=>[m[1],new Element(m[1])]));
 const requests=[],devices=[],calls=[]; let authenticated=signedIn,popups=0;
 class Call {
  constructor(from){this.parameters={From:from};this.handlers={};this.state='pending';this.muted=false;this.rejected=0;this.accepted=0;this.digits='';}
  on(k,f){(this.handlers[k]??=[]).push(f);}
  emit(k,...args){return Promise.all((this.handlers[k]||[]).map(f=>f(...args)));}
  status(){return this.state;}
  accept(){this.state='open';this.accepted++;this.emit('accept');}
  reject(){this.rejected++;this.state='closed';this.emit('reject');}
  disconnect(){this.state='closed';this.emit('disconnect');}
  isMuted(){return this.muted;}
  mute(v){this.muted=v;}
  sendDigits(v){this.digits+=v;}
 }
 class Device {
  constructor(token){this.token=token;this.handlers={};this.destroyed=0;this.tokens=[];devices.push(this);}
  on(k,f){(this.handlers[k]??=[]).push(f);}
  emit(k,...args){return Promise.all((this.handlers[k]||[]).map(f=>f(...args)));}
  async register(){await this.emit('registered');}
  async connect({params}){this.to=params.To;const c=new Call();calls.push(c);return c;}
  updateToken(v){this.tokens.push(v);}
  unregister(){}
  destroy(){this.destroyed++;}
 }
 const auth={hasSession:()=>authenticated,requireSession:()=>authenticated,request:async p=>{
  requests.push(p.action);
  if(p.action==='voice_token')return tokenHandler?tokenHandler():{ok:true,token:'fixture',from_number:'+12155550100'};
  if(p.action==='voice_status')return {ok:true,twilio_webrtc:{browser_webrtc_ready:true,from_number:'+12155550100'}};
  return {ok:true,items:[],count:0};
 }};
 const ctrl=WebPhone.init({workAuth:auth,document:{getElementById:id=>els[id],createElement:t=>new Element(t)},window:{Twilio:{Device},open(){popups++;}}});
 return {ctrl,els,requests,devices,calls,Call,popups:()=>popups,logout(){authenticated=false;ctrl.setAuthenticated(false);}};
}

test('the shipped call path is entirely in-page and all calling actions require sign-in',async()=>{
 const h=inlinePhone({signedIn:false});
 for(const id of ['phoneConnectBtn','phonePrimaryCallBtn','phoneSyncInboxBtn','phoneCheckStatusBtn']) {
  assert.equal(h.els[id].disabled,true,id);
  await h.els[id].emit('click');
 }
 assert.deepEqual(h.requests,[]);assert.equal(h.popups(),0);
 const js=fs.readFileSync(path.join(__dirname,'web-phone.js'),'utf8');
 const html=fs.readFileSync(path.join(__dirname,'index.html'),'utf8');
 assert(!js.includes('win.open('));assert(!html.includes('openGoogleVoice('));
 assert(!js.includes('fetch('));assert(!html.includes('voice.google.com/calls'));
});

test('Enable calling registers once for incoming calls and renews the voice token without placing a call',async()=>{
 const h=inlinePhone();
 const one=h.els.phoneConnectBtn.emit('click');const two=h.els.phoneConnectBtn.emit('click');
 await Promise.all([one,two]);
 assert.equal(h.devices.length,1);assert.equal(h.calls.length,0);
 assert.equal(h.els.phoneConnectBtn.textContent,'Receiving calls');
 assert.match(h.els.phoneLineState.textContent,/Ready to receive/);
 await h.devices[0].emit('tokenWillExpire');
 assert.deepEqual(h.devices[0].tokens,['fixture']);
 assert.deepEqual(h.requests,['voice_token','voice_token']);
 h.logout();assert.equal(h.devices[0].destroyed,1);
});

test('outgoing calls stay in-page and the keypad sends in-call DTMF without modifying the destination',async()=>{
 const h=inlinePhone();h.els.phoneDialInput.value='2155550199';
 await h.els.phonePrimaryCallBtn.click();
 assert.equal(h.devices[0].to,'+12155550199');
 assert.equal(h.popups(),0);assert.match(h.els.phoneStatusLine.textContent,/Connecting/);
 const call=h.calls[0];call.accept();
 assert.match(h.els.phoneStatusLine.textContent,/Connected/);
 await h.els.phoneKeypad.emit('click',{target:{dataset:{digit:'7'}}});
 assert.equal(call.digits,'7');assert.equal(h.els.phoneDialInput.value,'2155550199');
 await h.els.phoneHangupBtn.click();
 assert.equal(call.state,'closed');assert.match(h.els.phoneStatusLine.textContent,/Call ended/);
 h.logout();
});

test('incoming calls ring in the page and Answer handles synchronous accept events; busy calls are rejected',async()=>{
 const h=inlinePhone();await h.els.phoneConnectBtn.click();
 const call=new h.Call('+12155550199');await h.devices[0].emit('incoming',call);
 assert(h.els.webPhoneDrawer.classList.contains('open'));
 assert(h.els.phoneIncomingBanner.classList.contains('visible'));
 assert.match(h.els.phoneIncomingLabel.textContent,/12155550199/);
 await h.els.phoneAnswerBtn.click();
 assert.equal(call.accepted,1);assert.match(h.els.phoneStatusLine.textContent,/Connected/);
 const busy=new h.Call('+12155550200');await h.devices[0].emit('incoming',busy);
 assert.equal(busy.rejected,1);
 await h.els.phoneHangupBtn.click();h.logout();
});

test('Decline and remote cancellation clear ringing without starting audio',async()=>{
 const h=inlinePhone();await h.els.phoneConnectBtn.click();
 const call=new h.Call('+12155550199');await h.devices[0].emit('incoming',call);
 await h.els.phoneDeclineBtn.click();
 assert.equal(call.rejected,1);assert.equal(call.accepted,0);
 assert(!h.els.phoneIncomingBanner.classList.contains('visible'));
 const canceled=new h.Call('+12155550200');await h.devices[0].emit('incoming',canceled);
 await canceled.emit('cancel');
 assert(!h.els.phoneIncomingBanner.classList.contains('visible'));
 await h.els.phoneAnswerBtn.emit('click');assert.equal(canceled.accepted,0);h.logout();
});

test('logout during token initialization cannot leave a registered device or restore calling state',async()=>{
 let resolve;const h=inlinePhone({tokenHandler:()=>new Promise(r=>resolve=r)});
 const start=h.els.phoneConnectBtn.emit('click');h.logout();
 const locked=h.els.phoneStatusLine.textContent;
 resolve({ok:true,token:'late-private-token',from_number:'+12155550100'});await start;
 assert.equal(h.devices.length,0);assert.equal(h.els.phoneStatusLine.textContent,locked);
 assert.equal(h.els.phoneConnectBtn.disabled,true);
});

test('an incomplete calling account never claims online and never opens a fallback window',async()=>{
 const h=inlinePhone({tokenHandler:()=>({ok:false,error:'No active phone number on this account'})});
 await h.els.phoneConnectBtn.click();
 assert.match(h.els.phoneStatusLine.textContent,/No active phone number/);
 assert.equal(h.devices.length,0);assert.equal(h.popups(),0);
 assert(!h.els.phoneLineState.textContent.includes('Ready'));
});
