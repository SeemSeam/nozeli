# 三角色记忆与技能：来源治理、渐进披露和宿主边界

Date: 2026-11-01
Status: **独立设计审阅通过；后续记忆／原生 skill 系统实施须单独批准，不是已实施功能或运行验收结论。**
Scope: 保留 frontdesk／orchestrator／Worker；仅设计本文件。当前 context cutover 可移除重复事件提示和旧诊断扇出，不因此授权实施整套知识管理／原生技能迁移。

## 1. 决策与不做什么

以 [context-delivery-design.md](context-delivery-design.md) 为交付合同：Pi 独占原生历史、工具循环、压缩与恢复；Nozeli 管材料版本、Work、CAS、效果与准入。`memory.md` 是现有角色契约文件名，不是会话学习结果。三个角色不拥有各自不断增长的长期聊天记忆。知识是用户批准的项目来源，不是模型自行形成的权限或事实。

不新增记忆引擎、向量库、总结 Agent、第二历史账本；不自动提炼／学习 Work 报告，不导入私人笔记、全局个人技能或其他项目知识，不为索引、检索、详情、冲突检测、reload 发模型请求。Pi 原有 compaction 可能调用模型，必须独立标明，不能称为本设计的零调用操作。无安装、提交、推送、个人账号验证或用户会话改写。

## 2. 源码基线与明确差距

以下为本轮阅读的实现事实，后续并行 context cutover 可能修改；不是拟议能力的上线声明。

- `apps/desktop/src/agents/managed/roles.json`：frontdesk、orchestrator 为 resident，worker 为 dynamic；包位于 `roles/<role>`。不改变角色数量、模型或 effort 设置。
- `managed/runtime.mjs`：`rolePrompt` 读取 `memory.md`；frontdesk 默认全部技能，orchestrator 固定 `project-maintenance.md`，Worker 固定 report/task-boundary 并加载所选非 material 技能。`eventSkill` 为 intake 选择 handoff/followup/clarification；`readRoleSkill` 校验文件名／授予列表，返回正文 SHA-256。
- `managed/controller.mjs`：角色绑定含 skills、instructions、instructionDigest；resident 设置重启同线程，Worker 设置默认作用于新 Worker，既有 Work 保留绑定。当前 `nozeli_skill_read` 只向 Worker 注册，frontdesk/orchestrator 调用会被拒绝。设计不能声称三个角色今天已可调用此工具。
- 三份 `roles/*/memory.md` 同时包含稳定职责、详细工具纠错、旧 OMP 措辞及错误后台路由政策；需要分层，不可直接复制成新的全量 system prompt。Worker 候选／发布／用户采用门和 frontdesk 原工作树直接保存必须保留区别。
- `managed/memory-version.mjs`：`MemoryVersion.snapshot()` 读取 `index.md` 及其直接链接的 `topics/<name>.md`，校验普通文件、stat 身份及内容摘要；它不是任意目录知识扫描，也不提供用户批准或不可变历史归档。
- `managed/context-reader.mjs`：ContextReader 是每宿主 turn 的临时 readRef；文本分页约 10,000 JS 字符，记录版本和区间。`memoryContext` 是本地词项匹配，返回最多四个匹配、历史入口等；当前 preview、recent、allReadRef 不等于用户批准知识，也不证明全文已读。不得将字符上限冒称字节／token 预算。
- `apps/desktop/src/agents/runtime.mjs` 是旧两角色档案只读器，不是本方案执行入口；不复活旧 runtime。
- Pi 固定依据：`integrations/pi/upstream-manifest.json` 所记录版本及本地 `@earendil-works/pi-coding-agent@1.4.0` 的 `docs/skills.md`、`dist/core/skills.js`、`resource-loader.{js,d.ts}`。适配层当前通过 `integrations/pi/src/bridge.mjs` 的 resourceLoaderOptions 加 system extension；不能据 SDK 支持资源加载推断 Nozeli 已隔离并接入原生技能目录。

## 3. 四种来源，四种生命周期

| 类别 | 权威与写入者 | 默认启动内容 | 变更与用途 |
| --- | --- | --- | --- |
| 不可变角色契约 | 发布包／宿主维护者；每一版本不可变 | 当前角色短职责、强制边界、真实工具合同 | 新版本可替换后续绑定；旧版本留审计，不由项目知识覆盖 |
| 用户批准的项目知识 | 用户明确批准某个范围、正文和版本 | **零正文，零自动项目知识目录** | 任务相关时显式查询；来源仍是数据，不升级 system authority |
| Work 证据 | 宿主冻结的原请求、批准扩展、材料、候选、报告及效果回执 | 仅当前 Work 必需控制身份／范围版本／未决效果投影 | 首次交接提供必要原文；其余按版本查询；报告完成不自动晋升知识 |
| 瞬态会话信息 | Pi 原生消息、压缩、当前用户输入；宿主短期读引用 | Pi 自己恢复；Nozeli 不再补发 | readRef 随 turn 失效；可重签来源引用，不能伪造会话持久知识 |

