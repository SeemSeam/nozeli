# 发布说明与发行边界

当前版本基线：**`0.1.0-beta.9`**（Linux x64、macOS arm64 与 Windows x64 预发行候选，尚待同一提交的 CI 和三平台实包验收）。用户明确批准本版 Beta 公开预发行审计例外：SuperDoc/PPTist 与 Git、OMP 对应源码，Electron/Chromium 第三方通知，PPTist 传递依赖及 Pi 运行时闭包六项仍未签核，`--public` 继续阻断，不构成合规认证或稳定版授权。

## 三平台稳定版准备（2026-11-18，用户已确认）

目标为真正的稳定正式版，不通过Beta例外绕过分发审计。平台固定Linux x64、macOS arm64、Windows x64；不暗含Intel Mac或Windows ARM。当前源码版本仍为beta.8历史基线，不提前分配稳定tag、不修改已公开附件，不推送／开PR／上传或替换日常安装。

| 门槛 | 当前证据／缺口 | 完成标准 |
| --- | --- | --- |
| 统一源码及版本 | 本地主线已含三平台，远端main仍bf7483f | 一个最终产品提交；版本、package/lock、inventory、README、CHANGELOG、来源及三平台包内RELEASE.json一致 |
| Linux/macOS更新 | 实现保留，本轮仅共享逻辑和Linux限定烟测 | 最终原生包成功更新、启动失败回退、中断恢复、父退出竞态与草稿保护；Mac真实arm64运行，不拿Linux代替 |
| Windows更新 | 旧95d14e5仅手工安装；现用户授权VM直接补齐 | 真实Windows独立helper、原进程身份停稳、验证包、健康确认、回退／中断恢复、外部赢家／UNKNOWN不重放，全链路新包验收后才能开放支持 |
| 签名与分发 | Mac ad-hoc未公证；Windows unsigned | 准备正式签名与目标系统分发验证；需要所有者合法证书／账号权限，不自购／读取凭据或关闭系统安全检查 |
| 六项再分发审计 | 全部pending，历史Beta例外不能用于稳定版 | 各义务真实对应源码／通告／闭包证据及具名人工审核；未签收时public gate继续失败 |
| 三平台同提交资格 | Windows95d14e5限定通过，不是未来稳定包 | 三平台最终干净提交原生构建、真实解压程序保存／正常退出／冷恢复、业务及平台风险专项、checksum绑定，无旧包改名 |
| 远端合并与CI | 受保护main要求线性历史及CI gate | 先按权限准备线性候选并取得最终SHA必需CI；当前本地历史含merge提交，不能直接推入受保护main或改保护绕过 |

Windows执行已交VM原生Agent：在独立C盘95d14e5基线补自动更新和Windows稳定使用缺口，保留原N盘源码／profile／UNKNOWN／helper和旧包；仅确定性本地Provider，不付费推理。宿主负责回收源码、共享接口审阅和Linux/Mac消费者验证；VM完成不自动代表三平台签收。任务合同保留于主机 `project-migration/WINDOWS-STABLE-IMPLEMENT.md`，不是产品运行依赖。

实施顺序：Windows现有更新／安装合同与持久状态先明确 → 原生helper／切换／健康与恢复端到端实施 → 原生最终包专项 → 宿主合并与共享回归 → 所有者签名／审计门 → 冻结新版本并三平台同提交验收 → 当前明确授权后才发布。前述门未满足时只称“稳定版准备”，不得标stable/latest；能力缺口不能靠文案隐藏。

## Windows x64 本地整合（2026-11-18）

本轮授权：将 VM 最终源码本地合入 main、对齐 beta.8 并增加 Windows release 构建与校验入口；不推送、不开 PR、不改既有 tag／附件、不公开发布或替换日常安装。保留 `0.1.0-beta.8` 作为源码版本对齐，不冒充已发布 beta.8 的新增 Windows 资产。未来公开新提交必须另定新版本及获得当轮发布授权。

Windows 包必须由真实 Windows x64 从最终干净提交构建，包含独立 Node／Git／Pi、原生文件与进程组件及完整来源记录；最终 ZIP 的 RELEASE.json、校验和与实际解压程序须绑定同一提交。原 VM 候选中的真实任务闭环和 11/11 采用后测试是旧输入证据，不替代合并后原生构建、文件保存／正常退出／冷恢复及派工采纳验证。

