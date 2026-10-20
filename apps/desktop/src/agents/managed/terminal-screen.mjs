import headless from '@xterm/headless';
const {Terminal}=headless;
const palette=['#000000','#cd0000','#00cd00','#cdcd00','#0000ee','#cd00cd','#00cdcd','#e5e5e5','#7f7f7f','#ff0000','#00ff00','#ffff00','#5c5cff','#ff00ff','#00ffff','#ffffff'];
function color(cell,foreground){
 const prefix=foreground?'Fg':'Bg',value=cell['get'+prefix+'Color']();
 if(cell['is'+prefix+'RGB']())return '#'+value.toString(16).padStart(6,'0');
 if(!cell['is'+prefix+'Palette']())return null;
 if(value<16)return palette[foreground&&cell.isBold()&&value<8?value+8:value];
 if(value>=232){const n=8+(value-232)*10;return `rgb(${n},${n},${n})`;}
 const n=value-16,level=[0,95,135,175,215,255];return `rgb(${level[Math.floor(n/36)]},${level[Math.floor(n/6)%6]},${level[n%6]})`;
}

// One bounded parser per actual PTY. It has no input callback, process handle,
// protocol reply transport or disk persistence. Snapshots contain cells, not ANSI.
export function createTerminalScreen({cols=120,rows=32,onChange=()=>{}}={}){
 const terminal=new Terminal({cols,rows,scrollback:0,allowProposedApi:true});
 let chain=Promise.resolve(),seq=0,version=0,updatedAt=null,disposed=false,timer,cached;
 function changed(){version++;updatedAt=Date.now();if(!timer)timer=setTimeout(()=>{timer=null;if(!disposed)onChange({seq,version,updatedAt});},80);}
 const schedule=fn=>{chain=chain.then(()=>{if(!disposed)return fn();});return chain;};
 return {
  write(data,nextSeq){return schedule(()=>new Promise(resolve=>terminal.write(data,()=>{seq=nextSeq;changed();resolve();})));},
  resize(nextCols,nextRows){return schedule(()=>{terminal.resize(nextCols,nextRows);changed();});},
  snapshot(){return schedule(()=>{
   if(cached?.version===version)return cached;
   const buffer=terminal.buffer.active,lines=[];
   for(let y=0;y<terminal.rows;y++){
    const line=buffer.getLine(buffer.baseY+y),runs=[];let previous=null;
    for(let x=0;x<terminal.cols;x++){
     const cell=line?.getCell(x);if(!cell||cell.getWidth()===0)continue;
     const fg=cell.getFgColor(),bg=cell.getBgColor(),fgMode=cell.getFgColorMode(),bgMode=cell.getBgColorMode();
     const flags=(!!cell.isBold())|((!!cell.isDim())<<1)|((!!cell.isItalic())<<2)|((!!cell.isUnderline())<<3)|((!!cell.isInverse())<<4)|((!!cell.isStrikethrough())<<5)|((!!cell.isInvisible())<<6);
     const width=cell.getWidth(),text=cell.getChars()||' ';
     // Wide cells stay distinct so the projection can reserve exact columns.
     if(previous&&previous.fg===fg&&previous.bg===bg&&previous.fgMode===fgMode&&previous.bgMode===bgMode&&previous.flags===flags&&width===1&&previous.width===1){previous.run.text+=text;previous.run.cells++;}
     else{const run={fg:color(cell,true),bg:color(cell,false),bold:!!(flags&1),dim:!!(flags&2),italic:!!(flags&4),underline:!!(flags&8),inverse:!!(flags&16),strike:!!(flags&32),invisible:!!(flags&64),text,cells:width};runs.push(run);previous={fg,bg,fgMode,bgMode,flags,width,run};}
    }
    lines.push(runs);
   }
   return cached={cols:terminal.cols,rows:terminal.rows,seq,version,updatedAt,lines};
  });},
  dispose(){clearTimeout(timer);timer=null;return chain.then(()=>{disposed=true;terminal.dispose();});},
 };
}
