import assert from 'node:assert/strict';
import {staticReport} from './static-report.fixture.mjs';

export const recordedBugTask='我需要制作一个混沌系统的html演示';
export const chaosDemoHtml=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>混沌系统 · Lorenz 演示</title><style>body{font:16px system-ui;margin:32px;color:#182235;background:#f5f7fb}h1{font-size:26px}canvas{display:block;background:white;border:1px solid #ccd3de;max-width:100%;margin:20px 0}button,input{font:inherit;margin-right:12px}output{font-variant-numeric:tabular-nums}</style><h1>混沌系统：Lorenz 吸引子</h1><p>两个初始条件仅相差 0.00001 的轨迹，在同一确定性系统中逐渐分离。σ=10，β=8/3。</p><label>ρ <input id="rho" type="range" min="20" max="35" step="0.1" value="28"><output id="rhoValue">28</output></label><button id="pause">暂停</button><button id="reset">重新开始</button><canvas width="900" height="480" id="plot"></canvas><output id="steps">0</output><script>
const canvas=document.getElementById('plot'),ctx=canvas.getContext('2d'),rho=document.getElementById('rho');let a=[0.1,0,0],b=[0.10001,0,0],steps=0,playing=true;
function advance(p){const[x,y,z]=p,r=Number(rho.value),dt=.004;return[x+10*(y-x)*dt,y+(x*(r-z)-y)*dt,z+(x*y-8*z/3)*dt]}
function point(p){return[450+p[0]*12,470-p[2]*9]}
function clear(){ctx.clearRect(0,0,900,480);a=[.1,0,0];b=[.10001,0,0];steps=0;document.getElementById('steps').textContent='0'}
function frame(){if(playing){for(let i=0;i<20;i++){for(const pair of [[a,'#3158bc'],[b,'#c04d38']]){const old=point(pair[0]),next=advance(pair[0]),end=point(next);ctx.strokeStyle=pair[1];ctx.beginPath();ctx.moveTo(...old);ctx.lineTo(...end);ctx.stroke();if(pair[0]===a)a=next;else b=next;}steps++;}document.getElementById('steps').textContent=String(steps);}requestAnimationFrame(frame)}
document.getElementById('pause').onclick=()=>{playing=!playing;document.getElementById('pause').textContent=playing?'暂停':'继续'};document.getElementById('reset').onclick=clear;rho.oninput=()=>{document.getElementById('rhoValue').textContent=rho.value;clear()};frame();
</script></html>`;
const text=value=>typeof value==='string'?value:(value??[]).map(part=>part.text??'').join('\n');
const call=(id,tool,args)=>({id,tool,args});
// Replays the exact original user input and tool arguments. Only the expected
// responses change after the source fix: no host fault or DEBUG workaround.
export function recordedBugScenario(){
 const state={intakeRequests:0,debugRequests:0,workerRequests:0,receipts:[],nativeInputs:{}};
 const receipt=(request,id)=>{const row=request.messages.findLast(m=>m.role==='tool');assert(row,'native tool receipt required');assert.equal(row.tool_call_id,id);const value=JSON.parse(text(row.content));state.receipts.push({id,value});assert.notEqual(value.ok,false,JSON.stringify(value));return value.value??value;};
 state.handler=async request=>{
  const names=request.tools?.map(tool=>tool.function?.name)??[];
  const lastUser=text(request.messages.findLast(m=>m.role==='user')?.content);
  if(lastUser.includes('系统内部 DEBUG')){state.debugRequests++;throw Error('The fixed optional parameters unexpectedly required DEBUG');}
  if(names.includes('nozeli_publish')){
   const n=state.workerRequests++,users=request.messages.filter(m=>m.role==='user').length;
   if(state.nativeInputs.worker==null)state.nativeInputs.worker=users;else assert.equal(users,state.nativeInputs.worker,'no replay/supplementary Worker prompt');
   if(n===0)return call('fixed-worker-write','write',{path:'chaos-demo.html',content:chaosDemoHtml});
   if(n===1){const written=request.messages.findLast(m=>m.role==='tool');assert.equal(written?.tool_call_id,'fixed-worker-write');assert.notEqual(written.isError,true);return call('fixed-worker-publish','nozeli_publish',{kind:'result',content:staticReport('已生成离线 Lorenz 混沌系统 HTML 演示：chaos-demo.html，可调参数、暂停与重新开始。原空参数序列在源码修复后直接完成正常派工，无需 Debug 兜底；成果等待用户审核。'),files:['chaos-demo.html']});}
   throw Error('Unexpected Worker replay after publication');
  }
  const n=state.intakeRequests++;
  if(n<3){if(n>0){const value=receipt(request,'fixed-empty-cursor-'+(n-1));assert.equal(value.board.total,0);assert.deepEqual(value.board.rows,[]);}return call('fixed-empty-cursor-'+n,'nozeli_inspect_work',{workName:'@state',cursor:''});}
  if(n===3){const value=receipt(request,'fixed-empty-cursor-2');assert.equal(value.board.total,0);return call('fixed-board-status','nozeli_manage',{action:'status',expectedRevision:0,text:'',workId:''});}
  if(n===4){const value=receipt(request,'fixed-board-status');assert.deepEqual(value.facts.works,[]);return call('fixed-empty-brief','nozeli_dispatch',{name:'混沌系统 HTML 演示',brief:''});}
  throw Error('Original intake prompt was unexpectedly replayed');
 };
 return state;
}
