// A view projection only. Exact spans and historical events stay unchanged.
export function uniqueChanges(items) {
  return [...new Map(items.map(item => [item.eventId, item])).values()]
    .sort((a, b) => b.revision - a.revision || a.eventId.localeCompare(b.eventId));
}
export function groupAuthorship(units, attribution) {
  if (!attribution) return [];
  const groups = [], spans = attribution.spans || [];
  let spanIndex = 0, previous = null;
  for (let index = 0; index < units.length; index++) {
    const unit = units[index], items = [];
    while (spanIndex < spans.length && spans[spanIndex].to <= unit.from) spanIndex++;
    for (let i = spanIndex; i < spans.length && spans[i].from < unit.to; i++) {
      if (spans[i].to > unit.from) items.push(spans[i]);
    }
    const changes = uniqueChanges(items), actorIds = [...new Set(changes.map(item => item.actor.id))].sort();
    if (!changes.length) { previous = null; continue; }
    const join = previous && actorIds.length === 1 && previous.actorIds.length === 1
      && actorIds[0] === previous.actorIds[0] && previous.boundary === unit.boundary
      && previous.lastIndex === index - 1 && unit.join !== false;
    if (join) {
      previous.to = unit.to; previous.endLine = unit.line ?? previous.endLine;
      previous.lastIndex = index; previous.units.push(unit);
      for(const item of changes)previous.events.set(item.eventId,item);
    } else {
      previous = {kind:'text', from:unit.from, to:unit.to, line:unit.line, endLine:unit.line,
        boundary:unit.boundary, firstIndex:index, lastIndex:index, units:[unit], events:new Map(changes.map(item=>[item.eventId,item])), actorIds};
      groups.push(previous);
    }
  }
  // Deletions are point records, never authorship of their neighboring text.
  const points = new Map();
  for (const item of attribution.points || []) {
    let lo=0,hi=units.length;
    while(lo<hi){const mid=(lo+hi)>>>1;if(units[mid].from<=item.from)lo=mid+1;else hi=mid;}
    const unit=units[lo-1];
    if (!unit || !(item.from<unit.to || unit.from===unit.to&&unit.from===item.from)) continue;
    const entries = points.get(item.from) || {unit, items:[]}; entries.items.push(item); points.set(item.from, entries);
  }
  for (const [from, {unit, items}] of points) groups.push({kind:'deletion', from, to:from,
    line:unit.line, endLine:unit.line, boundary:unit.boundary, units:[unit], items:uniqueChanges(items),
    actorIds:[...new Set(items.map(item=>item.actor.id))].sort()});
  return groups.sort((a,b)=>a.from-b.from || (a.kind==='deletion'?1:-1)).map(group=>{
    const {events,...view}=group,items=events?uniqueChanges([...events.values()]):group.items;
    return {...view,items,docId:attribution.docId,revision:attribution.revision,digest:attribution.digest,
      id:`${attribution.docId}:${group.kind}:${group.from}:${group.actorIds.join(',')}`,pending:items.some(item=>item.pending)};
  });
}
export function lineAuthorship(text, attribution) {
  const units = [], starts = [0];
  for (let at=text.indexOf('\n');at!==-1;at=text.indexOf('\n',at+1)) starts.push(at+1);
  for (let i=0;i<starts.length;i++) units.push({from:starts[i],to:starts[i+1]??text.length,line:i+1,boundary:'lines'});
  return groupAuthorship(units,attribution);
}
export function groupScope(group) {
  return {docId:group.docId,revision:group.revision,digest:group.digest,from:group.from,to:group.to,
    actorIds:group.actorIds,kind:group.kind};
}
export function groupTitle(group) {
  const actors=[...new Map(group.items.map(item=>[item.actor.id,item.actor])).values()];
  const saved=group.items.filter(item=>!item.pending), times=[...new Set(saved.map(item=>item.time))].sort();
  const format=time=>new Date(time).toLocaleString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false});
  const location=group.line?`第${group.line}${group.endLine!==group.line?'–'+group.endLine:''}行中有修改`:'当前段落中有修改';
  return [actors.map(actor=>actor.name).join('、'),group.kind==='deletion'?'删除位置':location,
    saved.length?`${saved.length}批 · ${times.length>1?'最早 '+format(times[0])+'，最新 ':''}${format(times.at(-1))}`:'',
    actors.some(actor=>actor.kind==='external')?'外部时间为检测时间':'',group.pending?'含未保存修改（尚无确认时间）':''].filter(Boolean).join(' · ');
}
