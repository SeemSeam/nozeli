// Shared offline tutorial catalog and semantic transport; no DOM or native runtime.
// One guided project, six learning sections. Every explanation follows a real visible action.
const lesson=(section,rows)=>rows.map(([id,caption,hintTitle,hintDetail,semantic,relPath])=>({id,section,caption,hintTitle,hintDetail,semantic,readMs:Math.max(6500,Math.min(12000,2500+hintDetail.length*85)),...(relPath?{relPath}:{})}));
export const demoChapters = [{id:'learn',title:'Nozeli 入门教学',steps:[
 ...lesson('01 · 认识工作台',[
  ['map-project','认识项目入口','先认识你所在的项目','左侧项目入口切换本地项目。现在是专用教学副本，接下来的编辑不会改动你的材料。','ui.map-project'],
  ['map-files','认识文件导航','从文件树找到材料','用左侧文件树浏览目录，也可以搜索文件名或内容。下一节会打开一份 Markdown 笔记。','ui.map-files'],
  ['map-workspace','认识中央工作区','阅读、编辑与成果共用一个工作区','中央是主要工作面：文件、报告和差异都在这里查看。关闭内容后会回到空工作台。','ui.map-workspace'],
  ['map-conversation','认识对话入口','对话用于提问与明确交接','现在打开项目对话。输入问题后明确发送才调用 AI；本教学只使用标注的离线回复，不登录账号。','ui.map-conversation'],
  ['map-todos','认识工作与待办','工作看进展，待办做决定','右侧工作目录告诉你在做什么；待办承接问题与成果。看到报告不等于已经接受修改。','ui.map-todos'],
 ]),
 ...lesson('02 · 从 Markdown 开始',[
  ['open-notes','打开研究笔记.md','先打开一份有结构的材料','我们围绕同一份 Markdown 笔记学习。标题、段落与表格组织研究问题，不再从纯文本样本开始。','open','research-notes.md'],
  ['md-preview','打开 Markdown 实时预览','边写边看排版','这是实际 Markdown 实时预览，和正在编辑的是同一份材料。','md-preview','research-notes.md'],
  ['human-edit','演示编辑并保存','本地编辑无需派工','演示在笔记中补一句说明并保存。不启动 Agent，也不会产生待审核任务。','human-edit','research-notes.md'],
 ]),
 ...lesson('03 · 批注与就地讨论',[
  ['local-note','保存原文批注','记下想法，不等于发送任务','在 Markdown 原文位置保存一条备注。批注留在本地；只有明确发送，才把材料交给 Agent。','point-note','research-notes.md'],
  ['discuss-create','从选区创建问题','把“这里”变成明确的讨论来源','选中文字创建讨论草稿。先核对引用内容和位置，再发送；不用反复解释是哪份文档的哪一段。','discussion-create','research-notes.md'],
  ['discuss-send','明确发送讨论','发送后再出现回复','本步发送当前标签引用，回复来自离线教学源。实际使用时，你的模型会读取明确交接的材料。','discussion-send','research-notes.md'],
  ['discuss-followup','在标签内继续追问','同一位置，连续讨论','在同一标签追问为什么仍要检查样本量。新回复不替换原问题或批注。','discussion-followup','research-notes.md'],
  ['open-image','打开观测示意图','图像也能成为讨论材料','需要指出图上位置时，打开示意图。下一步用画笔表达问题，而不是只写“这里不对”。','open','methods.png'],
  ['draw-region','框选画面并涂鸦','用标记说明图上哪里','框选并画出关注区域，再保存笔迹。区域、原图与笔迹共同保留位置，保存本身不启动 AI。','drawing','methods.png'],
 ]),
 ...lesson('04 · 从任务到审核闭环',[
  ['frontdesk-ask','回到项目对话','简单问题先直接交流','普通发送交给前台；需要在后台持续处理的要求，可以用同一输入区的「后台任务」。两种动作都需明确触发。','frontdesk-ask'],
  ['task-a','从输入区提交后台任务','用「后台任务」提交','现在提交一项离线方法核查。演示不会启动真实 Worker 或连接模型。','task-submit'],
  ['task-a-done','查看第一版成果待办','有了报告，尚未采纳','同一任务交付 V1。成果待办是审核入口，不是修改已经应用的凭据。','task-a-done'],
  ['review-open','打开 V1 报告','先看结论、依据和验证边界','从成果待办打开第一版报告，再核对它所绑定的文件差异。','report'],
  ['view-diff','查看 V1 冻结交付 Diff','核对本次交付，而非当前文件','这里比较冻结输入和 V1 候选；不会用当前工作区的文件替换基线。','diff'],
  ['review-continue','在报告中追加讨论','向原任务明确发送返工意见','打开「追加讨论」并发送补充要求。只打开讨论或留下草稿不会发送，也不等于采纳。','decision-continue'],
  ['task-a-revised','查看同一任务的 V2','新交付不是新任务','离线示例为原任务交付 V2，V1 留作只读历史。','task-a-revised'],
  ['review-revised','打开 V2 报告','确认正在审核的是第二版','从最新成果入口打开同一任务的 V2，先核对结论。','report-revised'],
  ['view-diff-revised','复核 V2 冻结交付 Diff','确认补充要求已经反映在候选中','仍用同一条冻结基线比较；这次看到的是 V2 候选，不是 V1 或人工草稿。','diff'],
  ['review-accept','采纳并结束示例任务','核对版本后再采纳','本次只记录离线 V2 的演示决定，不会把真实修改合入你的项目。真实任务还有应用完成或受阻的回执。','decision-accept'],
 ]),
 ...lesson('05 · 分屏与独立窗口',[
  ['layout-source','回到研究笔记','需要对照时再调整布局','回到一直使用的 Markdown 笔记。接下来将材料与对话并排，而不是在空白界面演示复杂布局。','open','research-notes.md'],
  ['split','并排放置材料与对话','分屏：减少来回切换','在分区标题的「更多操作」选「向右拆分」，也可以把分区标题拖到边缘。这里将笔记与项目对话并排。','split'],
  ['detach','脱离为独立窗口','把一个内容面移到另一块屏幕','点击笔记分区标题栏的「独立窗口」。移动的是原内容，不是复制文档或另开会话。','detach'],
  ['dock','返回主工作区','回来后继续原来的现场','点击笔记独立窗口的「返回主工作区」，回嵌同一份笔记，保留批注和编辑现场。','dock'],
 ]),
 ...lesson('06 · 更多材料与自己的项目',[
  ['open-pdf','阅读参考 PDF','同一工作台继续阅读论文','PDF 支持真实页面阅读、缩放和选区。它是主线材料的补充，不会把讨论与项目割裂。','open','paper.pdf'],
  ['pdf-page','翻页查看参考内容','页面与批注位置相互对应','翻到第二页。阅读位置与原文绑定；扫描内容可使用区域讨论，而不是假装存在文字。','pdf-page','paper.pdf'],
  ['open-docx','查看 Word 材料','按材料选择合适的编辑器','DOCX 使用原生文档驱动。不同格式的支持范围不同，不承诺任意 Office 内容都能无损编辑。','open','manuscript.docx'],
  ['open-pptx','查看演示文稿','幻灯片也在同一项目中','PPTX 画布与文档共用材料工作流。这里仅展示打开后的真实画面，不增加另一套任务流程。','open','presentation.pptx'],
  ['settings-tour','认识模型设置','准备好后再配置自己的 AI','设置中管理连接账号和默认模型。教学不替你登录、不保存凭据；不配置模型也可本地阅读编辑。','ui.settings'],
  ['finish','结束教学并返回','从你自己的 Markdown 开始','你已经认识界面、完成批注讨论和成果审核，并学会分屏与窗口返回。示例与编辑保留，马上回到教学前的工作区。','ui.finish'],
 ]),
]}];

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
    const view=Object.values(groups.snapshot().views).find(view=>view.kind==='document'&&view.relPath==='research-notes.md');
    if(!view)throw Error('研究笔记未打开，不能脱离其他文档');
    await groups.command({type:'floatOpen',viewId:view.id});current();
  }else if(semantic==='dock'){
    const layout=groups.snapshot(),note=Object.values(layout.views).find(view=>view.kind==='document'&&view.relPath==='research-notes.md');
    const contains=(node,id)=>node.kind==='group'?node.views.includes(id):contains(node.first,id)||contains(node.second,id);
    const detached=note&&layout.detached.find(window=>contains(window.root,note.id));
    if(!detached)throw Error('研究笔记的独立窗口已不在原位置');
    await groups.command({type:'dock',windowId:detached.id});current();
  }else throw Error('未知布局动作');
  return {layout:groups.snapshot()};
}
export const demoSteps=demoChapters[0].steps;
const chapterIds=new Set(demoChapters.map(chapter=>chapter.id));
export const isDemoChapterId=value=>chapterIds.has(value);