知识版本批准不等于批准执行命令；接受 Worker 结果不等于批准项目知识；批准知识也不扩大 Work 原任务范围。用户当前约束优先适用于当前任务，历史约束不能自动带到无关新任务。命令、路径、角色或技能标签本身不新设权限；保持现有当前用户工具策略，高风险效果仍走宿主授权与实际 OS 身份校验。

## 4. 每个角色的最小启动与具体工作方式

共同启动只有：角色契约版本、实际授予的工具定义、可用技能短目录（名称、用途、版本、适用事件）。目录是发布包静态元数据，不是项目记忆内容；不扫描全项目任务表。frontdesk 普通闲聊的**可变自动投影为零**。其他角色只有当前绑定必要控制事实，按 context 合同一个有界槽位；不会另建一份 Worker system 锚点和持久 user 锚点。

### Frontdesk

职责：直接解答、查阅、编辑并保存用户当前原工作树；真正需要后台持续执行时交接具体剩余动作及真实已完成／未知效果。直接保存不要求 Worker 报告或采用仪式。

最小契约：原文一次、材料为数据；CAS／草稿保护；不虚构成功；交接不扩大范围；技术诊断不自动派后台模型。详细替换错误教程留在 read-material 技能，不在每轮重复。

目录来自实际文件：`read-material.md`（证据、文档读取／编辑和版本）、`handoff.md`（后台继续、取消与高风险效果边界）。按任务读取而不是默认拼全文。例：“把这一段改短”→读目标版本→CAS 保存→报告真实结果；不读历史报告或项目记忆。“后台继续核对剩余章节”→handoff→只交接未完成章节与已保存回执；不抄前台聊天历史。

### Orchestrator

职责：分类、路由、排程、查真实绑定和缺失路由事实；不是内容作者、知识策展人或自动诊断 Agent。不发明任务、测试或验收要求；保留当前政策允许的小型直接操作，而不是新增角色权限禁令。

最小契约：宿主 owns ID／队列／配额／revision；绑定讨论 continue，明确独立目标 dispatch，状态查询 status；路由不是范围批准，结束／采用／放弃只能由用户控制。宿主先验证事件绑定，再选适用规则；事件正文仍是一次源数据，不能把整份 event skill 拼到 user 原文。

实际目录：`handoff.md`（无绑定 intake）、`followup.md`（显式绑定 Work）、`clarification.md`（确有业务缺信息的绑定澄清）、`project-maintenance.md`（用户明确诊断与已声明确定性恢复能力）。现有 maintenance 文件“always injected／自动排队诊断”的文字必须随 context 政策更新，不可原样当长期契约。

例：用户明确在 Work A 补充一条要求→绑定规则→continue 同一 A；新目标超范围由 Worker／宿主 deviation 流处理，不由主控替用户批准。“连接失败”UI 通知→本地诊断记录，**不触发** clarification 或 maintenance 技能模型回合。用户明确要求分析某失败→一次受范围限制的诊断输入，查原回执，不重放未知效果。

### Worker

职责：专属 worktree 内内容工作、与用户同 Work 讨论、冻结证据并发布结果；候选不冒充原项目已采用。仅用户采用／放弃，宿主整合／关闭；无文件分析同样需真实最终发布。

最小契约包括不可选关闭的任务范围比较、deviation 停止、发布义务与候选身份、效果不重放、CAS 和宿主门。`report.md`／`task-boundary.md` 的详细程序可渐进读取，**强制义务不依赖模型是否读取技能**。宿主只能程序化验证可证明的绑定、审批、文件和状态，不声称完全自动理解任意自然语言范围；语义偏离仍须模型报告和用户决策。

实际目录：`material.md`（冻结材料与当前源区别）、`question.md`（业务缺事实／保留进度）、`report.md`（静态 HTML、真实来源、发布停止）、`task-boundary.md`（原任务＋明确批准扩展）。当前 Worker 已有 `nozeli_skill_read({name:"material.md"})`；未来原生技能迁移之前仍沿该真实工具，不给 frontdesk 虚构同名能力。

