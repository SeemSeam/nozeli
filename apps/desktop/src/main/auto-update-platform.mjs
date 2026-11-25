// Platform channels describe implemented adapters, not release qualification.
// Source checkouts stay check-only; installation authority is independently
// validated before download, native handoff and activation.
export function updatePlatformSupport(platform = process.platform, arch = process.arch) {
  const policy = platform === 'linux' && arch === 'x64'
    ? '从 Nozeli GitHub Releases 检查 Linux x64 更新；稳定版本只选择稳定通道，Alpha/Beta 客户端保留预发行进度。自动下载并校验后，仅在无未保存编辑、无在途任务且系统空闲时安装重启；失败保留旧版本。'
    : platform === 'darwin' && arch === 'arm64'
      ? '从 Nozeli GitHub Releases 检查 macOS arm64 更新；稳定版本只选择稳定通道，预发行客户端保留预发行进度。自动下载并校验后，仅在无未保存编辑、无在途任务且系统空闲时安装重启；失败保留旧版本。'
      : platform === 'win32' && arch === 'x64'
        ? '从 Nozeli GitHub Releases 检查 Windows x64 ZIP 更新；稳定版本只选择稳定通道。仅经原生所有权核验的独立安装支持下载、空闲重启与健康确认；未保存输入、在途任务或未知效果会阻止安装。启动失败只回退程序版本，不回退用户资料。旧版首次仍需手动安装支持更新的版本；签名与 SmartScreen 资格单独说明。'
        : null;
  const checksSupported = policy !== null;
  return Object.freeze({
    checksSupported,
    platform,
    arch,
    reason: checksSupported ? null : 'UPDATE_PLATFORM_UNSUPPORTED',
    policy: checksSupported
      ? policy
      : '当前版本未提供适用于此系统的更新渠道，自动检查、下载和安装已停用；请使用本机安装包手动更新。',
  });
}

export function requireUpdatePlatform() {
  const support = updatePlatformSupport();
  if (!support.checksSupported) throw Object.assign(new Error(support.policy), {code: support.reason});
}
