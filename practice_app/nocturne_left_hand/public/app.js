const $ = (id) => document.getElementById(id);
const STORAGE = 'neothesia-nocturne-practice-v1';

// Issue #4 后续阶段「后端适配」：GROUPS 不再是写死的教学示例，而是从真实课程
// 数据加载。默认指向已经存在的《肖邦：夜曲 Op.9 No.2》课程，可以用
// ?course=<id>&from=<小节号>&to=<小节号> 覆盖，方便以后接其它含左手和弦的曲目
// （任务清单里提到的回归测试用《致爱丽丝》就可以用这个参数试）。
const params = new URLSearchParams(location.search);
const COURSE_ID = params.get('course') || 'chopin_nocturne_9_2';
const FROM_MEASURE = Math.max(0, Number(params.get('from')) || 0);
const TO_MEASURE = Math.max(FROM_MEASURE + 1, Number(params.get('to')) || FROM_MEASURE + 8);

const PITCHES=['C','D♭','D','E♭','E','F','G♭','G','A♭','A','B♭','B'];
const CN=['哆','降瑞','瑞','降咪','咪','发','降嗦','嗦','降啦','啦','降西','西'];
const FINGER_NAMES={1:'拇指',2:'食指',3:'中指',4:'无名指',5:'小指'};
const PHASES=['认识和弦 · 摆好手型','先弹低音 · 推荐指落键','松开移手 · 和弦落下','保持手型 · 和弦再弹'];

// 和弦命名规则跟主应用 public/index.html 里的 detectChordName/describeNoteGroup
// 是同一套区间表——这个原型是独立静态页面（没有构建步骤、不能 import 主应用的
// 代码），只能照抄一份，两边改动时要记得保持一致，不要各改各的。
const CHORD_SHAPES=[
  {name:'大三和弦',ivs:[0,4,7]},{name:'小三和弦',ivs:[0,3,7]},{name:'减三和弦',ivs:[0,3,6]},
  {name:'增三和弦',ivs:[0,4,8]},{name:'属七和弦',ivs:[0,4,7,10]},{name:'大七和弦',ivs:[0,4,7,11]},
  {name:'小七和弦',ivs:[0,3,7,10]},{name:'半减七和弦',ivs:[0,3,6,10]},{name:'挂二和弦',ivs:[0,2,7]},
  {name:'挂四和弦',ivs:[0,5,7]},
];
const INTERVAL_NAMES={1:'小二度',2:'大二度',3:'小三度',4:'大三度',5:'纯四度',6:'三全音',7:'纯五度',8:'小六度',9:'大六度',10:'小七度',11:'大七度',12:'八度'};
function detectChordName(pitches){
  const sorted=[...pitches].sort((a,b)=>a-b);
  const classes=[...new Set(sorted.map(p=>((p%12)+12)%12))];
  if(classes.length<3) return '';
  const bassClass=((sorted[0]%12)+12)%12;
  const roots=[bassClass,...classes.filter(c=>c!==bassClass)];
  for(const root of roots){
    const normalized=[...new Set(classes.map(pc=>((pc-root+12)%12)))].sort((a,b)=>a-b).join(',');
    const shape=CHORD_SHAPES.find(s=>[...s.ivs].sort((a,b)=>a-b).join(',')===normalized);
    if(shape) return {root,name:shape.name};
  }
  return null;
}

