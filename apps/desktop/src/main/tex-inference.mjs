import path from 'node:path';
const clean = text => text.replace(/(?<!\\)%.*$/gm, '');
export function inferTex({texts,current,config,tools,hasConfig=false}) {
 const roots=[...texts].filter(([,text])=>/\\documentclass(?:\s*\[|\s*\{)/.test(clean(text))).map(([file])=>file);
 const resolve=(base,name)=>{const p=path.posix.normalize(path.posix.join(path.posix.dirname(base),name.trim()));return texts.has(p)?p:texts.has(p+'.tex')?p+'.tex':null;};
 const edges=new Map([...texts].map(([file,text])=>[file,[...clean(text).matchAll(/\\(?:input|include|subfile)\s*\{([^}]+)\}/g)].map(m=>resolve(file,m[1])).filter(Boolean)]));
 const reaches=(from,to,seen=new Set())=>{if(from===to)return true;if(seen.has(from))return false;seen.add(from);return (edges.get(from)||[]).some(p=>reaches(p,to,seen));};
 let root=config.root,reason='沿用已保存的主文档';
 if(!root||!texts.has(root)){
  const hint=texts.get(current)?.match(/^\s*%\s*!TeX\s+root\s*=\s*(.+?)\s*$/mi),target=hint&&resolve(current,hint[1]);
  if(target&&roots.includes(target)){root=target;reason='依据 TeX root 声明';}
  else if(roots.includes(current)){root=current;reason='当前文件包含 documentclass';}
  else{const owners=roots.filter(r=>reaches(r,current));root=owners.length===1?owners[0]:roots.length===1?roots[0]:'';reason=root?(owners.length===1?'依据章节引用关系':'项目中唯一主文档'):'存在多个主文档，请选择';}
 }
 let engine=config.engine,engineReason='沿用已保存的编译引擎';
 if(!hasConfig){
  const hint=texts.get(root)?.match(/^\s*%\s*!TeX\s+(?:program|TS-program)\s*=\s*(xelatex|lualatex|pdflatex|tectonic)\s*$/mi)?.[1]?.toLowerCase();
  const content=[...texts].filter(([file])=>root&&reaches(root,file)).map(([,text])=>clean(text)).join('\n');
  const unicode=/\\(?:usepackage|documentclass)(?:\[[^\]]*\])?\{[^}]*(?:fontspec|unicode-math|ctex|xeCJK)/.test(content)||/[\u3400-\u9fff]/.test(content);
  const choices=unicode?['xelatex','lualatex']:['pdflatex','xelatex','lualatex','tectonic'];
  engine=hint||choices.find(e=>tools[e])||choices[0];engineReason=hint?'依据 TeX program 声明':unicode?'依据中文/Unicode字体需求':'依据本机可用编译工具';
 }
 return {root,engine,reason,engineReason,roots};
}