例：核对长文→按冻结版本分页→记录区间并集→发布引用与未读限制；不能最后一页 complete 就声称通读。“顺便加一个独立产品”→报告 deviation 并停止→用户明确批准后更新范围版本；不因加载一个技能变成获准执行。

## 5. 技能形式：原生 Pi 渐进披露，而不是第二加载器

拟议迁移采用 Pi 的目录式 `SKILL.md`（name、description、相对引用资源），将上节十个实际文件逐一转为角色命名空间，例如 `nozeli-frontdesk-read-material`、`nozeli-orchestrator-followup`、`nozeli-worker-report`。这些是**拟议名称，不是当前已存在的技能**；迁移是一次清晰替换，不保留同一正文同时经 rolePrompt、eventSkill、native skill 三路加载。

兼容性已从固定版本源码／文档确认的部分：

1. Pi 目录只展示名称／description／path；匹配任务后模型读完整文件。`formatSkillsForPrompt` 过滤 `disableModelInvocation`。
2. `disable-model-invocation: true` 只隐藏自动模型目录，不是安全撤销；显式 `/skill:name` 仍可使用。`enableSkillCommands` 控制交互发现，不保证禁止手工命令。`allowed-tools` 是实验元数据，不是 Nozeli 能力授予。
3. `/skill:name` 将指令及参数展开为输入，不适合偷偷替代用户普通消息。Nozeli UI 如提供“使用技能”须展示独立明确操作和实际交付；普通 user 文本保持逐字原样，不把事件处理伪装成用户发出的 skill command。
4. `DefaultResourceLoader` 有 noSkills、additionalSkillPaths、skillsOverride、noContextFiles、agentsFilesOverride 和 reload；**noSkills 不等于绝对不加载**：显式 additional／CLI 路径仍可进入，extensions 也可 extendResources。只设置 noSkills 不是可证明的来源 allowlist。
5. 原生默认搜索 user/project／祖先 `.agents/skills` 及包资源；名称冲突首个获胜并警告。Nozeli 必须对明确授权的角色包做精确资源选择、碰撞拒绝和来源登记，不继承任意个人目录。角色命名空间不能替代来源验证。
6. 当前 `bridge.reload` 拒绝 promptInFlight 并走 driver.reloadSession；SDK reload 可重新解析设置、包、扩展，不只是换技能文本。应用层必须将“技能刷新”限定为已批准本地资源集，不触发安装、网络导入、模型调用或非技能配置变更。

尚需以后实施验证：managed bridge 的最终 catalog／原生 read 可达性／scope 过滤、禁用后显式命令拒绝、extension 资源再过滤、固定版本的 reload 生命周期和同名诊断。未通过前沿现有 readRoleSkill 合同，不能宣布原生迁移完成。

禁用分两类：隐藏自动建议（可选用户偏好）与撤销授予（宿主 catalog、读取／命令入口均拒绝未来加载）。两者 UI 必须分开。已入 Pi 历史的技能文本不会因禁用被偷偷删除；宿主即时工具准入使用最新撤销事实。技能不能实现对当前用户文件权限的沙箱；本方案限制自动资源交付，不谎称禁止用户工具读取已可访问文件。

绑定与 reload：保留当前 resident 同线程、Worker 新默认／旧 Work 固定绑定的语义。显示生效范围；用户主动迁移现有 Work 时，在空闲边界记录旧／新契约与技能版本，下一 run 使用新资源集。prompt 进行时不能热换文本；紧急撤销先在宿主工具门生效，停止后续自动动作，再于安全边界刷新。resume 保留原生历史，按当前有效授权重建目录，不回灌历史技能正文。

## 6. 用户批准项目知识的生命周期

复用项目文件／对象版本、现有来源冻结与 CAS，不建立另一套知识数据库。提议在既有项目元数据中记录最小来源描述：project、source identity、冻结版本／digest、批准正文区间、适用范围、批准者／明确动作证据、状态、替代关系和冲突引用。这里是逻辑合同，**不是声称现有 MemoryVersion 已有这些字段或 UI**。

生命周期：未批准来源 → 用户明确选择和预览 → 冻结候选 → 用户批准具体版本 → 可查询；新修改产生新候选，不自动继承批准。候选可驳回；已批准版本可明确 supersede／revoke／archive。创建候选也不自动启动模型整理；用户要求整理才由 frontdesk 或既有 Worker 做内容任务，结果仍需独立知识批准。

