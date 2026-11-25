// User-facing aliases for the bundled Frontdesk skill catalog.
export const frontdeskSkillCommands = [
  {alias:'read-material', label:'阅读项目材料', description:'结合有版本的文件、选段和批注进行阅读或修改。'},
  {alias:'handoff', label:'交接后台工作', description:'交接尚未完成的工作，不扩大范围或重放历史操作。'},
  {alias:'project-analysis', label:'分析项目', description:'从项目文件核对结构和运行方式，不自动执行。'},
  {alias:'project-progress', label:'梳理项目进展', description:'根据当前工作记录盘点进度、待决事项和阻塞。'},
].map(row=>({...row, name:'nozeli-frontdesk-'+row.alias, command:'/skill:'+row.alias}));

export function parseFrontdeskSkill(text) {
  const token=/^\/skill:([^\s]*)/i.exec(text.trimStart())?.[1];
  if(token===undefined)return null;
  const key=token.toLowerCase();
  return {skill:frontdeskSkillCommands.find(row=>row.alias===key||row.name===key)};
}
