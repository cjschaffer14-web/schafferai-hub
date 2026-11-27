import { HTTPDesktopTransport } from './http-transport.js?v=20261127-interaction';
import { DesktopAudio } from './audio.js?v=20261127-interaction';

const $ = id => document.getElementById(id);
const screen = $('screen'), desktop = $('desktop'), ctx = screen.getContext('2d', {alpha: false});
let relay, socket, healthTimer, live = false, connecting = false, generation = 0, agentReady = false;
let currentFrame = null, decoding = false, frameAt = 0, pointer = null, moveAt = 0;
let wheelTimer = null, wheelX = 0, wheelY = 0, transport = 'websocket';
const audio = new DesktopAudio({soundButton:$('sound'),micButton:$('microphone'),message:$('audio-status'),onFailure:message=>disconnect(message)});

function fitCanvas() {
  const width = Number(desktop.clientWidth), height = Number(desktop.clientHeight);
  if (![width,height,screen.width,screen.height].every(value => Number.isFinite(value) && value > 0)) return;
  const scale = Math.min(width / screen.width, height / screen.height);
  screen.style.width = `${screen.width * scale}px`;
  screen.style.height = `${screen.height * scale}px`;
}

function status(message) { $('status').textContent = message; }
function empty(title, message) {
  audio.stop();
  if(wheelTimer !== null) clearTimeout(wheelTimer);
  wheelTimer = null; wheelX = 0; wheelY = 0;
  generation++; currentFrame = null; frameAt = 0;
  $('fullscreen').disabled = true; $('text-toggle').disabled = true;
  for (const id of ['apps','return','escape']) $(id).disabled = true;
  $('text-form').hidden = true; $('text-toggle').setAttribute('aria-expanded','false');
  $('empty-title').textContent = title; $('empty-copy').textContent = message;
  $('placeholder').hidden = false; $('screen-label').hidden = true;
  screen.classList.remove('live'); ctx.clearRect(0, 0, screen.width, screen.height);
}
function send(event) {
  if (!live || socket?.readyState !== WebSocket.OPEN) return;
  if (event.type !== 'release' && (!agentReady || !screen.classList.contains('live') || !frameAt || Date.now()-frameAt > 10000)) return;
  try { return socket.send(JSON.stringify({type:'input', event})) !== false; }
  catch { disconnect('Desktop input could not be sent. Reconnect to continue.'); return false; }
}
function release() {
  if(wheelTimer !== null) clearTimeout(wheelTimer);
  wheelTimer = null; wheelX = 0; wheelY = 0;
  send({type:'release'}); pointer = null;
}
function controls(connected) {
  live = connected; $('connect').hidden = connected || connecting;
  $('disconnect').hidden = !connected && !connecting;
  $('fullscreen').disabled = !connected || !screen.classList.contains('live');
  $('text-toggle').disabled = !connected || !screen.classList.contains('live');
  for (const id of ['apps','return','escape']) $(id).disabled = !connected || !screen.classList.contains('live');
  if (!connected) { $('text-form').hidden = true; $('text-toggle').setAttribute('aria-expanded','false'); }
}
function disconnect(message = 'Disconnected. Connect again when you’re ready.') {
  audio.clearSession();
  release(); generation++; currentFrame = null; connecting = false;
  socket?.close(1000,'Disconnected'); socket = null; agentReady = false; controls(false);
  empty('Your Mac, from here.',message); status(message); checkHealth();
}
async function checkHealth() {
  if (!relay || live || connecting) return;
  try {
    const res = await fetch(`${relay}/health`,{cache:'no-store',signal:AbortSignal.timeout(6000)});
    if (!res.ok) throw new Error(); const data = await res.json();
    if (live || connecting) return;
    $('connect').disabled = !data.available || data.ready === false;
    if (data.available && data.ready !== false) status('Mac available');
    else status(data.message || (data.available ? 'Mac permissions need attention' : 'Mac offline'));
  } catch { if (!live && !connecting) { $('connect').disabled = true; status('Mac connection unavailable'); } }
}
async function drawFrames() {
  if (decoding) return; decoding = true;
  try {
    while (currentFrame && live && agentReady) {
      const blob = currentFrame, epoch = generation; currentFrame = null;
      const bitmap = await createImageBitmap(blob);
      if (epoch === generation && live && agentReady) {
        if (screen.width !== bitmap.width || screen.height !== bitmap.height) {
          screen.width = bitmap.width; screen.height = bitmap.height;
        }
        fitCanvas();
        ctx.drawImage(bitmap,0,0); frameAt = Date.now();
        screen.classList.add('live'); $('placeholder').hidden = true;
        $('fullscreen').disabled = false; $('text-toggle').disabled = false;
        for (const id of ['apps','return','escape']) $(id).disabled = false;
        $('screen-label').hidden = false; status('Connected · click the screen to control your Mac');
      }
      bitmap.close();
    }
  } catch { if (live) status('Waiting for the next desktop frame…'); }
  finally { decoding = false; }
}
function connect() {
  if (!relay || socket) return;
  connecting = true; agentReady = false; controls(false); status('Connecting to your Mac…');
  const ws = transport === 'http' ? new HTTPDesktopTransport(relay) : new WebSocket(`${relay.replace(/^http/,'ws')}/viewer`); socket = ws;
  ws.binaryType = 'blob';
  ws.onopen = () => { if (socket !== ws) return; connecting = false; controls(true); if(transport === 'http') audio.setSession(relay,ws.viewerId,{available:false,ready:false}); status('Connected · waiting for desktop…'); };
  ws.onmessage = event => {
    if (socket !== ws) return;
    if (event.data instanceof Blob) { if(agentReady) { currentFrame = event.data; return drawFrames(); } return; }
    let data; try { data = JSON.parse(event.data); } catch { return; }
    if (data.type === 'status' || data.type === 'hello') audio.updateStatus(data);
    if (data.type === 'status' && (data.available === false || data.ready === false)) {
      release(); agentReady = false; empty('Desktop unavailable',data.message || 'Check your Mac’s connection and permissions.');
      status(data.message || 'Desktop unavailable');
    } else if ((data.type === 'status' || data.type === 'hello') && data.ready === true) {
      agentReady = true;
      if (!screen.classList.contains('live')) {
        $('empty-title').textContent = 'Mac is ready';
        $('empty-copy').textContent = 'Waiting for the live desktop…';
        status('Mac ready · waiting for live desktop…');
      }
    } else if (data.type === 'error') status(data.message || 'Desktop connection error');
  };
  ws.onerror = () => { if (socket === ws) status('Desktop connection failed'); };
  ws.onclose = () => {
    if (socket !== ws) return;
    release(); audio.clearSession();
    socket = null; generation++; currentFrame = null; agentReady = false; connecting = false; controls(false);
    empty('Mac disconnected','Reconnect when your Mac is available.'); status('Desktop disconnected'); checkHealth();
  };
}
function point(event) {
  const r = screen.getBoundingClientRect();
  if (!r.width || !r.height || !screen.classList.contains('live')) return null;
  return {x:Math.max(0,Math.min(1,(event.clientX-r.left)/r.width)), y:Math.max(0,Math.min(1,(event.clientY-r.top)/r.height))};
}
screen.addEventListener('pointerdown',event => {
  const p = point(event); if (!p || !live) return;
  event.preventDefault(); screen.focus(); screen.setPointerCapture(event.pointerId); pointer = event.pointerId;
  send({type:'pointer',action:'down',button:Math.min(2,event.button),...p});
});
screen.addEventListener('pointermove',event => {
  const p = point(event); if (!p || !live || Date.now()-moveAt < 20) return;
  moveAt = Date.now(); send({type:'pointer',action:'move',...p});
});
screen.addEventListener('pointerup',event => {
  const p = point(event); if (p) send({type:'pointer',action:'up',button:Math.min(2,event.button),...p});
  pointer = null;
});
screen.addEventListener('pointercancel',release);
screen.addEventListener('contextmenu',event => event.preventDefault());
screen.addEventListener('wheel',event => {
  if (!live || !agentReady || !screen.classList.contains('live') || !frameAt || Date.now()-frameAt > 10000) return;
  event.preventDefault();
  const factor = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? screen.clientHeight : 1;
  wheelX = Math.max(-2000,Math.min(2000,wheelX+event.deltaX*factor));
  wheelY = Math.max(-2000,Math.min(2000,wheelY+event.deltaY*factor));
  if(wheelTimer === null) wheelTimer = setTimeout(()=>{
    wheelTimer = null; const deltaX=wheelX,deltaY=wheelY; wheelX=0;wheelY=0;
    send({type:'scroll',deltaX,deltaY});
  },20);
},{passive:false});
function key(event,action) {
  if (!live) return; event.preventDefault();
  if (event.repeat) return;
  send({type:'key',action,key:event.key,code:event.code,modifiers:['Shift','Control','Alt','Meta'].filter(name=>event.getModifierState(name))});
}
screen.addEventListener('keydown',event=>key(event,'down'));
screen.addEventListener('keyup',event=>key(event,'up'));
screen.addEventListener('blur',release);
window.addEventListener('blur',release);
window.addEventListener('resize',fitCanvas);
document.addEventListener('fullscreenchange',fitCanvas);
if (typeof ResizeObserver === 'function') new ResizeObserver(fitCanvas).observe(desktop);
window.addEventListener('pagehide',()=>disconnect('Disconnected'));
document.addEventListener('visibilitychange',()=>{if(document.hidden && socket) disconnect('Disconnected while this page was in the background.');});
$('connect').addEventListener('click',connect);
$('disconnect').addEventListener('click',()=>disconnect());
function shortcut(keys) {
  for (const event of keys) if (!send({type:'key',...event})) { release(); return; }
  screen.focus();
}
$('apps').addEventListener('click',()=>shortcut([
  {action:'down',key:'Meta',code:'MetaLeft',modifiers:['Meta']},
  {action:'down',key:' ',code:'Space',modifiers:['Meta']},
  {action:'up',key:' ',code:'Space',modifiers:['Meta']},
  {action:'up',key:'Meta',code:'MetaLeft',modifiers:[]},
]));
for (const [id,key,code] of [['return','Enter','Enter'],['escape','Escape','Escape']]) {
  $(id).addEventListener('click',()=>shortcut([
    {action:'down',key,code,modifiers:[]},{action:'up',key,code,modifiers:[]},
  ]));
}
$('fullscreen').addEventListener('click',async()=>{
  try { if(document.fullscreenElement) await document.exitFullscreen(); else await $('desktop').requestFullscreen(); screen.focus(); }
  catch { status('Full screen is unavailable in this browser'); }
});
$('text-toggle').addEventListener('click',()=>{
  $('text-form').hidden = !$('text-form').hidden;
  $('text-toggle').setAttribute('aria-expanded',String(!$('text-form').hidden));
  if (!$('text-form').hidden) $('text').focus();
});
$('text-form').addEventListener('submit',event=>{
  event.preventDefault(); if(!live || !$('text').value) return;
  if (send({type:'text',text:$('text').value.slice(0,2000)})) { $('text').value = ''; screen.focus(); }
});
setInterval(()=>{
  if(live && frameAt && Date.now()-frameAt>10000) {
    release(); frameAt=0; empty('Waiting for your Mac…','The desktop stream has stopped. Check your Mac or reconnect.'); status('Waiting for desktop frames…');
  }
},2000);
try {
  const config = await (await fetch('./config.json',{cache:'no-store'})).json();
  const url = new URL(config.relayUrl);
  if(url.protocol!=='https:' && !(url.protocol==='http:' && ['localhost','127.0.0.1'].includes(url.hostname))) throw new Error();
  if(config.transport !== undefined && !['http','websocket'].includes(config.transport)) throw new Error();
  transport = config.transport || 'websocket';
  relay = url.origin; await checkHealth(); healthTimer = setInterval(checkHealth,15000);
} catch { status('Desktop connection setup pending'); empty('Desktop connection setup pending','The Mac desktop service has not been connected yet.'); }
