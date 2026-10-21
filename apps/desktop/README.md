# Nozeli desktop 0.1alpha

Electron桌面阅读、批注、编辑与受管OMP协作产品。平台、构建、Release和许可边界以[仓库README](../../README.md)为准。

## 构建

开发前提：Node 22+、npm、Git、Bun 1.3.14、Linux x64原生编译工具及Electron系统依赖。首次构建：

```sh
npm ci
npm run build:pptist
npm run build:omp
npm run build:renderer
```

`npm ci`为Electron重建node-pty，不使用全局node-gyp或系统OMP。上游构建输入固定版本/哈希，不需要旧仓库或本机绝对路径。依赖、构建、运行profile不进入Git。

## 开发与测试

`npm start`启动本地应用。`npm run test:host`、`npm run test:renderer`、`npm run test:electron`分别运行宿主、渲染逻辑与实际Electron回归。其他分组见package.json。tests/fixtures为合成或带来源说明的固定样本；普通测试不发起付费模型请求。live验收需显式启用和自有账号，不自动执行。

同一 OS 用户只运行一个 Nozeli 应用进程：源码启动、安装版、不同 `NOZELI_CONFIG_ROOT` / `NOZELI_USER_DATA` 与 `NOZELI_TEST_INSTANCE=1` 共用 Electron 原生单实例锁；测试隔离变量只隔离配置，不允许多开。锁身份取 OS 账号家目录（不跟随 HOME、XDG 或自定义 profile），重复启动在配置初始化/迁移前退出 0，将打开文件请求交给已有实例并唤回窗口。同一进程内分屏与原生脱离窗口不受限制；terminal-client、handoff、document IPC helper 仍先行分发，不争用产品锁。正常退出由 Electron 释放锁，崩溃后由其原生机制恢复。

专项真实 Electron 烟测：先正常关闭其他采用新锁的 Nozeli（不要打断正在执行的测试/Agent），在可用桌面会话和 renderer 已构建的条件下运行 `node tests/desktop-singleton.test.mjs`。该脚本加载生产 `main.cjs`，验证 A/B 独立配置且 B 更改 HOME/XDG 后仍退出 0、A 收到文件请求、B 配置未写入、同进程双 BrowserWindow、三类 helper 不抢锁，以及正常退出和崩溃后的重启；不调用模型、不安装、不自动构建。仅清收脚本自己启动的进程，合成测试 profile 留在输出路径供检查。不要并发运行其他产品 Electron 回归；它们会被已有实例接管，而非创建隔离应用。Windows/macOS 仍需在对应平台实际验收。

## 标签讨论

标签按轮保留问题与同一请求下的全部助手正文；流式输出只更新对应消息，不重建卡片、覆盖旧轮或重置正在阅读的滚动和原文分页。持久化仅保存请求/消息身份，正文来自统一会话索引；冷开可按请求查回历史消息。正文超出缓存预算时保留分段读取入口，不静默截断。各文档表面共用此行为。
待定位讨论标签确认移除后立即刷新待定位区，同时过滤内存与持久化的已移除投影，避免旧批注列表残留；刷新后不复活，对话消息、任务与原文件保留。真实安装版点击移除并确认、立即消失、刷新与历史账本不变已通过，证据 `~/.cache/nozeli-smokes/nozeli-orphan-remove-9lpUOJ/`；相关37项回归通过。移除前的确认仍保留，不将“折叠”当作删除。

