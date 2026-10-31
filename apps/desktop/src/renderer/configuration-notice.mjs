export function renderConfigurationNotice(node, agents = []) {
  const required = agents.some(agent => agent.configurationStatus === 'unconfigured' || agent.configurationStatus?.loginRequired === true);
  node.hidden = !required;
  node.textContent = required ? '当前会话来源需要登录或配置：请在设置的「AI 连接与账号」完成账号登录或 API 源配置；官方本机配置不受影响。' : '';
}
