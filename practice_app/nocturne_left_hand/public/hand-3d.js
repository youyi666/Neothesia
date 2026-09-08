import * as THREE from 'three';
import { GLTFLoader } from './vendor/GLTFLoader.js';

const $ = id => document.getElementById(id);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(36,1,.001,10);
const renderer = new THREE.WebGLRenderer({antialias:true,alpha:true});
renderer.setPixelRatio(Math.min(devicePixelRatio,2));
renderer.shadowMap.enabled=true;
renderer.shadowMap.type=THREE.PCFSoftShadowMap;
renderer.outputColorSpace=THREE.SRGBColorSpace;
renderer.toneMapping=THREE.ACESFilmicToneMapping;
$('stage').append(renderer.domElement);
scene.add(new THREE.HemisphereLight(0xfff3df,0x586a65,2.4));
const light=new THREE.DirectionalLight(0xffefd8,3.5);
light.position.set(-.2,.45,.15);light.castShadow=true;
light.shadow.mapSize.set(2048,2048);
Object.assign(light.shadow.camera,{left:-.3,right:.3,top:.3,bottom:-.3,near:.01,far:2});
light.shadow.bias=-.0001;scene.add(light);
const rim=new THREE.DirectionalLight(0xdbeeff,1.8);rim.position.set(.3,.15,-.3);scene.add(rim);
const keys=[];
const keyWidth=.0235;
function box(w,h,d,color,x,y,z){const m=new THREE.Mesh(new THREE.BoxGeometry(w,h,d),new THREE.MeshStandardMaterial({color,roughness:.4}));m.position.set(x,y,z);m.castShadow=true;m.receiveShadow=true;scene.add(m);return m;}
box(.30,.028,.21,0x28342f,0,-.026,-.035);
for(let i=0;i<9;i++){
 const key=box(keyWidth-.001,.012,.15,0xf9f4e8,(i-4)*keyWidth,-.006,-.03);keys.push(key);
 if([0,2,3,5,6,7].includes(i))box(.012,.013,.085,0x242824,(i-3.5)*keyWidth,.0065,-.0625);
}
const targetKeys=keys.slice(2,7);
function setView(side=false){camera.position.set(side?.30:.12,side?.13:.37,side?.16:.30);camera.lookAt(0,.012,-.025);}
setView();let side=false;
$('view').onclick=()=>{side=!side;setView(side);$('view').textContent=side?'手背视角':'侧面观察';};
new ResizeObserver(()=>{const r=$('stage').getBoundingClientRect();renderer.setSize(r.width,r.height);camera.aspect=r.width/r.height;camera.updateProjectionMatrix();}).observe($('stage'));