文档右下角“对话”按钮恢复为当前项目唯一对话面的打开/聚焦入口，重复点击不复制会话。对话顶部“清空前台上下文”必须确认：仅归档并更换 frontdesk 原生线程，不重启或清空 orchestrator/Worker，不删除聊天记录、工作报告、标签引用、文件或 GUI 草稿；前台在途/排队、原生输入、终端租约与未确认工具副作用会拒绝清空。清空后新前台不自动接收旧对话或独立请求，主控投递水位不变，旧日志可通过只读归档查看。129 项行为回归及真实 Electron/私有 OMP 本地 HTTP 的取消、角色隔离、草稿/归档/刷新与下一回合上下文边界通过，证据 `~/.cache/nozeli-smokes/nozeli-frontdesk-clear-66c1ak/`；此项不冒充公网模型推理。
已安装 `conversation-frontdesk-context`，回退保留 `tag-removal-projection-fix`；独立安装二进制的同一真实原生流程通过，证据 `~/.cache/nozeli-smokes/nozeli-frontdesk-clear-EXQQJ4/`。安装切换不改已运行旧窗口的内存代码，若旧版仍在运行，单实例锁只唤回旧窗口，需正常退出重开；不强关用户编辑，也不在日常项目自动执行清空。


标签讨论正文显示用户原问题，解释请求使用简短标题；文件、位置、引文和冻结版本放在默认收起的“选区来源”。模型首次收到自然语言组织的“问题、来源、原文、前后文与注意事项”，不再把schema/内部身份/整包JSON拼入正文。同一原生会话成功处理过且来源未变的续聊只给问题与简短来源；重启、换线程、观察到压缩、材料或备注变化时重新完整提供。每轮完整材料仍按摘要保存为只读原件，续聊显式提示上下文不足时按原件读取，不假定模型一定记住；后台派工始终带完整材料。用户自己输入的JSON或同名标题不被清理。旧日志不改写。

回归：`node --test tests/tag-session-identity.test.mjs tests/tag-input-presentation.test.mjs`；实际Electron消费：`node tests/desktop-tag-history.test.mjs`、`node tests/session-reading.test.mjs`。涵盖三轮、多段回复、流更新、滚动、长回复分页和重载；使用合成会话，不冒充真实Provider回复。

自然语言交付回归：`node --test tests/tag-material-delivery.test.mjs tests/tag-input-presentation.test.mjs`，包含真实Controller分派边界、首次/续聊、版本与会话变化、处理中压缩失效、完整材料读取、区域坐标与截图语义。不会为追求简短省略来源冲突或安全提示。

本轮host91/91、renderer79/79、标签/输入专项44/44、原生Collab70/70通过；可见Wayland完整Electron门（阅读/重启、配置与只读历史、三轮标签）及会话简洁问题/折叠来源消费通过。Word/PPT/图片/PDF实际回归通过。未重新调用真实付费Provider，不能据此声称新模型回复已实测；旧无界面启动超时保留，改用实际可见Wayland入口验证。历史和截图留在忽略的测试输出，不进入产品数据。

## 统一设置与项目文件隐藏

