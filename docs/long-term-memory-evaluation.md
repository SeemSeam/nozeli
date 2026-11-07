# Nozeli 长期记忆：候选评测与生产实施合同

Date: 2026-11-07。状态：**隔离研究／可运行原型；不是产品现有能力，不授权正式 cutover、安装、提交或迁移真实项目。**

**最新产品方向以[Plantree统一报告与稳定结果记忆](plantree-result-memory-design.md)为准**：Plantree管理全部task报告和沿树生成，长期记忆只引用稳定版本及关键结果，短期波动由Pi/Orchestrator上下文管理。本文保留候选研究、通用知识扩展提案、Reviewer纠错和独立Demo证据；通用knowledge批准/核验、多层语义提炼/skill演化不再是第一阶段实施要求，不能混用本文旧提案扩大最新范围。

主入口为本页；[主控设计](orchestrator-long-term-design.md)继续定义唯一任务账本，[角色记忆设计](role-memory-skills-design.md)继续定义知识准入，[上下文合同](context-delivery-design.md)定义 Pi 交付与预算。候选原始证据、锁与运行产物在 [`evaluation/long-term-memory-20261107/`](../evaluation/long-term-memory-20261107/)。仅合成资料；不读写 nozeli_test2，不用账号、付费端点或 CCB runtime。

## 1. 主方案与可推翻条件

**推荐复用 Nozeli 已有项目 SQLite／不可变对象存储，增加知识版本与来源关系、独立后处理 outbox，以及可完全重建的 FTS5＋显式中文双字／别名索引。** 不整体引入第二套 memory/agent runtime，不新增第二份 Work/job/receipt 状态库；Python 原型只验证合同，生产沿已有 Electron 存储 worker 实现，用户不安装 Python、数据库服务、Bash、WSL 或 Docker。

这是有界词法方案，不冒充语义理解或通用中文问答。自然语言长查询拆分、繁简／中英别名要给命中解释；未登记同义表达、否定、时间推理不保证召回。结果不足时仍可按来源目录／稳定 ID 浏览。默认无 embedding、无模型首启下载、无隐式整理模型费。未来若真实中文标注集证明词法召回不足，单独批准引入**可丢弃的** embedding 投影；不能改换权威库或降低隔离、撤销和离线浏览门。

推翻本选择的证据：同预算下某候选在同语料和所有硬门中证明更好中文召回、完整来源版本、发布原子性、清除无复活、三平台封装，并且维护／分发成本可接受。框架存在、带 hybrid 标签、进程 exit 0 或云端 benchmark 均不足。

原样复用：SQLite 的事务、FTS5、Nozeli 现有冻结对象／CAS／项目生命周期／Pi session。必需 adapter：中文规范化、别名、范围／状态过滤、版本绑定分页、来源读票据、outbox 与 lineage 失效、导出导入。不可外包：用户采用与知识批准区别、Work 真状态、owner/instance fence、未知效果不重放、未保存编辑、永久清除、批准范围和宿主工具准入。

最小存储约束：`UNIQUE(project_id, knowledge_id, revision)`、head 对 revision 的外键、source digest／span 的边界检查、有效区间非负、approval 指向精确 revision+digest、outbox 的幂等键唯一、非活动 lifecycleEpoch 禁止领取／提交。正文版本与准入／撤销事件追加不改写；当前 head／派生状态可更新但必须 CAS。来源边需同时有正向和反向索引，跨项目外键默认拒绝；没有明确映射的跨项目导入不能复用原边。`corpusVersion` 只在影响查询可见性的事务中由程序单调推进；仅更新时间、文件 mtime 或模型给出的数字不能担任版本。

自动抽出的“skill”最多是带来源的提议，不自动写入 Pi 可信技能目录。若用户另行批准转成执行技能，仍需独立的角色资源 allowlist／版本／授予流程，保存全部来源依赖；源撤销后新目录发现与加载即时停止，已进原生历史的文字不能承诺被擦除。长期规则正文与可执行宿主能力始终分离。

生产接线范围（本任务不改这些源码）：`workspace.mjs` 的冻结／closure事务登记知识来源而不等待抽取；`managed-storage.mjs` 保留 business/local分界与unknown核查；`project-storage.mjs` 纳入新表／对象／outbox的生命周期准入；`storage-database.mjs`／`storage-worker.mjs` 增加有回执、局部CAS事务和检索命令而不放松8000ms deadline／隔离规则；`controller.mjs`、`frontdesk-read.mjs`、`memory-version.mjs`、`context-reader.mjs` 同包迁移到稳定ID／版本来源；`project-lifecycle.mjs`／`permanent-project-reset.mjs` 覆盖全部新持久物；原生Pi bridge和设置／来源详情消费新DTO、预算及失效状态。旧read selector／root append在迁移完成后干净删除，不以兼容别名长期双轨运行。



## 2. 当前实现与直接复现

运行 `node evaluation/long-term-memory-20261107/baseline.mjs`。原件 `baseline-report.json`；脚本导入真实 `ContextReader`、`memoryContext`、`MemoryVersion`，只在临时合成目录操作。

- `workspace.mjs:updateArchiveState` 写 `<!-- report:id -->`，`context-reader.mjs:sections` 只认 `work`。3 个合成 report block 实际成为 1 个 index，historyMatches/recent 为空。
- 9 个同等相关主题仅返回 4 个，无总命中或后续页；预览前 500 字，实际“混沌目标”在后文，预览无命中段。
- `MemoryVersion.snapshot` 只认直接 `topics/[A-Za-z0-9_-]+.md`。中文文件、锚点、嵌套路径未纳入；合成 missing 链接进入 topics，但正文 null。当前无完整遗漏诊断。
- Node 22.22.1／SQLite 3.46.1 的 unicode61、trigram：`双星混沌` 中“双星”“混沌”均 0 命中，四字整体命中；不把 FTS5 当已解决中文。
- 正向能力：当前 `ContextReader` 冻结长 UTF-8 来源，按字节分页并完整拼回原文。不要为换检索重造 Pi 历史或破坏已有预算屏障。

`managed-storage.mjs:saveManagedState` 现有 intent-first／项目事务／本机回执分阶段；project 与 local recovery 不是一个事务。现有 `memoryPending` 不是已经完成的语义知识系统。`archiveReport` 在 mutate 内更新 Markdown，不意味着 Markdown 与 SQLite 同事务。新实现必须接入既有事务／unknown reconciliation，不能仅在 closure 之后加一个不可恢复的 callback。

## 3. 权威、身份和时间模型（生产提案）

| 层 | 权威 | 允许用途 | 禁止推论 |
| --- | --- | --- | --- |
| 当前任务 | 现有 Work/job/receipt/closure／真实文件效果 | 查询当前进度、剩余动作、未知效果 | 摘要或知识覆盖当前账本 |
| 来源证据 | 现有冻结 object＋source revision／原生 message 身份 | 按 digest 和 span 重开原文 | 当前磁盘代替旧版本 |
| 历史 | 不可变原报告、采用／丢弃事件及主机事实 | 回答“当时为什么失败” | accept=事实正确，discard=不可检索 |
| 知识 | 同一项目库的不可变 knowledge revision＋准入事件＋来源边 | 带状态、时效、冲突的项目结论 | 已批准=永真／有执行授权 |
| 投影 | FTS、片段、可选向量／graph／skill 建议、Plantree 导出 | 定位与导航，可全删重建 | 投影是第二个事实来源 |

可移植知识版本的稳定身份为`(projectId, knowledgeId, revision)`，由宿主分配；名称、文件路径、topic标题和本机实例均不是内容身份。`(instanceId, ownerId, lifecycleEpoch)`只绑定运行租约、写入准入和本机读取票据，不进入可移植内容主键、来源边或批准身份。保留项目身份的设备迁移保留内容ID，但重新建立本机owner/票据；复制为独立项目须显式映射project/knowledge/source身份并重新核对批准适用范围，不能继承旧owner写权。永久清除后新项目身份不能复用旧ID或票据。

每个版本记录 `bodyDigest`、来源类型、Work/report/message/object ID、来源 revision、digest、UTF-8 byte span `[start,end)`、引文 digest、记录时间 `recordedAt`，及业务有效区间 `validFrom/validTo`（未知为 null）。源为 PDF/图时保留页／区域与派生文本版本，不编造文字 span。验证 byte span 和 digest，正文不可得返回 missing，不降级读取当前文件。模型只给候选正文、引用选择和语义关系；宿主生成内部 ID／digest／时间与协议。

知识状态拆成独立维度，不采用`confirmed/verified/conflict`互斥的单轴枚举：

