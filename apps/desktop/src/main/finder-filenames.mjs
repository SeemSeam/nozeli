// Finder's binary property list is an array of filename strings. Deliberately
// accept only that shape, not the general plist object graph.
export function parseFilenameBinaryPlist(bytes) {
  const fail=()=>{throw Error('无效的 Finder 文件列表。');};
  if(bytes.length<40||bytes.subarray(0,8).toString()!=='bplist00')fail();
  const trailer=bytes.length-32,offsetWidth=bytes[trailer+6],refWidth=bytes[trailer+7];
  const integer=(at,width)=>{if(!Number.isInteger(at)||![1,2,4,8].includes(width)||at<0||at+width>bytes.length)fail();const value=bytes.readUIntBE(at,Math.min(width,6));if(width===8){if(bytes[at]||bytes[at+1])fail();return bytes.readUIntBE(at+2,6);}return value;};
  const count=integer(trailer+8,8),top=integer(trailer+16,8),table=integer(trailer+24,8);
  if(!count||count>2048||top>=count||![1,2,4,8].includes(offsetWidth)||![1,2,4,8].includes(refWidth)||table<8||table+count*offsetWidth!==trailer)fail();
  const offsets=Array.from({length:count},(_,i)=>integer(table+i*offsetWidth,offsetWidth));
  if(offsets.some(offset=>offset<8||offset>=table)||new Set(offsets).size!==count)fail();
  const bounds=index=>{const start=offsets[index],end=Math.min(table,...offsets.filter(offset=>offset>start));return {start,end};};
  const header=index=>{const {start,end}=bounds(index);const marker=bytes[start],kind=marker>>4;let length=marker&15,at=start+1;if(length===15){if(at>=end||bytes[at]>>4!==1)fail();const width=2**(bytes[at++]&15);if(at+width>end)fail();length=integer(at,width);at+=width;}return {kind,length,at,end};};
  const array=header(top);if(array.kind!==10||!array.length||array.length>1024||array.at+array.length*refWidth!==array.end)fail();
  const result=[];
  for(let i=0;i<array.length;i++){
    const index=integer(array.at+i*refWidth,refWidth);if(index>=count||index===top)fail();const item=header(index);
    if(![5,6].includes(item.kind)||!item.length||item.length>32768||item.at+item.length*(item.kind===6?2:1)!==item.end)fail();
    const payload=bytes.subarray(item.at,item.end);let value;
    if(item.kind===5){if(payload.some(byte=>byte>127))fail();value=payload.toString('ascii');}
    else{try{value=new TextDecoder('utf-16be',{fatal:true}).decode(payload);}catch{fail();}}
    result.push(value);
  }
  return result;
}