const state={group:0,phase:0,fingering:0,done:[],tempo:48,pedal:false,loop:false,view:'keyboard'};
let GROUPS=[];
let HAS_PEDAL_DATA=false;
let audioContext, master, playing=false,runId=0,manualPedal=false,activeVoices=new Set(),timers=new Set(),toastTimer;
const group=()=>GROUPS[state.group];
const fingers=()=>group().fingerings[state.fingering]||group().fingerings[0];
const pitch=(n)=>PITCHES[((n%12)+12)%12];
const octave=(n)=>Math.floor(n/12)-1;
const name=(n)=>pitch(n)+octave(n);
const isBlack=(n)=>[1,3,6,8,10].includes(((n%12)+12)%12);
const currentNotes=()=>state.phase===1?[group().bass]:group().notes;
const currentFingers=()=>state.phase===1?[group().bassFinger]:fingers();
const announce=(message)=>{$('toast').textContent=message;$('toast').classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').classList.remove('show'),2600);};
function save(){try{localStorage.setItem(STORAGE,JSON.stringify({group:state.group,phase:state.phase,done:state.done,tempo:state.tempo,pedal:state.pedal}));}catch{$('save-status').textContent='此浏览器未允许保存进度';}}
function restoreSavedState(){
  try{
    const old=JSON.parse(localStorage.getItem(STORAGE)||'null');
    if(!old) return;
    if(Number.isInteger(old.group)&&old.group>=0&&old.group<GROUPS.length) state.group=old.group;
    if(Number.isInteger(old.phase)&&old.phase>=0&&old.phase<4) state.phase=old.phase;
    if(Array.isArray(old.done)) state.done=[...new Set(old.done.filter(n=>Number.isInteger(n)&&n>=0&&n<GROUPS.length))];
    if(Number.isFinite(old.tempo)) state.tempo=Math.max(36,Math.min(80,old.tempo));
    state.pedal=old.pedal===true&&HAS_PEDAL_DATA;
  }catch{}
}
function later(fn,ms){const t=setTimeout(()=>{timers.delete(t);fn();},ms);timers.add(t);return t;}
async function readyAudio(){if(!audioContext){const AC=window.AudioContext||window.webkitAudioContext;if(!AC)throw new Error('浏览器不支持音频');audioContext=new AC();const compressor=audioContext.createDynamicsCompressor();compressor.threshold.value=-18;compressor.ratio.value=4;master=audioContext.createGain();master.gain.value=.58;master.connect(compressor);compressor.connect(audioContext.destination);}if(audioContext.state!=='running')await audioContext.resume();}
function release(voice,when=audioContext.currentTime){if(voice.released)return;voice.released=true;voice.gain.gain.cancelScheduledValues(when);voice.gain.gain.setTargetAtTime(.00001,when,.07);try{voice.osc.stop(when+.5);}catch{}}
function pedalSet(down){manualPedal=down;$('pedal-manual').setAttribute('aria-pressed',String(down));$('pedal-manual').textContent=down?'踏板已踩下 · 点按抬起':'踏板已抬起 · 点按踩下';if(!down&&audioContext){for(const voice of activeVoices)if(voice.keyReleased)release(voice);}}
function playNote(midi,{duration=.65,at=0,velocity=1}={}){const t=audioContext.currentTime+at+.015;const osc=audioContext.createOscillator();const gain=audioContext.createGain();const real=new Float32Array([0,0,0,0,0,0]);const imag=new Float32Array([0,1,.32,.16,.065,.025]);osc.setPeriodicWave(audioContext.createPeriodicWave(real,imag));osc.frequency.value=440*Math.pow(2,(midi-69)/12);const vol=.20*velocity;gain.gain.setValueAtTime(.00001,t);gain.gain.exponentialRampToValueAtTime(vol,t+.012);gain.gain.exponentialRampToValueAtTime(vol*.29,t+.42);gain.gain.exponentialRampToValueAtTime(.0001,t+8);osc.connect(gain);gain.connect(master);const voice={osc,gain,released:false,keyReleased:false};activeVoices.add(voice);osc.onended=()=>{activeVoices.delete(voice);osc.disconnect();gain.disconnect();};osc.start(t);osc.stop(t+9);later(()=>{voice.keyReleased=true;if(!manualPedal)release(voice);},(at+duration)*1000);later(()=>{document.querySelectorAll(`[data-midi="${midi}"]`).forEach(el=>el.classList.add('sounding'));},at*1000);later(()=>{document.querySelectorAll(`[data-midi="${midi}"]`).forEach(el=>el.classList.remove('sounding'));},(at+Math.min(duration,.7))*1000);}
function stopAudio(){runId++;playing=false;for(const t of timers)clearTimeout(t);timers.clear();if(audioContext)for(const voice of activeVoices)release(voice);pedalSet(false);document.querySelectorAll('.sounding').forEach(el=>el.classList.remove('sounding'));$('demo').innerHTML='<svg viewBox="0 0 24 24"><path d="m9 5 10 7-10 7z"/></svg>';$('demo').setAttribute('aria-label','播放本组完整示范');$('demo-label').textContent='听一遍完整动作';$('audio-status').textContent='低音 → 移手 → 和弦';$('pedal-state').textContent='';$('pedal-demo').textContent='▷ 试听踏板连接';}
async function listen(notes,separate=false){stopAudio();const token=runId;try{await readyAudio();if(token!==runId)return;notes.forEach((n,i)=>playNote(n,{at:separate?i*.48:0,duration:1.1}));$('audio-status').textContent=(separate?'依次试听：':'同时试听：')+notes.map(name).join(' · ');}catch{announce('声音暂时无法启动，请再次点击试听。');}}
async function listenOne(note){const wasPedal=manualPedal;if(playing)stopAudio();try{await readyAudio();if(wasPedal)pedalSet(true);playNote(note,{duration:.65});$('audio-status').textContent='正在试听 '+name(note)+(manualPedal?' · 延音踏板已踩下':'');}catch{announce('声音暂时无法启动，请再次点击琴键。');}}
async function demo(pedalOnly=false){if(playing){stopAudio();return;}stopAudio();const token=runId;try{await readyAudio();if(token!==runId)return;}catch{announce('请再次点击，开启浏览器声音。');return;}playing=true;$('demo').innerHTML='<svg viewBox="0 0 24 24"><path d="M8 6h3v12H8zM15 6h3v12h-3z"/></svg>';$('demo').setAttribute('aria-label','停止示范');$('demo-label').textContent='正在示范 · 点击停止';if(pedalOnly)$('pedal-demo').textContent='□ 停止踏板示范';
  const beat=60/state.tempo;const withPedal=pedalOnly||(state.pedal&&HAS_PEDAL_DATA);const thisGroup=group();
  const cycle=()=>{if(token!==runId)return;pedalSet(false);$('audio-status').textContent='1 · 小指弹低音 '+name(thisGroup.bass);if(withPedal)$('pedal-state').textContent='先弹低音，再踩下踏板。';playNote(thisGroup.bass,{duration:beat*.4,velocity:.8});
    if(withPedal)later(()=>{pedalSet(true);$('pedal-state').textContent='踏板踩下 · 松开低音，声音继续。';},beat*180);
    later(()=>{$('audio-status').textContent='2 · 松开旧键，整手移到和弦';thisGroup.notes.forEach(n=>playNote(n,{duration:beat*.58,velocity:.72}));},beat*1000);
    later(()=>{$('audio-status').textContent='3 · 保持手型，再弹一次';thisGroup.notes.forEach(n=>playNote(n,{duration:beat*.58,velocity:.65}));},beat*2000);
    if(withPedal){later(()=>{const nextGroup=GROUPS[(state.group+1)%GROUPS.length];$('audio-status').textContent='4 · 新低音落键，换踏板';playNote(nextGroup.bass,{duration:beat*.55,velocity:.7});$('pedal-state').textContent='新低音落键后，抬起踏板清掉旧和声。';later(()=>pedalSet(false),55);later(()=>{pedalSet(true);$('pedal-state').textContent='随即重新踩下，接住新低音。';},155);},beat*3000);}
    later(()=>{if(token!==runId)return;if(state.loop&&!pedalOnly)cycle();else stopAudio();},beat*(withPedal?4500:3300));};cycle();}
function buildKeyboard(){
  // 键盘范围按真实加载到的音符动态算，别再写死 36-60——夜曲左手实际音域比
  // 原型示例数据宽，写死的话某些组的目标音会落在键盘外，根本按不到。
  const allNotes=GROUPS.flatMap(g=>[g.bass,...g.notes]);
  const lo=Math.min(36,...allNotes)-2;
  const hi=Math.max(60,...allNotes)+2;
  const whites=[];for(let n=lo;n<=hi;n++)if(!isBlack(n))whites.push(n);const count=whites.length;let content='';for(let n=lo;n<=hi;n++){const black=isBlack(n);const pos=black?whites.filter(v=>v<n).length-.31:whites.indexOf(n);content+=`<button class="piano-key ${black?'black':'white'}" data-midi="${n}" style="left:${pos/count*100}%;width:${(black?.62:1)/count*100}%" aria-label="试听 ${name(n)}"><span class="key-note">${name(n)}</span></button>`;}$('keyboard').innerHTML=content;$('keyboard').addEventListener('click',e=>{const key=e.target.closest('[data-midi]');if(key)listenOne(Number(key.dataset.midi));});}
function drawScore(){const notes=currentNotes(),fs=currentFingers(),color=state.phase===1?'#9cbedd':'#c5b1e8';let svg='<svg viewBox="0 0 560 155" role="img" aria-label="当前音组的低音谱号音高对照">';for(let y=40;y<=104;y+=16)svg+=`<path d="M35 ${y}H522" stroke="#596c63" stroke-width="1"/>`;
  svg+='<path d="M51 69c-17-12-13-31 3-31 22 0 20 35-9 52m2-44a4 4 0 1 0 0 .1" stroke="#b6c6b4" stroke-width="2.4" fill="none"/><circle cx="73" cy="48" r="2" fill="#b6c6b4"/><circle cx="73" cy="64" r="2" fill="#b6c6b4"/>';
  const gap=notes.length>1?Math.min(140,420/(notes.length-1)):0;
  notes.forEach((n,i)=>{const letters={C:0,D:1,E:2,F:3,G:4,A:5,B:6};const step=octave(n)*7+letters[pitch(n)[0]];const y=104-(step-(2*7+4))*8;const x=notes.length===1?260:162+i*gap;for(let ledger=120;ledger<=y;ledger+=16)svg+=`<path d="M${x-17} ${ledger}h34" stroke="#83968a"/>`;for(let ledger=24;ledger>=y;ledger-=16)svg+=`<path d="M${x-17} ${ledger}h34" stroke="#83968a"/>`;svg+=`<g class="score-tone" data-midi="${n}" tabindex="0" role="button" aria-label="试听 ${name(n)}"><ellipse cx="${x}" cy="${y}" rx="10" ry="6.5" transform="rotate(-17 ${x} ${y})" fill="${color}"/>${pitch(n).includes('♭')?`<text x="${x-27}" y="${y+5}" font-size="24" fill="${color}">♭</text>`:''}<text x="${x}" y="145" text-anchor="middle" font-family="system-ui" font-size="11" fill="${color}">${name(n)} · ${fs[i]} 指</text></g>`;});svg+='</svg>';$('score').innerHTML=svg;}
function render(){const g=group(),notes=currentNotes(),fs=currentFingers(),bass=state.phase===1,groupCount=GROUPS.length;$('group-label').textContent=`手型 ${String(state.group+1).padStart(2,'0')} / ${String(groupCount).padStart(2,'0')}`;$('chord-symbol').textContent=g.symbol;$('chord-title').textContent=bass?'先找到左手低音':g.title;$('chord-subtitle').textContent=notes.map(name).join(' · ');$('notes-row').innerHTML=notes.map((n,i)=>`<button class="note-card ${bass?'note-bass':''}" data-midi="${n}" aria-label="试听 ${name(n)}，左手 ${fs[i]} 指，${FINGER_NAMES[fs[i]]}"><span class="note-label">${pitch(n)}<sub>${octave(n)}</sub><span class="note-cn">${CN[((n%12)+12)%12]} · ${FINGER_NAMES[fs[i]]}</span></span><span class="finger-circle">${fs[i]}</span></button>`).join('');$('note-caption').textContent=bass?'先弹这一个低音':`${notes.length===2?'两个':notes.length===1?'这一个':'几个'}音，一起按下`;
  for(const key of $('keyboard').children){const n=Number(key.dataset.midi),index=notes.indexOf(n);key.classList.toggle('target',index>=0);key.classList.toggle('bass',bass&&index>=0);key.classList.toggle('ghost',!bass&&n===g.bass);key.innerHTML=(index>=0?`<span class="key-finger">${fs[index]}</span>`:'')+`<span class="key-note">${name(n)}</span>`;key.setAttribute('aria-label',`试听 ${name(n)}${index>=0?`，左手 ${fs[index]} 指`:''}`);}
  const titles=['先把手型放好','先弹一个低音','松开，再移到和弦','保持手型，再弹一次'];const copies=[`看清这${notes.length}个落点，让手自然展开。`,'用推荐指法轻弹低音，给移手留出时间。','眼睛先看下一个落点，手腕放松地带过去。','手的位置不用变，轻轻抬指后再次落键。'];$('coach-title').textContent=titles[state.phase];$('coach-copy').textContent=copies[state.phase];$('phase-count').textContent=`0${state.phase+1} / 04`;
  $('phase-list').innerHTML=PHASES.map((p,i)=>`<li class="${i===state.phase?'active':i<state.phase?'finished':''}"><button data-phase="${i}" ${i===state.phase?'aria-current="step"':''}><span class="phase-num">${i<state.phase?'✓':i+1}</span><span>${p}</span>${i===state.phase?'<span class="phase-state">当前</span>':''}</button></li>`).join('');
  document.querySelectorAll('#hand-svg [data-finger]').forEach(el=>{el.classList.toggle('active',fs.includes(Number(el.dataset.finger)));el.classList.toggle('bass',bass);});
  $('fingering').innerHTML=g.fingerings.map((f,i)=>`<option value="${i}" ${i===state.fingering?'selected':''}>${f.join(' · ')}${i?' · 备选':' · 推荐（自动生成，仅供参考）'}</option>`).join('');$('fingering').disabled=bass;
  const moveTitle=['先找到手型，再连接低音','低音和和弦，分两次弹','同一个小指，先松开、后落键','形状不变，轻轻再弹一次'];$('move-title').textContent=state.phase===2?'从低音移到和弦音':moveTitle[state.phase];$('move-text').textContent=state.phase===0?`把 ${fingers().join('、')} 指轻放在标记琴键上。蓝色空心点是稍后要弹的低音。`:state.phase===1?'先单独练准低音，不需要把手一直撑在低音与和弦之间。':state.phase===2?g.move:'不要重新找键。保持自然的手型，抬起手指后同时弹下。';
  $('next').innerHTML=['手型就位，练低音','低音弹过了，练换位','和弦落下，再弹一次',state.group===groupCount-1?'完成这一轮练习':'这组练过了，下一组'][state.phase]+' <span>→</span>';$('previous').disabled=state.group===0&&state.phase===0;
  $('group-list').innerHTML=GROUPS.map((gr,i)=>`<button class="group-card ${i===state.group?'current':''}" data-group="${i}" ${i===state.group?'aria-current="true"':''} aria-label="练习第 ${i+1} 组：${gr.title}${state.done.includes(i)?'，已手动练习':''}"><span class="group-num">0${i+1}</span><span><strong>${gr.symbol}</strong><small>${gr.hint}</small></span><span class="group-status">${state.done.includes(i)?'✓':i===state.group?'·':''}</span></button>`).join('');$('progress-number').innerHTML=state.done.length+`<span>/ ${groupCount}</span>`;$('session-title').textContent=`今天，从 ${groupCount} 组开始`;$('progress-ring').style.background=`conic-gradient(var(--green) ${state.done.length*100/groupCount}%,#35443d 0%)`;$('progress-caption').textContent=state.done.length?`已手动练习 ${state.done.length} 组`:'手动记录 · 不赶进度';$('journey-status').textContent=state.done.length?`已手动练习 ${state.done.length} / ${groupCount} 组`:`${groupCount} 组手型 · 按自己的节奏`;
  $('tempo').value=state.tempo;$('tempo-value').value=state.tempo;
  $('pedal-toggle').disabled=!HAS_PEDAL_DATA;$('pedal-toggle').setAttribute('aria-checked',String(state.pedal));$('pedal-detail').hidden=!state.pedal;
  $('pedal-badge').textContent=!HAS_PEDAL_DATA?'本曲无踏板数据':state.pedal?'延音连接':'先不加踏板';
  $('pedal-description').textContent=!HAS_PEDAL_DATA?'这段范围的 MIDI 没有记录踏板信息，不编造原曲踏板标记，示范保持关闭。':state.pedal?'示范会在低音落键后踩下，换和声时更换踏板。':'先练准落点，再用延音连接换位。';
  drawScore();centerKeyboard();syncScoringSession();}
function centerKeyboard(){requestAnimationFrame(()=>{const keys=[...$('keyboard').querySelectorAll('.target')];if(!keys.length)return;const center=keys.reduce((v,k)=>v+k.offsetLeft+k.offsetWidth/2,0)/keys.length;const scroll=$('keyboard-scroll');scroll.scrollLeft=Math.max(0,Math.min($('keyboard').offsetWidth-scroll.clientWidth,center-scroll.clientWidth/2));});}
function next(){stopAudio();if(state.phase<3){state.phase++;}else{if(!state.done.includes(state.group))state.done.push(state.group);if(state.group<GROUPS.length-1){state.group++;state.phase=0;state.fingering=0;}else if(state.done.length===GROUPS.length){$('complete-dialog').showModal();}else{state.group=GROUPS.findIndex((_,i)=>!state.done.includes(i));state.phase=0;state.fingering=0;announce('这一组已记下，继续练习尚未完成的手型。');}}save();render();}
function previous(){stopAudio();if(state.phase>0)state.phase--;else if(state.group>0){state.group--;state.phase=3;state.fingering=0;}save();render();}
function reset(){stopAudio();state.group=0;state.phase=0;state.fingering=0;state.done=[];save();render();announce('已开始新一轮慢练。');}
$('notes-row').addEventListener('click',e=>{const note=e.target.closest('[data-midi]');if(note)listenOne(Number(note.dataset.midi));});
$('score').addEventListener('click',e=>{const note=e.target.closest('[data-midi]');if(note)listenOne(Number(note.dataset.midi));});
$('score').addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){const note=e.target.closest('[data-midi]');if(note){e.preventDefault();e.stopPropagation();listenOne(Number(note.dataset.midi));}}});
$('play-separate').onclick=()=>listen(currentNotes(),true);$('play-together').onclick=()=>listen(currentNotes());$('demo').onclick=()=>demo();$('pedal-demo').onclick=()=>demo(true);$('next').onclick=next;$('previous').onclick=previous;
$('loop').onclick=()=>{state.loop=!state.loop;$('loop').setAttribute('aria-pressed',String(state.loop));announce(state.loop?'已开启本组循环。点击停止按钮可随时停下。':'已关闭本组循环。');};
$('tempo').oninput=e=>{state.tempo=Number(e.target.value);$('tempo-value').value=state.tempo;save();if(playing)stopAudio();};
$('fingering').onchange=e=>{stopAudio();state.fingering=Number(e.target.value);render();announce('已同步更新音卡、手型与琴键指法。');};
$('pedal-toggle').onclick=()=>{if(!HAS_PEDAL_DATA)return;stopAudio();state.pedal=!state.pedal;save();render();};
$('pedal-manual').onclick=async()=>{if(playing)stopAudio();try{await readyAudio();pedalSet(!manualPedal);$('pedal-state').textContent=manualPedal?'现在点击琴键：松开后仍延音。再次点击抬起踏板，声音停止。':'旧声音已释放。';}catch{announce('请再次点击，开启浏览器声音。');}};
$('phase-list').onclick=e=>{const b=e.target.closest('[data-phase]');if(!b)return;stopAudio();state.phase=Number(b.dataset.phase);save();render();};
$('group-list').onclick=e=>{const b=e.target.closest('[data-group]');if(!b)return;stopAudio();state.group=Number(b.dataset.group);state.phase=0;state.fingering=0;save();render();};

