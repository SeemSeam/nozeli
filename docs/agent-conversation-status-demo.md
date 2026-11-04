# 对话区 Agent 状态与模型：交互 Demo 与实施方案

Date: 2026-11-01
Status: 独立离线交互Demo与设计已落盘并通过实际浏览器测试，待用户审阅；生产接入状态另见§10–11。任务／自动修复协同设计及9场景伴随页见[协同合同](agent-task-repair-lifecycle-design.md)，不代表新生产维修策略已实施。

## 1. 目标与边界

先确定读者在对话区需要看到什么，再映射当前 Nozeli／Pi GUI／Pi 的事实与已有接口；只有确认缺失的底层事实才补接口。保留统一工作面，不先扩建调度框架或新增后台模型轮询。

Demo：`apps/desktop/demos/agent-status/index.html`，同目录 `style.css`、`app.mjs`。可直接用浏览器打开 HTML；也可在仓库根运行 `python3 -m http.server 48763 --bind 127.0.0.1 --directory apps/desktop/demos/agent-status`，访问 `http://127.0.0.1:48763/`。Python只作开发预览服务，不是产品用户前置依赖。

任务／休眠／修复伴随页：同目录`task-repair.html`，首页已有入口。用户已授权主助手独立接管，取消未执行的Frontdesk排队任务。原Demo推进改为按场景、确切target独立回执，未决决定和成果审阅不被普通讨论或统一推进自动解除。两页实际操作及窄屏证据见[协同合同§6](agent-task-repair-lifecycle-design.md#6-验证边界与交接状态)。

此 Demo 不导入生产 preload／运行时，不请求模型，不读取论文、凭据或真实项目，不保存生产设置；模型名称、回复、项目和状态全部为合成示例。刷新页面重置本地演示。底部“场景”“推进演示一步”“展示12个Agent”是设计验收控制，不属于正式用户界面。

## 2. 对话区布局

### 顶部：项目协作条

- 项目层只显示“项目协作保持 / 等待处理 / 项目待命”，附进行中 Agent 数和待处理项数。这里“项目协作保持”表达项目仍可推进，不承诺所有角色进程都在线。
- 前台、主控与两个相关 Worker 用紧凑摘要展示：角色＋稳定标识、工作短标题、一个主要状态、模型按钮。不复制工具日志或报告正文。
- 超过四个 Agent 收入“全部 Agent”列表。每个 Worker 用自己的 Work 身份，不把不同 Worker 都折叠成一个“Worker”。正式接入后应优先显示当前交互／需处理／活跃 Worker，并使列表顺序稳定；具体排序待确认，不暗改执行优先级。
- 点击 Agent 仅定位讨论与明确发送目标，不启动进程、不发送消息。查看列表或技术详情同样不唤醒。

### 中部：连续对话

- 历史消息头显示发言者、Worker工作标题、发送时模型、时间。历史模型不可被当前设置或后续状态刷新覆盖；缺少历史模型证据时显示“未记录”，不得拿当前模型倒填。
- Agent当前活动使用短过程行，不持续制造系统气泡。需要用户动作的事实才展开对话卡：确认假设、处理连接、打开审核报告。
- 报告提供“打开审核报告 / 继续讨论”。查看不等于接受，不在这个Demo伪造合入、修改文件或审核通过。
- 未决问题允许“暂不决定”，保留工作与问题；不得以自动换Agent绕过授权或用户决定。

### 底部：一个输入区

- 显示明确目标和该Agent模型入口，继续讨论与提出修改共用输入区，不要求问答／任务模式切换。
- 运行中发送的新输入表达“排在当前回合之后”，不模拟打断。Demo发送只把用户文本安全显示为本地演示消息，不伪装真实入队。
- 模型选择、详情、Agent选择、主题和场景变化保留未发送草稿。切Agent不自动派发已有文字；正式目标变更是否共享或隔离草稿沿现有项目草稿合同实现，不在此另建第二套草稿策略。

## 3. 哪些状态对读者可见

| 用户可见状态 | 含义 | 主要动作／边界 |
| --- | --- | --- |
| 待命 | 当前没有业务回合，不代表已休眠 | 可明确发送；不展示“免费Agent” |
| 准备中 | 已有启动／准入过程，尚未开始普通输出 | 不暗示已执行工具 |
| 执行中（样例为“核对中”） | 当前任务正在推进 | 可附有事实依据的短活动描述，不让模型自填运行状态 |
| 使用工具 | 有原生／宿主工具执行事实 | 展开过程查看；不把消息结束当工具结束 |
| 等待运行名额 | 输入已接受，尚未取得执行容量 | 明示无需重复提交；不能伪装运行中 |
| 需要你决定 | 用户输入／权限／业务假设决定阻断 | 原对话内明确选项，动作绑定确切请求 |
| 结果待审阅 | 当前Work成果已准备 | 打开冻结报告，继续讨论；不自动接受／结束 |
| 整理上下文 | Pi压缩等受保护活动 | 保留当前工作与草稿，不启动第二owner |
| 连接重试中 | 原生已有重试事实 | 不由Nozeli再次重发prompt；可以显示有限重试说明 |
| 保存结果中 | 原生结束但宿主仍在落账／发布 | 不能提前显示完成、释放owner或消费草稿 |
| 已暂停 | 明确停止或业务阻塞，工作保留 | 显式续作与原版本准入，不偷偷重跑 |
| 休眠 · 按需恢复 | 无运行owner，保留工作／原线程 | 显式输入或已接受事件可申请恢复；浏览和选模型不唤醒 |
| 连接失败 | 已确认不可用 | 保留输入，提供连接／模型入口，不自动重发 |
| 状态待核实 | 原生／owner／宿主证据不足或冲突 | 不按idle、completed或安全重投处理 |

状态不是单一互斥业务枚举。显示时先保留具体阻塞和用户动作，再区分当前受保护活动与稳定Work状态；其余活动可在详情列出。例如待审阅Work可以同时是sleeping，卡片主状态“结果待审阅”，详情说明“会话按需恢复”。不得因为owner已退出把Work标为完成。

失败文案按来源区分：连接／模型失败、执行失败、结果保存受阻、状态未知；不能把所有错误统一叫“连接失败”。Demo“失败与未知”主要演示两者不可混淆，完整错误分类沿现有诊断合同接入。

项目层遇到未核实状态时继续保留协作与核查机会，不能因缺少busy事件误降为空闲休眠；Demo以“项目协作保持”加待处理项及警示色表达，不把owner术语搬进对话。

## 4. 不在主对话常驻展示的内部状态

ownerId／generation、PID与进程树、spawn reservation、exit confirmation、reclaiming、写者lease／heartbeat、session epoch、IPC seq、flush／nativeDrain、CAS、存储UNKNOWN、游标、digest等，不作为普通用户的Agent标签。

- 技术详情可只读查看必要事实，不拿内部JSON占满对话。
- 内部问题确实阻断用户操作时，转成“状态待核实”“结果保存受阻”等可理解提示，并提供核查入口；隐藏术语不等于隐藏故障。
- 正常owner回收不插系统消息，不把每次进程启动／停止写成对话噪声。
- 进程已退出、原生回合已settled、宿主事务已提交、Work已结束是四类不同事实。

## 5. 模型按钮的行为合同

作用域默认**当前Agent后续回合**，不同时修改项目默认或其他Agent。Worker绑定和原线程能力必须由宿主再确认；不可通过模型按钮创建新Worker来回避兼容问题。

| 当时情况 | 确认后的展示 | 生效规则 |
| --- | --- | --- |
| 空闲会话 | 发起切换，收到回执后更新当前模型 | 正式版必须等待实际effective确认；Demo即时模拟确认 |
| 正在执行／工具／压缩／重试／交互 | 当前模型保持，显示待切换 | 当前回合不受影响；保存期望，安全边界确认后更新effective |
| 休眠 | 显示“上次使用”与“下次启动使用” | 只保存期望，不启动进程，不把保存冒称实际生效 |
| 已知连接失败 | 保存期望模型，当前/历史模型不变 | 明确重新连接并收到确认后更新effective；不重发原输入或发送草稿 |
| 状态待核实 | 模型列表只读，禁止覆盖原会话 | 先核实owner／原请求；没有可靠事实不推断idle |
| 配置保存失败 | 当前与原待切换值不变，明确显示失败 | 允许显式重试，不静默换来源或新建线程 |
| 模型不可用 | 保留原选择／历史提示，条目禁用 | 来源名称＋模型ID区分，不把目录条目等同推理授权 |

选择器包含搜索、当前／已保存标识、取消、撤销未生效切换和Demo专用“模拟配置保存失败”。重选当前值不重复提交。取消／Escape不写入。运行中多次选择以最新明确选择为准，旧回执不能覆盖新期望；正式版需绑定projectId／target／owner generation／配置revision／operationId，并复用既有模型配置串行入口。

当前Demo只展示模型，不先加入thinking档位、源管理和认证表单，避免在对话区复制设置页。后续可从原生可用能力补充，不能按模型名字猜档位。

## 6. Demo验收场景

1. 并行工作：前台／主控待命，两个Worker分别使用工具与核对中；项目协作保持。
2. 等待运行名额：一个Worker执行，另一个排队；主控可休眠，项目仍保持。
3. 需要决定：在原对话确认研究假设或暂不决定，不发明授权。
4. 结果待审阅：报告入口与继续讨论，不在Demo伪造接受／合入。
5. 压缩与原生重试：受保护活动可见，与普通idle分开。
6. 准备与结果保存：启动准备和原生结束后的宿主保存分开；推进后仍不伪装整个Work完成。
7. 失败与未知：已知失败可先保存期望模型、明确重新连接；未知Agent只读，不允许直接覆盖配置或发送。
8. 项目待命：无执行任务，Worker休眠；普通推进不批量唤醒休眠Agent。
9. 运行中切模型、边界生效、撤销、保存失败、取消、不可用模型；历史消息与草稿保持。
10. 十二个Agent列表、390px窄屏、深浅主题、键盘焦点及无水平溢出。

## 7. 从Demo反推接口，不预先扩建底层

建议逻辑DTO（字段是设计合同，不代表已有同名生产API）：

- identity：projectId、role、target/workId、workRevision；owner／generation只用于后台校验。
- visible：displayName、workLabel、primaryState、activityText、blockReason、availableActions。
- model：recorded/lastEffective、effective、desired、syncState、configurationRevision；历史消息modelAtSend独立。
- lifecycle：projectKeepsRunning、protectedActivity、pendingAcceptedJobs、pendingDependencyEvents；不由UI根据一个busy推算。
- evidence：snapshotRevision、ownerGeneration、observedAt、sourceSequence、freshness。断线／缺失／代际变化明确unknown，不倒退覆盖新快照。

| Demo需要 | 当前材料／入口 | 下一步优先动作 |
| --- | --- | --- |
| 身份／工作／排队／审阅／暂停 | Nozeli Work、job、receipt、target及现有snapshot／disposition | 复用现有投影，不从Pi重复建立业务状态机 |
| 推理／工具／压缩／原生重试 | Pi原生事件、pi-gui订阅、`facts.mjs`转发 | 盘点事件接收、去重和role归属，归纳状态；仅确认缺失的事实才扩桥 |
| 原生交互与关闭 | 当前interaction及respond合同 | 复用确切请求身份，和原生业务问题／权限分层 |
| 正在保存／不可休眠 | Controller current/running、工具集合、nativeDrain／存储回执、owner退出证明 | 宿主组合；不能只看agent_end或Pi status=idle |
| 模型显示／切换 | snapshot里的model/effective/desiredModel/pendingModel/modelError，现有设置／默认模型串行应用逻辑 | 核实逐target/Worker的真实可切换能力和作用域；复用现有写入入口，缺target级合同再补 |
| 历史模型 | 原生历史／发送时模型事实 | 查证每条消息可否可靠归属；缺失标为未记录，禁止倒填 |
| 状态重新核对 | Pi GUI snapshot与Nozeli runtime status目前粒度不同 | 先补轻量可查询快照的现有事实汇总与seq／generation核对；不读取完整历史来判断busy |
| 项目整体保持／依赖唤醒 | 当前Controller、process budget、job队列、kick与owner gates | 用户先审阅Demo与项目保持语义；再review项目级聚合准入，不能因显示协作条提前启动所有Agent |

实施顺序：**用户审阅Demo → 核定可见状态及模型作用域 → 逐字段查当前接口 → 在Nozeli归纳已有事实 → 真正缺失的Pi/桥接事实再补 → 真实Pi逐场景验收**。生产接线前不得把示例状态、固定模型目录或本地“发送”当作已实现能力。

本轮不改生产状态、Pi SDK、模型设置和资源调度，不安装、不提交、不推送。独立设计结果不构成调度策略或冷恢复自动重放授权。

## 8. 本轮实际验证

真实Chromium已打开Demo并操作八类场景；实测运行中切换保持当前模型、模拟安全边界确认后生效、历史模型不回写、休眠只保存期望不唤醒、保存失败保留旧值、明确重试／撤销、未知只读、研究假设决定、连接恢复不重发、不清未发送草稿、十二Agent列表、Escape取消及技术详情。390px窄屏实测scrollWidth=390，无横向溢出；深浅主题与模型选择器截图已查看，浏览器记录的页面异常为空。直接file://打开HTML也实际渲染四个Agent，无页面异常。

截图原件：`/var/tmp/nozeli-agent-status-demo-01Ym2a/{desktop,model-pending,narrow-dark}.png`。该证据仅是离线UI／交互验证，不是Pi状态映射、真实模型切换、队列公平或跨平台桌面验收；本轮未跑无关生产测试套件。

## 9. Demo所需底层调用与缺口核对（2026-11-01，分析完成，未实施）

### 9.1 结论与真实观察

不用重写Pi状态系统，也不能直接把生产`managed.status`接到Demo后宣称完成。当前身份／Work／交互／在线模型切换已有入口；主要缺口是Nozeli轻量纯读投影、原生活动聚合和序号核对、持久逐target模型意图与撤销、历史模型透传。项目整体保持的业务准入与UI展示分开实施。

实际运行真实Pi owner＋回环合成Provider，报告`/var/tmp/nozeli-pi-real-wTDuV3/demo-state-gap.json`：执行中model change返回pending、当前模型不变，结束后切到第二模型；恢复原线程保留生效模型且总请求仍1，无自动重放。原生assistant message真实带`provider=local-fixture, model=scripted`。原生status返回busy/model/effective/seq等13个字段，但没有完整工具／交互／压缩／重试活动快照；送达Nozeli的native callback和entry callback都未携带seq。owner metadata只保存线程／文件／工具摘要，不保存pendingModel。上述是一个固定版本真实运行场景，不能外推其他版本或未运行边界。

### 9.2 调用链与按状态映射

当前链：Pi原生事件 → vendored pi-gui `onNativeSessionEvent` → `integrations/pi/src/facts.mjs` → owner JSONL → `PiSession.receive()` → Controller → `managed-state / managed-timeline` → renderer。业务身份和准入以Nozeli账本为权威，不让Pi创建第二套Work/queued状态。

| Demo事实 | 已有权威材料／入口 | 缺口与最小动作 | 是否需新增Pi底层事实 |
| --- | --- | --- | --- |
| 前台／主控／Worker身份、工作短标题 | Controller snapshot.target、works.id/name/revision，residents；`managed.status` | sleeping resident和never-started Worker不能仅从sessions枚举；按业务target补齐完整有界列表，区分未启动/休眠/未知 | 否 |
| 待命／准备 | starting/restarting、Pi phase、Controller current/running | 统一priority和reason，准备失败不可静默降idle | 否 |
| 执行／使用工具 | Pi agent_start、message事件、tool_execution_*；Host工具inFlightToolCalls | 当前native事件多数只进timeline，SessionIndex.event仅消费消息流/agent_end，不存工具/重试活动投影；Host工具集合不能覆盖Pi原生bash/read等工具。需按callId归纳有界活动集合 | 事件已有，先补Host消费 |
| 原生重试／压缩 | facts转发auto_retry_*、compactionStarted/Ended、runSettled；Pi busy | 区分agent_end.willRetry与最终agent_settled；重试不能创建新host job。压缩已有context预算失效逻辑，不把显示状态与预算代次处理混为一件事 | 事件已有；核对快照字段 |
| 等待名额 | pump容量门、processBudget、queued job；部分job.resourceBlocked | queued不总等于容量不足，还可能是同target占用、草稿、pendingIntake、coldJobs、deviation等。必须由准入判定返回准确reason，不由renderer猜 | 否 |
| 需要决定 | agents.interactions、attention、effect permission、problem/deviation记录 | 区分等用户、后台可核对和模型/配置阻断；复用现有owner/request/version绑定作答，不能所有interaction都标用户问题 | 否 |
| 结果待审阅／暂停／结束 | Work.status、receipt、disposition及review API | primaryState与execution/owner状态正交；ended仍可能closure未完成，review可同时sleeping | 否 |
| 保存结果中 | Pi flush/nativeDrain、Controller runJob及持久化/发布事务 | busy包含这些但不能具体归因；添加宿主执行阶段/待提交回执投影，出错转保存受阻或unknown，不提前完成 | 否，Host权威 |
| 连接失败／状态未知 | connectionErrors、modelError、storageBlocked、transport unknown、unconfirmed slot | 按target/请求限定范围；项目级失败不能把所有Worker误标失败。未知事实不能由一段时间无输出推断idle | 否；快照核对需扩桥 |
| sleeping／项目保持 | 无session、Work thread、processBudget与project/Controller门 | 无slot不代表安全sleep：未启动、退出未核实、残留注册要分开。新增project聚合，保留queued/protected/settlement/unknown核查机会；不改变现有no-replay | 否 |

源码锚点：`controller.mjs:114-159,398-405,1246-1284,1453-1459,1539-1572,3122-3133`；`managed-projects.mjs:119-170,216-257,358-370,432-454`；`pi-session.mjs:65-124,200-236,289-320`；`session-index.mjs:333-351`；`facts.mjs:88-117,119-265`。

### 9.3 一个不能直接复用的读入口

`managed.status → attentionState(connected=true) → controller.processBackstage()`不仅返回状态，还可能持久化backstage事件、创建orchestrator job并kick；`attention.observe`也持久化待办。未连接时status的projectionSource还会读完整managed业务状态／历史页。因此Demo“展开全部Agent／技术详情不会唤醒、不派工、轻量读取”不能简单通过高频轮询该入口实现。

最小修补：为对话协作条提供**纯读、有界的现有事实摘要**，与注意力事件生产／派工分开。先复用Controller内存与已有本地标量读能力；无Controller时返回unloaded/recorded事实，不为查询构造完整Controller，不读全会话正文。现有status兼容消费者不在第一步暗中改行为。

### 9.4 模型显示和切换的确切缺口

已有生产调用：`managed.model.options {projectId,target}`；`managed.model.set {projectId,target,ownerId,model,effort,requestKey}`；`managed.session.options`、`managed.session.command`；模型目录来自`ProviderSettings.models()`。不是从零写模型接口。

| Demo行为 | 生产现状 | 需补齐合同 |
| --- | --- | --- |
| 在线单Agent切换 | model.set已按target/owner校验，支持Worker；PiSession与prompt共享admission queue，忙时pending | 直接复用，但加读取时owner绑定/配置revision及确切回执，检查模型目录来源/可用性；菜单可用不等于已获推理额度 |
| 下一回合待切换 | pendingModel/desiredModel已在会话对象，desiredGeneration防过期queued配置覆盖 | **接受pending不等于持久保存**。增加本机逐target期望选择的CAS/operation receipt，明确accepted/persisted/applied/failed/unknown。重启不能丢掉已告诉用户“保存”的选择 |
| requestKey重试 | model.set检查requestKey格式，但该分支未使用requestKey建立幂等结果或碰撞检查 | 复用项目本机事务／回执约定，不以重复apply替代幂等；未知结果只核对，不盲重发 |
| 休眠/失败时保存 | model.options/set都要求live session，否则PI_OWNER_UNAVAILABLE；项目角色默认有持久设置，但影响整类角色 | 新增或扩展**逐target本机意图**入口，查目录不启动该Agent；不得拿settings.models.save替代Worker单独设置。失败可保存期望，effective需连回原线程核实 |
| 撤销未生效切换 | PiSession内部clear:true会清pending/desired，但model.set只接受model/effort，未对外暴露cancel | 绑定expected intent revision取消待应用项；已提交原生改变不可伪装“撤销成功”。回当前模型也是新配置动作，不是撤销未开始项 |
| 冷恢复与默认优先级 | makeSession恢复时会应用piSource.roleDefaultsFor(role)；原生线程也保留其模型 | 确认优先级：本Agent显式覆盖 > 角色默认 > 原生默认；明确“恢复继承”。不能已保存单Worker覆盖又被角色默认静默改回 |
| 配置失败及时显示 | modelError在snapshot；applyPendingModel捕获后emit model-error；observeSession监听model-changed/change等但未单独监听model-error | 把延迟配置失败接到统一状态revision通知，避免等别的事件才刷新；禁止用原有效模型显示掩盖失败 |
| 作用域及权限 | target／owner门已有；session/model查询仍可能被runtime/config初始化门阻断 | 纯目录／记录选择读取与真实运行门分离；变更仍经过项目生命周期、Work版本、兼容性、owner和高风险准入，不泛化豁免 |

关键源码：`managed-projects.mjs:642-645,740-754`；`pi-session.mjs:47-50,242-279`；`controller.mjs:1543-1558,1711-1731`；`main.cjs:788-795`。休眠选择需要的目录查询不应被“无live owner”阻断，也不应触发每次模型联网发现；用已有已授权目录，缺失明确提示。

### 9.5 历史模型：原始事实已有，当前UI DTO没透传

原生assistant message包含provider/model，真实烟测已确认。`SessionIndex.nativeDTO()`没有把这两个字段纳入对话DTO；超预算metadata allowlist、streaming DTO、portable message和renderer session-store的裁剪也需同一字段合同，不能只修普通小消息。

推荐按assistant消息/segment显示真实生成模型，不按当前会话模型回填整轮；原生重试/切模可能使一组消息不止一个模型。用户消息没有模型事实时不伪造；历史缺字段显示未记录。新消息只增只读派生字段，不改历史原始对象或哈希；为大消息生成有界元数据时提取，不为显示模型重读/解析超大原文。旧大记录如果无安全元数据入口，先显示未记录，不扫描完整JSONL制造OOM。

### 9.6 状态顺序／新鲜度：必须先补的桥接合同

现有facts.entryFrame有seq，但native/delivery没有统一seq；PiSession生成的onNativeEntry/onNativeEvent事实未传外层seq，真实运行两个callback均未见seq。runtime.status的seq来自facts当前条目序号，不是所有活动的水位，不能用它证明压缩/工具/交互事件没漏。Nozeli本地epoch与viewOwnerId已有，应继续用，不再制造替代身份。

补齐方案：在**Nozeli bridge**对活动更新和一致快照给同一owner generation下的单调activityRevision；只添加到Nozeli信封，不修改Pi原生entry。快照返回有限工具集合/计数、prompt-start、runActive、compaction、retry、pending interaction、configuration/command、可核验状态和水位；事件与快照在同一串行边界采样。Host转发并验证，旧代际/旧revision丢弃，缺口可主动读取一次纯状态快照，无输出或心跳超时只触发核查，不能自动判空闲或补发prompt。

不将当前best-effort OwnerRuntime.status直接当轻量一致快照：它还会SessionManager.open原生文件计算entryCount/leafId，且busy只看promptInFlight，未暴露完整活动。新摘要不读历史正文，不泄漏工具参数/文件内容/凭据；snapshot不是持久化完成证明，仍须宿主回执。

### 9.7 最小接入顺序与验收门

1. **只读投影P1**：定义有界Agent/project DTO与多维状态→可见标签纯函数；接已有Work/job/interaction/owner事实，暂不改回收。无owner返回明确unloaded/sleeping/unknown，列出blockedReason，分页稳定且动作能力由Host给出。打开Demo式状态UI不能创建job或启动Pi进程。
2. **原生活动P2**：接已有工具/压缩/重试/交互事件；补桥接activity快照和revision，转发owner/epoch/version；测试旧owner迟到、漏事件、并行工具和settlement空窗，信息不足仍unknown。优先补Nozeli桥，不改Pi SDK。
3. **逐Agent模型P3**：复用live model.set，补target意图持久化、CAS/幂等、睡眠只保存、撤销竞争和默认优先级。重启后只恢复期望，不重放旧输入；applied必须有原生回执。能力不足的历史线程显示不可改，不新建线程伪装成功。
4. **历史模型P4**：将已有原生模型事实贯穿普通/streaming/portable/超预算/分页DTO；未知不倒填，历史原件不改。
5. **项目保持P5**：用户“一个Agent运行保持项目整体运行态”的要求落成宿主聚合，Controller/依赖监听和已接受事件可继续推进；不是全角色常驻进程。只在无受保护运行、无待结算/合法待处理输入、无未知owner时评估休眠，queued/coldJobs/权限/deviation不绕过。资源回收策略另经review，不能让UI标签反向授权执行。

必验：每个Demo场景真实Pi/本地Provider，busy/工具/压缩/重试/交互不误idle；原生settled但flush失败不报完成；无live owner选模型不启动；pending保存失败/崩溃/撤销与生效竞争；多Worker独立模型、角色默认更新不覆盖显式选择；旧project/owner回执不串绑；cold queued和UNKNOWN不重放；大历史状态读取保持有界。UI继续使用Demo已验证的草稿保护、历史不回写和窄屏交互。

本次仅更新分析，不实施API或调度，不提交／安装／推送。下一步可按P1/P2先接真实只读状态，再做P3模型写入合同；不能仅替换Demo数据源就称为产品完成。

## 10. 生产源码完成（2026-11-02，Linux限定验收通过，未安装／提交／推送）

本节承接上节实施授权；第1–9节“离线Demo／未实施”是设计时记录，独立Demo本身仍然离线，不冒充真实功能。当前生产接线不引入第二个任务账本、DAG、轮询模型或新的全局资源调度器。

### 已落盘模块

- `managed/collaboration-status.mjs`：把当前Controller／job／Work／owner／模型事实归纳为有界协作摘要。执行状态、Work状态、配置状态和新鲜度分开；cold jobs不计作可自动执行输入。
- `main/storage-collaboration.mjs`与ProjectStorage：只提取本机缓存的Work标量与local thread/provider事实；分页保留未完成的ended closure，项目running/waiting聚合与页无关；指定target的owner核查不会被前缀截断漏掉。查询不构造Controller、不调用backstage、不启动项目Agent或加载正文。
- `integrations/pi/src/activity.mjs`、bridge／owner／PiSession：原生活动、工具、重试、压缩、交互、准备和保存阶段的有界快照及owner-local版本；保留entry原始内容，增加信封身份／版本。`agent_end`不等于`runSettled`；原生结束但宿主flush/nativeDrain未完成仍受保护。初次准备与结束后保存已分开。
- `managed/target-model-intent.mjs`及Controller：逐target本机CAS意图、请求键回执、保存／pending／submitted／applied／failed／unknown／cancelled；保存不等于生效。Model receipt额外绑定owner，旧owner迟到不能覆盖新owner。原生clamp事实保存，不能仅凭相同model确认effort-only变更成功。
- `session-index`与renderer session-store/timeline：assistant逐消息透传`provider/model/modelStatus`；流式、portable、裁剪和新超大条目的元数据路径一致。旧大记录无可靠元数据就显示未记录，不扫描完整历史倒填，不修改历史对象哈希。
- `renderer/collaboration-status.mjs/css`与原对话面板：生产项目协作条、Agent列表、逐Agent模型选择／继承／撤销。卡片与模型选项以身份复用DOM，状态更新不替换可点击节点；列表刷新保留已加载范围，无法取得一致页时保留旧节点并明确上次快照；打开的模型菜单重新核对事实，保留未提交选择与搜索。

### 查询与写入合同

`managed.collaboration.status {projectId, cursor?, limit?}`：每页最多50个Work及两个resident，输出编码预算64KiB；cursor绑定实例／来源／版本，失效明确报错。只读入口与`managed.status → attentionState → backstage`分离；不把旧消费者暗改成另一种执行语义。DTO含Agent身份、Work修订、可见状态、阻塞原因、当前／上次确认／期望模型、动作能力、新鲜度与项目保持事实；owner/generation只作校验，不在对话常驻展示。

`managed.model.options {projectId,target}`：无live owner也可读取记录与目录，不为目录／选择唤醒该Agent；返回配置revision、原生effective、recorded、desired、override、owner身份、Work修订与available。目录仍来自已有Pi设置路径；目录与凭据已配置不证明付费推理授权。

`managed.model.set {projectId,target,expectedRevision,requestKey,action,model?,effort?,ownerId?,workRevision?}`：action为set/inherit/cancel。live变更必须携带当前owner，Worker必须匹配当前Work修订；最终提交前重新核对owner／Work／lifecycle。历史只读、context recovery、未核实owner和存储UNKNOWN不绕过。相同请求不会重复原生效果；待执行保存可按原意图继续，但原请求／prompt从不重发。

显式target选择优先于角色默认，恢复原线程时应用；inherit取消target覆盖并沿既有角色／原生默认路径处理。cancel只取消尚未提交的选择；已提交／未知不声称撤销。恢复先前尚未生效偏好仍可在下次启动应用。成功applied以原生回执为准；未知结果只核对，不因相同模型名冒称effort生效。配置回执不修剪后假装可重试：达到1024条／4MiB预算明确拒绝后续保存，原配置与幂等证据保留。

### 项目保持与资源边界

任一受保护Agent、合法已接受队列、待结算／依赖事件、未完成宿主技术操作或未知owner，都保留项目推进／核查机会。复用现有Controller常驻、kick、capacity-released和已验证owner回收门；不因切项目卸载忙项目，也不因项目活跃启动所有角色。

硬上限仍有效：所有slot都busy/unknown时，不能同时保证不抢占、不越限且立即唤醒另一个角色。此时保持队列／监听并解释阻塞，等待合法释放或用户处理；本轮不宣称依赖死锁完全消除、不暗设控制角色预留名额、不自动终止busy owner。公平调度／预留配额仍需独立产品决定。

### 验证记录

真实Pi／本地Provider的Host烟测已观察纯读不启动、休眠保存、初次及原线程恢复的target优先级、忙时切换、历史生成模型、GUI草稿保持、两个真实Worker的独立选择与角色默认不覆盖、已验证回收和冷开不重放。初步证据：`/var/tmp/nozeli-pi-real-C73A2V/{production-state-model,worker-models}.json`。

独立review提出的owner CAS、目标分页、effort核对、取消恢复前一偏好、已加载列表焦点、菜单事实刷新、记录页全局聚合／未结束closure／provider前缀遗漏已修正并补回归。reviewer仅对其发现及所述修正作确认，不冒称最终源码已经独立全量复测。以下为整合后的实际运行结果；失败尝试不计通过。

集成回归曾发现Controller选项／IPC字段白名单迁移漏项：已恢复原进程额度、接受前草稿保护、成果归属记录与项目文本读取回调，并恢复`review.instruction.save`允许字段；原安全断言未删除。修正后相关53项通过，覆盖错误PID／未知额度阻断、活跃及损坏草稿保护、指令账本真实入口和只读协作查询。

真实Electron进一步发现模型已生效但后台刷新未结束时，弹窗退出点击被忽略：退出现在只关闭界面，不撤销已提交选择，不阻塞继续输入。新增延迟回执回归核对关闭后可继续编辑，晚到结果不重开菜单、不覆盖草稿；配置撤销仍只能使用独立的“撤销待切换”动作。

最终运行证据（隔离合成项目，真实Electron／Pi owners／本地HTTP Provider；未调用付费模型、未使用个人凭据）：

- Host原线程／模型烟测：`/var/tmp/nozeli-pi-real-fvtCuD`，10项检查通过；只读不创建Controller／owner、休眠保存不唤醒、忙时保持当前请求模型、历史显示实际生成模型、冷恢复原thread且不重放、原文件不变、自有进程全部结束。
- 真实生产对话：`/var/tmp/nozeli-pi-electron-0Nabbl/report.json`，10项通过；原文空白与引用分层、逐Agent模型选择不推理、过期owner拒绝、真实回复及历史模型、草稿／冷开不重放与正常退出；实际截图已检查。
- 真实模型管理：`/var/tmp/nozeli-pi-model-mgmt-KiV4TF/report.json`，9项通过；源配置CAS／密钥保留、真实目录发现、thinking原生clamp、同owner／thread换密钥后真实请求且零重放。退出遵循实际“取消任务并退出”确认，不绕过运行保护，exit code 0。
- 注册`npm run test:smoke`最终4脚本全过：真实文件宿主`apps/desktop/.test-output/ci/smoke-V8owZX`、PPT实际引擎导出`/var/tmp/nozeli-ppt-pending-fMpCF4`、投影合并及协作表面`/var/tmp/nozeli-collaboration-ui-FsSpmT`。组件还核对延迟回执下退出／继续编辑、62个Agent分页与后页焦点、菜单事实更新但保留选择／搜索、跨项目迟到隔离、390px无横向溢出。组件网关是确定性合成数据，不冒充该组已运行真实Pi。
- 完整`npm test`通过：unit 560/560（64文件）＋integration 1559/1559（150文件），合计2119项，0失败、0跳过；原始TAP为`apps/desktop/.test-output/ci/{unit,integration}.tap`。`npm run build:renderer`通过；Pi运行时使用实际构建产物完成上述原生链路，不以`PI_RUNTIME_UNAVAILABLE`跳过。

验收限Linux x64。Windows/macOS、真实账号OAuth／付费模型、公开发行与安装未验；硬资源上限下的公平性／死锁调度仍遵循前述边界，不因本次接入宣称全局调度问题已消除。

## 11. Agent动态自动管理（2026-11-02，源码完成，Linux限定验证通过，未安装／提交／推送）

上一阶段完整测试通过后，用户授权推进工作项目Agent常驻、空闲卸载和启动重加载。本节新增自动闲置回收；不将§10已完成的压力回收／按需恢复冒充自动回收已经存在。

### 运行合同

- **常驻的是项目推进能力，不是所有角色进程**：已连接项目保留Controller、队列、依赖监听及宿主结算；任一Agent运行不因切项目停止。其他角色安全空闲可单独卸载，不关闭项目、不释放Work业务配额，不要求所有角色常驻。
- **默认连续安全空闲5分钟再卸载**：复用原进程归属核验和`reclaimIdle`；有明确容量压力时沿原策略提前回收。用状态／原生活动事件及最近截止时间驱动单个定时器，不轮询模型、不扫描历史正文。状态查询本身不刷新“使用时间”或启动进程。
- **拒绝回收受保护或未知状态**：运行／排队输入、工具、重试、压缩、原生交互、配置提交、宿主保存／结算、UNKNOWN、未核实owner、原生草稿、终端租约、交接与恢复中的实例不当空闲。到期再次核对原Controller及owner；异步退出前有新输入则保留，退出已开始的输入等待原退出确认后正常恢复。
- **按需重加载而非重放**：新的显式用户输入、已获准队列和真实依赖事件按原session路径唤醒所需target，恢复同一thread及已保存模型选择；不预热全部角色、不因浏览状态／设置偏好启动，不自动重演coldJobs／coldQueued／未知效果。单target不得出现双owner。
- **释放以确认退出为准**：停止失败或进程树未确认保留provider与预算证据；自动管理不形成密集失败重试。项目不可用、关闭及应用退出清理定时器与候选；原草稿、历史、文件、模型偏好不删除。

### 验收门

自动截止到期且仍有空余额度时实际卸载；同项目busy peer继续；原生活动重置空闲期；旧owner截止不能作用于替换owner；回收中收到输入不丢失；原线程新输入／依赖事件正常唤醒且不重放旧输入；停止失败不释放名额；项目关闭后无延迟重启。以下记录真实Pi进程、本地Provider、真实文件及相关回归／Electron表面的运行证据。未授权安装、提交、推送或付费请求。

### 落盘模块与审查

- `managed/agent-idle-lifecycle.mjs`：单个unref截止定时器、单飞到期处理、单调时钟和精确Controller／session身份；状态批次核对与单target即时核对分开。未回收的安全竞态返回false只取消本次截止，下一段空闲仍可回收；真正退出失败按原session抑制自动重试，保留证据。
- `managed-projects.mjs`：接入连接、状态、原生活动及项目／应用关闭；不移除闲置项目Controller，不更改原`openController`草稿保护、归属记录、项目读取、模型意图与预算合同。
- `Controller`：原生已知空闲、宿主保存／publication／closure／交接／未知状态及合法排队保护；终端关闭后的异步空窗再次核对，退出确认后再清除本owner，最后解除回收栅栏并kick队列。原生eligibility事件先于32ms展示事件合并，短暂busy→idle也重置连续空闲期，不因展示合并丢失安全变化。
- 两位独立reviewer分别检查截止／清理与原生准入／恢复。截止审查提出的32ms合并丢失空闲重置问题已修复并复审无新增发现；review是源码判断，不代替以下运行结果。

### 已运行验证

- 定向生命周期／进程额度／Pi准入／协作投影：48/48通过，零跳过；覆盖替换owner、回收中输入、亚帧原生活动、原线程唤醒、冷输入不重放、已确认与未知退出、宿主事务保护。
- 完整`npm test`：unit 560/560（64文件）＋integration 1578/1578（151文件），合计2138项，0失败／0跳过；原始TAP为`apps/desktop/.test-output/ci/{unit,integration}.tap`。
- `npm run build:renderer`与注册Electron smoke 4脚本通过；真实文件宿主`apps/desktop/.test-output/ci/smoke-g60InC`、PPT实际导出`/var/tmp/nozeli-ppt-pending-jw4DeL`、协作表面`/var/tmp/nozeli-collaboration-ui-K7FDEr`。真实生产对话Pi链路`/var/tmp/nozeli-pi-electron-Mi6x19/report.json`10项通过，含正常退出及冷恢复不重放。
- 真实动态生命周期最终验收：`/var/tmp/nozeli-auto-idle-real-jWgwVK/report.json`，8项检查全部通过。用实际DesktopHost／ManagedProjects／原生Pi PID／隔离文件／回环HTTP Provider；仅通过构造器把闲置期缩至1200ms，默认5分钟由确定性时钟边界回归另验，不声称真实等待过完整5分钟。忙前台保留、闲主控PID实际退出；状态查询及休眠偏好不唤醒；主控／前台按原thread恢复且应用已保存模型；真实Worker运行时两个resident可卸载，随后发布冻结报告；Worker自己闲置卸载而Work配额仍占用，显式续作以相同thread、新PID推进原Work到revision 2，仅一次新请求且原生日志精确保存原文；最终全部自有进程确认退出，无延迟重启、无原文件修改。

真实验收前的失败驱动未计入通过：脚本曾把后台核对也当作intake调用管理工具，被产品真实准入拒绝；已修正确定性Provider按实际事件范围作答，未放宽产品权限。续作原文以原生日志核验，不把provider最后一个user片段的位置当成稳定协议。临时驱动在证据保留后移除。

限Linux x64及本地确定性Provider；真实账号／付费模型、Windows/macOS、全局公平性／死锁消除、安装与发行不据此验收。项目Controller和存储服务未做冷卸载，文件／网页／终端工作面也不受本轮Agent进程回收策略驱逐。