- 来源引用稳定到项目＋对象／文件版本＋digest＋区间；readRef 只是本回合读取票据。过期重新以版本来源签发，绝不悄悄改读当前磁盘。
- 批准知识仅表示用户希望按该版本检索，不保证内容永真。冻结字节不可得时返回 unavailable，不能用 MemoryVersion 当前文件摘要伪称旧版本归档。
- CAS：用户预览 V1 后文件变成 V2，批准必须失败并重新展示；不是“批准最新”。多来源快照需验证来源集合和各版本，不能仅相信 index 的修改时间。
- 冲突：新旧说法／不同来源显式关联；既不以最新时间、角色地位、搜索排名也不以“已批准”自动裁定事实真伪。读者同时得到相关冲突版本和适用范围；确需决定时让用户在具体任务中选择或保留不确定。
- 撤销：立即停止新自动推荐／读取授予，旧回执留审计。历史 Pi 消息已见正文不能“撤回模型记忆”；UI 如实说明，提供用户显式新会话／原生压缩选择，不保证遗忘。删除本地副本按现有数据保留政策，不能顺带删 Work 证据。
- 源删除／改名不等于删除冻结来源；冻结版本存在则显示原来源已变更，缺失则如实阻断需要该证据的结论。跨项目复用必须明确选择版本与范围，不能由于磁盘可读自动带入。

历史 Plan Tree 和 Work 汇总默认标为历史证据，不自动批准整个根索引或 topics。迁移不得重写历史为“用户已认可”。普通文件编辑保存也不自动进入批准知识集合。

## 7. 检索、交付与预算接口

采用现有显式查询路线：controller 的 `nozeli_inspect_work` 记忆查询分支／当前只读来源工具定位版本，ContextReader 分页；后续 context cutover 可收敛入口，但不能借 `nozeli_handoff(reason="@read …")` 启动后台模型。返回仅任务匹配的有界元数据，用户／模型选择正文区间；不预装 recent、全部索引或全项目任务表。检索可继续使用现有本地词项算法，不需要模型 embedding 或新引擎。零命中不等于项目没有历史。

宿主到 Pi 逻辑合同：固定角色契约＋工具声明属于可信规则；技能 catalog 独立计量；项目知识／材料／Work 来源是有标签数据；当前 Work 控制是单个 ephemeral context 投影。读取返回 source/version/range/total/continuation/完整性和冲突状态；工具返回之后仍由 Pi 维护原生 tool result，不手动裁剪配对。生产者新增任何资源／事件字段必须同时更新 native 消费入口、准入校验和详情证据；未知类型拒绝，不静默丢弃。

沿 context 设计的 allow/deny：普通 user 原文一次，明确选择的材料一次事务，原任务首次交接；已有 Pi 同线程历史、UI 错误、未发送批注、其他角色讨论和长期知识不自动加入。事件技能的可信规则只能固定配置或已核验事件规则通道，不能以长 user 前缀交付；同事件不得同时走 native `/skill` 展开和宿主拼接。

预算以 context 设计为唯一合同：4 KiB 请求投影、64 KiB run、256 KiB 原生压缩代次是待校准建议，不是本文新增容量保证。知识正文／技能按需正文如由宿主交付，应进入共享持久内容账；固定契约和目录独立计量，不能通过技能包装绕开累计额度。原生 read／skill command 路线若不能观察并限制宿主来源字节，就不能宣称已实现同一共享额度；迁移验收必须覆盖该消费路径。附图独立限额；字节不是 token。

优先省略可选推荐／知识片段，保留来源状态、撤销、范围和未知效果。必要控制无法完整容纳则阻断整个模型请求；显式材料超额可见分页／暂停，不静默摘要。分页完整性由已读区间并集确定；readRef complete=false 只是本页状态。新 job 名或换技能不能刷新 run／代次额度；Pi 压缩失败不靠重新调用模型骗取额度。

详情 UI（本地、零模型调用）显示：固定契约／技能目录版本、按需加载正文来源、知识批准／冲突／撤销状态、准备内容与 native hook 观测的区别、未交付区间与省略原因。仅在有原生 entry 证据时标记已记录，回答成功不等于交付或当前可见；compaction 后旧 receipt 不能证明正文仍在上下文。默认日志不复制正文、私人路径或密钥。

## 8. 强制边界不能依赖技能

宿主每个相关工具调用重新验证项目／Work／owner／revision、暂停／撤销／deviation gate、审批作用域、CAS、候选发布及效果去重。报告技能被禁用、模型未读 task-boundary、旧压缩摘要含错误批准，都不能绕过这些门。知识材料里的“忽略限制”只是数据。宿主不得把未知已启动效果当未执行并重试；确定性程序恢复与用户请求诊断区别于自动 maintenance 模型调用。