// ── Web MIDI 真实评分（Issue #4 任务 4）───────────────────────────────────
// 只在"先弹低音"（1）、"和弦落下"（2）、"和弦再弹"（3）这三个真正要弹奏的阶段
// 判分；阶段 0（认识和弦·摆好手型）是看不弹，不接判分。复用仓库已有的
// lib/scoring.js（跟主应用评分页同一份、同一套测试覆盖），每进入一个待判分
// 阶段就用当前目标音开一个只有一个事件的等待模式 session：全部目标音同时
// 按下即算这一阶段弹对，天然支持"和弦允许分先后按下、按住"而不要求同一毫秒
// 到达。没有连 MIDI 设备时"下一步"按钮还是唯一、始终可用的推进方式——判分是
// 叠加上去的加分项，不是新增的门槛，不会把没有电子琴的人挡在练习之外。
const SCORED_PHASES=new Set([1,2,3]);
let midiAccess=null,midiInputs=[],midiStatus='idle';
let scoringKey=null,scoringSession=null;

function scoringNotesForCurrentPhase(){
  return currentNotes().map(n=>({note:n,hand:'left'}));
}

// 阶段没变、只是 MIDI 连接状态变了（比如刚连上/断开）时，也要能刷新这行提示，
// 不能只在"刚进入这个阶段"那一刻算一次——所以单独抽出来，两处都调它。
function idleFeedbackText(){
  // 阶段 0（认识和弦）故意不判分，只是"看"；连着 MIDI 也一样——这里必须给一句
  // 明确提示，否则用户已经连上设备、在这一步按键却毫无反应，会误以为连接没生效。
  if(!SCORED_PHASES.has(state.phase)) return midiStatus==='connected'?'这一步只看不弹，点下一步开始弹低音':'';
  if(midiStatus==='connected') return '🎹 弹对会自动前进';
  if(midiStatus==='no-devices'||midiStatus==='denied'||midiStatus==='unsupported') return '';
  return '未连接 MIDI 键盘 · 弹完请手动点下一步';
}

