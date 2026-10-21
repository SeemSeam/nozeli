import {setIconButton} from './ui-icons.mjs';
import { workspaceIcon } from './workspace-conversation-controls.mjs';
import './document-header.css';
import {mountPopupMenu} from './popup-menu.mjs';
import {decorateFileTitle} from './file-icons.mjs';
import {panelButton, observePanelWidth} from './panel-menu.mjs';

export function mountDocumentHeader() {
  const reader = document.getElementById('reader');
  const header = reader.querySelector('.desk-header');
  const title = document.getElementById('subject-title');
  const path = document.getElementById('file-path');
  const bar = document.getElementById('reader-bar');
  const documents = document.getElementById('documents');
  const close = document.getElementById('close-subject');
  const status = document.getElementById('save-status');
  const mode = document.getElementById('text-mode-toggle');
  const tools = header.querySelector('.desk-tools');
  const secondaryRow = document.getElementById('secondary-pane').querySelector('.reader-bar');
  secondaryRow.insertBefore(document.getElementById('secondary-tools'),document.getElementById('secondary-close'));
  secondaryRow.append(panelButton('secondary-more'));
  for(const id of ['code-jump','pdf-outline-toggle','pdf-prev','pdf-next','pdf-search-toggle','word-zoom-out','word-zoom-in','image-out','image-in','secondary-prev','secondary-next'])document.getElementById(id)?.classList.add('panel-overflow-first');
  for(const id of ['pdf-zoom-out','pdf-zoom-in','word-zoom-reset','image-actual','secondary-zoom-out','secondary-zoom-in'])document.getElementById(id)?.classList.add('panel-overflow-second');
  document.getElementById('open-beside').classList.add('panel-overflow-first');
  observePanelWidth(header); observePanelWidth(bar); observePanelWidth(secondaryRow);
  const pdfTools = document.getElementById('pdf-toolbar');
  const imageTools=document.getElementById('image-toolbar');
  const fontControl=document.createElement('span');fontControl.id='font-control';
  const fontButton=document.createElement('button');fontButton.type='button';fontButton.id='font-settings';fontButton.title='字号与阅读行宽';
  fontButton.append(document.getElementById('font-size-label'),workspaceIcon('chevron-down'));fontControl.append(fontButton);
  tools.insertBefore(fontControl,document.getElementById('font-smaller'));
  const fontMenu=document.createElement('div');fontMenu.id='font-menu';fontMenu.className='surface-menu';
  const fontCaption=document.createElement('span');fontCaption.className='menu-caption';fontCaption.textContent='正文大小';
  const smaller=document.getElementById('font-smaller'),larger=document.getElementById('font-larger');
  fontMenu.append(fontCaption,smaller,larger);
  smaller.textContent='缩小字号';larger.textContent='增大字号';
  for(const size of [12,14,16,18]){const button=document.createElement('button');button.type='button';button.dataset.readerFont=String(size);button.textContent=size+'px';fontMenu.append(button);}
  const reset=document.createElement('button');reset.type='button';reset.id='font-reset';reset.textContent='恢复默认字号';fontMenu.append(reset);
  const widthCaption=document.createElement('span');widthCaption.className='menu-caption';widthCaption.textContent='Markdown 阅读行宽';fontMenu.append(widthCaption);
  for(const [value,label]of [[72,'舒适行宽'],[100,'较宽正文']]){const button=document.createElement('button');button.type='button';button.dataset.readingWidth=String(value);button.textContent=label;fontMenu.append(button);}
  document.body.append(fontMenu);mountPopupMenu(fontButton,fontMenu);
  const metadata = document.createElement('div');
  metadata.className = 'document-meta';
  metadata.append(status, mode);
  // Shared command handlers and state stay available to the document menu.
  // A permanently hidden owner keeps these infrequent controls off the header.
  const viewCommands = document.createElement('div');
  viewCommands.id = 'document-view-commands'; viewCommands.hidden = true;
  viewCommands.append(document.getElementById('markdown-preview-toggle'), document.getElementById('markdown-sync'));
  document.body.append(viewCommands);
  // Native pane chrome owns the title and tools button. Its menu is rendered
  // inside this content WebContents, anchored independently of hidden rows.
  const contentToolsAnchor = document.createElement('span');
  contentToolsAnchor.id = 'document-content-tools-anchor';
  contentToolsAnchor.setAttribute('aria-hidden', 'true');
  contentToolsAnchor.style.cssText = 'position:fixed;right:8px;top:0;width:1px;height:1px;visibility:hidden;pointer-events:none';
  document.body.append(contentToolsAnchor);
  const definitions = [
    ['open-beside', 'layout', '在旁边打开文件'],
    ['toggle-focus', 'maximize', null],
    ['close-subject', 'close', '关闭当前内容'],
  ];
  for (const [id, name, label] of definitions) {
    const button = document.getElementById(id);
    setIconButton(button,name);
    if (label) { button.title = label; button.setAttribute('aria-label', label); }
  }
  reader.classList.add('document-header-unified');
  function render() {
    const dual = documents.classList.contains('dual');
    reader.classList.toggle('document-dual', dual);
    const parent = dual ? bar : header;
    if(tools.parentElement!==parent)parent.append(tools);
    const texTools=document.getElementById('tex-toolbar');
    if(texTools){
      if(!texTools.dataset.panelObserved){texTools.dataset.panelObserved='true';observer.observe(texTools,{attributes:true,attributeFilter:['hidden']});}
      if(!texTools.hidden&&texTools.parentElement!==parent)parent.insertBefore(texTools,tools);
      else if(texTools.hidden&&texTools.parentElement!==document.getElementById('primary-pane'))document.getElementById('reader-scroll').before(texTools);
    }
    const pdf = !pdfTools.hidden;
    const image=imageTools && !imageTools.hidden;
    reader.classList.toggle('document-pdf', pdf);
    if(image){if(imageTools.parentElement!==parent){if(dual)bar.append(imageTools);else header.insertBefore(imageTools,tools);}}
    else if(imageTools && imageTools.parentElement!==document.getElementById('primary-pane'))document.getElementById('primary-pane').insertBefore(imageTools,document.getElementById('reader-scroll'));
    const pdfParent = pdf ? parent : document.getElementById('primary-pane');
    if (pdfTools.parentElement !== pdfParent) {
      if (pdf && !dual) header.insertBefore(pdfTools, tools);
      else if (pdf) bar.append(pdfTools);
      else pdfParent.insertBefore(pdfTools, document.getElementById('pdf-search'));
    }
    if (metadata.parentElement !== parent) {
      if (dual) bar.append(metadata);
      else header.insertBefore(metadata, tools);
    }
    metadata.hidden = close.hidden;
    if(parent.lastElementChild!==tools)parent.append(tools);
    const markdown=/\.(md|markdown)$/i.test(path.textContent);
    for(const node of fontMenu.querySelectorAll('[data-reading-width]'))node.hidden=!markdown;
    widthCaption.hidden=!markdown;
    const fullPath = path.textContent;
    decorateFileTitle(title,fullPath,!close.hidden);
    decorateFileTitle(path,fullPath,!close.hidden);
    const secondary=document.getElementById('secondary-path');
    decorateFileTitle(secondary,secondary.dataset.iconPath||secondary.textContent.split(' · ')[0],dual);
    if (title.title !== fullPath) title.title = fullPath;
    if (path.title !== fullPath) path.title = fullPath;
    const label = status.textContent;
    if (status.title !== label) status.title = label;
    if (status.getAttribute('aria-label') !== label) status.setAttribute('aria-label', label);
    status.classList.toggle('quiet-saved',status.dataset.state==='saved');
    mode.setAttribute('aria-label', mode.textContent === '编辑' ? '切换到编辑模式' : '切换到阅读模式');
  }
  const observer = new MutationObserver(render);
  observer.observe(documents, { attributes: true, attributeFilter: ['class'] });
  observer.observe(document.getElementById('primary-pane'),{childList:true});
  observer.observe(close, { attributes: true, attributeFilter: ['hidden'] });
  observer.observe(pdfTools, { attributes: true, attributeFilter: ['hidden'] });
  if(imageTools)observer.observe(imageTools,{attributes:true,attributeFilter:['hidden']});
  observer.observe(status,{attributes:true,attributeFilter:['data-state']});
  for (const node of [title, path, status, mode]) observer.observe(node, { childList: true, characterData: true, subtree: true });
  observer.observe(document.getElementById('secondary-path'),{childList:true,characterData:true,subtree:true,attributes:true,attributeFilter:['data-icon-path']});
  const resize = new ResizeObserver(() => {
    const width = header.getBoundingClientRect().width;
    header.classList.toggle('document-header-compact', width < 560);
    header.classList.toggle('document-header-narrow', width < 320);
  });
  resize.observe(header);
  render();
}
