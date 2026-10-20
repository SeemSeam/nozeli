// Directory listings may be truncated; only the host can establish absence.
export async function readFileAvailability(invoke, projectId, paths) {
  const unique = [...new Set(paths)], entries = new Map();
  for (let start = 0; start < unique.length; start += 500) {
    const chunk = unique.slice(start, start + 500);
    const result = await invoke('file.availability', {projectId, paths:chunk});
    if (!result.ok) throw new Error(result.error?.message || '无法检查文件路径');
    for (const entry of result.value.entries) entries.set(entry.relPath, entry);
  }
  return entries;
}
export function availabilityCaption(entry) {
  return entry?.status === 'missing' ? '原路径不存在' : entry?.status === 'unavailable' ? '路径暂不可用' : entry?.status === 'present' ? '当前文件' : '检查路径中';
}