function syncScoringSession(){
  if(!SCORED_PHASES.has(state.phase)){
    scoringKey=null;scoringSession=null;
    $('play-feedback').textContent=idleFeedbackText();
    return;
  }
  const key=`${state.group}:${state.phase}`;
  if(scoringKey===key) return;
  scoringKey=key;
  scoringSession=window.PracticeScoring.createWaitModeSession([{notes:scoringNotesForCurrentPhase()}]);
  $('play-feedback').textContent=idleFeedbackText();
}

function updateMidiStatusLabel(){
  const labels={idle:'未连接 · 手动推进',requesting:'请求授权中…',unsupported:'此浏览器不支持 Web MIDI，仍可手动推进',denied:'授权被拒绝，仍可手动推进','no-devices':'没有找到 MIDI 设备，仍可手动推进',connected:'已连接 · 弹对自动前进'};
  $('midi-status').textContent=labels[midiStatus]||midiStatus;
  $('midi-connect').textContent=midiStatus==='connected'?'🎹 已连接':'🎹 连接 MIDI 键盘';
  $('midi-connect').disabled=midiStatus==='requesting';
  $('play-feedback').textContent=idleFeedbackText();
}

function bindMidiInputs(inputs){
  const nextInputs=inputs.filter(input=>input.state!=='disconnected');
  for(const input of midiInputs) if(!nextInputs.includes(input)) input.onmidimessage=null;
  midiInputs=nextInputs;
  for(const input of nextInputs) input.onmidimessage=handleMidiMessage;
  midiStatus=nextInputs.length?'connected':'no-devices';
  updateMidiStatusLabel();
  syncScoringSession();
}

