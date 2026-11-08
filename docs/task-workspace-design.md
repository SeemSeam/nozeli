# 正式任务工作区设计

状态：2026-11-08任务内含输入／续聊与自适应宽框已实现，源码及实际安装程序限定验收通过；用户授权commit、安装、重启、测试，功能提交为 `9c28387`，本机 `task-contained-20261108-local-01` 已正常重启。未推送／发布。

2026-11-08用户截图明确否定当前任务卡视觉，要求Reviewer优化。此次重设计仅调整卡内信息层级与视觉，不把此前功能/安装验收当成美观签收；暂不安装或提交新视觉。

视觉合同：任务保持原输入位置、原身份及框内原文/续聊；用紧凑标题和唯一状态作为入口，删除重复状态说明、横铺五阶段流程与无实际信息的“原任务持续更新”。发布修订/回流仅在有信息价值时轻量展示。任务对话融入同一中性阅读面，不再套饱和大气泡；成果为可识别的主要阅读入口，过程为次级小入口，取消页底等宽大按钮。错误、暂停、排队、执行、待审及结束仍可区别；不靠截断原文、隐藏补充或改变字号来伪造紧凑。

窄窗允许标题与状态自然换行，长文件名/原文不溢出；浅深主题与200%缩放保持正文、状态、链接、焦点可读。所有修改需真实Electron截图及Reviewer复核，不改变发送、任务生命周期、报告选择、只读过程或草稿持久化。

## 时间线与任务身份

任务框包含同一任务的原始用户输入、后续补充、任务内问答与讨论，不再将这些消息作为主时间线的独立气泡重复显示。主时间线的普通消息只保留前台对话；工具、推理、冻结文件及完整执行历史仍由该任务的只读过程入口按需读取。框体随对话窗格自适应，宽窗采用更宽的阅读上限，窄窗不溢出；取消232×208固定槽位，高度随内容自然增长。复用原消息正文、引用、复制与冻结材料，不新增独立发送链。

框按原始intake lineage（缺失时才用Work ID）绑定，名称、修订、更新时间不参与身份。原输入位置决定任务框在主时间线中的顺序，后续输入与讨论按原sequence排列在框内，不将任务整体挪到对话末尾；仍保留原时间与消息身份。归属只用确切taskRequestId、job／Work／intake关联，不按文本或临近位置猜；无法确认归属的原始诊断保持明确未关联，不冒充某任务的对话。历史页只投影本页记录，页外原输入和完整记录沿“查看过程”读取，不从当前job.text重造旧输入。

六色 sage / blue / violet / teal / rose / sand 由 `src/domain/task-identity.mjs` 统一确定。卡、过程头、右侧追踪与有关联 Work 的待办使用相同身份色，原左侧项目图标不变。角色色只用于过程内区分，身份色不替代状态、告警或焦点。

## 状态和过程流

状态复用 `managedWorkRecords` 的宿主投影；当前动作取原生 turn 状态或宿主事件，不摘模型回复当进度。结果待审、已接受但技术收尾未完成、结束、暂停和故障保持区分。

默认卡不再绘制五阶段流程或方向/回流动画，以唯一完整宿主状态表达当前阶段；真实运行动作及不同的暂停/故障/技术收尾说明按需保留。回流依据仍为`routing.action=continue`或实际`context.reviewContinuation`，与后续已发布修订合成一条轻量上下文；首轮发布不额外重复“已发布”。完整过程仍经原有分页入口读取，修订号不冒充报告发布序号。身份色仅为细边线，不承担状态含义。

## 对话工作区分屏与原生边界

conversation surface 与 shell 是不同 WebContentsView。任务卡与右侧工作行的过程／概览点击经过 `workspace.control` 的严格项目和来源校验，打开固定 `kind=task-process`、`readOnly=true` 的原生内容面，并在对话工作区分屏；同一精确 taskScope 复用已有内容面，不占右栏。右侧暖待办与工作追踪始终保留。窄窗使用现有内容面聚焦，不新建侧栏抽屉。