let rig,chains=[],rest=[],ready=false,running=false,started=0,period=2.8,audio,lastSound=-1;
const prefixes=['thumb','index-finger','middle-finger','ring-finger','pinky-finger'];
const positions=[];
const V=THREE.Vector3;
const ease=t=>{t=THREE.MathUtils.clamp(t,0,1);return t*t*(3-2*t);};
function pose(finger=-1,amount=0){
 for(let f=0;f<chains.length;f++)for(let j=0;j<chains[f].length;j++){
   const bone=chains[f][j],saved=rest[f][j];
   const angle=(j===0?.12:.22)+(f===finger?amount:0)*(j===0?.20:.12);
   bone.quaternion.copy(saved.q).multiply(new THREE.Quaternion().setFromAxisAngle(saved.axis,-angle));
 }
 rig.updateMatrixWorld(true);
}
try{
 const gltf=await new GLTFLoader().loadAsync('./vendor/right.glb');
 rig=gltf.scene;
 const armature=rig.getObjectByName('Armature');
 rig.updateMatrixWorld(true);
 // WebXR joints are siblings in this asset. Attach them into anatomical
 // chains while preserving their bind transforms and skinning matrices.
 for(const prefix of prefixes){
   const names=prefix==='thumb'?['metacarpal','phalanx-proximal','phalanx-distal','tip']:['metacarpal','phalanx-proximal','phalanx-intermediate','phalanx-distal','tip'];
   const bones=names.map(s=>rig.getObjectByName(`${prefix}-${s}`));
   for(let j=1;j<bones.length;j++)bones[j-1].attach(bones[j]);
   chains.push(bones.slice(1,-1));
   rest.push(bones.slice(1,-1).map(b=>({q:b.quaternion.clone(),axis:new V(0,0,1).applyQuaternion(b.getWorldQuaternion(new THREE.Quaternion()).invert()).normalize()})));
 }
 const rotation=new THREE.Matrix4().set(0,0,1,0,1,0,0,0,0,1,0,0,0,0,0,1);
 rig.quaternion.setFromRotationMatrix(rotation);
 rig.traverse(obj=>{if(obj.isMesh){obj.material=new THREE.MeshPhysicalMaterial({color:0xd6a589,roughness:.64,metalness:0,clearcoat:.08});obj.castShadow=true;obj.receiveShadow=true;obj.frustumCulled=false;}});
 scene.add(rig);pose();
 for(let f=0;f<5;f++){
   pose(f,1);
   const tip=rig.getObjectByName(`${prefixes[f]}-tip`).getWorldPosition(new V());
   // Whole-hand translation aligns the contact; bone lengths remain fixed.
   positions.push(new V(targetKeys[f].position.x-tip.x,.004-tip.y,-.005-tip.z));
 }
 pose();rig.position.copy(positions[0]).add(new V(0,.012,0));ready=true;
 $('play').disabled=false;$('reset').disabled=false;$('play').textContent='播放五音示范';$('status').textContent='模型已就位 · 点击播放';
}catch(error){$('status').textContent=`模型加载失败：${error.message}`;console.error(error);}

function stop(){running=false;lastSound=-1;$('play').textContent='播放五音示范';targetKeys.forEach(k=>{k.position.y=-.006;k.material.color.set(0xf9f4e8);});}
$('reset').onclick=()=>{stop();pose();rig.position.copy(positions[0]).add(new V(0,.012,0));$('status').textContent='准备手型';};
$('play').onclick=async()=>{if(running){stop();$('status').textContent='已停止';return;}audio ||= new AudioContext();await audio.resume();period=Number($('speed').value);started=audio.currentTime;lastSound=-1;running=true;$('play').textContent='停止示范';};
function sound(f){const now=audio.currentTime,osc=audio.createOscillator(),gain=audio.createGain();osc.type='triangle';osc.frequency.value=440*2**(([60,62,64,65,67][f]-69)/12);gain.gain.setValueAtTime(0,now);gain.gain.linearRampToValueAtTime(.12,now+.02);gain.gain.exponentialRampToValueAtTime(.001,now+.7);osc.connect(gain).connect(audio.destination);osc.start();osc.stop(now+.75);}
renderer.setAnimationLoop(()=>{
 if(ready&&running){
   const elapsed=audio.currentTime-started,index=Math.floor(elapsed/period),phase=(elapsed%period)/period;
   if(index>=5){stop();$('status').textContent='五音示范完成 · 可切换视角再次观看';}
   else{
     const down=ease((phase-.32)/.15)*(1-ease((phase-.67)/.17));
     const moving=ease(phase/.30),from=positions[Math.max(0,index-1)],to=positions[index];
     rig.position.lerpVectors(from,to,moving);rig.position.y+=(1-down)*.012+Math.sin(Math.PI*moving)*.014;
     pose(index,down);
     targetKeys.forEach((key,f)=>{key.position.y=-.006-(f===index?.002*down:0);key.material.color.set(f===index&&down>.7?0xe5c88e:0xf9f4e8);});
     if(phase>.46&&lastSound!==index){sound(index);lastSound=index;}
     $('status').textContent=`${index+1}/5 · ${['C','D','E','F','G'][index]} · ${phase<.32?'抬手移位':phase<.67?'缓慢落指':'抬指释放'}`;
     [...$('notes').children].forEach((el,i)=>el.classList.toggle('active',i===index));
   }
 }
 renderer.render(scene,camera);
});
document.addEventListener('visibilitychange',()=>{if(document.hidden)stop();});