async function connectMidi(){
  if(!navigator.requestMIDIAccess){midiStatus='unsupported';updateMidiStatusLabel();return;}
  midiStatus='requesting';updateMidiStatusLabel();
  try{
    const access=await navigator.requestMIDIAccess({sysex:false});
    midiAccess=access;
    const inputs=[...access.inputs.values()];
    access.onstatechange=()=>{
      const current=[...access.inputs.values()];
      if(current.length) bindMidiInputs(current);
      else if(midiInputs.length){midiStatus='no-devices';updateMidiStatusLabel();}
    };
    if(!inputs.length){midiStatus='no-devices';updateMidiStatusLabel();return;}
    bindMidiInputs(inputs);
  }catch(e){midiStatus='denied';updateMidiStatusLabel();}
}

// 独立于判分逻辑之外、任何时候收到 Note On 都会更新的"收到信号"提示——不看
// scoringSession 是否存在。这是特意加的诊断信息：如果用户反馈"显示已连接但按键
// 没反应"，这行文字能立刻分辨是"消息根本没送到浏览器"（这行也不会变，说明是
// 设备/驱动/浏览器权限问题，不是这个页面的代码问题）还是"消息收到了，只是没有
// 判分"（这行会变，多半是当前这一步（阶段0"认识和弦"）本来就不判分，或者弹的
// 音跟目标音不一致）。
function reportMidiActivity(pitch){
  $('midi-activity').textContent=`🎵 刚收到：${name(pitch)}（${pitch}）`;
}

