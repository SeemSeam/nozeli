# 正式任务工作区设计

状态：2026-11-08实现已落盘，通过Linux源码及实际安装程序限定验收；用户随后授权安装与本地commit，未推送／发布。证据及未测边界见文末。

## 时间线与任务身份

任务卡是整项请求的紧凑导航，不是另一份报告。默认宽 232px、信息槽总高 208px，单卡在原对话宽度中居中；只居中任务卡，不改变用户消息和讨论对齐。原始提交和后续修改输入继续按各自 sequence 出现在对话中。后台长正文、工具、推理、冻结文件清单与收尾正文不再铺在卡外。

卡按原始 intake lineage（缺失时才用 Work ID）绑定，名称、修订、更新时间不参与身份。后续派工和修订持续更新原卡，不按更新时间重排。历史页只投影页内存在的任务，不伪造未加载的卡；若原卡不在当前对话页，显式定位会说明情况，不静默切页或创建会话。

六色 sage / blue / violet / teal / rose / sand 由 `src/domain/task-identity.mjs` 统一确定。卡、过程头、右侧追踪与有关联 Work 的待办使用相同身份色，原左侧项目图标不变。角色色只用于过程内区分，身份色不替代状态、告警或焦点。

## 状态和过程流

状态复用 `managedWorkRecords` 的宿主投影；当前动作取原生 turn 状态或宿主事件，不摘模型回复当进度。结果待审、已接受但技术收尾未完成、结束、暂停和故障保持区分。

流程固定表达请求 → 主控 → 执行 → 成果 → 审阅，不表示模型估计百分比。前向动效只在真实当前 job 运行且 turn 属于思考、输出或工具执行时发生。排队、交互等待、未知、暂停、待审和结束不流动。回流依据 `routing.action=continue` 或实际 `context.reviewContinuation`，新回流事件只播一轮，首次打开历史不补播。窗口隐藏和系统减少动态效果设置停动。卡只保留最近两项已发布修订轨迹；完整记录通过过程分页查阅，修订号不冒充报告发布序号。

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
