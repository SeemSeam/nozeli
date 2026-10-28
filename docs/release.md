# 发布说明与发行边界

当前版本基线：**`0.1.0-alpha.1`**（见根 [CHANGELOG.md](../CHANGELOG.md) 与 `apps/desktop/package.json`）。本页记录发行状态、验证边界与公开分发前置条件；打包与验证命令见[桌面开发说明](../apps/desktop/README.md)。

## 版本状态

- 本版本为 **Alpha 审阅候选**：源码仓库公开的意图是供审阅与跟进开发，**不代表第三方许可与对应源码义务审计已完成**。
- 验证状态：**Linux x64／Wayland 本机验证**通过（阅读、批注、编辑、后台协作工作流与本机安装循环）。**Windows／macOS 为产品目标平台，未验证**；安装与打包工具当前仅实现 Linux。
- 空工作台四项推荐功能引导（批注与选区讨论、任务闭环、分屏阅读、独立窗口）已包含在本版本中。
- AI 能力需用户自行配置模型源与账号；发行物不含任何凭据、用户项目数据或个人会话。

## 公开分发前置条件（未完成，逐项 gating）

1. **第三方源码义务**：仓库内含 AGPL 许可的压缩（minified）vendor 产物（如 `apps/desktop/vendor/superdoc-1.47.1`）及 PPTist 等内嵌来源。发布**对应完整源码的证明**尚未完成；仅提供本仓库源码归档或上游 URL **不自动满足** AGPL 的对应源码义务。
2. **二进制再分发审计**：本机 Alpha 包为本地验证产物。捆绑第三方二进制（Chromium/Electron、OMP/Bun 运行时、dugite/Git 等）的许可证与再分发义务清单（`apps/desktop/SOURCES.md` 与 `apps/desktop/assets/licenses/`）仍需逐项核对签收后，才可公开分发。
3. 以上两项未完成前，不发布公开下载，也不宣称“源码已开放即义务已满足”。

## 打包与验证入口（摘要）

- Linux 便携包：`node tools/package-portable.mjs <绝对输出目录>`（要求源码树已全部提交）；本机用户级安装：`node tools/install-local.mjs`。
- 常规回归不发起付费模型请求；真实模型检查一律显式启用并由授权者自行运行。
- 发布检查顺序：全部常规回归通过 → 构建便携包 → 从解压产物启动冒烟 → 核对 SOURCES 与 licenses 清单 → （公开分发前）完成上述两项审计。
