import {uiIcon, setIconButton} from './ui-icons.mjs';
import './interface-appearance.css';

// Apply only to Nozeli-owned controls; driver/editor content retains its own UI.
export function mountInterfaceAppearance() {
  const buttons = {
    'pick-project':['plus','打开项目文件夹'], 'focus-exit':['minimize','退出专注阅读'],
    'pdf-outline-toggle':['list-tree','PDF 目录'], 'pdf-search-toggle':['search','搜索 PDF'],
    'pdf-zoom-out':['minus','缩小页面'], 'pdf-zoom-in':['plus','放大页面'],
    'pdf-region':['scan','区域选择'], 'pdf-prev':['chevron-left','上一页'], 'pdf-next':['chevron-right','下一页'],
    'image-out':['minus','缩小图片'], 'image-in':['plus','放大图片'], 'image-region':['scan','区域选择'],
    'word-zoom-out':['minus','缩小 Word 页面'], 'word-zoom-in':['plus','放大 Word 页面'], 'word-region':['scan','区域选择'],
    'secondary-prev':['chevron-left','上一页'], 'secondary-next':['chevron-right','下一页'],
    'secondary-zoom-out':['minus','缩小页面'], 'secondary-zoom-in':['plus','放大页面'], 'secondary-close':['close','关闭对照文件'],
    'cancel-note':['close','收起备注编辑'],
  };
  for (const [id,[icon,label]] of Object.entries(buttons)) {
    const button=document.getElementById(id);if(button)setIconButton(button,icon,{label});
  }
  for (const [id,icon,text] of [['provider-console-toggle','terminal','终端'],['selection-draw','pencil','涂鸦'],['selection-note','sticky-note','备注'],['selection-discuss','message-square','讨论'],['selection-explain','circle-help','解释'],['send-message','arrow','发送']]) {
    const button=document.getElementById(id);if(button)setIconButton(button,icon,{text,label:button.getAttribute('aria-label')||text});
  }
  for(const id of ['file-toggle','toggle-sidebar']) {
    const button=document.getElementById(id);button.prepend(uiIcon('chevron-left'));button.classList.add('ui-edge-button');
  }
}
