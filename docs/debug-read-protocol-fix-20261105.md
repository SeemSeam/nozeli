# Orchestrator debug 激活与读取协议修复

日期：2026-11-05。状态：用户授权实施，严格分阶段验收后再提交；不安装、不重放用户任务。

## 当前裁决

只有模型不可用的故障需要阻断并向用户请求处理模型。其他程序bug属于系统责任：持久记录、自动激活Orchestrator debug、检查真实证据并保存诊断与修复方案；不把内部技术问题变成用户业务决定，不以一次status查询或一句“需要版本修复”冒充debug完成。

程序依然核验文件／版本／原任务／进程归属／权限。用户明确暂停、拒绝授权、成果审核不是程序bug；debug不能替用户决定。未知效果先由系统对账，不因自动debug重放原prompt、命令或写入。UI不阻断用户阅读和其他工作，不代表故障操作可不经验证继续。

### 用户回应后的执行闭环（2026-11-05 追加授权，已安装并通过分项实测）

- 用户批准确切授权请求、采纳问题报告方案，或拒绝并提供新反馈后，决定必须先按原项目／Work／revision／来源持久化，再推进唯一绑定的剩余步骤；不得只存备注或要求用户重发原任务。
- 新授权不扩大为任意命令、root 权限或对其他 Work 的授权。原报告、用户反馈、历史输入不可改写；已准入输入／完成效果不重放。
- 有效的显式决定可以唤醒所绑定的排队续作；冷状态查看、过期决定、已完成回执的重复请求不创建 owner 或第二任务。重复同键应恢复尚未完成的准入／调度，而不是返回成功后遗留不可执行队列。
- 模型／配置／存储／人工暂停等真实屏障仍生效。决定已保存但尚未执行时返回具体的排队／阻断事实及原 job 身份，不伪称执行或丢弃用户决定；条件恢复后继续同一条续作。未知效果先核查，不能把“继续”实现为重发原始输入。
- 本轮修复现有敏感效果授权和问题报告 approve／reject 续作链，随后经用户明确要求完成安装及真实场景验收。DEBUG 的模型建议仍不构成通用代码修复能力，不冒称自动改源码、安装、验证和续跑均已实现；当前安装与模拟边界见执行记录最新章节。未提交或推送。

### 安装验收中的权限交互修正（2026-11-05 用户追加，已安装并实测宿主权限场景）

- 权限申请不发布 problem／result 报告，也不创建“权限报告”工作面。待办仅提醒待授权事项；用户点击后回到既有前台对话，在可信的内联授权卡上决定。
- 授权卡默认仅简洁说明所需权限、对象／范围、目的和具体风险；完整命令、原任务、来源身份和回执按需展开。不把摘要隐藏掉的版本／效果绑定交给模型重造。
- 申请没有默认同意，批准／拒绝仍走原宿主决定台账及原 continuation。打开提醒不发消息、不派工、不改原对话草稿；Worker 申请也不得把主输入接收者改为 Worker。
- 方案报告与最终成果审核保留原用途，不能用方案“已批准”替代高危操作的确切权限申请。本轮真实安装验收以修正后的对话授权交互为准，旧“待办报告页”上的成功不计符合本次要求。

### 原线程升级续接与测试工作区重置（2026-11-06，已授权实施）