- `approval: proposed | approved | rejected`：用户对确切revision、digest和适用范围的准入决定；批准不等于真值背书，报告accept也不是知识批准。新正文默认proposed，旧版本批准不自动移到新版。
- `verification: unverified | supported | verified | invalidated`：证据核验事实，记录方法、证据版本和核验时间；verified不能替代approval。模型生成只能是主张或待核验支持，不能自报verified。
- `lifecycle: active | superseded | retracted`：版本当前使用资格；superseded保留明确替代边，retracted阻止今后推荐及旧票据继续供给，历史正文不改写。
- `conflictGroups`：关联冲突组、双方确切版本和未决/已解决事件，与approval/verification并存。已批准且有效的知识存在未决冲突时，默认检索仍返回该项及风险摘要/对方版本入口，不靠过滤隐藏矛盾，不按时间或排名裁决。
- `sourceAvailability`与`validFrom/validTo`：分别表达证据可得性/撤销影响与业务有效范围；未知不能当作永远有效。部分来源失效先标依赖受损并核对剩余支持，未经重新核验不能继续保留依赖旧证据的verified断言。

正文revision不可变；批准、核验、替代、冲突和撤销以追加事件记录，当前维度是其可重建投影。任何影响查询资格的事件同事务推进corpusVersion。展示可组合为“已批准 · 有核验证据 · 存在冲突”，不能用单个badge抹掉其他维度。默认当前知识要求精确版本已批准且lifecycle有效，并核验时效/来源资格；仅verified但未批准不得入默认集合。未批准的相关冲突版本可返回为风险入口，在打开时沿其既有访问授权检查，不因作为冲突证据而自动升级为当前知识。

来源文件删除不等于物理删除冻结历史。外部源消失先标 source-retired／missing 并暂停依赖其有效性的当前推荐，保留当时证据；用户明确撤销证据则按 lineage 递归失效派生内容。永久清除项目才清除全部关联受管正文，包括历史和旧恢复对象。

### 3.1 拟议表及目录

同一 `project.sqlite` 增加 knowledge_heads、knowledge_revisions、knowledge_sources、knowledge_relations、knowledge_approvals、knowledge_tombstones、knowledge_outbox、knowledge_corpus。SQL FTS 和 snippet cache 是派生表；不把整个知识集合塞回每次 managed state 的全量 JSON 替换。任务状态仍在既有 managed 表。生产须新增存储 worker 的**局部事务 API**，在同一事务验证来源／owner／CAS、提交版本／批准／outbox 和 corpusVersion；不是把当前 `replaceProjectCollections` 当无限扩展点。

```text
.nozeli/
  project.sqlite                       # 原项目库；知识规范记录与任务同事务边界
  objects/<existing-layout>/<digest>   # 复用现有不可变对象，不发明第二 object store
  memory/plantree/index.md             # 旧文件迁移输入；保留用户编辑，不后台覆盖
  memory/exports/<corpusVersion>/
    index.md                           # 有界主题导航，历史按年/月/稳定游标分卷
    topics/<knowledgeId>/<revision>.md
    history/<year-month>/<volume>.md
    manifest.json                      # 身份、摘要、来源、导出版本和丢失诊断
```

投影可读格式示例（**导出 schema，不是今天已存在的文件**）：

```yaml
schema: nozeli-knowledge/1
projectId: p-example
knowledgeId: k-integrator
revision: 2
approval: proposed
verification: unverified
lifecycle: active
conflictGroups: [conflict-example]
bodyDigest: <host-computed-sha256>
validFrom: null
validTo: null
recordedAt: <host-recorded-utc>
sources:
  - kind: report
    workId: w-example
    reportId: r-example
    revision: 2
    digest: <frozen-source-sha256>
    spanUnit: utf8-byte
    span: [0, 36]
relations:
  - type: contradicts
    knowledgeId: k-integrator-old
    revision: 1
---
在给定双星混沌测试条件下，建议比较辛积分器；尚未验证普适性。
```

真实导出含完整摘要，示例占位符不是已批准／可导入记录。中文标题任意，文件名只用宿主 ID，导航不靠正则猜业务身份。历史“尚未合入”原文保留为当时报告，与后来 merged 事件分栏；Host facts 走宿主稳定 URI resolver，不再输出无法解析的 `project.sqlite#...` 相对文件链接。

## 4. 写入准入、事务与独立后处理

1. 报告冻结、Work closure 依旧按原业务完成；同一持久事务登记 source observation 和幂等 outbox（`project/instance/source/revision/digest/extractorVersion`）。既有完成历史通过有水位的 reconciliation 补齐。索引失败不重新跑 Worker，不把 knowledge complete 作为 closure 成功条件。
2. 确定性编目自动允许；**语义抽取仅用户启用整理并选择模型／本地或远程数据范围后运行**。默认关闭；没有新的隐形 Agent 常驻或无限派工。Orchestrator 仍负责路由，不凭名字假定已经整理知识。内容理解由已有明确委托的 Worker／frontdesk 或独立可恢复后处理调用承担，不新增 agent runtime。
3. 领取 outbox 写持久 lease、owner/epoch、attempt；调用前冻结来源集合。模型返回候选正文／引文范围／可能冲突。程序验证 schema、span、source digest 和作用域；不能程序验证的语义标 proposed。accept/discard/失败仅来源属性。
4. 正文先写现有内容寻址对象，独占创建＋fsync，重新核验摘要；事务再引用已持久对象。对象已写但事务未提交仅留无引用对象；有界 GC 按保留期回收。不得先提交指向未持久正文的 head。
5. 项目事务内复核 `expectedHeadRevision`、审批快照、源 tombstone、owner/instance/lifecycleEpoch；插入不可变 revision／lineage、head、outbox 完成和 corpusVersion。相同幂等键同一意图返回原回执；相同键不同内容拒绝。不确定 commit 经原回执对账，绝不再调用业务模型或盲目覆盖。
6. FTS／片段／导出独立消费持久投影任务，版本落后明确 `indexedThrough`。摘要是带全部来源边的可重算派生项，不能遗漏 lineage。模型失败进入 retryable/blocked，保留尝试原因，有限策略只重试原知识事件；不用新的 Work 掩盖失败。
7. 用户批准要预览完整候选或明确选段、来源、范围、冲突；提交校验候选 digest/版本和用户操作证据。新正文新批准；规则、长期偏好、跨项目复用、skill 启用和任何执行效果不能由自动抽取批准。

**外部编辑不静默覆盖**：内部规范记录不可直接编辑；导出文件按 corpusVersion 不可变独占创建，绝不后台覆盖用户可编辑的旧 index/topics。发现导出被修改，保留原字节并作为 proposed 外部 revision；比对其基线，不和后台整理竞争同一原路径 rename。需要写回用户文件时沿现有文档 CAS／草稿门，非合作进程在最后检查后仍可能写入，不能声称普通 compare＋rename 消除了 TOCTOU。生产验收必须覆盖 OS 保存机制；无法原子保证则只产出旁路候选供显式合并。

幂等保证的是**规范知识发布一次**，不是远端 LLM 物理调用恰好一次。抽取请求在发出前记录 attempt／输入摘要／预算，结果不明时先核对已存回执；provider 无幂等支持则显示调用／计费可能重复，仅在用户启用的有界重试政策内处理。无授权不为补摘要新开模型回合。源 tombstone 或 owner epoch 已变则即便晚到模型响应有效也只隔离，不可发布。


## 5. 检索与续读合同

工具名字实施时沿已有 `nozeli_inspect_work @memory`／原生只读来源入口收敛；以下为逻辑 API，非新增现成工具。

- `query({text, kind, approval, verification, lifecycle, conflict, scope, validAt, recordedBefore, pageSize, maxBytes, cursor})`：项目和本机读取许可由宿主绑定，不接受模型任意projectId绕过滤。默认选择精确版本approval=approved、lifecycle=active且时效/来源资格有效的知识，verified不替代批准；先选合规候选，再附其未决冲突组和来源风险，不用conflict过滤使已批准条目消失。历史、提议和失效知识分区可查，不自动提升。调用者可按核验程度收窄，但不能让更高核验级别绕过批准或访问准入。
- `open({knowledgeId, revision, sourceId?, span?, cursor?, maxBytes})`：稳定 ID 重新签来源票据；引用绑定冻结 revision+digest。无权限／已撤销／缺失／过期分别返回明确状态，不回退最新磁盘。
- 返回`corpusVersion, indexedThrough, tokenizerVersion, queryVersion, totalMatches, returned, hasMore, nextCursor, coverage, skipped, missing`，以及候选的approval、verification、lifecycle、conflictGroups、来源可得性、validTime、命中段、normalizedTerms/aliases、排序解释和稳定读入口。冲突证据与当前结果分别标识，风险摘要/入口也计入字节预算；不足时返回可续读入口，不能静默省略冲突存在这一事实。totalMatches是当前查询/过滤的词法命中总数，不是语义相关总数。
- 确定性排序：查询精确度／字段权重、状态过滤后的相关度、稳定 ID tie-break；不以文件遍历顺序或“最近”代替真值。不要仅把旧 top4 改大。第 5 项后必须可遍历，响应 byte budget 包含全部 JSON 元数据。
- cursor 为宿主不透明票据，绑定项目、实例、规范化 query/filter、corpusVersion、排序版本和最后排序键。可采用**变化即 resyncRequired**而不持有长 SQLite 读事务；不承诺 snapshot 历史无限保留。新版本不能拼到旧页，撤销／清除即时校验优先于旧快照。查询未变的 tokenizer 升级同样使旧 cursor 失效。
- coverage 明列 authorityRows、indexedRows、failedRows、unreadableSources、partitions、unreadRanges；未知数量用 unknown，不伪造百分比。索引缺失可退回有界稳定目录浏览，明确 degraded，不偷偷全库扫描挂住 UI。
- 来源页绑定 revision/digest 和 UTF-8 边界；预算不足返回尚未交付区间／continuation，不静默摘要。沿 ContextReader／DocumentReader 已有 full JSON 计费、64 KiB run／256 KiB代次的现有合同；不是新增 token 承诺。跨 run 用来源版本重新签票，区间并集才证明通读。
- 模型必须把零命中理解为“该查询在这些已覆盖分区未命中”，不能断言不存在。词法召回不足显示未匹配词、别名和可浏览目录，不让模型靠搜索排名裁定冲突。

