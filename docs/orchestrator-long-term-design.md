# Orchestrator 长期多任务与 Plan Tree 设计

Date: 2026-11-01
Status: 独立设计审阅通过；P0 最小实施已并入主仓（见 §4.1 实施状态）；Plan Tree 版本治理等后续项须单独批准。
P0 实施边界：有界分页任务板、workId+expectedRevision 管理身份、事件 scoped 只读 inspect、continue-miss→dispatch fallback 移除。实施后尚未运行完整回归（见 §10）。

2026-11-07最新系统合同为[Plantree统一报告与稳定结果记忆](plantree-result-memory-design.md)：树负责全部task报告及文档生成归属，结果记忆只消费稳定版本/完整收尾结果；短期理解由Pi/Orchestrator上下文管理，宿主任务事实仍唯一权威。此前[候选研究与Demo](long-term-memory-evaluation.md)保留参考，不将通用自动知识整理列为第一阶段前提；既有P0与已验边界不变，尚未正式cutover。

方向已固化在该主合同§15—§18：短期上下文自管理，主控按需检索、核对并绑定历史依据，不强制每任务搜索；`fe24f1c`已实现稳定报告检索/交接及多输入来源版本目录，尚未安装。后续先减少并发读竞争并实测模型质量，再统一完整Plantree归属、按规模增加持久派生检索，最后评估可恢复整理；不另建短期/长期任务账本。

2026-11-08用户新增方向：[简洁生命周期与项目初始化](project-lifecycle-initialization-design.md)拟扩展主控为一次有界项目梳理及程序辅助诊断；新项目已有AI配置/启用后自动整理，生成根索引关联的项目地图，程序负责预算/来源/发布和恢复真实结果。不是新增Agent或第二任务表，不能让项目打开依赖LLM；无法可靠恢复可提示明确完全重置。该设计尚未实施，替代旧“主控永不做项目理解”的绝对约束，但不扩大日常任务执行权限或授权删除。

## 1. 核心判断

当前不是“模型通过 skill 维护一张进度表”。**宿主持久任务账本负责排队和状态，Orchestrator 根据事件理解目标、查询事实、提出路由，skill 提供规则。** Plan Tree 是可检索的项目索引／历史资料，不是当前任务状态机，也还不是完整的版本化长期知识系统。

长期稳定不能依赖模型记得所有任务。应达到：模型任何时候压缩、退出、重载，都能通过稳定工具重新读回准确的当前状态、原目标、批准范围、证据和剩余动作；不自动重演旧输入。

## 2. 当前实现：事实而非未来能力

源码路径相对仓库根，分析对象为当前 Pi 源码树，不代表用户日常安装版已经包含此前全部修改。

| 部分 | 当前实现 | 不能据此声称 |
| --- | --- | --- |
| Work | `workspace.mjs:174–193` 保存原请求、brief、稳定 ID、名称、状态、revision | 已有通用层级计划、依赖 DAG 或模型理解的完成百分比 |
| 原生回合 job | Controller 队列保存每次输入、目标、来源、运行结果、准入与回执 | 一个 job 就是一整个长期任务 |
| 排队 | `Controller.pump()` 与 `activateNext()` 按 works 顺序选择符合条件的 queued Work，配额允许时启动 | skill 决定实际启动时间；已有完整优先级／公平调度 |
| 并发 | 同 target 单回合串行，多个 Worker 可并行；项目 Work 配额与全局进程额度分别门控 | 模型承诺的“并行”就已获得进程或释放业务槽位 |
| Work 配额 | `used()` 计算已激活且未 ended 的 Work；paused、review 等仍占用 | 回合结束或模型进程退出就释放 Work 名额 |
| 冷恢复 | `restore()` 保存并中断旧 queued/running job，coldQueued/coldJobs 不自动重放；执行中 Work 需要核对 | 重启后全部队列无条件自动跑完 |
| 进度 | Work/job 状态、工具回执、候选／问题／报告／审核和 closure 提供事实；时间线展示执行事件 | 流式“我正在检查”或模型自报百分比是已核验里程碑 |
| 调度工具 | inspect、dispatch、manage 读写宿主账本；结束／采用仍受用户绑定决定约束 | Orchestrator 可凭摘要自行接受或结束任务 |
| skills | `runtime.mjs` 当前为主控加载 memory.md 和四份固定 skill 全文 | 已实现只有 metadata 的按需原生 skill catalog |
| Plan Tree | `Workspace.plan` 指向项目 metadata 下 `memory/plantree/index.md`；结束后的冻结报告与宿主事实写入历史条目 | 报告被接受等于知识已获批准，或索引是最新进度权威 |
| 记忆检索 | `MemoryVersion` 核验根索引及直接链接的合规 topics 文件；`memoryContext` 做本地词项匹配和分页 | 递归全树、不可变历史 topic 版本库、用户批准语义或完备召回 |

关键路径：`controller.mjs:208–242` restore、`:561–567` routingContext、`:1148–1163` pump、`:1836–1872` inspect/dispatch、`manageIntake()`；`workspace.mjs:255–277,459–487` 结算／结束／归档。

## 3. 压缩究竟会丢什么