- 左下角“设置”统一管理私有OMP源、前台/主控/Worker默认模型、外观与通用选项。三角色默认模型持久保存成功后联动所有项目同角色的在线Agent：空闲时由原生OMP确认切换，忙碌时待当前回合结束后应用，保存结果分别报告已应用、待应用和脱敏失败信息。休眠/未连接Agent不被唤醒，下次启动或恢复原线程时读取当前默认；清空默认会取消待应用目标而保留原生当前选择。不创建新线程、不重放消息、不改历史回合模型证据，关闭/归档工作保持只读。被默认配置或历史会话引用的源不能直接移除。密钥仅在宿主私有配置保存，不由读取API回传。
- 默认模型页独立读取真实 OMP 目录，不等待登录源列表；加载/读取失败/无源/已有源但无模型分别提示，未就绪时禁止误保存。页面提供“刷新模型列表”和“配置 OMP 源”，按模型名及源显示选择；不把空白隔离配置伪装成已有模型。源增删后须等待旧读取完成再取新目录，保留未提交选择与失败前的原选择。实际可见 Electron 空目录→配置源→可选模型→同线程 A/B 原生请求验证通过（本地脚本响应，非公网推理），证据 `~/.cache/nozeli-smokes/nozeli-defaults-electron-Wq4IGm/`。独立检查窗口使用合成本地源，不共享日常或其他测试实例配置。
- 发现型源的所选模型不在角色离线目录时，使用原生 `refreshProvider(provider,'online-if-uncached')` 获取该源真实目录，再按原有空闲/代次栅栏切换；不伪造模型定义或复制其他会话数据库。真实日常私有配置验证 GPT-6→GPT-6.1 保持前台/主控线程，前台/主控终端均 attached（本次含设置操作首次打开约1.5秒）；正式后台“GPT6.1真实只读验收”主控与Worker回合均completed且effective.model=`paratera/gpt-6.1-sol`，工作进入review并产生正式报告，两份原文件摘要不变。真实远程推理证据在`~/.local/state/nozeli-gpt61-real-2Fo7X7/`；桥/模型回归14项通过。本项不宣称忙态终端附着等待问题已解决。
- 设置导航以虚线和小字分成“通用设置（所有项目共享）”与“当前项目设置”；Agent 额度页内另行标明全局进程与当前项目 Worker 的作用范围。分组仅调整展示，不改变额度保存、项目隔离或默认模型联动规则；实际可见 Electron 已检查分隔样式和无项目禁用状态。
- “Agent 额度”只保留两个限制：当前项目 Worker 数（1–16 个开放 Work，暂停/待审阅/关闭中仍占用）与全局存活 Agent 数（默认8，2–64；前台、主控、Worker及启动预留均计数）。终端不再重复提供额度设置。全局名额在实际启动前原子预留，确认原生 owner 和子进程退出后释放，未知退出仍占用；降低额度不能低于当前占用，已接收输入保留排队而不是误标失败。不活跃项目的安全空闲 Agent 自动休眠，执行中回合、在途工具、原生未发送输入和系统终端租约受保护；普通 GUI 草稿持久保存，使用项目时沿原线程按需恢复，不重放旧输入。额度设置使用当前工作区项目身份，不依赖尚未完成恢复的 Agent 视图。
- 历史额度恢复修正：旧 provider/native-terminal 清收完成后必须返回明确的 `verified` 确认，不能把已退出进程永久留在“退出待确认”。合法的上一系统启动身份已不可能存活，释放其名额且不向当前复用 PID 发信号；本次启动的 PID 身份冲突、损坏记录或未确认清收仍保留占用。Linux 脱敏日常样本 8 条历史记录由修复前占用8恢复为0；真实进程及原生崩溃恢复组合68项通过，可见 Electron 验证无打开项目时历史占用为0、设置32并回读磁盘成功（`~/.cache/nozeli-smokes/nozeli-quota-ui-LK8VWz/`）。不删除原会话、任务或草稿，不把独立测试与认证 broker 当作会话 Agent 计数。
- 账号登录先从随包OMP的`auth-broker list --json`目录选择源，再显式启动`omp login <provider>`；不手填Provider ID、不先开启数字选择器。宿主重新校验所选源，未知/空源不启动登录进程。界面显示当前源及授权状态，验证码/回调输入和取消沿用官方流程；自定义API源保持单独入口。真实列表及选择启用已实测，完整远程OAuth授权需用户本人完成，不冒称已验。
- 界面主题支持浅色/深色/跟随系统；界面字体与12–20px字号不改变正文、对话、标签和终端独立排版。Zen快捷键为Ctrl/Cmd+Shift+F11，Escape优先关闭对话框再退出Zen。
- “终端”按钮位于“当前项目设置”分组内、Agent 额度上方；打开项目后显示，点击直接切换，不建立重复入口。“Zen专注模式”保留设置导航顶部。终端顶部可直接“返回阅读”，切换不取消任务、不清空草稿。窄屏文件栏开关置于左侧中部，避免遮住设置。
- 文件树右键“隐藏”只隐藏当前项目的显示，不删除文件、不修改.gitignore、不取消已打开编辑，也不阻止Agent访问。“…”→“显示已隐藏”可查看并恢复隐藏项。隐藏与查看偏好按项目持久化，大目录在遍历和可见数量预算前排除。
- 检查入口：`node --test tests/provider-settings.test.mjs tests/file-tree-ops.test.mjs`；可见Electron为`tests/desktop-settings.test.mjs`和`tests/desktop-tree-visibility.test.mjs`。真实OAuth和其他平台不据此视为通过。
- 资源/模型联动 Linux 限定验证：153 项组合行为回归通过；后续 GUI 回合实际模型持久化及工作区身份修正的 62 项回归通过（集合有重叠，不累加）。真实私有 OMP＋本地 HTTP 通过跨项目休眠/原非空线程恢复、原生草稿保护、宿主 SIGKILL 冷恢复零请求重放、三分钟在途回合保护及完成后休眠；模型 A→B 保持 PID/线程与未发送输入，HTTP 和不可变回合实际模型分别 A/B，运行中新增 Provider 及 stop/resume 同样通过。实际可见 Wayland Electron 保存模型联动、29 项设置流程及 A/B 项目额度独立保存通过。只用合成凭据和本地模型响应，未验证公网推理、OAuth、Windows/macOS；长时项验证的是在途所有权保护，不是模型计算性能。
- 经本轮用户授权，已安装 `agent-resources-model-linkage`，回退为 `provider-login-picker`。实际独立安装二进制在可见 Wayland、隔离配置下完成保存默认模型、在途 A 保护及下一回合 B、同线程与未发送草稿/原件保留，证据 `~/.cache/nozeli-smokes/nozeli-defaults-electron-EopOME/`。未强关日常旧窗口，需正常退出重开加载新版。

