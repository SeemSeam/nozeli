# Orchestrator Debug：Bug 记录、临时恢复与源码修复

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
