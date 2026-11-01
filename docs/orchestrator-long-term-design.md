# Orchestrator 长期多任务与 Plan Tree 设计

Date: 2026-11-01
Status: 独立设计审阅通过；P0 最小实施已并入主仓（见 §4.1 实施状态）；Plan Tree 版本治理等后续项须单独批准。
P0 实施边界：有界分页任务板、workId+expectedRevision 管理身份、事件 scoped 只读 inspect、continue-miss→dispatch fallback 移除。实施后尚未运行完整回归（见 §10）。
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

## 9. skill 在这里负责什么

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