Pi compaction 改变模型后续可见上下文，不删除 Nozeli 的 Work、原生日志、冻结材料与回执。因此须区分：

- **数据仍在，但模型忘记入口**：需要短固定契约说明查询工具，不能依赖压缩前临时 readRef。
- **数据仍在，但读取视图不够**：当前任务板缺 ID／分页／阻塞原因，不能靠模型猜补。
- **摘要失真或过期**：任务名称、已完成动作、批准范围不能以模型摘要覆盖宿主新 revision。

### 5.4 Closure 归档不是整合完成

实际 closure 流程必须明确区分阶段：确认停止 → 验证并保存冻结报告 → 首次更新根索引 → 候选验证、同意门及整合 → changed-files/provenance → Worker history/cleanup → closure complete → 再次更新索引。首次出现索引条目不代表已合入、cleanup 已完成或结果已采用。

项目数据库 closure、冻结对象和真实提交／文件回执是权威；Plan Tree Markdown 是可重建的派生视图，二者不是单事务。中断、冲突或索引并发修改时，按既有事实幂等修复索引，保留用户修改，不覆盖用户文本，不重启 Worker、不重放业务效果。

### 5.5 历史回执与陈旧状态

旧 Worker／旧 revision 晚到的回执可保留为历史证据，但拒绝其更新当前状态、发布成功标记或当前 revision；“记录历史”不等于“承认已发布成功”。

- **输入或效果未知**：有历史不表示允许重新执行；需要对账而非重放。
- **知识未归档或只存当前文件**：压缩无法替程序补上不可变版本与知识批准记录。

不追求“保证模型永远记住每个细节”，而保证“重要事实有持久来源、来源能重新定位、执行前能重新核验”。

## 4. Reviewer 指出的具体缺口

### P1：任务板不是可用的大规模分页接口

`nozeli_inspect_work('@state')` 当前调用 `routingContext({role:'frontdesk'})`，每行只有 name/status/revision，没有 Work ID、queue position、block reason、next action、report revision、event watermark、cursor。全量结果超宿主 allowance 时，`onTool()` 拒绝整份响应并停止该回合读取；不是自动给出第一页。任务足够多时，新回合也可能无法读到任务板。

### P1：读取身份和管理身份不一致

inspect 支持 `@work:<id>`，manage 当前主要按开放 Work 的精确名称匹配。取得 ID 不表示已经能用相同 ID 修改任务。未来必须同时迁移工具声明、消费者和回执为明确 workId／expectedRevision／幂等操作身份，名称只用于展示与检索。

当前不存在开放 Work 且无明确绑定等情况下，失配的 continue 可被转成首次 dispatch；压缩后失忆不得成为创建任务的理由。取消此 fallback 是本提案的行为变更，须后续明确批准，不在本轮修改。

### P1：事件只读入口的可达性

inspect 当前 intake-only，也阻止 maintenance/backstage 使用同一个通用任务板入口。应按实际获准事件提供项目／Work scoped 只读查询；不能通过放宽一个 handler 条件顺带开放 dispatch、continue 或恢复效果权限。

### 4.1 P0 实施状态（2026-11-01，源码事实）

- **有界任务板**：`nozeli_inspect_work @state` 返回一页有界行（稳定 workId、显示名、状态、revision、队列位、事实阻塞原因、冻结报告引用）＋配额与宿主生成的不透明 `nextCursor`；`nozeli_manage status` 与前台 `state` 读取共用同一板。cursor 绑定 project+filter+账本状态指纹（ID/状态/revision 序列），并发变化显式返回 `resyncRequired`＋新首页，不混页。按审阅收敛采用**最小指纹失效**：未实现持久 snapshotRevision/watermark、事件总线或增量变化查询（§6 的变化查询合同仍属后续）。
- **统一管理身份**：`nozeli_manage continue` 仅按 `workId`＋`expectedRevision` 提交，revision 在 store 序列化事务内复核；幂等按完整意图摘要（action/workId/expectedRevision/text），完全相同请求重放原回执，意图变化拒绝；`nozeli_dispatch` 同样按意图摘要去重。名称仅用于检索/展示，`continue` 未命中返回 `UNKNOWN_WORK`，**首次派工 fallback 已删除**（新任务必须显式 dispatch）。
- **事件 scoped 只读**：backstage/maintenance 事件可经 `nozeli_inspect_work` 读取 `@state` 分页与 `@work:<id>` 详情（`scopedReadonly`）并续读**自身详情签发**的 readRef，不获得 dispatch/continue 或其它效果；@conversation/@memory/@frontdesk-source 等 intake 专属入口仍不开放。
- **任务详情**：`@work:<id>` 增补原请求/brief/sourceJob、执行 jobs 摘要与 live owner（未知为 null）、输入与 worktree/candidate 基线（repo/commonDir/directory/branchRef/baseCommit/inputCommit/targetRef/targetHead，未记录为 null）、冻结 result/problem/回执计数/逐回执不可变 candidate 关联/closure 关联（含归档报告 digest）。详情本身有界：长原请求/补充输入/批准范围/偏离详情/closure 错误只给固定预览＋readRef 分页（scoped 事件只能续读自身详情签发的引用）；任务板行显示名按 UTF-8 字节预算截断，最坏页大小为固定上界。
- **已运行验证**：`apps/desktop/tests/managed-taskboard.test.mjs` 九项通过，覆盖 120 任务分页、cursor 失效、改名安全 ID、stale 不产生新工作、冻结报告候选及归档关联、长多字节名称与详情分页、scoped 只读。真实 ProjectStorage／Workspace／Controller 隔离无模型冒烟的 15 项观察通过，modelCalls=0，临时驱动已移除。完整默认回归 unit541/541、integration1534/1535，唯一失败暴露已知 Work 的 clarify 待办丢失归属：已改为稳定 workId＋expectedRevision 绑定，并在事务内核验身份/版本，任务结束只关闭其自身问题。修后相关 task-flow/taskboard/todo-lifecycle 共25/25通过，renderer构建通过；未将先前失败的全量运行标为全绿。§10 冷恢复/回滚/真实大任务量 UI 矩阵未据此验收。P1 排队策略、知识/Plan Tree 版本治理、预算统计均未实施。