- 普通宿主工具定义升级不再要求用户确认换会话。沿 Pi 原生 sessionId／确切 JSONL 路径恢复原线程，注册本次进程的工具；工具摘要变化仅作诊断，不能据此拒绝已有对话或切换到新线程。
- 历史元数据在原生打开确认身份前不更新；线程身份不符、原生日志损坏、不可解释持久化格式仍明确拒绝，不以恢复为名重放旧输入／效果。进程、会话和操作事实继续分开，不新增通用兼容性分类系统。
- 用户明确选择重置“全部测试工作区”。先正常关闭应用并保留完整可回退备份，只归档登记项目 `.nozeli` 与本机测试会话／任务／布局／草稿／原生会话状态；不删除项目实际文件、Git、模型账号、API 配置和模型默认项。不将清空后新项目可连接冒充跨版本原线程恢复通过，必须先运行独立旧会话→新版工具的真实 Pi 验证。
- 源码实测：80/80 定向回归通过；`node tests/pi-tool-upgrade-continuity-live.mjs` 通过真实私有 Pi owner、旧清单生成原生日志、新清单原线程恢复、零恢复请求、实际新增工具调用及生产 Controller 完整 DEBUG 检查／报告。证据：`/var/tmp/nozeli-upgrade-proof-ynEV69/pi-tool-upgrade-continuity-qsQLpv/result.json`。仅确认为零活动且日志真正缺失的既有恢复路径允许新建，不将旧线程工具摘要套在新线程上；有历史或未知效果的会话不走此回退。本地确定性 Provider，不外推付费模型或 Windows/macOS。
- 本机安装已更新到 `2026-11-06T00-00-59-494Z`；使用安装内独立 Node 与安装内 Pi／Controller 重跑同一升级验证通过：`/var/tmp/nozeli-upgrade-proof-khUYlB/pi-tool-upgrade-continuity-9R98By/result.json`。未用重置后空会话替代升级验收。
- 全部登记测试状态已可回退归档：10 个项目 `.nozeli` 与 7 个本机状态目录（含 storage-v2、原生 sessions、布局／草稿等），共 17 处，仅重命名迁移，不删除。备份 `/home/bfly/.local/state/nozeli-runtime-tests/test-workspace-reset-20261105T232318Z`，完整源／目标见 `moves-completed.json`，原故障证据另存 `original-schema-failure`。迁移前后项目实际文件及 Git 顶层身份一致；6 个账号／模型文件与应用 settings 指纹一致。准备至执行间两个外部项目 `.git` 目录元数据曾变化，保留其执行时现场，未覆盖。
- 已启动真实安装版并检查原生窗口，显示“未打开项目”的干净起始面，未自动打开项目或派工；截图备份下 `reset-installed-window.png`。重启后账号／模型文件及 settings 指纹再次核对一致。Linux 限定，不声明跨平台通过；本轮未执行 Git 提交。

### 2026-11-06 新项目后台派工失败调查（安装版真实项目）

- 事实：项目 `/home/bfly/yunwei/nozeli_test` 当前新身份 `9f47589a-0d74-4ebb-b17c-144437224b7b`；原请求“我需要制作一个混沌系统的html演示”已原样持久化。`nozeli_inspect_work` 连续三次传入空字符串 `cursor`，每次均收到 `INVALID_CURSOR` 的同回合纠正；随后 `nozeli_manage status` 正常返回空 Work 板；最后 `nozeli_dispatch` 传入 `brief:""`，宿主在 `Workspace.submitState` 写入前拒绝 `task requires original request and brief`，因此 Work 数量为0，没有隐藏重放或部分创建。
- Debug 并非未生效：故障记录 `bug:20f375e2…` 已绑定原 job，主控 DEBUG 事件 `19158197-1165-4d30-acdf-750c66f1e855` 从 `01:00:57` 启动，完成11段只读源码检查，`01:02:07` 写入 `model-interpretation` 报告，`01:02:14` 正常结束。报告明确 `verifiedFix:false`、无自动修复尝试；当前应是“诊断已保存，系统待修复”，不是已修复或可继续执行。
- 界面显示“系统处理中”的原因已在安装版隔离复现：`turnPresentation` 只按原失败 job 的 `debugState=awaiting-fix` 判定 `status:'debugging'`，没有要求维护 job 仍为 `queued/running`。维护 job 已 `completed` 但仍投影“系统处理中”；工作区记录本身却是“系统问题待处理·原请求已保留”。这是状态投影缺陷，不是诊断未启动。
- 调查还复现两个产品缺口：空 `cursor` 未在工具入口规范化为省略（应直接返回首页），以及 `nozeli_dispatch` schema/调用路径允许模型提交空 `brief`，最后才由下游抛泛化宿主错误；应在宿主事务前返回可纠正的 `INVALID_PAYLOAD`，或明确允许空 brief 并安全创建。两者均不应重发原请求。
- 证据：原始新实例 `managed:cache:jobs`、`managed:maintenance`；安装版隔离复现报告 `/var/tmp/nozeli-intake-failure-investigation-XrpRjo/report.json`（驱动已删除）。未修改源码、未重试用户任务、未变更项目数据。

### 2026-11-06 用户裁决：Debug 临时运行时续行

