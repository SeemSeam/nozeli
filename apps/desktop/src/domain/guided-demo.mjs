// Shared offline tutorial catalog and semantic transport; no DOM or native runtime.
// One guided project, six learning sections. Every explanation follows a real visible action.
const lesson=(section,rows)=>rows.map(([id,caption,hintTitle,hintDetail,semantic,relPath])=>({id,section,caption,hintTitle,hintDetail,semantic,readMs:Math.max(6500,Math.min(12000,2500+hintDetail.length*85)),...(relPath?{relPath}:{})}));
export const demoChapters = [{id:'learn',title:'Nozeli 入门教学',steps:[
 ...lesson('01 · 认识工作台',[
  ['map-project','认识项目入口','先认识你所在的项目','左侧项目入口切换本地项目。现在是专用教学副本，接下来的编辑不会改动你的材料。','ui.map-project'],
  ['map-files','认识文件导航','从文件树找到材料','左侧文件树浏览目录，上方快速打开用于查找文件。先认清入口，下一节再打开 Markdown。','ui.map-files'],
  ['map-workspace','认识中央工作区','阅读、编辑与成果共用一个工作区','中央是主要工作面：文件、报告和差异都在这里查看。关闭内容后会回到空工作台。','ui.map-workspace'],
  ['map-conversation','认识对话入口','对话用于提问与明确交接','现在打开项目对话。输入问题后明确发送才调用 AI；本教学只使用标注的离线回复，不登录账号。','ui.map-conversation'],
  ['map-todos','认识工作与待办','工作看进展，待办做决定','右侧工作目录告诉你在做什么；待办承接问题与成果。看到报告不等于已经接受修改。','ui.map-todos'],
 ]),
 ...lesson('02 · 从 Markdown 开始',[
  ['open-notes','打开研究笔记.md','先打开一份有结构的材料','我们围绕同一份 Markdown 笔记学习。标题、段落与表格组织研究问题，不再从纯文本样本开始。','open','research-notes.md'],
  ['md-preview','阅读 Markdown 排版','切换阅读视图看清结构','这是真实 Markdown 预览。阅读与编辑是同一份材料的两种视图，不需要复制正文到另一个工具。','md-preview','research-notes.md'],
  ['human-edit','亲自编辑并保存','先学会自己动手修改','在笔记中补一句说明并保存。这是本地编辑，不需要启动 Agent，也不会生成待审核任务。','human-edit','research-notes.md'],
 ]),
 ...lesson('03 · 批注与就地讨论',[
  ['local-note','保存原文批注','记下想法，不等于发送任务','在 Markdown 原文位置保存一条备注。批注留在本地；只有明确发送，才把材料交给 Agent。','point-note','research-notes.md'],
  ['discuss-create','从选区创建问题','把“这里”变成明确的讨论来源','选中文字创建讨论草稿。先核对引用内容和位置，再发送；不用反复解释是哪份文档的哪一段。','discussion-create','research-notes.md'],
  ['discuss-send','明确发送讨论','发送后再出现回复','本步发送当前标签引用，回复来自离线教学源。实际使用时，你的模型会读取明确交接的材料。','discussion-send','research-notes.md'],
  ['discuss-followup','在标签内继续追问','同一位置，连续讨论','继续追问时保留原标签和上下文。新回复不替换你先前保存的问题与批注。','discussion-send','research-notes.md'],
  ['open-image','打开观测示意图','图像也能成为讨论材料','需要指出图上位置时，打开示意图。下一步用画笔表达问题，而不是只写“这里不对”。','open','methods.png'],
  ['draw-region','框选画面并涂鸦','用标记说明图上哪里','框选并画出关注区域，再保存笔迹。区域、原图与笔迹共同保留位置，保存本身不启动 AI。','drawing','methods.png'],
 ]),
 ...lesson('04 · 从任务到审核闭环',[
  ['frontdesk-ask','回到项目对话','简单问题先直接交流','项目对话适合快速提问；需要持续整理的工作再明确交接到后台。下面演示同一项方法核查任务。','frontdesk-ask'],
  ['task-a','交接方法核查任务','提交之后，仍可以继续阅读','教学模拟提交一项后台工作。提交不代表完成；实际后台结果还需要报告、核对和你的决定。','task-a'],
  ['task-a-done','查看成果待办','成果已交付，审核还未完成','示例成果进入待办。这里展示的是离线教学状态，不是假装启动了真实 Worker。','task-a-done'],
  ['review-open','阅读成果报告','先看结论、依据和验证边界','打开报告，先理解结论及其来源，再检查文件差异。不要仅凭“完成”二字接受结果。','report'],
  ['view-source','打开 Markdown 对照','核对修改前的依据','方法说明以 Markdown 保留修改前版本。下一步进入现有工作区 Diff，比较前后文本。','open','comparison-before.md'],
  ['view-diff','在统一工作区查看 Diff','修改在哪里，一眼可核对','左右对比 Markdown 的修改前后，增删位置高亮。报告和文档共用这一套差异查看系统。','diff','comparison-before.md'],
  ['review-continue','补充要求，继续修改','继续：原任务保留，交回修改','示例中提出补充要求。继续修改不代表接受、不结束原任务；你仍掌握最终决定。','decision-continue'],
  ['review-accept','接受示例成果','接受之后才完成这一轮闭环','现在明确接受教学成果，示例待办完成。真实 Worker 候选只有经明确接受才会由宿主安全合入。','decision-accept'],
 ]),
 ...lesson('05 · 分屏与独立窗口',[
  ['layout-source','回到研究笔记','需要对照时再调整布局','回到一直使用的 Markdown 笔记。接下来将材料与对话并排，而不是在空白界面演示复杂布局。','open','research-notes.md'],
  ['split','并排放置材料与对话','分屏：减少来回切换','通过布局将材料与项目对话并排。实际使用也可以拖动标签到分区边缘，按需要调整大小。','split'],
  ['detach','脱离为独立窗口','把一个内容面移到另一块屏幕','将笔记脱离为原生独立窗口。这里移动的是原内容，并非复制文档或另开一份会话。','detach'],
  ['dock','返回主工作区','回来后继续原来的现场','独立窗口移回主工作区，保留原文、批注和编辑现场。学会返回，比只学会弹出更重要。','dock'],
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
    const view=Object.values(groups.snapshot().views).find(view=>view.kind==='document'&&view.relPath==='research-notes.md')??Object.values(groups.snapshot().views).find(view=>view.kind==='document');
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