bootstrap 的 `viewState.taskScope` 固定 workId/sourceJobId，renderer 不能改 project 或 scope；`taskMode` 只在过程／概览间切换。不同查询范围是独立内容面；请求后来派工不会暗改旧面 scope，用户可从原任务卡明确打开新 Work 范围。标题为“任务过程 · 名称”，分屏、关闭、独立窗口与返回主工作区复用现有菜单。关闭不停止后台任务、不销毁原对话 DOM 或草稿。

`task-workspace` 的 process / overview / locate 与显式 inspect 路由由宿主校验；locate 只定位已有 conversation，不创建会话。概览的详情、成果、保留进展、版本和请求控制按钮仅在用户点击时经 inspect + section 枚举转发 shell 原受控入口；只读面没有 managed 写权限。成果仍使用原精确报告入口，不另造报告阅读栈。打开过程不调用 attention.presented、不清除未读、不 mountAgent、不 connect、不挂 composer。

## 只读过程和阅读稳定性

过程直接调用 scoped `timeline.page`，每页最多 100 条；独立保存宿主 frame，不复用主 chat store，也不自行重造 cursor。`nextCursor` 原样回传，避免 scoped cursor 被裁剪逻辑改成无 scope 的 before 字符串。原文的长正文、tool、reasoning 和 native 字段继续使用原有只读字段分页器。

历史正文只渲染该 frame 的持久记录，不使用 live Work 状态制造未来收尾。冻结成果只接受页内 objectId 或准确来源 jobId/sourceJobId 绑定，不能仅凭 Work + revision 混入后来发布的成果。当前状态单独放在过程头，不伪装成历史事件。

最新页在真实宿主 timeline 更新时有界重读 scoped frame，复用同一原生记录 DOM，不改变父 chat 的滚动位置。用户滚动、点开原文、IME 组合或选择文字时暂停自动替换，旧 cursor 页始终冻结；“读取最新”显式回到可更新的最新页。每个固定 scope 内容面仅缓存过程／概览两个页面及有界 100 条 frame，保留展开、原文字段分页与各自滚动；阅读 cursor/scroll 写入原 viewState，重新打开按宿主范围恢复。迟到响应在内容面销毁后失效，不自动把 source scope 改绑 Work。

任务内容面仅保留一个纵向阅读滚动容器；工具、原文与代码块不再设置纵向限高，代码仍保留横向滚动及显式自动换行，长原文继续按字段分页。正文沿用项目 conversation 字号，不继承工具 chrome 小字号。初始化失败设置 `window.__nozeliInitError` 并上报 contentFailed，不以 ready-success 掩盖错误。

## 待办与追踪布局

默认两区按 50/50 分配可用高度；单方内容少时让出真实空余，不通过隐藏关键任务腾位置。短窗或两区最低内容高度超过可用空间时，整个侧栏滚动。待办采用暖底，工作追踪中性底。边界收展位于垂直中点并与左侧一致；右栏不展示消息数字、未读点或新消息提示。任务过程不再改变两区可见性或高度分配。

## 集中验收范围

renderer构建与797项默认unit通过；13项限定历史／固定scope／只读分屏／大原件导出回归通过。独立React/Electron消费者验证原文、旧页不混未来成果、scope游标、选区／IME延迟、宿主模式互切及过程DOM保留；该组件证据不冒称实际任务执行。

真实Electron＋私有Pi＋回环确定性模型＋真实Git／文件：`/tmp/nozeli-task-workspace-q4xrmr/report.json` 通过两个分时task、中间普通讨论、同Work原Worker问答／修改／第二次发布、原卡DOM与居中槽位／身份色／草稿保留，独立原生分屏复用、只读发送拒绝、原窗格关闭、完整工具原文读至第1799条、正常退出及冷恢复零重放。浅深主题、320／390／1280、系统减少动态与真实200%缩放已观察。右栏100项真实持久状态验收：`/tmp/nozeli-project-attention-Zm7Aww/report.json`，饱和均分、滚动／字体变化后的自然尺寸稳定、短窗整体滚动、箭头中点对齐及零右栏提示通过，业务数据不变。内置reviewer完成最终代码和截图复审accept。

