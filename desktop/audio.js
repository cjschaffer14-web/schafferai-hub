// Audio is opt-in for each public viewer lease; no microphone is opened on load.
export const SOUND_FORMAT = Object.freeze({sampleRate:48000, channels:2, encoding:'s16le', bytes:38400});
export const MIC_FORMAT = Object.freeze({sampleRate:16000, channels:1, encoding:'s16le', bytes:6400});
const MAX_AGE = 1200;
const object = value => value && typeof value === 'object' && !Array.isArray(value);

export function decodePCM(pcm, bytes, decode = globalThis.atob) {
  if (typeof pcm !== 'string' || pcm.length !== Math.ceil(bytes/3)*4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(pcm)) throw new Error('Invalid audio data');
  const raw = decode(pcm);
  if (raw.length !== bytes) throw new Error('Invalid audio length');
  const result = new Float32Array(bytes/2);
  for (let i=0;i<result.length;i++) {
    const unsigned = raw.charCodeAt(i*2) | raw.charCodeAt(i*2+1)<<8;
    result[i] = (unsigned >= 32768 ? unsigned-65536 : unsigned)/32768;
  }
  return result;
}
export function encodePCM(buffer, encode = globalThis.btoa) {
  const bytes = new Uint8Array(buffer);
  if (bytes.byteLength !== MIC_FORMAT.bytes) throw new Error('Invalid microphone chunk');
  let raw=''; for (let i=0;i<bytes.length;i++) raw+=String.fromCharCode(bytes[i]);
  return encode(raw);
}