### P2：Plan Tree 历史分类与版本治理不完整

归档写入 `<!-- report:<id> -->`，当前 `memoryContext.sections()` 主要识别 `<!-- work:<id> -->`，两者不能被误当同一分类合同。新设计需要将两类既有标记明确解析为历史证据，不把落在根索引的报告自动当知识规则。

MemoryVersion 只识别根索引直接链接、符合文件名模式的 topic，不是递归树或历史不可变版本库。未来批准知识必须绑定冻结正文，不把当前文件 digest 伪称已有批准历史。

## 5. 长程架构：三类持久事实，不设第二账本

### 5.1 当前任务板：宿主状态的唯一权威

复用现有项目存储／Work／job／回执，增加必要索引或字段，不另让模型维护 Markdown 进度表作权威。

拟议每个任务摘要包含：稳定 Work ID、显示名称、原始目标来源、当前 revision／状态、队列位置、阻塞／等待原因、已核验里程碑入口、最新报告版本、剩余动作、未决／未知效果、待用户决定、更新时间和证据来源。没有真实进度证据时显示“执行中／尚未核验”，不伪造百分比。

任务板应是从规范记录导出的视图；任何可导出的 Markdown／Plan Tree 任务目录都标注版本与导出时间，不能反向覆盖账本。模型计划是建议，不是实际状态。

### 5.2 Work 过程记忆：范围与证据

原请求、批准扩展原文、当前验收约束、已完成动作回执、里程碑、阻塞和具体剩余动作按 Work／revision 绑定。里程碑区分 proposed、observed、verified，不以模型“已完成”直接升级。

新的 Worker 或压缩后续聊只接收当前绑定／版本及短读取入口；长原文／报告按冻结来源读取。Nozeli 工具准入核验权限、CAS、暂停、结束和未知效果。旧 Worker 或旧 revision 的晚到报告只做历史证据，不覆盖新计划。

### 5.3 项目 Plan Tree：语义知识与历史目录

根索引保持短小，仅列主题与入口，正文在版本化主题／原件中。三类条目分开：

1. 用户批准的项目知识：具体来源版本、适用范围、批准／替代／撤销记录；仍为数据而非 system authority。
2. Work 历史：原请求、报告、接受／丢弃结果及宿主事实；接受结果不自动批准知识。
3. 待确认提议／冲突：双方来源可见，不以更新时间、检索排名或主控角色自动裁定。

可以保留可读 `index.md`／topics 文件，但版本与确认复用现有冻结对象／项目 metadata／CAS。知识目录不是第二任务状态机；当前任务状态仍查宿主。详细生命周期沿[三角色记忆设计](role-memory-skills-design.md)，不重复建一套 memory engine。


### 6.1 水位不是现有版本号的别名

Work revision、collection CAS、原生 session sequence 各有不同语义；当前没有统一 taskboard revision。拟议 snapshotRevision／watermark 必须由同一规范任务事务或既有持久事件事实导出，明确覆盖集合与提交顺序，不能复用模型填写的数字，也不能拿原生聊天序列冒充任务变更序列。若现有事实不能证明完整增量，返回 `resyncRequired` 并重新读取一致快照，不伪造 delta。

## 6. 拟议最小查询／管理合同

以下是逻辑接口，不是今天已经存在的 API；命名实施时沿已有 tools 收敛。

- **任务列表**：项目绑定、状态过滤、cursor、响应字节预算；返回有界摘要页和 nextCursor、snapshotRevision／watermark。
- **任务详情**：workId、所需 revision；返回当前事实和冻结来源入口，不默认附全报告。
- **变化查询**：已确认水位之后与当前事件相关的变化，分页；历史已清理或水位过期则返回明确 resyncRequired，重新读取一致快照，不能把空结果当“没有变化”。
- **知识检索／读取**：查询、来源类型、批准状态／范围；结果带版本、冲突和全文可读入口，按需分页。
- **管理动作**：明确 workId、expectedRevision、源事件／原用户输入身份、幂等键；提交前重核绑定，失配返回 stale 及最新读取入口，不凭旧摘要自动改名／重建／继续。