- Debug 的目标由“诊断后等待源码修复”扩展为“定位问题，宿主证明可安全临时恢复时主动让原任务继续”。不是让模型改源码、热改安装、手写数据库、解锁或重发原用户输入；本轮实现新增受约束的运行时能力，源码缺陷与临时恢复分别记录。
- `debug` → `debug.inspect` → `debug.report` 后，有宿主签发能力时主动 `debug.continue`。本次首先支持已证明在创建 Work 前因空 brief 拒绝的派工：只在确切原 intake 上以未改写原请求作为本次临时 brief，沿普通派工保存原附件／来源／权限／幂等与配额合同；只生成一个原 sourceJob 的 Work，不再创建业务 intake。
- `continuing` 只表示临时恢复正在执行；`continued-with-known-fault` 必须由实际业务持久回执证明，保留 `verifiedFix:false` 和源码问题待修复事实。原请求继续不等于最终成果已完成，不伪造 `repaired`；历史错误与诊断报告不改写，追加真实续行事实。
- 任务／项目／bug／maintenance event／attempt 必须一致。结果未知、先前已执行但无确定回执、权限或人工暂停／取消、身份／版本冲突、缺少安全证据时不放行；并发、重复或冷恢复只认原回执，不再派工。原失败线程不重放用户 prompt。
- 用户已授权实现、测试并重新安装；相同“我需要制作一个混沌系统的html演示”与空参数路径先用隔离项目、真实私有 Pi／宿主／文件／Git 验证，再验实际安装版。不得用空 cursor 直接吞错或正常 brief 路径冒充 Debug 续行通过，不重试用户现有失败现场，不自动接受成果，不提交／推送。

### 临时续行实施与重新安装验收（2026-11-06，已完成）

- 已实现 `debug.continue` 与 skill 主动续行责任：原派工实际进入 `Workspace.submitState` 原 guard 并在写入前拒绝，宿主精确记录空 brief 的拒绝意图；未知提交／回滚失败／已路由不签发能力。Debug 阅读宿主证据和 workspace 源码、保存报告后，才能在确切 bug／event／attempt／原 intake 上续行。原请求作为临时 brief，Work、routing.hostContinuation 和原 job 续行事实在同一业务事务保存；重复／并发调用只返回原回执。
- `continuing`／`continued-with-known-fault` 已接入原任务、维护状态与对话展示；已提交回执可在投影失败或冷恢复时收正，不再派工；停止／取消、权限／人工暂停、存储未知与身份／版本冲突不绕过。源码缺陷仍为 `needs-version-fix`、`verifiedFix:false`、`sourceRepairRequired:true`，不因任务续行而假装源码已修复。异步权限查询后的停止也会在提交前重新核验。
- renderer 构建通过；`managed-debug-protocol`／`session-execution-presentation`／`managed-work-records`／`maintenance-status-page`／`maintenance-runtime`／`pi-session-admission` 6 文件定向 128/128 通过，零失败／跳过。新原生场景注册 live，安装版场景显式执行，不声称全仓通过。
- 同一原文“我需要制作一个混沌系统的html演示”真实经历三次空 cursor 拒绝、一次空 brief 派工失败、自动原生 Debug／源码检查／报告／临时续行和重复回执读取，随后唯一原 sourceJob 的 Worker 通过真实 native write 生成 `chaos-demo.html` 并冻结发布为 `review`。源码原件 `/var/tmp/nozeli-debug-runtime-live-6XeZDf/report.json`；不是正常 brief 绕过失败，也不是 monkeypatch 宿主或手写状态。
- 用户授权重新安装后，current=`2026-11-06T02-14-18-377Z`，previous=`2026-11-06T00-54-32-789Z` 保留回退。实际安装 ELF＋私有 Pi／捆绑 Git＋隔离项目重复完整故障与续行链路，原请求／唯一 Work／原项目字节／Git 均核对；真实对话徽标为 `continued`（已临时恢复·原任务继续），无永久 `debugging`；Worker 结果实际待审核，不自动合入。
- 安装版原件 `/var/tmp/nozeli-installed-debug-runtime-continuation-0CrFqx/report.json`，`runtime-continuation-delivered.png` 与 `actual-worker-chaos-demo.png` 已检查。额外沙箱 Electron 工件窗口加载实际 Worker 文件字节，验证 Lorenz 模拟推进、暂停／继续与调参；该窗口只是工件行为验证，不替代安装主进程／原生 CLI／真实文件验收。私有应用正常 exit0、安装字节不变、无额外模型请求。
- 同场景 provider 为本机确定性回环脚本；未调用日常远端账号，不据此外推 GLM/GPT 实际模型选择质量或 Windows/macOS。未重试用户现有失败 job／未改日常项目／未自动接受成果／未提交或推送。中间单元夹具缺失依赖与共享对象问题、首次工件查看用到 Electron 不支持的 Target.createTarget 均保留失败输出，已分别纠正；没有放松生产保护。

