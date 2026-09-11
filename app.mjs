import {UUID, STATE_LABELS, RESULT_LABELS, FrameAssembler, CompletionTracker, decodeSnapshot, restartCommand} from './protocol.mjs';
import {createRenderer} from './renderer.mjs';
const $ = id => document.getElementById(id);
const assembler = new FrameAssembler(), completion = new CompletionTracker();
let device, commandCharacteristic, notificationCharacteristic, snapshot;
let session = 0, busy = false, lastReceived = 0, pending, audioContext;
let nextId = 1, displayAngle = 0, stale = false;
let sliderDirty = false;
const colors = ['#75d7c8', '#ffc56e'];
const renderer = createRenderer($('hourglass'), mode => $('render-mode').textContent = mode);
const supported = window.isSecureContext && Boolean(navigator.bluetooth);
if (!supported) {
  $('connect').disabled = true;
  $('message').textContent = window.isSecureContext
    ? '이 브라우저는 Web Bluetooth를 지원하지 않습니다. Windows의 Chrome/Edge에서 열어주세요.'
    : '블루투스 연결에는 HTTPS가 필요합니다. 교사가 제공한 HTTPS 주소로 열어주세요.';
}
function message(text) { $('message').textContent = text; }
function controls() {
  $('connect').disabled = !supported || busy || Boolean(device?.gatt?.connected);
  $('disconnect').disabled = !device?.gatt?.connected;
  $('restart').disabled = !commandCharacteristic || !snapshot || stale || Boolean(pending) || ![1,2,3].includes(snapshot.state);
}
async function enableAudio() {
  audioContext ??= new (window.AudioContext || window.webkitAudioContext)();
  if (audioContext.state !== 'running') await audioContext.resume();
}
function chime() {
  if (!audioContext || audioContext.state !== 'running') return;
  for (let i = 0; i < 3; i++) {
    const oscillator = audioContext.createOscillator(), gain = audioContext.createGain();
    const start = audioContext.currentTime + i * .23;
    oscillator.frequency.value = 1050 + i * 230;
    gain.gain.setValueAtTime(0, start);gain.gain.linearRampToValueAtTime(.12,start+.01);
    gain.gain.exponentialRampToValueAtTime(.001,start+.14);
    oscillator.connect(gain);gain.connect(audioContext.destination);
    oscillator.start(start);oscillator.stop(start+.15);
    oscillator.onended = () => {oscillator.disconnect();gain.disconnect();};
  }
}
function accept(value) {
  if (stale) completion.reset();
  if (!sliderDirty) { $('minutes').value = value.duration / 60; updateSlider(); }
  snapshot = value;lastReceived = performance.now();stale = false;
  if (completion.accept(value) && $('sound').checked && !document.hidden) chime();
  $('connection').textContent = '연결됨';$('connection').classList.add('live');
  $('state').textContent = STATE_LABELS[value.state];
  $('duration').textContent = `${value.duration / 60}분`;
  $('elapsed').textContent = `${Math.floor(value.elapsed / 60000)}분 ${Math.floor(value.elapsed / 1000) % 60}초`;
  $('grains').textContent = `${value.upper} / ${value.lower}알`;
  $('angle').textContent = value.plane < .12 ? '평면 방향 측정 어려움' : `${Math.round(Math.atan2(value.gx,value.gy)*180/Math.PI)}°`;
  if (pending && value.ack === pending.id) {
    clearTimeout(pending.timer);
    message(value.result === 0 ? (value.duration === pending.minutes * 60
      ? `${value.duration / 60}분으로 새로 시작했습니다.`
      : '장치의 적용 시간이 요청과 다릅니다. 적용된 기준 시간을 확인하세요.')
      : (value.result === 1 ? '시간 설정을 지원하지 않습니다. 최신 HourglassCore를 복사하고 BLE 펌웨어를 다시 업로드하세요.' : (RESULT_LABELS[value.result] ?? '명령 적용 실패')));
    pending = undefined;
  }
  controls();
}
function receive(event) {
  try {const frame = assembler.push(event.target.value);if (frame) accept(frame);}
  catch (error) {message(error.message);}
}
function cleanup() {
  session++;
  notificationCharacteristic?.removeEventListener('characteristicvaluechanged',receive);
  notificationCharacteristic = commandCharacteristic = undefined;
  assembler.reset();completion.reset();
  if (pending) {clearTimeout(pending.timer);pending=undefined;}
  busy=false;stale=true;
  $('connection').textContent='연결 끊김';$('connection').classList.remove('live');
  $('state').textContent='마지막 수신 화면 · 연결 끊김';controls();
}
function disconnected() {cleanup();message('연결이 끊겼습니다. 실물은 계속 동작합니다. 다시 연결하면 현재 상태를 가져옵니다.');}
$('connect').addEventListener('click', async () => {
  const token=++session;busy=true;controls();message('기기 선택창에서 Hourglass 이름을 선택하세요.');
  // Invoke both permission-sensitive APIs directly from the click gesture.
  if ($('sound').checked) enableAudio().catch(()=>message('소리 테스트 버튼으로 오디오를 활성화하세요.'));
  let chosen;
  try {
    chosen=await navigator.bluetooth.requestDevice({filters:[{services:[UUID.service]}]});
    if(token!==session) return;
    device?.removeEventListener('gattserverdisconnected',disconnected);device=chosen;
    device.addEventListener('gattserverdisconnected',disconnected);
    const server=await device.gatt.connect();
    if(token!==session) {device.gatt.disconnect();return;}
    const service=await server.getPrimaryService(UUID.service);
    const state=await service.getCharacteristic(UUID.state);
    commandCharacteristic=await service.getCharacteristic(UUID.command);
    notificationCharacteristic=await service.getCharacteristic(UUID.stream);
    if(token!==session) return;
    assembler.reset();completion.reset();snapshot=undefined;stale=false;
    notificationCharacteristic.addEventListener('characteristicvaluechanged',receive);
    await notificationCharacteristic.startNotifications();
    const initial=await state.readValue();
    if(token!==session) return;
    if(!snapshot) accept(decodeSnapshot(initial)); // never replace a newer notification with a stale read
    nextId=((snapshot.ack+1)&0xffff)||1;
    $('device').textContent=device.name||'내 모래시계';
    message('현재 상태를 가져왔습니다. 시간 선택만으로는 실행이 초기화되지 않습니다.');
  } catch(error) {
    if(token!==session) return;
    chosen?.gatt?.disconnect();cleanup();
    message(error.name==='NotFoundError'?'기기 선택을 취소했거나 기기를 찾지 못했습니다. 전원과 BLE 예제를 확인하세요.':`연결 실패: ${error.message}`);
  } finally {if(token===session) {busy=false;controls();}}
});
$('disconnect').addEventListener('click',()=>{device?.gatt?.disconnect();});
$('restart').addEventListener('click', async () => {
  if(!commandCharacteristic||pending||stale) return;
  const id=nextId;nextId=(nextId%65535)+1;
  pending={id,minutes:Number($('minutes').value),timer:setTimeout(()=>{
    if(pending?.id===id) {pending=undefined;message('적용 확인을 받지 못했습니다. 현재 상태를 확인한 뒤 다시 시도하세요.');controls();}
  },3000)};
  controls();message('모래시계에 설정을 보내고 있습니다…');
  try {await commandCharacteristic.writeValueWithResponse(restartCommand(id,pending.minutes));}
  catch(error) {if(pending?.id===id){clearTimeout(pending.timer);pending=undefined;message(`설정 전송 실패: ${error.message}`);controls();}}
});
$('test-sound').addEventListener('click',async()=>{try{await enableAudio();chime();}catch(error){message(`오디오를 시작할 수 없습니다: ${error.message}`);}});
$('sound').addEventListener('change',()=>{if($('sound').checked)enableAudio().catch(()=>message('소리 테스트 버튼을 눌러주세요.'));});
document.addEventListener('visibilitychange',()=>{if(!document.hidden){completion.reset();stale=true;assembler.reset();controls();}});