分页 cursor 绑定项目、过滤条件和快照／水位。并发变化下返回同一快照的后续页或显式失效；不能悄悄混合不同版本、漏项或重复项。数据／索引状态与权限都由程序负责，模型不填写内部水位。

主控每次相关管理动作前必须有该对象的当前事实；没有快照或其 revision 已失效就读详情。初次无绑定路由只读有界候选或按目标检索，不能全量 preload 所有任务。新事实已到并不代表模型已处理；“传输确认水位”和“业务动作处理回执”分开，不能因回答失败漏掉事件，也不能重放已执行效果。

## 7. 排队、事件和冷恢复

- 正常运行继续使用宿主按规则激活 queued Work；Orchestrator 不靠轮询模型推进排队。项目 Work 配额、全局进程额度、暂停／审核占位分别显示。
- 先保留当前顺序／准入政策。优先级、依赖 DAG、加权公平、定时任务是未来独立产品决定，不冒称已有，不用本轮设计暗中改变已接受任务的执行顺序。
- 同一业务事件幂等合并，取消／版本更新使旧事件失效；相关事件触发有限主控处理，不周期唤醒模型“看看有没有进展”。无任务／无事件时零模型调用。
- 业务数据库重开先恢复持久状态并核对原生 owner／回执；旧 queued/running 输入继续遵守 no replay。模型压缩不是宿主崩溃，不应把正常 queued Work 全部转 interrupted；两种恢复路径分开。
- 已完成效果只对账，不再执行；未知效果停止自动恢复，按真实核查入口处理；明确未准入且已有确定性恢复能力的步骤才允许原范围内恢复。
- 冷恢复后仍保留任务和队列目录；不能承诺所有历史排队任务自动恢复执行。若未来允许证明从未执行的 queued Work 继续自动启动，须单独授权和完整准入证据，不以“长期管理”消除原 no-replay 规则。

## 8. 压缩后的最小恢复流程

1. Pi 恢复自身规范历史；宿主保留当前事件的项目／Work 绑定及读取能力说明。
2. 如主控没有当前对象事实或原生 compaction 已使本地可见性证据失效，按事件读取有界任务摘要／当前详情；不重发整份历史。
3. 查询具体剩余动作、阻塞、最新报告和未决决定；只在必要时按版本读原请求／材料／知识。
4. 提交动作时验证当前 revision、用户范围及幂等回执；旧摘要与旧 Plan Tree 不能覆盖新状态。
5. 停止／恢复／派工结果以宿主回执确认，模型文字不是状态提交。

不能在 native compaction 的摘要里寄希望完整保留所有任务。固定短角色／工具契约使恢复入口可发现，当前数据使用有界查询或必要事件投影。预算沿现有上下文合同；必要控制无法完整容纳时阻断整个请求，不能丢掉控制事实继续执行。

## 9. 多项目 Agent 守护、空闲休眠与依赖唤醒（2026-11-01 分析）

本节是机制分析，不改变当前执行顺序、配额或 no-replay 合同。当前实现中的“free Agent”应拆成三种事实：

1. **空闲 owner**：Pi 进程仍存活、没有当前回合／工具／终端／原生草稿／排队输入，可被宿主安全回收；不是“免费名额”。
2. **sleeping slot**：进程已回收，但项目、角色、threadId、draft、Work 与队列仍在持久状态中；唤醒必须是显式连接或已准入任务的宿主调度，不是模型自行轮询。
3. **available capacity**：全局 process budget 尚有可同步预留的 native owner 名额；它与项目 Work quota、任务队列和 token budget 分离。

### 当前事实

- `AgentProcessBudget.reserve()` 同步占用 slot，`bind()` 只有确认整个 Pi 进程树退出后才释放；未知退出、未确认 descendant 或平台能力未知时保留 slot。跨项目并发 start 不会双占同一名额。
- `ManagedProjects.reclaimInactive()` 先回收非当前项目、非请求项目的最旧 controller，再在请求项目内回收非目标 idle role。`Controller.canReclaimIdle()` 拒绝 running/current/starting/restarting/configuring、busy、tool call、native draft、external terminal、queued/running job；普通内置 terminal 也保护，只有隐藏 terminal 回收显式允许关闭。
- 当前实现**不是按时间自动休眠**。切换项目且有容量时保留 idle owner；达到容量压力才回收。项目激活本身不唤醒 sleeping role；显式 `connect()` 或 accepted queued job 的 `pump()` 才会尝试 `startSession()`。唤醒不重放已完成输入；cold `queued/running` 仍转 interrupted 并建恢复待办。
- `Controller.pump()` 只在项目已 started、存储 online、Work quota 有余量时消费 queued Work；无 owner 且全局满时先请求回收安全 idle owner，失败则保留队列。`ManagedProjects` 的 controller state 事件会 kick 其他 controller 中“已有 queued job 且没有 live owner”的调度器，已有真实测试证明背景完成释放容量后另一项目 queued input 可执行一次。
- Pi `prompt()` 以 admission tail 串行化同 owner；`stopIdle()` 只在无 busy/tool call 时进入 `stopOwner()`。停止先请求 runtime stop、flush、等待退出，再验证 owner-tagged process tree；失败保留 slot。原始 Pi runtime 的 lease/heartbeat保护同一会话写者，但 Nozeli 的跨项目唤醒权仍由 Host 持有。