### 2026-11-06 用户追加：依据 Bug 记录修复源码并在安装后复测

- 对照安装版复测台账的 `INVALID_CURSOR`（3 次）与 `DISPATCH_BRIEF_EMPTY`（1 次），本轮修复参数合同本身；验收目标不再是触发 Debug 后临时恢复，而是同一中文请求和原参数序列直接正常完成、零新增对应 Bug／维护事件。
- 首次任务板读取的可选游标统一语义：省略、`null`、空字符串或纯空白均表示首页；非空游标必须沿原分页令牌／版本／项目规则校验，不把损坏令牌静默当首页。工具 schema／说明同步此可选语义。
- 派工的 `brief` 是可选附加执行说明：省略、`null`、空白字符串均由宿主使用冻结的原 intakeSource.request；原 request 不改写，非空 brief 原样保留，其他类型返回同回合可纠正 `INVALID_PAYLOAD`、零写入。幂等意图按实际有效 brief，等价默认参数不能多建 Work，实质变更不能借旧回执。
- 保留内部 Workspace 非空 brief 不变量。删除普通派工中已不应可达的“故意抛空 brief／再生成拒绝证据”路径；历史已捕获预效果拒绝及续行回执仍保留可读／幂等，通用 Debug 诊断、安全围栏和旧现场恢复不退役。旧 Bug 台账不改写为新版本的成功记录。
- 相同场景复测驱动切换为 `pi-recorded-bug-fixed-live.mjs`／`installed-recorded-bug-fixed-live.mjs`；不保留旧场景导出别名。旧“失败→Debug续行”的历史证据仍用于对照，不将其当作本轮源码修复通过。用户明确要求安装后复测；不修改日常项目、不重发旧业务、不自动接受工件、不提交／推送。

### 源码修复及安装后同场景签收（2026-11-06，已完成）

- 已统一 `Controller` 的可选参数合同及工具 schema／说明：空游标实际读取首页、坏非空游标仍拒绝；brief 缺省／null／空白使用冻结原请求，非空说明原样保留，错误类型返回 `INVALID_PAYLOAD + continueTurn` 且零写入。有效 brief 先归一化再计算派工意图，等价重复只回同一 Work；不同有效意图仍拒绝。内部 Workspace 非空不变量、正常来源／附件／配额／权限流程未变。
- 普通 dispatch 中旧的“空 brief 抛错、打拒绝证据、制造维护任务”捕获分支已删除。仅消费修复前已持久化证据的历史 Debug 恢复与回执继续保留；不回写旧 Bug 为已修复，也不自动重发日常失败请求。原生场景驱动已 clean cutover 为 recorded-bug-fixed 名称，无旧导出／入口别名。
- 定向 7 文件 144/144 通过、零失败／跳过：`managed-debug-protocol`、`managed-taskboard`、`session-execution-presentation`、`managed-work-records`、`maintenance-status-page`、`maintenance-runtime`、`pi-session-admission`。覆盖默认 brief 的等价重放、错误类型零写入、游标首页等价与真分页、坏令牌拒绝、历史 Debug／权限／停止／未知效果围栏。
- 源码真实私有 Pi 原件 `/var/tmp/nozeli-recorded-bug-fixed-live-zjg5Df/report.json`：同一句“我需要制作一个混沌系统的html演示”，同 `cursor:""` 三次、manage status、dispatch `brief:""`，直接正常派工，一个原 intake／Work／Worker，真写 `chaos-demo.html` 并冻结发布；新维护任务／Bug 均为0，不依赖 Debug 临时恢复。
- 通用 Debug 原生回归仍通过：`/var/tmp/nozeli-pi-debug-activation-live-Dvd3qE/report.json`（明确标注宿主边界注入的故障，不冒充当前源码缺陷；401 停止／显式恢复、只读源码检查／报告、权限／版本边界、零重放均验）；读取纠错原件 `/var/tmp/nozeli-pi-read-correction-live-qZFSIg/report.json`（坏非空 cursor、错误选择器与真实跨工具引用纠正、候选编辑／发布均验）。
- 已安装 current=`2026-11-06T03-38-28-248Z`，previous=`2026-11-06T02-14-18-377Z` 保留回退。实际安装 ELF／main／私有 Pi／捆绑 Git 在隔离新项目复演同输入与原空参数序列，唯一 Work 实际 `review`、原 intake／Worker 已 completed；真实对话正常完成／已交付待审核，无失败／Debug 恢复徽标。生产维护查询 total=0，正常 exit0 后直接读取 SQLite 的原始 Bug 台账仍为空；安装字节、原文件／Git 未改。
- 最终安装原件 `/var/tmp/nozeli-installed-recorded-bug-fixed-LlZZ5D/report.json`，`source-fixed-delivered.png` 与实际 `actual-worker-chaos-demo.png` 已检查；实际 HTML 推进／暂停／调参均验。首次驱动外部读活跃 SQLite 遇到读锁，已改为运行中沿生产查询 API、退出后才读原始库；中间采样曾早于 Work／Worker 完整结算，已收紧为 review＋Worker completed＋所有可见回合 completed 后签收。失败／中间报告保留，不以宽松等待代替结算。
- 使用本地受控 provider 输出，不外推远端 GLM/GPT 自主模型质量、Windows/macOS 或全仓套件。未修改日常项目／历史 Bug 记录、未自动接受工件、未提交／推送；旧窗口须正常退出后重开以加载新程序。