function handleMidiMessage(e){
  const [status,data1,data2]=e.data;
  const command=status&0xf0;
  if(command===0x90&&data2>0) reportMidiActivity(data1);
  if(!scoringSession) return;
  if(command===0x90&&data2>0){
    const before=scoringSession.getResult().extraNotes;
    scoringSession.noteOn(data1);
    const result=scoringSession.getResult();
    if(result.isComplete){
      $('play-feedback').textContent='✓ 弹对了！';
      later(()=>next(),350);
    }else if(result.extraNotes>before){
      $('play-feedback').textContent='✗ 弹错了，再试一次';
    }
  }else if(command===0x80||(command===0x90&&data2===0)){
    scoringSession.noteOff(data1);
  }
}

$('midi-connect').onclick=connectMidi;
updateMidiStatusLabel();
function setView(view){state.view=view;for(const v of ['keyboard','score']){$('view-'+v).classList.toggle('selected',v===view);$('view-'+v).setAttribute('aria-selected',String(v===view));$(v+'-view').hidden=v!==view;}$('view-hint').textContent=view==='keyboard'?'与真实琴键一一对应':'保持音高，不压缩整曲';if(view==='keyboard')centerKeyboard();}
$('view-keyboard').onclick=()=>setView('keyboard');$('view-score').onclick=()=>setView('score');
$('help').onclick=()=>{stopAudio();$('help-dialog').showModal();};
document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>b.closest('dialog').close());
$('restart').onclick=reset;$('practice-again').onclick=()=>{$('complete-dialog').close();reset();};
document.addEventListener('keydown',e=>{if(e.key==='Escape'){stopAudio();return;}if(e.altKey||e.ctrlKey||e.metaKey||e.repeat||document.querySelector('dialog[open]')||/INPUT|SELECT|TEXTAREA|BUTTON|A/.test(e.target.tagName))return;if(e.code==='Space'){e.preventDefault();demo();}else if(e.key==='ArrowRight'){e.preventDefault();next();}else if(e.key==='ArrowLeft'){e.preventDefault();previous();}else if(['1','2','3'].includes(e.key)){const n=currentNotes()[Number(e.key)-1];if(n!==undefined)listenOne(n);}});
document.addEventListener('visibilitychange',()=>{if(document.hidden)stopAudio();});window.addEventListener('pagehide',stopAudio);window.addEventListener('resize',centerKeyboard);

