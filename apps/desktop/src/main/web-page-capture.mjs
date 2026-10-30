export const webPageCaptureScript = `(() => {
  const excluded = 'script,style,noscript,template,form,input,textarea,select,button,[contenteditable]:not([contenteditable="false"]),[hidden],[aria-hidden="true"]';
  const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
  const chunks = []; let size = 0, node;
  while ((node = walker.nextNode()) && size < 200000) {
    const parent = node.parentElement;
    if (!parent || parent.closest(excluded)) continue;
    const style = getComputedStyle(parent);
    if (style.display === 'none' || style.visibility === 'hidden' || !parent.getClientRects().length) continue;
    const text = node.textContent.trim();
    if (text) { chunks.push(text); size += text.length + 1; }
  }
  return {url:location.href,title:document.title,text:chunks.join('\\n').slice(0,200000)};
})()`;
