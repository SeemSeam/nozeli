import {createHash} from 'node:crypto';

// Strict run-equivalence qualification for the stripped Node executable.
// Only the ELF64 header and program-header fields needed to prove the loaded
// image unchanged are parsed here (bounds checked); this is not a general ELF
// library. Section and symbol evidence comes from canonicalized GNU readelf/nm
// output, so the gate holds across GNU binutils patch releases (CI 2.42 vs the
// qualifying workstation 2.46 reorder non-allocated bytes) while any change to
// loaded bytes, allocated sections or defined symbols still fails.

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const read16=(bytes,offset)=>bytes.readUInt16LE(offset);
const read32=(bytes,offset)=>bytes.readUInt32LE(offset);
function read64(bytes,offset){
 const value=bytes.readBigUInt64LE(offset);
 if(value>0xffffffffffffn)throw Error('ELF64 field at offset '+offset+' exceeds 48 bits');
 return Number(value);
}

// Segment content digest with file-layout metadata masked: the ELF header
// (section-table location/count differ after stripping) and each program
// header's p_offset column (segments compact to new file offsets) are ignored;
// their semantic fields are compared field-by-field instead. Every other byte
// in the mapped range must be identical.
function segmentContent(bytes,header,segment){
 if(!segment.fileSize)return null;
 const range=Buffer.from(bytes.subarray(segment.offset,segment.offset+segment.fileSize));
 const zeroSpan=(start,length)=>{
  const from=Math.max(start,segment.offset),to=Math.min(start+length,segment.offset+segment.fileSize);
  if(to>from)range.fill(0,from-segment.offset,to-segment.offset);
 };
 zeroSpan(0,header.elfHeaderSize);
 for(let index=0;index<header.programHeaderCount;index++)zeroSpan(header.programHeaderOffset+index*header.programHeaderSize+8,8);
 return digest(range);
}

// Returns {header:{...elf header fields...},segments:[{type,flags,offset,virtualAddress,physicalAddress,fileSize,memorySize,alignment,content}]}.
// content is the SHA-256 of a segment's masked file bytes, or null when a
// segment maps no file bytes. Throws on malformed or truncated input.
export function elf64LoadImage(bytes){
 if(!Buffer.isBuffer(bytes)||bytes.length<64||bytes.readUInt32BE(0)!==0x7f454c46)throw Error('not an ELF image');
 const header={identification:bytes.subarray(0,16),elfClass:bytes[4],byteOrder:bytes[5],elfVersion:bytes[6],osAbi:bytes[7],abiVersion:bytes[8],type:read16(bytes,16),machine:read16(bytes,18),version:read32(bytes,20),entry:read64(bytes,24),programHeaderOffset:read64(bytes,32),sectionHeaderOffset:read64(bytes,40),flags:read32(bytes,48),elfHeaderSize:read16(bytes,52),programHeaderSize:read16(bytes,54),programHeaderCount:read16(bytes,56),sectionHeaderSize:read16(bytes,58),sectionHeaderCount:read16(bytes,60),sectionNameIndex:read16(bytes,62)};
 if(header.programHeaderSize<56)throw Error('ELF64 program header entry size '+header.programHeaderSize+' is truncated');
 if(header.programHeaderOffset+header.programHeaderSize*header.programHeaderCount>bytes.length)throw Error('ELF64 program headers exceed image bounds');
 const segments=[];
 for(let index=0;index<header.programHeaderCount;index++){
  const base=header.programHeaderOffset+index*header.programHeaderSize;
  const segment={type:read32(bytes,base),flags:read32(bytes,base+4),offset:read64(bytes,base+8),virtualAddress:read64(bytes,base+16),physicalAddress:read64(bytes,base+24),fileSize:read64(bytes,base+32),memorySize:read64(bytes,base+40),alignment:read64(bytes,base+48)};
  if(segment.offset+segment.fileSize>bytes.length)throw Error('ELF64 segment '+index+' exceeds image bounds');
  if(segment.type===1&&segment.alignment>1&&(segment.offset-segment.virtualAddress)%segment.alignment!==0)throw Error('ELF64 load segment '+index+' offset 0x'+segment.offset.toString(16)+' is not congruent to virtual address 0x'+segment.virtualAddress.toString(16)+' modulo alignment 0x'+segment.alignment.toString(16));
  segment.content=segmentContent(bytes,header,segment);
  segments.push(segment);
 }
 return {header,segments};
}

