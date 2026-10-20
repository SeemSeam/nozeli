export const FILE_COLORS = Object.freeze([
  { id: 'red', name: '红色', hex: '#c44443' },
  { id: 'orange', name: '橙色', hex: '#d87921' },
  { id: 'yellow', name: '黄色', hex: '#b69714' },
  { id: 'green', name: '绿色', hex: '#378359' },
  { id: 'blue', name: '蓝色', hex: '#3478b9' },
  { id: 'purple', name: '紫色', hex: '#8858b5' },
]);
export function validateFileLabel(value) {
  if (!value || !Array.isArray(value.colors) || value.colors.length > FILE_COLORS.length || new Set(value.colors).size !== value.colors.length || value.colors.some(id => !FILE_COLORS.some(c => c.id === id)) || typeof value.note !== 'string' || value.note.length > 2000) throw new Error('文件标记需要有效颜色列表及不超过 2000 字的备注。');
  return { colors: FILE_COLORS.filter(c => value.colors.includes(c.id)).map(c => c.id), note: value.note };
}