function draw() {
  if(snapshot&&device?.gatt?.connected&&performance.now()-lastReceived>1000&&!stale) {
    stale=true;completion.reset();$('connection').textContent='수신 지연';$('connection').classList.remove('live');
    $('state').textContent='새 상태를 기다리는 중';controls();
  }
  if(snapshot&&!stale&&snapshot.plane>=.12) {
    const target=Math.atan2(snapshot.gx,snapshot.gy);
    const diff=Math.atan2(Math.sin(target-displayAngle),Math.cos(target-displayAngle));
    displayAngle+=diff*(matchMedia('(prefers-reduced-motion: reduce)').matches?1:.22);
  }
  renderer.draw({snapshot,stale,angle:displayAngle,colors,time:performance.now(),
    reduced:matchMedia('(prefers-reduced-motion: reduce)').matches});
  requestAnimationFrame(draw);
}
function updateSlider() {
  const minutes = Number($('minutes').value);
  $('selected-time').innerHTML = String(minutes).padStart(2,'0') + '<span> MIN</span>';
  $('minutes').setAttribute('aria-valuetext', minutes + '분');
}
$('minutes').addEventListener('input',()=>{sliderDirty=true;updateSlider();});
for(const [module,index] of [['upper',1],['lower',0]]) {
  const picker=$(module+'-color'), palette=document.querySelector('[data-module="'+module+'"]');
  try { const saved=localStorage.getItem('hourglass-color-'+module);if(/^#[0-9a-f]{6}$/i.test(saved))colors[index]=saved; } catch {}
  picker.value=colors[index];
  const update=()=>{
    colors[index]=picker.value;
    try {localStorage.setItem('hourglass-color-'+module,picker.value);} catch {}
    for(const button of palette.children)button.setAttribute('aria-pressed',String(button.dataset.color===picker.value));
  };
  for(const [name,color] of [['빨강','#ff6b62'],['초록','#86d785'],['파랑','#79b6ff'],['호박색','#ffc56e'],['민트','#75d7c8']]) {
    const button=document.createElement('button');button.type='button';button.dataset.color=color;
    button.style.setProperty('--swatch',color);button.setAttribute('aria-label',(index?'위':'아래')+' 모듈 '+name);
    button.addEventListener('click',()=>{picker.value=color;update();});palette.append(button);
  }
  picker.addEventListener('input',update);update();
}
updateSlider();
controls();
draw();
