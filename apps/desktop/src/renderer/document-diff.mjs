import { MergeView } from '@codemirror/merge';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { markdown } from '@codemirror/lang-markdown';
import { languageSupportForPath } from './code-language.mjs';
import { readerEditorTheme } from './text-view.mjs';
import { basicSetup } from 'codemirror';
import { syntaxHighlighting } from '@codemirror/language';
import { classHighlighter } from '@lezer/highlight';

export function mountDocumentDiff({ parent, leftPath, leftText, rightPath, rightText, leftLabel = '基线（只读）', rightLabel = '候选版本（只读）', onNavigate = () => {} }) {
  const language = path => /\.(md|markdown)$/i.test(path) ? markdown() : languageSupportForPath(path);
  const nonce = document.querySelector('meta[name="nozeli-style-nonce"]').content;
  const makeState = (path, doc, label) => ({
    doc,
    extensions: [basicSetup, readerEditorTheme(), syntaxHighlighting(classHighlighter), language(path), EditorState.readOnly.of(true), EditorView.editable.of(false), EditorView.contentAttributes.of({'aria-label':`${path} · ${label}`}), EditorView.cspNonce.of(nonce)],
  });
  parent.replaceChildren();
  const merge = new MergeView({
    a: makeState(leftPath, leftText, leftLabel),
    b: makeState(rightPath, rightText, rightLabel),
    parent,
    highlightChanges: true,
    gutter: true,
    collapseUnchanged: false,
    diffConfig: { scanLimit: 5000 },
  });
  let synchronizing = false, frame = 0, index = -1;
  onNavigate(index, merge.chunks.length);
  const mapPosition = (position, fromA) => {
    const from = fromA ? 'fromA' : 'fromB', to = fromA ? 'toA' : 'toB';
    const otherFrom = fromA ? 'fromB' : 'fromA', otherTo = fromA ? 'toB' : 'toA';
    let delta = 0;
    for (const chunk of merge.chunks) {
      if (position < chunk[from]) return position + delta;
      if (position <= chunk[to]) {
        const sourceSpan = Math.max(0, chunk[to] - chunk[from]);
        const targetSpan = Math.max(0, chunk[otherTo] - chunk[otherFrom]);
        if (!sourceSpan) return chunk[otherFrom];
        const ratio = Math.max(0, Math.min(1, (position - chunk[from]) / sourceSpan));
        return chunk[otherFrom] + Math.round(targetSpan * ratio);
      }
      delta += (chunk[otherTo] - chunk[otherFrom]) - (chunk[to] - chunk[from]);
    }
    return position + delta;
  };
  const sync = (source, target, fromA) => {
    if (synchronizing) return;
    synchronizing = true;
    try {
      const sourceLine = source.lineBlockAtHeight(source.scrollDOM.scrollTop);
      const targetPos = Math.max(0, Math.min(target.state.doc.length, mapPosition(sourceLine.from, fromA)));
      const targetLine = target.lineBlockAt(targetPos);
      const withinLine = source.scrollDOM.scrollTop - sourceLine.top;
      target.scrollDOM.scrollTop = Math.max(0, targetLine.top + withinLine);
    } finally {
      cancelAnimationFrame(frame);frame=requestAnimationFrame(() => { synchronizing = false; });
    }
  };
  const onA = () => sync(merge.a, merge.b, true);
  const onB = () => sync(merge.b, merge.a, false);
  merge.a.scrollDOM.addEventListener('scroll', onA, { passive: true });
  merge.b.scrollDOM.addEventListener('scroll', onB, { passive: true });
  return {
    merge,
    navigate(direction) {
      if(!merge.chunks.length)return;
      index=index<0?(direction>0?0:merge.chunks.length-1):(index+direction+merge.chunks.length)%merge.chunks.length;
      const chunk=merge.chunks[index];
      for(const [view,from]of [[merge.a,chunk.fromA],[merge.b,chunk.fromB]]){
        const position=Math.min(from,view.state.doc.length);
        view.dispatch({selection:{anchor:position},effects:EditorView.scrollIntoView(position,{y:'center'})});
      }
      onNavigate(index,merge.chunks.length);
    },
    destroy() {
      cancelAnimationFrame(frame);
      merge.a.scrollDOM.removeEventListener('scroll', onA);
      merge.b.scrollDOM.removeEventListener('scroll', onB);
      merge.destroy();
      parent.replaceChildren();
    },
  };
}
