// Glyphs from the MIT-licensed Codicons bundled with Monaco 0.57.0.
export const FILE_ICONS = Object.freeze({
  code:{glyph:0xeae9,color:'#547d9b'}, markdown:{glyph:0xeb1d,color:'#578c91'},
  text:{glyph:0xec5e,color:'#84917c'}, word:{letter:'W',color:'#4a78a6'},
  pdf:{glyph:0xeaeb,color:'#a4574f'}, sheet:{glyph:0xebb7,color:'#5b896a'},
  ppt:{letter:'P',color:'#b77c4c'}, tex:{letter:'T',color:'#8d719c'},
  bib:{glyph:0xeaa4,color:'#78875a'}, image:{glyph:0xeaea,color:'#93718f'},
  config:{glyph:0xeb0f,color:'#aa9050'}, unknown:{glyph:0xeae8,color:'#95988d'},
  folder:{glyph:0xea83,color:'#a18443'}, 'folder-open':{glyph:0xeaf7,color:'#a18443'},
});
export function fileIconType(filePath, {directory=false,expanded=false,kind}={}) {
  if(directory)return expanded?'folder-open':'folder';
  const name=String(filePath||'').replaceAll('\\','/').split('/').pop().toLowerCase();
  const ext=name.includes('.')?name.split('.').pop():'';
  if(/^(docx?|docm|odt|rtf)$/.test(ext))return 'word';
  if(/^(pptx?|pptm|odp)$/.test(ext))return 'ppt';
  if(/^(xlsx?|xlsm|ods|csv|tsv)$/.test(ext))return 'sheet';
  if(ext==='pdf')return 'pdf';
  if(/^(md|markdown|mdown|mdx)$/.test(ext))return 'markdown';
  if(/^(tex|sty|cls|ltx)$/.test(ext))return 'tex';
  if(ext==='bib')return 'bib';
  if(/^(png|jpe?g|webp|gif|bmp|svg|tiff?|ico|avif|heic)$/.test(ext))return 'image';
  if(/^(jsonc?|ya?ml|toml|ini|conf|config|xml|env)$/.test(ext)||/^\.(?:env(?:\..*)?|gitignore|gitattributes|npmrc|editorconfig|prettierrc(?:\..*)?|eslintrc(?:\..*)?)$/.test(name))return 'config';
  if(/^(js|jsx|[cm]js|ts|tsx|py|java|c|h|cc|cpp|cxx|hpp|hxx|go|rs|css|scss|less|html?|sql|sh|bash|zsh|fish|ps1|bat|cmd|cmake|rb|php|swift|kt|kts|cs|m|mm|lua|r|pl|vue|svelte)$/.test(ext)||/^(makefile|cmakelists\.txt|dockerfile)$/.test(name))return 'code';
  if(/^(txt|log|text)$/.test(ext)||/^(readme|license|licence|changelog|authors)$/.test(name)||kind==='text')return 'text';
  return ['word','ppt','sheet','pdf','image'].includes(kind)?kind:'unknown';
}
export function updateFileIcon(node,filePath,options={}) {
  const type=fileIconType(filePath,options),icon=FILE_ICONS[type];
  if(node.dataset.fileIcon===type)return node;
  node.className='file-type-icon'+(icon.letter?' file-type-letter':'');node.dataset.fileIcon=type;
  node.dataset.glyph=icon.letter||String.fromCodePoint(icon.glyph);node.style.setProperty('--file-type-color',icon.color);
  node.setAttribute('aria-hidden','true');return node;
}
export function createFileIcon(filePath,options={}) {
  return updateFileIcon(document.createElement('span'),filePath,options);
}
export function decorateFileTitle(node,filePath,visible=true) {
  let icon=node.querySelector(':scope > .file-type-icon');
  if(!visible){icon?.remove();return;}
  if(!icon){icon=createFileIcon(filePath);node.prepend(icon);}else updateFileIcon(icon,filePath);
}