export function demoIdentity(session){return {projectId:session.projectId,sessionId:session.id??session.sessionId,epoch:session.epoch};}
export const demoCommands={open:'file.open','point-note':'annotation.point','pdf-page':'pdf.page',drawing:'drawing.stroke','discussion-create':'annotation.discuss','discussion-send':'discussion.send','discussion-followup':'discussion.send','frontdesk-ask':'conversation.ask','text-edit':'document.edit','human-edit':'document.edit','diff':'diff.open','md-preview':'md.preview','task-submit':'notification.show','task-a':'notification.show','task-b':'notification.show',progress:'notification.show','task-a-done':'notification.show','task-a-revised':'notification.show','task-b-done':'notification.show',report:'report.open','report-revised':'report.open','decision-continue':'notification.show','decision-accept':'notification.show','decision-discard':'notification.show',split:'workspace.split',detach:'workspace.detach',dock:'workspace.dock'};
export function unwrapDemo(result){if(!result?.ok)throw Object.assign(Error(result?.error?.message||'演示操作未完成'),{code:result?.error?.code});return result.value;}
export function createDemoActions({invoke}){
  return async function runAction(session,step){
    return unwrapDemo(await invoke('demo.perform',{...demoIdentity(session),chapterId:session.chapterId,stepIndex:session.stepIndex,command:demoCommands[step.semantic],args:{semantic:step.semantic,stepId:step.id},relPath:step.relPath}));
  };
}
