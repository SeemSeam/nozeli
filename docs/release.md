# 发布说明与发行边界

当前版本基线：**`0.1.0-alpha.3`**（见[CHANGELOG](../CHANGELOG.md)与package.json）。精确提交由同名tag及发行包RELEASE.json绑定；产品构建、测试和分发审计分别记录，不互相替代。

## 版本状态

- **Alpha预发行**：<https://github.com/SeemSeam/nozeli/releases/tag/v0.1.0-alpha.3>，包含Linux x64便携包、源码及SHA-256校验和。修复快速切换、系统文本复制、原生工具升级重连与失位标签操作，新增原生文件粘贴、折叠审核列表及强退；默认YOLO与后台主控恢复的权限边界见[用户指南](user-guide.md)。发布由仓库所有者本轮明确要求；**发布不是合规认证**，下述分发审计仍未完成。
- 本版本为 **Alpha 审阅候选**：供源码审阅、跟进开发与 Linux 本机验证使用。
- 验证状态：**Linux x64／Wayland 与 X11/XWayland 本机验证**通过（阅读、批注、编辑、后台协作工作流与本机安装循环；本次剪贴板与快速切换专项为X11/XWayland）。**Windows／macOS 为产品目标平台，未验证**；安装与打包工具当前仅实现 Linux。
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

上述义务仍未签收；仓库所有者明确要求公开Alpha预发行并不等于审计完成，也不能用免责声明替代义务。`node tools/check-repository.mjs --public`仍保持失败以如实列出阻塞；本次是所有者明确发布决定，非该检查通过，不自动推广为稳定版本或后续发行授权。

## 打包与验证入口（摘要）

- Linux 便携包：`node tools/package-portable.mjs <绝对输出目录>`（要求源码树已全部提交）；本机用户级安装：`node tools/install-local.mjs`。
- 常规回归不发起付费模型请求；真实模型检查一律显式启用并由授权者自行运行。
- 发布检查顺序：全部常规回归通过 → 构建便携包 → 从解压产物启动冒烟 → 核对 SOURCES 与 licenses 清单 → （公开分发前）完成上述审计并写入签收记录。

## 持续集成与发布检查

每个PR及main推送触发Linux `CI`：确定性unit/integration、干净固定输入构建（Office／OMP／renderer）、Xvfb下真实Electron烟测及统一`CI gate`。日志/TAP/合成截图只保留有限天数，失败不使用continue-on-error放行；profile和数据库不上传。

`Release candidate check`通过workflow_dispatch接受已存在且版本匹配的tag，验证测试/构建/烟测和公开发行元数据门，不自动上传公开包。旧tag如果缺少新检查工具会明确失败，不能把当前main检查冒充旧包验证。

CI生成的`sbom.cdx.json`来自`npm sbom --package-lock-only --sbom-format cyclonedx --omit dev`，是锁定npm生产依赖清单，不包含完整Electron/OMP原生二进制、手工vendor或字体闭包。它与compliance inventory互补，不是完整发行物SBOM或来源签名，也不代表许可证审计通过。

## 维护者发布技能

[nozeli-github](../dev_tools/skills/nozeli-github/SKILL.md) 保存本项目的提交、受保护PR合并、版本/tag/默认分支一致性、便携包实测、GitHub附件发布及中断恢复流程。安装到用户级系统OMP的 `~/.omp/agent/skills/nozeli-github` 后可跨会话使用；这是开发维护技能，不是产品运行依赖，不发布npm包。

只读检查器：`python3 dev_tools/skills/nozeli-github/scripts/check_release_state.py --phase prepare`；提交推送后用 `--phase dev`，发布后用 `--phase published --assets-dir <发行物目录>`。安装副本支持 `--root <仓库目录>`。检查器不提交、不推送、不发布、不重跑CI，也不将待审计状态当作已签收。