在 `95d14e5` 基线中，Windows 自动更新明确不支持，手工安装／升级／回退沿原生安装工具执行。签名／SmartScreen、真实物理 IME／多屏、未知效果对账和旧 helper/home 完整释放资格按[Windows 清单](windows-w0-w5-qualification.md)逐项核验。六项分发审计仍 pending，历史 Linux/macOS 公开例外不覆盖 Windows 或未来版本。

本地完成结果：运行源码 `95d14e5` 已真实 Windows 原生构建并产出 `Nozeli-0.1.0-beta.8-windows-x64.zip`（415749370 bytes，SHA256 `71d6271a26dbf875266d84012c4c64336df59e54ff1a969bf608464138553bf1`），位于 VM `C:/NozeliValidation/release-95d14e5-20261118/`。独立解压包GUI7项、托管业务及安全14项通过；[完整记录](testing.md#2026-11-18-windows-本地整合验证限定通过未公开发布)。本地main后续文档提交不重标包内SHA、不移动现有beta.8 tag，也不将此本地候选当作公开Windows发行。

### Windows stable updater implementation contract (not yet qualified)

Windows VM 提交 `36a6ea0` 已实现原生自动更新，并构建出同提交的未签名 Windows x64 本地候选。解压启动烟测通过；安装验收在 900 秒后超时，未取得成功回执。此候选不构成合并后提交的原生验收或发布资格。

The Windows development branch starts from `95d14e594169fd9799b46f3ce12a1cc1562ec768`; its original ZIP and validation remain immutable. The observed baseline reports `UPDATE_PLATFORM_UNSUPPORTED` before creating update storage. This section specifies implementation and acceptance, not a supported flag or a release approval.

- **Authority:** the native manual installation owns `WINDOWS-INSTALL.json`, `WINDOWS-PROFILE.json`, `ACTIVE.json`, private root/profile FileIDs and the existing `.install-lock`. Updates use those same records and activation CAS; update progress/preferences/attempt/health remain in the existing updater record namespace. A launcher holding its original lock is not a stale lock to steal. Legacy manual installs remain valid and source checkouts remain check-only.
- **Selection and staging:** Windows x64 ZIP only; exact SemVer/tag commit, archive checksum, `RELEASE.json`, package version, complete candidate membership and native provenance must agree. A stable version excludes prerelease tags/flags. Dedicated credential-free Chromium networking retains its existing GitHub allowlist; loopback is host-test-only. ZIP rejects duplicate/case-fold collisions, reparse/link entries, traversal, reserved/alias paths, wrong architecture and replaced archive. Each Windows download uses a new private directory beneath `profile/desktop/updates` so the archive's retained read handle does not exclude writes to status or preferences. Candidate promotion remains on the owned installation volume with independently revalidated native FileIDs/digests.
- **Admission:** both automatic and explicit installation require shared lifecycle readiness: no unsaved document/composer/IME input, queued/running/unknown business effect, retained website form, active filesystem operation or unresolved recovery. Freeze, flush, then recheck; never save/cancel user work to make an update admissible. Inspection/download does not authorize activation.
- **Attempt states:** `prepared` binds token, parent incarnation, installation/active generation and digest, source version/commit, candidate version/commit/digest and private identities. `helper-ready` requires the independent bundled runtime to retain the original parent process HANDLE and original installation authority before main may quit. `promoting` is persisted before the `ACTIVE.json` CAS; `awaiting-health` binds the new active generation and actual child incarnation. `complete` requires a renderer-ready acknowledgment matching the original token, exact version/commit, selected payload and child identity. Each transition is a compare-and-swap against the prior attempt; a lost publication reply remains UNKNOWN for the issuer.
- **Receipt contention:** Native readers and transactional writers can briefly refuse one another with `ERROR_SHARING_VIOLATION`. Updater JSON access waits briefly without relaxing handle sharing. Each write retry uses the same expected raw digest; digest conflicts, failed commits, and uncertain cleanup are never retried.
- **Cancellation before promotion:** the helper checks the native private, token-bound cancellation receipt while waiting for the parent and again after the exact parent HANDLE signals exit. A missing receipt permits progress; a valid receipt stands down; malformed or unreadable evidence stops the attempt before lock acquisition.
- **Failure and restart:** kernel-observed original parent HANDLE exit permits activation, including exit during identity inspection; an unprovable/live/reused process never does. No PID-name kill or timeout-based ownership inference. Failed startup rolls back only active binary selection via the exact expected generation, preserving profile and documents. A concurrent activation winner is retained and blocks rollback. Interrupted download/stage never activates; interrupted `promoting`/`awaiting-health` reconciles exact old/new activation receipts and original process facts, never repeats unknown business. A failed version is quarantined from automatic retry until an explicit check; no restart retry loop.
- **Official restart custody:** the installer corroborates the attempt and compares its raw record digest through the held native delete lease. It authorizes recovery with a compare-and-swap against the same journal bytes it validated and removes the attempt without releasing custody in between. The relaunched app recognizes the replacement launcher lock by its exact directory FileID, not by a sharing error alone. Recovery of the still-selected promoted version waits for the real renderer-ready acknowledgment; it does not replay activation.
- **Synthetic crash fixtures:** A crash is injected only when the installation-bound test record explicitly names the transition phase or stage. An omitted hook is inert even when the transition has no stage.
- **Acceptance:** fresh source-bound native packages and extracted GUI journeys must prove healthy upgrade, startup-failure rollback, interrupted switch/restart, parent-exit-during-identity-check, foreign winner and unsaved draft refusal, failed-version quarantine and tampered/wrong-platform refusal. Synthetic test versions must identify real source commits and real manifests, not renamed baseline packages. Linux/macOS affected contract regressions remain required; signing, SmartScreen, physical IME/multiscreen and power-loss durability are separate gates.


## 版本状态

- **beta.8当前授权与门槛（2026-11-16）**：用户在六项待签收分发义务披露后明确授权beta.8公开Beta预发行例外，覆盖Linux x64＋macOS arm64；不沿用旧版授权，不构成合规认证、稳定版/latest或日常安装授权。六项义务仍pending，`--public`仍阻断。最终单一提交须完整CI成功，两平台最终解压包须真实启动、编辑保存、正常退出及冷恢复，并覆盖更新成功、失败回退／中断恢复及父退出竞态；最终包的RELEASE.json与附件校验和须绑定最终交付SHA，不用旧证据替代。Mac仍仅ad-hoc签名、无Developer ID和公证。旧Beta7及更早tag与附件保持不变。
- **beta.8升级路径**：Linux仅规范化发行副本特殊权限，保留执行位，不改宿主sandbox或放宽旧extractor安全拒绝；旧Linux版可更新到beta.8。Mac按平台选择arm64 ZIP，校验签名与bundle后同卷暂存，由独立捆绑helper在父进程正常退出后复核并原子交换.app，保留previous，以新renderer回执确认健康，失败回退并恢复中断。旧Mac没有此更新器，首次须手动安装beta.8，此后才支持未来自动升级；不得把“新版本支持”写成“旧Mac可自动升至beta.8”。
- **既有证据不等于最终资格**：此前Linux本地真实更新／回退旅程及[原生Mac运行43821746428](https://github.com/SeemSeam/nozeli/actions/runs/43821746428)在`a838a64a2de2656265f936f3d60982e997e37988`的成功升级、启动失败回退／中断恢复均已有记录（见[测试记录](testing.md)）。原生实跑发现并修正握手前完整bundle复核耗时及身份快照期间父退出竞态：复核在父退出后、交换前执行，内核确认退出视为停止，仍拒绝活跃身份变化与未知归属。这些是旧源码阶段已验事实，不是beta.8最终SHA的必需CI或最终双平台归档资格。

- **beta.7授权与门槛（2026-11-15，历史记录）**：用户在当轮六项待签收义务披露后明确选择beta.7公开Beta预发布例外，覆盖Linux x64＋macOS arm64；不沿用旧版授权，不构成合规认证、稳定版/latest或日常安装授权。公开审计仍失败六项。当时要求最终单一提交完整CI成功、两平台解压包真实保存／正常退出／冷恢复及新增管理助手／显式恢复路径验收；已发布结果见本页末尾记录，不充当beta.8资格。Mac仅ad-hoc签名、无Developer ID和公证；旧tag与附件不变。

- **beta.6当前授权与门槛（2026-11-13）**：本轮再次披露六项人工分发审核仍未签收、Mac仅ad-hoc签名且未公证后，用户明确授权公开 beta.6 预发行（Linux x64＋macOS arm64）。此为本版本公开例外，不沿用Beta5授权、不记作合规签收，不标稳定版或latest，未授权替换日常安装。`--public`继续如实失败；本版自身包含CI/workflow与测试矩阵选择器变更，其资格运行按full分类执行，不宣称targeted提速，发布时长以发布实际结束计（计时起点2026-11-13T08:04:06Z）。受保护main精确提交CI与Linux/macOS arm64实际构建／解压验收须在本版提交上运行并记录后才算通过，本页不预填结果，通过后再上传并逐字节核对双平台附件；独立扩展市场／官网Demo仅为文档原型。
- **beta.5当前授权与门槛（2026-11-13）**：本轮再次披露六项人工分发审核仍未签收、Mac仅ad-hoc签名且未公证后，用户明确授权公开 beta.5 预发行（Linux x64＋macOS arm64）。此为本版本公开例外，不沿用Beta4授权、不记作合规签收，不标稳定版或latest，未授权替换日常安装。`--public`继续如实失败；受保护main精确提交CI与Linux/macOS arm64实际构建／解压验收须在本版提交上运行并记录后才算通过，本页不预填结果，通过后再上传并逐字节核对双平台附件。本轮内存／设置UI／优化在途改动已随实包Linux验收覆盖；native资格以最终CI为准，不提前宣称通过。

- **beta.4当前授权与门槛（2026-11-12）**：本轮再次披露六项人工分发审核仍未签收、Mac仅ad-hoc签名且未公证后，用户明确授权公开 beta.4 预发行（Linux x64＋macOS arm64）。此为本版本公开例外，不沿用Beta3授权、不记作合规签收，不标稳定版或latest，未授权替换日常安装。`--public`继续如实失败；受保护main精确提交CI与Linux/macOS arm64实际构建／解压验收须在本版提交上运行并记录后才算通过，本页不预填结果，通过后再上传并逐字节核对双平台附件。

- **beta.3当前授权与门槛（2026-11-11）**：本轮再次披露六项人工分发审核仍未签收、Mac仅ad-hoc签名且未公证后，用户明确选择“授权公开 beta.3 预发行”。此为本版本公开例外，不沿用Beta2授权、不记作合规签收，不标稳定版或latest，未授权替换日常安装。`--public`继续如实失败；先完成低风险瘦身、当前功能保持、受保护main精确提交CI与Linux/macOS arm64实际解压验收，再上传并逐字节核对双平台附件。

- **beta.2当前授权与门槛（2026-11-11）**：用户在得知六项分发审计仍未签收后，追加明确授权公开 Linux x64 与 macOS arm64 的本版 Beta 预发行及附件；此为本版权限，不沿用beta.1/alpha.6授权，不记为法律或合规签收，不标稳定版或latest，且未授权替换日常安装。六项义务仍pending，`--public`保持失败。本版Linux冻结安装真实旅程已通过（见[测试记录](testing.md#图示校验错误与原work自恢复2026-11-10)与[审核讨论恢复](testing.md#已交付成果仍无法审核讨论2026-11-11)）；确切提交CI、两平台源码tar一致性与macOS arm64实际构建／解压运行须由发行工作流在本版提交上运行并记录后才算通过，本页不预填结果。mac仍仅ad-hoc签名（见下述macOS分发边界）。

- **beta.1授权与门槛（2026-11-10，上一版历史记录）**：用户在得知六项分发审计仍未签收后，追加明确要求“发布”，授权公开 Linux x64 与 macOS arm64 的本版 Beta 预发行及六个附件，取代此前只准备草稿的限制；不沿用alpha.6授权，不记为法律或合规签收，不标稳定版或latest。六项义务仍pending，`--public`保持失败。产品提交`17209df`已合main，main完整CI及Mac原生打包／解压运行均通过；两平台源码tar逐字节一致，独立下载原件的哈希及包内提交绑定已验证。后续文档提交不改产品tag和附件；公开后再次核对远端状态与字节。
- **macOS分发边界**：本轮目标为Apple Silicon arm64，使用真实macOS构建原生模块并验证独立包内Node／Git／Pi。只提供ad-hoc签名，不含Developer ID或Apple公证，Gatekeeper可能拒绝；不把绕过系统安全检查作为普通安装前提。beta.8新增原生自动更新路径，旧Mac首次仍须手动安装beta.8后才支持未来自动升级，最终资格须按上述门槛实测。未提供Intel Mac包，不声称九格式完整显示矩阵、跨DPI／所有原生像素及强杀进程树全覆盖。

- **alpha.6当前所有者授权**：2026-11-08用户获知六项分发义务未签收、`--public`失败后，明确授权alpha.6公开Alpha预发布例外。仅此版本有效，不构成合规认证，不宣称公开审计通过。需确切提交CI、干净源码打包、解压实际ELF冒烟及远端附件校验后才发布。候选包含稳定报告记忆、任务工作区与任务内对话、生命周期恢复/重置、原生技能初始化和初始页/网页栏精简；仅Linux资格，不外推Windows/macOS、200%完整应用可用性或真实磁盘硬件故障。

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

- 2026-11-05 用户要求“安装复测通过后commit，两个修复分别测试”：current 激活 `2026-11-05T10-28-25-750Z`，previous 保留 `approval-ux-batch4-20261105-local-01`。761 个 src/dist 冻结摘要一致；实际安装 ELF＋包内 Node/Pi/Git 的自动 DEBUG／持久报告和同回合读取纠正／真实候选发布／明确接受合入分别 6 项通过、各自正常 exit0，证据分别为 `/var/tmp/nozeli-installed-debug-activation-y0xkE7/report.json`、`/var/tmp/nozeli-installed-read-protocol-correction-dIpKZV/report.json`。DEBUG 使用明确标记的单次宿主故障注入，读取纠正为真实工具路径；无日常项目操作、安装字节热改或业务重放。见[分项安装验收](pi-integration-execution.md#两项修复分别安装复测2026-11-05用户授权)。未推送／公开发布或取得跨平台资格。

- 2026-11-05 用户要求真实安装测试批准及其他停顿场景，并裁决权限请求只提醒、回原对话授权，不写权限报告。最终 current `2026-11-05T14-24-44-086Z`、previous `2026-11-05T14-11-04-047Z`；762 个 src/dist 输入一致。实际安装 ELF 的对话授权／管理员拒绝／带未发送草稿继续／Worker 暂停后批准及恢复（6 项）和冷重开方案反馈／旧版本拒绝／暂停续作／明确接受合入（12 项）分别通过、正常 exit0。安装验收发现的草稿阻断已批准续作已修复、重新安装实跑通过。证据和模拟边界见[安装版授权与停顿场景](pi-integration-execution.md#安装版授权与停顿场景2026-11-05按用户最新权限交互验收)。未提交／推送／公开发布，无真实 root 或付费模型验收。

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

CI生成的`sbom.cdx.json`来自`npm sbom --package-lock-only --sbom-format cyclonedx --omit dev`，仅为锁定npm宿主生产依赖清单。Beta3将已编译前端依赖归为构建期，因此另保留实际esbuild输入生成的`frontend-bundled-notices.json`（发行包内为`BUNDLED-NPM-NOTICES.json`及逐包/版本通告），不能因dev标记就把已编译前端代码排除出来源核对。两者仍不包含完整Electron/历史OMP原生二进制、手工vendor或字体闭包；须与compliance inventory互补，不是完整发行物SBOM、来源签名或许可证签收。

## 维护者发布技能

[nozeli-github](../dev_tools/skills/nozeli-github/SKILL.md) 保存本项目的提交、受保护PR合并、版本/tag/默认分支一致性、便携包实测、GitHub附件发布及中断恢复流程。安装到用户级系统OMP的 `~/.omp/agent/skills/nozeli-github` 后可跨会话使用；这是开发维护技能，不是产品运行依赖，不发布npm包。

只读检查器：`python3 dev_tools/skills/nozeli-github/scripts/check_release_state.py --phase prepare`；提交推送后用 `--phase dev`，未公开草稿用 `--phase draft --assets-dir <双平台附件目录>`，发布后用 `--phase published --assets-dir <发行物目录>`。安装副本支持 `--root <仓库目录>`。检查器不提交、不推送、不发布、不重跑CI，也不将待审计状态当作已签收。

公开附件沿用 `USAGE.zh-CN.md`：打包器生成的 `使用说明.md` 保留在包内，外部发布前复制为ASCII文件名并将SHA256SUMS对应条目绑定到该文件名。GitHub会把纯中文上传文件名规范化成 `default.md`；应核对实际远端名称，不能仅凭上传命令成功认定一致。维护技能／烟测工具在tag后单独修补时，不移动产品tag，不重写原便携包的提交绑定。

### 双平台草稿构建

- 在各自原生平台、同一干净提交准备锁定 npm／Pi 依赖与 PPTist／Pi 构建；Linux x64 用 `node tools/package-portable.mjs <绝对新目录>`，macOS arm64 用 `node tools/package-macos-release.mjs <绝对新目录>`（均从 `apps/desktop` 执行）。输出目录须独占新建，不覆盖旧候选。
- mac 打包器重建原生模块与 renderer，将版本／提交／平台及 ad-hoc 未公证事实写入签名密封的 `Nozeli.app/Contents/Resources/RELEASE.json`，再制作 zip；解压后检查签名、架构、包内 Node／Git 与 plist。Gatekeeper 的本机评估如实记录，不要求禁用系统安全检查。
- `.github/workflows/macos-release-draft.yml` 在 `release/beta1-**` 候选分支运行原生构建与实际解压程序烟测；Linux CI 的同类分支也打包并实测解压后的二进制。两者仅保留7天 Actions artifacts，不上传公开发行。烟测使用 `NOZELI_TEST_BINARY` 指定实际程序，覆盖真实编辑／平台原生保存快捷键／正常关闭／冷恢复，不调用模型。
- 汇总时核对两平台同提交源码 tar 字节一致，保留 Linux `USAGE.zh-CN.md` 与 mac `USAGE-macos.zh-CN.md`，重算一个覆盖两包、同提交源码及两份说明的 SHA256SUMS。`release.platformsTargeted` 和 `platformsExercised` 的并集决定检查器必需附件；target 不是已通过声明，最终资格以各平台精确提交 CI／解压运行报告为准。
- `--phase draft` 要求草稿仍未公开、预发行标记正确、tag提交一致、该提交CI通过、两平台资产完整且校验和及包内提交绑定正确；公开审计门独立保留失败。未经本轮明确授权，不执行发布草稿、公开附件或标为 latest。

## 自动更新发布物契约（开发源码）

Linux x64 更新源固定为本仓库 GitHub Releases，使用 `Nozeli-<version>-linux-x64.tar.gz` 与 `SHA256SUMS.txt`；暂存包的 `RELEASE.json` 版本／平台／架构／提交须与精确 tag 一致，安装标记须 validated，包内须带真实二进制、renderer、更新帮助进程与解包worker。普通更新不调用系统 Node/npm/OMP、Bash、tar 命令或提权组件；归档依赖 `tar@7.5.22` 随程序分发。Pi 分支须同时保留随包 Node／Pi runtime 的完整闭包，不能以原 OMP 运行时替换。旧版缺少更新运行时的包不作不完整安装。

更新器在启用时后台检查下载，闲时安装重启；原程序先确认无未保存输入和在途／排队工作，保留现场并停稳，再由独立帮助进程切换用户级 current/previous 或便携目录。新程序须完成真实工作面健康确认；启动失败回退程序、不静默回滚用户内容，失败版本停止自动反复安装。源码运行和不支持的平台只检查，不替换源码。既有 alpha.3 归档没有检测器，须先正常安装含此功能的新构建；同步源码不移动 alpha.3 tag、不替换公开附件，也不构成安装或发布授权。校验和／tag 一致性不等同数字签名或合规签收。

开发源码更新修复（2026-11-11，尚未安装／发布）：桌面更新使用独立非持久 Chromium 网络会话，遵循桌面网络／代理，每一跳发送前检查 HTTPS GitHub／资产域名白名单，不复用浏览器账号或读取 GitHub 凭据。403/429 只有在响应头证实配额耗尽或 Retry-After 时才显示限流及恢复时间；普通 403 不推断原因，不绕过匿名 API 配额、tag 或校验和。

Linux 安装工具与便携打包显式创建私有目录，不再由 umask 0002 产生组可写布局。已存在的可写权限不被检测器或安装工具静默收紧；validated 安装若违反拥有者／权限／current 身份契约，明确报告失败并停止自动安装，不再冒称源码安装。存量安装需要所有者明确修复安装目录权限并装入修复构建后才能获得该行为，不能仅靠“立即检查更新”修复运行中的旧检测器。macOS／Windows 自动安装仍未实现。

## 快速发布运行绑定（2026-11-13，维护工具已实现）

`dev_tools/skills/nozeli-github/scripts/check_release_state.py` 增加 `--ci-run-id`，用于dev/draft/published绑定同仓库ci.yml在精确产品SHA上的成功运行。核对实时run详情、当前attempt、事件和五项必需job／gate；更晚完成的失败或取消阻断，错误SHA、fork、工作流、attempt及gate不能复用。默认不传仍核验最新运行。具体命令见同目录SKILL.md。

16个隔离fixture通过，包含主支重复运行仍in_progress时复用成功发行分支、拒绝新失败／取消及错误绑定。真实干净beta.5快照调用新检查器，以43345593857代替较晚的43349288387完成published＋本地双平台资产绑定检查，0技术失败；六项分发审计pending仍保留。脏开发树和缺upstream首次smoke明确拒绝，改用独立干净已推快照后通过，未放宽清洁检查。

发布顺序为最终SHA分支CI与双平台打包并行→下载已验同SHA原包→主支按原保护快进→绑定原成功运行检查→tag/draft/publish/远端摘要；无须因同SHA主支重复运行再等待或重建。此变更不取消后台重复workflow、不写成功status、不改保护、也未实施path-filter快速CI。第一次强制全套仍需原耗时，不承诺几分钟发布。仓库与本机skill已同步；本次未提交／推送维护改动，未改已发布beta.5标签／附件。

## 受影响测试矩阵（2026-11-13，源码实现，待远端部署）

本节后续实现了上一节尚未实施的增量CI：`apps/desktop/tools/ci-test-plan.mjs` 对可靠base..head完整差异生成full/targeted/docs计划，ci.yml按JSON选择unit/integration矩阵，并把计划artifact作为本次gate证据。unit完整跑；targeted只跑映射消费者integration，但Linux真实build/smoke与Mac native保留，发布五项资格job名称不变。纯docs可仅unit，不具备产品包发布资格。未知、高风险、删除／改名／新增非文档、CI/规划器变化均full。

首版精确映射仅collaboration-status.mjs/.css、project-attention.mjs/.css四个renderer叶路径；provider设置、agent、平台/存储/Git与共享core不缩矩阵。纯版本metadata需三文件结构白名单对比、四版本齐全一致及tag/URL绑定，落targeted并保留非空release-retention基线。依赖／平台／审计义务变化不能冒充版本更新。

release用最新非draft已公开v* tag完整差异；integration用origin/main分叉点完整差异防前序未验commit漏测，main用受保护before，PR用base到实际merge HEAD。事件payload字段来自可信文件、无shell ref拼接；缺基线/非祖先/查询失败/手动运行保守full或失败。gate总是存在，plan/tests必须成功，只有docs显式false才容许build/native skipped，并重读artifact核对outputs及head。

子集执行器复用原隔离环境/preflight/TAP，并按plan.base/head独立重算，拒绝篡改为另一已注册测试。24项分类纯逻辑＋真实Git CLI回归全部通过；生产workflow resolver提取后12个真实事件fixture通过；独立scratch提交只改collaboration-status.css，实际原integration消费者20/20通过（约4.7秒），篡改测试列表／base／head均exit2拒绝。scratch初次缺依赖未计通过；CLI回归原fixture在rename后新增映射文件应full，已修测试准备为恢复映射后真实修改，不放宽分类器。独立reviewer workflow及planner/runner最终均correct，仅静态复审。

## beta.7已发布（2026-11-16）

`v0.1.0-beta.7`已在`84101656e17b5287a0be63a7a9eb3008417d5382`公开为Linux x64＋macOS arm64 prerelease。精确CI `43736248023`、双平台最终包解压验收及远端附件SHA-256核对通过；发布页为<https://github.com/SeemSeam/nozeli/releases/tag/v0.1.0-beta.7>。资产含Linux便携包、Node debug symbols、macOS arm64包、源码包、双平台使用说明和校验清单。六项再分发义务仍pending，依据本版本明确Beta例外公开，不构成合规认证或稳定版；Mac无Developer ID／公证，Windows未验。
