export function treeMenuItems({ directory, root, canPaste, visibility = false, hidden = false, showHidden = false }) {
  const items = [];
  if (!root) items.push({ label: '打开', id: 'open' });
  if (!directory) items.push({label:'使用系统默认应用打开',id:'openExternal'});
  if (!directory) items.push({ label: '颜色标签与备注…', id: 'label' });
  if (directory) items.push({ label:'新建文件…', id:'createFile' }, { label:'新建文件夹…', id:'createFolder' });
  items.push({type:'separator'});
  if (!root) items.push({label:'剪切',id:'cut',accelerator:'CmdOrCtrl+X'},{label:'复制',id:'copy',accelerator:'CmdOrCtrl+C'});
  items.push({label:'粘贴',id:'paste',enabled:canPaste,accelerator:'CmdOrCtrl+V'});
  if (!root) items.push({label:'重命名…',id:'rename',accelerator:'F2'},{label:'移至回收站…',id:'trash'});
  items.push({type:'separator'},{label:'复制相对路径',id:'relativePath'},{label:'复制完整路径',id:'absolutePath'},{label:'在系统文件管理器中显示',id:'reveal'});
  if(directory) items.push({type:'separator'},{label:'折叠所有子目录',id:'collapse'});
  if(visibility){items.push({type:'separator'});if(!root)items.push({label:hidden?'显示':'隐藏',id:hidden?'unhide':'hide'});items.push({label:'显示已隐藏',id:'toggleHidden',checked:showHidden});}
  items.push({label:'刷新',id:'refresh'});
  return items;
}