外观偏好通过宿主`appearance.json`原子保存，不依赖每次启动可能变化的本地HTTP origin；实际安装版完整退出/重开验证主题和项目隐藏均保留，隐藏原文件字节不变。“显示已隐藏”与恢复可实际点击。Linux/Wayland验收，未调用真实模型或OAuth。

Linux原生Wayland的项目/引用目录框使用不绑定父窗口的Electron重载，避免父窗口xdg-foreign导出阻塞；X11/Windows/macOS保留父窗口关联。已在未设置`NOZELI_TEST_PICK`的真实原生选择中打开`nozeli_git`项目；系统选择动作非自动化，取消路径未取得独立原生UI签收，不以预设路径测试冒充。24项设置检查、双尺寸终端进入/返回、Zen按钮/快捷键、8px底部与草稿保留通过；旧沉浸套件仍在字号菜单等待失败，不作全套通过声明。

选区工具条不因编辑器内部input/textarea的原生滚动而关闭；正文视口滚动、Esc、文件/布局切换仍收起。真实Monaco左键拖选→内部输入滚动→讨论点击保留精确offset/quote回归通过；安装候选真实拖选→“解释”点击→私有OMP回复、单job、原文不变通过（本机`~/.local/state/nozeli-selection-live-1nPD2S/`）。Markdown Unicode选区及完整进程重启回归通过。两次解释烟测在未形成选区前失败，原件保留，不计模型成功或修改产品以放宽空选区。

## 单内容分区与项目原生窗口

已移植开发提交 `70f0243` 的产品源码与回归，保留本仓库既有Provider登录、默认模型联动、Agent额度和可读选区材料；两仓库没有共同提交祖先，采用产品路径三方补丁集成，不导入旧开发仓库历史、CCB或计划树。测试Office/PDF材料使用本仓库`tests/fixtures`，不依赖旧仓库路径。

