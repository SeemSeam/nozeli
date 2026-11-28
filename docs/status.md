# 当前状态与能力边界

当前源码基线：`0.1.0-beta.10` 候选，目标 Linux x64、macOS arm64 与 Windows x64；下列旧版本验证不替代候选版本资格。

## 2026-11-18 Windows 本地整合（完成，未发布）

用户授权将虚拟机最终开发状态本地合入 main，并补 Windows release 支持；不推送、不创建公开发行、不替换日常安装。统一产品版本保持 `0.1.0-beta.8`，保留 beta8 的 Linux/macOS 更新器和显式 TeX 编译补丁。VM 源码由 `cb07c51` 加最终未提交修改导出，隔离导入提交 `a04a4dd`；原 VM 文件及本机管理助手未提交改动均不改写。

原 VM 安装版真实模型成果采用记录（四文件合入、Work ended／closure complete、quota=0、采用后11/11测试）保留为历史候选证据，不替代本轮整合后的限定验收。

最终运行源码 `95d14e5` 已本地合 main；真实 Windows 新编原生组件及发行ZIP、独立解压21943文件一致性、可见GUI保存／正常退出／冷恢复7项、托管业务与CAS／UNKNOWN／Job／ACL限定14项全部通过。包位于 `C:/NozeliValidation/release-95d14e5-20261118`，完整命令、SHA256及限制见[测试记录](testing.md#2026-11-18-windows-本地整合验证限定通过未公开发布)。跨平台Pi构建输入已修复LF与cwd确定性，未放宽干净源码门。文档后续提交不改包绑定；旧UNKNOWN／个人配置和原未提交开发保持。Windows自动更新、签名／SmartScreen、物理IME／多屏与完整W0–W5仍不宣称通过。

## Windows VM 历史阶段记录（按原始日期保留）

2026-11-14 Windows VM 续作：当前目标已扩展为完整 W0–W5，不再以 v57 小范围通过为停止条件。官方签名 VS 安装器经主机监督真实 UAC 同意后补齐 Spectre14.44（exit0）；文件／进程组件保持 Spectre、CFG、SDL 实际构建。新源代码模型/auth 含异步递归拒绝、8MiB分块CAS、私密解析错误与证据目录实体约束；源码两宿主配置完整矩阵各94/94、Pi owner各56/56、Worker各2/2、archive-focused各2/2通过，Electron集成辅助18/18通过。此前应用选择器期间的 Electron 通过声明已作废，现仅计子进程实际报告身份的结果。原 archive-focused Electron 0/2失败输出保留，短临时根新fixture已通过；这些计数不代表独立v57包通过。

Windows chrome WebContentsView 随原生显示／隐藏／最小化／恢复／加载及内容视图重新挂接同步可见性；实际GUI证据从 hidden、无输入恢复为 visible、trusted键盘与点击。`source-gui-terminal-composition-order-v13`真实窗口五项通过：Job内Shell、Unicode／空格路径独立Node及文件oracle、Ctrl-C后原Shell继续、正常关闭原owner退出、冷恢复明确点击启动且不重放。保留xterm屏幕阅读模式，Unicode使用Chromium原生composition协议并等待其提交任务；不等于物理中文IME或多屏／设备资格。

原生 ConPTY 项目终端、工具 Job、独立强退线程、随包 Node 的语言服务，以及显式隔离目录的 Windows 手工安装／升级／回退已实施；CLI专项与真实窗口分别记证，不把源码存在或局部通过当整体完成。原 helper/home 释放、完整材料闭包、pending/default 托管入口和其余产品门仍未完成。正式基线v50、productionReady/goalComplete=false。当前[完整清单](windows-w0-w5-qualification.md)；实时JSON：`N:/dev-cache/windows-supervisor/goal-status.json`，证据：`N:/restored-20261112/nozeli-test/20261114-windows-goal`。旧D盘记录保留为历史，不是本VM实体custody。

本轮新增metadata原生消费／FileID与字节CAS／版本交接及原始stdio冷读取链；模型工具定义升级仍允许，竞争者和不确定发布保留。metadata／准入专项两宿主各58/58，私密解析canary有失败前／修复后证据；真实原owner冷链另行核对，未拿合成stdio夹具冒充实际owner。Pi／OMP显式隔离、reset恢复和初始化状态已补前置拒绝；拒绝专项各43通过、13个能力前提跳过，不计为Windows实现通过。真实GUI初始化重试先于配置门返回unsupported，随后普通终端五项仍通过。

独立v57-v1从已核验v56v2生成，ZIP SHA256 `906f77a43c751639cb5ab5f1d50adecc2b73ca403d2fb46a362e4e3ad9ffa6ef`。包内Node／Electron配置各94/94、启动／读取／CAS／冲突草稿／重启六项通过；执行后26111文件、18 native输出、32 native输入及6 SDK输出完整性通过。原包终端关闭15s超时仍保留，inspector诊断正常退出不替代该失败；当前metadata／拒绝修改晚于v1冻结，不能外推为v1已覆盖。隔离安装使用独立Unicode根，不替换日常安装。

上述owner56/56是metadata新增之前的原源码快照；后续完整owner最新Node／Electron各55/56，真实metadata冷链Node专项2/2已有证据，Electron专项仍有15s宿主准备及8s存储结果未知失败，保留原fence且未放宽期限。中断前包内Worker／archive只有started/TAP头，没有完成receipt，不计通过。当前11/11安装回归证明同步／异步原生未准入可保留草稿并显式回退；v1长路径及v3 PowerShell Join-Path失败均保留，新.NET Path.Combine修复继续真实安装验收。阅读／角色材料／强退由独占文件的task代理实现，主流程统一集成并实测，不将代理完成或语法检查当产品通过。

后续真实检查：Node原生文件／实体／CAS／安全／持久化72/72；Electron同组62/72，十项集中在独立PowerShell ACL夹具spawn入口，未跳过，已交task代理定位。冻结v4包metadata两宿主各58/58，Node拒绝组43通过／13能力跳过，资源11/11；v4安装新Unicode根已成功，完整生成启动器GUI仍待前台独占验收。生成启动器永久回归9/9运行真实PowerShell与固定Node，对长路径/非ASCII/篡改/重解析拒绝逐项记证；它不等于Electron产品验收。当前源码Electron真实owner metadata／角色原始stdio冷链专项2/2，不外推完整owner矩阵或释放资格。

默认源码桌面入口真实单次发送阅读验收`agent-reading-v9-source-single-submit-v1`七项通过：普通选项目／Markdown、精确Unicode批注与不可变材料、本地保存零派工、Ctrl+S独立文件oracle、未发送草稿、外部赢家冲突保留、完整重启与两次正常退出0。v4真实生成启动器完整校验后启动／偏好重启通过，完整载荷升级／显式回退保留原版本与全部profile字节；复用同一候选不冒充新版本迁移。默认ManagedProjects Work入口仍在实施与验收，显式Controller适配器通过不能替代它；不把可选sandbox拒绝扩展为普通功能拒绝，不直接翻绿全局能力。

强退v13仅部分通过：卡住renderer的原生对话框强退1761ms、四个原HANDLE后代退出、sentinel存活、冷恢复原赢家／草稿及正常关闭均通过；崩溃renderer强退观测14763ms超过8s检查，完整场景仍失败，继续记录调用／退出时间链定位，不从核心成功推整组完成。Spectre开发安装UAC已成功exit0，产品UAC通道/token/effect/ACL验收仍独立未完成。

后续独占前台`source-gui-forcequit-final-v18`完整八项通过：卡住／崩溃renderer原生对话框强退OS退出402ms／359ms、原HANDLE后代退出与独立sentinel存活、两种冷恢复精确草稿／赢家／终端显式启动及正常退出。v13的14.7s异常只记未重现、原因未定；inspector realm错误导致无法证明当时产品调用与OS退出的分界，不据此宣称全部旧失败均为driver问题。此证据仍非物理IME／多屏或最终包完整资格。

<!-- windows-v56-settings-cold -->
2026-11-12 Windows v56：配置读取证据增加记录/blob原生FileID链和stdout head身份；原host冷检查、完整home归档及独立只读读取器核对同一确认前缀，未确认尾部/孤立文件/历史流/旧schema明确保留UNKNOWN。源码Node/Electron完整Pi各56/56；四宿主配置9、冷读取19、真实冷owner替换拒绝及正常/ready丢回复归档专项通过，独立包资源/实际owner/Worker通过。正式v50基线保持；完整读取生命周期、models/auth/import/角色/metadata/journal、helper/home处置、pending/default及其余W0–W5产品发行门仍未完成。见[本批记录](windows-alpha6-settings-cold.md)。

证据 `D:\nozeli-test\20261112-alpha6-settings-cold\development-status.json`。最终v2 ZIP SHA256 `d0c7e682cbef5fa1c71bfaf8dbe3cd1bdbcf51467181f0fc6cc69771f28580b3`。
<!-- /windows-v56-settings-cold -->

<!-- windows-v55-settings-read-boundary -->
2026-11-12 Windows v55：SDK配置存储接入原生实际读取字节与FileID证据；项目优先级、迁移、dirty-field合并及reload保留，写入比较身份与字节后原子提交。源码Node/Electron完整Pi各56/56通过。独立包两宿主各配置9/资源技能11/读写23/替换ACL持久化49/进程25/实际owner6/Worker布局2通过，包与冻结输入核对通过。正式v50基线不变，完整恢复材料闭包、helper/home释放、pending/default及W0–W5产品发行门继续未完成。见[本批记录](windows-alpha6-settings-read-boundary.md)。

证据 `D:\nozeli-test\20261112-alpha6-settings-reads\development-status.json`。最终ZIP SHA256 `189565b3fcb6acd739a7aed3e9013d4762ec530531bc3f81727ca6f7fc8a554e`；43639文件、1793冻结输入及36项本轮重建native输入/输出核对一致。
<!-- /windows-v55-settings-read-boundary -->

2026-11-12 Windows v54：修复配置管理层在角色会话前自动执行项目JS扩展的提前加载链。可选driver资源策略保持上游默认行为和SDK项目模型设置权限，Nozeli owner提前过滤非发行包资源；显式空SYSTEM/APPEND来源避免先读后覆盖。最终源码Node/Electron完整Pi各55/55、provider回归各26/26通过；独立v2包两宿主各资源3/技能8/真实owner1/恢复意图3/显式续作2/Worker布局2通过。v50正式基线不变，完整W0–W5未完成。见[本批记录](windows-alpha6-runtime-resource-boundary.md)。

2026-11-12 Windows v53 原生恢复意图：通过私有native HANDLE和create-only发布续作栅栏，发布后失败保留UNKNOWN；恢复检查复用已确认journal字节。源码Node/Electron完整Pi各54/54；四宿主意图各3、实际续作各2，独立包Worker各2通过；ready丢回复4/4。新包完整性核对通过，v50正式基线、v53开发候选，完整恢复闭包/helper释放/pending/default和W0–W5仍未完成。见[本批记录](windows-alpha6-recovery-intent.md)。


2026-11-12 Windows journal 确认字节投影：原生 flush/read 的同一份字节严格解析后构建 SDK 内存视图，避免按路径再次读取及 SDK 自动迁移；损坏 UTF-8/JSON、重复身份和缺失父条目在本轮投影前拒绝。源码 Node/Electron 完整 Pi 各52/52、四宿主 parser4/Pi5/ready丢回复1、独立包两布局Worker各2通过；运行后包与冻结输入完整性核对通过，v50 正式基线不变。见[恢复材料设计及本轮实现](windows-recovery-material-closure-design.md)。

2026-11-12 Windows Git 路径资格：实际 commonDir、linked worktree 和数字冲突后缀在初始化/写证据前检查，UTF-16 边界保留中文长字节路径。源码/独立包 Node、Electron 四组路径专项各 11 项、完整 Work 生命周期各 31/31、ready 丢回复各 1/1 通过。新包独立核对，v50 正式基线、v51 开发中，完整 W0–W5 未完成。见[本轮记录](windows-alpha6-git-path-qualification.md)。

2026-11-12 Windows：D 盘恢复开发，源码 Node 冷归档矩阵 8/8、ready 丢回复四宿主、SQLite 四组各14和长文件路径四组各1实际通过。renderer 重建，新候选独立解压核对通过；深 cwd/worktree、一次 owner 启动失败及其他三宿主完整归档矩阵仍未完成。正式基线 v50、v51 开发中，完整 W0–W5 未完成。见[本轮记录](windows-alpha6-archive-resumed.md)。

2026-11-11 Windows v50：原owner home目录身份/ACL及父链在首次resume前交给helper，真实host退出后仍保持并约束cold journal/归档；修复伪造home重连在拒绝前的接收HANDLE清理，重复拒绝回归通过。完整恢复材料生命周期、归档协调、资源释放及默认入口仍未完成，见[本批记录](windows-alpha6-home-custody.md)。下文为历史。

2026-11-10 Windows v49：原inspection持久归档完整观察到的owner home、原helper三路stdio和账本；完整集合CAS intent/ready、独立摘要复核、并发赢家/丢回复UNKNOWN，原home/helper保留。正常归档后实际Controller启动和warm停止通过。原home全生命周期custody、完整恢复闭包、归档协调、资源释放及默认入口仍未完成；实际矩阵/包见[本批记录](windows-alpha6-cold-evidence-archive.md)。下文为历史。

2026-11-10 Windows v48：两次真实host死亡后第三共享Controller接管并启动两个resident；完整跨代原helper/launch-set/stdio/source与历史回执核验，旧retired Worker行及revision、paused/候选/草稿保持且零旧输入重放。源码/独立解压Node各8模式、Electron各3，详细实际矩阵与新包见[本批记录](windows-alpha6-repeat-cold.md)。旧资源释放、pending/default入口、完整W0–W5仍未完成；beta.1 main尚未整合。下文为历史阶段。

2026-11-10 Windows 单次冷接管：原受限anchor完整custody连续转移，一次性原inspection token和完整集合CAS接续精确原退休代次；共享Controller核对旧provider、竞争只一赢家并启动两个新resident，旧Worker interrupted／review／草稿保留且零旧输入重放。第二轮cold、资源释放、pending协调、默认入口与完整W0–W5仍未完成。原生文件／进程及renderer实编，新独立包与实际矩阵见[本批记录](windows-alpha6-cold-handoff.md)。远端main已推进beta.1增量，当前包仍固定alpha.6＋PR27。下文为历史阶段。

2026-11-10 Windows 原 host/owner 记录冷退休：精确 business hold 与原 anchor 领取后，同一 SQLite 事务比较五个完整集合，单调增加 host/owner 修订并保留原 generation 历史。退休后由原 inspection 内部绑定读入口继续核对原 journal；并发变化与提交后丢回复保留 UNKNOWN、不重试。记录退休已资格化，实际资源释放、新代接续、默认 ManagedProjects 与 W0–W5 仍未完成。当前包、实际矩阵和下一代设计见[本批记录](windows-alpha6-cold-retirement.md)。

2026-11-10 Windows 原 anchor 冷领取：协议v9／launch-set v2由原helper跨连接单向仲裁，只复制原文件对象的受限不可继承HANDLE，保留原写共享排他。managed入口先业务hold再复核原checkpoint／source／完整owner／kernel／journal／tool／business／pending；后检查变化或丢回复保留UNKNOWN、不重试。原host/owner未退休，新代与默认执行未开放，W0–W5仍未完成。当前包和实际矩阵见[本批记录](windows-alpha6-cold-anchor.md)。

2026-11-10 Windows 原中断业务待核对处置：显式原生custody／业务回执核验后原子中断精确Worker job，保留review／候选／草稿；共享重启、调度准入、激活与启动扫描尊重恢复门。同值修订赢家及提交后checkpoint／pending变化拒绝或UNKNOWN、不重试。仅限定无pending处置，owner退休／下一代／默认ManagedProjects与W0–W5完整资格仍未完成。当前包和真实测试范围见[本批记录](windows-alpha6-business-hold.md)。

2026-11-10 Windows 工具处理持久记录：显式 registered launch 在调用前先登记原工具身份，处理返回后持久精确结果，再向原 Pi 回复。冷检查区分未返回与已返回未送达，检查点前后复核 SQLite 原记录，缺行／并发赢家／UNKNOWN 不重放。正常文档修改和成果发布关联既有业务回执；业务 pending／projection／owner 冷接管与默认执行仍未完成。见 [本批记录](windows-alpha6-tool-custody.md)。

2026-11-10 Windows 强杀journal前缀：Pi启动／prompt／flush返回原生同步快照；宿主退出后核对原File ID与已确认前缀，保留未知尾部。工具效果已发生但未回复仍unresolved、不重放，文件／快照篡改拒绝。源码／解压Node与Electron各52项、cold各15项、Worker各2项，GUI各6项通过；业务冷接管与默认入口仍未完成。当前包见[本批记录](windows-alpha6-abrupt-journal.md)。

2026-11-10 Windows 原始请求／journal 冷核验：原始stdin、Pi返回、原生journal和输入摘要逐项匹配；缺回复保留execution-unknown，工具回复不等于业务完成。显式journal检查点在SQLite CAS前后复核metadata／journal，提交后变化保留UNKNOWN与外部赢家。源码／解压Node及Electron完整定向各47项、cold各15项、Worker各2项，GUI各6项通过；业务冷接管和默认入口仍未开放。当前包与边界见[本批记录](windows-alpha6-journal-reconciliation.md)。
2026-11-10 Windows 原生启动集合：每次启动意图先记入原生追加历史，supervisor保留只读mapping；原宿主退出后逐项核验完整历史、Job和原stdin/out/err。删除owner行／未完成意图／替代身份的真实回归均拒绝确认。仅原项目host lease的完整集合与进程停稳取得本批证据，业务冷接管和默认ManagedProjects仍未开放；当前包与实际结果见[本批记录](windows-alpha6-launch-set.md)。

2026-11-09 19:39（Asia/Shanghai）上游再次核对：GitHub 最新 alpha.6／已合并 PR27 与本地 HEAD `cb07c518` 一致，无新增上游增量需要合并；开放依赖升级未纳入基线。原始 API 和核对收据见[合并记录](windows-alpha6-pr27-merged.md)，当前包仍以[冷恢复前置记录](windows-alpha6-cold-checkpoint.md)为准。本次仅更新上游核对与文档，没有重建或重跑前批测试。

2026-11-09 Windows 冷恢复前置：原生 helper 现保留已观察且退出的后代 HANDLE，新冷连接可取得受限原实体；当前已登记 Job 的原流／来源检查点复用本机 CAS／UNKNOWN。完整宿主启动集合、任务接管与默认入口仍未完成；实际验证与当前包见[本批记录](windows-alpha6-cold-checkpoint.md)。

2026-11-09 Windows managed 分离目录接入：已验证原登记存储逐路径原生宿主／来源、跨根执行证据、隔离 Git 长 ref，以及真实 Controller／Pi／Git 的编辑、明确审阅接受、归档和 warm reopen。生产默认选择与冷恢复仍未开放；当前验证包、实际计数和路径 unsupported 边界见[本批记录](windows-alpha6-managed-roots.md)。

2026-11-09 Windows 新进展：正式外部启动已接入原生持久队列及实际文档显示确认，冷恢复不重放；四宿主各179通过/0失败/1跳过，源码/解压生产GUI各8项通过。完整边界和当前ZIP见[外部打开记录](windows-alpha6-external-routing.md)；W1–W5完整资格仍未完成。


2026-11-09 Windows 本地最新整合：已迁到上游 main `cb07c51`／最终 PR27 `b72e744`；Windows 整合、限定通过与未通过项见[最终合并版记录](windows-alpha6-pr27-merged.md)。本机证据不外推上游平台或 Windows 完整发行资格，下方早期 PR 候选记录保留为历史。

历史 Windows 工作树版本：`0.1.0-alpha.6`；该描述只记录当时的上游状态，不是本次整合后的产品版本。

## Linux/macOS 发行基线及历史

状态基线：`0.1.0-beta.8`（Linux x64＋macOS arm64双平台预发行候选，公开状态以[发行页](https://github.com/SeemSeam/nozeli/releases/tag/v0.1.0-beta.8)为准）。2026-11-16用户获知六项分发义务未签收后明确授权本版公开Beta例外；六项仍pending，`--public`仍阻断，不构成合规签收，不标稳定版/latest，不替换日常安装。本版聚焦Linux发行副本去特殊权限，以及Mac arm64原生更新签名验证、同卷原子交换、独立helper、新renderer健康确认、失败回退／中断恢复及父退出竞态；不放宽旧Linux更新器的危险归档拒绝、不更改宿主sandbox。Linux旧版可更新beta.8；旧Mac首次须手动安装beta.8后才支持未来自动升级。最终精确提交完整CI与双平台最终解压包尚须实际验收，不预填通过。Mac仅ad-hoc签名、无Developer ID或公证，Intel Mac与Windows未发行；旧Beta7 tag与附件不变。

2026-11-16 **更新器既有证据与本版资格分开**：此前Linux本地更新／失败回退旅程及[原生Mac运行43821746428](https://github.com/SeemSeam/nozeli/actions/runs/43821746428)在`a838a64a2de2656265f936f3d60982e997e37988`通过成功升级、启动失败回退和中断恢复。原生实跑修正了握手前整包复核耗时与身份快照期间父进程退出竞态：完整复核移至父退出后、交换前，内核确认退出视为停止，活跃身份变化／未知归属仍拒绝。该证据不是beta.8最终SHA的CI或最终发行包资格；详见[测试记录](testing.md)。

2026-11-13 **Beta6版本更新（居中标题／左栏整合随main合入＋CI受影响矩阵与合格运行复用）**：版本与发行元数据升至 `v0.1.0-beta.6`，package.json／package-lock.json／合规清单tag与URL、CHANGELOG／README／release 全部同步；main最新 `f0531cc` 居中标题条与左栏紧凑控件整合随rebase保留。CI侧新增 `apps/desktop/tools/ci-test-plan.mjs` 受影响矩阵：按可靠base..head完整差异生成full/targeted/docs计划（release用最新非draft已公开v* tag、integration用origin/main分叉点、main用受保护before、PR用base到实际merge HEAD），ci.yml按JSON选择unit/integration矩阵并把计划artifact作gate证据；unit恒full，targeted仅跑映射消费者integration，Linux真实build/smoke与Mac native保留，发布五项资格job名称不变；未知／高风险／删除改名／新增非文档及CI／规划器变化必full，缺基线／非祖先／查询失败／手动运行保守full或失败；子集执行器按plan base/head独立重算并拒绝篡改。`check_release_state.py --ci-run-id` 将dev/draft/published绑定到精确产品SHA上成功的ci.yml运行，核对实时run详情、当前attempt、事件与五项必需job／gate，更晚失败／取消阻断，错误SHA／fork／工作流／attempt／gate不可复用。本版CI/workflow自身变动按full执行，首次部署不宣称targeted提速；本版新提交的CI与双平台实际构建/解压验收尚未运行，不预填成功，发布时长以发布实际结束计。独立market/website Demo仅文档原型。六项分发审计仍pending，`--public`仍阻断；当前改动保留在本地release分支，未推送／未发布，不替换日常安装。

2026-11-13 **Beta5版本更新（本轮内存／设置UI／优化在途改动已随实包Linux验收覆盖）**：版本与发行元数据升至 `v0.1.0-beta.5`，CHANGELOG／README／release／合规清单同步；beta4首条本地内存优化记录迁入beta5节。本轮内容包括索引缺失时报告收尾保留真实缺席状态、内置Z.AI源仅填API Key（浏览器授权仍可选且不接管 `zcode://` 回调）、角色默认模型按源浏览后再选模型、Monaco动态分包与静态资产HTTP流式传输、设置侧Pi进程30秒静默安全回收（不触碰业务Agent与在途凭据操作）、Linux x64打包依赖裁剪（仅目标Node/OpenSSL头文件、剔除Canvas非目标变体、Node调试符号外置并保留出处链），以及离线历史／关闭回收与原生测试修正。强制CI与双平台真实包烟测尚未运行，native资格以最终CI为准，不提前宣称通过；六项分发审计仍pending，`--public`仍阻断。未提交／推送／发布，不替换日常安装。

2026-11-12 **用户授权的全部产品改动已提交并安装本机**：功能提交 `d184c07`（26文件），当前 `all-local-20261112-02`，previous保留 `2026-11-11T07-25-55-817Z`，版本仍Beta3本地快照，未push／Release。891项生产src／dist／Pi-src与已验输入逐字节一致，收据 `/var/tmp/nozeli-full-local-install-98Ycqz/installation.json`。Pi／renderer重建、842项unit、7项图像／保留／导入、9项真实Pi上下文及六脚本smoke通过；reviewer发现的100px局部窗裁剪已修复并真实命中验证。实包图像讨论 `/tmp/nozeli-drawing-background-vjzWLZ/report.json` ok=true，前台／续问／后台均携真实笔迹PNG及归一化位置。激活current后真实启动／编辑保存／切项目保护／正常冷恢复 `apps/desktop/.test-output/ci/smoke-ChOl0g/report.json`、PPT原生引擎导出末次输入／原件保护／外部冲突／恢复 `/tmp/nozeli-ppt-pending-tWpN71/result.json` 均ok=true、exit0。provider刷新及标签小窗串行复核通过；旧离线报告夹具REPORT_CHANGED仍不计通过。未改个人配置、未派日常任务，操作前无运行中日常进程；未替用户打开项目。六项分发审计仍pending，Mac／Windows及付费模型理解质量不外推。


2026-11-12 **涂鸦讨论去冗余与图像定位源码修复，未安装／提交／发布**：对齐讨论小窗，删除底部重复说明／次级按钮行与260px正文上限，来源与保留动作从标题更多菜单按需进入。实际复现自定义模型缺少图片声明导致SDK把图片省略为文字占位；补通显式[image]、原生input能力与静态导入，非视觉模型在推理前明确拒绝，个人配置不自动改写。另随冻结图交接笔迹像素／归一化范围及相交来源视口，不伪造文档页码。Linux真实Electron／Pi／回环HTTP验证前台、续问与后台均携图、真实笔迹像素和坐标到达；源码unit842及定向／保留／窗口手势通过，详见[本轮实测](testing.md#涂鸦讨论去冗余与图片定位2026-11-12源码修复未安装提交发布)。非付费模型理解、非Mac／Windows或已发布Beta3签收；旧广义离线报告夹具的REPORT_CHANGED失败如实保留。

2026-11-11 **Beta2 公开预发行授权**：用户在获知六项再分发审计义务仍未签收后，明确授权公开`v0.1.0-beta.2`（Linux x64＋macOS arm64，非稳定版/latest）；此为本版权限，不构成合规签收，`--public`仍阻断，也未授权替换日常安装。本版修复图示校验错误原回合纠正、有界诊断证据与终局诊断回执、原Work/线程安全恢复、报告HTML发布前语法预检，以及旧HTML语法恢复事项结算后解除审核讨论只读，证据见[测试记录](testing.md#图示校验错误与原work自恢复2026-11-10)与[审核讨论恢复](testing.md#已交付成果仍无法审核讨论2026-11-11)。Linux冻结安装真实旅程已通过；本版确切提交CI与macOS arm64实际runner记录由发行流程实测后补录再记为通过。mac仍ad-hoc签名、未公证。

2026-11-09 **PR #27 跨平台整合候选安全修正**：保留原alpha.6 Linux主线与Mac arm64适配，修复最终初始化发布交错／FIFO阻塞、长请求ID暂存文件名、Darwin进程事实两处fail-open；内置reviewer已复审关闭发现。Linux干净依赖／Pi／Office／renderer构建和原PR解压包X11／Wayland真实保存冷恢复、HTML只读双guest通过；新增失败前／修正后回归保留。新增必须通过的macOS原生安全CI，编译及syscall注入测试只能由Darwin完成。当前仍是待CI和最终包验证的PR候选，不冒称Mac公开发行、Windows支持或自动更新／公证通过；未替换日常安装。详见[整合记录](testing.md#pr-27-主线整合安全复核2026-11-09)。


2026-11-09 **紧凑Task与内联过程已安装，未commit／push／Release**。current=`compact-inline-task-20261109-local-01`，previous=`approval-shared-task-flow-20261109-local-01`；806份生产输入一致，清单`/tmp/nozeli-compact-inline-install-LWOSlB/`。实际包主卡旅程`/tmp/nozeli-task-workspace-jEoIg1/report.json`通过默认折叠、过程零新view／window／模型增长、1800行原文分页、草稿与冷恢复；审核旅程`/tmp/nozeli-approval-discussion-1Kd2gZ/report.json`通过默认展开、内联零布局变更、FIFO、明确换版、四主题窄短窗／200%、明确合入／ended及正常退出。69项安全／布局／定位回归及真实消费者`/tmp/nozeli-session-consumer-7YPfMZ`通过；Reviewer已关闭材料白名单及初读失败空覆盖两项阻断。未删用户已存独立阅读布局，未强退日常窗口，正常重开加载。Linux及回环模型限定，其他平台和历史原生像素边界未扩大。

历史基线（非当前版本）：`0.1.0-alpha.5` 的 Linux x64/Wayland、X11/XWayland及GitHub Ubuntu/X11验证，当时安装与打包工具仅实现Linux。当前双平台草稿状态以上方Beta基线为准。
历史 Mac 开发线：基于 `0.1.0-alpha.5`（`9215afafcb82c2b96b80acaa05e302db71228a07`）新增 macOS arm64 原生安全文件／耐久性／进程归属与独立 ad-hoc `.app`，已在该旧基线实际验证包内 Markdown 阅读、Command-S 保存、项目 zsh 终端与正常退出，以及本地 HTTP Provider 的 Pi 交接、发布、丢弃、冲突与生命周期。这些是 alpha.5 时代的本机证据，不代表本轮Beta回归、真实账号、Developer ID或Apple公证通过。

2026-11-09 **Mac 已基于 alpha.6 构建与验收**：新工作树 `/Users/bfly/nozeli-macos-alpha6`（分支 `macos-alpha6`，基线 `v0.1.0-alpha.6` = `9a2466a847267620747b79f9c1b97fbac8f00280`），旧 `/Users/bfly/nozeli` 留存。交付 `dist/Nozeli-0.1.0-alpha.6-macos-arm64-verified/Nozeli.app`，独立Node/Git/Pi、原生文件／耐久性／进程适配、品牌图标与网页叠放修复均保留。完整默认unit798通过/1跳过、integration1873通过/25跳过，零失败；新增初始化／重置／退出合同29项全过。真实Mac包的受限skill初始化（403门控、取消、SIGKILL零重放）、永久重置＋PTY停稳、任务多轮／只读过程／冷恢复通过，只用合成项目与本地Provider。旧基线证据不冒作新验收；九格式显示矩阵仍在截图阶段超时，不能计通过。详见[测试记录](testing.md#alpha6-macos-本机迁移与验收2026-11-09)与 `.test-output/alpha6-acceptance/`。未提交、推送、安装到Applications或操作日常项目；ad-hoc签名，未公证。

2026-11-09 **审批小窗共享Task阅读体已实施并安装，未commit／push／Release**。current=`approval-shared-task-flow-20261109-local-01`，previous=`task-flow-attention-fixes-20261109-local-01`；806份src／dist／Pi-src与冻结输入一致，收据`/tmp/nozeli-approval-shared-install-NuvAau/`。实际包旅程`/tmp/nozeli-approval-discussion-E7mG6k/report.json`全程通过同Task原输入与后续问答／FIFO／修改发布、旧object保持与明确换版、草稿收展、四主题、窄短窗／真实200%输入可达，以及采纳取消后明确合入／ended／正常退出。真实DOM与状态58项通过；共享React消费者`/tmp/nozeli-session-consumer-vJjsFl`通过。宿主组117/118的单个fixture选错默认conversation，修正后scope15项通过。Reviewer的定位重播、选区竞态和成果导航kind已修复。原生父子合成像素额外旅程因Spectacle失焦拒绝输入，不签全部历史黑块／卡死，详见[实施记录](worker-review-chat-demo.md#2026-11-09实施与验收记录)。未强退日常窗口、未操作用户项目，正常重开加载。Linux及回环脚本模型限定。


2026-11-09 **用户改为仅本地安装，已激活修复包；未commit／push／Release**。current=`task-flow-attention-fixes-20261109-local-01`，previous=`alpha6-9a2466a-20261109`；版本仍为alpha.6本地累计工作树快照，不冒称干净新版本。806份src／dist／Pi-src与已验输入一致。实际冻结ELF＋包内Pi／Git任务完整旅程`/tmp/nozeli-task-workspace-Kzh61X/report.json`通过；提醒完整旅程`/tmp/nozeli-project-attention-mCI2e4/report.json`通过四主题、窄窗／200%、65秒闲置、正常退出及业务保持，早一次窄窗等待超时原件保留，不宣称已确定其同因；激活current入口的启动／编辑保存／冷恢复`/tmp/nozeli-portable-alpha6-smoke-ywdlR3/report.json`通过。未强退日常窗口、未在用户项目派模型；正常重开加载。安装收据及清单`/tmp/nozeli-task-flow-install-NNTSEN/`。

用户追加审批对话优化已由Reviewer与UI设计完成梳理：[同Task展开任务流设计](worker-review-chat-demo.md#审批窗展开原task流2026-11-09reviewer设计未实施)。后续讨论全部归原Task、保留流动动画与详细信息、统一各级披露，单输入无模式；阅读object与发送／决定token独立。明确记录现有人工稿自动应用与讨论运行投影缺口；仅设计未实施，不混入本次安装，不以设计文档冒充UI验收。


2026-11-09 **左侧项目提醒抖动已修复源码，未安装／提交**。根因为常规刷新先隐藏仍有效数字，徽章显隐又触发项目缩写`top:16px/6px`切换；真实Electron组件复现72→62→72的区域位移。现保持项目缩写固定，刷新期间仅保留原60秒内的已确认摘要，过期／失败／明确失效仍清除；连续事件不无限推迟读取，旧代次回执不覆盖新请求。23项状态／宿主摘要回归通过；组件取证`/tmp/nozeli-attention-jitter-53Q7zN/report.json`显示刷新及数量变化、归零、失败均无位置变化。完整应用`/tmp/nozeli-project-attention-XVxT0d/report.json`通过多项目、65秒闲置、四主题、窄窗／真实200%缩放、正常退出及业务记录不变，零模型调用；夹具明确使用已有历史项目，避免首次项目初始化混入只读摘要验证。日常安装未替换，Linux限定。

新增永久真实项目栏对齐回归：有数字／无数字入口的缩写相对位置与尺寸一致；最终完整旅程`/tmp/nozeli-project-attention-Qludi3/report.json`通过，正常退出，业务记录和文件摘要保持，未调用模型。



2026-11-09 **任务流向丢失已定位并恢复源码；尚未安装、提交或发布**。流向由`d05b35f`加入，`9c28387`仍包含任务内续聊及方向／回流；`c295496`视觉精简主动删除节点与动效，alpha.6继承删除，不是卡片分组失效或安装漏复制。现仅恢复方向表达，保留中性阅读面、身份及宽框。移除未经用户需要的项目标题整理控件。旧安装与alpha.6的437个src文件逐项对账：15个差异中，补齐文本附件／历史投影、精确冻结材料多跳交接和角标刷新；6个为注释／局部变量更名，4个为首页／浏览器正常前进，不盲目回退。assets无旧版独有文件，4754个runtime文件相同，锁定生产依赖条目相同。遗漏功能79项、任务归属／状态44项回归通过，真实React/Electron消费者验证实际前向移动、回流、暂停恢复不重播及减少动态；附件真实发送旅程通过。完整初始化旅程另在文件树等待超时，不计全程通过。发布安装仍为`alpha6-9a2466a-20261109`；源码不自动更新日常程序。

恢复后的最终源码真实旅程：`/tmp/nozeli-task-workspace-wwKFXo/report.json`通过Electron/Pi/Git双任务、多轮续改、只读分屏、草稿保留及正常冷恢复；任务卡方向截图已查看。仅源码资格，日常安装仍未替换。



2026-11-08 **任务卡视觉优化已按用户授权提交安装**：功能`c295496`（7文件），current=`2026-11-08T10-14-53-685Z`，previous=`2026-11-08T08-52-12-275Z`，803份src/dist/Pi-src与安装输入一致。实际安装ELF/Pi/Git隔离双任务、多轮续改、精确成果/只读过程、草稿及正常冷开零重放通过，报告`/tmp/nozeli-task-workspace-cpUZ2m/report.json`。Reviewer源码/视觉无具体阻断；200%卡片组件已核对，完整应用输入区占屏限制仍在。未强关用户日常窗口，正常重开加载；未推送/发布。[安装记录](task-workspace-design.md#任务卡视觉用户授权提交与安装2026-11-08)。

2026-11-08 **简洁生命周期／自动恢复／项目初始化已按用户后续授权安装并完成Linux异常验收，未提交/发布**。current=`2026-11-08T08-52-12-275Z`，803份src/dist/Pi-src与源码构建一致，原日常版本仍保留。真实安装ELF八档自动保存时序/PPT退出保留、六种原生关闭故障、并发关闭/重置、PTY取消/清除、EACCES部分清除后SIGKILL冷恢复及真正替换实体拒绝删除通过；七格式独立窗口返回/resize/全屏通过，修复PDF双滚动尺寸反馈。初始化403故障门/显式解除原排队重试、取消晚到不发布、SIGKILL零静默重放、完成后冷开零推理通过。恢复定向回归59/59。日常项目未被破坏性测试，未强关原进程；Windows/macOS、真实断电/磁盘损坏/满盘及付费模型理解质量未验。[安装后证据](project-lifecycle-initialization-design.md#9-用户授权安装后的异常验收2026-11-08)。

2026-11-08 **用户授权commit／安装／重启／测试已完成**：功能提交 `9c28387`（12文件），current=`task-contained-20261108-local-01`、previous=`task-workspace-20261108-local-01`；786项src/dist与已验输入一致。实际安装ELF＋包内Pi／Git的独立双task／多轮／任务内原输入与讨论／原只读过程／草稿／长原文／正常冷恢复验收 `/tmp/nozeli-task-workspace-nFjRUN/report.json` ok=true。日常旧进程经正常窗口关闭退出，复用原会话核对4个本页task均为760px宽、零框外后台输入、无初始化错误；最终移除临时调试参数后正常重开本次ELF，PID1899563，原系统入口＋原profile＋原项目，debugPort=none，程序保持打开。两项目任务／工作／消息身份不变，5个源文件摘要不变；一条collectionOrder元数据重写及正常host-opened审计如实记录，不冒称元数据零写入。收据 `/tmp/nozeli-contained-install-HdAA4R/delivery.json`；截图仅本地。安装为累积工作树本地快照，本轮提交未夹带其他在途改动。未推送／发布；Windows/macOS、OS级IME、付费模型质量和此前590px旧缩放脚本限制未扩大签收。


2026-11-08 **用户追加的任务内含原输入／续聊与自适应宽框已落盘，Linux源码限定通过；本次未安装／提交**。原后台输入、后续补充和同Worker问答按确切taskRequestId／job／Work／intake收进同一框，框内保持原sequence／时间，框本身锚定原输入；框外保留普通前台对话，不重复铺后台输入。删除232×208固定槽位，宽度随窗格变化、宽窗上限760px，高度自然增长；保留原文、材料、引用／复制与只读过程，程序交接不冒充用户消息，不新增发送链或重写旧消息。未知诊断不猜归属，历史不制造页外记录。构建与51项定向回归通过；最终真实Electron／私有Pi／本地确定性HTTP／Git与文件 `/tmp/nozeli-task-workspace-HCp6is/report.json` ok=true：双task中插前台讨论、同Worker问答／第二次发布、输入／续聊仅在原框一次呈现，原DOM／身份／草稿／只读分屏／冷恢复零重放。最终React/Electron消费者 `/tmp/nozeli-session-consumer-XgoGAn` 通过框内引用、交接去重、1200／480／320自适应及原文／历史／选区读取；源码及组件截图已查看。未操作日常项目、未安装或提交本次变更；旧current不自动包含此调整，Windows/macOS、系统IME候选窗和付费模型质量未验。


2026-11-08 **用户授权安装与commit：任务工作区本机安装已通过实际ELF复测**。current=`task-workspace-20261108-local-01`，previous=`2026-11-08T01-38-35-481Z`；安装器校验并更新命令／桌面入口，786个src/dist文件（432源码＋354构建）与已验工作树逐字节一致，清单 `/tmp/nozeli-task-install-zwsKxQ/input-manifest.json`。实际安装ELF＋包内Pi／Git、独立合成项目／profile、回环确定性HTTP完整复走双任务、中间普通讨论、同Worker问答／第二次发布、原卡DOM／身份色／草稿保留、过程分屏复用／只读拒绝发送／原窗格关闭、长工具原文读至末条，以及浅深320/390/1280与200%缩放、正常退出／冷启动零重放，`/tmp/nozeli-task-workspace-JivxfM/report.json` ok=true、providerErrors=[]；截图已查看。未操作日常业务或强关旧窗口；旧进程须正常退出后重开新版。安装包是累积工作树本地快照，不冒称仅含本轮提交的纯净构建；本轮只提交任务工作区范围，其他在途变更保留。未推送／发布，Windows/macOS、系统IME候选窗与付费模型质量未验。


2026-11-08 **居中任务标签与只读原生任务分屏已落盘并通过Linux源码限定验收；本轮未安装／提交／推送**：任务在各自原输入位置呈现232×208默认槽位，普通讨论与修改意见保持时间顺序；同一Work续作更新原卡与身份色，真实当前运行和回流事实驱动动效，不复制执行卡、不以历史失败覆盖新轮。详情／过程使用固定project＋taskScope的 `task-process` 原生工作区分屏，同范围复用、关闭不停止任务，右侧暖底待办／中性工作追踪保留50/50基准与自然高度让位、边界居中箭头；右栏无消息数字／未读点，不清底层义务或项目角标。过程限定历史、原文字段、冻结材料与超8MiB原件导出均有范围／版本校验，不能send/connect/approve。renderer构建、797项默认unit、13项任务scope／只读分屏／不可变大原件导出回归、独立React/Electron过程消费者均通过；内置reviewer最终accept。真实Electron＋私有Pi＋回环确定性HTTP＋真实Git／文件双task与多轮流程 `/tmp/nozeli-task-workspace-q4xrmr/report.json` ok=true：分时任务间普通讨论、A原卡DOM／居中尺寸／身份色／草稿保留、同原Worker第二次发布自动进入过程、43890字节工具原文读至末条、分屏复用／禁止send／原窗格关闭及正常退出冷启动零业务重放，浅深×1280/390/320与200%缩放。真实Host／SQLite100事项右栏 `/tmp/nozeli-project-attention-Zm7Aww/report.json` ok=true，双方饱和各半、滚动后重算稳定、20px字体、240px真实短窗整体滚动、左右箭头同中点、无右栏消息提示、原业务记录及文件保持。截图已逐面查看；shell截图不包含子WebContentsView像素，不冒称OS合成全窗截图。真实系统IME、Windows/macOS、付费模型质量未验，单元／定向与live计数不累加冒称全仓integration通过。临时启动／原文诊断脚本已移除，维护验收入口保留。


2026-11-07 **顶部仅故障待处理已落盘并通过Linux源码限定验收；未安装／提交／推送**。移除通用待办顶部挂载、结束反馈、跨项目启动拉取及专属投影／样式；共享 occurrence 身份原样迁入 `attention-presentation.mjs`，右侧成果／授权待办、消息未读、项目角标与持久业务 ack 保留。故障入口改为单条“故障待处理 · N项／查看故障”，数量沿权威 active userCritical 全量summary；无故障不占位，读取失败保留待核实，回执不撑起顶部。逐项解除、禁用原因、版本／代次／范围／防重核验、刷新、分页和批次回执留在原详情窗口，不扩大后台识别。renderer构建与104项定向回归通过（45项故障门控／账本／项目提醒＋59项待办／授权／呈现）；内置reviewer静态审查accept。实际Electron三组通过：合成持久故障及真实SQLite验收 `/tmp/nozeli-fault-only-top-QZwm6p/report.json`，四主题、320／390px、成果与授权可达／消息未读保留、零自动ack、实际无效故障记录读取失败保留计数并禁解除、原详情实际解除和持久批次、恢复后顶部隐藏、正常退出且原文件／草稿／业务状态不变；实际Pi／回环HTTP402／真实文件任务 `/tmp/nozeli-agent-control-ui-yUMQ2u/report.json`，真实标题拖动后指针进入故障详情、范围内未准入输入继续且已准入失败输入不重放、回执读取及正常退出；跨项目提醒 `/tmp/nozeli-project-attention-9gyudu/report.json`，2／99+／零隐藏、四主题／窄窗／200%缩放、无顶部通用条及无自动ack。截图已查看，无个人账号或付费模型；合成持久故障不冒称HTTP识别，HTTP实测不冒称任意失败可恢复。早期失败为夹具未结算发布／授权事实不全、未显式激活刷新项目、Locator首匹配、未初始化配置与CDP模拟视口错位，修正真实准入／选择器／窗口路径后通过，未削弱产品保护。临时入口已删除，维护入口仍为 `installed-attention-notifications-live.mjs`。仅Linux源码，不外推Windows/macOS或日常安装。

2026-11-07 **左侧项目图标沉静中性方案已落盘并通过 Linux 源码验收，未安装／提交／推送**：按用户最新要求撤回项目配色，删除身份取色函数、图块身份色属性及六色变量，不保留兼容壳。缩写上限改为 11px／字重500，保留冲突编号、大写展开字号适配；44px命中区／32px图块位置不变。采用主题中性字色、极轻底色与弱边线，current仅轻底／细边＋左侧短标记；hover加宽原边线、active收小圆角，只有键盘焦点沿主题焦点色。保留真实红待办角标、零／未知隐藏、完整辅助技术名称及原点击／切换／键盘合同。内置UI工程师施工、内置reviewer静态审查accept，主助手 renderer 构建与21项定向检查通过。真实Electron隔离8项目验证同前缀／中文／宽字母／大写展开字形≤11px、字重500、无裁切及99+遮挡，明暗×sage/slate各选中／非选中×普通／悬停／按下共24组受控样式探针对比度最低5.48:1；实际项目切换、待办键盘进入及返回、Tab／Shift+Tab焦点、目录失联／恢复、超过60秒空闲刷新、320／390px、200%缩放、刷新后缩写保留与强制色截图通过。正常退出、零渲染异常，隔离文件／业务记录不变，无模型调用。报告 `/tmp/nozeli-project-quiet-XfSO2E/report.json`；深浅、窄窗、键盘焦点和强制色原生Electron截图已查看。仅本轮Linux源码证据，不外推Windows/macOS、完整辅助技术或日常安装；临时烟测脚本已移除。

2026-11-07 **左侧项目图标优化已落盘并通过 Linux 源码烟测，未安装／提交**：44px点击区内保留32px图块，项目缩写居中，按名称分词生成双字素缩写并在冲突时编号；移除双层选中框，改为细边框＋左侧短标记，键盘虚线焦点独立。正数待办角标保留真实计数和完整辅助技术名称，缩小并与字形分区。修改位于 `app.mjs` 与 `project-attention.css`；renderer构建、21项项目提醒定向检查通过。真实Electron＋隔离SQLite项目验证 `nozeli / nozeli_git / nozeli-copy` 分别显示 `NO / NG / NC`、跨项目切换、键盘进入待办与Escape返回、2／99+／零隐藏、目录失联与恢复、超过60秒空闲刷新、明暗×sage/slate、320／390px及200%缩放；正常退出、零渲染异常、原文件及业务记录不变，无模型调用。报告 `/tmp/nozeli-project-attention-alBItz/report.json`，明暗和窄窗截图已查看。仅本轮实现与运行证据，不冒称 reviewer 已复审签收；Windows/macOS和完整辅助技术未实测，日常安装不变。


2026-11-07 **退役身份污染当前存储修复已安装复测，未提交／推送**：current=`retired-storage-isolation-20261107`，previous=`project-attention-badges-r2-20261107`。requireOnline在触及metadata/DB前拒绝removed，并核验异步返回身份，旧失败不得invalidate同路径新owner；startup/config正常恢复跳过退役项目，仍独立核验未知provider名额。显式重新添加与未知写入隔离保留。64/64定向回归，旧安装真实冷启动fixture失败`/tmp/nozeli-retired-startup-z3zzpZ`，源码`stXTIs`、冻结包`lXGOxV`、激活后`nXsMIa`均通过两次真实冷启动且文件/批注/草稿保持。安装后徽章6组`/tmp/nozeli-project-attention-AsFCgh/report.json`通过。实际nozeli_test仅以readOnly DB适配器核验：当前7d9ed862身份available、退役均PROJECT_RETIRED；未清除或重置实际数据，未强关旧实例，正常退出重开才加载新版。此包同时包含前轮已测永久清除与无信息隐藏徽章修复。下方未安装为历史记录。

2026-11-07 **永久清除项目状态与无信息徽章源码修复完成，未安装／未提交**：旧归档式reset改为枚举并清除同root／同实体的全部历史project/instance metadata、local/recovery、旧归档及已核验受管Git资源，停稳／保存／身份不明保留围栏；清完再创建空新身份。原文件、用户Git、全局账号和其他项目保留，未对日常用户项目执行清除。左侧仅确认正数显示红圈数字，零／加载／未知／过期无徽章，不再显示问号或省略号；前台到期纯读刷新、失败有限重试。128项定向安全回归通过；真实Electron临时项目＋活PTY永久重置4组通过，真实跨项目/四主题/320与390px/200%缩放及超过60秒空闲提醒6组通过。证据 `/tmp/nozeli-permanent-reset-yiq2HD/report.json`、`/tmp/nozeli-project-attention-rCTiR8/report.json`。Windows/macOS、真实账号与完整辅助技术未验；旧安装行为不因源码修复自动变化，详见[实施证据](agent-conversation-status-demo.md)。

2026-11-06 **用户明确授权“安装，我要验证”：r4已试装**。从已测冻结r4候选复制并经现有安装器校验激活为 `review-page-r4-2026-11-06T14-14-33-888Z`，previous保留 `2026-11-06T08-40-52-916Z`。421源码、354构建文件与候选逐字节一致，未重建或夹入后续工作树；记录 `/tmp/nozeli-review-redesign-ARiK9h/user-installed-r4.json`。本次由用户验证成果报告正文末尾清单／三按钮、审核原生小窗拖动缩放收展／黑块／草稿、采纳放弃及普通标签对照；保留进展冗余页尚仅设计审查，不宣称已删。同帧像素和reviewer整体验收门仍未过，试装不等于accept；未代操作日常项目或强关旧窗口，未提交／推送。

2026-11-06 **成果页重做源码候选已实现，reviewer 整体签收仍阻断，未作本轮安装／提交**：r4独立真实ELF的采纳与放弃生命周期均ok:true／实际exit0，保存失败显式业务重试、同DOM恢复、父属迁移、ended未发稿只读保持已取证；共用标签尺寸／收展／父夹取及zoom0.8/1.25有有限trusted-CDP实证，r3集中过186项、r4相关37项通过。连续可见讨论两段60秒无持续讨论bounds／位置写入，CPU中位增量0；但真实父报告＋子窗同帧合成像素尚未取得，不能声称用户黑块问题已通过验收。正常区域截图工具有界失败，未绕权限或拼图；完整原件及限制见[当前候选](worker-review-chat-demo.md#当前实施候选2026-11-06未安装整体验收未通过)。另“保留进展”冗余页已完成reviewer设计审查，建议删除专页并合入任务详情，本轮未擅自实施。

2026-11-06 **项目恢复后同进程重新添加修复已安装并复测**：current=`2026-11-06T08-40-52-916Z`，previous=`2026-11-06T06-50-32-215Z` 保留回退。只对明确移除后重新添加、原目录／metadata／清单／DB身份一致且无未结算操作的连接恢复，保留项目／实例／草稿与历史，未知写入和 lifecycle hold 不自动清除。64/64定向回归、安装内Host状态保留、实际安装ELF正常关闭→metadata loss→打开拒绝→恢复→正常移除→添加按钮重加→原文件读取通过，同一进程无需重启；正常exit0，零模型推理／业务重放，源文件／Git／manifest保持。安装界面原件 `/var/tmp/nozeli-installed-project-readd-restored-BWTEBB/report.json` 与截图已检查，安装内Host `/var/tmp/nozeli-installed-readd-host-y7YIqM/report.json`。未在日常 `nozeli_test` 上强行恢复，旧窗口需正常退出后重开；活跃页面保存失败仍阻止移除（不绕过）。Linux限定、未提交／推送，下面未安装文字为历史阶段。

2026-11-06 **成果页最新用户实测未通过，reviewer 已重新设计、待实施**：安装后审核讨论窗仍卡死、部分发黑且没有真正悬浮；此前局部测试不能否定该反馈。新方案将成果文件和已有方法／数据归入报告正文自然末尾，页级仅保留“审核讨论／采纳并结束／放弃并结束”，推荐父属非模态原生讨论承载，拒绝粗裁大片正文冒充浮层。完整整页布局、权限／草稿保护、原生承载权衡及真实像素／指针／CPU与IPC验收门见[reviewer 重设计](worker-review-chat-demo.md#reviewer-成果页整体重设计2026-11-06待实施)。本轮仅设计与文档，不改产品代码、不安装、不提交；卡死／黑块根因仍待运行查证。

2026-11-06 **用户授权 commit 并与 `e4dd289` 一起安装新版，已完成**：窗口／管理界面及相关 UI 接线提交 `a772582`（父提交即 `e4dd289`）；实际用户目录 current=`2026-11-06T06-50-32-215Z`，previous=`2026-11-06T03-38-28-248Z`。安装冻结当前完整运行源码，415个src、354个dist文件与工作树逐字节一致；其他既有后端未提交修改仍保留，不把安装快照冒充纯提交树。实际安装ELF的PPT标签／涂鸦拖动、键盘、取消、窗口夹取、本地恢复13项全过；`e4dd289` 的原中文请求＋空cursor×3＋空brief再次通过，唯一Work／Worker、真实HTML发布、零维护job／新Bug，两次均正常exit0。记录 `/tmp/nozeli-unified-install-88KARQ/installed.json`，测试原件 `/tmp/nozeli-label-windows-cUP4Yb/report.json`、`/tmp/nozeli-installed-recorded-bug-fixed-HgjW12/report.json`。不强退旧窗口、不操作日常项目、不推送／发布；正常退出全部旧窗口后重开桌面入口加载新版。以下“未安装”文字为源码取证阶段历史，不覆盖此安装记录。

2026-11-06 **共用局部窗口与简洁管理页已在源码实施，未安装**：标签／备注、冻结位置、审核及网页讨论共用几何、手势、尺寸与独立展示 CAS；来源、笔迹、线程及审核决定保持原路径。Agent 状态改紧凑行，会话诊断按需、资源与默认模型分行，故障页同层返回。188/188 定向回归、真实设置30项、深浅主题PPT／涂鸦各13项及原生报告讨论→人工稿采用通过；网页父View裁剪实证保持完整guest视口、段落换行与草稿／URL归属。Linux隔离合成项目限定，网页菜单选择用明确回调fixture，实际拖动用真实指针；不外推物理菜单、全格式／硬件或跨平台。详见[实施证据](testing.md#2026-11-06-共用局部窗口与简洁管理页源码未安装)。本轮未执行安装、提交、推送或发布，以下安装记录仍为各自历史阶段。

2026-11-06 **依据 Bug 台账完成参数合同源码修复，安装后同场景通过**：`INVALID_CURSOR` 的空／null／省略游标统一首页；`brief` 可选，空／null／省略由宿主用冻结原请求，其他类型可纠正拒绝，非空说明保留，等价派工幂等。旧普通派工故障制造分支已删除，历史 Debug 安全恢复事实仍可读。144/144 定向回归、通用 Debug／真实读取纠错均通过。current=`2026-11-06T03-38-28-248Z`，previous=`2026-11-06T02-14-18-377Z`；实际安装版用同中文请求、空 cursor×3、空 brief 正常生成唯一 Work／Worker，HTML 已发布待审核（review、Worker completed），维护任务与持久 Bug 记录均0，无需 Debug 兜底，正常 exit0。证据 `/var/tmp/nozeli-installed-recorded-bug-fixed-LlZZ5D/report.json`，原生与实际工件截图已检查。本地受控 provider，不外推远端模型质量／跨平台；不重试旧任务、不改旧 Bug、不自动合入，未提交／推送。

2026-11-06 **Debug 临时运行时续行已落盘、重新安装并同场景通过**：主控对宿主已证明写入前拒绝的空 brief 派工，在诊断／检查源码／保存报告后主动 `debug.continue`；保持原 intake／请求／sourceJob，只创建唯一 Work，重复或冷恢复只认原回执。未知效果、权限／人工暂停／取消及身份／版本冲突仍阻断，不改源码／安装、不重放原 prompt，临时成功仍 `verifiedFix:false`。128/128 定向回归、真实私有 Pi 与实际安装 ELF 的“同中文输入＋三次空 cursor＋空 brief 失败→Debug→续行→Worker 真写 HTML→发布待审”通过；界面不再永久显示处理中，HTML 模拟／暂停／调参实测通过。current=`2026-11-06T02-14-18-377Z`，previous=`2026-11-06T00-54-32-789Z`；正常退出后重开加载新程序。安装证据 `/var/tmp/nozeli-installed-debug-runtime-continuation-0CrFqx/report.json`，详见 [Debug 实施记录](debug-read-protocol-fix-20261105.md)。本地确定性 provider，不外推远端模型质量／跨平台；未重试日常失败请求、未自动合入、未提交／推送。

2026-11-06 项目右键新增“重置为新项目…”（源码与本机安装已验收）：明确确认后沿保存／草稿保留、进程停稳与在途写入屏障归档旧元数据，旧实例与恢复区原位封存，保持 worktree／原生会话路径；同一目录以新项目和实例身份自动加载，不继承旧批注、会话、任务、草稿或布局。原文件、Git、全局账号／API／模型设置保留；未知停稳、保存失败、身份变化与发布中断不强制清空、不自动重放。63/63 定向回归通过；真实 Linux X11 Electron 右键取消／确认、新身份原文与空批注、旧未保存稿跨分页恢复读取、其他项目及冷启动通过，正常退出；原生窗口截图已检查。源码证据 `/var/tmp/nozeli-project-reset-gui-mu4EPW/attempt-ahR70s/report.json`。Windows/macOS 未验。

同轮用户授权“安装了吗 commit”后，本机 current 更新为 `2026-11-06T00-54-32-789Z`，previous 保留 `2026-11-06T00-00-59-494Z`。实际安装 ELF＋隔离 profile／合成项目经真实右键重置，自动加载新项目身份、保留原文并正确归档旧元数据，正常 exit0；自有 PID 原生截图已检查，证据 `/var/tmp/nozeli-reset-installed-68kJNB/report.json`。不强关原有窗口、不操作日常项目；已打开的旧程序须正常退出后重新从桌面入口启动才能加载新版。安装冻结当前工作树，存在其他既有未提交改动；本轮 Git 提交仅纳入项目重置相关差异，不代提交其他改动，不推送／发布。

2026-11-05 审核区按用户实际安装反馈和Reviewer方案重做：报告为主体，底部唯一“审核讨论”显式打开可移动标签式窗口，采用/真实文件/交付物Diff留在报告底部；删除自动aside/stack和模式开关，真实同Work回合整理、原文折叠与原生viewport保宽裁切已实现。源码的真实Pi讨论/排队/人工稿采用、暂停只读与原生HTML/删除文本/冻结Diff路径通过，详见[重做取证](testing.md#报告审核工作面重做2026-11-05)。仍有原生裁切可能大于浮窗的体验限制，不声称打开后完整无遮挡同时阅读。未做本轮安装、提交或推送；观察到current已另行切为`2026-11-05T10-28-25-750Z`、previous为第四轮，407源码与354构建文件与当前工作树静态一致，但本轮未对该已安装ELF作运行签收；下面安装文字为各自阶段历史。

2026-11-05 用户本轮明确“安装一下我要测试”：`approval-ux-batch4-20261105-local-01`已安装并激活，包含第三／第四轮版次、并读、保留进展与暂停引导；previous保留第二轮。冻结src/dist共759文件与工作树逐字节一致；实际包ELF的审批全程及真实失败后只读引导通过，固定800专项在取证时窗口变为最大化而未通过，不记作新增窄窗签收。无付费调用、不操作用户项目、不强退旧窗口，未提交／推送／发布。安装记录`~/.local/state/nozeli-runtime-tests/approval-ux-batch4-install-20261105/installed.json`；以下未安装文字为原取证阶段状态。请正常退出全部旧窗口后从桌面入口重开。

2026-11-05 用户追加授权“安装和commit”：第二轮`approval-ux-batch2-20261105-local-01`已激活，previous保留首批`approval-ux-batch1-20261105-local-01`。M1/M2/M4/M5已包含：人工审阅稿可直接采用，同层确认列文件路径／人工稿／未发送意见处置，任务命名与窄栏简化。真实冻结ELF＋包内Pi/Git在中文X11同帧旅程完成原线程讨论、人工改稿、采用前原件保护、实际合入及ended/complete，正常退出。原件`/tmp/nozeli-ux-batch2-zh-G7r6ZE/report.json`；未推送或发布。本页历史“未安装”描述各自当时阶段，不代表当前安装指针。

2026-11-05 第三轮源码候选（未安装／提交）：U2-01统一当前／旧版／人工稿发布序号；U2-02在正常字号下默认宽窗左右、窄窗上下并读，保留显式自由摆放与收起；U2-03撤回第二轮重复截图的展开／返回标签，补实际800窗口、原生可见面与像素差异证据。M3已实现只读“保留进展”：真实READ_REF_EXPIRED失败后可查看／复制原请求、冻结报告与文件、失败补充及未确认事实，打开／复制不新增模型或job，不自动重放，不提供无依据恢复按钮。真实中文人工采用及失败后只读取证均通过；不等于故障根因、R01/R02或未知效果恢复验收。入口与边界见[测试记录](testing.md#第三轮-u2-01u2-02u2-03-与-m32026-11-05源码候选未安装)。

2026-11-05 U3收尾（第四轮源码，未安装／提交）：正常字号800默认上下并读已实际同屏定位结论与完整助手解释、输入意见、收起展开，布局／字号不改；2次滚动、0次额外布局调整，原文位置与草稿保留，对话约7.33px数值偏移仍在但整条解释可见，不声称所有更拥挤提示状态通过。异常进展首屏改为补充未完成、哪些材料可读、当前暂不能继续及就近查看／复制／返回；技术原文折叠保留，原报告当前暂停说明与禁用动作一致，历史系统消息不改写。真实失败后只读操作无新增执行或文件写入；[操作与剩余边界](testing.md#u3-01u3-02-小批收尾2026-11-05源码未安装)。

## 已具备的主要能力（Linux 实测）

- **报告审核与讨论（2026-11-05 重做源码实测）**：待办先展示报告，底部可看真实成果、冻结交付物Diff、明确采用，只有点击“审核讨论”才打开直接可移动的标签式窗。复用标签消息组件，按真实Work/job/request与原修订整理多段回复，原请求/交接和过程折叠、发布为独立事件；与主Work消息ID/正文实际对照。原生HTML保持完整viewport，只裁切可见区域，开关/拖动不再重排原文，关闭恢复阅读；裁切范围仍可能大于窗体。原线程、草稿/CAS、队列、不可用/历史只读和真实合入保护保留。Linux隔离真实Electron/Pi/文件已验证，不等于模型质量、完整历史导航或跨平台签收。详见[当前接入决策](worker-review-chat-demo.md#生产接入决策本轮优先)。

- **阅读**：PDF（大纲、搜索、缩放、文本层）；文本／Markdown／TeX／BibTeX；代码文件（Monaco）；图片（PNG/JPEG/WebP）；DOCX；XLSX；PPTX（内嵌 PPTist 编辑，草稿独立保存，导出副本不覆盖原文件）。
- **批注与讨论**：文字选区、PDF 页／选区／区域、图片区域、文档位置右键点锚与画面涂鸦均可就地备注或发起讨论；讨论锚定发起时的版本与位置。保存本地备注不派工，显式发送才交给 Agent。
- **编辑与版本**：自动保存与冲突检测；每文件修改账本与作者标记（你／各 Agent／外部）；历史版本对比（Diff）不改动原文；Agent 修改经宿主精确同步到打开的编辑器，不进入本地撤销栈。
- **统一工作区**：文档与对话共用标签组布局（并排／堆叠／多列／网格）；拖出为真实独立窗口并可移回；快速打开、文件树隐藏／恢复、已打开列表。
- **项目终端（普通交互 shell，宿主侧已接入）**：工作区入口为每个项目注册一个真实终端（node-pty），工作目录为项目根目录，shell 按 Linux 登录策略选择（/etc/passwd 当前用户条目 → 校验过的 $SHELL → /bin/sh），不把 Agent 运行环境凭据注入终端环境，也不向渲染进程暴露环境内容。终端由宿主独占管理：重复点击只呈现同一 shell，拆分／独立窗口／停靠保留原进程；输出为带序号的有界回放，输入与尺寸有上限。每棵终端进程树携带无密钥的私有归属标记：内容关闭、项目关闭与应用退出按平台适配器的已验证收割器清理全部同用户后代（含脱离进程组的后台任务与 setsid 子进程），验证未通过时保留归属记录、拒绝新终端并允许重试，不伪造清理完成。冷启动恢复布局不自动开 shell，需显式入口点击或终端内显式重连。Windows/macOS 未验证，将明确拒绝而不是伪造终端。
- **后台协作**：三角色（前台／主控／Worker）；主控任务板为有界分页的宿主账本视图（稳定 Work ID、状态、revision、队列位、阻塞原因、报告引用，cursor 指纹显式失效），管理动作用 workId＋expectedRevision 提交（名称仅展示检索），backstage/维修事件可只读查询任务板与详情；后台 Work 以报告＋候选文件差异交付，人显式接受（合入项目）或丢弃（不合入）；接受前不写回原文件。统一待办中心处理问题与成果。本轮任务板等定向回归通过（见[测试记录](testing.md)），完整默认回归与发行包核验以发布流程实测为准，不代表[长期设计](orchestrator-long-term-design.md)的后续阶段已经实施。
- **当前安装（2026-11-04 用户授权连接修复安装）**：current `2026-11-04T00-46-19-337Z`，previous `2026-11-03T17-14-57-747Z`。安装链累计包含冻结输入合入／回滚／作者记录、后台自动记 bug 与收尾维修、无 AI 配置的宿主启动恢复（用户端不提供技术重试／Git 锁处理）。`2026-11-03T17-14-57-747Z` 版完成真实模型系统验收：90,023 字节需求文档两次有界读取并明示未读全文、GLM-5.3 两轮数值 CLI 独立 oracle 69/69＋4/4、离线预约 Web 应用两轮独立判卷、六类原生宿主故障矩阵 6/6。最新版包含已接手空线程被旧历史误阻断的连接修复，原日常 profile 实窗验证连接 ready、无业务重放；非空旧线程仍需真实协议接手。紧凑 F/O/W 状态栏改版为源码，未包含于安装版。Linux 限定，详见[系统验收](testing.md#新项目真实模型与安装版系统验收2026-11-04linux)、[连接修复](testing.md#日常对话连接已接手空线程被旧历史误阻断2026-11-04已授权安装并实窗验证)与[紧凑状态栏](testing.md#沉浸对话输入框下方-fow-紧凑模型状态栏2026-11-04源码待安装)；安装边界见[发布说明](release.md)。
- **任务状态与固定审核（已包含在上述安装版）**：报告仅正文滚动，底部决定常驻、短窗自动紧凑；待审核跨重启保持。明确审核后为 closing，只有主控原事务全部收尾确认才 ended；失败保留原审核绑定和恢复入口。启动自动恢复未完成 Worker／主控原队列与原线程，已准入回合严格从原生日志续执行，不重发用户消息或已完成工具；人工暂停／取消持续生效，未知效果先核查。生产 Manager／私有 Pi 回环专项及原项目 closing 状态重启实测通过，不以此声称原项目旧失败或待核对冲突已经解决，详见[测试记录](testing.md)。
- **收尾故障闭环（已安装，原项目已修复）**：用户只决定结束；技术故障由后台自动记 bug、进行有界原事务修复，成功后结清故障及维修事件；保护原授权、并发／未保存输入和未知效果。原 Liuhuaiyu 重启验证第 2 版与轨道任务第 9 版均完整 ended/complete，Worker job 和草稿不变；两项 bug repaired，维修事件 completed。历史锁字节及原 inode 均保留备份；本次工程维修不扩展为任意未知外部锁自动删除。见[当前故障修复证据](testing.md#用户只决定结束后台负责故障修复2026-11-03)。
- **会话与协作状态（协作条已包含在安装版；输入框下紧凑 F/O/W 状态栏为源码改版，尚未安装）**：对话时间线保留消息／推理／工具事实和真实历史生成模型；协作条显示前台／主控／Worker状态及模型，点击按Agent选择、继承或撤销未提交的模型变更。忙时等待安全边界，休眠只保存下次选择，不唤醒或重发；未知状态不当空闲。thinking沿Pi原生能力和现有设置／会话接口，本轮不新增对话thinking菜单。原生OMP终端／PTY接管仍已移除，不伪造终端画面。
  P1–P5及自动动态管理已完成，原阶段证据见[§10–11](agent-conversation-status-demo.md)。任务／维修协同包含宿主先修复、确切未准入技术事件结算、原action能力／绑定、只补维修收尾、不重复效果、有界冷读与过期只读UI、宿主事务／closure回收保护。此前默认回归2158项、原生live36项、Electron smoke5脚本的历史证据见[生产接入与深度证据§7](agent-task-repair-lifecycle-design.md)，不冒充本次最终包重跑。默认连续安全空闲5分钟回收，按需恢复原线程；不结束Work、不释放其业务配额，不绕过硬额度、未知状态和用户决定。本次最终安装与复杂实测以本页当前安装项为准。
- **TeX**：源码旁动态 PDF 预览（latexmk／XeLaTeX／pdfLaTeX／LuaLaTeX 或 Tectonic，需本机工具链）；可选 TexLab 补全。
- **设置**：私有 Pi 源与账号管理、三角色默认模型、外观（主题／配色／字体）、Agent 额度；密钥仅存宿主私有配置，不经读取接口回传。账号登录含 Z.AI（GLM Coding Plan）：浏览器授权后创建/复用专用密钥 `nozeli`（用户手动粘贴回调，Nozeli 不接管 `zcode://`），另有内置 Provider API 密钥表单（运行时声明能力）；真实账号 OAuth 尚未运行验证。
- **空工作台引导**：无打开文件时介绍批注与选区讨论、任务闭环、分屏阅读、独立窗口，并说明操作路径；打开项目、浏览文件及演示复用既有入口。

## 数据与隐私边界

- 项目内容与批注保存在项目目录的 `.nozeli/` 下；应用状态在操作系统用户数据目录。不联网遥测。
- AI 能力正迁移到随应用构建的 Pi 会话运行时（见 [SOURCES](../apps/desktop/SOURCES.md) 的 Pi session runtime cutover 与 [OMP 集成](../integrations/omp/README.md) 保留的历史来源），不读取系统 OMP 配置；模型请求仅在显式操作后发生。
- Git（dugite）随应用捆绑，普通保存不产生提交；接受后台成果才执行受管合入，无自动推送。

## 已知限制（不作已验收声明）

- **平台**：Windows 未验证；macOS arm64 仅有上述本机开发专项验证。Mac 不支持 bubblewrap 沙箱、外部系统终端接管；管理员提权、自动更新、完整 Office／PDF／分屏回归和 Developer ID／公证未验收。Linux 安装器与既有公开附件不变。
- **本轮严格对齐候选**：整文件讨论、网页工作面／讨论、标签漂移提示、会话管理与新 Pi 问答正在按冻结原版逐项验收。旧开发数据迁移不在范围；当前执行证据见 [Pi 对齐记录](pi-integration-execution.md)。不得将此前套件数量或某一组件通过视为最终候选全功能签收。
- **Office 子集**：XLSX 图表与未知 OOXML 部分保留在原包但不显示，格式／结构编辑暂不可写；PPT 图片、转场、母版保真有限，旧 `.ppt` 不支持；Word 批注与作者标记限于正文段落与表格文本。
- **PDF**：批注为页／选区级，锚定保存时的版本；不承诺无损改写任意 PDF。
- **并发写入**：宿主在替换前复核摘要，但不承诺关闭与不合作外部写入者的全部竞态；检测到外部变化时显式提示。
- **依赖与隔离**：TeX 预览／补全依赖本机工具链。普通受管执行以当前用户权限运行，不默认声明沙箱保护；只有显式启用隔离时需要系统 bubblewrap，隔离建立失败则拒绝该隔离启动，不冒充隔离成功。
- 未承诺：双人文档同步编辑、任意格式截图附件回写、Office 历史二进制还原、跨设备同步。

逐项验证与安装记录保留在内部开发计划库，不随本仓库发布；本页只保留当前能力与边界结论。
