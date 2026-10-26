// Shared offline tutorial catalog and semantic transport; no DOM or native runtime.
export const demoChapters = [
  {id:'intro',title:'进入项目',steps:[['open-notes','打开研究笔记，文件属于独立的演示副本。','open','research-notes.txt']]},
  {id:'reading',title:'阅读与编辑',steps:[['edit-open','切换到真实文本编辑器。','open','research-notes.txt'],['edit-save','输入示例记录并自动保存到示例文件。','text-edit','research-notes.txt']]},
  {id:'anchors',title:'位置与选区',steps:[['anchor-open','打开位置备注来源。','open','research-notes.txt'],['point-menu','没有选区时，位置备注不会派工。','point-note','research-notes.txt'],['select-explain','选取原文后显式解释，回复来自离线演示源。','selection-explain','research-notes.txt']]},
  {id:'discussion',title:'紧凑标签续聊',steps:[['discuss-file','打开讨论来源。','open','research-notes.txt'],['discuss-open','选区讨论先建立草稿，不自动发送。','discussion-create','research-notes.txt'],['discuss-send','显式发送后收到一条标明来源的演示回复。','discussion-send','research-notes.txt'],['discuss-followup','在同一标签续问，然后收起并重新展开。','discussion-followup','research-notes.txt']]},
  {id:'pdf',title:'PDF 阅读',steps:[['pdf-open','打开真正的多页 PDF。','open','paper.pdf'],['pdf-page','翻到第二页，缩放仍使用原 PDF 驱动。','pdf-page','paper.pdf'],['pdf-select','选择 PDF 原文并解释。','pdf-selection','paper.pdf']]},
  {id:'image',title:'图片与涂鸦',steps:[['image-open','打开本地图片，标注绑定原始像素。','open','methods.png'],['image-point','在图片位置保存本地备注。','image-note','methods.png'],['image-draw','在真实区域画笔中绘制并保存笔迹；发送仍需显式操作。','drawing','methods.png'],['image-send','明确发送带冻结图片和笔迹的讨论材料。','drawing-send','methods.png']]},
  {id:'ppt',title:'幻灯片',steps:[['ppt-open','通过 PPTX 驱动打开幻灯片。','open','presentation.pptx'],['ppt-point','画布点位讨论不同于文字选区。','ppt-note','presentation.pptx']]},
  {id:'word',title:'Word 文档',steps:[['word-open','通过 DOCX 驱动阅读文档。','open','manuscript.docx'],['word-edit','编辑并保存真实 Word 内容。','word-edit','manuscript.docx']]},
  {id:'sheet',title:'电子表格',steps:[['sheet-open','通过 XLSX 驱动查看测量数据。','open','measurements.xlsx'],['sheet-edit','修改一个示例单元格并保存，不演示未支持的公式能力。','sheet-edit','measurements.xlsx']]},
  {id:'workspace',title:'分屏与独立窗口',steps:[['workspace-open','在工作面打开研究笔记。','open','research-notes.txt'],['workspace-split','分屏并打开项目原对话；调整比例不复制会话。','split'],['workspace-detach','将同一内容面移到独立原生窗口。','detach'],['workspace-dock','把原内容面返回主窗口，不复制会话。','dock']]},
  {id:'results',title:'通知与成果',steps:[['result-notice','展开演示提醒并进入正常报告处理面；没有真实 Worker。','notification'],['result-report','阅读明确标注来源的冻结 HTML 报告。','report'],['result-before','打开待比较的真实文本。','open','comparison-before.txt'],['result-diff','查看真实前后文本差异。','diff','comparison-before.txt'],['result-decision','回到原报告操作区，明确接受演示结论；不改变真实任务。','decision']]},
  {id:'finish',title:'结束与清理',steps:[['finish-review','演示结束默认保留文件。可返回原工作面，或亲自进入项目清理。','summary']]},
].map(chapter=>({...chapter,steps:chapter.steps.map(([id,caption,semantic,relPath])=>({id,caption,semantic,...(relPath?{relPath}:{})}))}));

export function demoIdentity(session){return {projectId:session.projectId,sessionId:session.id??session.sessionId,epoch:session.epoch};}
export const demoCommands={open:'file.open','text-edit':'document.edit','point-note':'annotation.point','selection-explain':'annotation.selection','discussion-create':'annotation.discuss','discussion-send':'discussion.send','discussion-followup':'discussion.send','pdf-page':'pdf.page','pdf-selection':'document.select','image-note':'annotation.point',drawing:'drawing.stroke','drawing-send':'drawing.discuss','ppt-note':'ppt.point','word-edit':'word.edit','sheet-edit':'sheet.edit',split:'workspace.split',detach:'workspace.detach',dock:'workspace.dock',notification:'notification.show',report:'report.open',diff:'diff.open',decision:'notification.show',summary:'project.cleanup'};
export function unwrapDemo(result){if(!result?.ok)throw Object.assign(Error(result?.error?.message||'演示操作未完成'),{code:result?.error?.code});return result.value;}
export function createDemoActions({invoke}){
  return async function runAction(session,step){
    if(step.semantic==='summary')return {retained:true};
    return unwrapDemo(await invoke('demo.perform',{...demoIdentity(session),chapterId:session.chapterId,stepIndex:session.stepIndex,command:demoCommands[step.semantic],args:{semantic:step.semantic,stepId:step.id},relPath:step.relPath}));
  };
}

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
    const view=Object.values(groups.snapshot().views).find(view=>view.kind==='document'&&view.relPath==='research-notes.txt');
    if(!view)throw Error('没有可以脱离的研究笔记');
    await groups.command({type:'floatOpen',viewId:view.id});
  }else if(semantic==='dock'){
    const detached=groups.snapshot().detached.at(-1);if(!detached)throw Error('没有可返回的独立窗口');
    await groups.command({type:'dock',windowId:detached.id});
  }else throw Error('未知布局动作');
  return {layout:groups.snapshot()};
}