- 每个分区只呈现一个文件或对话。左侧已打开是平铺记录，点击切换，右键向右/向下分屏或在真实系统独立窗口打开；未呈现记录不挂载后台编辑器。当前已呈现文件分屏使用只读阅读副本，共享未保存内容但保留各自选区与阅读位置；项目主对话不复制。
- 独立窗口保留同一活WebContentsView；标题可返回工作区。切到B保存后隐藏A浮窗，切回A恢复同窗/内容/尺寸且不主动抢焦点；主动关闭不会复活。关闭最后一个可见项目窗口也保护其他隐藏项目内容；主窗关闭时可见副窗仍可编辑，最后一窗退出。Wayland精确桌面坐标受合成器影响，未保证像素级原位置恢复。
- 命名布局保存/重命名/载入/删除保留。载入前保存当前缓冲与导航，保留后来打开的资源与当前选区，不拿保存时的旧视图覆盖当前内容。旧多文件叶只迁移原active呈现，其余记录仍保留。
- 工作区控件收敛为两层：仅导航主窗口创建全局“工作区／布局与窗口”；独立窗口不创建第二份全局菜单。文档只由分区标题栏显示一次文件名、关闭和独立/返回窗口，正文不再显示重复的文件工具栏。分区“工具”聚焦对应原生活内容面并复用既有文档菜单，保留编辑、字号、对比、PDF页码/缩放、TeX与Office专属操作；页码改为可见且校验范围的弹窗。对话只保留原对话标题栏和前台清空，更多菜单仅提供该内容关闭/脱离/返回，不重复全局布局预设。52项行为回归、5项真实控件流程、9项冷恢复生命周期、6项驱动、10项分屏与前台独立清空烟测通过，证据在`~/.cache/nozeli-smokes/nozeli-workspace-chrome-OWnaNi/`及同次运行目录；不据此声称其他平台或TeX编译通过。
- 已安装 `workspace-flat-controls`，回退 `conversation-frontdesk-context`；独立安装包6项真实控件流程通过（含PPT真实iframe区域框选），证据 `~/.cache/nozeli-smokes/nozeli-workspace-chrome-jQuul0/`。日常新版已打开，主导航仅1个全局布局菜单，对话内容面0个全局菜单/重复文件栏；不在重开时自动清除用户前台上下文。
- 系统装饰层进一步合并：主窗只显示 Nozeli 标识、当前项目名和同一行布局/系统窗口控制，下方每个文件仅一条分区栏；悬浮窗采用无系统叠层的单条文件栏，统一Nozeli图标并合入工具、返回和窗口控制，不再有选择项目/系统菜单/工作区重复层。窗口最小化、最大化还原、关闭均调用所属原生窗口，拖动区域不拦截按钮。已安装 `window-single-row-brand`，回退 `workspace-flat-controls`；实际安装包6项控件、源码10项分屏/9项生命周期和16项权限回归通过，证据 `~/.cache/nozeli-smokes/nozeli-workspace-chrome-rBtqTA/`。Linux/Wayland限定，其他平台原生装饰与拖动未验。
- 左侧“已打开”不列出对话，原对话入口与会话保持不变；列表下方用分隔线和间距区分项目文件树。候选安装包 `navigator-opened-separator` 的真实 Electron 流程通过，含对话入口可用及对话不出现在已打开列表；视觉证据 `~/.cache/nozeli-smokes/nozeli-workspace-chrome-0BTXJo/opened-project-separator.png`。
- 独立窗口改为仅顶部文件名／对话名，移除品牌、工具、返回及系统控制按钮；标题右键提供内容工具、返回、最小化、最大化/还原、关闭，正文右键与编辑/发送保留。标题指针拖动支持目标中央附着和边缘分屏预览，Esc取消；移除32个浮窗数量上限（总布局安全容量保留）。Linux/Wayland真实两窗同时可见、右键工具/返回及拖回同一编辑器/选区/undo通过：`~/.cache/nozeli-smokes/nozeli-workspace-chrome-eIVmiD/`；对话同composer/草稿/历史零重放10项、冷恢复生命周期9项及27项布局/权限回归通过，其中40个浮窗序列化/回停为domain验证，非40个真实系统窗口压力验收。源码未安装；其他平台与物理多屏拖放未验。
- 对话入口仅主导航顶栏右侧一份，固定在布局菜单与窗口控制之间；文档内容面和独立根窗不再显示重复浮动入口。真实Electron验证切换文件与悬浮/附着后位置不变、非主窗零入口且主窗点击仍进入原项目对话，通过证据 `~/.cache/nozeli-smokes/nozeli-workspace-chrome-lqfLGO/`；源码未安装。
- 移除顶栏“布局与窗口”和主窗文件栏“工具”折叠按钮。常用工具按文件类型直接展开，窄分区换行不折叠；查找、阅读/编辑、字号、PDF翻页/缩放、Word适应/缩放/框选、PPT框选、TeX编译/预览复用原命令与能力检查。低频文档操作、分屏、命名布局保存/载入/重命名/删除在文件标题右键，独立窗仍仅标题。Linux真实字号按钮、PDF缩放及PPT iframe框选通过 `~/.cache/nozeli-smokes/nozeli-workspace-chrome-qf87YI/`；命名布局持久化管理及6项真实格式驱动通过（后者 `~/.cache/nozeli-smokes/nozeli-native-drivers-U1ojaz/`）。源码未安装，TeX编译及其他平台未验。
- 对话标题精简为名称、独立窗口、关闭；字号/历史折叠/清空移入原右键，不再堆叠标题按钮。“关闭”调用关闭呈现分区而非删除view，唯一对话入口收起到底部，再点击恢复原对话身份。真实Linux流程通过 `~/.cache/nozeli-smokes/nozeli-workspace-chrome-hdmN9N/`；直接脱离、返回与项目切换保持composer、未发草稿及历史且零重放通过 `~/.cache/nozeli-smokes/nozeli-single-content-pVU3Cn/`。源码未安装；截图中的旧会话恢复错误不属于本次UI变更修复范围。
- 删除会话中的“阅读 · 项目术语”手动配置、术语保存/读取与首次出现高亮及专属样式；不替换为另一套手工设置，不再消费旧浏览器术语偏好。保留Markdown选区/IME安全渲染和冻结材料展开。renderer构建及可见Electron `tests/session-reading.test.mjs`通过；源码未安装。
- 用户授权后已提交界面调整 `ae63320`，安装 `workspace-ui-ae63320`，保留 `window-single-row-brand` 回退。实际安装二进制6组界面流程通过，证据 `~/.cache/nozeli-smokes/nozeli-workspace-chrome-3RtWu1/`；包含直接常用工具、真实浮窗/拖回、对话减号收起到底部及原身份恢复。安装包按现有本地打包工具取工作树快照，包含未提交的既有其他改动，不宣称纯净commit可复现包；其他改动未纳入本次界面提交。
- 修复OMP零活动恢复误把同角色其他旧线程的已完成任务算作当前线程活动：只允许durable zeroActivity且无当前/归属未知已执行任务时恢复缺失空会话，不重放旧输入。旧线程/同线程/未知归属三种回归通过；恢复组合40/41通过，另一个旧provider进程身份夹具报`provider process identity invalid`，未算通过。真实安装恢复另行验收。
- 本仓库Linux/Wayland实际验证：原生核心10项、冷启动生命周期9项、Word/Markdown/TeX源码/PDF真实驱动6项、Word/Sheet镜像2组及命名布局管理通过；布局/宿主/目录导航监听44项通过。证据为忽略目录`.test-output/nozeli-single-content-MRZQP9/`、`nozeli-native-lifecycle-89uhl3/`、`nozeli-native-drivers-zpYrna/`、`nozeli-office-mirrors-lcOXsp/`。已重建固定版本PPTist和renderer；TeX源码转移不等于编译验收。
- 合并保留功能专项35项中34通过；`agent-process-budget.test.mjs`的“cap two dispatch cycle…”在所有jobs完成断言失败。本次未改该测试及其Controller/额度实现，不把它算作通过或修改断言掩盖。首次44项测试有14项因`/tmp`写入quota错误`-122`失败，改为本仓库忽略目录的磁盘TMPDIR后44项通过；未清理或覆盖用户临时数据。
- 目标设置可见Wayland29项通过（`.test-output/nozeli-settings-ui-lxFSpX/`），无远程认证或模型请求。默认headless启动未产生renderer，90秒等待失败保留（`nozeli-settings-ui-ULFv8U/`），不把headless失败当作可见桌面设置失败，也不宣称headless已支持。
- `d65d2be` 后续集成深测：95项布局/文件监听/Agent额度与设置行为回归通过，真实可见Wayland的跨profile单实例、核心分屏10项、冷开生命周期9项、真实仓库导航/快捷键/resize、Word/Markdown/TeX源码/PDF驱动6项及Word/Sheet未保存模型镜像2组通过。修复新项目Agent启用分支遗漏与启动完成未发布最终状态导致对话面不可用；只有导航宿主创建Agent，对话内容面订阅并回读就绪。模型联动真实验收迁移到唯一conversation surface，不再操作shell隐藏composer。之前cap2失败保留为历史记录；本轮真实测试通过情况单独列账，不覆写旧证据。测试目录精简保留104608个非删除文件并校验65414份证据哈希不变，清单在`~/.local/state/nozeli-storage-prune-zUOyHe/`。

