# Agent 生命周期与任务自动修复协同合同

日期：2026-11-02。状态：生产源码接入已完成，Linux限定深度验收通过；最终结果见§7。设计／Demo与生产状态分开记录，与 [Agent 状态、模型和动态管理](agent-conversation-status-demo.md) §10–11 配套；未安装、提交、推送或发行。

## 2026-11-03 用户修订：审核与最终结束必须分离

本节为用户修订后的当前源码契约，覆盖下文与之冲突的“先 ended 再技术收尾”历史记录。Linux 源码、真实私有原生运行时／回环 Provider 及原生报告界面定向验证完成；不等于全量、跨平台或当前安装版已经升级，证据见[测试记录](testing.md#审核固定布局持久状态与重启续执行2026-11-03源码)。

- 结果页仅正文拥有阅读滚动；审核决定常驻该内容分区底部，采用布局分配而非覆盖正文。展开意见、文件与版本信息不得重新制造正文内外两个阅读滚动窗；窄窗仍保留决定入口。
- 发布有效报告进入 `review`，直到确切用户审核决定被持久接受。重启、关闭、owner 休眠／退出、job 完成、定时回收及报告阅读均不能推导接受或结束，不取消待审报告。
- 用户明确接受／丢弃后先持久进入 `closing`：决定、确切版本、原队列／权限与恢复事实保持不可变，展示“已审核，待收尾”。不能再次接受或重放 Worker；收尾失败、权限／冲突／未知结果保持 closing 的阻断阶段和可解析恢复入口，不冒充已结束。
- 只有原 Orchestrator 协调的确切收尾事务（合入／丢弃处理、原生退出、归档、资源清理与必要持久化）全部确认成功后，原子落为 `ended`、记录最终结束时间并按既有配额合同释放名额。接受回执或单独 Git 成功都不是最终结束。
- 冷恢复保留 review／closing／blocked 事实，不从文本或进程退出重建业务授权。已确认用户决定且收尾未完成的旧 ended 可经有证据的状态迁移归为 closing，保留原批准、版本、请求键、权限及所有已发生效果；已真实完成的历史记录不重开。无可验证决定／收尾证据的历史异常先保留并标明待核查，不盲目重置、重放、合入或删除。
- 2026-11-03 用户追加：重启不能把未完成 Worker／Orchestrator 工作变成手动暂停或已结束。正常启动应按持久任务意图恢复原队列与原线程；明确人工暂停、取消／删除、待审核及权限决定持续生效，未发送前台草稿不自动发送。未准入输入沿原身份准入一次；已准入输入必须从原生日志核对并续执行，不重复用户输入或已完成工具。原生日志缺少工具结果／持久效果未知时先核对并显示恢复受阻，不假装完成或自动重放；已审核仅恢复原收尾队列，不重跑 Worker 内容工作。
- 2026-11-03 用户再次明确：用户只决定是否结束任务；决定持久化后，后台自动启动并推进原收尾流程。程序 bug 是系统故障，必须自动记录 bug、进入既有维修流程并据此修正，不转成用户的 Git 锁判断、事务恢复、技术重试或再次审核。普通报告和工作目录只显示收尾／系统故障处理状态及只读详情，不提供技术恢复决策面。真实权限授权、用户并发编辑和明确禁止合入仍不能由维修越权覆盖；保留现场并由系统核查，不要求普通用户担任故障排查员。上一轮新增的手动 Git 锁隔离和原技术重试入口撤回；冻结输入合入、回滚和作者记录修复保留。
- 2026-11-03 主控工具协议失败追加：只读查询的游标／参数错误不是用户业务失败，也不能冒充远端服务故障。保留原请求，在同一原生回合返回有界可纠正结果并持久记 bug；同工具在同 job 中实际成功后才结清该故障，不新增用户消息或诊断模型回合。真正宿主异常以严格 host origin／原工具机器码跨 owner 传回，进入既有维护账本；没有原安全动作时保持系统所有权，不凭日志重建 prompt 或重放未知效果。未创建 Work 的失败请求只读展示原目标和系统处理状态，技术诊断默认折叠，不提供普通用户“重新核对／恢复／重试主控处理”来维修程序。真实 Work 的用户业务控制、明确权限和并发修改保护仍保留。
- 2026-11-10 图示校验与诊断证据修正：`nozeli_diagram` 的已知schema／布局／输入校验以`DIAGRAM_INPUT_INVALID`在原回合返回原Worker，具体布局诊断不进入脱敏维修账本；真正内部异常仍失败。宿主记录白名单工具名、callId、阶段、效果确定性与机器码，诊断按该工具获得固定可信源码目录和摘要校验，不再只看通用`HOST_TOOL_ERROR`。无安全续行能力时，`debug.report`持久回执直接结束诊断，不要求多一次模型回复或反复检查。
- 已知遗留图示故障由宿主配方恢复：核对原job／Work／revision／线程、不可变最终单一图示调用及失败结果，纯渲染原参数得到类型化校验拒绝，才持久写唯一恢复回执并向同一线程追加一次剩余工作说明；不重发原请求、不新建Work、不重做已完成工具。排队后版本／线程再核验，冷启动只补未结算回执、不重复入队。记录为`unknown`但已确认归档且唯一末尾原因为`PI_HOST_TOOL_FAILED`的终次宿主异常，必须再满足上述纯调用证据才能核查恢复；真正传输unknown／缺结果／并行未知工具、人工暂停、权限、版本或身份变化仍拒绝。
- 此能力是完整的受支持配方闭环，不是任意代码自修改：诊断模型提出解释／修复方案，宿主只执行预先实现且可验证的恢复动作；没有匹配配方或效果无法核实则保留现场。自动补丁不得修改安装程序、凭据或用户原始材料，模型报告不得冒充verified repair或任务完成。


## 1. 结论

复用同一项目 Controller、任务账本、维修账本和全局原生进程额度。项目推进能力、业务 Work、一次输入 job、原生 owner、宿主修复事务是不同生命周期；不增加“维修 Agent”常驻角色，也不把一次原生进程退出当成 Work 结束。

自动修复首先是**宿主对已绑定原事务的有界恢复**，不一定先启动 LLM。只有已入账的合法维修／后台核对事件需要主控理解时，才沿已有队列按需唤醒主控。模型陈述不构成修复成功；宿主验证的持久化结果与回执才构成成功。

## 2. 当前源码事实

证据入口相对仓库根：

- `apps/desktop/src/agents/managed/controller.mjs`：`maintenanceTransaction`、`maintenanceRetry`、`maintenanceEvent`、`maintenanceStatus`、`maintenanceScan`、`pump`、`reclaimIdle`。
- `apps/desktop/src/agents/managed/maintenance-ledger.mjs`：`maintenanceBoundary`、`record`、`attempt`、`finish`。
- `apps/desktop/src/agents/managed/agent-idle-lifecycle.mjs` 与 `agent-process-budget.mjs`：原生 owner 自动回收及额度；不是维修重试预算。

| 对象 | 权威与现有行为 | 不得推导 |
| --- | --- | --- |
| Work | 持久任务身份、revision、候选、报告及关闭阶段；休眠不释放业务配额 | Agent 退出即任务结束或候选可自动合入 |
| job | 已接受的本次输入及准入／执行／交付事实；cold 输入受恢复门控 | 新 owner 可重发旧 prompt |
| owner | 单 target 原生进程；安全空闲5分钟回收，按需恢复原 thread | 主控／Worker 都必须常驻，或所有睡眠线程都可自动启动 |
| repair action | Controller 内存中的确切恢复函数及验证器；`maintenanceFlights` 按 bug 单飞 | 持久 bug 记录包含可在冷启动重新执行的完整事务 |
| maintenance record | 按项目／phase／job／Work／revision与脱敏故障去重；持久保存尝试和结果 | `repairing` 字样能证明当前仍有修复在执行 |
| maintenance job | 在原队列中以主控为 target 的核对事件，不建立新业务 Work | 独立常驻维修角色，或维修任务豁免全局额度 |

`maintenanceTransaction`首次原事务失败后排除权限、冲突、未知退出等边界，记录故障并注册确切内存恢复函数，先尝试一次宿主恢复。验证成功则持久结算完全匹配、尚未准入的queued核对事件，不再为已解决的问题额外派维修模型；仍未恢复的故障才释放原主控技术事件进入队列。原效果最多两次维修尝试，**不含最初失败的原事务调用**；已started未结束的未知尝试不重新执行。次数上限不新增用户配置。

原事务只有宿主验证后才可能标记修复完成。验证效果与业务／维修回执收尾分开：同Controller保留确切action的已验证栅栏，保存失败时仅可`retryMode:'finalize'`补结算，不重复原效果，也不再消耗效果尝试额度；即使用尽两次尝试也可在该栅栏仍有效时补保存。最终业务状态、匹配核对事件和维修回执均持久完成后才标`repaired`。Worker发布恢复可进入review；未开始prompt且没有已准入尝试的启动／准备失败才可恢复原job排队。冷开缺原action或验证栅栏不可凭持久文本重建执行权限。

冷重启丢失内存 action：保留故障及已执行事实，显示需要版本修复／核对，不从日志文本重建执行函数。`maintenanceStatus` 发现 `repairing` 但没有 live flight 时给出 `interrupted-host-attempt` 的只读解释，不借读取操作修改原持久记录。

引导 resident 启动失败时 Controller 尚未开始调度，不排入依赖自身才能执行的维修循环；maintenance job 自身再失败也不递归派维修。工具 schema 不匹配必须原明确交接，不自动换线程伪装修复。

## 3. 统一展示：结果、阻塞和进程分别表达

保持已有协作条、任务详情、审核报告与待办入口，不引入第二个维修任务板。普通读者先看到工作能否继续、当前是否需要自己行动；bug ID、owner、尝试次数和技术阶段放详情。

| 场景 | 默认展示 | 进程与恢复 | 明确禁止 |
| --- | --- | --- | --- |
| 已接受任务无运行额度 | 等待运行名额；无需重复提交 | 保留队列／监听，有额度后原 target 启动 | 强杀 busy owner、偷偷预留新额度 |
| 执行中的 Worker，闲置主控 | Worker 执行中；主控可休眠 | 项目服务保留，真正后台事件按需恢复主控 | 为显示“项目运行中”唤醒所有角色 |
| 快速宿主恢复成功 | 原工作继续；详情保留修复事实 | 不要求新增维修模型；仅持久结算完全匹配且未准入的核对事件，已启动事件保留 | 批量取消不同故障、已准入或效果未知的事件 |
| 宿主恢复未确认 | 原工作保留，系统故障处理中／待核对 | 原事务受单飞与次数约束；主控事件不越权执行 | “换个 Agent 重试整个任务” |
| 两次效果修复用尽或无原action | 系统问题尚未解决，保留原工作与结果 | 不再执行原效果；同Controller确切验证栅栏仍在时可仅补维修收尾，冷开不可重建 | 无限效果重试、假装成功或凭持久记录重新授权 |
| 原生交互／权限／业务问题 | 需要你决定；原问题保留 | 不属于静默维修；受保护 owner 不空闲回收 | 主控代替用户授权，或自行猜测答案 |
| 原生输出结束、报告尚在落账 | 保存结果中 | owner／发布事务保持保护，不能提前释放 | 先标完成，失败后再重跑 Worker |
| 结果 review | 结果待审阅，显式打开报告 | 无运行活动时可回收 Worker；Work配额仍占用 | 自动接受、自动结束或重绑其他工作 |
| closing／未完成 closure | 正在收尾／收尾待处理 | 宿主原 closure 幂等推进，必要阶段保护 owner | “Worker结束”等于Git／归属／归档完成 |
| 冷恢复 unknown | 状态待核实，旧输入不重放 | 只读展示原事实，显式合规恢复 | 因过了5分钟直接判安全、重建执行意图 |
| 项目不可用／关闭 | 保留未确认状态或确认停止 | 清理自动截止，保留未确认进程归属 | 关闭后定时唤醒、释放未确认名额 |

这些是 Demo 应表达的既有合同和拟议呈现，不代表新增状态 API、维修治理或全局公平性已经实施。

## 4. Demo 必须覆盖的可交互场景

使用 `apps/desktop/demos/agent-status/` 的现有场景推进器；所有输入、回执和故障明确为本地模拟。设计控制放演示区，不进入正式产品动作。

1. **工作项目、闲置角色**：Worker保持执行，演示时间跨过空闲截止，只卸载安全闲者；读列表和选模型不唤醒。明确发送后只恢复目标原线程。
2. **准备失败快速修复**：原 job 尚未准入；第一次准备失败，宿主恢复验证成功，同一 Work继续，一次业务输入，不先画一次维修模型请求。
3. **报告保存失败**：Worker输出结束→宿主冻结／保存阻塞→主控合法核对／有界原事务恢复→报告可审阅；不重复 Worker执行，不自动合入。
4. **修复中断与冷开**：持久尝试停在 started，内存 action 不可用；显示待核对／需版本修复，草稿与原结果保留，不提供“一键自动重跑”。
5. **资源满**：所有 owner busy／unknown，维修核对排队；即使修复很重要也不凭优先标签抢杀或越限。合法闲者回收后原队列推进。
6. **用户决定与技术故障并存**：问题、权限或偏离决定仍在原待办；修复不得替用户作答或清除决定，任务不会因为另一个修复成功自动恢复执行。
7. **修复结束后的闲置期**：技术事务和合法队列全部结算后才开始该 owner 新的完整空闲期；持续原生活动与32ms以内 busy→idle 也重置期限。
8. **显式结束优先**：用户结束原 Work或版本已变化后，旧修复结果不能续派业务；保留已发生事实并收尾。草稿、历史模型和其他项目状态不串绑。
9. **退出失败闭环**：停止失败／未确认时保留owner和额度占用，维修队列不假装已启动；重复推进时间不密集停止重试，应用关闭后也不延迟唤醒。

关键交互不靠统一“推进一步”将所有Agent批量改为空闲；每个场景有自己可观察的合法转移和禁止效果。恢复显示“原会话恢复”，不是“新Agent已经修复”；只有模拟宿主验证步骤后才能展示演示修复成功。

## 5. 生产收敛与明确后置项（本轮接入见§7）

- **维修轻量投影**：本轮已实现按project／bug／Work revision绑定的有界DTO及生产协作区详情；复用原维修账本，未另建任务状态源。
- **已修复核对事件**：本轮宿主先修复，并只结算完全匹配且尚未准入的queued技术事件；不同故障、已执行、冷恢复及未知效果不吞掉。
- **失败解释与恢复动作**：由确切action、已验证栅栏、剩余额度、任务／权限／UNKNOWN派生动作能力；`needs-version-fix`、`human-boundary`、`cancelled`不能仅凭文案变成可重试。效果恢复与只补结算明确分开。
- **宿主事务保护**：本轮hostOperations覆盖原宿主事务、维修flight和closure开始／结束资格通知；不以UI字段授权回收，不新增常驻维修角色。原Worker回合结束若仍由该job绑定的维修持有发布，不提前制造“缺少交付”或暂停正在修复的事务。
- **全局饥饿／公平性**：硬上限全部受保护时只能排队。公平性、跨项目优先级、控制角色额度预留均是独立调度决策，不在此次Demo更新中偷偷改变。

## 6. 验证边界与交接状态

本节是上一轮设计／Demo验证边界，当时未更改生产调度。旧`desktop-maintenance-live.mjs`原为OMP专项；本轮§7已迁移成真实Pi，保留普通文件、原生命令、被忽略工件、显式接受与正常退出的实际断言。不能把旧OMP证据当成当前Pi通过，也不因源码接入授权安装、提交、推送或付费模型。

Frontdesk原请求 `job_ffd523fd1fe7` 最初因 `omp_editor_not_focused` 停在accepted／queued。用户随后明确要求独立落盘测试，主助手接管；已用`ccb cancel`取消原排队任务，回执为cancelled，避免迟到编辑覆盖本轮成果。不再以Frontdesk后续执行作为交付前提，也不声称它已审阅批准。

### 本轮已交付的独立伴随页

`apps/desktop/demos/agent-status/task-repair.html`，由原Demo首页直接进入，包含9个可交互场景，独立的owner数组／Work／job／repair／未决决定事实，按场景合法转移，不批量结束其他Agent。独立接管后亦修正原`app.mjs`：场景推进只确认具体target回执，准备完成不结束其他Worker的保存，压缩结束不结束另一角色的原生重试；review可继续讨论，暂不决定后讨论仍保留未决业务问题，未知状态仍禁止发送。

实际浏览器验证覆盖：忙Worker与闲角色回收、宿主快速恢复零模型调用且核对队列仍保留、发布独立验证回执、冷恢复禁发、退出未确认保留3/3额度、未决决定不被技术修复清除、原空闲截止失效、closure单独确认、review仍可讨论及场景切换草稿保留；390px深色无横向溢出。截图：`/var/tmp/nozeli-repair-demo-desktop.png`、`/var/tmp/nozeli-repair-demo-narrow.png`。这些是离线Demo证据，不替代真实Pi任务维修验收。

源码合同相关回归45/45通过（maintenance-runtime、agent-idle-lifecycle、agent-process-budget）。另实际运行Controller＋ProjectStorage＋隔离文件，注入一次宿主准备事务临时失败，宿主先修复并验证真实文件、无模型owner启动、原Work保留、独立维修事件仍排队、持久回执一次verified尝试、原文件不变：`/var/tmp/nozeli-repair-contract-XiNyCF/report.json`。此烟测不包含Worker原生执行或Pi完整维修端到端；未通过的早期驱动不计通过。

独立源码合同审阅§1–2／5无阻断发现；Demo设计首审提出的状态混用、批量推进、review讨论阻断、暂不决定语义及退出失败场景已在独立伴随页处理。补充页两轮复核后无新增阻断项：结论只覆盖该页静态状态与转移，不外推原Demo `app.mjs`、生产维修链路或Frontdesk已审阅批准。实际浏览器验证由主助手单独执行。

伴随页复核进一步指出并已修正：全局额度不足与同target已有执行不能混为一谈。额度场景现由休眠主控、当前前台、未知Worker及独立的其他项目owner构成；前台当前job先结算并核验退出，空出名额后才恢复主控，未知／外部owner保持不动。项目聚合用明确`repairInFlight`／`settlementPending`事实，不以中文状态文案猜测；宿主恢复中与报告待结算时均保持项目推进，全部技术事务结算后才可待命。实际浏览器验证上述分支，含停止失败多次推进不唤醒主控、讨论／修复不回答业务问题。

### 独立接管后的实际测试

实际Chromium重新操作原Demo：等待额度只启动排队target且busy peer不结束；准备与保存两次独立回执；压缩和重试分别确认；未决问题不能靠全局推进或普通讨论变成已解决；review继续讨论不接受／结束Work；休眠模型保存不唤醒或消费草稿；未知owner禁止发送；12Agent展开／收起和390px深色无横向溢出。截图`/var/tmp/nozeli-independent-agent-demo-narrow.png`。

通过首页链接进入伴随页，重新操作全部9场景与退出失败分支，检查busy peer、额度、宿主活动、冷恢复、未决决定、空闲期限、closure及review讨论，并验证跨场景未发送草稿保持、390px无横向溢出。截图`/var/tmp/nozeli-independent-repair-demo-narrow.png`；本轮记录`/var/tmp/nozeli-independent-demo-report.json`。UI改动使用实际浏览器验证，未重复跑与此Demo无关的生产全套测试；此前45项及宿主烟测仍是上一轮证据，不冒充本轮新增测试。

## 7. 生产源码接入（2026-11-02，源码完成，Linux限定深度验收通过）

本轮落实§5的维修轻量投影、确切原事务动作能力、已验证修复后尚未准入技术事件的持久结算，以及宿主修复／发布／closure对Agent回收和项目推进的保护。复用原项目／Work／job／维修账本与全局原生进程额度；不新增维修常驻角色或第二套任务板，不改变全busy／unknown时必须等待的硬限制。

- 宿主：先完成有界原事务恢复，再允许尚有必要的技术核对事件进入模型调度；只有验证成功且身份／版本完全匹配、尚未启动prompt／准入的queued维修事件可结算，已开始／效果未知／其他故障事件不吞掉。
- 维修读取：宿主IPC `managed.maintenance.status`迁移为有界分页标量DTO；离线状态不构造Controller、不加载完整维修正文、不启动owner。原生工具内部`Controller.maintenanceStatus()`仍保留原账本合同，不建立兼容别名。
- 维修动作：展示与提交绑定project／bug fingerprint／phase／job／Work revision。是否可重试由当前live action、次数、原任务／准入／权限和UNKNOWN事实核定；冷启动缺action不伪装可恢复。
- 项目与owner：原宿主事务、维修flight、发布／closure阶段有明确开始／结束通知，资格变化不依赖UI标签。回收只针对已核实安全owner，Work／进程配额独立。
- 生产UI：沿现有协作区显示紧凑维修摘要与按需详情，分页、能力明确、stale只读、请求绑定与迟到隔离；不影响输入草稿、历史、模型菜单或用户决定。

验证包括原事务恢复／绑定竞争／次数上限／冷开未知／queued与admitted边界／事务资格回归；真实Pi＋Git ref lock＋真实候选文件修复／一次Worker执行／原Work和线程保持／空闲回收；真实Electron维修展示、草稿、明确审核接受、冻结忽略文件和可执行位／正常退出。旧`desktop-maintenance-live.mjs`切换Pi并保留其真实原生文件、忽略产物和显式合入断言，不以旧OMP验收外推。最后统一运行构建、相关专项和完整默认回归，失败原件不计通过；不安装、提交、推送或使用付费模型。

### 已落盘模块与核验要点

- `managed/controller.mjs`、`maintenance-ledger.mjs`：确切action／binding、有限效果尝试、已验证action身份栅栏、独立finalizing落账、已结束Work的原closure决定恢复、完全匹配未准入技术事件结算、按target的hostOperations和正常停止等待。
- `main/storage-maintenance.mjs`、storage worker／ProjectStorage与`managed/maintenance-status.mjs`：SQLite worker提取标量，最大50行／64KiB；游标绑定数据库incarnation、project／instance、存储与实时能力版本。损坏对象、JSON字符串伪装对象、非法attempt、跨项目身份、不安全整数均归入unknown／blocked，不能计作成功；NULL flight不抹掉合法排队项。
- `managed-projects.mjs`、`managed/collaboration-status.mjs`：只读状态不启动Controller或owner，retry校验原binding再派生当前能力，project聚合宿主事务／repair flight而非仅看native busy；不因页内没有运行者就丢掉项目推进。
- `renderer/collaboration-status.mjs/css`：复用协作区的维修摘要／分页展开详情，默认显示工作标题，UUID／原binding留在技术详情；能力控制重试或完成维修收尾。迟到／过期快照只读，不跨项目更新、不重发动作；草稿、焦点、历史模型和结果／用户决定独立。

独立host与surface reviewer分别检查维修并发／权限和分页／UI安全。正式发现均按实际源码及回归修正：结束后的closure误拦截、效果验证后保存失败导致任务悬挂、自动runJob错误进入业务recovery、损坏记录被计为修复成功、编码字符串与不安全整数、SQL NULL排队计数。后续复核对其已审查修正无新增阻断项；review仅是源码判断，不冒充替主助手运行验收。

真实Electron额外暴露原Worker正常完成与延期发布恢复的并发缺陷：维修动作短暂恢复Work运行资格时，原回合尾部可能误触发“缺少交付”并暂停它，造成Workspace发布`stale or inactive run`。现仅在原job与当前Work仍绑定同一维修bug时跳过该业务settlement，由原维修事务完成发布；不同job／旧revision不被泛化豁免。新增实际runJob＋真实工件／报告持久化门控回归，保持一份Work／输入／结果，不靠mock回执放行。

### 已观察的最终专项结果

- 当前修复／分页／生命周期／额度／协作定向73/73通过、零跳过；包含上述并发、反复持久化失败、耗尽效果次数但仅补结算、冷开不可重建action、真实ended closure与恶意元数据边界。原报告HTML完整字符串断言误把宿主阅读样式注入当成错误，已删除该实现断言，改验真实存储报告摘要与冻结工件完整性；未重钉样式文本。
- `npm run build:renderer`及注册Electron smoke 5脚本通过：真实文档宿主`apps/desktop/.test-output/ci/smoke-ZBOsv4`，PPT实际引擎导出`/var/tmp/nozeli-ppt-pending-Dv1iBu`，原协作组件`/var/tmp/nozeli-collaboration-ui-wryW7e`，维修组件`/var/tmp/nozeli-repair-consumer-GW0HRP`。最终默认摘要去除UUID后的维修组件另在`/var/tmp/nozeli-repair-consumer-b2o1zv/report.json`9项通过，390px截图已检查。组件网关为确定性夹具，不计为原生Pi。
- 真实Pi＋实际文件／Git ref-lock／受限全局额度2：`/var/tmp/nozeli-pi-repair-live-nvsmnu/report.json`6项通过。冷读零owner，宿主快速恢复零推理，原Worker只发一次输入和发布、原事务有界恢复、三个声明文件（含忽略产物）冻结，分页及全局计数、review owner闲置退出但Work配额／thread保留、全部自有PID确认退出且无延迟重放。测试仅以构造器缩短闲置期限，不新增产品环境后门。
- 最终真实Electron＋Pi＋原生命令／文件／Git完整链路：`/var/tmp/nozeli-pi-maintenance-ui-bFrSD6/report.json`4组通过、exit0，模型请求9次均来自脚本化本地Provider。原生宿主读取普通`.ccb`输入、宿主精确编辑、真实bash生成并执行忽略脚本及验证JSON、真实分支锁故障／原生status→retry、同Work／thread／job维修、真实维修详情与未发送草稿保留；原文在接受前不变，实际报告确认后才合入三份精确冻结字节及执行位。临时debugger／prototype包装已删除，最终验收不依赖诊断脚手架。截图已实际检查。
- 原真实生产Pi对话回归`/var/tmp/nozeli-pi-electron-E0bqoN/report.json`10项通过，含原文／材料分层、逐target模型与旧owner拒绝、真实历史模型、390／190px、正常退出及冷开草稿不重放。

失败尝试均保留、不计通过；限Linux x64、隔离项目和本地确定性Provider。真实账号OAuth／付费模型、Windows/macOS、全局公平性／死锁消除、安装／提交／推送／发行未验或未执行。以下默认／live／smoke分别计数，不将重叠专项相加冒充全套。

### 最终完整验收

- `npm test`：unit **560/560**（64文件）＋integration **1598/1598**（152文件），共**2158项**，0失败、0跳过；最终TAP：`apps/desktop/.test-output/ci/unit.tap`与`integration.tap`。早期两次完整运行暴露的元数据计数与新增报告样式断言失败均未计通过，修正后重新完整运行。
- `NOZELI_TEST_LIVE=1 NOZELI_OZONE=x11 npm run test:live`：**36/36**（7文件），0失败、0跳过；实际私有Pi／文件／Git／本地HTTP，覆盖原生工具、压缩、交付预算、拒绝／未知输入不重放、本地授权协议、维修生命周期及真实Electron冻结工件接受。原始`apps/desktop/.test-output/ci/live.tap`；本次套件中的Node维修证据`/var/tmp/nozeli-pi-repair-live-egWQWh/report.json`、Electron维修`/var/tmp/nozeli-pi-maintenance-ui-lihwb2/report.json`。
- 最终`npm run test:smoke`：**5/5脚本通过**；原始`apps/desktop/.test-output/ci/smoke.log`，文档宿主`apps/desktop/.test-output/ci/smoke-rDq89h`、PPT`/var/tmp/nozeli-ppt-pending-16Y9El`、协作`/var/tmp/nozeli-collaboration-ui-ymaUMG`、维修消费者`/var/tmp/nozeli-repair-consumer-vvZPnO`。
- 加强实际报告可见性后，`/var/tmp/nozeli-pi-maintenance-ui-VH2gvx/report.json`再次完整通过；另捕获实际隔离HTML正文`real-frozen-report-body.png`，不是只截审核按钮或拿空白宿主壳代替报告渲染。正文、真实维修对话和冻结文件审核图已检查。
- Demo快速修复场景已同步当前宿主先修复／确切未准入核对结算语义；实际浏览器核对宿主恢复阶段0新增模型调用，随后原Worker首次执行才有1次合成调用，草稿与390px布局保持。该Demo仍明确是离线模拟，不算生产模型证据。

用户指南、测试入口、生产状态、主设计入口与changelog已同步。临时main inspector／prototype日志包装与诊断驱动不留在产品或正式验收依赖中；所有凭据、项目文件和Provider均为测试自有合成数据。

## 8. 人工控制协同提案（2026-11-02，未实施）

[人工修复与任务控制设计](manual-task-control-repair-design.md)继承§7生产接口与验收边界，区分外部服务故障解除、确切宿主事务维修和任务人工控制。暂停门不改写正在发布的Work状态；原效果两次尝试／同Controller验证栅栏／finalize-only／cold no-replay不被人工按钮绕过。工作区顶部只升级必须用户处理的故障，右侧待办与任务目录保留；跨项目解除按绑定快照逐项目核验，不批量restart或无差别maintenance.retry。该提案不改变本节已实现API，不据此授权安装或重演旧输入。