### 分情况行为与风险

| 场景 | 当前行为 | 主要风险 | 推荐策略 |
| --- | --- | --- | --- |
| 项目A空闲，项目B有空闲名额 | A owner保持存活 | 常驻进程和内存成本，但切换低延迟 | 保持当前策略；增加可见“驻留/可回收”事实，不用定时杀进程 |
| B已准入且执行中，A请求新任务 | 不回收B运行 owner；回收安全 idle owner，必要时A任务排队 | 若全部 owner忙，A等待但没有优先级公平 | 引入项目级等待队列和事件触发唤醒；不抢占运行回合 |
| A有未发送原生草稿／终端 | owner受保护 | 长时间占用 capacity | UI显示阻塞原因，提供用户明确“保存/放弃并回收”，禁止后台静默丢输入 |
| Worker完成报告待审 | owner通常保留，Work仍占项目 quota | “完成”被误当“可结束”或自动续跑 | 报告进入 review；只回收 owner，不结束 Work；继续/接受由用户或显式事件触发 |
| Worker依赖主控／后台待办 | `kick()`和后台事件可唤醒 orchestrator | 依赖拓扑不显式时可能队列互等或无效唤醒 | 增加 durable dependency facts：blockedBy、sourceJob、expectedRevision、wake event；只唤醒能解除阻塞的 target |
| 空闲 owner回收失败或进程树未知 | slot继续占用 | 容量长期泄漏，但安全优先 | 保留 slot并显示“退出未核实”；提供人工核查／重试，不强杀未知PID |
| host崩溃后旧 queued/running | cold recovery中断，不自动重放 | 用户感觉“Agent没醒” | 恢复中心显示“未执行/效果未知/需核对”；仅用户显式继续或有未来单独批准的确定性未准入恢复 |
| 项目切换到 sleeping role | activation不自动唤醒 | 用户以为切项目即恢复全部 Agent | UI区分 sleeping 与 connected；显式打开对话、提交新任务或依赖事件才唤醒 |
| 多项目同时请求 capacity | 目前主要按 inactive activity LRU，缺乏公平／优先级合同 | 活跃项目或老项目可能饥饿 | 未来用有界 admission queue：project／target／priority／enqueueAt／reason；公平只作用于未开始任务，不改变已接受任务 |
| provider／model配置刷新 | 在线 owner在安全 idle boundary应用；running round不切换 | 多项目状态显示可能暂时不一致 | 每个 owner显示 requested/effective/pending；配置事件只触发受影响项目，不广播唤醒全部 Agent |

### 推荐的管理模型（后续实现，不是本次提交）

1. **Host-owned lease table**：每个 project/target 一条 owner 状态，包含 `state=running|idle|sleeping|starting|stopping|unconfirmed`、threadId、ownerId、generation、lastActivity、blockedReason、workId、dependency keys、wakeReason。它是派工事实，不由模型填写。
2. **事件驱动 wake broker**：事件类型限于 `capacity-released`、`job-accepted`、`dependency-settled`、`user-opened`、`provider-ready`、`recovery-confirmed`。事件按 project/target 过滤、幂等合并、有界重试；无事件零模型调用。一个项目有运行 Agent 时，可以唤醒同项目另一个 sleeping Agent，但必须先满足 dependency/owner/slot 门，不能因为“同项目”而全量唤醒。
3. **两阶段 admission**：先在宿主事务中保留 job 与依赖快照，再同步 reserve slot；spawn 后写 owner receipt；启动失败只释放未产生 owner 的 reservation，未知结果转 `unconfirmed`。唤醒不是重新提交原 prompt；它只恢复 thread，新的模型输入必须有新的 durable job 或明确 continuation receipt。
4. **依赖优先而非项目全醒**：前台提交→主控路由→Worker执行→报告审核是有向链。只有 predecessor 的 confirmed fact 满足 successor 的 `blockedBy`，才创建 wake intent。依赖冲突、版本过期、权限或用户问题保持 blocked，不通过唤醒绕过。
5. **回收策略分层**：默认不设固定 idle TTL；先回收跨项目且无依赖、无草稿、无终端、无队列的 idle owner；高内存压力可提出回收建议但仍走同一安全准入。长期 sleeping 只保留小型状态，不保留Pi进程；日志/原文按现有持久化与分段读取。
6. **公平与可观测性**：显示每个项目的 `running/idle/sleeping/queued/blocked`、占用与等待原因、预计触发事件；记录 `wakeRequested/wakeGranted/wakeDeferred/wakeDenied`。指标只解释事实，不让模型通过自填状态改变调度。

### 明确不推荐

- 不要因为一个项目有运行 Agent 就自动唤醒该项目全部 Agent；会造成模型空转、额度消耗和依赖环放大。
- 不要用定时器周期唤醒模型检查进展；用宿主事件和持久队列。
- 不要抢占 running prompt、带工具调用或未发送原生输入的 owner；停止结果未核实不得释放 slot。
- 不要把 sleeping 当 completed、把 free 当 no-owner、把 queued 当 safe-to-replay；三者分别是资源事实、进程事实和业务准入事实。

