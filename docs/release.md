# 发布说明与发行边界

当前版本基线：**`0.1.0-alpha.1`**（见根 [CHANGELOG.md](../CHANGELOG.md) 与 `apps/desktop/package.json`）。本页记录发行状态、验证边界与公开分发前置条件；打包与验证命令见[桌面开发说明](../apps/desktop/README.md)，逐项义务的机器可读清单见 [compliance-inventory.json](../apps/desktop/compliance-inventory.json)。

## 版本状态

- **公开 Alpha 预发布已发布**：<https://github.com/SeemSeam/nozeli/releases/tag/v0.1.0-alpha.1>（源提交 `af004b4`，含 Linux x64 便携包、源码快照与 SHA-256 校验和）。该预发布应仓库所有者明确要求发布；**发布不是合规认证**，下述分发审计未完成。
- 本版本为 **Alpha 审阅候选**：供源码审阅、跟进开发与 Linux 本机验证使用。
- 验证状态：**Linux x64／Wayland 本机验证**通过（阅读、批注、编辑、后台协作工作流与本机安装循环）。**Windows／macOS 为产品目标平台，未验证**；安装与打包工具当前仅实现 Linux。
- 空工作台四项推荐功能引导（批注与选区讨论、任务闭环、分屏阅读、独立窗口）已包含在本版本中。
- AI 能力需用户自行配置模型源与账号；发行物不含任何凭据、用户项目数据或个人会话。

## 分发审计状态：未完成

分发审计状态：未完成。已公开的预发布不因附件 `使用说明.md` 中的“供本机使用”声明或本页免责说明而解除下列义务；免责声明不构成义务履行。逐项状态以 [compliance-inventory.json](../apps/desktop/compliance-inventory.json) 为准（含 pinned 版本、哈希与证据路径）；本页与其不一致时，先修正文档再发布。签收必须是具名人工记录（审核人、日期、结论、证据），不能用状态标记或脚本输出替代。

未完成义务（与清单 `obligations` 一一对应）：

1. **AGPL vendor 对应源码**：发行物内含 AGPL 许可的压缩（minified）产物 `vendor/superdoc-1.47.1` 与构建产物 `vendor/pptist/dist`。对应完整源码的提供与核验尚未签收；仅提供本仓库源码归档或上游 URL 不自动满足 AGPL 对应源码义务。仓库已保留可核验来源（SuperDoc npm 完整性与文件哈希见 `vendor/superdoc-1.47.1/SOURCES.json`；PPTist 上游归档 `vendor/pptist/upstream.tar.gz`，tar 内容 SHA-256 `f23dfaf45708a1cf04cabaa08077a16e00c2b5244e76d6821df56265a1c67c81`）。
2. **Git 二进制对应源码**：捆绑的 Git 2.53.0（GPL-2.0，经 dugite-native v2.53.0-4098283 分发）需为再分发二进制整理并提供完整对应源码与通告（含原生发行版内置库）。
3. **私有 OMP 运行时对应源码**：随包分发的编译版私有 OMP 运行时需随发行物提供配方式重建的对应源码包（上游 commit、三补丁、锁文件与 native addon 摘要），并核验 Bun 运行时通告覆盖（`BUN-LICENSE.txt`、`THIRD-PARTY-NOTICES.txt`）。
4. **Electron/Chromium 二进制通告**：逐发行物核验 `LICENSES.chromium.html` 等第三方通告的存在与完整并记录核验结果。
5. **PPTist 传递依赖审计**：`pptxtojson`、`pptxgenjs`、`hfmath` 及其传递闭包（含字体/资源）的再分发审计未完成。

上述义务签收前：不发布后续公开版本，不宣称“源码已开放即义务已满足”，不以任何自动检查替代人工签收。`node tools/check-repository.mjs --public` 在此期间保持失败，作为发布门的机器侧提醒（该脚本是元数据一致性检查，不是法律审计）。

## 打包与验证入口（摘要）

- Linux 便携包：`node tools/package-portable.mjs <绝对输出目录>`（要求源码树已全部提交）；本机用户级安装：`node tools/install-local.mjs`。
- 常规回归不发起付费模型请求；真实模型检查一律显式启用并由授权者自行运行。
- 发布检查顺序：全部常规回归通过 → 构建便携包 → 从解压产物启动冒烟 → 核对 SOURCES 与 licenses 清单 → （公开分发前）完成上述审计并写入签收记录。
