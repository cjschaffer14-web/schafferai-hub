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
 const html=fs.readFileSync(path.join(__dirname,'index.html'),'utf8');assert(!html.includes('fetch('));assert(!html.includes('state.token'));assert(!/password\s*[:=]\s*["']password["']/.test(html));assert(!/localStorage\.(?:getItem|setItem)\(STORAGE_TOKEN/.test(html));assert(html.includes('src="./work-auth.js?v='));for(const action of ['chat','tts','send_text','rtc_signal','poll_events'])assert(html.includes('workAuth.request({ action: "'+action+'"'),action);
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

function googleOnly({signedIn=false,handler}={}) {
 const html=fs.readFileSync(path.join(__dirname,'index.html'),'utf8');
 const els=Object.fromEntries([...html.matchAll(/\bid="([^"]+)"/g)].map(m=>[m[1],new Element(m[1])]));
 for(const el of Object.values(els))Object.defineProperty(el,'innerHTML',{get(){return '';},set(){this.children=[];}});
 let authenticated=signedIn;const navigated=[],requests=[],calls=[];let sessionRequests=0,device,registrationFailures=0,timerId=0;const reconnectTimers=new Map();
 class FakeCall {constructor(){this.handlers={};this.parameters={From:'+15555550101'};this.accepted=false;}on(k,f){(this.handlers[k]??=[]).push(f);}emit(k,...v){for(const f of this.handlers[k]||[])f(...v);}accept(){this.accepted=true;this.emit('accept');}disconnect(){this.emit('disconnect');}status(){return this.accepted?'open':'connecting';}}
 class FakeDevice {constructor(){this.handlers={};device=this;}on(k,f){(this.handlers[k]??=[]).push(f);}emit(k,...v){for(const f of this.handlers[k]||[])f(...v);}async register(){if(registrationFailures>0){registrationFailures--;throw Error('network offline');}this.emit('registered');}async connect(data){calls.push(data.params.To);return new FakeCall();}unregister(){}destroy(){}}

 const auth={hasSession:()=>authenticated,requireSession:()=>authenticated,googlePhoneSession:async()=>{sessionRequests++;return {phoneNumber:'+13026359389'};},request:async p=>{
  requests.push(p.action);return handler?handler(p):{ok:true,google_voice:{number_assigned:true,phone_number:'+13026359389'}};
 }};
 const ctrl=WebPhone.init({setTimeout:(fn,delay)=>{const id=++timerId;reconnectTimers.set(id,{fn,delay});return id;},clearTimeout:id=>reconnectTimers.delete(id),workAuth:auth,document:{getElementById:id=>els[id],createElement:t=>new Element(t)},window:{SchafferGoogleSip:{Device:FakeDevice},location:{assign:url=>navigated.push(url)},open(){throw new Error('No new windows allowed');}}});
 return {els,ctrl,navigated,requests,calls,reconnectTimers,setRegistrationFailures:n=>{registrationFailures=n;},disconnectDevice:()=>device.emit('unregistered'),async runReconnect(){const entry=reconnectTimers.entries().next().value;assert(entry,'expected reconnect timer');reconnectTimers.delete(entry[0]);await entry[1].fn();},sessionRequests:()=>sessionRequests,incoming(){const call=new FakeCall();device.emit('incoming',call);return call;},logout(){authenticated=false;ctrl.setAuthenticated(false);}};
}

test('Google phone loads native SIP and contains no redirect or alternate-provider path',()=>{
 const src=fs.readFileSync(path.join(__dirname,'web-phone.js'),'utf8');const html=fs.readFileSync(path.join(__dirname,'index.html'),'utf8');
 assert(!/twilio|voice_token|win\.open\(|location\.assign|navigateGoogleVoice/i.test(src));
 assert(html.includes('google-sip-client.js'));assert(html.includes('phoneConnectBtn'));
 const h=googleOnly();assert.equal(h.els.phonePrimaryCallBtn.disabled,false);assert.equal(h.els.phoneConnectBtn.disabled,false);
});

test('signed-out phone connects and dials inside the website without private account access',async()=>{
 const h=googleOnly();h.els.phoneDialInput.value='2672647302';
 await h.els.phonePrimaryCallBtn.click();await h.els.phoneConnectBtn.click();
 assert.deepEqual(h.navigated,[]);assert.deepEqual(h.calls,['+12672647302']);assert.equal(h.sessionRequests(),1);assert.deepEqual(h.requests,[]);
});

test('typing does not dial; explicit Call uses the native Google device once',async()=>{
 const h=googleOnly({signedIn:true});h.els.phoneDialInput.value='2672647302';await h.els.phoneDialInput.emit('input');
 assert.deepEqual(h.calls,[]);assert.equal(h.sessionRequests(),0);
 await h.els.phonePrimaryCallBtn.click();assert.deepEqual(h.calls,['+12672647302']);assert.equal(h.sessionRequests(),1);assert.deepEqual(h.navigated,[]);
});

test('invalid destination cannot create a Google phone session',async()=>{
 const h=googleOnly({signedIn:true});h.els.phoneDialInput.value='invalid';await h.els.phonePrimaryCallBtn.click();
 assert.equal(h.sessionRequests(),0);assert.deepEqual(h.calls,[]);
});

test('incoming Google call works signed out and waits for explicit Answer',async()=>{
 const h=googleOnly();await h.els.phoneConnectBtn.click();const incoming=h.incoming();
 assert(h.els.webPhoneDrawer.classList.contains('open'));assert(h.els.phoneIncomingBanner.classList.contains('visible'));assert.equal(incoming.accepted,false);
 await h.els.phoneAnswerBtn.click();assert.equal(incoming.accepted,true);assert.equal(h.els.phoneIncomingBanner.classList.contains('visible'),false);
 await h.els.phoneHangupBtn.click();assert(h.els.phoneStatusLine.textContent.includes('ended'));
});

test('Google line status uses the authenticated work account rather than another provider line',async()=>{
 const h=googleOnly({signedIn:true});await h.els.phoneCheckStatusBtn.click();
 assert.equal(h.els.phoneLineNumber.textContent,'+13026359389');assert.deepEqual(h.requests,['voice_status']);
 h.logout();assert.equal(h.els.phoneLineNumber.textContent,'+13026359389');
});

test('late Google status and inbox results cannot restore private information after logout',async()=>{
 const pending={};const h=googleOnly({signedIn:true,handler:p=>new Promise(r=>pending[p.action]=r)});
 const status=h.els.phoneCheckStatusBtn.emit('click'),inbox=h.els.phoneSyncInboxBtn.emit('click');h.logout();
 const locked=h.els.phoneStatusLine.textContent;
 pending.voice_status({ok:true,google_voice:{phone_number:'+13026359389'}});
 pending.voice_inbox({ok:true,items:[{subject:'Private',text:'Private body'}]});
 await Promise.all([status,inbox]);assert.equal(h.els.phoneInboxList.children.length,0);
 assert.equal(h.els.phoneLineNumber.textContent,'+13026359389');assert.equal(h.els.phoneStatusLine.textContent,locked);
});

function phoneFixture(websocketUrl = 'wss://schafferai-phone-gateway.cjschaffer14.chatgpt.site/sip?ticket=' + 'a'.repeat(43)) {
 return {ok:true,uri:'sip:website@web.w.pbx.voice.sip.google.com',authorizationUsername:'website',authorizationPassword:'placeholder',expiresAt:Date.now()+3600000,websocketUrl};
}

test('public Google phone uses hosted HTTPS without work-account credentials or storage',async()=>{
 const saved=storage();const calls=[];
 const client=create({endpoint:'https://example.test/work',storage:saved,fetchImpl:async(url,options)=>{calls.push({url,options});return response(phoneFixture());}});
 const config=await client.googlePhoneSession();assert.equal(config.authorizationPassword,'placeholder');
 assert.equal(calls.length,1);assert.equal(calls[0].url,'https://schafferai-phone-gateway.cjschaffer14.chatgpt.site/session');assert.equal(calls[0].options.headers,undefined);assert.equal(calls[0].options.credentials,'omit');assert.equal(calls[0].options.redirect,'error');
 assert.deepEqual(saved.values(),[]);assert.equal(client.hasSession(),false);
});

test('phone session refuses insecure, foreign, malformed, or extra-parameter signaling URLs',async()=>{
 const base='wss://schafferai-phone-gateway.cjschaffer14.chatgpt.site/sip?ticket='+'a'.repeat(43);
 for (const url of ['ws://127.0.0.1:8878/sip?ticket=x',base.replace('.site/','.site.evil.test/'),base+'&extra=x',base+'&ticket=other',base+'#fragment',base.replace('wss:','https:'),base.replace('/sip?','/other?'),base.replace('a'.repeat(43),'short')]) {
  const client=create({storage:storage(),fetchImpl:async()=>response(phoneFixture(url))});
  await assert.rejects(client.googlePhoneSession(),/invalid/);
 }
});

test('private work logout does not cancel a pending public phone connection',async()=>{
 let finish;const saved=storage({[SESSION_KEY]:JSON.stringify({token,expiresAt:Date.now()+3600000})});
 const client=create({storage:saved,fetchImpl:()=>new Promise(resolve=>finish=()=>resolve(response(phoneFixture())))});
 const pending=client.googlePhoneSession();client.clear();finish();assert.equal((await pending).authorizationUsername,'website');assert.deepEqual(saved.values(),[]);
});

test('work-account logout preserves an active website phone call and its End call control',async()=>{
 const h=googleOnly({signedIn:true});await h.els.phoneConnectBtn.click();const incoming=h.incoming();await h.els.phoneAnswerBtn.click();
 h.logout();assert.equal(h.els.phoneHangupBtn.disabled,false);assert.equal(h.els.phoneLineState.textContent,'Connected');
 assert.equal(h.els.phoneSyncInboxBtn.disabled,true);assert.equal(h.els.phoneCheckStatusBtn.disabled,true);
 await h.els.phoneHangupBtn.click();assert(h.els.phoneStatusLine.textContent.includes('ended'));
});

test('phone Settings is collapsed by default and opens without dialing',async()=>{
 const html=fs.readFileSync(path.join(__dirname,'index.html'),'utf8');
 assert(/id="phoneSettingsPane" hidden/.test(html));
 const h=googleOnly({signedIn:true});h.els.phoneSettingsPane.hidden=true;
 await h.els.phoneSettingsBtn.click();assert.equal(h.els.phoneSettingsPane.hidden,false);assert.equal(h.els.phoneSettingsBtn.attributes['aria-expanded'],'true');
 await h.els.phoneSettingsBtn.click();assert.equal(h.els.phoneSettingsPane.hidden,true);assert.deepEqual(h.calls,[]);assert.equal(h.sessionRequests(),0);
});

test('in-call keypad preserves the destination while sending menu digits',async()=>{
 const h=googleOnly({signedIn:true});await h.els.phoneConnectBtn.click();
 const incoming=h.incoming();incoming.sendDigits=digits=>incoming.sentDigits=digits;
 h.els.phoneDialInput.value='+15555550199';await h.els.phoneAnswerBtn.click();
 assert.equal(h.els.phoneDialInput.value,'+15555550101');
 await h.els.phoneKeypad.emit('click',{target:{dataset:{digit:'1'}}});
 assert.equal(h.els.phoneDialInput.value,'+15555550101');assert.equal(incoming.sentDigits,'1');await h.els.phoneHangupBtn.click();
});


test('idle Google transport reconnects with bounded backoff and never repeats a call',async()=>{
 const h=googleOnly();await h.els.phoneConnectBtn.click();h.disconnectDevice();h.disconnectDevice();
 assert.equal(h.reconnectTimers.size,1);assert.equal([...h.reconnectTimers.values()][0].delay,2000);
 h.setRegistrationFailures(4);
 for (const expected of [5000,15000,30000,30000]) { await h.runReconnect();assert.equal([...h.reconnectTimers.values()][0].delay,expected); }
 await h.runReconnect();assert.equal(h.reconnectTimers.size,0);assert.equal(h.els.phoneLineState.textContent,'Connected');assert.deepEqual(h.calls,[]);
 h.disconnectDevice();assert.equal([...h.reconnectTimers.values()][0].delay,2000);h.ctrl.teardown();assert.equal(h.reconnectTimers.size,0);
});

test('transport reconnect waits until an active call ends and teardown cancels recovery',async()=>{
 const h=googleOnly();await h.els.phoneConnectBtn.click();const call=h.incoming();await h.els.phoneAnswerBtn.click();
 h.disconnectDevice();assert.equal(h.reconnectTimers.size,0);assert.equal(h.sessionRequests(),1);assert.equal(h.els.phoneHangupBtn.disabled,false);
 await h.els.phoneHangupBtn.click();assert.equal(h.reconnectTimers.size,1);assert.equal(h.sessionRequests(),1);
 h.ctrl.teardown();assert.equal(h.reconnectTimers.size,0);assert.deepEqual(h.calls,[]);
});

test('transport reconnect waits while an incoming call is awaiting an answer',async()=>{
 const h=googleOnly();await h.els.phoneConnectBtn.click();const call=h.incoming();h.disconnectDevice();
 assert.equal(h.reconnectTimers.size,0);call.emit('cancel');assert.equal(h.reconnectTimers.size,1);h.ctrl.teardown();
});