// readelf -SW rows: '[Nr] Name Type Address Off Size ES Flg Lk Inf Al'. The
// canonical identity keeps name/type/address/size/entsize/flags/alignment;
// the file offset is retained separately so payload bytes can be compared even
// though stripping may compact them to new offsets.
export function canonicalSections(text){
 const rows=[];
 for(const line of String(text).split('\n')){
  const match=line.match(/^\s*\[\s*\d+\]\s+(\S+)\s+(\S+)\s+([0-9a-fA-F]+)\s+([0-9a-fA-F]+)\s+([0-9a-fA-F]+)\s+([0-9a-fA-F]+)\s*([A-Za-z]*)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/);
  if(match)rows.push({name:match[1],type:match[2],offset:Number.parseInt(match[4],16),size:Number.parseInt(match[5],16),allocated:match[7].includes('A'),identity:[match[1],match[2],match[3],match[5],match[6],match[7],match[10]].join(' ')});
 }
 return rows;
}

// nm --defined-only rows: 'Value Type Name'. File and section markers that
// strip --strip-debug may drop never appear here, so any real defined native
// symbol removed (for example by --strip-unneeded) is caught.
export function canonicalDefinedSymbols(text){
 const rows=[];
 for(const line of String(text).split('\n')){
  const match=line.match(/^([0-9a-fA-F]+)\s+([A-Za-z?])\s+(.+?)\s*$/);
  if(match)rows.push(match[1]+' '+match[2]+' '+match[3]);
 }
 return rows;
}

