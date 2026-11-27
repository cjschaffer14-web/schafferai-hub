const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../audio.js'),'utf8').replace("new URL('./audio-capture-worklet.js',import.meta.url)","'https://portal.example/audio-capture-worklet.js'");
const modulePromise=import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{resolve,reject,promise};};
const json=value=>({ok:true,status:200,headers:new Headers({'Content-Type':'application/json'}),json:async()=>value});
class Button{constructor(){this.disabled=false;this.events={};}addEventListener(name,cb){this.events[name]=cb;}setAttribute(name,value){this[name]=value;}}
const healthy={available:true,ready:true,audio:{available:true,captureReady:true,microphoneReady:true,virtualInputName:'BlackHole 2ch'}};
async function harness(options={}){
  const {DesktopAudio}=await modulePromise;
  const calls=[],contexts=[],scheduled=[],failures=[],timers=new Map(),worklets=[];let timer=0,micCalls=0;
  class Node{connect(){}disconnect(){this.disconnected=true;}}
  class Worklet extends Node{constructor(){super();this.port={};worklets.push(this);}}
  class Context{
    constructor(){this.state='running';this.currentTime=0;this.destination={};this.audioWorklet={addModule:async()=>{}};contexts.push(this);}
    resume(){return Promise.resolve();}close(){this.state='closed';return Promise.resolve();}
    createMediaStreamSource(){return new Node();}createGain(){const node=new Node();node.gain={value:1};return node;}
    createBuffer(channels,frames,rate){const data=Array.from({length:channels},()=>new Float32Array(frames));return{duration:frames/rate,getChannelData:index=>data[index]};}
    createBufferSource(){const node=new Node();node.start=at=>scheduled.push({node,at});node.stop=()=>{node.stopped=true;};return node;}
  }
  const soundButton=new Button(),micButton=new Button(),message={};
  const fetcher=async(url,init)=>{
    const call={url,init,body:init.body?JSON.parse(init.body):undefined};calls.push(call);
    if(options.fetch)return options.fetch(call);
    if(url.includes('/viewer/audio'))return json({epoch:'epoch',...call.body,outputGeneration:'output',inputGeneration:'input',audio:healthy.audio});
    return json({epoch:'epoch',generation:'output',sampleRate:48000,channels:2,encoding:'s16le',chunks:[]});
  };
  const audio=new DesktopAudio({soundButton,micButton,message,AudioContext:Context,AudioWorkletNode:Worklet,mediaDevices:{getUserMedia:()=>{micCalls++;return options.media?options.media():Promise.reject(Object.assign(new Error('denied'),{name:'NotAllowedError'}));}},fetch:fetcher,onFailure:message=>failures.push(message),now:options.now||Date.now,setTimeout:(fn,delay)=>{timers.set(++timer,{fn,delay});return timer;},clearTimeout:id=>timers.delete(id)});
  audio.setSession('https://relay.example','viewer',healthy);
  return{audio,calls,contexts,scheduled,failures,timers,worklets,soundButton,micButton,message,get micCalls(){return micCalls;}};
}
function fakeStream(){const track={stops:0,stop(){this.stops++;}};return{track,getTracks:()=>[track],getAudioTracks:()=>[track]};}

