# 报告审核与原工作讨论：当前接入及历史 Demo

Date: 2026-11-06

## 最新截图反馈：折叠策略与过程内联（2026-11-09，设计待实施）

用户要求主对话整张Task默认折叠；审核讨论窗保持展开；满宽“请求→主控…”过于松散，改为内容宽度的紧凑方向，减少重复分隔／正文摘要。进一步明确所有“查看过程”应在当前Task／对话内展开、折叠，不再创建独立分屏。Reviewer核对后确认须同时迁移固定Task过程分页／消息定位／原件导出的窄权限链，不能只改CSS／移除按钮；不升级报告object／决定token，不丢完整日志或超大原文能力。具体视觉、独立surface阅读记忆、动效与验收见[任务卡最新设计](task-workspace-design.md#2026-11-09追加主卡默认折叠讨论展开过程内联设计待实施)。本节覆盖下方旧独立过程面方案，但尚未实施／测试／安装；当前安装仍为approval-shared-task-flow-20261109-local-01。

## 2026-11-09实施与验收记录

用户已授权更改、落盘、本地安装和测试，不commit／push／Release。共享`TaskReader`已用于主对话卡与审核小窗；旧`projectReviewConversation`及context／transcript双桶和w.request／w.brief合成历史生产路径删除。审核读取返回原scope的`taskFrame`＋白名单`taskState`，流式沿canonical替换身份，原输入／后续问答／修改／真实宿主事实同流。当前object与发送／决定token不因读取后来发布而升级。

状态投影补真实讨论tool／output活动、故障／偏离／维修原因，原business timeline记录决定登记、应用受阻／完成和收尾完成的持久事实；旧账本缺事件明确标缺失，不回填假历史。界面统一轮次／过程／工具／字段披露，按稳定job键保DOM与披露选择，异步read完成后重新检查选区／IME，短窗按实际单滚动容器保存恢复；定位请求临时保存且requestId只消费一次，不劫持后续概览或冷恢复。

审核子窗只收到固定Task失效通知；原文、材料和成果读取仅限宿主实际披露身份。冻结材料读原bytes，不读同名当前文件；过程导航使用宿主验证的原scoped cursor定位原消息。复制仅安全写。普通发送不自动应用已存人工稿，显式“交回人工稿并发送”确认具体object／版本／文件／摘要后才用applyDrafts准入；请求摘要和未知重试保留该效果选择。

已验：后端／权限／原稿授权71项通过；新增宿主事件、状态和布局组118项初跑117通过，唯一测试错误为选中了默认conversation而非task-process，修正后该scope组15项全通过。真实DOM／状态／发布序号组58项通过；共享React/Electron消费者`/tmp/nozeli-session-consumer-vJjsFl`通过，包括真实receipt导航、同ID对照、流式节点、定位、复制和披露保持。真实Electron/Pi/Git审批旅程`/tmp/nozeli-approval-discussion-uMQKDH/report.json`通过多轮FIFO、旧对象保持、显式换版、草稿、四主题、窄／短窗／200%、取消采纳及实际合入／结束／正常退出。冻结安装包另行验证后记录。

原生合成像素门未签收：中文人工稿独立旅程`/tmp/nozeli-ux-batch2-zh-SzaPza/report.json`因Spectacle失去确切PID焦点而拒绝注入，未取得该次父子窗合成截图，不绕过工具保护或拼图。保留历史黑块／卡死的未验边界；已有DOM／原生几何／正常生命周期通过不能冒充所有像素问题解决。Linux限定，本地回环脚本模型不证明付费模型理解质量。

实际安装：用户授权后激活`approval-shared-task-flow-20261109-local-01`，previous保留`task-flow-attention-fixes-20261109-local-01`。806份生产输入一致，实际包旅程`/tmp/nozeli-approval-discussion-E7mG6k/report.json`全程ok=true并正常退出。初次冻结包旅程在200%输入几何检查失败，后以等待稳定客户区并滚动输入可达的验收通过，原件保留`/tmp/nozeli-approval-discussion-MdmzLS/`，不扩大为已证明所有旧缩放失败同因。交付清单`/tmp/nozeli-approval-shared-install-NuvAau/`，未commit／push／Release，未强关用户窗口。


下方设计中的“未实施”是此前快照，最新实现与安装状态以上节和docs/status.md为准。

## 审批窗展开原Task流（2026-11-09，Reviewer设计，未实施）

本节为最新用户要求与Reviewer／UI设计联合梳理，优先于下方历史Demo的内容组织。只做设计，不混入本次本地修复安装；不证明原生黑块、卡死或同帧像素问题已解决。用户要求：审批讨论窗展示Task卡片的展开内容；展开保留真实流动动画和详细信息，后续讨论、问答、补充、修改和审批反馈都进入原Task流；充分美化，直观、动感、简洁，各级展开一致完整。

### 再次反馈后的内容对齐评审（2026-11-09，仍未实施）

当前安装的小窗未与Task卡对齐是事实，不是用户未重启：安装修复只恢复主卡流向。生产仍存在两套投影：`groupSessionWorkflows`／`TaskConversation`对比`projectReviewConversation`／`mountThreadTranscript`。合成原记录探针确认后者把原输入拆为context，主卡则将原输入与question／answer置同workflow；小窗独立拼状态且没有TaskStageRail。旧discussion读取显式不投影流式回复，`work-request`／`work-handoff`还来自当前w.request／w.brief；不能以当前可变字段重造历史原文。

**单一实施方向：共享无写权限的Task阅读体，两套宿主外壳。** 不直接挂完整Timeline，不在旧context＋transcript上方加Task头假称对齐；也不把当前主卡有限页数组当完整Task历史。两面允许不同加载范围／阅读位置，但同ID的原文、来源、顺序、状态语义及成果目标必须一致，页外内容要明确标记并可达。

|共享片段|统一内容|宿主差异|
|---|---|---|
|TaskHeader|名称、唯一总体状态、真实当前动作／等待对象|小窗标题槽承接Task名，不重复第二标题；主卡无窗口几何|
|TaskStageRail／详情|五阶段方向、真实活动、事件身份化回流、已记录阶段事实|两面相同，不让discussion.active覆盖Task总体状态|
|TaskHistory／原请求|原sequence、原ID、引用与冻结材料、已加载范围／cursor|原请求缺页走原reader；无原记录明确说明，不以w.brief补历史|
|TaskRound|确切request／job归轮，原用户输入、Worker多个回复、失败／未知|无依据独立显示，不按相邻正文合并；原节点与字段读取保留|
|TaskHostFact／成果引用|发布、决定登记、应用受阻／完成、收尾及各条冻结object|流内成果点开该版；主卡最新入口与小窗“此版成果”语义分开|
|过程披露／OriginalFieldReader|真实执行者／状态／已加载范围，参数输出错误原文分页|统一进入原固定scope只读面并定位轮次；无定位能力列为缺口，不默默跳latest|

主对话仍负责多Task与普通前台编排、全局分页及原主composer，不新增每卡输入框；Task续聊必须明确绑定。小窗独有当前阅读object版本条和固定Task原composer、保存／准入／回执提示。采纳／放弃仍仅在原成果页，小窗共享阅读体不能持有通用invoke写权限。只读过程面复用视觉／reader，绝不挂composer或审批权限。

主卡和小窗共同切换为共享阅读token、轮次与披露语法；不是只修改小窗。默认原输入与当前轮首次展开，历史／阶段明细／工具技术字段按需，用户选择按各表面稳定业务键保留。正文共同继承conversation字号／行高，轻角色标签和分隔，不继续使用审核tag饱和气泡契约。复制、材料、成果入口不能误触折叠；风险在摘要仍可见。

窄窗按实际阅读容器宽度适配，五阶段有序换行而不删节点／缩正文；深层视觉缩进最多一级。正常一个历史滚动区且composer非覆盖；短窗／200%使composer挤满时回退为整个窗口内容的单滚动，composer作为末段可达，不叠第二纵向滚动盒。流式、选区／IME、分页和历史回流消费均保留稳定节点及锚点，不自动强展开。

实施顺序：先补足宿主证实的Task lineage／原消息／宿主事实／活动与完整分页范围；再使主卡与小窗共同消费统一只读投影；最后替换旧context＋transcript及专用样式，接回原composer／保存／bind协议。真实讨论活动单独投影（现activeJob排除reviewDiscussion），普通问答不画修改回流。人工稿效果授权沿原链逐层补全，不能只靠改提示语。

内容验收不是“组件存在”：同Task／同加载范围逐ID对照原请求、引用材料、全部轮次、Worker回复、发布／决定／应用／收尾；各条成果目标一致；连续解释→追问→修改始终原Task且无模式；流式到canonical无重复／丢失；跨页原文、原字段完整可达；旧对象读取不升级token；两面披露默认和摘要语义一致但阅读选择互不抢改；真实活动／回流／暂停／减少动态一致；窄窗／短窗／200%无输入覆盖。原生黑块、像素与可信指针继续独立验收，不由内容设计宣称已解决。

**Reviewer最终收紧：**统一消费者切换时同步删除`#discussionEntries`用当前`w.request/w.brief`生成`work-request:<id>/work-handoff:<id>`的聊天行路径，不保留兼容兜底。这些行没有原始消息ID／requestId／revision／sequence，不能证明历史归属。历史原记录存在则用原ID／来源／冻结材料；缺失或不可读则如实标明，不补造历史。当前Work元数据如需保留只能明确标“当前任务元数据”，不参与历史轮次或去重。验收须修改当前brief后重开旧报告，旧历史仍不变、缺失仍为缺失。旧双桶context／transcript与伪原始行必须一起退役，不能把合成行搬进新组件就声称对齐。

流式读取为另一项阻断：必须接入原timeline的streaming→canonical替换身份、去重与事件投递规则；若某范围没有实时数据，明确标记尚未提供实时内容，不把durable历史当实时展开流。仅共享皮肤、现有数组或TaskCard均不能签收内容一致。



### 唯一推荐：同一业务流，多个阅读入口

保留现有父属非模态原生审批窗、共用local-window外壳、原Worker/session与原发送链。主对话卡、审批窗和只读过程面读取同一持久业务记录，各自保留阅读位置，不建立第二聊天store或平行审批聊天。一个输入框和发送按钮，不增加必须先选“问答／任务／修改”的模式。

审批窗宿主固定project＋Work，后续输入持续归原Task；主对话中的任务续聊凭taskRequestId、job／Work／intake绑定归属。普通前台消息不按名称、文本或相邻位置吸入任务；缺失／冲突身份明确标注待核对，不重写历史。原用户输入不与程序性交接重复呈现；消息按原sequence排列，同ID跨页去重，不按相同正文去重。真实发布、决定登记、应用成功／受阻和技术收尾作为具名宿主事实进入同一流，不冒充模型回复，不为显示事实再派模型。

### 三个身份范围分离

|范围|用途|不允许|
|---|---|---|
|固定Task／Work流|按原intake lineage读取同一任务的全部已证实记录|新报告另建聊天、按标题重绑、读全流自动复活ended工作|
|当前阅读object|冻结报告正文、成果及人工稿pin|新发布自动换正文、以新成果污染旧报告|
|本次发送／决定object＋reviewVersion＋requestKey|宿主准入、回执和决定CAS|读到latest后偷偷升级token、换key重发、采纳新版|

发布序号、Work revision、reviewVersion、人工稿revision／digest各有语义，不互换。旧报告中可见后续发布事实，但仍保留旧阅读对象；仅用户显式“查看最新报告”才沿原保存／bind协议切换。未发意见保留并提示来源版本，不静默改绑。未知发送使用原key、原对象、原文核对回执；跨文档flush后token改变则拒绝重新核对，不自动换token提交。

### 视觉结构与统一展开层级

```text
Task名称                         唯一完整状态  收起 ×
一句事实摘要／明确标注的原请求摘录
请求 → 主控 → 执行 → 成果 → 审阅        始终可见
▸ 阶段详情  最近真实交接／发布事实
↶ 审阅／补充已回流                       真实新事件
当前动作／等待对象                       有依据才显示
当前查看：报告发布号 · 工作修订 · 当前候选／历史只读
查看此版成果 · 版本与来源 · 查看过程
──────────────── 单一历史阅读区 ────────────────
读取更早任务记录／明确未加载范围
▾ 原始请求                              用户 · 原时间
  原文、引用、冻结材料
▸ 历史讨论轮次                           一句原文摘录
▾ 本轮问答／补充／修改                   原时间
  用户原文、原Worker回复、真实发布／审批反馈
  ▸ 执行过程                            按需进入原只读面
───────────────────────────────────────────────
继续此Task的讨论                         固定上下文标签
原输入框、原草稿和材料                    发送
本地已保存／未发送，或具体保存／准入／回执阻断原因
```

窗口收起是唯一顶层收展，避免另套Task总开关；标题拖动不兼任点击折叠。头与主阶段方向可见，技术阶段详情可折叠，不能再次删除主流向。原始输入和当前讨论首次默认展开，历史轮次可收起；用户手动收起后刷新不强制展开。

|层级|折叠保留|展开行为|
|---|---|---|
|阶段详情|主方向、当前阶段、真实事实摘要|查看已有交接／发布依据，不画百分比|
|讨论轮次|来源、时间、原文摘录、失败／未知|同一确切request／turn的原文与回复；无依据不拼轮|
|执行过程|执行者、真实状态、已加载范围|进入原固定scope只读过程面，不在审批窗再复制整棵日志树|
|工具记录|工具名、状态、实际时间、阻断原因|参数／输出／错误沿原消息身份读取|
|原文字段|字段名、已知长度／页码或尚未读取|原字段分页、复制、代码横向滚动／换行，不以片段冒充全文|
|版本与来源|当前查看版本、历史只读／版本变化风险|技术ID按需展开，风险不能折叠隐藏|

各层统一左chevron＋标题＋一句有依据摘要，时间／来源置右，窄窗换行；优先原生details／summary，自定义控件保留aria-expanded／controls、Enter／Space及可见焦点。复制／来源／材料按钮与折叠命中分开。折叠包含焦点的子树时焦点回所属披露按钮，不进入隐藏内容。

中性阅读底、Task细身份线、轻分隔和4px间距节奏；建议内边距12／16px、组间12–16px、行内4–8px，沿既有token落实。正文继承用户conversation字号，标题约正文大小／600字重；元信息弱化但可读，不靠缩字通过200%缩放。披露命中至少36px，触控44px；深层缩进窄窗收敛，不层层堆边框、饱和气泡或大按钮。状态有文字和形状，不只靠颜色；浅深／高对比需实测，不能预先声称无障碍合规。

### 动效与阅读稳定

|事实|表现|边界|
|---|---|---|
|当前job真实思考／输出／工具运行|当前阶段细线前向流动|不从模型文字猜进度，不全卡呼吸，不假百分比|
|新持久消息|一次轻量到达提示|读旧段只给“有新内容”，不抢焦点／展开历史|
|新continue／reviewContinuation|一次反向回流＋文字|普通问答不冒充修改回流，历史重开不重播|
|用户收展|短chevron转向、内容直接呈现|避免长高度动画、长流弹跳|
|排队／等待／暂停／未知／待审／closing／ended|静态状态与方向|不持续跑执行动画|
|隐藏／收起／减少动态|停止移动，保留静态箭头和全部信息|不补播历史，不用闪烁替代|

展开状态按Task scope、request／job、消息ID与字段保存，不用标题／数组索引。保留同DOM、草稿、附件、原文分页、选区和滚动锚点；加载更早页以首条可见消息和相对偏移锚定。只有已在底部且无选区／IME／编辑时跟随新消息。单一历史纵向滚动容器，composer可达，工具不另套纵向限高盒。320／390内容宽、短窗和真实200%下自然换行，不隐藏阶段、不缩正文；五节点换行仍保留方向。冷恢复窗保持隐藏；跨进程正文选区恢复不冒称已支持。

### 发送与审批：必须先补齐的生产缺口

普通发送只确认提交原文，不表示采纳、合入、结束或扩大权限。复用managed.review.discussion.send、原Work持久FIFO队列、requestKey和保存／IME／版本屏障；含歧义就在同Task流内澄清。解释不强制发布新报告；明确修改在既有授权和工具权限内执行，额外权限仍走原确认。

Reviewer查明：当前controller讨论路径会依据已保存人工稿差异构造apply plan并应用到执行目录、推进revision。未来必须分开“人工稿已保存”和“用户明确交回这些具体稿件执行”；在原输入区就地列出文件、冻结版本和具体效果，沿现有安全确认准入，取消保留原文。该确认不是模式切换，也不是采纳；不能用prompt“不要修改”冒充强制权限保障。本次只记录设计，不修改该行为。

task-presentation当前activeJob排除了reviewDiscussion，不能直接拿它当讨论运行状态。实施需区分原任务执行、讨论回合及真实审核回流后再共享投影；不得将所有讨论都画成回流。

采纳／放弃仍仅位于原成果页唯一决定区，窗内不复制按钮。accept沿workspace.review.decide及精确版本确认；discard沿原disposition.binding／managed.end，不改成accept变体。保留review-lifecycle真实closure证据，区分决定登记、应用受阻、收尾完成；不根据endedBy或按钮成功猜测效果。

### 实施落点与验收门

- domain/review-conversation、managed.review.discussion.read：统一Task投影，补来源／绑定／运行／审批事实；不新建消息store。流读取与操作token分离，保留宿主分页与能力原因。
- managed-review／discussion-thread：替换旧context＋transcript的内容组织，不在上方再叠一张完整卡；复用原消息节点、草稿CAS、pendingSend、quote／copy与原发送链。
- session-timeline／task-presentation：复用身份、主流向、原读取器；提取可复用阅读呈现而非直接挂依赖#conversation的完整Timeline；区分最新publication和当前阅读object。
- review-discussion／NativeReviewDiscussionManager／专属preload：保留owner／generation／project／Work／object授权，新增读能力不能变成通用managed写权限；沿共用外壳，不另造几何控制器，不向报告注入应用桥。
- send→main的discuss路由→controller→store/job→receipt：任何具体人工稿效果授权都须逐层校验、持久化与冷恢复，不能只改前端或按钮。新增事实通知须接通生产、过滤、转发、订阅，不只发未消费事件。
- task-workspace：固定scope、原cursor／字段分页，保持只读无composer，披露视觉一致但不共享审批写权限。

未来验收必须覆盖：双Task穿插普通前台不串流；连续解释→追问→修改无模式且原Work／session不变；原文与程序交接不重复；全流可读旧对象权限不升级；人工稿存在不触发未授权应用；未知回执用原key且不重派；保存失败／IME／token变化保留现场；四层披露完整可达且焦点／选区／分页／草稿保持；运行／暂停／回流／隐藏／减少动态符合事实；同次运行关闭重开保留现场；旧页和长工具不跳底；浅深／高对比／320／390／短窗／真实200%可用；父窗迁移／模态／保存屏障正常；跨Work／object／message伪造拒绝。真实原生合成像素与指针门单独验，禁止拼接图或仅DOM矩形冒充通过。

Reviewer与UI设计已核对上述单一方向，未运行新设计验收，未实施。历史证据保留下方，不覆盖本节。

## 当前实施候选（2026-11-06，未安装，整体验收未通过）

用户已授权实施并经 reviewer 测试。正文末尾成果附录、三按钮、父属非模态讨论及宿主保存／决定屏障已接入源码；最新独立候选 `review-page-redesign-r4-20261106` 冻结于 `/tmp/nozeli-review-redesign-ARiK9h/candidate-home/.local/opt/nozeli/releases/`，未替换日常安装、未提交／推送。r3的186项集中契约回归和r4的37项相关回归通过，不替代原生像素／真实用户反馈验收。

- 用户再次反馈放大缩小不正确后，确认原承载混用CSS像素与屏幕DIP，并以100vw/100dvh强制覆盖共用外壳。r3删除这处分叉：标签 `local-window` 独占rect、resize、最小尺寸、夹取、收展36CSS及偏好持久化；原生环境只映射坐标、最后转换一次为DIP并应用客户区bounds，默认标签行为保持。
- Reviewer独立静态复审关闭已发现的：跨文档人工稿／IME保存遗漏、冷初始化失败永久坏row、放弃未知回执被新能力判断拦截，以及CSS/DIP两套几何控制。不是整页签收。
- 独立执行器真实r3原件 `/tmp/nozeli-independent-review-gYlXgI/report.json`：CSS resize420×460→470×500→400×450，折叠450→36→450，父夹取不改400×450偏好；页面zoom0.8/1.25及真实普通文件标签同操作有原始记录。Reviewer亲读数值与trusted pointer轨迹，限定为当前Linux显示配置的trusted-CDP集成支持；不是OS硬件、跨DPI或矩形外合成像素证明。host部分存在1DIP及zoom1.25高度约2.5DIP偏差，不写逐像素完全相等。该报告整体仍ok:false，后续guest定位／生命周期尚未通过，不把部分结果冒充完整旅程。
- r4真实包生命周期完整原件 `/tmp/nozeli-independent-review-pFV7Bs/report.json` 为ok:true：应用级composition阻断保存、注入宿主保存拒绝时隐藏／两决定被阻断、真实业务“重试保存”以原revision保存后同DOM hide/show恢复、detach/dock子窗随父迁移、采纳取消原bytes不变、实际合入candidate及原Work ended/complete；同object意见revision2首次只读查询9ms成功，ended后同DOM只读且未派工，Electron实际exit0。Reviewer亲读原件，关闭保存恢复及采纳后只读收尾两项运行阻断；未声称其亲自运行测试。旧TRANSFER_HELD失败原件保留，本次成功不证明旧错误原因或最大释放时间。
- r4放弃完整原件 `/tmp/nozeli-independent-review-mgT5dM/report.json` 为ok:true、decision=discard：取消零写入、确认后baseline保持不合入候选，原Work ended/discard/complete，意见revision2同object只读同DOM、不派工，实际exit0。同目录第二轮performance-report为真实r4 ELF，连续opened60/60和after-drag60/60样本child可见且应用持焦点；79次trusted-CDP手势／30.284s；三个静置段讨论bounds和displayView.write均0，CPU中位增量0。opened阶段workspace.bounds有11次，不宣称全应用零IPC；未覆盖真实硬件指针、跨DPI、input→pixel p95及每帧pending统计。
- 真实父子同帧像素仍阻断整体签收：系统Spectacle activewindow不包含child；正常区域UI多次有界尝试未生成PNG，最终纯合成probe失败原件 `/tmp/nozeli-review-redesign-ARiK9h/composite-owned-final.capture-failure.json`。直接KWin CaptureArea未授权、XWayland root黑帧；没有修改权限／用户截图配置、没有全屏个人数据采集或拼图回退。自有probe均自然关闭，未把工具失败转述成产品已无黑块。
- 旧源码性能原件 `/tmp/nozeli-ux-batch2-zh-lKPuM3/performance-report.json` 只能支持静置无持续讨论bounds／展示写入；opened60样本中44个child隐藏，不能签“连续可见60秒CPU预算”。后续须逐样本验证原生可见和焦点再测。截图root全黑／系统工具不含child也不算产品通过；禁止拼接父子图伪造浮层，真实同帧像素门尚未通过。
- 用户另提供的“保留进展”截图已实际查看并由另一reviewer深审，建议删除冗余专页、合入任务详情；属独立设计分析，见[冗余复核](agent-conversation-status-demo.md#保留进展整页冗余复核2026-11-06设计未实施)，未擅自实施删除。

下方“待实施”保留原方案快照；当前实现状态以上节为准，原日常安装成果页仍未验收。


## 最新用户反馈与重设计范围（2026-11-06，当前验收未通过）

用户在安装新版后明确反馈：成果页仍不正确，审核讨论窗直接卡死、部分发黑、没有真正悬浮。此前源码／隔离安装专项通过不否定该现场反馈，也不构成当前成果页验收通过。当前消息带“📷 #1”标记，但本轮未取得可解码附件；不得声称已查看截图像素或已定位卡死／黑块根因。

- 本轮要求 reviewer 重新设计整个成果页，不仅微调按钮／CSS；先形成设计与真实安装验收标准，不据旧安装授权继续实现／安装。
- 报告为唯一主体；成果文件及已有的相关方法／数据属于报告正文末尾的内容区，不能继续挤占固定页级操作栏。不得凭空生成方法／数据，不改写冻结报告原件；缺项应如实说明。
- 页级操作收敛为三个明确入口：**审核讨论、采纳并结束、放弃并结束**。成果文件／差异及版本详情放在对应内容位置按需进入，不增加重复页级按钮。
- 审核讨论必须真正悬浮、不挤压正文，且可输入、移动、收起与恢复；不得以最大无挡矩形裁掉大片报告、隐藏原生正文或冻结截图冒充浮层。黑块／卡死需在后续真实安装运行中分别查证，不先定因。
- 保留原 Work／线程、草稿／选区／阅读位置、确切报告版本及审核 CAS、人工稿与未发送意见、保存失败／IME／并发／只读屏障；放弃必须走原结束流程与危险确认，不删除用户文件、不自动重放。

此前实现与安装历史保留于下方完整重设计之后；当前页级方向以本次用户反馈和 reviewer 重设计为准。

## Reviewer 成果页整体重设计（2026-11-06，待实施）

状态：设计交付，不是实现或验收报告。未修改产品代码，未安装、提交或运行 build/lint/tests/formatters。此前安装授权不延续。用户实测“讨论小窗卡死／部分黑／没有悬浮”为当前事实，当前安装 2026-11-06T06-50-32-215Z 不合格。只有 📷 #1 标记，没有取得可解码截图；本稿不声称看过截图。父已更新设计文档开头的验收状态，历史测试只保留其原有范围。

### 一、证据、推断与决策分开

下列路径相对 apps/desktop/src；行号为读取快照。

| 已证事实 | 定位及含义 |
|---|---|
| 页外审核 section 与报告原生阅读面分离 | renderer/managed-agent-panel.mjs:395–426：mountReport 调用 mountStaticReport；appendReview 单独挂 mountManagedReview，按 project/Work 复用；不是正文自然末尾的完整成果区。 |
| 当前四个页级动作，缺直接放弃 | renderer/managed-review.mjs:39–85：成果文件、交付物Diff、审核讨论、采用并结束；文件/Diff 两块互斥开关，CSS 限制到 30dvh 内滚动。版本、标题、状态与内容入口混在同一区。 |
| 现有“悬浮”会额外裁正文 | renderer/isolated-surfaces.mjs:18–36：对遮挡窗逐次选最大无挡矩形；main/isolated-preview.mjs:223–235：父 View 裁切，guest 保持完整视口和负偏移。这能避免重排，却不能保留浮窗四周所有正文，不是真正叠层。 |
| 窗口外壳已共用，不应再写第二套拖动 | renderer/local-window.mjs:30–131、local-window.css：标题阈值、capture、取消、键盘、独立 view CAS 与复用 body；业务输入不是几何状态。 |
| 大范围观察确实存在 | isolated-surfaces.mjs:50–51 观察整个 body 的 subtree/childList/class/style/hidden/open；local-window 的 paint 会写样式和标题文本并 publish。事实仅能证明触发面大。 |
| 原生预览有明确隔离 | main/isolated-preview.mjs:315–358：独立 session、无 Node、sandbox、contextIsolation、静态报告禁 JS、导航拦截、真实父窗口所有权；workspace-native.mjs:672–744 管理独立窗、surface、迁移与回收。不能直接把应用桥暴露给报告。 |
| 正文末尾已有安全的只读入口机制 | main/isolated-preview.mjs:164–178 在服务副本的最后 </body> 前附加文件链接，不改变冻结原件；nonce endBase 经 :354–356 导航拦截变成 end-matter 事件；renderer/isolated-surfaces.mjs:52–56 消费并传给 onEndMatter。可复用，而非重写报告。 |
| 采纳和放弃不是一个协议 | managed-review.mjs:261–274 走 workspace.review.decide(action=accept,objectId,reviewVersion,requestKey)；main/main.cjs:498–501 仅准 accept/continue。managed-agent-panel.mjs:741–759 的 disposeWork 经 disposition.binding、revision/objectId 核对、确认、managed.end(decision=discard)，原入口在 :773 的更多菜单。不能给 workspace.review.decide 随意新增 discard 后只改按钮。 |

待证假设：全 body MutationObserver 与 paint/layout 是否形成持续反馈环；黑块究竟来自 clip、原生合成、迟到 bounds、挂载迁移还是其他遮罩；标题是否被 guest 命中或焦点/capture 中断。均不能写成已找到根因。未来诊断记录触发源→矩形→IPC序号→应用回执→实际像素及指针目标；不重复跑旧 smoke 反驳用户。总体重设计不以先证明某个卡死根因为前提。

依据 docs/principles.md 的阅读优先、打开不发送、切换不丢现场及独立业务身份；docs/worker-review-chat-demo.md 的共用外壳契约与最新反馈；docs/user-guide.md 成果段的冻结差异、人工稿、原线程与真实收尾。旧文档允许粗裁限制的部分在本设计中明确被新验收目标替代，不把旧实现说明当签收。

### 二、完整页面层级与线框

目标：第一眼知道正在读哪项成果、当前能做什么；正文最大化且保持原文；读到最后自然遇到实际成果和依据；决定固定可达；讨论只由显式入口打开。不是把四按钮换成三按钮。

宽面（以实际内容区 1100×800 为例）：

    项目 / 工作名                    报告 V3 · 当前待审核
    [仅有真实风险时：人工稿未保存 / 暂停 / 状态待核对]
    ┌────────────────────────────────────────────────┐
    │ 原报告标题与正文                               │
    │ 阅读列约 70–85 字符，图表按内容宽度适配          │
    │ 不新增 AI 总结、不重新组织旧报告原文            │
    │                                                │
    │ ……原文的最后一段……                             │
    │ ── 成果与依据（服务呈现附录，非改写报告） ──    │
    │ 成果文件 3                                     │
    │ 文件名 / 路径 / 修改类型 / 人工稿标识            │
    │   查看成果  ·  冻结交付 Diff                    │
    │ 相关方法：原报告章节链接 / 已冻结方法文件        │
    │ 相关数据：实际数据工件 / 已冻结引用              │
    │ 版本与技术详情 ▸                               │
    └────────────────────────────────────────────────┘
    [审核讨论]                  [采纳并结束] [放弃并结束]

打开讨论后，在正文上方真实覆盖一个约 380–420×420 的非模态窗：标题（工作名·报告版本）、收起/关闭、当前发送状态、原线程历史、意见输入、发送及保存状态。只有窗体实际像素矩形遮挡正文，周围正文始终可读可点。它不是固定并排栏，不挤压或缩短正文行宽。默认定位右侧且避开页级操作栏；移动后保留用户位置，Home 恢复默认。聊天内不放采纳/放弃。

窄面（实际内容区 390×844；320×480 同样必须可达）：

    工作名（可换行，不以小字硬塞）
    报告 V3 · 待审核 / 历史只读
    必要风险提示（自然换行）
    ┌───────────────────────┐
    │ 原正文，左右 12–16px  │
    │ 图表仅自身横向滚动    │
    │ ……正文末尾……          │
    │ 成果与依据            │
    │ 文件名                │
    │ 路径 / 修改 / 人工稿   │
    │ 查看成果 · 冻结 Diff  │
    │ 方法 / 数据           │
    │ 版本与技术详情 ▸      │
    └───────────────────────┘
    [审核讨论]
    [采纳并结束] [放弃并结束]

窄面固定栏两行，不用省略号藏危险决定，触摸目标至少 44px；正文 viewport 真实扣除栏高而非被栏盖住末尾。没有可读空间时允许三按钮纵向排列，不能横向溢出。窄面讨论仍是同一非模态可移动窗，宽度不超过内容区减 16px，高度夹取，标题/关闭/输入/发送持续可达，历史内部滚动；不增加一套移动端聊天。小窗打开不锁正文，外侧区域继续可滚；关闭回原入口焦点且 preventScroll。首屏不自动弹出，收到消息或版本变化也不自动弹出。

层级：正文 15–17px（继承现有阅读偏好），标题沿报告原样；应用状态/文件说明 13–14px；低频技术详情折叠，不能用 10px 堆满页面。浅/深主题使用现有 token，危险态不能只靠红绿区分。当前风险紧邻操作栏，版本详情不能吞掉“暂停、未保存、历史、回执未知”等必要信息。

页级仅【审核讨论】【采纳并结束】【放弃并结束】三个按钮。文件/方法/数据/Diff/最新版本/技术详情是其所在内容行的链接或 disclosure，不新增第四个全页 CTA。已有应用级导航和文档工具不复制成成果页操作排。收尾待办保持可达，但以状态正文中的定向内容链接进入原待办，不再另起一排页级按钮。

### 三、正文末尾“成果与依据”的数据与交互

1. 复用 appendReportEndMatter 的服务呈现机制和真实 artifact/manifest，不修改冻结 HTML 字节、对象摘要、导出原件或历史正文；新增附录明确标为应用附录。默认展开实际成果清单，不再页外按钮展开第二个文件面板。长清单随正文自然滚动，不设 30dvh 嵌套阅读框。
2. 每个文件显示真实相对路径、增加/修改/删除、可用预览及人工稿标识；“查看成果”沿现有 onOpenMaterial→openArtifact；“冻结交付 Diff”沿 onOpenFile→openArtifactDiff。同路径不等于同对象：传递 projectId/Work/objectId/relPath，不能从当前磁盘兜底。返回保留报告 scroll/选区及讨论现场。
3. 冻结 Diff 明示“冻结输入→本次发布候选，不含人工稿”；人工稿在成果工作面比较基线→当前稿，入口和说明不能混用。删除显示基线；二进制显示版本与不支持文本比较；缺基线明确不可用，不虚构空文本。
4. 方法、数据仅按已有结构化清单/冻结引用/真实工件归类；有报告原章节时使用其真实锚点，不复制改写原文。未分类文件仍在成果清单，不凭扩展名猜“方法”；没有结构化依据则写“未单独提供方法材料／数据材料”，可指向已知正文原位置。不得调用模型临时提炼，不编造数据集或计算指标，也不默认扫描用户目录补齐。
5. 扩展 end-matter 为明确白名单内容动作（如 artifact、diff、reference）；这些是设计中的语义名，不宣称已有 API。端到端必须改：slot 冻结目标表→nonce 链接生成→主进程导航 dispatcher 校验 action/index/source→isolated-preview 事件→renderer 显式分支→报告所属路由。现有消费者只认识 file/review，不能只生成新链接。过期 generation、跨 Work 或越界索引拒绝并显示错误；guest 永远不能执行决定或取得通用 invoke。
6. 版本与技术详情放附录末，摘要仅报告发布序号、当前/历史、人工稿；展开才见 objectId、工作 revision、reviewVersion、目标引用、冻结基线、回执/收尾详情。真实发布序号不等于工作 revision，不能用新版本的已合入状态污染旧报告。

### 四、悬浮承载方案比较与明确推荐

| 方案 | 安全与完整浮层 | 代价/限制 | 决定 |
|---|---|---|---|
| 可信同 WCV 外壳，报告置于无应用权限的 sandbox iframe | 同一合成面可做精确 DOM 浮层；可信 UI 与不可信报告必须不同安全域，禁止报告访问父桥 | 当前 CSP frame-src/child-src/frame-ancestors 限制和静态 guest 禁 JS 体系不支持直接套用；要重做资源、导航、打印、跨框焦点和高度/滚动协议。绝不能直接 innerHTML 报告到应用 DOM，也不能把讨论注入报告并开放 preload | 长期可评估，但不作为本轮最低风险主线；安全证明不是“小改 CSS” |
| 父属非模态原生子窗承载可信讨论 | 独立真实像素面位于报告 WCV 上方，正文仍完整渲染；仅小窗矩形截获指针，不需要 clip 让洞 | 需显式 owner、焦点、定位、缩放、迁移、合法模态、最小化/项目隐藏生命周期；X11/XWayland/Wayland 行为必须实测，不能推定跨平台成立 | 推荐：为原生报告接入共用 local-window 的原生承载适配器 |
| 保留最大无挡矩形 clip | 原有隔离仍在，保留 guest 行宽 | 无法表达“矩形中间挖一个洞”，必然丢弃窗外至少一侧可见区域；CSS z-index 无法跨 native view | 不满足新验收，不能当正式浮层或所谓降级成功 |

推荐落地约束：原生子窗 parent 必须是报告实际 parentWindow，不是永远 shell；非 modal、不全局 alwaysOnTop、不产生全屏透明命中层；窗口 client bounds 等于可见讨论矩形，外侧指针由原报告接收。子窗装载可信应用页并使用最小 scope：只可访问所属 project/Work 的讨论、草稿、展示位置，不能自选其他对象或执行文件采用/放弃。宿主验证 owner wc、window/surface generation 和业务绑定。复用同一 transcript、draft 和 local-window 手势/状态模型，仅 environment 把矩形提交给原生承载；不要让 OS 拖窗与 DOM 拖动同时消费一套事件，也不要新建第二个聊天 store。

切换项目/报告隐藏、小窗关闭只隐藏并保留输入；宿主模态打开时讨论禁输入并遵从父模态；主窗失活不悬浮到其他应用之上。脱离/回嵌迁移父属和 scope 是一笔有回执的操作，失败保留原归属并受阻，不能销毁脏稿。冷恢复保持隐藏。报告本体继续使用隔离 WCV；bounds 只处理真实父区域/合法模态，不再减讨论矩形。其他网页/标签调用方继续共用外壳，此次不顺带重做全局停靠；删除旧算法前明确哪些调用方仍依赖它，不以全局删除造成旁路回归。

平台无法可靠实现父属非模态层时，本轮该平台标未通过；不能默默回退粗裁、截图冻结、缩小报告或“打开另一个无关联聊天窗口”冒充完成。截图只作为验收证据，不作为报告显示介质。

### 五、三动作、状态及失败语义

| 状态 | 审核讨论 | 采纳并结束 | 放弃并结束 |
|---|---|---|---|
| 当前冻结报告可审核 | 打开/恢复；输入不等于发送 | 跨文档保存及确切 token 校验后确认 | 获取 disposition 的当前 binding 与 discard 能力后确认 |
| Worker 正在处理/有队列 | 能读；只有宿主允许才向原 Worker FIFO 排队 | 禁用并说明等待原回合/队列 | 严格按 disposition，不绕停稳/未知效果保护 |
| 历史版本 | 可读原历史；不把旧稿发送到新报告 | 禁用，内容链接可查看最新 | 禁用，不用旧页取消当前 Work |
| 人工暂停/恢复受阻/未知回执 | 能读；发送按现有屏障禁用或只核对原 request | 不猜成功，不自动重试合入 | 不以放弃绕过效果未知；宿主允许后才可决定 |
| 已记录决定、closing、合入受阻 | 只读；显示真实状态 | 禁重复，不写“已结束” | 禁相反决定，不把合入失败改成已放弃 |
| ended | 可读历史和保留意见 | 禁用，显示真实结论 | 禁用，显示真实结论 |

讨论：保留 project/Work/原线程、消息原身份、FIFO 与 requestKey 去重。讨论窗口身份 Work-scoped，每次显式发送仍冻结确切 objectId/reviewVersion。打开、拖动、关闭、展开版本不触发模型。送达未知沿原 pendingSend 核对，不生成新请求补发；拒绝与未知分开提示。新回复不夺取滚动与焦点；在底部才跟随，否则显示内容级新消息提示。历史原文、系统旧承诺均保留，当前状态另行说明。

采纳：按钮文案统一为“采纳并结束”，底层仍 action=accept。先等待 IME 结束并跨文档 flush；失败停在原页，保留输入/人工稿/选区。确认明确工作、报告版本、目标分支、实际路径及人工稿、写入效果；未发意见明确“不发送、不据此改稿，保留在本工作”。保存导致 token 变化则重新读版本并重新确认，不能偷偷换 token 后提交。决定记录、已应用、收尾完成分别呈现；接受回执不等于文件已合入，更不等于 ended。

放弃：页级按钮接原 disposeWork/disposition→managed.end(decision=discard)，不能给 accept handler 换标签。增加讨论草稿/相关人工稿的保存屏障并保留现有 draftWriter.settled、binding revision/objectId、allowed、并发和 requestKey 检查；最终以宿主能力和确切 binding 决定。确认默认“返回审阅”，危险按钮明确“放弃并结束”；文案说明“不把候选合入项目，结束此 Work；已有报告、冻结成果、人工稿和未发送意见保留为只读历史；不会发送意见，不删除项目文件”。如原流程要求主动草稿处置，提供明确保留到历史或返回的选择，不能静默清空或把保存等同发送。此处“放弃”不代表删除文件，也不回滚此前外部/前台实时编辑。

失败分别写：草稿未保存／审核版本变化（重新核对）／采纳决定未确认／已记录但合入受阻／放弃决定未确认／已记录但结束未完成。绝不共享“原文件已应用”成功文案。超时或连接断开保留同一请求标识，只查询回执；没有确定未执行证据不得换 requestKey 自动再试。关闭/切换/退出继承现有保存、IME、并发及 unknown 屏障。

### 六、实施分解与旧结构删除（未来实施，不是本轮授权）

1. 明确身份边界：report presentation 只读冻结对象；review session 持有业务状态；native discussion host 只管承载。沿现有 surface/store 分工，不引入新任务系统。先列出 footer 新动作的 producer/dispatcher/consumer 及可用能力来源。
2. 改完整成果页：managed-agent-panel 的报告挂载改为单一阅读区+紧凑头部状态+三按钮固定栏；移除页外重复工作名大区、四动作结构和附加文件/Diff面板；managed-review 继续持有草稿/队列/决定，不再作为第二块“成果页面”。保留原生报告原文和原路径文件工作面。
3. 扩充现有服务端 end matter，不另造 HTML 重写器。接完整文件、方法、数据、Diff 目标白名单及所有消费者。删除原 filesButton/diffButton/toggleDetail 和两个隐藏列表、30dvh 面板规则与旧“成果与审核”跳转；既有 artifact fallback 合并到同一附录读取路径，缺数据有明确空态。不得整文件回滚丢失 CAS 修复。
4. 原生子窗实现与 local-window environment 接口同步：主进程登记 owner/scope/lifecycle，最小 preload/IPC准入；renderer 复用既有 discussion body、草稿、历史和展示 CAS。关闭、dispose、迁移与失败均遵循保存屏障。报告讨论不再进入 clip 遮挡列表；其他使用者逐一追踪后才删除其不再使用的分支/监听，不保留双写位置或双重拖动。
5. 接三动作，移除更多菜单里的重复放弃入口；但不删除通用 disposeWork 业务链。检查 main.cjs、workspace-native 权限、review-documents 与 managed.end 的实际消费侧，不新增不可路由的 action。去掉 appendClosureAccess 的额外页级按钮排，保留内容级收尾状态/待办链接。
6. 布局调度收敛：原生讨论几何一帧最多一次，单 surface 最多一条在途与一条 latest pending，重复矩形不发；owner代次/序号拒绝旧回执，最终落点必须确认。不以全 body MutationObserver 作为布局来源，使用现有明确局部窗口事件、viewport ResizeObserver、必要父层几何/模态通知；错误文本刷新不能反向触发无限布局。持久化每手势结束一次，键盘合并后一次，业务 CAS 不与几何 CAS 混用。
7. 更新相应场景测试和 docs/principles、worker-review-chat-demo、user-guide、testing/status；旧历史证据不删，明确新的未验/已验边界。删除只证明 CSS class 或 dispatchEvent 移动的成功断言，改真实命中证据。实现完成后由获授权的主执行者统一运行检查；本设计不运行任何检查，也不要求现在安装。

### 七、真实安装 ELF 验收门（未来另获授权执行）

仅专用隔离 profile/合成项目；不可碰用户论文或清用户文件。记录 ELF 真实路径、appRoot、资源摘要、版本、Electron、显示后端、DPI/zoom、输入设备和实际内容 viewport。开发预览与真实安装分别留证，旧 smoke 不抵消用户失败。未获得安装授权就保持“待安装验收”。

A. 全页与像素：实际宽 1100/800/390/320，短高 480，浅/深；正文顶部、中段、末尾与很深滚动；文件清单/方法/数据/Diff确在同一正文阅读流末尾，页级始终只有三按钮。报告与聊天各自滚动，返回原滚动/选区。开窗前、开窗后、拖到中央/四角、resize、收起、关闭分别保留整窗截图与视频。除实际小窗矩形及其有限阴影外，报告像素不得消失、变黑或冻结；正文行宽/scroll 不因拖动改变。截图比对用确定性静态工件排除光标变化，不能只检查 DOM rect。

B. 真实指针：OS 鼠标点击可见标题文字/空白并连续拖动至少 80×50 CSS px，再反向；记录 isTrusted、target/composedPath、capture、client 坐标、原生接收 wc 与父窗口位置。输入/链接/按钮/正文选区不能启动拖动。点击窗外报告四边的真实链接与选择文本必须命中；点击窗内不能穿透。pointercancel、lostcapture、blur、Esc、Tab/方向键/Shift/Home、IME组合、窄短屏、父模态、脱离回嵌、最小化/项目切换/多屏均覆盖。DOM click、合成 dispatchEvent、直接 setBounds/controller.move 不算拖动验收；elementFromPoint 不证明原生未截获。

C. 文件决定：真实冻结基线和候选，包括新增/修改/删除/二进制、中文路径、人工稿与脏缓冲。采纳前原项目 bytes 不变；确认后核对实际目标 bytes、作者来源、合入/closing/ended 回执。磁盘并发改动、token变化、保存失败、人工暂停、未知效果都应阻断错误采用。放弃后原文件/候选/人工稿/未发意见都保留，项目不合入候选，Work按原流程结束。确认取消零副作用；双击、断连/晚回执、重启不重复发送/应用/结束。两种决定的成功失败状态与回执分别核对。

D. 线程与恢复：讨论一轮修改、纯解释、FIFO连续两条、回执未知、历史只读、同Work新发布、两个窗口同时保存；确认不创建替代Work/线程，不重写旧消息。移动前后输入DOM身份（同承载内部）、选区、草稿、历史滚动、报告选区/滚动一致；关闭恢复同节点，冷启动从持久草稿恢复而不自动开窗/发送。人工稿与发布候选的Diff语义分别验证。

E. CPU/IPC 有界：在同机同profile同静态长报告，开窗前后各静置60秒并记录renderer/main/GPU CPU、事件与IPC计数，连续拖动30秒后再静置60秒。硬门：稳定后5秒内布局停止，随后静置区间零无原因 bounds/view持久化请求；每surface在途布局≤1、待发latest≤1，提交率≤实际绘制帧率；每次完整手势持久化≤1，迟到回执不回跳，无增长队列或自激观察链。性能目标：讨论打开静置相对基线单核归一CPU中位数增量≤2个百分点，真实输入到像素响应p95≤100ms；这两项是待测预算，不是既有证据。超预算或持续IPC视为未通过并保留触发链，不能靠吞掉错误/暂停计数作假。

F. 安全/资源：报告脚本或伪造链接无法触达讨论/决定IPC；跨对象、跨项目、旧generation、越界目标一律拒绝。子窗不开全局顶置，不遮其他项目；关闭/释放不泄漏WCV、监听或session，失败迁移不销毁脏稿。截图冻结、裁空、缩小guest或隐藏整份正文均直接失败。

最终签收需同时给出：真实ELF身份、宽窄浅深全页原件、开窗拖动真实像素/命中链、CPU/IPC时间序列、真实文件采用与放弃前后摘要、原Work/线程与版本回执、失败场景及明确未验平台。没有这些证据只能称设计或实现候选，不能称“已修好”。

### 整合约束

- 推荐的原生小窗是报告父窗口所属的工具型非模态承载，不是新的项目独立窗口；不新增任务栏入口，不全局置顶。具体平台能否可靠做到随父显隐、合乎模态、焦点及多屏行为，必须以实现和实测为准，不在设计阶段保证。
- “方法／数据”只呈现当前报告已有章节、冻结引用或实际交付材料；用户所需的具体材料命名随原件，不臆造新能力。
- 先交付完整页面及原生承载候选，再统一执行上述验收；仅三按钮排布通过、纯DOM矩形通过或旧 smoke 通过，都不能越过卡死／黑块／非悬浮阻断门。

---



Status: 共用局部窗口已提交 `a772582`，用户授权与父提交 `e4dd289` 一起安装到本机 `2026-11-06T06-50-32-215Z`；真实安装ELF标签／涂鸦13项通过，保留回退。未推送或公开发布，完整记录见[当前状态](status.md)；下方“未安装”为源码取证阶段，用户日常项目及全格式／硬件矩阵不据此签收。

## 共用窗口实施（2026-11-06，源码，未安装）

- `local-window.mjs/.css` 统一备注／标签、冻结位置、审核与网页讨论的窗口外壳、几何、指针捕获／取消、键盘、尺寸、收起隐藏和焦点恢复；`local-window-view.mjs` 经宿主按项目实例、业务所有者及 surface 独立 CAS 保存展示状态，不使用业务草稿 revision。标记与来源留在原位置，普通刷新复用原输入。
- 冻结卡通过记录携带的 `card.windowOwnerId` 保留跨恢复 fork 的展示身份；不是以图片内容 hash 充当身份。旧 offset 原值保留，仅可测量时原子迁移。原生报告及网页用父 View 裁剪、完整 guest 视口，不以缩小 WCV 冒充遮挡；粗矩形裁剪仍可能多遮住窗体外的页面。
- 已实跑真实标题拖动、关闭恢复、PPT／涂鸦本地恢复、原生报告讨论及人工稿采用；网页真实拖动和 URL 草稿隔离已验证，菜单动作选择为明确回调 fixture，不冒充物理原生菜单点击。逐项原件、188 项回归和未验矩阵见[测试记录](testing.md#2026-11-06-共用局部窗口与简洁管理页源码未安装)。

以下“统一局部窗口契约”为实施前设计快照，保留其链接和当时证据；实施状态以上节和测试记录为准。


## 统一局部窗口契约（2026-11-06，设计，未实施）

本节优先于下方历史 Demo 的双按钮、自动展开、自由摆放模式及旧窗口实现说明。目标不是逐窗补监听器：全部局部讨论统一一套窗口几何、手势、键盘和生命周期。当前源码核对不等于实际拖动验收；本轮未运行用户程序／profile，也未复验旧 smoke。

### 1. 覆盖与当前分叉

以下路径均相对 `apps/desktop/src/renderer/`，行号为本轮读取快照，仅作定位。

| 窗口 | 当前所有者／挂载与坐标 | 当前位置／收起关闭 | 迁移职责 |
| --- | --- | --- | --- |
| 本地备注 | `note-tag.mjs:106–274`；文档标记子树，祖先 reader／编辑器滚动坐标，translate 加 fit | `workspace.mjs:218` 的 noteOffsets 持久化；chatSizes 仅 Map；标签 open／草稿回调 | 标记留在文档；卡移入同内容面的可信窗口层，业务保存备注不派工 |
| 文件讨论 | `app.mjs:224–274`；reader-scroll 内绝对零高度层，`data-tag-layout=viewport`，按 slot 初始摆放 | 同标签 move／resize；文件身份不表示锚点失效 | 删除 slot 布局及私有几何，保留文件线程 |
| 选区／位置讨论 | `note-tag.mjs:255–274,512–535`；跟随源标记可见性，拖动补 scroller 差值 | noteOffsets；标记离屏会隐藏卡 | 来源定位只供默认放置与显式返回；打开卡不再因标记离屏消失 |
| 真正未定位讨论及备注 | `app.mjs:236–270`；轻目录打开同一 viewport 卡，不是文件讨论 | 原引用／历史、显式重新定位独立保存 | 目录只作入口；保留同业务 ID，不造假锚点 |
| 冻结涂鸦“位置讨论” | `workspace-snapshot.mjs:375–505`；snapshot-card-panel，视口 CSS px，自然位置来自冻结笔迹 rect | `target.card.offset`＋现有恢复写入队列；返回笔迹／仅本地保存／完成各有业务动作 | 冻结图和笔迹层不搬、不重捕获；只把卡片面板接入外壳 |
| 审查／审核讨论（原 Worker 窗） | `managed-review.mjs:60–86,243–250`；root 内 fixed，窗口视口坐标 | position／drag 为局部内存；关闭隐藏原节点；CSS resize:none | 必须删自有拖动并接同 controller；Work 草稿与确切 object/token 保护保留 |
| 网页局部讨论 | `web-discussion-panel.mjs:1–16` 与 `online-browser-view.mjs:18–31`；可信 chrome 的 flex 侧栏，native guest 占剩余 viewport | 没有标题拖动；横向 CSS resize；草稿按项目＋已提交 URL 保存 | 纳入局部窗口统一范围；改为同外壳浮窗，不能将脚本注入网站或向网站开放应用接口 |

不纳入：主对话分屏／系统独立窗、应用顶栏移动、确认模态、设置、原文阅读器。这些不是局部讨论窗，保留原布局和安全语义；不得顺带重做全局停靠系统。

### 2. 已证事实与未证原因

- 标签和冻结卡使用 3 CSS px 阈值、方向键 10px；审核窗 pointerdown 即 capture，无阈值，方向键 16px，cancel 仅清 drag，Home 去右上；三者不是共享实现。标签／冻结卡没有统一 lostpointercapture、blur、销毁收尾。源码差异说明必须收拢，不能证明这就是用户现场失效原因。
- `styles.css:103–104` 的 reader 层 pointer-events:none、子标记 auto；`workspace.css:85` 标签 relative＋resize:both；审核 fixed／resize:none；冻结卡另有自然位置和夹取。层叠、包含块、滚动映射不一致。
- `workspace-groups.css:30–50` 含顶栏与 detached 标题的 app-region:drag/no-drag；当前三种小窗标题未显式统一 no-drag。不能据此断言全窗被原生拖区吞事件，必须读取实际标题及祖先 computed style／原生命中。
- `app.mjs:149–175,3019–3049` 有项目切换／transfer 的 inert；`frozen-change-reader.mjs:29–31` 会隐藏并 inert 原子树。合法屏障不能为拖动而移除；残留屏障是否出现尚未证实。
- `isolated-surfaces.mjs:17–35` 明确 native preview 画在 DOM 之上，仅识别 `[data-review-discussion]`，取最大无挡矩形裁切。既有证据承认额外裁切；CSS z-index 不能解决原生 WCV 命中。网页当前依赖占位缩小 guest，改浮窗必须同时改原生遮挡接口。
- 待取证：运行二进制／资源版本；标题真实 hit target 和事件是否到达；透明遮罩／祖先 pointer-events／inert；实际 app-region；native guest bounds、clip 与迟到布局；pointer capture／失焦；滚动、CSS transform、页面 zoom 与 DPI 换算。分别记录事件未到、到达未开始、开始后被重置、已移动但被遮住，不能猜定一个根因。

### 3. 最小共用模块与接口

新增 `local-window.mjs` 与 `local-window.css`，一个外壳／geometry／gesture controller，不引入另一份聊天或业务 store。`discussion-thread.mjs` 继续只管历史投影。以下为待实现契约，不是现有 API：

```js
mountLocalWindow({
  layer, key, title, body, actions, state, environment,
  commitView, beforeHide, onError
}) // -> { show, collapse, hide, reset, update, flush, dispose }
```

- `key={projectInstanceId, ownerKind, ownerId, surfaceId}`：ownerKind 为 annotation／snapshot／review／web；ownerId 来自真实业务身份，不用标题或路径猜测。annotation 含完整文件来源身份，review 为 Work（objectId 不作窗口 key），web 为确切已提交 URL；surfaceId 区分同业务的不同视图投影，窗口内切报告不改绑定。
- `body`／`actions` 是既有节点，首次挂载后移动、布局、收展、流式刷新不重建 textarea、历史阅读器和 selection。业务负责草稿、材料、线程、候选、版本、发送身份；controller 只持有临时 gesture 与展示视图。
- `state={schema:1, revision, placement:{mode:'auto'|'manual',x,y}, size:null|{width,height}, collapsed, hidden}`；x/y 为同一内容面可用区域左上角的 CSS px，manual 是展示位置而非源锚点偏移。auto 只由业务默认位置 resolver 解析。clamp 后的 effectiveRect 不回写用户 preferred geometry；缩窄后放大可恢复原偏好。冷恢复审核窗保持 hidden，不能因上次打开、新回复或新版本自动弹出。
- `environment.measure()` 返回同一坐标空间的 bounds、默认 rect、surface epoch；`environment.toLocal(clientX,clientY)` 负责坐标变换；`environment.subscribe(invalidate)` 监听内容面布局／visualViewport／zoom／滚动。默认矩形由适配层从源标记或笔迹映射，controller 不读文件锚点、不计算图像裁剪。
- `environment.publishOcclusion({key,epoch,sequence,rect,visible})` 将共用可见矩形交给既有原生布局管理器，Promise 返回实际 applied 的同代次回执。CSS px→原生 DIP 只在既有宿主边界换算一次，devicePixelRatio 不参与普通拖动增量。过期回执丢弃；宿主迁移后旧 epoch 无权改新 surface。
- `commitView({key,expectedRevision,next,reason})` 只写展示字段，返回新 revision；reason 为 move／resize／collapse／hide／reset。每次手势结束一次提交，键盘连续输入合并后 flush；业务适配器接现有本机保存通路。`flush()` 等本窗口在途 view 保存；不发送消息。`beforeHide` 只保留草稿／IME屏障，不调用 send 或 accept；失败保留节点与输入并呈现重试。
- `update` 只能更新标题／可用动作／环境／权威 view revision，不以普通状态刷新覆盖活跃手势或新输入。`dispose` 必须先由业务完成保存屏障；失败不得强拆节点。公开状态变化与 occlusion 发布来自 controller，不再靠各调用方监听样式变化推断拖动。

### 4. 统一交互及挂载规则

- 每个可信内容 WebContents 建一个非滚动 local-window-layer，位于编辑器变换／overflow 子树之外，但仍受项目／surface 生命周期与合法模态屏障约束。不挂到不可信 HTML／网站 DOM；不跨项目 portal。标记保持原文位置，卡片不挤压编辑区。
- 外层覆盖层 pointer-events:none；实际可见窗口 auto；hidden 窗不参与 hit-test 和 native occlusion。窗口及标题显式 `-webkit-app-region:no-drag`，标题 touch-action:none、user-select:none，正文可选择，输入正常 IME。共享焦点边框、主题 token、标题尺寸、滚动区和显式 resize handle；禁止业务 CSS 重写 position／transform／拖动规则。
- 标题空白／标题文本直接拖动，不先切模式；排除 button、input、textarea、select、a、summary、contenteditable、交互 role 及显式 no-drag 子树（用 composedPath）。只接 primary pointer、主按钮、一个 pointerId；pointerdown 记录原矩形并 capture，移动达到 3 CSS px 才进入 dragging，不把点击当移动。只阻止手势相关默认行为，不劫持正文选择或按钮。
- pointermove 用相对起点的 local 增量，rAF 绘制；不反复叠加 clamp 后的位置。pointerup 提交一次并释放 capture；pointercancel／意外 lostpointercapture／Escape／窗口 blur／surface epoch 改变均回到手势前位置、清监听、释放 capture，不落盘半途位置。正常主动 release 不触发第二次取消。尺寸手柄复用同一状态机。
- 标题可 Tab 聚焦、可访问名称和操作说明；方向键统一 10px，Shift＋方向键 1px，Home 回 auto 默认位置；只在标题本身聚焦时拦截，不消费编辑器快捷键。提供显式收起／关闭／恢复按钮，不依赖双击。Escape 优先取消手势，其次关闭菜单／确认框，最后才隐藏当前局部窗；IME组合中不隐藏。
- 收起只保留标题，关闭仅隐藏，删除标签仍为独立明确业务操作；恢复使用同节点、原草稿／输入选区／历史滚动／文档阅读位置。主动关闭恢复焦点到原入口且 preventScroll；异步更新不抢焦点。关闭审核窗不结束 Work；涂鸦返回笔迹不删除问题。
- 普通可用尺寸下全窗夹取；窄／短面优先保证标题、关闭、输入和操作可达，历史内部滚动，不硬塞桌面 min-width，不建立第二种窄屏窗口系统。preferred size 与临时有效尺寸分离。
- 原生报告／网页复用现有 native clip 父容器与完整 guest viewport：共用 occlusion registry 取代审核专属选择器，几何发布、隐藏、迁移、释放一并更新。保留现有最大无挡矩形裁切的明确限制，不能声称完全无遮挡；不得以改 guest 行宽、重建网页、隐藏整个报告或移除安全沙箱换取拖动成功。原生布局失败显示错误，保留输入及上次已确认布局；不能只更新 DOM 就报告命中已修好。

### 5. 迁移、冲突与删除顺序

1. 先用隔离合成项目启动实际安装二进制，记录第 7 节命中链；不复验用户“无法拖动”结论，而是定位失效阶段。先冻结当前来源／草稿／展示状态和版本证据，不触碰日常 profile。
2. 实现单一 controller 与可信 layer／native occlusion 契约，先让标签和审核窗共同消费，以防把审核遗漏到最后。业务动作仍沿原函数，新增导出前核对引用，逐调用方切换。
3. `note-tag.mjs` 删除 position／fit 内的窗口布局、head pointer/key/dblclick 移动及 CSS resize 观察保存；保留标记、来源、备注和 transcript；`app.mjs` 删除 viewport 卡 slot 偏移／私有容器定位，轻目录仅调用 show；所有文本／代码／Word／PDF／图片／PPT tag factory 调用均接适配器，不能只迁移 reader-discussion-tags。
4. `managed-review.mjs` 删除 place、position／drag、243–250 的 pointer／key／resize 分支；`managed-review.css` 删除 fixed 几何与专用拖动标题规则，保留内容样式。show／hide 对接共用外壳，底部审核入口／采用位置不变。`isolated-surfaces.mjs` 删除审核选择器专用 occlusion 计算入口，改读共享注册表；保留原生实际裁切算法与版本校验。
5. `workspace-snapshot.mjs` 删除标题专属监听、placeCardPanel／refreshCardPanel 的手工位移夹取、commitCardOffset 手势写入；layoutCard 只计算冻结画面与自然默认 rect。迁移 card.offset 后不再双写。`region-drawing.css` 删除重复 title 拖动与 panel 几何规则，保留冻结图／材料样式。
6. `web-discussion-panel.mjs` 接同外壳；`online-browser-view.mjs/.css` 去掉讨论 flex 占位及 CSS resize，接共享原生遮挡发布和既有 guest 生命周期。项目＋URL、导航不串绑、排除表单秘密、显式发送及任务去重保持。不能只把侧栏改 fixed 而留下 guest 抢点击。
7. `workspace.mjs` 的 noteOffsets／chatSizes 运行期读取改为统一 view store；旧字段仅由一次性版本迁移器读取，删除旧 writer 和所有旧监听，不留兼容导出或新旧系统分支。旧数据备份不是运行期 fallback。

数据迁移必须先保留原记录再原子写新 view：旧 noteOffsets 是相对自然位置、snapshot offset 是相对笔迹默认位置，不能直接解释为绝对 x/y。首次可可靠测量旧布局时，取旧实际可见矩形转换为 local 坐标；未打开／源失位／不可测量则保留未消费迁移记录并采用可达默认位置，不覆盖旧值。无旧字段为 auto；无持久尺寸不伪造恢复值；审核局部 position 只在仍存活视图可转换，冷启没有就默认隐藏。未知 schema／非有限值保留原数据并提示，不能清业务记录。

view CAS 独立于材料 CAS；多窗口相同投影写入冲突保留当前有效位置与双方 revision，给出重新载入或显式保存本次位置，不自动覆盖赢家，也不把 view 冲突升级成重发。存储失败保留内存草稿和上次 durable view，提示尚未保存；关闭／退出沿现有恢复屏障。回退运行包不得回滚内容数据库或重放队列；旧包不可读新 view 时可回默认摆放，但原新旧展示记录、草稿与历史均保留。迁移失败不以删除 annotation／snapshot／Work 解决。

### 6. 不得混同的业务边界

窗口移动／resize／收起／恢复不修改来源锚点、笔迹 rect、冻结图、文件版本、线程／requestId／messageId／发送身份。保存本地备注或涂鸦不派工；普通讨论和提交任务仍为显式动作。审查讨论保留 project／Work 归属、objectId／reviewVersion、跨文档 flush、候选 CAS、原 Worker FIFO、输入去重与 unknown 回执保护；采用仍在报告底部显式确认，沿 `workspace.review.decide` 和真实合入／closing→ended。旧引用、历史与阅读版本不被新报告静默替换。

### 7. 可执行验收与证据门

实施前后均记录实际 binary/appRoot、资源摘要、平台／显示后端、Electron 版本、实际内容 viewport、zoom、DPI、输入设备。只用专用隔离 profile／合成文本、PDF、图片、PPT、网页和真实文件/Git审核样本；本轮不授权安装或操作用户论文。安装版前测为诊断，候选开发版通过不能代替后续获授权的安装版验收。

每种第 1 节窗口分别执行：入口打开→输入未发送中文草稿并选中一段→记录历史滚动和源锚点／版本→从真实可见标题内非按钮坐标按下→连续移动至少 (80,50) CSS px→释放→反向拖动→关闭／恢复→正常退出冷恢复。用 OS 鼠标事件或 Electron 对实际目标 WebContents 的可信输入，记录 event.isTrusted、composedPath／target、capture、起终 client 坐标、窗口矩形变化和原生 hit surface；触控另用真实硬件记录 pointerType，模拟 cancel 只算组件证据。`elementFromPoint` 只能解释 DOM，不能证明 WCV 没截获。

同时核对原 BrowserWindow 位置未变、只有局部窗移动，原标记／笔迹／文件字节／版本／Work／线程／队列和请求数不变；输入节点身份、草稿、选区与阅读位置保持。不得用 dispatchEvent、DOM.click、直接 style／controller.move、body 非空或只比几何框替代实际拖动。失败时保留事件／宿主 bounds／截图，不删除失败记录。

| 场景组 | 必验结果 |
| --- | --- |
| 命中与取消 | 标题文本／空白可拖；按钮、输入、链接、正文选择不误拖；小于阈值不移动；跨边界拖动、cancel、capture 丢失、blur、销毁不残留手势；无意外 OS 窗口移动 |
| 可达性 | Tab／方向键／Shift／Home、键盘 resize、收起关闭恢复与焦点；IME Escape 和菜单／确认优先级；窄短窗动作可达 |
| 布局 | 浅深主题，实际内容宽 320／390 及桌面；分屏、滚动前后、分屏 resize、脱离／回嵌；页面 zoom 80/100/125/150%，可用设备上的 100/150/200% DPI 与跨屏；记录实际而非 requested 尺寸 |
| 来源 | 本地备注、文件、选区、点位、真正失位；文本／代码／Word／PDF／图片／PPT 实际内容；源标记离屏仍可操作已打开卡，Home 不伪造重新定位 |
| 原生层 | 真实 HTML 审核报告、离线预览、在线网页 guest；开窗／拖动／resize／关闭／分屏／迁移后真实标题命中；完整 guest viewport／正文行宽和 scrollY 不变，裁切范围与额外裁切如实截图 |
| 恢复与保护 | 收起重开、返回笔迹、保存本地、正常冷恢复、旧位置迁移、保存失败与并发 revision；原稿与历史保留，审核不自动弹出、不自动发送／接受，新版本仍需原确认 |

共享 controller 单元测试只验证边界／状态转换／取消／坐标／CAS消费者行为；既有测试迁移到新外壳，删除只钉 class／样式拷贝／旧实现文案的断言。实际审核发送／采用使用真实宿主、文件、Git及隔离模型链证明原边界，不以浏览器假动作代替。Windows、macOS、Linux X11/XWayland、原生 Wayland、触控笔／触摸屏／物理多屏分别记录；未测就标未测，不能从 Linux 或合成 pointer 推断通过。

本轮交付仅源码／文档静态复核与实施契约；上述运行矩阵全部待实施后执行。旧 `testing.md` 的局部 smoke 仅保留其原证据边界，不构成当前用户问题已解决。

## 生产接入决策（本轮优先）

最新用户要求与Reviewer设计：**进入待办审核时只展示原报告阅读面及底部审核区；底部唯一“审核讨论”按钮点击后才打开可直接移动的非模态标签式对话窗。** 报告展示以加聊天前26b39d6为基线，恢复原生成果文件浏览和底部交付物Diff；删除自动aside/stack和自由摆放模式切换。保留现有讨论、草稿、版本/CAS及原生文件业务链，不整文件回滚旧逻辑。

- 审核讨论窗绑定project/Work，按真实回合整理与主Work一致的内容；原请求/交接按需读原文，发布为事件，多段Worker回复同组且保留原消息身份。窗内只有讨论发送，不承载采用。采用、文件、交付物Diff及版本/状态均在报告底部；默认不打开，状态更新或重进报告也不自动展开。
- 每轮原Worker理解对话，按需修改并通过既有工具发布报告；纯解释且内容未变不强制新交付，实际候选改变而无匹配新快照必须阻止接受。普通问答不先废弃旧报告、不重建Work或原生线程。
- 沿用既有`managed.review.discussion.read/send`及原Worker发送/接单链，不开放普通`managed.send`的Worker目标，不新增右下角Agent状态接入动作。读取补充真实回合身份/有界过程记录，主对话直连Worker仍属于其他明确授权范围。
- 发送复用跨文档flush与确切审核token屏障；未保存编辑、IME组合、并发人工稿／新发布不能被聊天覆盖或静默采用。接受仍走原`workspace.review.decide`，保留合入与主控closing→ended收尾语义；接受回执不冒充已合入或已结束。
- 读取历史、打开／收起审批窗不启动模型；显式发送才持久接单、按原Worker单通道处理。忙时排队不伪称已被模型读取，暂停／故障／未知效果／权限／结束边界继续生效。重启恢复不重复交付已准入消息。
- 讨论草稿按Work持久保存，报告换版／项目切换不串归属，引用保留发起版本。浮窗收起不撤回队列或丢失草稿；关闭项目须走原保存／恢复路径。

当前切面：报告底部保留版本/采用/真实文件与独立冻结Diff，讨论只由底部按钮打开。共享标签transcript保留原消息ID并整理同轮多段，原请求/主控原文及过程折叠；新原生View父容器只裁切可见区域，HTML子viewport不因拖动改变行宽，嵌套捕获与迁移资源所有权同步迁移。发送、队列、CAS/IME、回执唯一性和原合入收尾沿既有链。

Reviewer设计与当前Source方向覆盖下列历史自动浮窗/并读说明，主计划§14已同步。最终实际原件：中文讨论/主Work内容对照/拖动与人工采用`36EMxf`，真实HTML/删除文本/冻结Diff`c3kf7o`，队列/窄短窗`fnjcN2`，真实失败后的暂停引导`y7ZEdE`，详见[重做取证](testing.md#报告审核工作面重做2026-11-05)。浮窗仍可能额外裁切原生报告，不宣称同时完整无遮挡阅读；旧Vk3Roh竖列重排及重复帧不进入After。安装状态只观察到current另变时间戳快照、407源码/354构建静态匹配，本轮没有替用户安装/提交/推送或运行该已安装ELF。

## 历史首轮接线证据（不作为本次重做签收）


状态：生产源码接通。实际Electron＋私有Pi owner＋本地脚本Provider＋Git文件链路7个场景通过（含654×1150、390×844、390×480实际窗口缩放），最终Work为ended、closure为complete；9次本地Provider调用，零付费模型／个人凭据使用。最终原件：`/tmp/nozeli-approval-discussion-Pmf9ld/report.json`、`electron.log`及报告／审批窗截图。此前失败原件保留，不计通过。

实现入口与关键文件：`managed-review.mjs/.css`复用`mountThreadTranscript`的标签讨论气泡，Work作用域浮窗及双按钮；`managed-agent-panel.mjs`把报告正文保留主工作区，并先持久化报告object身份后准入浮窗。`isolated-surfaces.mjs`为原生HTML guest裁出不遮挡浮窗的可见矩形，收起后恢复；后台新HTML发布不自动替换阅读面，用户从浮窗“查看最新报告”显式切换。连续同工作修订的报告另有publicationNumber展示，不混淆Work revision。

宿主：`managed.review.discussion.read/send`仅报告所属Work准入；main经`runReviewDecision(action:discuss)`执行全量候选文档flush／token核验，精确重复输入先回读durable回执。Manager内部`reviewDiscussionReceipt`不对外暴露IPC。普通`managed.send`的Worker准入仍拒绝，关闭项目期间拒绝新讨论发送，历史读取不启动模型。

账本：纯讨论同Work同revision排队运行，队列末尾才结算回review；无变化答案不强制发布。带人工稿的发送复用原续作字节级应用／恢复机器，必须重新发布后才能接受。实际候选与最新冻结tree全量比对，新增／删除／改名／未发布修改均阻止接受；不可核实不视为干净。对话读取真实账本＋`sessionIndex.portableMessages`，按原id／nativeEntryDigest去重，不按正文折叠；同文不同身份回复保留。只显示durable已确认回复，生成中显示活动状态，不伪造流式原文；历史按有界页加载并明确中间未展开区。

发送前冻结原object/token/text/requestKey并按Work保留；丢回执重试只查同一输入，报告换版不重造请求。接受不发送未提交草稿；成功回执仍显示收尾中，直到宿主合入和主控全部完成才ended。人工暂停、未核对效果、权限与恢复门不被聊天解除。

已实测：待办→主工作区HTML报告＋非模态审批窗；原线程纯问答不升报告／不改源文件；运行中第二条输入持久排队且原生Provider回合不重叠；原Worker真实write修改候选并publish新报告；显式换新版后同线程继续问答；收起重开保留草稿；先取消再确认接受；真实合入后的`candidate.txt`字节与发布内容一致；最终ended/complete，正常退出，无Renderer错误。定向修复回归56/56；最终原生身份／Renderer回归31/31。默认套件另行记录，不将重叠用例相加。

运行命令：`npm run build:renderer`；`node tests/desktop-review-discussion-live.mjs`。永久live脚本已注册到`tools/test-suites.mjs`的显式live集合，后端新用例注册integration。首次接线中发现并修复：真实native回复不在state.messages导致缺失、running临时stale被误当历史禁止排队、显式最新入口被在途屏障吞掉；UI验收限定浮窗history而不是隐藏主对话文本。

未验边界：Windows/macOS、真实付费模型自主判断质量、生产profile／用户项目、完整冷启动在途未知效果与跨窗物理多屏矩阵。当前不安装，不开放全局Worker聊天。

最终窄短窗口复测原件包含`approval-390x480.png`，已实际查看，输入与“发送／接受并结束工作”完整可见，无窗外按钮；不同尺寸不丢未发送草稿。原生HTML报告截图和DOM审批窗截图分别取证，不能把DOM screenshot中的原生child-view空白当成未渲染；真实guest已验证正文V1/V2标记及窗口避让边界。

默认回归最终通过：`npm test`的unit 673/673、integration 1734/1734，零失败／取消／跳过；TAP原件在`apps/desktop/.test-output/ci/`。最终注册仅把产生临时bundle的Renderer用例移至integration，default成员不变。未执行live全集合，不声称其他平台／付费Provider已验。

### 第三轮生产修正（2026-11-05，源码未安装）

以上“当前不安装”属于首轮取证阶段；用户后来已授权安装第二轮并本地提交93265f6。本轮另作源码候选：发布序号贯穿当前／历史／人工稿入口，同Work revision内重发不再都标V1；正常字号宽窗左右、800窄窗上下并读，显式自由摆放／收起保持意见。M3只读“保留进展”从既有账本投影原请求、冻结报告／文件、失败补充与未确认事实，不启动Controller／模型，不提供无依据续接。

真实中文人工改稿、返回、确认采用与真实READ_REF_EXPIRED之后的查看／复制／冻结文件打开均已实测。第二轮重复图的展开／返回标签已撤回，第三轮补原生窗口记录和像素差异门；详见[第三轮测试与边界](testing.md#第三轮-u2-01u2-02u2-03-与-m32026-11-05源码候选未安装)。不将此只读进展声明为自动恢复或未知效果修复；本轮未安装、提交、推送或发布。


## 1. 最新决策

此前“任务目录→独立任务详情→并排报告和聊天”的方案不再作为本Demo的目标形态。用户要求统一为标签悬浮系统，包含对话中该Worker block的全部任务上下文。

**同一任务 block，两个呈现状态：主对话中的紧凑块，以及展开后的任务标签悬浮窗。不是新增一个聊天系统，不复制一份任务历史。**

任务查看、主对话block、报告段落标签都可以成为这个悬浮窗的入口，接收者始终是原任务的Worker。当前Demo展示主对话block入口，只含一项合成任务；不冒充已验生产多任务路由。
本轮用户进一步确认：每轮对话由Worker按需调整报告，无需额外发送“更新报告”；悬浮窗底部同时提供“发送”和“接受并结束工作”。外观对齐标签讨论：单一紧凑标题、滚动对话、轻量输入与底部动作，不常驻重复Worker标题、建议按钮或候选控制台。


## 2. 悬浮窗里是什么

默认“完整任务”展示原block，而非空白问答框：

1. 用户原始要求与材料范围。
2. 主控给原Worker的确切交接，署名“主控”，不是“你”。
3. Worker执行记录与后续多轮回复。
4. 正式报告发布事件及对应不可变版本入口。
5. 后续用户问题、补充、修改要求及所引用的旧版本材料。
6. 程序事实：接收、排队、暂停、停止、报告修订、接受决定。
7. 任务结束后的主控收尾记录，仍属于这个block。

“报告与版本”是同一悬浮窗内的内容页；看正文、引用段落后回到完整任务输入。底部输入和“发送／接受并结束工作”在两个内容页共用一份，不另设报告页接受入口。接受绑定当前明确展示的最新版本；历史版不能误接受，确认时再次核验版本和活动状态。停止／暂停收进次级控制。

Demo提供初始要求、主控交接、两步合成执行、V1报告、逐轮问答／补充／修改及结束收尾。报告保存支持V2、V3及之后的多版；每轮核对是否有实际内容变化，无变化就保留当前版，不为凑轮次生成空版本。初始执行步骤与用户后续交互计数分开。

## 3. 保持简洁的窗口行为

- 点击主对话任务block的“展开任务标签”打开非模态悬浮窗，底层工作面仍可见、可操作，不加遮罩。
- 标题只显示任务名与W1，操作为放大／还原、收起；桌面可拖动标题或键盘方向键移动，Home复位，右下角可调整大小。
- 收起后显示轻量任务标签，含状态与报告版本；点击回到同一个窗口、同一份草稿／引用／阅读版本／历史位置。收起不停止执行，不撤回队列。
- Escape收起；确认对话框打开时Escape只取消确认，不收起任务窗。
- 桌面位置限制在视口内，放大后可还原；窄屏保持同一标签窗口和同一状态，填入可用视口，不硬塞桌面尺寸。
- “完整任务／报告与版本”两页切换只改变呈现。选段引用带版本身份，切新版不能改写旧引文。
- 演示场景、重置和脚本说明收进次级入口。刷新重置；显式重置或切场景须确认。

## 4. 三种事实分别维护

| 事实 | 何时变化 | 不得冒充 |
| --- | --- | --- |
| 对话回合 | 用户明确发送，原Worker处理 | 新任务或新正式报告 |
| 工作候选 | 实际内容变化并由宿主核验 | 已发布／已接受成果 |
| 报告版本 | 发布成功，宿主冻结快照 | 自动覆盖旧报告 |

每轮完成后Worker都核对报告：问题暴露解释不足时补充澄清；补充资料纳入适用背景并标注来源；需要改写时直接形成新报告快照。用户不必另行要求发布，有变化才升版；旧版永不覆盖。Demo按公开脚本匹配：确定性／混沌问题加入一次固定澄清，补充原文加入“用户提供、未独立核验”的背景，简洁／精简类要求采用固定简明结论。重复相同内容不产生新版本；超出脚本的修改仅澄清，不声称已执行。支持多轮组合累积，不模拟真实模型推理或文件编辑。

运行中补充持久排队（Demo仅内存）；暂停后续允许当前轮结算但阻止出队；停止当前保留此前效果和剩余队列，明确恢复才继续。撤回只针对尚未处理的排队输入，不伪造已执行回滚。

当前执行、排队、暂停、停止未核对或查看历史报告时不能接受成果。底部按钮明确“接受并结束工作”，旁边说明当前版本／禁用原因；点击后确认确切版本，默认取消。接受不会发送未提交草稿，草稿与引用原样只读保留。结束后不再接收输入、不静默重开原执行。

## 5. 与现有标签系统统一的边界

已核实源码：

- `note-tag.mjs`通过`discussion-thread.mjs`的`mountThreadTranscript/threadRounds`呈现多轮记录，并复用`annotation-composer.mjs`；已有来源定位、折叠与输入体验。
- `app.mjs`的`tagActions.save`先保存`tag.put`再经`__agentSelectionAction(action:discuss)`投递，按project/tag身份保护草稿和唯一回执。
- 当前标签依赖当前文件relPath，等待回复时禁发，文案为“等待前台回复”；`execute`则提交后台任务。这不是原Worker续聊接口。

因此统一的是悬浮窗口、对话记录、材料引用、草稿与交互规范；还需扩展任务范围与投递绑定，不能只给旧组件换标题。

推荐关系：project/Work决定任务身份与原Worker；报告版本/文件摘要/选区决定本条材料来源。段落标签是同一任务block的局部入口，不是另一个Worker，不把整项任务历史塞进一条文件annotation记录。移除某处定位标记不删除任务历史，不结束任务，不取消已接收输入。

完整任务上下文应可读取、可定位、保持归属，但不等于每次把全部历史正文重复塞进模型。生产继续使用原job账本、冻结材料、可分页原件与原生会话；展示完整block不能替代模型上下文交付验证。

## 6. 生产仍需的改动（未实施）

现有`reviewContinue`应用人工审校稿、推进revision并令旧报告stale，且Worker回合统一受最终报告交付约束。此前真实Workspace隔离探针已证明纯回答沿续作路径会被暂停并提示缺报告：`~/.cache/nozeli-worker-discussion-analysis-esGknu/report.json`。

需要新增明确Work绑定的普通交互准入，不全面放开任意target；复用原Worker单通道唯一投递，忙时排队；普通问答不调用续改版本推进，不全局取消初始受托任务的正式交付要求。候选变化、正式发布、人工稿和接受CAS必须在宿主串行边界核验。人工暂停、权限、未知效果和结束收尾各门不能被聊天解除。

## 7. Demo入口与验证

入口：`apps/desktop/demos/worker-review-chat/index.html`。静态托管同目录即可；本机开发预览：`http://127.0.0.1:48765/worker-review-chat/`。现有`agent-status/index.html`已链接此页。

合成内容，无真实模型／项目／凭据读取；不导入生产preload或标签运行时。Demo的悬浮为同一DOM与状态，不复制对话；不代表生产组件复用已完成。正式产品不依赖此开发HTTP服务。

上一版已验证悬浮、收起保留上下文和固定V1→V2流程；这些旧结论不代替本轮逐轮更新与底部双按钮验收。本轮实际验证在下方记录。

本轮Linux Chromium实际操作通过（1440×1000、390×844）：问题补充概念澄清自动形成V2，相同问题不空升版；补充原文形成V3；精简要求直接形成V4，无需发布命令。V4累积保留前几轮澄清、用户来源标识和精简结论，V1正文不变；重复修改与脚本未知输入不虚构新版本。运行／排队／暂停时接受禁用，暂停后当前轮完成为V2且队列保留，恢复后补充处理为V3。处理菜单操作后收起，避免遮挡推进控件。底部双按钮在对话／报告页均可见；接受确认绑定V4，取消不结束，确认后保留未发送草稿且只读，收尾仍在原block。

实际观察浅／深主题及窄屏：390px无横向溢出，底部按钮底边约805px，处于844px视口内；发送后滚动到新消息，回复完成后底部滚动间隙0，能直接看到本轮报告更新入口。浏览器无脚本错误，JavaScript语法检查通过。仍未据此验收真实模型自主判断、文件修改、生产标签组件、多任务与Windows/macOS。