可由程序保证的事实与只能辅助的语义清楚分开：宿主能拒绝旧 revision、未授权高风险效果、错误文件基线及 held Work；不能仅凭短任务摘要宣称自动识别所有越界内容。保留 Worker 语义偏离报告和明确用户决策，不新造“知识批准即执行许可”捷径。

## 9. 迁移顺序与责任边界

1. **当前 context cutover 范围**：host/controller owner 删除 event skill 的 user 拼接、历史补发、重复 Worker 锚点和错误诊断扇出；runtime/Pi owner 实现单槽投影及 native 证据；UI owner 展示真实来源。本文不直接编辑这些文件。角色长文里与切换相冲突的自动维修／无限读取描述须由集成方同步更新，不能让旧 prompt 抵消新合同。
2. **单独批准后的角色瘦身**：将 memory.md 明确标为版本化角色契约；抽出重复详细教程到上述现有技能；保留强制职责和工具门。所有角色先有可读取的目录入口，再停止正文预装；不能只删技能却让 frontdesk/orchestrator 没有消费者。
3. **单独批准后的原生技能迁移**：固定 SDK 能力验证、精确 resource allowlist、隔离角色资源、命名碰撞／撤销／reload 验证；一次切换所有生产者和消费者，删除旧 role skill 正文注入／重复 loader，不保留双轨默认。
4. **单独批准后的知识控制**：在现有来源／版本／CAS 上提供预览、明确批准、冲突、替代、撤销、可见分页检索；旧资料先保持未批准历史身份，用户逐项选择，绝不批量隐式导入。
5. **用户迁移控制**：显示旧 Work 固定绑定与新默认差异，用户决定是否迁移旧 Work；旧 native journal、报告、材料、未发送草稿不改写。无私人源导入、模型设置改写或真实个人会话测试。

本设计不要求在本轮实现步骤 2–4。父集成代理负责本轮最终 context 验证；本文作者只做文档／源码审阅，不运行 build、tests、formatter 或模型请求。

## 10. 设计验收与后续实施门

下表是可执行验收要求，**未在本文工作中运行**；context 原设计第 13 节全部继续成立，不能用本表替代／缩减。

| 场景 | 必须满足 |
| --- | --- |
| 三角色冷启动／普通闲聊 | 角色不变；固定契约和短技能目录可量化；零项目知识正文、零前台可变投影；原用户文本逐字一次 |
| 实际十份技能逐一调用 | catalog 与真实包／版本一致；角色授予过滤；无虚构工具；正文按需且无 event/user 双份 |
| Worker 禁用可选技能 | 发布／范围／撤销等宿主门不失效；不因缺技能伪装任务成功 |
| hide 与 revoke | 隐藏仅影响建议；撤销后命令／读取均不能新加载，历史不伪删；用户明确知道两者差别 |
| scope 与 reload | 用户／祖先／其他角色包不自动导入；collision 可见拒绝；busy 不热换；空闲刷新无安装／网络／模型副作用 |
| 现有 Work 与新默认 | 老绑定不悄悄更新；显式迁移记录版本；撤销即时门控，resume 不复活旧授权 |
| 知识批准 V1，磁盘变 V2 | CAS 拒绝旧预览批准；读冻结 V1 或明确不可得，不回退 V2 |
| Work 报告／Plan Tree | 接受结果不自动批准知识；历史不变新规则；无自动总结／学习／私人导入 |
| 知识冲突、撤销、删除 | 双方来源与范围可查；不自动选赢家；新检索按有效状态；历史暴露不可逆如实说明 |
| 长知识、多技能、多页材料 | 共享预算覆盖所有宿主正文路线；范围并集证明通读；必要控制超额整请求阻断；不改 Pi tool 配对 |
| 查看目录／来源／详情 | 零新增模型调用；准备、native 观测、entry 与 provider 证据不混称 |
| 合成 prompt injection／过期批准 | 知识／技能元数据不扩权；每次效果准入核验实际绑定；无已完成／未知效果重放 |

设计接受条件：同意四层来源、三个最小契约、实际技能目录、用户明确知识批准和原生兼容性门；保持实现授权分离。未完成的实现验证不是设计宣称成功的依据。冻结后的 combined context patch 需独立检查生产者／消费者、budget 和 journal 证据后才可给运行正确性结论。

独立 reviewer 已核对现有角色／十份技能目录、固定 Pi resource／skills 源码和上下文合同，设计 verdict 为通过：无阻断接受提案的源码矛盾或职责边界问题。重点保留最终资源过滤、真实撤销入口、原生 skill 正文共享预算与受控刷新作为未来迁移门；此结论不覆盖正在实施的 context cutover combined patch，不代表记忆或 skill 系统已经上线。