test('sound is opt-in and never requests a browser microphone',async()=>{
  const h=await harness();assert.equal(h.micCalls,0);assert.equal(h.calls.length,0);assert.equal(h.audio.sound,false);assert.equal(h.audio.mic,false);
  await h.audio.toggleSound();await settle();assert.equal(h.micCalls,0);assert.equal(h.audio.sound,true);assert.equal(h.calls[0].body.sound,true);assert.equal(h.calls[0].body.mic,false);
  assert.equal(h.calls[0].init.credentials,'omit');assert.equal(h.calls[0].init.redirect,'error');h.audio.clearSession();
});
test('missing Mac microphone sink blocks browser permission requests',async()=>{
  const h=await harness();h.audio.updateStatus({...healthy,audio:{...healthy.audio,microphoneReady:false}});
  await h.audio.toggleMicrophone();assert.equal(h.micCalls,0);assert.equal(h.micButton.disabled,true);h.audio.clearSession();
});
test('disconnect during a permission prompt stops a late microphone stream',async()=>{
  const permission=deferred(),stream=fakeStream(),h=await harness({media:()=>permission.promise});
  const starting=h.audio.toggleMicrophone();assert.equal(h.micCalls,1);h.audio.clearSession();permission.resolve(stream);await starting;
  assert.equal(stream.track.stops,1);assert.equal(h.audio.mic,false);assert.equal(h.worklets.length,0);
});
test('terminal OFF uses a newer revision than an in-flight ON and ignores its late response',async()=>{
  const pending=deferred();const h=await harness({fetch:call=>call.body?.sound?pending.promise:Promise.resolve(json({epoch:'epoch',...call.body,outputGeneration:null,inputGeneration:null}))});
  const starting=h.audio.toggleSound();await settle();h.audio.clearSession();
  assert.equal(h.calls[1].body.sound,false);assert.ok(h.calls[1].body.revision>h.calls[0].body.revision);
  pending.resolve(json({epoch:'epoch',...h.calls[0].body,outputGeneration:'old',inputGeneration:null}));await starting;await settle();
  assert.equal(h.calls.filter(call=>call.url.includes('/audio?')).length,0);assert.deepEqual(h.failures,[]);
});
test('late sound response from a prior toggle cannot play or create a second poll loop',async()=>{
  const first=deferred();let generation=0;
  const h=await harness({fetch:call=>{
    if(call.url.includes('/viewer/audio'))return Promise.resolve(json({epoch:'epoch',...call.body,outputGeneration:call.body.sound?'output'+(++generation):null,inputGeneration:null}));
    if(call.url.includes('generation=output1'))return first.promise;
    return Promise.resolve(json({epoch:'epoch',generation:'output2',sampleRate:48000,channels:2,encoding:'s16le',chunks:[]}));
  }});
  await h.audio.toggleSound();await h.audio.toggleSound();await h.audio.toggleSound();await settle();
  first.resolve(json({epoch:'epoch',generation:'output1',sampleRate:48000,channels:2,encoding:'s16le',chunks:[{seq:1,ageMs:0,pcm:Buffer.alloc(38400).toString('base64')}]}));await settle();
  assert.equal(h.scheduled.length,0);assert.equal([...h.timers.values()].filter(timer=>timer.delay===100).length,1);assert.deepEqual(h.failures,[]);h.audio.clearSession();
});
test('microphone is silent locally, sends fixed PCM packets once, and stops tracks immediately',async()=>{
  const stream=fakeStream(),h=await harness({media:async()=>stream});await h.audio.toggleMicrophone();
  assert.equal(h.audio.mic,true);assert.equal(h.worklets.length,1);assert.match(h.message.textContent,/BlackHole 2ch/);
  h.worklets[0].port.onmessage({data:new ArrayBuffer(6400)});await settle();
  const posts=h.calls.filter(call=>call.url.endsWith('/microphone'));assert.equal(posts.length,1);
  assert.deepEqual(Object.fromEntries(Object.entries(posts[0].body).filter(([name])=>name!=='pcm')),{id:'viewer',generation:'input',seq:1,sampleRate:16000,channels:1,encoding:'s16le'});
  assert.equal(Buffer.from(posts[0].body.pcm,'base64').byteLength,6400);
  await h.audio.toggleMicrophone();assert.equal(stream.track.stops,1);assert.equal(h.audio.mic,false);assert.equal(h.worklets[0].port.onmessage,null);h.audio.clearSession();
});
test('old microphone upload failure does not stop a new microphone session',async()=>{
  const old=deferred();let micPosts=0;const firstStream=fakeStream(),secondStream=fakeStream();let streams=0;
  const h=await harness({media:async()=>++streams===1?firstStream:secondStream,fetch:call=>{
    if(call.url.endsWith('/microphone'))return ++micPosts===1?old.promise:Promise.resolve(json({ok:true}));
    return Promise.resolve(json({epoch:'epoch',...call.body,outputGeneration:'output',inputGeneration:call.body.mic?'input'+streams:null}));
  }});
  await h.audio.toggleMicrophone();h.worklets[0].port.onmessage({data:new ArrayBuffer(6400)});await settle();
  await h.audio.toggleMicrophone();await h.audio.toggleMicrophone();h.worklets[1].port.onmessage({data:new ArrayBuffer(6400)});
  old.reject(new Error('old upload failed'));await settle();await settle();assert.deepEqual(h.failures,[]);assert.equal(h.audio.mic,true);assert.equal(micPosts,2);h.audio.clearSession();
});
test('PCM decoder preserves signed samples and rejects malformed or oversized audio',async()=>{
  const {decodePCM}=await modulePromise;const pcm=Buffer.from([0,128,255,127,0,0,0,192]).toString('base64');
  assert.deepEqual(Array.from(decodePCM(pcm,8)),[-1,32767/32768,0,-.5]);assert.throws(()=>decodePCM(pcm,6400));assert.throws(()=>decodePCM('!'.repeat(pcm.length),8));
});
test('worklet resamples 48 kHz stereo into exact 200 ms mono16 PCM and outputs silence',()=>{
  let Processor;const packets=[];
  const sandbox={sampleRate:48000,ArrayBuffer,DataView,Math,AudioWorkletProcessor:class{constructor(){this.port={postMessage:(buffer)=>packets.push(Buffer.from(buffer))};}},registerProcessor:(_,constructor)=>{Processor=constructor;}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../audio-capture-worklet.js'),'utf8'),sandbox);const processor=new Processor();
  const left=new Float32Array(128).fill(.75),right=new Float32Array(128).fill(.25),output=new Float32Array(128).fill(1);
  for(let i=0;i<75;i++)processor.process([[left,right]],[[output]]);
  assert.equal(packets.length,1);assert.equal(packets[0].length,6400);assert.equal(packets[0].readInt16LE(0),16384);assert.equal(packets[0].readInt16LE(6398),16384);assert.ok(output.every(value=>value===0));
});

test('sound deinterleaves stereo PCM, bounds playback backlog, and mutes scheduled buffers immediately',async()=>{
  const bytes=Buffer.alloc(38400);for(let offset=0;offset<bytes.length;offset+=4){bytes.writeInt16LE(32767,offset);bytes.writeInt16LE(-32768,offset+2);}
  const h=await harness({fetch:call=>call.url.includes('/viewer/audio')?Promise.resolve(json({epoch:'epoch',...call.body,outputGeneration:'output',inputGeneration:null})):Promise.resolve(json({epoch:'epoch',generation:'output',sampleRate:48000,channels:2,encoding:'s16le',chunks:Array.from({length:6},(_,i)=>({seq:i+1,ageMs:(5-i)*200,pcm:bytes.toString('base64')}))}))});
  await h.audio.toggleSound();await settle();assert.equal(h.scheduled.length,3);
  assert.equal(h.scheduled[0].node.buffer.getChannelData(0)[0],32767/32768);assert.equal(h.scheduled[0].node.buffer.getChannelData(1)[0],-1);
  assert.ok(h.scheduled.at(-1).at<.7);await h.audio.toggleSound();assert.ok(h.scheduled.every(({node})=>node.stopped));h.audio.clearSession();
});

test('expired sound is discarded and malformed sound closes the audio session',async()=>{
  let fresh=false;
  const h=await harness({fetch:call=>call.url.includes('/viewer/audio')?Promise.resolve(json({epoch:'epoch',...call.body,outputGeneration:'output',inputGeneration:null})):Promise.resolve(json({epoch:'epoch',generation:'output',sampleRate:48000,channels:2,encoding:'s16le',chunks:[{seq:fresh?2:1,ageMs:fresh?0:1201,pcm:fresh?'bad':Buffer.alloc(38400).toString('base64')}]}))});
  await h.audio.toggleSound();await settle();assert.equal(h.scheduled.length,0);assert.equal(h.failures.length,0);
  fresh=true;const poll=[...h.timers.values()].find(timer=>timer.delay===100);poll.fn();await settle();assert.equal(h.failures.length,1);assert.equal(h.audio.sound,false);h.audio.clearSession();
});

async function delayedSound(timing,ageMs=500){
  let now=1000;
  const h=await harness({now:()=>now,fetch:call=>{
    if(call.url.includes('/viewer/audio'))return Promise.resolve(json({epoch:'epoch',...call.body,outputGeneration:'output',inputGeneration:null}));
    now+=750;
    return Promise.resolve(json({epoch:'epoch',generation:'output',sampleRate:48000,channels:2,encoding:'s16le',...timing,chunks:[{seq:1,ageMs,pcm:Buffer.alloc(38400).toString('base64')}]}));
  }});
  await h.audio.toggleSound();await settle();return h;
}

test('relay processing time is counted once when a slow response still carries fresh sound',async()=>{
  const h=await delayedSound({processingMs:700});
  // 500 ms of age at the relay plus at most 50 ms in transit is still fresh.
  assert.equal(h.scheduled.length,1);assert.equal(h.audio.sound,true);assert.deepEqual(h.failures,[]);h.audio.clearSession();
});

test('missing or invalid relay timing conservatively includes the entire request duration',async()=>{
  for(const timing of [{},{processingMs:-1},{processingMs:NaN},{processingMs:Infinity},{processingMs:751},{processingMs:'700'},{processingMs:null}]){
    const h=await delayedSound(timing);
    // Without trustworthy processing time, age 500 + elapsed 750 exceeds 1200 ms.
    assert.equal(h.scheduled.length,0,JSON.stringify(timing));assert.deepEqual(h.failures,[]);h.audio.clearSession();
  }
});

test('valid relay timing preserves the 1200 ms sound freshness boundary',async()=>{
  const stale=await delayedSound({processingMs:700},1151);
  assert.equal(stale.scheduled.length,0);assert.deepEqual(stale.failures,[]);stale.audio.clearSession();
  const boundary=await delayedSound({processingMs:700},1150);
  assert.equal(boundary.scheduled.length,1);assert.deepEqual(boundary.failures,[]);boundary.audio.clearSession();
});