本次源码证据与隔离实测：`managed-projects.mjs:165-170`只在容量需求时按非当前／非请求项目的活动顺序回收，`controller.mjs:3122-3133`定义安全 idle predicate 与退出确认；`agent-process-budget.mjs:11-33`在 owner tree 未核实前保留 slot。真实 Pi／loopback smoke `/var/tmp/nozeli-pi-real-IcwI0E/lifecycle-analysis.json`验证两个 owner 满额时 busy Worker不可休眠、idle peer可释放、同项目/其他角色可取得新 slot、唤醒不产生模型请求、原 thread/journal恢复且仅显式新输入产生一次请求。该 smoke不覆盖完整 Controller 依赖公平或跨项目饥饿证明。

## 10. skill 在这里负责什么

skill 说明“遇到某类事件应如何查事实与管理”，不是进度表、调度器或永久记忆。
### 7.1 队列长度与背压边界

Work 并发上限和进程额度不是持久队列长度上限。当前审阅路径没有通用的待处理队列容量／背压合同；是否设置容量、达到上限如何拒绝或保留输入、是否允许批量排队及公平策略，都是未来明确的产品决定，不随本设计默认新增。

- handoff：判断真正新目标与原任务续接；核对原请求、材料和已完成／未知效果。
- followup：绑定同一 Work 和最新 revision，不自建替代任务。
- clarification：仅处理真实业务歧义，不把技术错误变成用户答题任务。
- project-maintenance：用户明确诊断与可核验恢复，不无限自动模型检查。

现有四份正文固定加载的实现与未来 skill catalog／按需加载分开。后续迁移必须先有真实可读取入口、资源来源白名单和预算覆盖；不能只删正文让主控失去规则。强制权限／CAS／发布／停止边界仍由宿主门控。

长期运行的是宿主和持久任务状态，不要求模型永久驻留；进程回收不等于任务失忆。也不需要增加另一个“记忆 Agent”周期总结全部任务。

## 10. 迁移顺序与验收

1. 优先有界任务板与明确身份：读取分页／ID／revision／阻塞原因／水位，管理动作生产者与消费者同步切换。
2. 将相关事件的只读可达性、去重及对账补全；不扩大效果权限，不新增技术诊断扇出。
3. 按已有 Work 证据建立可恢复的里程碑／剩余动作视图，未知仍未知。
4. 修正 report/work 历史标记分类，逐步接入批准知识版本与冲突／撤销；旧资料保持历史，不批量自动批准。
5. 校准压缩／冷恢复／大任务量下的有界查询和 UI，删除旧名称执行／全量状态返回路径；不保留双权威。

P0 最小实施已并入源码，但下表场景**均未运行完整验收**（新增单元测试与无模型冒烟脚本见 §4.1；其余场景仍未执行）：

| 场景 | 验收要求 |
| --- | --- |
| 100个以上任务、多个 paused/review/queued | 有界分页可读全目录；稳定 ID 不丢；配额与队列顺序真实 |
| 查询过程中新增／结束／改名任务 | 一致快照或明确 cursor 失效，无静默漏项 |
| 主控自动／手动压缩后管理 | 当前任务事实按需恢复，原始输入／效果不重放，无全表回灌 |
| 原生 owner 回收与同线程恢复 | 不丢 Work／队列；重建读取能力但不恢复旧授权 |
| 宿主崩溃／unknown commit／重复事件 | 以原 ledger／receipt 对账；不自动重投未知输入 |
| 旧 revision 的继续／取消／晚到报告 | 明确拒绝陈旧身份，不创建替代任务、不覆盖当前状态 |
| Rollback／版本回退 | 不逆转或隐匿已发生效果；保留批准／撤销历史与未知结果；代码／文件回退另需明确授权和当前基线核验，不自动执行历史命令 |
| Changed files／并发用户修改 | 区分 Worker 候选、冻结报告指向文件和当前项目文件；效果绑定真实 digest／revision／commit；用户后改不得被旧回执覆盖 |
| 真实 task 进展与模型叙述不一致 | 状态与已验证证据分开，不伪造百分比或完成 |
| Plan Tree 新旧 report/work 标记、topics冲突 | 均是可追溯历史；当前知识批准版本与冲突明确 |
| 无事件或只是查看任务板／记忆 | 零额外模型调用，零自动总结／上传 |

reviewer 已从当前源码提出上述缺口与收敛方向，主代理核对并整理文档；独立设计审阅已通过，要求补齐 closure 归档顺序、rollback／changed-files 门、水位语义与 queue backpressure 边界后无设计阻断项。P0（有界分页任务板、workId+expectedRevision 管理动作、事件作用域只读、continue-miss fallback 移除）已实施并附单元/冒烟脚本但未跑完整回归；版本化 Plan Tree、持久水位与变化查询、P1 排队/知识/预算统计仍属后续待批实施。本文档不授权安装、重新执行旧任务、清空会话、知识自动学习或跨项目导入。

