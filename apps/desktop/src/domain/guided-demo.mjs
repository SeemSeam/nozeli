// Shared offline tutorial catalog and semantic transport; no DOM or native runtime.
// One continuous learning flow: no chapter picks, each step carries its own big hint.
export const demoChapters = [
  {id:'learn',title:'演示学习',steps:[
    ['open-notes','打开研究笔记','欢迎来到 Nozeli','这是专用的演示项目；所有回复都是离线演示内容，不需要账号。结束后会自动移出演示、回到这里。','open','research-notes.txt'],
    ['local-note','保存一条本地批注','本地批注不派工','在原文位置保存备注不会启动 AI；只有显式发送才把材料交给 Agent。','point-note','research-notes.txt'],
    ['open-pdf','打开 PDF','真实的多页阅读','PDF 用真实驱动打开：可选中文字、缩放、翻页，阅读位置绑定原文。','open','paper.pdf'],
    ['pdf-page','翻到第二页','选区与位置始终对应原文','无论怎么缩放，选区和位置讨论都指向原始页面坐标。','pdf-page','paper.pdf'],
    ['open-image','打开示意图','图片也是一等材料','打开方法示意图，下一步在图上直接标注疑问。','open','methods.png'],
    ['draw-region','图上涂鸦','涂鸦指明“图上哪里”','在图片区域画笔标注；笔迹与原图共享位置，随材料一起冻结发送。','drawing','methods.png'],
    ['discuss-create','选区发起讨论','标签讨论：带着位置提问','选中文字发起讨论，先生成草稿；引文和位置自动附上，不需要自己描述“第几页哪一段”。','discussion-create','research-notes.txt'],
    ['discuss-send','显式发送','发送时冻结材料','发送那一刻冻结选区引文与涂鸦图片；回复来自离线演示源，明确标注。','discussion-send','research-notes.txt'],
    ['discuss-followup','标签内续聊','同一个标签继续追问','在紧凑标签里继续追问，上下文与位置保留，不另开会话。','discussion-send','research-notes.txt'],
    ['frontdesk-ask','前台快速问答','前台＝快问快答','轻量问题直接在前台问，立即得到回答；前台不占用后台任务额度。','frontdesk-ask'],
    ['agent-edit','Agent 提出修改','Agent 的修改必须经你审核','Agent 给出一段修改建议（演示固定内容）；它不会静默改你的文档。','text-edit','research-notes.txt'],
    ['view-source','打开修改前的原文','先看原文','先打开修改前的对照文本，下一步并排比较差异。','open','comparison-before.txt'],
    ['view-diff','查看修改前后','并排对比真实文本','打开差异视图，逐行核对修改前后；这一步与真实项目的 diff 完全相同。','diff','comparison-before.txt'],
    ['human-edit','你也亲自编辑','人＋Agent 共同编辑','接受修改后，你再亲自补一句：你的编辑与 Agent 的修改在同一文档共存、互不覆盖。','human-edit','research-notes.txt'],
    ['open-md','打开 Markdown','Markdown 实时预览','正文改动实时反映到预览；源码与预览一键切换。','open','README.md'],
    ['md-preview','切换到预览','所改即所见','切换到预览视图，刚才的说明立刻以排版呈现。','md-preview','README.md'],
    ['open-tex','打开 TeX','TeX 同样支持','TeX 以真实驱动打开、可编辑可编译；本演示环境若未配置 TeX 工具链，则展示源码并如实说明，不假装编译。','open','sample.tex'],
    ['open-docx','打开 Word','DOCX 真实驱动','Word 文档直接打开：可阅读、批注、编辑并保存。','open','manuscript.docx'],
    ['open-pptx','打开幻灯片','PPTX 快速展示','幻灯片用真实驱动翻页，画布点位同样可以发起讨论。','open','presentation.pptx'],
    ['task-a','提交后台任务 A','后台：整块工作交给 Agent','把“数据整理”整块交给后台；提交后你不必等待，可以继续阅读。','task-a'],
    ['task-b','再提交任务 B','后台可以多任务并发','紧接着提交第二个任务；两个后台任务并行推进，前台依然随时可问。','task-b'],
    ['task-progress','查看并行进展','进展都显示在对话里','两个任务的阶段进展依次进入对话时间线；完成后各自进入待办，等你审核。','progress'],
    ['task-a-done','任务 A 完成','完成的任务进入待办','任务 A 交付成果并生成待办；注意：到这一步任务还没有结束。','task-a-done'],
    ['review-open','打开审核报告','审核：任务只有闭环才结束','打开任务 A 的审核报告：结论、依据、修改清单与流程示意。看完不代表接受，“稍后处理”也不会结束任务。','report'],
    ['review-continue','决定：继续','“继续”＝提要求，任务保持打开','先选择继续：补充一条要求让 Agent 完善；任务保持打开，不会悄悄结束。','decision-continue'],
    ['review-accept','决定：接受','“接受”＝修改合入，任务闭环','接受后示例修改合入、任务 A 闭环结束。任务必须经过你的审核决定才算完成。','decision-accept'],
    ['task-b-done','任务 B 完成','另一个任务也在等你','任务 B 的成果同样进入待办；用另一种决定演示闭环。','task-b-done'],
    ['review-discard','决定：丢弃','“丢弃”＝保留原文，拒绝修改','丢弃保留原文、不采纳修改，任务 B 同样闭环结束。三条路：接受／继续／丢弃，都由你决定。','decision-discard'],
    ['split','分屏对照','分屏：阅读与成果并排','把工作面拆分：左边原文、右边报告，同一项目内对照。','split'],
    ['detach','拖出独立窗口','独立窗口跨屏工作','把一个内容面拖成独立原生窗口，可放到另一块屏幕。','detach'],
    ['dock','移回主窗口','移回不复制会话','独立窗口移回主窗，同一内容面、同一会话，没有复制。','dock'],
    ['settings-tour','打开设置','配置你自己的 AI','在“AI 连接与账号”里添加源并登录；在“默认模型”里按 快／强／中 配置档位（例如 GPT 系列的轻量／标准／高阶）。演示不会代你登录或保存凭据。','ui.settings'],
    ['finish','完成学习','演示完成','示例项目与你的编辑都会保留。即将自动退出，回到你点击演示之前的工作面。','ui.finish'],
  ].map(([id,caption,hintTitle,hintDetail,semantic,relPath])=>({id,caption,hintTitle,hintDetail,semantic,...(relPath?{relPath}:{})}))},
];

