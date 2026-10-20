import { createHighlighterCore } from '@shikijs/core';
import { createJavaScriptRegexEngine } from '@shikijs/engine-javascript';
import latex from '@shikijs/langs/latex';
import tex from '@shikijs/langs/tex';
import bibtex from '@shikijs/langs/bibtex';
import light from '@shikijs/themes/light-plus';
import { shikiToMonaco } from '@shikijs/monaco';
export const isTex = path => /\.(tex|bib|sty|cls)$/i.test(path);
export function installTex(monaco, request) {
  for (const id of ['latex','bibtex']) {
    monaco.languages.register({id});
    monaco.languages.setLanguageConfiguration(id,{comments:{lineComment:'%'},brackets:[['{','}'],['[',']'],['(',')']],autoClosingPairs:[{open:'{',close:'}'},{open:'[',close:']'}],wordPattern:/[a-zA-Z@][\w@:-]*/g});
    monaco.languages.registerCompletionItemProvider(id,{
      triggerCharacters:['\\','{',',','/'],
      async provideCompletionItems(model,position,context,token) {
        const version=model.getVersionId(), word=model.getWordUntilPosition(position);
        const range={startLineNumber:position.lineNumber,endLineNumber:position.lineNumber,startColumn:word.startColumn,endColumn:position.column};
        const prefix=model.getLineContent(position.lineNumber).slice(0,position.column-1);
        const command=/\\[a-zA-Z]*$/.test(prefix);
        const templates=id==='bibtex' ? [['article','article{${1:key},\n  author = {${2:Author}},\n  title = {${3:Title}},\n  year = {${4:2026}}\n}$0']] : [
          ...['section','subsection','textbf','textit','label','ref','cite','input','includegraphics','usepackage','documentclass'].map(name=>[name,name+'{${1}}$0']),
          ['frac','frac{${1:numerator}}{${2:denominator}}$0'],
          ...['equation','align','itemize','enumerate','figure','table'].map(env=>['begin '+env,'begin{'+env+'}\n\t${1}\n\\end{'+env+'}\n$0']),
        ];
        const suggestions=(command||id==='bibtex'?templates:[]).map(([label,insertText])=>({label,insertText,filterText:label,sortText:'0'+label,kind:monaco.languages.CompletionItemKind.Snippet,insertTextRules:monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,range,detail:'Nozeli 模板 · Tab 切换占位符'}));
        let result;try{result=await request(model.__nozeliLsp,'completion',{line:position.lineNumber-1,column:position.column-1});}catch{}
        if(token.isCancellationRequested||model.isDisposed()||model.getVersionId()!==version)return {suggestions:[]};
        const convert=r=>({startLineNumber:r.start.line+1,startColumn:r.start.character+1,endLineNumber:r.end.line+1,endColumn:r.end.character+1});
        for(const item of result?.ok?(result.value?.items||result.value||[]):[]) {
          const edit=item.textEdit, r=edit?.range||edit?.replace;
          suggestions.push({label:item.label,insertText:edit?.newText??item.insertText??item.label,range:r?convert(r):range,filterText:item.filterText,sortText:'1'+(item.sortText||item.label),detail:item.detail,documentation:item.documentation,kind:monaco.languages.CompletionItemKind.Text,insertTextRules:item.insertTextFormat===2?monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet:0,additionalTextEdits:item.additionalTextEdits?.map(e=>({range:convert(e.range),text:e.newText}))});
        }
        return {suggestions,incomplete:result?.value?.isIncomplete||false};
      }
    });
    monaco.languages.registerHoverProvider(id,{async provideHover(model,p){const version=model.getVersionId();const r=await request(model.__nozeliLsp,'hover',{line:p.lineNumber-1,column:p.column-1}).catch(()=>null);if(model.isDisposed()||model.getVersionId()!==version||!r?.ok||!r.value)return null;return {contents:[r.value.contents].flat().filter(Boolean).map(c=>({value:typeof c==='string'?c:c.value||''}))};}});
  }
  // A mutable facade keeps the official adapter from mutating ESM exports.
  return createHighlighterCore({themes:[light],langs:[tex,latex,bibtex],engine:createJavaScriptRegexEngine()}).then(highlighter=>{
    const editor={...monaco.editor,defineTheme:(id,theme)=>monaco.editor.defineTheme(id,{...theme,inherit:true})};
    shikiToMonaco(highlighter,{editor,languages:monaco.languages});
  });
}