## 11. DeePoly 普通后台请求缺少路由回执：复盘与稳定性路线

**状态：只读现场复盘＋两位独立 reviewer 源码审查；未实施、未重跑现场、未改权限。** 本机 `intake-history-local-01`。原 `intake` `6b0bbea5-ff85-4cf5-b1d2-0f35693d2478` 为普通后台提交（无 `restrictedMode`），使用 `paratera/gpt-6.1-sol`。Pi 已确认原输入入册（`7124f8c8`），两次原生 `read` 成功，模型以普通 `stop/completed` 结束；没有 `nozeli_dispatch`／`nozeli_manage` 调用、路由回执或对应 Work。该请求无匹配的效果授权记录、服务故障成员或退出清理失败。宿主在 `Controller.runJob` 的无路由后置检查报错；不是已证实的权限拒绝或网关故障。前次选源交接的确定性 `handoff-dispatch` 不走这条普通模型路由，相关修复不能覆盖本次。

模型说它只有读取和诊断工具，且同一原生线程前序有 DEBUG 记录。**尚不能区分**当轮实际下发工具目录不完整，还是目录正确但模型受旧诊断语境影响而误判：配置里的工具定义、工具字符数和模型文字都不是实际外发 schema 的证据。当前 `bridge.mjs` 在受限回合后尝试恢复工具，现有恢复测试用的是模拟的 active-name 列表，未覆盖已安装 SDK 的真实外发目录。另有合同缺口：skill 把 `manage status` 用于状态询问，但普通 intake 中它是非终结读取；仅查状态后自然结束仍缺路由。

**诊断已激活，自动续行未激活。** 原请求 12:06:14 UTC 失败；绑定 `maintenance` `8f717da4-1e39-4cdc-93b8-15556a0c32c7` 随即开始，12:06:53 完成 `debug.report`（两条源码检查回执）。账本为 `needs-version-fix`／`awaiting-fix`，`verifiedFix:false`，宿主事务修复次数 0、`continuationCapability:null`。现有 `debugContinuationCapability` 只为历史 `DISPATCH_BRIEF_EMPTY` 且存在确切派工拒绝证据的未路由 intake 提供临时续行；本次只有通用 `INTERNAL_FAILURE`，没有该证据，也没有注册可验证的维修动作。同一主控生成诊断不等于有权修改产品源码或重放业务输入。没有服务故障记录，因此外部网关解除入口不适用；现有恢复器把该已送达请求保守标为 `CHAT_EFFECT_UNKNOWN`，不可据“无 routing”推导“所有效果为零”。

### 按以下顺序实施与验收

| 阶段 | 改动 | 必过验收 |
| --- | --- | --- |
| 1. 精确归因与工具契约 | 在 Pi 实际请求发送边界按项目实例、owner 代次、job/request/attempt 与受限模式记录有界工具名、schema 摘要；记录末个工具结果类型、普通停止/异常、可见路由回执。不保存 prompt、工具参数正文或凭据。普通、DEBUG 各用独立的权威工具目录，转场核对；必需路由工具不齐则显式拒绝准入，不提交原生输入。 | 已安装同依赖的真实 Pi＋回环 Provider 检查正常→DEBUG 成功/失败→普通、重连、压缩、未确认停稳；逐次断言外发目录与权限，不以 mock 的 `getActiveToolNames()` 代替。若工具齐全而模型仍只读停下，修正本回合路由契约／诊断语境隔离，不把模型描述当权限事实。 |
| 2. 路由完整性 | 保留宿主守卫，拆出 `INTAKE_ROUTE_REQUIRED` 与工具目录不匹配、权限等待、真实外部服务故障等原因。独立任务、已绑定续作、明确只读查询、需澄清/核对各有独立决定；读取本身不结算。普通停止但无决定时持久化受阻结果，不猜 Work 或补造派工。确定性选源交接继续走现有宿主派工。 | 只读停止、明确查状态、歧义、既有 Work revision 变化、重复递交、崩溃前后；原请求不改写，错误分流正确，无幽灵任务；存在派工回执只读回，不创建第二个 Work。 |
| 3. 修复与原任务接续 | 将故障分类、诊断排队/运行/保存、可执行修复、验证和结算分别建模。在现有账本可靠交接 job→故障→诊断事件，冷启动核对断点并按同一键补记；无需模型即可验证的动作由宿主执行。无恢复能力显示理由。为已准入／已停止但效果未知提供原 job＋native entry 的明确核对与决策回执，核对后可提交**新指令**，绝不清空未知标记后自动重投旧输入。服务故障只走服务合同；诊断等待同一不可用模型时显示受阻。 | 故障记账后中断、重复诊断、诊断模型不可用、诊断成功但无动作、退出已确认但效果未知、权限/人工暂停/版本变化、存储回执未知。各路径有明确终态和下一步，零盲重试、零重复派工，不越权。 |
| 4. 用户状态与验收 | 工作追踪显示“诊断已完成／原请求仍受阻”，给出宿主记录的原因；只显示当前真实可用的核对、继续或撤销入口。诊断窗口不自动向共享主控发消息。 | 隔离项目验证历史 502、只读范围拒绝、普通缺路由及冷恢复可见性；安装版重启回读、零自动重放通过后，再经授权用真实 DeePoly 做现场验收。 |

