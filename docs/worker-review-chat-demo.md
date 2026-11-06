# 报告审核与原工作讨论：当前接入及历史 Demo

Date: 2026-11-06
Status: 共用局部窗口源码已实施并完成 Linux 限定实测；未安装、提交或发布。用户日常程序的拖动反馈不能据此视为已签收，下方旧源码／Demo 证据仍保留原边界。

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
