# 发布说明与发行边界

当前版本基线：**`0.1.0-alpha.5`**（见[CHANGELOG](../CHANGELOG.md)与package.json）。精确提交由同名tag及发行包RELEASE.json绑定；产品构建、测试和分发审计分别记录，不互相替代。

## 版本状态

- **Alpha预发行（已发布）**：<https://github.com/SeemSeam/nozeli/releases/tag/v0.1.0-alpha.4>（2026-11-01 公开 prerelease）：Linux x64便携包、源码及SHA-256校验和，包含 Pi 原生账号与模型管理、持久模型切换、紧凑源/API管理、本地 HTML/HTM 网页视图与收敛的上下文交付。发布由仓库所有者明确要求；**发布不是合规认证**，下述分发审计仍未完成（此前 alpha.3 见 CHANGELOG）。
- **Alpha预发行 `v0.1.0-alpha.5`**：仓库所有者已于 2026-11-04 明确授权将其公开发布为 Alpha prerelease——这是针对下述六项未签收义务的当前所有者 Alpha 例外，不构成合规认证。本轮内容：前台唯一主对话＋显式“提交后台”入口、紧凑 F/O/W 协作状态、有界文档读取、主控内部故障归系统处理、版本绑定审核历史、空交接连接恢复，及有界任务板／空闲原生 Agent 回收（见[CHANGELOG](../CHANGELOG.md)）。授权的发布流程：常规回归与所需 CI 通过 → 便携包构建 → 解压产物实际启动冒烟 → 校验和核对 → 创建同名 tag 与 GitHub Release；最终发行状态与附件以 [GitHub 发布页](https://github.com/SeemSeam/nozeli/releases/tag/v0.1.0-alpha.5)为准，未出现在该页面前不视为已发布。第三方对应源码、二进制通告及完整分发审计仍未签收。
- 本版本为 **Alpha 审阅候选**：供源码审阅、跟进开发与 Linux 本机验证使用。
- 验证状态：**Linux x64／Wayland 与 X11/XWayland 本机验证**通过（阅读、批注、编辑、后台协作工作流与本机安装循环；本次剪贴板与快速切换专项为X11/XWayland）。**Windows／macOS 为产品目标平台，未验证**；安装与打包工具当前仅实现 Linux。
- 空工作台四项推荐功能引导（批注与选区讨论、任务闭环、分屏阅读、独立窗口）已包含在本版本中。
- AI 能力需用户自行配置模型源与账号；发行物不含任何凭据、用户项目数据或个人会话。
- alpha.4 本轮本机验证（2026-11-01）：默认回归完成，集成测试 1519/1519；renderer 与 Pi runtime 构建成功。真实用户级安装为 `2026-11-01T01-02-12-605Z`，previous 保留 `2026-10-31T11-17-44-818Z`。隔离合成项目真实 Electron/Wayland 验证打开文件、编辑写回磁盘及正常退出 0，原件 `/tmp/nozeli-alpha4-smoke-SRtdV4`；不是便携包解压验收。旧 `installed-open` 与 `installed-real-project-files` 驱动分别受旧单页面假设、启动页面竞态影响未通过，不计作通过。哈希检查通过；`--public` 仍因六项未签收义务失败，未声明合规或跨平台通过。
- 2026-11-03 用户明确授权“替换安装、真实测试”：本机 current 已激活 `review-actions-20261103T073450Z`，previous 保留 `2026-11-03T03-11-11-684Z`。此冻结包包含成果实际效果／前后对比、醒目审核卡片和准入确认计时修复；Reviewer 最终源码评审通过，24 项审核定向测试通过，确切包的桌面／654px／390px 操作、取消确认、本地意见不派工及返回正文焦点已运行；原 profile 使用安装 ELF 实际启动通过。原用户第 9 版已有 accept／ended、技术收尾 blocked，验证未重试合入或改写决定。详见[测试边界](testing.md)。这是本机开发快照替换，不发布 tag／GitHub Release，不声明全量或跨平台通过。
- 后续用户明确要求开发完成后安装并基于 Liuhuaiyu 复测：最终 current 为 `durable-review-20261103T091200Z`，previous 保留 `durable-review-20261103T090135Z`。真实 `~/.local/bin/nozeli` 系统入口启动、原 profile／原项目报告、正常退出及同版重启通过。复测补正旧 cancelled 提醒导致 closing 当前报告被误标历史／取消的展示；19 项 inbox／记录回归通过后重新冻结、安装并复测。第 9 版现为 closing／blocked、无 endedAt，原确切审核决定与38条job保持；业务源文件指纹未变。阻断仍为含用户输入覆盖的 `binary-stars.html` 需核对，不冒充已合并。详见[最终安装复测](testing.md)。未公开发布、提交或推送。
- 用户随后明确授权“安装后用复杂任务重新测试”：最终 current 为 `2026-11-03T12-56-26-197Z`，previous 为 `2026-11-03T12-41-53-640Z`。首装包的真实复杂 GUI 验收发现“未初始化 AI 时重启不自动完成已确认收尾”，已补宿主独立启动恢复、真实回归通过后重新冻结安装。最终包正常冷启动在打开项目之前即完成原故障 Work，零模型初始化、零技术重试；五文件／人工稿／无关暂存保护、故障 repaired/event completed 实测通过。真实 GLM-5.3 多模块 CLI 两轮实现与独立 oracle 在首装包通过；两包 src 差异仅 startup 的 main.cjs、managed-projects.mjs，最终包再验证该真实任务历史／原生 guest、ended/complete、无重放。最终包六类复杂宿主故障／并发矩阵 6/6。详细版本、模拟边界及原件见[复杂安装验收](testing.md#安装后复杂真实任务与故障验收2026-11-03)。未发布／提交／推送，不声称完整默认或跨平台验收。
- 2026-11-03/04 本机安装链（用户授权安装与实测，均未发布）：current `2026-11-03T17-14-57-747Z` 完成真实模型系统验收——90,023 字节需求文档两次有界读取并明示未读全文、GLM-5.3 两轮数值 CLI 与独立 oracle 69/69＋4/4、离线预约 Web 应用两轮独立判卷（47／70项）、六类原生宿主故障矩阵 6/6；current `2026-11-04T00-46-19-337Z` 为已接手空线程连接修复安装，原日常 profile 实窗验证连接 ready、无业务重放，非空旧线程仍需真实协议接手。紧凑 F/O/W 状态栏改版仍为源码，未包含于安装版。2026-11-04 的所有者授权只覆盖 alpha.5 公开发布，不构成新的本机安装授权；详见[测试边界](testing.md)。

- 2026-11-04 用户在普通引用文件／前后台气泡／主控交接流程修复后明确要求“安装”：本机 current 已切到 `conversation-flow-20261104-local-01`，previous 为 `2026-11-04T00-46-19-337Z`。这是本地开发快照，包含前述三轮修复及紧凑协作状态；未提交、推送或重新发布。独立冻结包756个src/dist文件与已验证源码逐字节摘要一致；实际ELF＋捆绑Pi／Git在隔离profile完成5项综合验收、exit0。安装期间未强退原日常进程、未取消用户任务；原进程随后已退出，再通过正常`~/.local/bin/nozeli`启动新版，真实exe及`NOZELI_DESKTOP_READY ... hidden=false debugPort=none`确认，未代发消息或操作业务成果。安装与验证原件见[测试记录](testing.md#本地安装对话与主控流程修复2026-11-04)。旧段“未安装”为当时源码阶段，不描述本次安装后的状态。

- 2026-11-04 用户在“全部Agent直接列出＋彩色状态”和“主控独立收尾”修正后要求“安装测试”：current已激活`orchestrator-closeout-20261104-local-02`，previous为`conversation-flow-20261104-local-01`。756个src/dist冻结输入SHA-256与最终源码构建一致。实际候选ELF＋包内Pi/Git的丢弃收尾、接受冲突保留人工文件→原绑定重试完成合入两条完整流程各8项检查通过、exit0（集合重叠不累计）；另包内组件62个Agent全列表／颜色／320px检查通过。旧日常窗口走原生正常关闭，无force或用户任务取消；新版通过标准CLI入口启动，实际exe及可见窗口核实，debugPort=none。未提交／推送／公开发布，见[安装测试](testing.md#全部agent与主控收尾安装测试2026-11-04)。

- 2026-11-05 用户明确要求“安装一下”：已激活`approval-ux-batch1-20261105-local-01`，previous保留`orchestrator-closeout-20261104-local-02`；CLI／桌面入口经原installer同步。该冻结包为首批已验审批对话＋阅读状态UX，不含后续agent1复审M1/M2/M4/M5迭代。实际冻结ELF＋包内Pi/Git在隔离项目8场景通过、9次本地脚本Provider、正常exit0，原件`/tmp/nozeli-approval-discussion-LFjxmw/report.json`；756个src/dist摘要与current/previous记录在`~/.local/state/nozeli-runtime-tests/approval-ux-batch1-install-20261105/`。未强退日常进程或代发用户业务，未提交／发布；后续源码仍需独立复审／安装授权。

- 2026-11-05 用户追加要求“记得安装和commit”：已按既有冻结／激活流程安装`approval-ux-batch2-20261105-local-01`，previous保留`approval-ux-batch1-20261105-local-01`。实际该候选ELF通过中文X11正文＋讨论同帧、收起重开草稿、人工直接编辑保存→采用→精确合入／ended，6次回环脚本Provider、零付费模型、正常exit0，原件`/tmp/nozeli-ux-batch2-zh-G7r6ZE/report.json`。本地提交只覆盖审批与UX相关改动，其他在途改动保留；不push、不打tag或公开发布。没有强退日常窗口或操作用户业务。

## 分发审计状态：未完成

分发审计状态：未完成。已公开的预发布不因附件 `使用说明.md` 中的“供本机使用”声明或本页免责说明而解除下列义务；免责声明不构成义务履行。逐项状态以 [compliance-inventory.json](../apps/desktop/compliance-inventory.json) 为准（含 pinned 版本、哈希与证据路径）；本页与其不一致时，先修正文档再发布。签收必须是具名人工记录（审核人、日期、结论、证据），不能用状态标记或脚本输出替代。

未完成义务（与清单 `obligations` 一一对应）：

1. **AGPL vendor 对应源码**：发行物内含 AGPL 许可的压缩（minified）产物 `vendor/superdoc-1.47.1` 与构建产物 `vendor/pptist/dist`。对应完整源码的提供与核验尚未签收；仅提供本仓库源码归档或上游 URL 不自动满足 AGPL 对应源码义务。仓库已保留可核验来源（SuperDoc npm 完整性与文件哈希见 `vendor/superdoc-1.47.1/SOURCES.json`；PPTist 上游归档 `vendor/pptist/upstream.tar.gz`，tar 内容 SHA-256 `f23dfaf45708a1cf04cabaa08077a16e00c2b5244e76d6821df56265a1c67c81`）。
2. **Git 二进制对应源码**：捆绑的 Git 2.53.0（GPL-2.0，经 dugite-native v2.53.0-4098283 分发）需为再分发二进制整理并提供完整对应源码与通告（含原生发行版内置库）。
3. **私有 OMP 运行时对应源码**：随包分发的编译版私有 OMP 运行时需随发行物提供配方式重建的对应源码包（上游 commit、三补丁、锁文件与 native addon 摘要），并核验 Bun 运行时通告覆盖（`BUN-LICENSE.txt`、`THIRD-PARTY-NOTICES.txt`）。
4. **Electron/Chromium 二进制通告**：逐发行物核验 `LICENSES.chromium.html` 等第三方通告的存在与完整并记录核验结果。
5. **PPTist 传递依赖审计**：`pptxtojson`、`pptxgenjs`、`hfmath` 及其传递闭包（含字体/资源）的再分发审计未完成。
6. **Pi 运行时闭包来源记录**：随包分发的 Pi 会话运行时（integrations/pi 闭包）需在分发前记录确切 vendored pi-gui 文件摘要与 pinned `@earendil-works/pi-coding-agent` 1.4.0 依赖锁定并核验，比照私有 OMP 运行时的来源标准；尚未签收。

本次技术审查未观察到凭据／用户数据混入，运行时清单已补记实际导入的 HTTP observer。Pi 新增0005补丁严格可往返；完整补丁系列重构45/46文件与上游逐字节一致。既有0004补丁格式计数／分隔问题，以及session-supervisor两行注释重排的来源缺口仍保留为未签收审计事实，未通过修改状态或伪造具名签收消除。它们不改变本次可运行构建的哈希核对，但不构成完整对应源码审计通过。

上述六项义务仍未签收；仓库所有者 2026-11-04 再次明确授权 alpha.5 公开 Alpha 预发行，但这不等于审计完成，也不能用免责声明替代义务。`node tools/check-repository.mjs --public`仍保持失败（如实列出全部阻塞项）；本次是所有者明确发布决定，非该检查通过，不自动推广为稳定版本或后续发行授权。

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

公开附件沿用 `USAGE.zh-CN.md`：打包器生成的 `使用说明.md` 保留在包内，外部发布前复制为ASCII文件名并将SHA256SUMS对应条目绑定到该文件名。GitHub会把纯中文上传文件名规范化成 `default.md`；应核对实际远端名称，不能仅凭上传命令成功认定一致。维护技能／烟测工具在tag后单独修补时，不移动产品tag，不重写原便携包的提交绑定。

## 自动更新发布物契约（开发源码）

Linux x64 更新源固定为本仓库 GitHub Releases，使用 `Nozeli-<version>-linux-x64.tar.gz` 与 `SHA256SUMS.txt`；暂存包的 `RELEASE.json` 版本／平台／架构／提交须与精确 tag 一致，安装标记须 validated，包内须带真实二进制、renderer、更新帮助进程与解包worker。普通更新不调用系统 Node/npm/OMP、Bash、tar 命令或提权组件；归档依赖 `tar@7.5.22` 随程序分发。Pi 分支须同时保留随包 Node／Pi runtime 的完整闭包，不能以原 OMP 运行时替换。旧版缺少更新运行时的包不作不完整安装。

更新器在启用时后台检查下载，闲时安装重启；原程序先确认无未保存输入和在途／排队工作，保留现场并停稳，再由独立帮助进程切换用户级 current/previous 或便携目录。新程序须完成真实工作面健康确认；启动失败回退程序、不静默回滚用户内容，失败版本停止自动反复安装。源码运行和不支持的平台只检查，不替换源码。既有 alpha.3 归档没有检测器，须先正常安装含此功能的新构建；同步源码不移动 alpha.3 tag、不替换公开附件，也不构成安装或发布授权。校验和／tag 一致性不等同数字签名或合规签收。
