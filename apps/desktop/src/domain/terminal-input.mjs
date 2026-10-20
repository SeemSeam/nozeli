// Terminal capability replies share the input stream with user keystrokes.
// A read can contain several replies, a split reply, or replies plus typed text.
const responseSource=String.raw`\x1b(?:\[[\d;?:><=]*[Rcu]|\[\??[\d;]*\$y|\[[IO]|\]\d+;[^\x07\x1b]*(?:\x07|\x1b\\))`;
const replies=()=>new RegExp(responseSource,'g');
export function isTerminalProtocolInput(data){return data.length>0&&data.replace(replies(),'').length===0;}
export function createTerminalInputObserver(){
 let pending='';
 return {hasText(data){
  let remaining=(pending+data).replace(replies(),'');pending='';
  const tail=remaining.match(/\x1b(?:\[[\d;?:><=]*\$?|\]\d*(?:;[^\x07\x1b]*)?(?:\x1b)?)?$/);
  if(tail&&tail[0].length<=4096){pending=tail[0];remaining=remaining.slice(0,-pending.length);}
  return /[^\x00-\x1f\x7f]/.test(remaining);
 },reset(){pending='';}};
}