实际安装：用户授权后激活 `task-workspace-20261108-local-01`，previous保留 `2026-11-08T01-38-35-481Z`。786个src/dist文件与已验输入逐字节相同，清单 `/tmp/nozeli-task-install-zwsKxQ/input-manifest.json`。实际安装ELF＋包内Pi／Git在独立合成项目／profile重走上述双任务、多轮、长原文、分屏只读／复用／关闭、草稿、正常退出与冷恢复、主题和窄窗缩放，`/tmp/nozeli-task-workspace-JivxfM/report.json` ok=true、providerErrors=[]；原生过程与对话截图已查看。未强退旧日常进程或操作日常项目，不需清空项目。

边界：仅Linux；Windows/macOS、系统IME候选窗、真实付费模型推理质量未验。工作区原生面截图按shell／conversation／task-process分别获取，未拼接冒充OS全窗合成。完整原件导出回归使用实际大文件及可信保存路径夹具，不代表本轮操作过真实用户导出对话框。安装是累积工作树本地快照；本轮commit仅覆盖任务工作区，不把其他在途变更一并提交。

## 追加验收：任务内对话与自适应宽框

2026-11-08：`session-store`、`session-execution-presentation`、`task-workspace-presentation` 三个定向文件共51项通过，renderer构建通过。最终真实Electron＋私有Pi＋回环确定性HTTP＋真实Git／文件 `/tmp/nozeli-task-workspace-HCp6is/report.json` ok=true、providerErrors=[]：两个分时task中穿插普通前台讨论；原输入、原Worker问题／解释、第二次修改各只出现在确切任务框内，原框DOM／身份色／位置和草稿保留，任务B不接收A的讨论；原只读过程、精确报告、长工具原文、正常退出和冷恢复零重放保留。过程／对话截图已逐面查看，不冒称OS合成全窗截图。

最终React/Electron消费者 `/tmp/nozeli-session-consumer-XgoGAn` 通过框内输入／问答顺序、普通前台消息留在框外、初始和补充内部交接均不冒充用户再发一遍、框内引用保留原文，以及1200／480／320下任务宽度随可用空间真实增长且不溢出；浅深截图已查看。消费者同时通过有界原文读取、历史页不混未来成果、IME／选区／阅读位置保持；组件窗口宽度证据不替代真实CLI或跨平台验收。未新增发送链、未重放旧输入、未改旧消息正文或持久业务状态。本次未安装、未提交，Windows/macOS与系统IME候选窗仍未验。

## 用户授权安装与正常重启

功能提交 `9c28387`（12文件）仅覆盖本次任务框改动，共享文档按内容限定暂存，其他在途变更未提交。安装current=`task-contained-20261108-local-01`，previous=`task-workspace-20261108-local-01`；786项src/dist（432源码＋354构建）与已验输入逐字节一致，安装仍为累积工作树本地快照，不冒称纯净提交构建。

实际安装ELF＋包内Pi／Git在独立profile、合成项目及回环确定性HTTP完成双task、多轮问答／续改、框内各一次呈现、原框身份／草稿、只读过程、长原文、正常退出／冷恢复，`/tmp/nozeli-task-workspace-nFjRUN/report.json` ok=true、providerErrors=[]，截图已查看。未在日常项目派发模型任务。

日常程序经X11正常关闭协议退出旧PID1320393，使用原系统入口、原profile重开；验收进程1788993确认原会话view复用、4个本页任务框均宽760px且在窗格内、零框外后台输入、无初始化错误。随后再次正常退出验收进程，移除临时调试参数，最终PID1899563运行本次安装ELF，`NOZELI_DESKTOP_READY ... debugPort=none`，正常系统窗口和原项目目录入口已确认，程序保持打开。