FTS5 的编译／tokenizer 边界见 [SQLite 官方说明](https://sqlite.org/fts5.html#tokenizers)及 [trigram 限制](https://sqlite.org/fts5.html#the_trigram_tokenizer)。中文双字规范化版本和别名表必须一起锁定，路径／代码符号保留原字段精确查找；参数绑定之外还要将用户文本转义成 FTS 字面词，不能把任意 `OR/NOT/*` 当宿主过滤语法。别名是可审计的受控词表，不是已测通用繁简转换模型。


## 6. 生命周期、失效与安全

所有派生表包含源 revision 的反向边；多层摘要／skill 建议也必须登记完整依赖，环或缺源条目隔离。撤销事务先标 tombstone 并增加 corpusVersion，读取／检索 join 最新有效性立即拒绝，后台再清物理 FTS／向量／graph／cache／导出；禁止“先删除向量、稍后标撤销”的可见窗口。失效任务可幂等重跑，不恢复被撤销 head。

| 事件 | 知识处理 | 运行约束 |
| --- | --- | --- |
| 关闭 | 保留内容，释放句柄，暂停后处理 | 写入 lease 结算后关库，晚到 callback 拒绝 |
| 移除 | 保留历史，不自动后台执行 | 沿现有实体核验后重新添加，unknown fence 不解除 |
| 归档 | 只读内容和未决知识事件 | 不自动启动模型、不复活原 Work |
| 源更名／移动 | 稳定源身份不变，记录位置事件 | 路径碰撞不认成新 owner；缺失链接诊断 |
| 撤销来源 | 全 lineage 当前使用失效 | 历史证据保留但不默认推荐 |
| 永久清除 | 清受管规范、对象、queue、派生、local recovery、旧 reset archive 和受管备份 | 全关联 owner 停稳／unknown 拒绝，最小技术 fence 禁旧写回 |
| 新实例／重新添加同路径 | 先核验实体及历史登记 | path 相同不能继承旧 token；清除后全新 project/instance |

永久清除沿 [principles](principles.md#永久清除项目状态后全新打开)，不用旧“归档并重置”语义替代。清除清单要纳入新知识表／outbox／cache／导出／sidecar目录与模型临时输入，清完验证无可恢复正文，先写最小 purge receipt 再允许创建新身份。只保留项目／实例不可逆标识、生命周期 epoch、阶段和技术回执，不留正文／可恢复 object backup。恢复入口先查 purge registry，拒绝自动恢复旧 project/instance；未知备份只读隔离。用户另存／外部备份和已发送给 provider 的内容不在本机可保证擦除范围，UI 必须明示。

知识是低信任数据，不放 system prompt；候选写入需宿主工具、绑定、CAS、批准。恶意“忽略限制／删文件”不能在记忆导入器执行，Markdown HTML 不带 Node／应用特权。但普通 Agent 是当前用户权限，不是恶意代码沙箱；不能凭标记承诺抵挡任意模型诱导工具调用。高危效果仍走既有用户授权门，知识批准永不授予删除／跨项目写权。历史 Pi 消息已含正文不能保证遗忘；撤销只约束未来宿主供给和效果。

## 7. Electron、Pi 与三平台交付

基线方案无新监听端口、无数据库 daemon、无新常驻 Python 进程；用既有存储 worker 非 UI 线程执行局部 SQLite 事务、FTS、分页和重建。复用项目库当前 WAL／备份约束，不擅自改变所有项目 durability 配置。批量索引有界事务、取消点、UI 负载限制；统计本机队列、索引水位、错误与磁盘占用。SQLite／native 的精确 Electron 构建版本和编译项必须由实际发行二进制探测，不拿开发 Node 版本代替。

Pi 只看短工具说明和有界数据。frontdesk 普通聊天仍零知识 preload；Worker 只读当前 Work 相关批准来源；Orchestrator 只读路由所需资料，不因为 outbox pending 就派 Agent。新增 DTO 同时接通 controller、storage worker、native bridge、budget、UI 来源详情和生命周期清除枚举，拒绝未知 schema，不留双入口 alias/shim。

设置入口：知识目录／提议与冲突；批准、替代、撤销；按当前／历史筛选；来源可得性、未覆盖和索引水位。诊断／重建零模型调用。整理默认关闭，启用时显示 provider、数据范围、预计调用单位和暂停／恢复；完全本地检索与远程抽取明确分开，默认无遥测。未授权不下载模型、不读取个人 provider key。可选本地 embedding 若未来批准，必须显式模型许可证／checksum／大小／下载同意／离线包和卸载范围。

| 平台 | 本次可声明 | 生产发布硬门 |
| --- | --- | --- |
| Linux x64 | 开发 Node／Python 隔离原型；非 Electron 生产 memory 接线 | 实际 Electron SQLite FTS 编译项、关库／崩溃／清除、包内路径和无 Python 必需依赖 |
| Windows x64/arm64 | 未实机 | Electron SQLite可用性、长路径／大小写／Unicode、文件锁与替换、进程Job Object/owner回执、签名安装／卸载、杀进程恢复 |
| macOS x64/arm64 | 未实机 | Universal/native架构、codesign/notarization、沙盒/权限路径、fsync／原子发布、休眠恢复、进程组收尾 |

若改选 sidecar，宿主须负责打包解释器、全部 native 库／模型、随机端口＋本机认证、启动握手、owner出生身份、退出／升级／崩溃恢复和清除；不能给用户一个 pip/uv/Docker 命令充当跨平台产品封装。

## 8. 迁移、升级和回退（须另行授权）

1. **只读 inventory**：锁定项目＋实例＋实体，读取冻结 object、Work/report revision／closure、原 index/topics；统计 report/work marker、重复／畸形／缺块、缺对象、破链接、非法路径／symlink。每项记 digest 和来源水位；保留原始字节，禁止解析失败就丢弃。
2. **schema migration**：备份现有库与 manifest，版本化 SQL 在项目存储 worker 单事务创建表；不移动用户原文件。失败回滚并可旧版只读。备份也纳入永久清除清单。
3. **导入历史**：同时识别 `<!-- report:id -->` 和 `<!-- work:id -->`，以明确闭合块解析；嵌套／混杂／身份冲突隔离人工核对，不用松散 regex 把全文升知识。冻结报告内容与当时状态原样保留，最终 closure 事实另引用；导入幂等键含 project/source/revision/digest/parserVersion。
4. **主题生成**：已有 topics 也只作未批准来源，模型主题总结为 proposed，来源全部可达。不把 accept 或文件存在转 confirmed。用户编辑带基线冻结，未保存草稿先保护，不悄悄改写。
5. **shadow 查询**：新索引与旧入口对照但不双写两份权威；保存每 source 的 migration record、authority watermark、数量／digest 对账、失败与隔离清单。source水位必须从真实持久事务记录导出，不能拿 Work revision 或 wall clock 冒充全库顺序。无可用增量时短写入屏障下重新一致 inventory／对账。
6. **并发追平**：旧业务写入持续记录同事务 outbox；将 snapshot watermark 后变更消费至最终屏障，验证无漏事件／无非法晋升／逐源摘要一致。旧 writer 在最后切换停用；同一产品包切换所有查询与归档消费者，不保留 report 写／work 读双合同。
7. **正式切换**：明确批准后，原路径 UI／Pi入口原子选择新 adapter，验证 ID open、分页、预算和回退。旧 index/topics 留只读迁移原件／用户文件；只有 inventory 全部对账、缺失显式确认、所有调用方迁移和用户修改保留后，才停止旧 append 和巨大 root 扫描。用户文档不是可随意删除的 obsolete code。
8. **回退**：切换前记录 schema／migration epoch 和全部导出 manifest。新写入过后不能让旧版忽略 tombstone／批准／epoch继续写；安全回退为兼容只读＋来源导出，或先做已验证逆迁移。不能直接拷回旧 backup 复活清除内容。保留新版本／用户修改，不回滚真实 Work 效果。
9. **升级**：tokenizer／别名／可选embedding版本改变仅重建新派生代，原语义正文不变；检查权威来源 digest、批准与撤销不变，切换索引代并使旧 cursor失效。schema升级先备份、事务迁移、校验再开写；失败维持旧代浏览。导出JSON＋不可变正文＋lineage＋schema manifest可离开本应用，不绑定某框架内部 ID。

## 9. 可执行生产验收门

以下是**生产实现后必须执行，不能用研究原型代签**。每行保留输入、barrier、实际存储／进程证据和失败原因；Linux／Windows／macOS分别记录。

| 门 | 操作 | 必须观察 |
| --- | --- | --- |
| G1 耐久与幂等 | 提取领取、正文持久、DB发布、索引、摘要各barrier kill真正进程，再冷启；同事件重放 | 无漏已提交知识任务、同意图一份版本、未知业务不重放；删全派生重建权威digest不变 |
| G2 人工并发 | 预览V1后外部改V2／未保存草稿，后台同topic整理；移动／改名／删除／破链 | 旧CAS拒绝，双方正文保留，ID不丢，缺源与链接诊断可达，无普通rename竞态覆盖 |
| G3 撤销与清除 | 源→摘要→摘要→skill/cache/向量链；撤销；永久清除；尝试旧queue/archive/backup恢复 | 新读立即失效，全部派生不可推荐；无受管正文／ghost，最小fence仍拒旧callback |
| G4 生命周期 | 关闭／移除／归档／重新添加／同path新owner／新instance；晚到写回／unknown | 不跨项目或新owner，未结算未知写入继续fence；清除失败不假装成功 |
| G5 离线和成本 | 断模型／网络／embedding，关闭遥测，冷启后浏览／查询 | 已有来源可用，明确degraded，知识任务可恢复，零隐形业务重派／无限Agent，记录调用数 |
| G6 真值与注入 | accept/discard/failed、已批准但冲突、verified未批准、旧版本批准、新revision、恶意记忆 | verified不绕批准，冲突不使合规知识消失且对方入口可达；批准只对确切版本/范围有效，无自动权限晋升；工具门拒越权/旧审批，原数据不改 |
| G7 升级迁移恢复 | 旧report/work历史、schema/tokenizer/embedding变化、备份恢复／导出重导 | 字节／来源／批准不变，水位可对账，cursor不混版，purge registry优先，无静默缺失 |
| G8 消费检索 | 1000主题同名／跨项目、双字／繁简／中英别名、路径符号、current/history、第五项后 | 标注expected IDs逐项对照，分页完备／稳定排序／版本绑定／片段相关；不以“有命中”代召回 |
| G9 长上下文 | 真Pi累计budget达限后跨run续读冻结源；中途修改磁盘 | 区间并集重建digest，缺页显式；原生entry及预算回执可查，无静默漏来源或重新派工 |

研究原型即使全部通过，也只说明选定合同在合成环境可执行。生产接线、真实模型中文抽取质量、多设备、断电硬件／磁盘故障、所有非合作外部写入者、三平台分发仍须独立证明。

## 10. 官方候选核验、shortlist 与反证

固定来源、完整commit、每份原始文件URL／SHA-256见 [audit/evidence.json](../evaluation/long-term-memory-20261107/audit/evidence.json)及 [audit/notes.md](../evaluation/long-term-memory-20261107/audit/notes.md)。已执行离线完整性检查：8组候选、223份官方材料，摘要全部匹配；这是来源完整性，不是8个运行通过。Basic Memory另有wheel／安装依赖／CLI实测证据。

| 候选／固定版本 | 许可及OSS边界 | 实质依赖／与Nozeli不兼容点 | 决定 |
| --- | --- | --- | --- |
| [Basic Memory v1.0.0](https://github.com/basicmachines-co/basic-memory/releases/tag/v1.0.0) | package AGPL-3.0-or-later，根AGPLv3；本项目亦AGPL，不单因许可拒绝。Cloud存储版本历史不能冒称local功能 | Python＋SQLite＋Markdown；正式file-first候选，stable permalink／本地文本搜索有价值，仍需Nozeli批准、实例fence、不可变来源与发布事务 | **shortlist并实际安装／运行**，检验是否值得整体引入 |
| SQLite 3.46.1＋显式CJK bigram／别名 | SQLite public domain；原型Python为开发工具，PSF运行时非产品新增前提；自编规范化无下载模型 | 复用现有库／对象，需实现增量事务、lineage和检索adapter；不是完整语义引擎 | **shortlist并实际运行，主推荐** |
| [Hindsight v1.2.0](https://github.com/vectorize-io/hindsight/releases/tag/v1.2.0) | MIT；OSS retain/recall/reflect与managed cloud分开 | npm是uv/uvx→Python daemon→pg0/PostgreSQL launcher，默认embed@latest须另锁；非strict tags会含untagged，不是项目授权。历史事件只存IDs/counts、受保留期约束、提交后best-effort | 不整体引入；冻结来源／批准／隔离不能委托给tags/history |
| [MemOS v2.0.34](https://github.com/MemTensor/MemOS/releases/tag/v2.0.34)；plugin 2.0.16-beta.1；main `d326a641…` | server根Apache-2.0，plugin package MIT但无对应独立LICENSE，分发范围需澄清；Cloud plugin不同 | server Python/Neo4j/Qdrant；local TS插件release Node≥20，main≥22、better-sqlite3 13.0.3、transformers，默认telemetry配置需关闭。deleteTrace不递归清L2/L3/skills；capture恢复有实现，但model→逐行写入→episode link→下游事件不是durable outbox单事务 | 算法参考，不引入自动学习／第二知识库，不能当已满足撤销和crash门 |
| [OpenViking v0.5.3](https://github.com/volcengine/OpenViking/releases/tag/v0.5.3) | **AGPLv3**，非旧宣传Apache；OSS与activation分布式／支持版不同 | Python＋Rust/CMake/native＋embedding/VLM。L0/L1/L2有用，但当前检索实际global vector＋filter/rerank，已移除递归树导航；session URI／migration/group API存在breaking changes | 导航投影借鉴，不整体替换来源与身份系统 |
| [Graphiti v0.31.2](https://github.com/getzep/graphiti/releases/tag/v0.31.2) | Apache-2.0，非Zep cloud等价物 | Python＋图DB＋LLM/embedding；Kuzu已deprecated；PostHog默认启用要显式关闭；时序图不等于用户批准和原文版本 | 时间/关系模型参考，不引入第二图权威 |
| [Mem0 ts-v3.3.1](https://github.com/mem0ai/mem0/releases/tag/ts-v3.3.1)，main `f1791daa…` | Apache-2.0；main的“OSS v3”是算法/API迁移，Python manifest仍2.2.1，不能编造pip3.x版本；graph迁Platform | main抽取ADD-only不表示手工update/delete消失；TS默认provider名memory但实际better-sqlite3持久vectors，另有SQLite history，不是易失Map。仍非Nozeli同事务／批准／不可变证据 | 不按“TS不持久”错误理由淘汰；按准入、lineage和生命周期差距不整体引入 |
| [Letta Code 0.34.44](https://github.com/letta-ai/letta-code/tree/5e20013556fb8f3c52dc4054e00f69bfb3215df8)、SDK0.8.73 | Apache-2.0；当前Node local runtime确实可无账号本机运行，不应只评旧Pythonserver0.16.8 | CLI engines须满足`^22.23.4`、`^24.22.1`、`^26.12.1`任一，比live docs严格，本机22.22.1不满足；CLI固定SDK0.8.38，非registry latest0.8.73。native PTY/sharp和完整agent harness；本地MemFS有Git，默认非semantic index，root可入system | 只为memory替换Pi不合适，不谎称必须Python／Cloud |
| [LangMem commit 8620b986…](https://github.com/langchain-ai/langmem/commit/8620b986af5b0c7593e6b7fbece2998690d22d15) | MIT，manifest0.0.30但未证明对应发布artifact，GitHub无release/tag | Python抽取／优化库＋LangGraph Store接口，InMemoryStore不持久；可选持久Store不表示自带Nozeli权威库 | 非完整memory候选，未来授权抽取接口参考 |
| [LanceDB v0.41.0](https://github.com/lancedb/lancedb/releases/tag/v0.41.0) | Apache-2.0，OSS local与Cloud分开 | Node≥22、Arrow peer、Rust/N-API；捕获native targets缺macOS x64，不能拿宽泛os字段冒充预编译覆盖；模型另授权 | 若需向量可考虑**可丢弃投影**，本轮无向量必要性，不加重叠主库 |

shortlist的控制变量是同一合成语料／独立oracle、离线文本检索、无模型／账号；不是为凑数部署所有服务。初筛中的三点已纠正：Mem0 provider名称不等于易失实现；Letta当前有Node本地runtime；MemOS不同固定树的Node engines不同。Hindsight history不能替代冻结revision，OpenViking层级存储不能被写成现行递归检索算法。

Basic Memory安装清单是159个精确版本，`requirements.lock`及`evidence/installed-distributions.json`保留直接Requires-Dist和许可证元数据。唯一空license元数据项`py_rust_stemmers@0.1.8`已继续打开wheel所带LICENSE确认MIT，原文及`license-resolution.json`保留；这不是全面法律／源码再分发审查。未安装的候选只有固定manifest依赖清单，**无已解析全量transitive SBOM或运行资源数字**。任何未来分发还须审native/模型许可证和源码／NOTICE义务。

### 10.1 Basic Memory离线失败及修正依据

首轮`basic-memory/runs/final/`真实CLI建索引成功，但MCP启动在FastMCP4.1.3 banner独立version-check访问pypi.org，被DNS围栏拒绝；三规模检索未运行，不能称离线通过。Basic Memory的auto_update=false不控制此检查。随后按已安装FastMCP官方`settings.py`／`version_check.py`使用`FASTMCP_CHECK_FOR_UPDATES=off`，不改候选实现、不放开网络、不吞异常；失败原件保留。

第二轮`runs/final-offline-config/`暴露评测器聚合诊断把JSON list误作dict的AttributeError；已修正仅对字典诊断检查状态，保留该次原始产物。最终运行是否通过以独立`final-validated`报告为准；不以“修了配置”本身证明可用。


## 11. 同语料实际运行结果

最终顺序运行原件：[`runs/final-validated/report.json`](../evaluation/long-term-memory-20261107/runs/final-validated/report.json)，每个命令stdout/stderr在同目录。两个候选的业务详情分别为 [`basic-memory/runs/final-validated/report.json`](../evaluation/long-term-memory-20261107/basic-memory/runs/final-validated/report.json) 和 [`embedded/runs/final-validated/report.json`](../evaluation/long-term-memory-20261107/embedded/runs/final-validated/report.json)；精简汇总 [`comparison.json`](../evaluation/long-term-memory-20261107/comparison.json)。四个执行入口均exit0，但Basic结果为**实验完成且存在漏召回**，不是业务门全部通过。

环境：Linux x64，i5-13600K／20逻辑CPU／67,195,322,368 bytes RAM，共享工作站，非独占性能实验。Node22.22.1；Basic隔离Python3.12.13，embedded系统Python3.14.4，SQLite3.46.1。机器原始信息`machine.txt`。同一corpus SHA-256 `eab596d321cad3f1c74ef63ac49a2b020c2de33fb25ad303c6ada6b220ad0cdb`；1000条中alpha950、beta50，有无关负例、重复标题、繁简／英文独立表达、代码路径子集、六种状态和四种交付outcome；oracle独立人工规定预期IDs，不从被测normalizer反推。

### 11.1 召回与真实消费

1000条规模，**研究原型旧模型**的current限定alpha/i1、单轴confirmed或verified，不以accept筛选；这不是§3独立维度/精确版本批准合同的验收，不能证明“已批准但冲突可见”或“verified未批准被拒”。Basic下表使用显式native metadata filter，不把原始搜索当安全隔离。embedded使用显式别名及“在问题中定位已登记主题短语”的词法adapter；没有把完整测试问题写成单句特判。两者不存在语义质量同等配置的宣称。

| 查询 | Basic current recall | embedded current recall | embedded precision |
| --- | ---: | ---: | ---: |
| 双星 | 0.40 | 1.00 | 1.00 |
| 混沌 | 0.80 | 1.00 | 1.00 |
| 雙星 | 0.20 | 1.00 | 1.00 |
| binary chaos | 0.20 | 1.00 | 1.00 |
| 目前双星混沌应当采用哪一种积分方法 | 0.00 | 1.00 | 1.00 |
| finishClosure | 1.00 | 1.00 | 1.00 |
| src/agents/managed/controller.mjs | 1.00 | 1.00 | 1.00 |

有返回的Basic current precision均1.00，长问题空结果precision为null，不能写成100%。受控别名是额外adapter，所以本表**不能证明Basic语义引擎较差**；它证明默认离线词法路径不会替Nozeli完成中英／繁简／自然问句归一化。embedded对未知同义词、问题中的否定／多个主题约束没有理解保证。另以3种未登记整句措辞实跑同一主题定位，精确IDs一致，`embedded/query-smoke.json`；不是通用问答测试。

Basic raw history检索未加Nozeli项目元数据过滤，1000条时“双星”200条中10条属于beta；这是**将两个Nozeli逻辑项目导入同一个Basic项目后未施加host scope**的结果，不是证明Basic独立project授权漏洞。native显式scope/status后无此污染。history分区仍需来源类型、状态／时间和批准政策adapter。

Basic真实能力：三个规模均原生第5项后可达；逐ID读回10／100／1000份完整Markdown及原始source JSON完全一致；显式reindex后外部编辑可见、rename保留permalink、delete不可读且不再命中；真实reset后全部ID重建一致、稳定ID完整正文仍可读。重建／变更原件在各规模raw目录。外部reconcile前停MCP，**未验证实时watcher／并发外部保存／CAS**。将source JSON存进正文只是来源保真，不是候选已经理解revision/span或实现知识批准。

embedded三个规模的current/history/status精确oracle比较、稳定排序／5条页遍历、cursor过滤／项目／版本失效、每条source完整字节重组均通过；删FTS重建前后authority digest相同。其Python原型会materialize候选／可见记录，不作为生产大语料内存／SQL查询计划范本；生产应SQL scope join＋稳定排序／keyset有界取页，不能照抄小语料全量物化。

### 11.2 规模曲线与资源

下面延迟不是同一个层级：Basic是已连接MCP的14次首页往返（包含服务端首次惰性工作，非裸引擎）；embedded是14次in-process bigram查询API。索引Basic含冷CLI启动／Markdown导入，embedded是已建库后的队列消费。禁止由表计算“引擎快多少倍”。p95仅14样本，按nearest-rank，非容量SLA。

| 系统 | 条目 | 索引秒 | 查询p50 ms | 查询p95 ms | 数据字节 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Basic Memory | 10 | 1.857 | 24.239 | 474.958 | 587925 |
| Basic Memory | 100 | 6.244 | 22.766 | 493.372 | 2276186 |
| Basic Memory | 1000 | 51.133 | 31.421 | 478.166 | 13251848 |
| embedded | 10 | 0.030 | 0.131 | 0.165 | 208896 |
| embedded | 100 | 0.212 | 0.268 | 0.375 | 454656 |
| embedded | 1000 | 2.087 | 4.220 | 6.224 | 2678784 |

数据定义：Basic最终state＋notes logical bytes，含候选DB／状态日志；embedded最终DB＋SQLite sidecar，均不含评测raw日志、依赖安装或模型。Basic解释器／venv／下载缓存分别保留，venv logical401,105,906 bytes、setup缓存428,320,635、解释器home102,826,888，不能合称“记忆数据体积”。embedded新增安装字节为0，但既有Python／SQLite运行时并非零体积；正式产品不会携带该Python原型。

Basic完整场景（包含逐ID读取／多次重建）的采样进程树CPU秒为44.52／58.12／200.84；50ms采样tree RSS峰值355,082,240／361,676,800／391,131,136 bytes。进程树原始PID/PPID/create-time/argv/RSS/CPU逐样本保存在每规模`process-tree.jsonl`，不是只量父进程；RSS共享页可能重复、极短进程可能漏采。MCP冷启动分别2.070／2.146／2.117秒。

embedded最终完整场景wall4.585秒、parent CPU2.519秒、children CPU0.406秒，parent lifetime高水位38,764KiB，children为最大单子进程高水位38,764KiB，**不是同时tree RSS总和，不能与上项直接比较**。四个crash子进程重启并非新数据库daemon；其临时SQLite／backup/export路径均在报告artifacts目录。Basic为评测父Python→实际CLI／stdio MCP Python进程，无部署常驻DB daemon；实验结束退出MCP，原始树可核查。

最终Basic三规模guard外网／DNS／模型构造阻断尝试均0，模型完成调用0，空模型缓存；embedded未链接模型／网络路径，调用0。**这是离线文本基线的零调用，不是语义抽取零成本**。首次安装需要公共包／解释器网络且初次安装耗时未量，不能填数字；已装环境经显式关闭FastMCP版本检查后离线首启可用。未下载embedding模型，不能报任何模型大小、中文embedding质量或LLM费用数字。

### 11.3 故障、时间与真实产品边界

- embedded的extraction/body/index/summary四个**已提交阶段边界**子进程实际SIGKILL=-9，重启均0，最终durable phase4，同事件只有一份event/evidence/body/summary；原始checkpoint／数据库在其artifacts目录。不是断电硬件、未提交I/O任意位置或Nozeli外部object目录fsync测试。
- 实际SQL CAS旧基线拒绝／新revision保留；source→knowledge→summary→aggregate→overview递归撤销、重建后不复活；close/remove/archive／active reset拒旧owner/instance和晚callback；backup/export/restore／tokenizer/schema迁移通过。模型不可用仅用确定性availability gate模拟队列等待，不冒充真实provider outage或模型事实抽取。
- `temporal-smoke.py`真实隔离SQLite执行4个旧模型双时间边界：历史validAt、记录前尚未知、后来记录的回溯结论、显式包含conflict；旧source revision/digest保持，discard不阻止独立核验记录。`temporal-report.json`。这是单轴研究SQL smoke，不是默认查询冲突可见性、批准与核验独立性或生产validAt工具验收；原实验保留，不以新合同重写旧结果。
- 真实现有产品命令`node --test apps/desktop/tests/project-lifecycle-reset.test.mjs`本次11/11、无跳过：清全部旧代／受管Git资源、保留用户原件／邻项目／全局账号；stop/save/close失败持久fence、preview身份变化拒绝、未知owner拒绝、部分清除冷启不重放。观察摘要`lifecycle-reset-observed.json`，完整TAP在本任务工具记录。该测试使用真实ProjectStorage／ProjectLifecycle／SQLite／临时Git，但停Agent接口为fixture；**不代签真实在途模型/PTY，也不证明新memory表已纳入清除**。
- 当前生产ContextReader长UTF-8来源22页完整重组；embedded逐来源31-byte分页验证digest/revision/span。未在本任务启动完整Electron／Pi run累计budget链，因此G9的原生entry／跨run预算接线仍是生产门。

未实现／未验必须保留：实际LLM语义提取与冲突发现质量；向量／graph／skill／cache投影及其递归清除（主基线不引入这些引擎）；生产项目库增量事务／对象目录adapter；实时外部文件编辑watcher及非合作保存竞态；Electron UI／Pi memory接线；三平台包；硬断电／磁盘满／损坏WAL／多设备同步。本报告给完整实施合同与可复跑局部证据，**不把这些未验项改写成生产通过**。

## 12. 可直接执行的复现与实施顺序

在checkout根运行；以下是开发研究命令，不是要求普通产品用户安装Python：

```sh
# 当前隔离依赖已安装，不重复setup；换机器才先执行basic-memory/setup.py
python3 evaluation/long-term-memory-20261107/run.py --name independent-replay
python3 evaluation/long-term-memory-20261107/temporal-smoke.py
node --test apps/desktop/tests/project-lifecycle-reset.test.mjs
```

`--name`必须是未存在名称，绝不覆盖旧实验；runner按baseline→官方证据完整性→embedded→Basic顺序执行，逐命令保留argv／退出码／wall/stdout/stderr并写report.json，任一基础设施失败非零退出。**run完成不等于oracle全匹配**，检索精确ID／缺失与误召回必须查两个业务报告。源码／官方来源均在evaluation目录，不依赖本任务会话恢复。

正式实施须另获授权，顺序固定：现有项目库局部事务／版本来源与outbox→稳定ID查询及字节预算→批准／冲突／撤销与lineage→只读迁移inventory／shadow对账→真Electron/Pi消费与永久清除范围→三平台打包实测→最终写屏障cutover／安全回退。每阶段执行G1–G9中受影响门，模型整理最后以显式设置启用；不先开自动学习再补批准。所有本次文件改动限两份原设计链接、主报告和独立evaluation，无安装到日常版本、真实项目迁移、commit/push/release。


## 13. 主代理独立复核（2026-11-07）

- 已完整读取worker2交付，并独立运行`python3 evaluation/long-term-memory-20261107/run.py --name parent-review-20261107`，baseline/audit/embedded/实际Basic Memory四个入口均exit0；原件在`runs/parent-review-20261107/report.json`及各候选同名运行目录。嵌入式10/100/1000规模每组45个oracle检查均无差异，来源重组分别10/100/1000份；四个真实SIGKILL边界重启成功。Basic1000规模词法召回结果复现§11表格。exit0只代表实验完成，不把Basic漏召回报成业务全通过。
- 采纳主方案作为**生产实施基线建议**，不签“长期语义记忆系统已完成”。本次没有实际运行Hindsight/MemOS等自动提取引擎，也没有embedding/LLM中文抽取质量比较；不能用Basic默认离线词法与定制双字/别名原型的差异推出所有开源框架更差，亦不能直接比较MCP往返与进程内API性能。
- 独立纯函数边界检查：原型`query_text`对“目前双星混沌应当采用哪一种积分方法”“不要双星混沌，请查单摆”“双星混沌与网络权限分别是什么约束”“之前已经否定的双星混沌结论是什么”均选择同一短语“双星混沌”。这确认它是受控主题定位，不是意图/否定/多主题/历史状态理解。生产必须保留原查询、显式状态/时间与范围过滤、覆盖诊断和稳定ID浏览；不得照搬“取最长登记主题后丢弃其余查询”当通用检索，也不得把该实验100%召回当无约束中文质量承诺。
- 已核对Mem0保存的官方源码：`memory` provider通过better-sqlite3创建vectors表，release/main均有持久实现。此前主代理依据概览称其默认易失的判断已纠正；不以该错误理由淘汰Mem0。
- 本轮复核未改产品源码、未迁移真实项目、未安装或提交。后续仍须执行G1–G9的实际Electron/Pi/事务/真实模型与三平台门。


## 14. 内置 Reviewer 深化审阅与整合（2026-11-07，设计修订，非生产验收）

### 14.1 审阅结论及修订

内置`MemoryIntegrationDeepReview`独立读取方案、角色/主控设计、closure/managed-storage及原型消费者后，判原合同`incorrect`：总体方向可条件接受，但不能直接作为实施依据。Reviewer为只读代理，未编辑文件、未运行实验；本节及正文修订由主代理整合，尚未取得修订后的再次独立签收。

|严重度|原问题与证据|后果|本次设计修订|
|---|---|---|---|
|P1|原§3把批准、核验、冲突做互斥status；§5又默认confirmed/verified。原型`embedded/run.py:309–337`同样先单轴过滤|已批准知识一旦标conflict即消失；verified未经批准可能入默认集合|§3改独立approval/verification/lifecycle/conflict/时效与来源维度；§5先选批准且有效条目，再附冲突风险和版本入口；G6要求验证这两反例|
|P2|原§3知识身份含instance，而§1主键与跨设备合同不含instance；原型visible/materialize也混入owner/instance|同一内容迁移设备后身份变化，批准/lineage/稳定入口不自洽|内容身份统一project+knowledge+revision，运行租约/票据另绑定instance+owner+epoch；复制项目显式映射，不继承写权|

旧研究原型和实验原件不改写；§11明确其单轴状态及运行实例隔离并未证明上述生产合同。§3导出示例、§5工具参数/返回与§9验收已同步，不仅在末尾追加一份相反规则。这里的修订是设计纠错，不是实现或通过新状态测试的证据。

### 14.2 与 Plantree 结合后的实际使用面（主代理设计深化）

Plantree是**人和Agent共用的项目文档组织与生成入口**，覆盖方案、决策、实施、测试、报告和主题知识，不只是事后主题导航或导出页面。先定位已有树节点与文档职责，再沿节点生成或更新，避免Agent任意新增同类Markdown；稳定树节点ID与文档ID独立于路径/标题，知识版本使用§3的稳定身份。树的归属/文档类型/来源关联由宿主持久记录，Markdown目录/导航是这些记录的可读物化，不能全部当可随意删除的索引缓存。任务运行状态仍以Work/job/receipt为权威，树不复制第二任务状态机；树上归档也不使正文自动成为已批准知识。

用户在主题页看到当前适用结论、适用条件、批准/核验/冲突组合标签、来源和旧版本。直接编辑沿现有草稿与基线CAS保存为新提议版本，原批准版本继续保留；不能后台覆盖正在编辑的缓冲区。未决冲突在该主题页和搜索结果均可达，未确认提议可集中浏览；无需每个归档动作弹审批。只有把具体正文/范围纳入当前项目知识时确认，不能将成果采纳按钮复用成全部知识批准。主题目录/历史编目是确定性零模型操作，语义提炼必须显式启用。

多任务完善同一主题示例：

1. Work A发布“欧拉法可用于该模型”的报告：先进入冻结历史；提取为主题`数值积分`的V1提议，不直接成为规则。用户可批准其明确适用范围，但核验维度仍按实际证据标注。
2. Work B发现高能参数下误差大：来源和对V1的冲突关系记录为新证据/提议。V1若仍获批准，默认查询应展示V1及未决冲突，而不是悄悄消失或只给新报告。新的V2可限定方法和参数；用户批准替代时由事务追加V1 superseded关系，V1正文和证据仍可查。
3. Work C发现V2在另一条件也不成立：同主题新增条件/冲突，不靠“最后完成的任务”自动裁定。用户可以分别保留两个适用区间的结论，或保持待确认；查询明确给出适用范围与争议。一个任务可贡献多个主题，一个主题也可有多个Work来源，不按同名自动合并。

宿主通过稳定ID/CAS/事件管理此过程；LLM只提出主题归属、提炼正文、引用及可能关系。新主题、合并或拆分是有来源的编辑提议：合并保留旧ID重定向/替代边，拆分分配新ID并保留出处，不让模型靠重命名制造“同一知识”的假象。主题摘要依赖确切知识版本，是可重建派生视图；摘要自身不授予执行技能权限。

### 14.3 收尾后处理与长期稳定边界

- 报告/用户决定/真实收尾事实进入既有事务时，确定性登记来源和幂等知识事件；语义处理队列失败不把已完成业务退回running，也不重新派原Worker。历史导入使用可对账水位补齐，不依赖回调碰巧执行。
- 一个提取结果可涉及多条知识；每个发布使用源集合、预期head和运行epoch核验。多任务同时修改同主题发生CAS冲突时保留两个候选，不用最新时间覆盖。模型请求已发但结果未知不承诺物理exactly-once或零重复计费。
- source“文件缺失”、证据“明确撤销”、结论“被反证”、项目“永久清除”分别处理。多来源结论有一条来源失效时暂停依赖该来源的核验声明并标风险，不能自动断言其他来源也错；也不能只剩一个来源便自动维持原verified。重新核验可发布后续事件/新版本，保留历史链。
- 对象pin/GC必须识别有效知识、历史保留、提议、批准与待处理事件引用；索引可删不等于来源对象可删。正常保留期GC与永久清除分开，后者沿既有全项目停稳/围栏清理所有派生与受管备份，旧callback/导入先核验purge/epoch。
- Markdown可读性不靠直接开放内部DB文件编辑实现：提供主题编辑器、带ID/基线的导入/导出和完整来源manifest；离开Nozeli仍能浏览正文与历史。可重建目录丢失可修复，人工编辑原件不能被当垃圾投影静默覆盖。

### 14.4 实施顺序与剩余验证条件

1. **先修模型与权威事务**：独立维度、内容ID与运行权分离、源对象持久/引用、局部CAS与outbox同事务。先用反例验证approved+conflict仍可见、verified+proposed不准入、旧批准不跨revision、换本机不换内容ID、新项目不继承票据。
2. **再完成确定性知识目录与稳定读取**：旧report/work历史兼容解析、ID直读、来源字节版本、覆盖诊断/分页/预算、可重建索引及Plantree主题导航。没有模型也能查全历史和证据；不把主题树排序当真实性。
3. **接通编辑/冲突/撤销及迁移**：真实Electron/Pi、人工草稿并发、共享/部分来源失效、GC pin、关闭/重置/备份恢复及索引水位。已提交阶段SIGKILL不代替未提交事务、对象fsync、磁盘满或断电实验。
4. **最后验证并启用语义整理**：使用独立中文标注集加入否定、多主题、时间与未登记同义问法；对词法、词法+embedding、可选LLM规划以同模型/预算/授权条件比较，区分提取质量与检索质量。没有这些结果，不宣称FTS基线已解决长期语义理解，也不据本次Basic离线对照排除专用记忆引擎。

以上为修订后的实施基线建议；只有对应G1–G9的实际产品证据可关闭验收门。本轮没有新实验、没有改产品代码、安装、迁移真实资料、提交或推送。


## 15. Plantree 沿树生成与长期记忆结合（2026-11-07，用户澄清后的设计合同）

### 15.1 设计初衷与职责修正

用户希望避免Agent生成的方案等Markdown分散、同类重复、无法管理，要求沿树生成。故Plantree不能仅作为收尾后的可读投影：**它是生成前的归属约束、进行中的文档工作区、收尾后的成果与知识组织面。** §3所称“投影”仅指可重建导航/检索/摘要，不包括用户正文、持久树结构及文档归属；这些本身也必须版本化保存。§3.1原目录示例是知识导出布局，不是全部项目文档只能放在隐藏memory目录的规定。

|职责|Plantree组织层|长期记忆层|
|---|---|---|
|生成前|定位项目目标、已有节点、已有文档及职责，决定更新还是新建|提供相关决定、约束、证据与历史版本，标出冲突/缺失|
|执行中|方案/实施/测试等产物沿节点登记，稳定身份关联实际文件与Work|冻结来源、记录版本/CAS与关系，检索不混用历史和当前|
|收尾后|把实际产物挂回原节点，旧方案保留明确替代关系，不再额外复制一份“总结大全”|形成可恢复知识提议，记录批准/核验/来源；不把采用报告当批准所有知识|
|后续任务|从原主题/计划继续演化，必要时新分支，跨分支引用不复制正文|跨任务召回正确版本及适用范围，支持按ID直接读取与历史追溯|

树用于组织，不要求所有关联都塞成父子关系：一篇方案可以引用多个决定，一个测试可以支持多个知识条目。每份产物有一个主要归属节点，额外关联用有类型的引用；树移动不改正文身份和来源。计划生命周期和知识有效性不同：计划取消不自动判知识为假，知识撤销也不自动重放已结束任务。

### 15.2 沿树生成的最小工作流

1. **定位再生成**：宿主给Agent当前项目/节点、实际请求和少量相关文档入口；Agent通过目录和检索找已有方案/决定，不能仅凭相似标题认定同一任务。模型提出归属和文档职责，宿主绑定内部ID与版本。
2. **优先更新**：已有同职责文档时在该文档新revision中增补或修订，保留用户草稿和并发基线。若目标或适用范围确实不同，创建新节点/分支并说明区别，不硬合并不同内容。
3. **有界新增**：新建受管方案/决策/测试说明等文档时同时登记主要节点、类型、来源Work及与已有文档的关系。路径由当前项目约定与文档类型确定，冲突由程序检测；模型不填写内部ID。普通用户文档、源代码、论文、第三方文件不强制迁移进树目录，也不能仅因未登记就删除。
4. **执行与发布分开**：Worker候选文档也登记在原节点下但明确候选/未采纳；写入项目仍走原审核与文件CAS。Orchestrator负责找到节点和协调工作，内容由明确委托的Worker/用户编辑；不得为凑齐树形结构凭空新增方案、报告或模型任务。
5. **收尾回挂**：程序关联实际方案/代码/测试/冻结报告和采用/丢弃事实；自动维护目录与关系不额外索要知识批准。语义提炼若启用，再形成独立知识提议，不能让知识处理失败使原业务重复执行。
6. **继续演化**：新任务先展示原节点的有效文档、已替代项和未解决问题；新决策发布后保留旧正文并追加替代关系。树及检索必须能解释“该更新为何归这里”，不靠日期文件名无限增殖。

### 15.3 结构示例与可读性

以下是逻辑树示意，不是强制文件名模板，也不是当前产品截图：

```text
项目
└── 数值模拟
    ├── 目标与适用范围
    ├── 方案：积分方法选择         同一文档持续修订
    ├── 决策：特定条件采用辛积分器  引用方案及验证证据
    ├── 实施与验证
    │   ├── 实际实现入口           可引用源码，不复制源码正文
    │   └── 精度测试与结果         绑定实际版本/环境
    ├── 交付历史                   关联各Work冻结报告与采用事实
    └── 可复用知识与未决冲突       引用确切来源，独立批准/核验
```

节点按需要建立，不要求每项小修改生成整套空文档。正文可以是现有可见项目Markdown；数据库保存稳定身份、归属、类型、版本及关系，冻结对象保留历史证据。目录/正文需可整体导出并在不运行Nozeli时阅读；外部修改重新导入为带基线候选，不能把数据库存在当作禁止正常文档编辑的理由。一个检索结果同时给出树路径、文档身份、当前/历史资格和来源入口；树内浏览与全项目检索互补，不强迫用户先猜对分支。

### 15.4 后续实施与验收补充

- 先在既有项目存储增加最小树节点/文档归属关联，复用同一项目事务与来源ID，不新增任务调度器或另一套文件主库。树结构修订也推进目录版本；删除导航索引可重建，不能连同持久归属一起丢失。
- 受管文档生成入口应能够表达“更新原文档”“新分支文档”“引用既有文档”，绑定expected revision和节点版本；业务文件发布与树登记通过现有intent/receipt对账，不能文件已生成却永久失联。外部文件发现作为待归类项，不根据扩展名批量自动批准知识。
- 接受条件：同主题三次任务不会生成三套散落方案；目标分叉不误覆盖；同名异任务不误合并；节点改名/移动仍能打开原版本和证据；收尾后的每个受管产物可定位且未采纳项不会假装正式；普通文档登记不触发额外审批，知识批准也不授权文件效果；并发、崩溃、迁移/导出/清除保持正文与归属对账。
- 本节修正此前“Plantree只做导航/导出”的不足；仍为设计，未改产品、未运行新实验、未迁移任何真实文档、未安装或提交。正式实施须把沿树生成和记忆基础层一并设计，不能先完成脱离文档工作流的memory库再补目录。


## 16. Plantree 动态整理、防膨胀与独立 Demo（2026-11-07，独立验证通过，未接入产品）

### 16.1 “清洁”分为三个层次

1. **活跃工作面有界**：同一节点/职责文档优先更新，已完成分支归档后不进入默认树/默认检索；历史仍可按ID/原路径和来源打开。归档不是删除、不是知识撤销，也不等于原任务已被程序完成。
2. **知识精炼有据**：重复或相近主题合并、摘要压缩、方案取代属于内容工作，只能形成保留全部来源的提议；不按标题或年龄自动判定重复，不为达到条目数量目标牺牲必要细节。
3. **磁盘回收有边界**：可重建索引/缓存允许重建回收；物理对象GC只处理无任何规范版本/提议/引用/保留任务依赖的工具受管孤儿，且过宽限期。历史正文被引用就不是垃圾。永久删除业务历史是独立显式策略/确认，不把日常自动整理变成不可恢复清除。

因此“保持项目清洁”不能承诺档案总量永不增长：归档只降低活跃噪声，历史磁盘仍增长，应显示活跃/历史/对象/索引分项数量和字节。后续若需要历史到期删除、配额或压缩策略，必须先展示会失去哪些版本/证据与可恢复边界，不能因根目录超标自动删除用户资料。

### 16.2 整理政策与安全门

- 完成节点只有在整棵待归档子树不存在进行中/未决冲突、人工保留或来自活跃树的来源依赖时，才进入确定性归档预览。完成父节点下仍有活跃子节点时保留整个边界；默认按已确认完成状态，不单靠修改时间。
- 未保存编辑、正在发布的文档、待确认提议/冲突、用户pin、稳定入口与来源依赖均应在产品接线中保护。Demo只证明其实际实现的状态/pin/引用保护，不能宣称已对接Nozeli未保存输入和进程屏障。
- 预览保存候选ID、原因、保护原因和目录修订；执行验证expected revision并重新核验，任何pin/引用/文档改动使旧预览失效。事务内整批归档，不在UI先隐藏后异步补状态；失败明确保留原工作面。
- 历史浏览/检索和恢复是正常功能。恢复保留节点/文档ID及历史版本，不能重派原任务或写回旧文件；父节点归档、归属冲突时给清楚诊断或在同事务恢复必要祖先。
- GC预览与归档预览分开。仅Demo marker归属目录内普通digest对象可删除，禁止外部路径/链接；执行前再验目录实体、对象内容/依赖与宽限期。未知或并发引用保持保护。缓存损坏不影响按ID读取正文，索引重建不改规范摘要。
- 触发点为任务/文档事实变化后的合并整理建议与有界维护，不在每个token/每次打开时全树扫描；预算、暂停、失败与水位可观察。自动化只执行已明确启用且无破坏正文的规则；内容合并和永久清除不借“自动清理”授权。

### 16.3 独立可运行验证范围

独立目录`evaluation/plantree-lifecycle-demo/`，Node内置SQLite、真实受管对象文件、localhost API与浏览器工作台，不加载CCB、不复用Nozeli日常profile/用户项目、不新增模型费用。API支持节点和同职责文档生成/修订、pin/来源引用、活跃与历史检索、归档预览/修订校验执行、恢复、重建和孤儿GC。UI必须体现“沿树生成”而不是又一张孤立任务表。

验证要求：持续新增/复用、100/1000级节点与多版本、活跃保护与跨分支依赖、pin后旧预览拒绝、搜索完整分页/历史恢复、全索引重建规范字节不变、真实child进程SIGKILL边界后冷开无半归档/缺对象、宽限期GC仅孤儿且重复安全、用户/外部文件不动、浏览器实际创建/编辑/归档/恢复/错误/窄屏流程。记录修前失败、定位、优化与修后相同场景，不能只给最终绿色或只测内存函数。实测性能记录机器、规模、指标定义、查询数及是否独占，不拿一次快查询承诺无限规模。

所有Demo能力须经实际运行再写通过；不把独立Demo SQLite事务当已完成现有Nozeli存储worker/Pi/草稿/owner生命周期接线。正式结合前由独立reviewer审查数据与生成合同、产品适配、真实模型整理质量和三平台交付门，未经批准不生产cutover、不安装或迁移日常资料。


### 16.4 已完成的独立实现、反例修复与实测

独立工作台、服务与真实SQLite/文件实现位于[`evaluation/plantree-lifecycle-demo/`](../evaluation/plantree-lifecycle-demo/README.md)，总证据索引[`results.json`](../evaluation/plantree-lifecycle-demo/results.json)。可直接沿树创建/更新职责文档、标记状态、pin、引用来源、预览/执行归档、历史检索/逐版本读取/恢复、索引重建及宽限期孤儿GC。没有mock状态或模型调用；没有改Nozeli产品源码或迁移/清理真实资料。

- **故障与安全13/13通过**：真实SQLite与文件、HTTP外源拒绝、全局预览修订、文档CAS、active/conflict/pin/活跃来源保护、祖先pin保护、内部引用共同子树、历史/外部文件保护、归档恢复、索引重建。正文对象发布前后、归档事务提交前后、GC物理删除前后六个实际child SIGKILL点，冷开后保持规范正文可读，剩余孤儿可重预览回收。原件`/tmp/plantree-lifecycle-tests-7pyYzt/observed.json`，不外推硬断电或任意磁盘故障。
- **修前反例与修后证明**：Reviewer指出发布在事务外校验并复用孤儿对象，可被另一连接GC。父用`afterObject`确定性交错实际复现已提交文档读正文ENOENT（`/tmp/plantree-lifecycle-tests-Ge8Ei4`），将节点/同职责/CAS/对象创建复用放入BEGIN IMMEDIATE后，竞争写连接被正确串行化，同一回归通过。不是以加宽限期或吞异常规避。
- **浏览器完整流程通过**：真实Chrome创建分支、同文档多revision、未保存草稿阻止归档、pin使旧预览失效、显式归档不自动重开历史、历史检索/恢复/精确旧版读取、另一客户端V4后clean刷新、来源引用、维护操作不改变规范revision/正文、深浅主题与390px无横向溢出。可独立运行`ui-smoke.mjs`，原件`/tmp/plantree-ui-smoke-KxUM8m/report.json`；父浏览器直接驱动复核原件`/tmp/plantree-browser-20261107-r5/report.json`。已查看宽/窄实际截图。
- **修正真实UI问题**：创建/引用按钮定位ID与data-testid不一致；clean缓存挡住服务器新版本；归档后loadState保留正文却误开启全历史树。前两项由独立reviewer发现并修复，后一项由浏览器回归失败定位，现正常刷新不改变历史开关，明确打开历史文档仍可展开。测试驱动漏参及错误钉维护文案的失败亦保留，但不称为产品缺陷。
- **增长场景**：100与1000节点实际建库、每个职责文档正文落盘；80%完成节点归档，活跃树分别保留20/200，全部100/1000文档仍经历史分页完整查回。一个方案连续20次修订只增加不可变版本，不增加20份同职责文档。归档减少噪声而不减少保留历史字节，1020对象包括1000初稿及20个修订。旧版本正文按ID/revision读取，当前搜索索引覆盖heads而非所有历史revision。

归档算法原先对每个done节点重新建树、全扫文档/引用，已改为共享树索引、DFS子树区间、后序保护汇总与有界原因说明。以下为**同一1000节点合成场景、共享工作站的单次前后运行**，不将查询返回大小等同计算有界，也不推为容量SLA：

|指标|优化前|优化后|
|---|---:|---:|
|整理预览耗时|128.64 ms|3.93 ms|
|重验并执行归档耗时|118.55 ms|5.49 ms|

前后原件`/tmp/plantree-lifecycle-growth-687YjY/report.json`与`/tmp/plantree-lifecycle-growth-YecxNe/report.json`；环境Node22.22.1、Linux x64、i5-13600K、约64GiB内存。40次warm词法查询/规模以及写入、重建、RSS/object字节均在原件，不是引擎之间性能竞赛。实际Chrome千节点历史显示/隐藏40个同步DOM样本，最多1000节点可见，p50约4.1ms、p95约8ms，无横向溢出（`/tmp/plantree-large-browser.json`）；不包括所有网络/布局绘制耗时，不宣称无限大树性能。

### 16.5 Reviewer复审与结合Nozeli前的门槛

内置`TreeCleanupSafetyReview`首次判incorrect，提出publication/GC跨连接、UI按钮绑定和clean草稿刷新三项；修后只读复审均关闭，最终`correct`、confidence0.94，未发现修订带来的可证实新P1/P2。Reviewer未运行测试，该结论仅独立Demo静态正确性，不代签Nozeli集成或语义记忆通过。

用户可先独立体验：本轮本机服务`http://127.0.0.1:40409/`，受管数据`/tmp/nozeli-plantree-lifecycle-showcase-20261107`；服务可随本次开发会话停止，复跑方式见README。预置场景只有一个安全可归档分支，另三类完成分支分别因活跃子节点、来源引用、人工pin受保护，可直接比较整理理由。UI明确预览/确认，不用自动永久删除实现视觉整洁。

接入仍需：将TreeStore概念映射为现有project.sqlite局部事务而非第二主库；同一宿主负责全部编辑器/Agent的打开租约、未保存输入和在途发布；树归属与实际文件生成intent/receipt对账；批准/核验/冲突独立维度、知识outbox、按确切版本来源与对象pin/撤销/永久清除；生产cursor/分区与有界state读取；真实中文语义提炼/多主题质量及三平台封装。当前Demo是**可运行并经优化的确定性组织/归档/回收验证载体**，不是已经完成自动语义合并、全局草稿保护、生产记忆接线或历史磁盘有界治理；不以这次通过绕过上述门槛。

本轮未安装、提交或推送，未触碰日常项目数据。