// One accepted layout operation may settle after pause, never in another project.
export async function runDemoLayout(groups,projectId,semantic){
  if(!groups)throw Error('此动作需要项目主工作区');
  const current=()=>{if(groups.snapshot()?.projectId!==projectId)throw Object.assign(Error('原布局项目已切换'),{code:'DEMO_SCOPE_CHANGED'});};
  current();
  if(semantic==='split'){
    await groups.command({type:'split',groupId:groups.activeGroup(),axis:'x',side:'after'});current();
    const root=groups.snapshot().mainRoot;
    if(root.kind==='split'){
      await groups.command({type:'resize',splitId:root.id,ratio:.56});current();
      const findEmpty=node=>node.kind==='group'?(!node.activeViewId?node:null):findEmpty(node.first)||findEmpty(node.second),empty=findEmpty(groups.snapshot().mainRoot);
      if(!empty)throw Error('分屏后没有可打开参考材料的分区');
      await groups.command({type:'open',groupId:empty.id,view:{kind:'conversation'}});
    }
  }else if(semantic==='detach'){
    const view=Object.values(groups.snapshot().views).find(view=>view.kind==='document'&&view.relPath==='research-notes.txt')??Object.values(groups.snapshot().views).find(view=>view.kind==='document');
    if(!view)throw Error('没有可以脱离的文档内容面');
    await groups.command({type:'floatOpen',viewId:view.id});
  }else if(semantic==='dock'){
    const detached=groups.snapshot().detached.at(-1);if(!detached)throw Error('没有可返回的独立窗口');
    await groups.command({type:'dock',windowId:detached.id});
  }else throw Error('未知布局动作');
  return {layout:groups.snapshot()};
}
export const demoSteps=demoChapters[0].steps;
const chapterIds=new Set(demoChapters.map(chapter=>chapter.id));
export const isDemoChapterId=value=>chapterIds.has(value);

export function demoIdentity(session){return {projectId:session.projectId,sessionId:session.id??session.sessionId,epoch:session.epoch};}
export const demoCommands={open:'file.open','point-note':'annotation.point','pdf-page':'pdf.page',drawing:'drawing.stroke','discussion-create':'annotation.discuss','discussion-send':'discussion.send','frontdesk-ask':'conversation.ask','text-edit':'document.edit','human-edit':'document.edit','diff':'diff.open','md-preview':'md.preview','task-a':'notification.show','task-b':'notification.show',progress:'notification.show','task-a-done':'notification.show','task-b-done':'notification.show',report:'report.open','decision-continue':'notification.show','decision-accept':'notification.show','decision-discard':'notification.show',split:'workspace.split',detach:'workspace.detach',dock:'workspace.dock'};
export function unwrapDemo(result){if(!result?.ok)throw Object.assign(Error(result?.error?.message||'演示操作未完成'),{code:result?.error?.code});return result.value;}
export function createDemoActions({invoke}){
  return async function runAction(session,step){
    return unwrapDemo(await invoke('demo.perform',{...demoIdentity(session),chapterId:session.chapterId,stepIndex:session.stepIndex,command:demoCommands[step.semantic],args:{semantic:step.semantic,stepId:step.id},relPath:step.relPath}));
  };
}
