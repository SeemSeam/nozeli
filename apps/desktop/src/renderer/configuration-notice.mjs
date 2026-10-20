export function renderConfigurationNotice(node, agents = []) {
  const required = agents.some(agent => agent.configurationStatus?.loginRequired === true);
  node.hidden = !required;
  node.textContent = required ? '旧系统认证引用未导入，请在 Nozeli 私有 OMP 中登录或配置服务；官方 OMP 不受影响。' : '';
}