本轮已在 `d65d2be` 上提交集成修正 `01f1408` 并安装 `workspace-singleton-01f1408`，回退保留 `quota-recovery-0faaac1`。实际安装二进制通过核心分屏10项、冷恢复/主窗关闭继续编辑9项、Word/Markdown/TeX源码/PDF驱动6项、Word/Sheet未保存镜像2组、命名布局管理，以及新对话面真实私有OMP本地HTTP模型A→B同线程与草稿保留；跨profile二次启动退出0且不写第二配置通过。证据位于 `~/.cache/nozeli-smokes/` 的 `nozeli-single-content-FQCKHo`、`nozeli-native-lifecycle-OaaelG`、`nozeli-native-drivers-QK49lO`、`nozeli-office-mirrors-9pBRzz`、`nozeli-defaults-electron-UIKmze`、`nozeli-installed-singleton-fLZpIx`。源码修正后的76项回归、设置29项和项目额度隔离也通过，集合重叠不累加。未推送、未调用付费模型；Windows/macOS、物理多屏/DPI、全部IME、TeX编译及完整付费AI跨窗工作流未重新验收。先前fixture路径和旧surface/跨项目IPC测试失败保留，不作平台失败或放宽安全校验。

## 当前安装的真实 Agent 工作流验收

2026-10-20，`settings-hidden-restart-fixed`实际Electron与私有OMP/GPT6.1完整66项通过：前台真实CAS保存与选区解释、主控派工、两个独立Worker工作树、GUI/原生终端原线程续作、冻结Diff、接受/丢弃、冷开零请求/零任务重放；真实180秒计时文件任务、renderer/native/main进程终止及显式原线程恢复均检查。原始项目暂存/未暂存文件、草稿、配置元数据保持，正常退出，自有账号副本清理。50次真实HTTP准入，观察input/output115754（非账单）。本机证据`~/.local/state/nozeli-agent-workflow-settings-b/result.json`；Linux/Wayland单轮，不外推其他Provider/OAuth/跨平台。