// ── 真实数据接入（Issue #4 任务 1：接入真实课程数据 / 任务 2 的指法部分）──────
// 把 practice-data 接口返回的、已经按 onset 分组的左手事件，两两配对成
// "低音 → 和弦" 的手型组：夜曲左手是标准的 oom-pah 伴奏型（先弹一个低音，
// 再弹一组和弦），MIDI 里这两步天生就是两个相邻但不同时刻的独立事件，
// 不是同一个事件里的和弦，所以不能直接把每个事件当一组——要识别"单音后面
// 跟着一个多音和弦"这个真实存在的模式，配对失败（比如连续两个单音、或者
// 和弦前面没有单独的低音）时退化成"该和弦自己的最低音当低音"，不假装有一个
// 实际不存在的独立低音动作。
function pairEventsIntoGroups(events){
  const groups=[];
  for(let i=0;i<events.length;i++){
    const cur=events[i];
    const nxt=events[i+1];
    if(cur.notes.length===1&&nxt&&nxt.notes.length>=2){
      groups.push({bassEvent:cur,chordEvent:nxt});
      i++; // 消费掉这两个事件
    }else{
      const chordEvent=cur.notes.length>=1?cur:null;
      if(!chordEvent) continue;
      const sorted=[...chordEvent.notes].sort((a,b)=>a.note-b.note);
      groups.push({bassEvent:{notes:[sorted[0]]},chordEvent:{notes:sorted}});
    }
  }
  return groups;
}