Reviewer 另查到独立缺陷（不作为本次归因）：已准入的手动中断缺少解除 `CHAT_EFFECT_UNKNOWN` 的正式核对出口；宿主交接最终准入窗中人工/服务 hold 可被无类型错误误归内部故障；新主控工作记忆工具需进入诊断脱敏名录，其预算不足返回必须保持非终结。分别补精确回执、透传 hold 类型、保留安全诊断字段和 `continueTurn`，不借此扩大权限。

### 独立方案复审：首批切口与禁止事项

两位 reviewer 对工具传播和宿主恢复分别做了只读复审。首批并行交付两道围栏，不等待历史事故归因：

1. **先封掉原文重投。** `Controller.retryIntake` 现可用新请求键克隆失败 intake，不能凭 UI 隐藏挡住这个入口。保留 `transferring` 的停稳操作，分离同身份的安全准入；普通 intake 冷开先回读已提交路由/撤销/存储回执，已入册且待核对的不得自动进入 `continueSession`。只允许有正面未准入证据的原队列项按原身份准入。待核对不是可调度状态。
2. **固定每轮 Pi 工具合同。** `OwnerRuntime.prompt` 在预留交付身份和 `driver.sendUserMessage` 前，用可信角色配置安装并核对本轮工具名与定义摘要，不用上一轮 active list 作权威；只在确认停稳后恢复普通目录，恢复失败或停稳未知时禁止该 owner 接续。已核对当前安装的 Pi SDK：扩展 `before_provider_request` 会捕获异常并继续返回 payload，所以它只可用于观察，不能当硬拦截。发送前严格校验须放在可阻止 provider 调用的 SDK/适配器边界；已入册后挡住某次外发，不得记成原输入从未准入。验收用固定版本的真实 Pi＋回环服务检查实际外发工具及定义，按当前 API 格式处理增量工具声明、重试、压缩与无关流量。首批不拆诊断线程，不扩大权限，不记录请求正文。

之后复用现有 `job.routing` 和 Work 事务，集中提交新任务、指定版本续作、经宿主明确授权的只读答复或澄清决定；读任务板不等于终结决定。工具齐全但无决定的正常停止，应结算为 `INTAKE_ROUTE_REQUIRED`，不追加自动纠正回合、不补造 Work。相同回执只读回；不同请求键也不得让同一原请求链重复创建 Work。

最后补无 Work 的原请求核对入口：只读核对精确项目实例、原 job、原生 entry 与路由/效果回执，发现已有 Work 则打开原对象；允许撤销未路由请求，或在证据与当前授权满足条件时显式提交新指令。保留旧错误和未知效果，不自动回放原输入。诊断排队、报告保存和维修验证分别显示；跨账本用幂等补记恢复断点，不假定原子提交。首批必须以直接 IPC 旧重试拒绝、冷开零重放、真实外发目录正确及“两次只读后停止”未创建 Work 作为门禁。当前 DeePoly 旧请求不具备自动业务续行资格。本节为设计复审，未修改运行代码、未执行测试或现场任务。

### 源码实施与验证

- 旧重试入口只保留停稳转交源的动作。普通 intake 冷开优先回读已提交回执；已入册、效果不明或存储提交未核对的输入不重投。只读观察不是路由决定；无决定记 `INTAKE_ROUTE_REQUIRED`，真实授权等待单独结算。批准后在精确请求和授权绑定下发送批准告知，不复制原输入；后续澄清和 Work 保留冻结原文及来源身份，不把批准告知当成用户指令。
- Pi 准入前安装验证本轮工具名及定义，只在停稳确认后恢复普通目录。固定 SDK 适配层核对外发声明并隔离重试对象，不记录正文、工具实参或凭据。源码 Linux 的真实外发验收使用 OpenAI Chat Completions 兼容回环，覆盖普通→DEBUG 成功／失败→普通、只读目录、重连、压缩及拒绝；其他编码只覆盖本轮源码复核，不视为逐服务签收。
- 工作追踪「核对原请求」只读本地账本；撤销另行明确确认、绑定项目实例，不撤回已经路由的请求，不抹去旧诊断或未知效果。后续任务由用户显式提交新指令。Electron 的六项消费者验证使用注入账本事实，不是完整 IPC 验证；另用实际宿主、Pi、Git 和回环服务实测冷开、核对、撤销零重放：原 intake 一条原生用户记录、一次合成文件效果、零 Work，独立 Worker 恢复与未准入队列仍正常。
- 定向套件 166 项通过；最终冻结补充和批准后澄清两项复验通过，另实测 PiSession 有回执的只读答复正常结算。不代表真实 DeePoly 现场重跑、真实远程模型、既有安装会话升级或其他平台验收；未安装、提交或发布。
- 内置 reviewer 复审关闭了宿主、恢复界面及 Pi 外发守卫的已报告阻断项。宿主与 UI 按审查范围签收；Pi 最后一轮复审确认适配器重试只能使用分离后的已校验载荷，不代表每种远程服务实测通过。