首轮A前台两条真实调用成功，但后台输入前焦点落入设置登录输入框而超时，整轮保留fail；没有证明生产派工失败或确定其触发根因。验收脚本增加输入前真实composer焦点与输入后精确文本断言，未改变生产代码或弱化任务结果检查；全新工程B完整通过。原始A证据保留，不自动重放原输入。

## 打包

在干净Git工作区、构建输入准备完毕后：

```sh
node tools/package-portable.mjs /absolute/new/output
```

生成Linux x64便携包、源码归档、说明和SHA-256。不修改current安装。`tools/install-local.mjs`为Linux本机用户级安装工具，`tools/release-retention.mjs --dry-run`预览旧版本保留策略；当前/回退/运行中版本受保护。

## 数据安全与可选能力

应用配置/会话位于`~/.Nozeli`，批注/版本事实位于各项目`.nozeli`。保存使用摘要校验与原子替换；冲突保留原件与草稿，不静默覆盖。普通文档保存不自动提交用户Git；仅显式接受Worker结果触发集成。

只保存本地备注不启动模型。AI需要账号、网络和可用bubblewrap隔离；缺失时拒绝受管启动，不影响基础阅读。TeX/TexLab/SyncTeX为外部可选工具，JS/TS语言服务需要系统Node。构建成功不代替跨平台或模型验收，不代表公开再分发许可已完成。