export class DesktopAudio {
  constructor({soundButton,micButton,message,onFailure=()=>{},fetch:fetcher=globalThis.fetch.bind(globalThis),AudioContext:AudioContextClass=globalThis.AudioContext||globalThis.webkitAudioContext,AudioWorkletNode:Worklet=globalThis.AudioWorkletNode,mediaDevices=globalThis.navigator?.mediaDevices,now=Date.now,setTimeout:timer=globalThis.setTimeout.bind(globalThis),clearTimeout:cancel=globalThis.clearTimeout.bind(globalThis)}={}) {
    Object.assign(this,{soundButton,micButton,message,onFailure,_fetch:fetcher,_AudioContext:AudioContextClass,_Worklet:Worklet,_mediaDevices:mediaDevices,_now:now,_timer:timer,_cancel:cancel});
    this._session=0; this._revision=0; this._micToken=0; this._soundToken=0; this._controlChain=Promise.resolve();
    this._sources=new Set(); this._controllers=new Set(); this._status={}; this.sound=false; this.mic=false; this._micStarting=false;
    this.soundButton?.addEventListener('click',()=>this.toggleSound());
    this.micButton?.addEventListener('click',()=>this.toggleMicrophone());
    this._render();
  }
  _render(text) {
    const supported=Boolean(this.id && this._status.available && this._status.ready && this._status.audio?.available);
    if(this.soundButton) {
      this.soundButton.disabled=!this.sound && (!supported || !this._status.audio?.captureReady || !this._AudioContext);
      this.soundButton.textContent=this.sound?'Sound on':'Sound off'; this.soundButton.setAttribute('aria-pressed',String(this.sound));
    }
    if(this.micButton) {
      this.micButton.disabled=!this.mic&&!this._micStarting&&(!supported||!this._status.audio?.microphoneReady||this._status.audio?.micInUse||!this._mediaDevices?.getUserMedia||!this._Worklet||!this._AudioContext);
      this.micButton.textContent=this._micStarting?'Cancel microphone':this.mic?'Microphone on':'Microphone off';
      this.micButton.setAttribute('aria-pressed',String(this.mic));
    }
    if(this.message) this.message.textContent=text || (this.mic ? `In the Mac app, choose ${this._status.audio?.virtualInputName || 'BlackHole 2ch'} as its microphone.` : this.id && !this._status.audio?.available ? this._status.audio?.message || 'Mac audio is not available yet.' : this._status.audio?.micInUse && !this._micStarting ? 'The microphone is in use by another desktop viewer.' : this.sound ? 'Mac sound is playing. Microphone is off.' : 'Sound and microphone are off until you turn them on.');
  }
  setSession(relay,id,status) {
    this.stop(); this.relay=relay; this.id=id; this._revision=0; this._controlChain=Promise.resolve(); this.updateStatus(status);
  }
  updateStatus(status) {
    this._status=status||{};
    if(this.id && (!status?.available || !status?.ready || !status?.audio?.available || (this.sound&&!status.audio.captureReady) || ((this.mic||this._micStarting)&&!status.audio.microphoneReady))) this.stop('Mac audio stopped.');
    this._render();
  }
  async _request(path,body,{keepalive=false,timeout=1800}={}) {
    const controller=new AbortController(); this._controllers.add(controller);
    const timeoutID=this._timer(()=>controller.abort(),timeout);
    try {
      const response=await this._fetch(`${this.relay}${path}`,{method:body===undefined?'GET':'POST',headers:body===undefined?{Accept:'application/json'}:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),credentials:'omit',cache:'no-store',redirect:'error',signal:controller.signal,keepalive});
      if(!response.ok) throw new Error(`Audio connection failed (${response.status})`);
      if(!response.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) throw new Error('Invalid audio response');
      const value=await response.json(); if(!object(value)) throw new Error('Invalid audio response'); return value;
    } finally { this._cancel(timeoutID); this._controllers.delete(controller); }
  }
  _context() {
    if(!this._contextObject||this._contextObject.state==='closed') this._contextObject=new this._AudioContext({latencyHint:'interactive'});
    // Called inside the button gesture, before the first network await.
    const resumed=this._contextObject.resume(); resumed?.catch(()=>{}); return this._contextObject;
  }
  _mutate() {
    const epoch=this._session,revision=++this._revision,id=this.id,sound=this.sound,mic=this.mic;
    const operation=async()=>{
      if(epoch!==this._session || revision!==this._revision) return null;
      const data=await this._request('/viewer/audio',{id,revision,sound,mic});
      if(epoch!==this._session || revision!==this._revision) return null;
      if(data.revision!==revision || data.sound!==sound || data.mic!==mic || typeof data.epoch!=='string') throw new Error('Invalid audio subscription');
      this._producerEpoch=data.epoch;
      if(sound) { if(typeof data.outputGeneration!=='string'||!data.outputGeneration) throw new Error('Missing sound session'); this._outputGeneration=data.outputGeneration; }
      if(mic) { if(typeof data.inputGeneration!=='string'||!data.inputGeneration) throw new Error('Missing microphone session'); this._inputGeneration=data.inputGeneration; }
      return data;
    };
    const promise=this._controlChain.catch(()=>{}).then(operation).catch(error=>{if(epoch!==this._session||revision!==this._revision)return null;throw error;}); this._controlChain=promise;
    return promise;
  }
  async toggleSound() {
    if(!this.id||this.soundButton?.disabled) return;
    const epoch=this._session;
    if(this.sound) { this._soundToken++; this.sound=false; this._stopPlayback(); this._render(); try { await this._mutate(); } catch(error) { if(epoch===this._session)this._fail(error); } return; }
    const token=++this._soundToken;
    try { this._context(); this.sound=true; this._lastOutput=0; this._render(); const state=await this._mutate(); if(state&&epoch===this._session&&token===this._soundToken&&this.sound)this._pollSound(epoch,token); }
    catch(error) { if(epoch===this._session)this._fail(error); }
  }
  _stopPlayback() {
    this._cancel(this._soundTimer); this._soundTimer=null; this._playAt=0;
    for(const source of this._sources) { try {source.stop();} catch{} try {source.disconnect();} catch{} }
    this._sources.clear();
  }
  _schedule(samples,seq) {
    const context=this._contextObject;
    if(!context || context.state!=='running') throw new Error('Tap Sound again to allow audio playback.');
    const current=context.currentTime;
    if(this._lastOutput&&seq!==this._lastOutput+1 || this._playAt>current+.65) this._stopPlayback();
    const buffer=context.createBuffer(2,samples.length/2,48000);
    for(let channel=0;channel<2;channel++) { const output=buffer.getChannelData(channel); for(let i=0;i<output.length;i++)output[i]=samples[i*2+channel]; }
    const source=context.createBufferSource(); source.buffer=buffer; source.connect(context.destination);
    this._playAt=Math.max(this._playAt||0,current+.08); source.start(this._playAt); this._playAt+=buffer.duration;
    this._sources.add(source); source.onended=()=>{this._sources.delete(source);source.disconnect();};
  }
  async _pollSound(epoch,token) {
    if(epoch!==this._session||token!==this._soundToken||!this.sound||!this.id)return;
    const generation=this._outputGeneration,started=this._now();
    try {
      const query=new URLSearchParams({id:this.id,generation,after:String(this._lastOutput||0)});
      const value=await this._request(`/audio?${query}`,undefined,{timeout:1200});
      if(epoch!==this._session||token!==this._soundToken||!this.sound||generation!==this._outputGeneration)return;
      if(value.epoch!==this._producerEpoch||value.generation!==generation)throw new Error('The Mac audio session changed. Turn Sound on again.');
      if(value.sampleRate!==48000||value.channels!==2||value.encoding!=='s16le'||!Array.isArray(value.chunks)||value.chunks.length>6)throw new Error('Unsupported Mac audio');
      const received=this._now(),elapsed=received-started;
      // Chunk age already includes relay processing. Only add the remaining
      // request/response time; older relays and invalid timing stay conservative.
      const transitUpperBound=Number.isFinite(value.processingMs)&&value.processingMs>=0&&value.processingMs<=elapsed?elapsed-value.processingMs:elapsed;
      // Keep at most the newest 600 ms rather than playing a network backlog.
      for(const chunk of value.chunks.slice(-3)) {
        if(!Number.isSafeInteger(chunk.seq)||chunk.seq<=this._lastOutput)continue;
        if(!Number.isFinite(chunk.ageMs)||chunk.ageMs<0||chunk.ageMs+transitUpperBound+Math.max(0,this._now()-received)>MAX_AGE){this._lastOutput=chunk.seq;continue;}
        const samples=decodePCM(chunk.pcm,SOUND_FORMAT.bytes); this._schedule(samples,chunk.seq); this._lastOutput=chunk.seq;
      }
    } catch(error) { if(epoch===this._session&&token===this._soundToken&&this.sound)this._fail(error); }
    finally { if(epoch===this._session&&token===this._soundToken&&this.sound)this._soundTimer=this._timer(()=>this._pollSound(epoch,token),100); }
  }
  async toggleMicrophone() {
    if(!this.id||this.micButton?.disabled)return;
    const epoch=this._session;
    if(this.mic||this._micStarting) {this._micToken++;this.mic=false;this._micStarting=false;this._stopMicrophone();this._render();try{await this._mutate();}catch(error){if(epoch===this._session)this._fail(error);}return;}
    const token=++this._micToken; this._micStarting=true;this._render();
    let stream;
    try {
      const context=this._context();
      // Never reached from page load, health checks, or Sound; only this button.
      stream=await this._mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true},video:false});
      if(epoch!==this._session||token!==this._micToken){stream.getTracks().forEach(track=>track.stop());return;}
      this._stream=stream;
      await context.audioWorklet.addModule(new URL('./audio-capture-worklet.js',import.meta.url));
      if(epoch!==this._session||token!==this._micToken){if(this._stream===stream)this._stopMicrophone();else stream.getTracks().forEach(track=>track.stop());return;}
      const source=context.createMediaStreamSource(stream),worklet=new this._Worklet(context,'schaffer-microphone',{numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[1]}),silence=context.createGain();
      silence.gain.value=0;source.connect(worklet);worklet.connect(silence);silence.connect(context.destination);
      this._micNodes=[source,worklet,silence];this._micStarting=false;this.mic=true;this._inputSequence=0;this._render();
      const state=await this._mutate();
      if(!state||epoch!==this._session||token!==this._micToken||!this.mic)return;
      worklet.port.onmessage=event=>{if(epoch===this._session&&token===this._micToken&&this.mic&&event.data instanceof ArrayBuffer)this._queueMicrophone(event.data,epoch);};
      for(const track of stream.getAudioTracks())track.onended=()=>{if(epoch===this._session&&this.mic)this._fail(new Error('Microphone access ended.'));};
    } catch(error) {
      if(stream&&this._stream!==stream)stream.getTracks().forEach(track=>track.stop());
      if(epoch===this._session&&token===this._micToken){this._stopMicrophone();this.mic=false;this._micStarting=false;this._render(error.name==='NotAllowedError'?'Microphone permission was not granted.':error.message||'Microphone unavailable.');try{await this._mutate();}catch(problem){this._fail(problem);}}
    }
  }
  _queueMicrophone(buffer,epoch) {
    try {this._micPending={pcm:encodePCM(buffer),seq:++this._inputSequence,at:this._now()};}catch(error){this._fail(error);return;}
    if(!this._micSending)this._sendMicrophone(epoch,this._micToken,this._inputGeneration);
  }
  async _sendMicrophone(epoch,token,generation) {
    if(this._micSending)return;const sending={};this._micSending=sending;
    try {
      while(epoch===this._session&&token===this._micToken&&generation===this._inputGeneration&&this.mic&&this._micPending){
        const chunk=this._micPending;this._micPending=null;if(this._now()-chunk.at>1000)continue;
        await this._request('/microphone',{id:this.id,generation,seq:chunk.seq,sampleRate:16000,channels:1,encoding:'s16le',pcm:chunk.pcm},{timeout:1000});
      }
    } catch(error){if(epoch===this._session&&token===this._micToken&&generation===this._inputGeneration&&this.mic)this._fail(error);}
    finally{if(this._micSending===sending)this._micSending=null;if(this.mic&&this._micPending&&!this._micSending)this._sendMicrophone(this._session,this._micToken,this._inputGeneration);}
  }
  _stopMicrophone() {
    this._micPending=null;
    if(this._micNodes){this._micNodes[1].port.onmessage=null;for(const node of this._micNodes)try{node.disconnect();}catch{}this._micNodes=null;}
    if(this._stream){for(const track of this._stream.getTracks()){track.onended=null;track.stop();}this._stream=null;}
  }
  stop(text) {
    const id=this.id,relay=this.relay,revision=++this._revision,active=this.sound||this.mic||this._micStarting;
    this._session++;this._micToken++;this._soundToken++;this.sound=false;this.mic=false;this._micStarting=false;
    this._stopPlayback();this._stopMicrophone();
    for(const controller of this._controllers)controller.abort();this._controllers.clear();
    this._outputGeneration=null;this._inputGeneration=null;this._producerEpoch=null;this._lastOutput=0;
    if(active&&id&&relay){
      // This OFF overtakes any earlier ON even when the HTTP requests reorder.
      try{Promise.resolve(this._fetch(`${relay}/viewer/audio`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,revision,sound:false,mic:false}),credentials:'omit',cache:'no-store',redirect:'error',keepalive:true})).catch(()=>{});}catch{}
    }
    const context=this._contextObject;this._contextObject=null;if(context)context.close()?.catch(()=>{});
    this._render(text);
  }
  clearSession(text) {this.stop(text);this.id=null;this.relay=null;this._status={};this._render(text);}
  _fail(error) {this.stop(error.message||'Audio stopped.');this.onFailure(error.message||'Audio connection stopped.');}
}