## 实施顺序

1. **先debug激活**：保留原wrong-tool读取错误。自动事件由status-only变成有宿主核验的debug开始、受限源码／事实检查和持久诊断报告。报告是模型解释，不是已验证修复；没有修复效果不能标repaired。记录原bug／项目／job／Work revision、debug回合及检查证据，防止跨项目／过期事件报告。
2. **先复测并查bug日志**：真实私有Pi＋生产Manager/Controller＋隔离文件，实际触发文档nextReadRef送入history_read，确认仍失败；随后观察真实主控debug工具执行和持久日志，而不是伪造状态。阶段1证据固定后才进入下一步。
3. **再修阻断bug及同类错误**：对只读协议错误返回结构化continueTurn，准确声明nextTool与当前ref归属；不给未知／外部引用返回内容，不自动猜路径或转发。可纠正错误写入脱敏bug日志，只有匹配的真实纠正读取成功才结算；不因任意其他读取成功假装修复。缺失／歧义任务查询不得升级为fatal或暗中派新Work。
4. **再复测／审查／提交**：同一原输入、线程、Work完成“错工具→纠正→真实候选编辑→发布”，检查bug实际repaired、无额外Worker或原业务重放。类似错误与日志保存失败边界定向回归，原生与Electron复测，独立review后只提交本轮改动。

## 真实故障来源

安装alpha.5的Liuhuaiyu项目：原生edit旧文本不匹配后，document_read成功返回第1页及nextReadRef，Worker将它送入history_read；doc引用仅在job.documentReader登记，历史读取从job.reader查找，误报READ_REF_EXPIRED。Controller只对document_read自身同码错误允许继续；Nozeli自有tools.mjs将宿主抛错设terminate:true，bridge.mjs主动abort原生回合。Pi-gui并非已证实根因。

原系统确实排入主控maintenance事件；主控只调用status，因为capability:null后结束，bug仍needs-version-fix、attempts为空。缺陷是缺少持续debug责任及可核验报告合同，不是没有记录过日志。历史记录不回写，本轮在隔离项目重现和修复。

## 改动与提交边界

接手时工作树已有51个修改／新增路径，均视为用户改动；原件已保存在`/var/tmp/nozeli-read-protocol-baseline`。根因修复阶段2草稿保存在`/var/tmp/nozeli-read-protocol-phase2`，阶段1已恢复预修复版本（保留用户原改动），不靠测试开关跳过真实阻断。最终提交只包含相对该基线的本轮差异，不把整份已修改文件或已安装运行数据一起提交。

## 验证记录

实施完成后记录实际命令、报告与限制；未运行的步骤不写通过。模型质量／真实账号／Windows和macOS不由本地确定性Provider外推。
