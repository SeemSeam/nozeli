// Test-only renderer telemetry. rAF denotes a paint opportunity, not physical display latency.
export async function installBookingFluencyObserver(page) {
 await page.evaluate(() => {
  if (window.__bookingFluency) throw Error('Booking observer already installed');
  const data={version:2,observerInstanceId:crypto.randomUUID(),projectId:window.__workspaceScope?.projectId,viewId:window.__workspaceScope?.viewId,timeOrigin:performance.timeOrigin,startedAt:Date.now(),inputs:[],frames:[],longtasks:[],bodies:[],visibility:[],errors:[],environment:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio,theme:document.documentElement.dataset.theme,font:getComputedStyle(document.querySelector('#composer')).fontSize,userAgent:navigator.userAgent}};
  const visible=()=>document.visibilityState==='visible'&&document.hasFocus();
  const epoch=()=>performance.timeOrigin+performance.now();
  let last=null,segment=0,raf,dead=false,visibleSince=visible()?epoch():null;const intervals=[];
  const frame=t=>{if(dead)return;if(visible()){if(last!==null)data.frames.push({at:performance.timeOrigin+t,ms:t-last,segment});last=t;}else last=null;raf=requestAnimationFrame(frame);};raf=requestAnimationFrame(frame);
  const transition=()=>{const at=epoch();if(visibleSince!==null)intervals.push({start:visibleSince,end:at});visibleSince=visible()?at:null;last=null;segment++;data.visibility.push({at,visible:visible()});};
  document.addEventListener('visibilitychange',transition);
  window.addEventListener('blur',transition);window.addEventListener('focus',transition);
  const paint=fn=>requestAnimationFrame(()=>requestAnimationFrame(()=>{if(visible())fn(epoch());}));
  document.addEventListener('input',event=>{if(event.target.id!=='composer'||!visible())return;const at=epoch(),length=event.target.value.length,target=document.querySelector('#conversation-panel')?.dataset.managedConversation;paint(paintedAt=>data.inputs.push({at,paintedAt,ms:paintedAt-at,length,target,trusted:event.isTrusted}));},true);
  let long;
  try{if(!PerformanceObserver.supportedEntryTypes.includes('longtask'))throw Error('longtask unsupported');long=new PerformanceObserver(list=>{for(const e of list.getEntries()){const at=performance.timeOrigin+e.startTime,end=at+e.duration;if(intervals.some(i=>at>=i.start&&end<=i.end)||(visibleSince!==null&&at>=visibleSince&&visible()))data.longtasks.push({at,ms:e.duration,segment});}});long.observe({type:'longtask',buffered:false});}catch(error){data.errors.push(error.message);}
  const signatures=new Map();
  const mutation=new MutationObserver(()=>{if(!visible())return;for(const node of document.querySelectorAll('.session-message:not([data-role="user"])')){const body=node.querySelector(':scope > .session-content > .session-markdown, :scope > .session-content > .session-plain');if(!body)continue;const id=node.dataset.message,text=body.innerText;if(!text.trim()||text==='本轮尚无正文回复。'||signatures.get(id)===text)continue;signatures.set(id,text);const at=epoch(),streaming=Boolean(node.querySelector('header [role="status"]'));paint(paintedAt=>data.bodies.push({id,at,paintedAt,characters:text.length,streaming,role:node.dataset.role}));}});mutation.observe(document.querySelector('#conversation'),{childList:true,subtree:true,characterData:true});
  window.__bookingFluency={data,alive:()=>!dead&&Boolean(raf)&&Boolean(long),snapshot:()=>structuredClone(data),stop:()=>{dead=true;cancelAnimationFrame(raf);long?.disconnect();mutation.disconnect();}};
 });
}
export function summarizeBookingFluency(data,controls) {
 const p95=rows=>rows.length?[...rows].sort((a,b)=>a-b)[Math.ceil(rows.length*.95)-1]:null;
 const input=data.inputs.filter(r=>r.trusted),framePauses=data.frames.filter(r=>r.ms>200),localControls=controls.filter(r=>r.category!=='project-transition'),transitions=controls.filter(r=>r.category==='project-transition');
 return {scope:'Visible focused renderer only; double-rAF paint opportunities, not physical display timestamps. Project transitions include asynchronous persistence and connection work, not local feedback latency.',input:{count:input.length,p95:p95(input.map(r=>r.ms)),over250:input.filter(r=>r.ms>250)},controls:{count:localControls.length,p95:p95(localControls.map(r=>r.ms))},projectTransitions:{count:transitions.length,p95:p95(transitions.map(r=>r.ms)),localFeedback:'Not independently observed; do not infer responsive feedback from completion.'},frames:{count:data.frames.length,over200:framePauses},longtasks:data.longtasks,thresholds:{inputP95:100,controlP95:150,ipcToVisible:500},failed:(input.length>0&&p95(input.map(r=>r.ms))>100)||input.filter(r=>r.ms>250).length>1||(localControls.length>0&&p95(localControls.map(r=>r.ms))>150)||framePauses.length>1};
}
