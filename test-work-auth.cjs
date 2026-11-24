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
function page(){
 const html=fs.readFileSync(path.join(__dirname,'index.html'),'utf8');const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(m=>m[1]);const elements=Object.fromEntries(ids.map(id=>[id,new Element(id)]));elements.quickPrompts.buttons=[new Element('chip')];const local=storage({schafferai_work_token:'legacy-untrusted'}),session=storage();const calls=[],timers=[];let media=0;const window={location:{search:'?token=url-untrusted&password=discarded&x=1',pathname:'/',hash:'#view'},history:{replaceState:(a,b,url)=>window.cleanUrl=url},addEventListener(){},speechSynthesis:{cancel(){},speak(){}}};const document={getElementById:id=>elements[id],querySelectorAll:()=>[],addEventListener(){},createElement:t=>new Element(t)};const context={window,document,localStorage:local,sessionStorage:session,URL,URLSearchParams,Set,console,Date,setInterval:(f,ms)=>{timers.push({f,ms});return timers.length;},clearInterval(){},navigator:{mediaDevices:{getUserMedia:async()=>{media++;throw new Error('unexpected microphone');}}},fetch:async(url,options)=>{const p=JSON.parse(options.body);calls.push(p);if(p.action==='auth_login')return response({ok:true,authenticated:true,token,expires_at:new Date(Date.now()+3600000).toISOString()});return response({ok:true,authenticated:!!p.token,requires_token:true,account:'work',version:'test',reply:'reply',events:[],signals:[]});}};context.globalThis=context;window.fetch=context.fetch;vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(__dirname,'work-auth.js'),'utf8'),context);context.SchafferWorkAuth=window.SchafferWorkAuth;vm.runInContext(html.match(/<script>([\s\S]*?)<\/script>/)[1],context);return {elements,local,session,calls,timers,window,media:()=>media};
}
const flush=()=>new Promise(resolve=>setImmediate(resolve));
test('signed-out page starts only public ping, removes legacy and URL credentials, and locks every private control',async()=>{
 const h=page();await flush();assert.deepEqual(h.calls.map(p=>p.action),['ping']);assert.equal(h.local.getItem('schafferai_work_token'),null);assert.equal(h.window.cleanUrl,'/?x=1#view');assert.equal(h.session.getItem(SESSION_KEY),null);assert(h.elements.authBanner.classList.contains('visible'));for(const id of ['sendBtn','callAiBtn','rtcJoinBtn','phoneCallBtn','phoneSmsBtn','textModeBtn'])assert.equal(h.elements[id].disabled,true,id);for(const id of ['phoneCallBtn','phoneSmsBtn','callAiBtn','rtcJoinBtn'])await h.elements[id].emit('click');h.elements.chatInput.value='private request';await h.elements.chatForm.emit('submit');await flush();assert.deepEqual(h.calls.map(p=>p.action),['ping']);assert.equal(h.media(),0);
});
test('page login and logout use server session; polling stops and paid actions remain blocked after logout',async()=>{
 const h=page();await flush();h.elements.tokenInput.value='fixture-only-input';await h.elements.saveTokenBtn.emit('click');assert.equal(h.elements.tokenInput.value,'');assert.equal(h.elements.sendBtn.disabled,false);assert(h.session.getItem(SESSION_KEY));await h.elements.tokenBtn.emit('click');assert.equal(h.session.getItem(SESSION_KEY),null);assert.equal(h.elements.sendBtn.disabled,true);const count=h.calls.length;await h.elements.phoneCallBtn.emit('click');for(const t of h.timers.filter(t=>t.ms===4000))await t.f();assert.equal(h.calls.length,count);
});
test('all protected page requests use central auth client, with no embedded credential/default or direct fetch bypass',()=>{
 const html=fs.readFileSync(path.join(__dirname,'index.html'),'utf8');assert(!html.includes('fetch('));assert(!html.includes('state.token'));assert(!/password\s*[:=]\s*["']password["']/.test(html));assert(!/localStorage\.(?:getItem|setItem)\(STORAGE_TOKEN/.test(html));assert(html.includes('src="./work-auth.js"'));for(const action of ['chat','tts','send_text','rtc_signal','twilio_call','twilio_sms','poll_events'])assert(html.includes('workAuth.request({ action: "'+action+'"'),action);
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