// readelf --dyn-syms -W rows: 'Num: Value Size Type Bind Vis Ndx Name' with the
// positional number dropped. Dynamic symbol names can be empty, so the name is
// the rest of the row.
export function canonicalDynamicSymbols(text){
 const rows=[];
 for(const line of String(text).split('\n')){
  const match=line.match(/^\s*\d+:\s+([0-9a-fA-F]+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s*(.*)$/);
  if(match)rows.push(match.slice(1).join(' ').trim());
 }
 return rows;
}

function uncovered(rows,covered){
 // Multiset difference: rows of the first list not matched by the second.
 const counts=new Map();
 for(const row of covered)counts.set(row,(counts.get(row)??0)+1);
 return rows.filter(row=>{const left=counts.get(row);if(left)counts.set(row,left-1);else return true;return false;});
}

function record(violations,prefix,rows){
 if(rows.length)violations.push(prefix+rows.slice(0,3).join('; ')+(rows.length>3?' +'+(rows.length-3)+' more':''));
}

// Compares the stripped candidate with its upstream original. Returns a list of
// human-readable violations; an empty list means the two images load the same
// bytes at the same addresses and expose the same defined native symbols.
export function qualifyStrippedNode({originalImage,processedImage,originalSections,processedSections,originalSymbols,processedSymbols,originalDynamicSymbols,processedDynamicSymbols}){
 const violations=[];
 let upstream,stripped;
 try{upstream=elf64LoadImage(originalImage);}catch(error){return ['upstream image is not a readable ELF64 image: '+error.message];}
 try{stripped=elf64LoadImage(processedImage);}catch(error){return ['processed image is not a readable ELF64 image: '+error.message];}
 for(const [label,image] of [['upstream',upstream],['processed',stripped]]){
  if(image.header.elfClass!==2)violations.push(label+' image is not ELF64 (class '+image.header.elfClass+')');
  if(image.header.byteOrder!==1)violations.push(label+' image is not little-endian (encoding '+image.header.byteOrder+')');
  if(image.header.machine!==62)violations.push(label+' image is not x86-64 (machine '+image.header.machine+')');
 }
 if(!upstream.header.identification.equals(stripped.header.identification))violations.push('ELF identification bytes changed');
 for(const field of ['type','version','entry','flags','elfHeaderSize','programHeaderOffset','programHeaderSize','programHeaderCount']){
  if(upstream.header[field]!==stripped.header[field])violations.push('ELF header field '+field+' changed from 0x'+upstream.header[field].toString(16)+' to 0x'+stripped.header[field].toString(16));
 }
 for(let index=0;index<Math.min(upstream.segments.length,stripped.segments.length);index++){
  const before=upstream.segments[index],after=stripped.segments[index];
  for(const field of ['type','flags','virtualAddress','physicalAddress','fileSize','memorySize','alignment']){
   if(before[field]!==after[field])violations.push('program header '+index+' field '+field+' changed from 0x'+before[field].toString(16)+' to 0x'+after[field].toString(16));
  }
  if(before.content!==after.content)violations.push('program header '+index+' no longer maps the original bytes');
 }
 if(upstream.segments.length!==stripped.segments.length)violations.push('program header count changed from '+upstream.segments.length+' to '+stripped.segments.length);
 const beforeSections=canonicalSections(originalSections),afterSections=canonicalSections(processedSections);
 record(violations,'allocated section no longer identical: ',uncovered(beforeSections.filter(section=>section.allocated).map(section=>section.identity),afterSections.filter(section=>section.allocated).map(section=>section.identity)));
 record(violations,'allocated section appeared: ',uncovered(afterSections.filter(section=>section.allocated).map(section=>section.identity),beforeSections.filter(section=>section.allocated).map(section=>section.identity)));
 const beforeNames=new Set(beforeSections.map(section=>section.name));
 record(violations,'section appeared without upstream counterpart: ',[...new Set(afterSections.filter(section=>!beforeNames.has(section.name)).map(section=>section.name))]);
 // Allocated payloads: each non-NOBITS section must keep a valid file range
 // inside a load segment of its own image and still hold its original bytes;
 // NOBITS sections have no file payload and are pinned by identity alone.
 const upstreamPayloads=beforeSections.filter(section=>section.allocated&&section.type!=='NOBITS'&&section.size);
 const processedPayloads=afterSections.filter(section=>section.allocated&&section.type!=='NOBITS'&&section.size);
 for(const [label,sections,bytes,image] of [['upstream',upstreamPayloads,originalImage,upstream],['processed',processedPayloads,processedImage,stripped]]){
  for(const section of sections){
   const end=section.offset+section.size;
   if(end>bytes.length){violations.push(label+' allocated section '+section.name+' exceeds image bounds');continue;}
   if(!image.segments.some(segment=>segment.type===1&&section.offset>=segment.offset&&end<=segment.offset+segment.fileSize))violations.push(label+' allocated section '+section.name+' is not covered by a load segment');
  }
 }
 const remaining=new Map();
 for(const section of processedPayloads)remaining.set(section.identity,(remaining.get(section.identity)??[]).concat(section));
 for(const section of upstreamPayloads){
  const counterpart=(remaining.get(section.identity)??[]).shift();
  if(!counterpart||!originalImage.subarray(section.offset,section.offset+section.size).equals(processedImage.subarray(counterpart.offset,counterpart.offset+counterpart.size)))violations.push('allocated section '+section.name+' no longer contains its original bytes');
 }
 record(violations,'defined native symbol no longer present: ',uncovered(canonicalDefinedSymbols(originalSymbols),canonicalDefinedSymbols(processedSymbols)));
 record(violations,'defined symbol appeared without upstream counterpart: ',uncovered(canonicalDefinedSymbols(processedSymbols),canonicalDefinedSymbols(originalSymbols)));
 record(violations,'dynamic symbol no longer identical: ',uncovered(canonicalDynamicSymbols(originalDynamicSymbols),canonicalDynamicSymbols(processedDynamicSymbols)));
 record(violations,'dynamic symbol appeared without upstream counterpart: ',uncovered(canonicalDynamicSymbols(processedDynamicSymbols),canonicalDynamicSymbols(originalDynamicSymbols)));
 return violations;
}