function buildGroupFromPair(pair,prevGroup){
  const bassNote=pair.bassEvent.notes[0];
  const chordNotes=[...pair.chordEvent.notes].sort((a,b)=>a.note-b.note);
  const pitches=chordNotes.map(n=>n.note);
  let symbol=pitch(bassNote.note),title;
  if(pitches.length>=3){
    const detected=detectChordName(pitches);
    // 大字母符号必须跟识别出的和弦根音一致——夜曲左手经常是转位（低音不是根音，
    // 比如 B♭3·E♭4·G4 实际是降E大三和弦的第一转位），不能直接拿低音音名当符号，
    // 那样会和下面 title 里真正识别出的和弦名对不上。
    if(detected){symbol=PITCHES[detected.root];title=`${symbol} ${detected.name}`;if(/七/.test(detected.name))symbol+='7';}
    else title=`${pitches.length} 音和弦（真实谱例，未匹配到标准和弦名）`;
  }else if(pitches.length===2){
    const span=Math.abs(pitches[1]-pitches[0]);
    title=`双音骨架 · ${INTERVAL_NAMES[Math.min(span,12)]||span+'半音'}`;
  }else{
    title='单音';
  }
  const hint=pitches.length>=3?(title.includes('未匹配')?'和弦 · 真实谱例':'三音和弦 · 真实谱例'):pitches.length===2?'双音骨架 · 真实谱例':'单音 · 真实谱例';
  const fingersReal=chordNotes.map(n=>Number.isInteger(n.finger)?n.finger:1);
  const bassFinger=Number.isInteger(bassNote.finger)?bassNote.finger:5;
  const move=!prevGroup
    ?`把 ${fingersReal.join('、')} 指轻放在标记琴键上，先熟悉这一个手型。`
    :(()=>{const distance=bassNote.note-prevGroup.bass;const dir=distance===0?'':(distance>0?'向右移':'向左移');
      return distance===0
        ?`低音停在同一个键 ${name(bassNote.note)} 上，松开后原位置再落键，再让 ${fingersReal.join('、')} 指落到和弦。`
        :`小指从 ${name(prevGroup.bass)} ${dir}到 ${name(bassNote.note)}，整只手跟着移动，再一起落下 ${fingersReal.join('、')} 指。`;})();
  return {
    symbol,title,notes:pitches,bass:bassNote.note,bassFinger,
    fingerings:[fingersReal],hint,move,
    fingerSource:chordNotes[0]?.fingerSource||'generated',
  };
}

function showLoadError(message){
  $('chord-title').textContent='数据加载失败';
  $('chord-subtitle').textContent=message;
  $('coach-title').textContent='暂时无法开始练习';
  $('coach-copy').textContent='请确认 practice_app 服务器正在运行，且课程 ID/小节范围正确，然后刷新页面重试。';
  document.querySelectorAll('.practice-toolbar button,.transport button,.journey button').forEach(b=>b.disabled=true);
}

async function loadRealGroups(){
  const courseRes=await fetch(`/api/courses/${encodeURIComponent(COURSE_ID)}`);
  if(!courseRes.ok) throw new Error(`课程 ${COURSE_ID} 不存在或服务器出错（HTTP ${courseRes.status}）`);
  const {course}=await courseRes.json();
  const lastMeasure=Math.min(TO_MEASURE,course.measure_count);
  if(FROM_MEASURE>=lastMeasure) throw new Error(`小节范围 ${FROM_MEASURE}-${TO_MEASURE} 超出了这首曲子的 ${course.measure_count} 小节`);

  const events=[];
  let hasPedal=false;
  for(let m=FROM_MEASURE;m<lastMeasure;m++){
    const res=await fetch(`/api/courses/${encodeURIComponent(COURSE_ID)}/measures/${m}/practice-data?hand_mode=left`);
    if(!res.ok) continue; // 单个小节请求失败不阻断整体加载，跳过继续拼后面的小节
    const data=await res.json();
    if(data.hasPedalData) hasPedal=true;
    for(const event of data.events) if(event.notes.length) events.push(event);
  }
  if(!events.length) throw new Error(`第 ${FROM_MEASURE+1}-${lastMeasure} 小节没有左手音符事件`);

  const pairs=pairEventsIntoGroups(events);
  const groups=[];
  for(const pair of pairs) groups.push(buildGroupFromPair(pair,groups[groups.length-1]));
  return {groups,hasPedal,course};
}

async function init(){
  try{
    const {groups,hasPedal,course}=await loadRealGroups();
    GROUPS=groups;
    HAS_PEDAL_DATA=hasPedal;
    restoreSavedState();
    $('piece-subtitle-real').textContent=`${course.title} · 第 ${FROM_MEASURE+1}-${Math.min(TO_MEASURE,course.measure_count)} 小节 · 真实课程数据`;
  }catch(e){
    showLoadError(e.message);
    return;
  }
  buildKeyboard();render();
}
init();