两个日常项目的job／Work身份与消息缓存保持不变，5个原文件摘要不变。核验时原243条项目记录中242条逐字节不变，唯一重写为 `managed_settings/collectionOrder`，五类主要业务顺序与重启前缓存一致；另新增一条正常 `host-opened` 审计，不冒称所有元数据零写入。证据 `/tmp/nozeli-contained-install-HdAA4R/delivery.json`、`daily-preservation.json` 和 `input-manifest.json`；真实窗口截图保留本地，未加入仓库。系统IME、Windows/macOS、付费模型质量及此前旧590px缩放脚本限制不因此签收。

## 任务卡视觉收敛与Reviewer复核（2026-11-08源码，未安装）

用户截图反馈优先于此前视觉验收：删除默认横铺五阶段流程、重复待审描述、无信息的持续更新及内部饱和消息底色。标题和唯一完整状态同一可换行头，真实运行/受阻/收尾详情保留；正文同一中性阅读面，首轮发布不重复修订轨迹；成果主按钮与过程次入口按内容宽度展示。普通前台消息、过程正文、TaskConversation筛选/排序、Message身份及原生路由未改。

真实源码Electron/Pi/Git合成项目`/tmp/nozeli-task-workspace-R8lzvd/report.json`通过双任务、前台普通讨论、同Worker问答/续改/二次发布、原卡DOM/草稿、精确成果入口、只读过程复用、长工具正文、正常关闭冷开零重放及浅深320/390/1280矩阵。组件React/Electron消费者`/tmp/nozeli-session-consumer-VAjdnT`通过框内消息去重/顺序/引用及宽窄布局；额外320px长排队暂停标签+展开引用复制菜单截图可见且未裁切。

独立Reviewer完成源码及最终浅深/宽窄/菜单截图复核，无具体阻断，最终correct（0.92）；不代表用户美观签收。追加真实旅程`/tmp/nozeli-task-workspace-4tokfe/report.json`再次通过；完整应用200%仍因composer占满窗口而未提供可见卡片证据，明确不计为完整应用缩放可用性通过。另以实际Electron消费者`webContents.setZoomFactor(2)`核对卡片标题/完整长状态/三条消息/焦点/成果与过程按钮，`/tmp/nozeli-session-consumer-RtRwAb/task-queued-real-zoom200.png`已由Reviewer查看通过；组件证据不替代完整应用窗口分配验收。未安装/提交本次视觉，Windows/macOS、OS级IME及付费模型质量未验。

## 任务卡视觉用户授权提交与安装（2026-11-08）

用户随后明确授权commit并安装：功能提交`c295496`（7文件），current=`2026-11-08T10-14-53-685Z`，previous=`2026-11-08T08-52-12-275Z`。803份src/dist/Pi-src与已验工作树输入SHA256一致，清单`/tmp/nozeli-task-card-install-zzTK8q/manifest.json`。这是累积工作树本地安装，不冒称纯净提交构建；其他在途改动未随功能提交混入。

实际安装ELF＋包内Pi/Git在隔离profile/合成项目重走双任务、多轮问答/续改/二次发布、精确成果与只读过程、原卡/草稿/长工具原文、浅深320/390/1280与正常退出冷开零重放，`/tmp/nozeli-task-workspace-cpUZ2m/report.json` ok=true、providerErrors=[]；安装版卡片截图已查看。此运行报告的scope仍为旧源码文案，真实ELF调用由父进程命令与交付收据绑定，后续脚本已修正按binary记录来源，未改写原报告。200%完整应用占屏限制保持，不冒称已解决。

未强关/重启用户日常窗口、未修改日常项目；正常退出重开系统入口即可加载新视觉。未推送或发布，Windows/macOS/系统IME/付费模型质量未验。

