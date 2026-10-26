# Nozeli desktop 0.1alpha

Electron桌面阅读、批注、编辑与受管OMP协作产品。平台、构建、Release和许可边界以[仓库README](../../README.md)为准。

## 新项目存储（2026-10-24，冻结候选待审核）

项目内容在`.nozeli/project.sqlite`与`objects/sha256`，运行时Plan Tree为`.nozeli/memory/plantree/index.md`；本机catalog/UI/执行及独立恢复位于`userData/nozeli/storage-v2`。SQLite记录按collection/id逐实体事务保存、版本CAS，非整个Controller状态JSON；对象引用按manifest及摘要校验。开发`docs/plantree`不移动或忽略。未知/旧测试格式明确拒绝，不自动导入或覆盖。

新建项目自动补齐Git，已有仓保留HEAD/index/dirty，新仓稳定句柄取原字节、禁用hook并创建一次基线；`.nozeli`规则受管追加。新位置自动fork项目/instance身份，保留不可变历史来源，不继承进程、信任和写回队列。catalog同时核验原根和元数据目录实体；仅同UUID不授予写权限。

源根或`.nozeli`失联后停止新源操作，关闭只要求本机恢复落盘；本机恢复中心可在无项目页导出完整文本/Office模型/图文稿。关闭、移除入口、清理本机、OS回收站删除为不同动作；破坏性动作有准确范围确认、owner停稳及持久操作收据，不降级永久删除。SQLite deadline先隔离退出旧worker再报结果未知，独立恢复库可用，显式重试核验receipt/目录后才建新代际，不自动重发请求。

冻结候选`storage-v2-review-20261024b`尚未激活；297源码/354构建文件核对一致。固定运行时84项存储/Git/候选/图片/配置行为通过；真实候选在新隔离profile完成根/元数据失联、关闭去重、恢复全文导出、冷开移除不复活、打开另一个项目、本机清理和实际OS回收站，正常exit0，最终证据`/home/bfly/.cache/nozeli-smokes/storage-cutover/nozeli-storage-lifecycle-3uiKXo/`。仅Linux定向验收，不代表全仓旧测试夹具、真实CLI在途/Office各格式/跨平台或断电资格完成。原用户测试元数据尚未清理，关联用户Git的一处旧worktree必须保留或单独审核注销，不擅自改用户Git/账号。没有提交或安装。

审核补修：`clean-local`只能删除确认范围内的`ui.sqlite`及其journal/WAL/SHM，完整保留`execution`（其中包含真实原生会话和Git关联worktree），不再递归删除。使用真实会话目录、真实Git worktree和未提交结果的回归6/6通过；源码真实Electron再次完成根失联/恢复导出/冷开/清本机/OS回收站，证据`~/.cache/nozeli-smokes/storage-cutover/nozeli-storage-lifecycle-DurWDJ/`。此补修尚未进入上述b冻结包，不能把旧包视为修复后候选。

### 2026-10-26 项目循环打开/移除与身份重载

- 普通“移除入口后再选同目录”核验原根与元数据实体，保留原 projectId/instanceId、未发送草稿和会话历史，不自动重发旧任务。项目打开只更新目标 catalog 记录；工作区绑定不再等待非必要的后台资源回收完成，错误仍返回原项目范围。
- 已移除目录的 `.nozeli` 若被另一实例合法替换，不忽略 inode/清单/数据库身份核验，也不直接采用另一 profile 的可写 instance。仅在明确原生确认后复用既有初始化事务建立新的项目身份，保留旧 removed 实例及本机恢复内容，并完整保留当前元数据来源副本；确认前后与发布前核对冻结的根/元数据 dev+ino、清单 schema/projectId 与数据库 identity。
- 特殊身份恢复目前仅支持 Linux 同用户保守 owner 核验：使用真实进程 stamp、精确可执行文件与实际打开的 `catalog.sqlite` 文件描述符，按 fd/inode 前后核验并只读登记查询同根 owner（包括已 unlink 的 catalog 句柄）。真实 Electron 会重写 argv/environ，不能用缺失的测试环境变量推测默认 profile；精确 Chromium 子进程标记与固定桌面服务排除均有反例测试。可识别 owner 必须先正常退出，无可核验 catalog/权限不足等未知状态返回 `RECOVERY_OWNER_UNVERIFIED`，人工确认不能覆盖拒绝。它不是跨用户/非合作程序的目录租约，进程扫描也不能排除扫描后的竞争；沿原 source-preservation/CAS 事务保护，不宣称三平台或恶意并发完整资格。Windows/macOS 特殊恢复保持原状态、明确不可用。普通添加与同身份重载不扫描 `/proc`。
- 生命周期先封新准入；hold 前受理的显式 operation capability 可完成且由 drain 等待。Managed 收尾只能使用当前 hold 对象；跨 IPC 仅唯一 flush receipt 绑定的原窗口/项目/代际能保留 `workspace.recovery`，不能借 token 发送模型或写原文件。并发 flush 串行，不覆盖 requestId。失败/超时保留持久 hold，显式核查后才恢复，不重放 pending。
- 测试必须同时隔离 profile **和项目目录**。新 profile 打开真实项目仍可能执行既定元数据 fork；不能把“测试配置隔离”当作项目文件隔离。本轮不自动迁移、恢复或修改用户原 `nozeli` / `V2Ray二维码`，不安装、不提交。
- 定向回归：`node --test tests/project-reload.test.mjs tests/project-storage-initialization.test.mjs tests/lifecycle-flush-capability.test.mjs tests/project-recovery-owner.test.mjs tests/project-lifecycle-admission.test.mjs`。真实循环入口：先 `npm run build:renderer`，再串行 `node tests/desktop-project-cycles-live.mjs`；真实 Electron＋捆绑 OMP＋本地脚本模型，不调用付费模型，使用合成根目录、正式工具与 `project.remove` 准入。
- **最终真实循环通过（源码开发版、未安装）**：`/home/bfly/.cache/nozeli-project-cycle-fixtures/nozeli-project-cycles-bLbUUL/report.json`，`ok=true`、`errors=[]`，25次本地模型请求。三个新合成根各完成“原生 OMP Worker 正式工具写不同 nonce→成果核验/接受→正式移除→同 projectId/instanceId 重载→再次真实执行→移除”，另一个根完成真实第二 Electron 同根 owner 拒绝、正常退出后原生确认新身份恢复、再次 Worker 执行/移除，共8次执行/移除。最后一个普通重载周期先等 `busyTargets` 完整清空再附着 PTY，显式续轮实际写入后在 job 仍 running 时移除；记录真实 owner PID/stamp 退出、recent 消失、未发送草稿/原文件与恢复事实保全、无历史请求重放。每次正式 `terminal.attach` 后实际 `terminal.screen` 可读；8张真实截图已留存，已查看恢复后/普通重载图。截图中心未选文档空态仍写“未打开项目”，不把它冒充阅读内容已验收或本轮顺带修复。
- **真实耗时，不签“全部瞬间完成”**：上述终轮新项目打开446–464ms，同身份重载126–166ms；原生 enable 1.55–1.97s、首个实际工作约3.40–4.24s；已完成工作的移除282–347ms，真实工具在途停稳移除8243ms。后者仍有约8秒停稳等待，不能以更宽 timeout 宣称无卡顿；没有整段旧安装版stage基线，不能宣称已测量全链性能提升比例。
- **验证链与失败原件**：renderer 构建成功；身份重载/flush/probe定向34/34，最终recovery-only hold准入3/3；协作生命周期合并96/96见`/tmp/nozeli-lifecycle-merged-results.tap`，最终 fd-probe＋真实 Electron＋准入/flush 50/50见`/tmp/nozeli-owner-fd-final-results.tap`。真实 fd-owner 子回归`/tmp/nozeli-owner-electron-results.tap`覆盖同根拒绝、异根允许、已unlink catalog仍拒、正常退出后释放。此前`0jmZPf/report.json`保留真实env消失导致旧profile猜测漏检的反例；最终按实际fd修复后整体矩阵通过，没有把旧失败覆盖为成功。
- **环境与证据边界**：Linux Wayland、真实 Electron/捆绑 OMP 与真实工具、本地确定性 OpenAI SSE 模型（不是付费模型质量验收）。系统目录选择器/原生确认的用户决定为fixture，生产准入与生命周期未mock。早期 `/tmp/nozeli-project-cycles-*` 因原生addon解压遇EDQUOT；只在对应测试owner已退出后清自建可再生natives，保留报告/日志/DB/源文件。最终通过指定 `TMPDIR=/home/bfly/.cache/nozeli-project-cycle-fixtures` 使用自有磁盘fixture，每个项目移除并核对PID退出后清该项目测试agent的natives，报告逐项记录 `stoppedNativeCachesPruned`；这不是产品自动磁盘回收修复，不外推长期资源占用或Windows/macOS。最终成功后不再重跑或安装。

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

冻结清单读取失败不等于零文件：首次成功前显示“文件数量未知”，只有成功空结果才显示“0 个文件”；翻页失败保留上次成功的清单与总数，重试读取失败请求的页。变更集或项目切换清除旧数量。精准回归：在 `apps/desktop` 执行 `node tests/frozen-files-state.test.mjs`，独立生成首次失败、成功空清单、成功后翻页失败、重试成功四张 `renderer-component-only` 截图及 `report.json`，另断言前后翻页重试位置、边界重置和迟到响应隔离；不需重跑完整 `session-reading`。这是合成 DTO 的实际 Electron 组件fixture，不代表生产宿主/WCV、真实Worker/Git或模型请求；分页失败截图仅在fixture中限制清单高度以同屏展示保留内容和错误，不作为产品布局证据。新输出使用独立临时目录，不覆盖先前失败证据。

已保存的工作报告从待办或报告历史进入，未连接模型时可直接阅读，不因查看结果触发聊天准入、连接或初始化；只有显式打开工作讨论才检查原生会话。右侧工作列表仅显示名称与轻量状态，名称进入原工作；详情和取消在名称右键菜单或 Shift+F10 按需访问，不再铺设报告、讨论、丢弃或终端按钮。关闭报告返回原阅读分区，保留编辑器、选区、滚动和未发送草稿，不改变待办处理规则。复验入口：`node tests/desktop-report-actions-live.mjs`，使用独立真实Git候选/文件和宿主，不调用模型；旧离线脚本由该完整操作区验收取代，历史证据保留。

2026-10-24 独立窗口返回补修（源码，未安装）：主工作区进入 `workspace-narrow` 时，分割祖先 `display:contents` 后仍向聚焦分区留下百分比 `flex-basis`，返回内容只占半幅。聚焦分区现显式使用 `flex:1 1 0`，不改布局树、文件或报告身份。真实 Electron 修前复现：590px 主窗可用宽约491px，报告分区仅242px；修后约491px，原生内容宽489px。`desktop-report-actions-live.mjs` 新增真实收窄主窗／独立报告返回的宽高填满断言，并保留原报告 document、选区、details 和零导航；14组通过、正常退出0，证据 `/tmp/nozeli-offline-results-n394us/`，定向几何 `/tmp/nozeli-offline-results-XANhz4/`；相关原生布局／预览83项通过。截图分别为shell与实际guest，不把shell截图的空白占位当正文证据。仅Linux已验，未更新日常安装，不声称覆盖用户现场的所有可能原因。

2026-10-24 当前项目整幅空白补修（源码运行，未安装）：按用户要求直接检查正在打开的 `main` 项目、`main.cjs`。确认 Monaco DOM／内容截图有正文、原生 visible/bounds 正常，但真实桌面壳页覆盖正文；上条窄布局修复不能解决此问题。窗口改为 BaseWindow 加显式 chrome WebContentsView；内容附着时重新将 chrome 原生层插到第0位，再恢复内容 sibling 顺序，避免跨 widget 迁移后仅逻辑 reorder 留下陈旧层叠。单换 BaseWindow、invalidate、resize、重新 show、保持来源窗均不能独立解决，失败截图保留。最终干净重开当前项目（三次511/491/472ms完整往返，含80ms观察等待），同 document／文本／选区不变，实际桌面截图正文可见：`/tmp/nozeli-current-return-1792818992636/final-clean-roundtrip.png`；此前热修复三次477/472/479ms不替代冷开证据。真实报告操作区14组通过（含报告guest原身份、窄窗及正常退出）、原生／恢复39项通过。正常关闭首个源码实例exit0；诊断期间原安装进程曾退出，原因未独立确证，不能归为用户正常关闭。当前保留源码修复窗口供用户继续观察，不自动更新安装或提交；仅Linux/Wayland验证，卡顿仅测上述往返，不声称全应用性能验收。

2026-10-24 用户授权安装并重测：已激活 `native-stack-return-20261024`，previous保留 `narrow-return-b04e67f-20261024`。280源码／350构建文件与 nozeli_git 快照字节一致；原源码窗口正常退出0，随后从安装入口启动，实际exe已核实为本release。使用原profile／当前main项目／main.cjs连续五次真实标题按钮独立→返回，耗时593/478/499/543/509ms；重启前后文本一致，往返同document／文本／选区不变，真实桌面截图确认正文显示（非仅guest截图）。证据 `/tmp/nozeli-installed-stack-1792825240369/installed-verification.json` 与 `installed-return-desktop.png`；截图包含系统磁盘空间通知，未因此删用户数据。安装版当前窗口保留打开，未提交，本次不外推全部卡顿或跨平台通过。

## 统一工作面涂鸦（2026-10-24，源码，未安装）

左栏涂鸦／对话／设置共用按钮风格。涂鸦先冻结当前项目可见主／副窗的原生 chrome、surface 和报告 guest 像素，显示窗口／矩形／全屏／不选择范围，再在原生覆盖预览中使用同一个绘画编辑器。全屏是所选显示器的 Nozeli 自有工作面合成，不抓桌面、系统通知或其他应用；不选择则来源清单为空、不锚定文件。窗口／矩形来源由宿主版本和实际可见区域确定，遮挡区域不带来源；全屏保留可见来源清单但不伪造精确选区。多窗通过冻结预览绘画，不是在每个原窗口同时建立独立画板。最小化或隐藏窗口明确拒绝，不静默遗漏；其他项目不自动取像素。

完成只生成内容寻址 PNG 并幂等追加原项目前台草稿，保留文字、引文和已有附件，不自动发送；未初始化 Agent 也可入稿。只有显式连接和发送才沿原 managed.send/imageAttachments 出站。宿主按项目／deliveryId／PNG摘要读取已冻结来源，不信任renderer自填路径。仅保存本地备注可从涂鸦入口恢复，编辑已保存记录形成新capture；旧文件区域备注仍在同一共享编辑器内使用其原始裁剪、标签和保存链，不重截替换旧证据。恢复库有界、原子写入；正常退出先冲刷当前笔迹，明确放弃仅删无结果引用的恢复记录。

复验：`node tests/desktop-workspace-drawing.test.mjs` 真实 Electron 原生报告多层捕获、物理笔迹、无锚点离线入稿、本地备注重开与继续入稿、退出冲刷；`node tests/desktop-report-actions-live.mjs` 既有报告14组通过；几何／材料身份／PNG真实Controller本地session／旧矢量／窗口与草稿组合62项通过。PNG提示传输采用本地fake session、不调用模型，不冒称真实读图；旧 `desktop-region-drawing.test.mjs` 在旧初始化/根页假设处启动失败，未计通过。Linux/Wayland限定；Office/PDF/Terminal实际合成全矩阵、跨平台、物理多屏及真实模型读图尚未验，不把主窗报告样本外推。没有提交或安装。

报告消费使用 `receipt.report` 格式描述，正文只来自冻结对象：新静态 HTML 为 `.html`，历史 Markdown 为 `.md`；不按正文猜测格式，不保留可写的 `receipt.text` 副本。工作待办与对话只投影宿主生成的摘要；前台 `report:工作名` 读取先核对冻结对象摘要，再提供相同 revision 的语义文本与字节版本，不从当前项目补找旧报告。采用审查同时核对报告本体与候选文件。报告迁移保留全局 schema 2，以 `reportStateVersion:1` 标明描述迁移；历史原字节和对象身份不变。本轮实现未运行检查，HTML 安全与实际消费验收另依实施计划执行。

HTML/HTM 项目文件仍由 Monaco 编辑；“预览当前缓冲”显式打开独立离线预览，“刷新当前缓冲”冻结宿主同步的多编辑器快照，不保存项目文件。自动预览必须手动勾选，默认关闭；状态显示快照、未保存编辑与资源/脚本错误，捕获失败保留上一版。关闭预览不重建源码编辑器；离开当前文件关闭该预览权限面。静态 HTML 报告只在无特权正文面显示，工作版本、采用/丢弃及“结果已保存但结算失败”提示仍属于可信外壳。冻结引用由宿主 manifest 身份读取，HTML 不进入应用 DOM。真实文件 Electron 检查驱动为 `node tests/desktop-html-surfaces.test.mjs`；需先由集成人完成构建，本轮代码编写阶段未执行该驱动。

报告文档命令统一位于工作面标题最右的“…”：另存冻结原件、复制经宿主摘要核验的 HTML/Markdown 源码、已支持的打印，以及关联工作与按需待办详情。报告正文后仅保留一条成果决定带；继续讨论为次要动作，接受并结束为主动作，丢弃保留在更多菜单危险组并确认。处置按钮读取本地 `managed.disposition`，不以 Agent ready 状态代替合法性；确认前冻结 binding，宿主在提交锁内重验。技术失败保持已接受/已丢弃与 ended 状态，显式重试仅技术收尾，不重开 Worker。详情关闭提醒不结束工作，菜单/详情/确认临时避让原生 HTML 内容层并恢复标题焦点。

真实无 Provider GUI 回归：`node tests/desktop-report-actions-live.mjs`；可设 `NOZELI_TEST_BINARY` 和 `NOZELI_TEST_APP_ROOT` 对安装包运行同一驱动。驱动仅使用独立 profile 与合成持久报告、真实 Git 候选，覆盖精确 HTML 剪贴板、标题菜单键盘与回焦、按需详情、取消优先确认、274px/20px 四主题决定带，以及真实冲突导致 ended+blocked 后技术重试完成；不访问用户 Work 或发送模型请求。

冻结差异的“关闭对比”使用所在分区的内容历史回退，不另建对话或覆盖其他分区；历史回退可能重建对话内容面，因此只承诺持久消息、草稿、冻结清单和阅读位置恢复，不宣称对话 DOM 不变。原独立文档编辑器与未保存缓冲、选区、滚动继续保留。关闭后焦点等待返回内容就绪且原生可见再交接；读取失败仍能关闭，退出失败保留当前证据供重试。短文件名、可展开完整路径、版本与导航分组适应窄栏，按钮沿用正文字号，版本与差异计数不小于 12px，不靠缩小文字塞入双栏。复验入口：`node tests/desktop-frozen-navigation-live.mjs`。

Linux/Wayland 源码验收：`/tmp/nozeli-frozen-navigation-llguzc/report.json` 为最终通过原件，14 次关闭均严格核对原分区、焦点、原文编辑器/缓冲/选区/滚动及对话持久状态；覆盖正常、内容相同但模式变化、不可读正文和真实归档读取失败，零模型请求、零 renderer 错误且正常退出。浅深主题各 13/20px，窄栏实际 349.333px、宽栏 1255.333px，28 张实际内容面截图保留。此前失败与诊断原件未覆盖；其中旧脚本在字体/布局稳定前采样造成的滚动差异另经事件诊断区分，未放宽精确恢复断言。本轮未安装、未提交，不宣称 Windows/macOS 已验证。

阅读恢复后的显式“回到最新”会解除旧位置锚点，后续布局更新不再反跳。`NOZELI_TEST_VISIBLE=1 node tests/session-reading.test.mjs` 的实际 Electron 组件回归通过，证据 `~/.cache/nozeli-smokes/nozeli-reading-aioxiM/`，包含恢复 32px 后鼠标追底与布局更新、浅深主题及键盘/缩放流程；零模型请求。非可见运行曾在 180 秒超时，未计通过；可见组件验证不替代上述生产内容面验收。

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
- 配色独立于主题：保留草木（`sage`）为默认，可选岩蓝（`slate`），两者均支持浅色、深色与跟随系统。岩蓝统一应用界面、角色消息、标签卡和差异对比的语义颜色，成功/新增、警告/本地备注与错误/删除仍区别于蓝色操作色；不改文档原件、PDF、终端或 Shiki 代码多色高亮，也不改独立排版。旧配置缺少配色时按草木读取；旧调用保存主题/字体而不传配色时保留已经保存的配色。保存仍由唯一宿主 `appearance.json` 原子落盘，并通过现有工作区消息同步已打开的内容面和独立窗口。
- 配色烟测发现的本地备注问题一并窄修：深色备注保存/编辑采用琥珀背景与深色文字，备注输入框和操作按钮提供明确的键盘焦点；保留的备注投影在成功保存后更新其持久记录版本，避免先保存未变文本、再编辑时仍携带旧版本而被误拒绝。保存失败仍保留草稿和冲突基线，不转为模型请求。窄栏卡片适配排除CodeMirror固定行号栏，避免左侧正文和操作被遮住，不重置滚动或用户偏移。
- Linux/Wayland可见Electron配色验收：`/tmp/nozeli-palette-m0tc7O/report.json`通过，原配色/岩蓝浅深、实际349px/869px内容面、设置切换/系统主题解析/独立窗同步/正常退出重开、旧配置和旧保存调用兼容、真实本地备注保存及来源保持；实测启用文字最低4.726、键盘焦点最低5.904。`/tmp/nozeli-reading-YLFDc6/report.json`为可见组件五角色/Worker矩阵，岩蓝元信息最低4.635；`/tmp/nozeli-frozen-navigation-stocUl/report.json`为真实宿主/Git归档两配色Diff与关闭恢复矩阵，131检查、零模型请求、零错误。复验命令：`NOZELI_OZONE=wayland node tests/desktop-palette-live.mjs`；`NOZELI_TEST_VISIBLE=1 NOZELI_PALETTE_MATRIX=1 node tests/session-reading.test.mjs`；`NOZELI_PALETTE_MATRIX=1 node tests/desktop-frozen-navigation-live.mjs`，产品Electron脚本串行执行。源码未安装/提交；组件证据不冒充模型执行，分离shell/WCV截图不冒充系统合成全窗，未覆盖其他平台、全部Office/系统IME/辅助技术及真实设置错误注入。原对比失败、陈旧备注版本失败和测试关闭/断言错误现场保留。
- 2026-10-22 用户授权后已安装本轮快照：current=`2026-10-22T01-47-35-274Z`，previous=`design-reviewed-2026-10-21T23-09-53-630Z` 保留。安装工具验证私有 OMP/Git、包内链接和桌面入口。实际安装二进制隔离配置启动、正常退出/冷开、旧外观原文件不变及无效配色拒绝已通过；后续打开设置时驱动报元素不可点击，完整配色安装验收未计通过，失败原件 `~/.cache/nozeli-smokes/nozeli-palette-vNY6BA/`。下一轮 executor 须基于该安装二进制定位并完成实际评测，不能以源码旧报告替代。本轮未提交、未强关日常窗口；旧窗口需正常退出重开加载新版。
- 固定安装版第二轮独立评测：`nozeli-palette-T7baH7`实际安装配色/备注/系统模式/跨窗/正常冷开通过；父`vNY6BA`原失败由驱动只等宽度不等resize高度/目标命中引起的时序风险解释，驱动增加真实geometry等待后pointer点击通过，未改包。`nozeli-frozen-navigation-b1VTm7`原矩阵通过，但增加角色持久历史后的`nozeli-frozen-navigation-w7UCMk`暴露P1：宿主保存scroll620.666687，关闭Diff回聊天后实际731.333313，草稿/消息/文件/原文editor仍保持；不放宽断言、不宣称全部恢复通过。`nozeli-frozen-navigation-AW5pWw`仅补实际安装角色/Worker审图，明确不覆盖该恢复失败；`nozeli-offline-results-2Dj3p1`离线两入口及正常exit0通过，零模型。结论为Linux本地有条件使用、整体发布门未通过，先修阅读位置P1；不扩主题，不自动重装。完整评测及P2密度/错误说明建议落于开发计划collab-workspace-integration.md“固定安装版第二轮独立评测”。以上目录位于`~/.cache/nozeli-smokes/`，失败原件保留；主控独立安装投影、显式latest多角色重建、并发单实例全矩阵和跨平台等未签。
- 后续源码迭代由当前助手实施，executor仅提供建议与只读审查。项目设置新增“阅读与对话／工作区／TeX编译／交互与确认”；通用设置收纳外观、全局阅读显示、AI连接、默认模型、Agent资源和快捷键与初始化。终端与Zen独立为即时操作；项目名称/路径可见，分类在本次应用会话内记忆。正文/对话字号与Markdown行宽仍按项目保存，多窗同步且保留近端快捷；不新增文件类型默认继承。全局修改者设置同步所有窗口，布局四种管理与TeX配置复用宿主接口，恢复确认等待实际保存。项目表单保留原归属，资源页仍为唯一组合保存表单。
- 阅读恢复补充非用户迟到scroll校正与preventScroll焦点；显式“返回最新”保持跟尾意图直到用户阅读接管。两配色扩展历史26次Diff关闭exact/焦点通过：`~/.cache/nozeli-smokes/nozeli-frozen-navigation-fXf0vq/`；原110.67px失败保留，确切浏览器内部触发栈未证实。Worker长说明折叠、记录计数移入详情；Diff失败用中文摘要和可展开原始诊断，不用当前文件兜底。
- 设置真实Electron源码旅程`~/.cache/nozeli-smokes/nozeli-settings-iteration-YvCh0A/`13检查通过，含同活独立窗同步/回停、A/B隔离、布局保存/载入/重命名/删除、TeX配置无构建、确认恢复、未保存额度保留、窄屏/Esc与正常退出冷开。可见组件`nozeli-reading-6pWeZs`双配色/浅深、无尺寸迟到110px位移恢复及历史回最新通过，相关42项行为回归通过。复验：`node tests/desktop-settings-iteration-live.mjs`；`NOZELI_INSTALLED_ROLE_AUDIT=1 NOZELI_PALETTE_MATRIX=1 node tests/desktop-frozen-navigation-live.mjs`。源码未安装/提交，当前release不含本轮；Linux/Wayland限定，尚待executor只读签收，不宣称跨平台或TeX编译已验。
- 本轮最终集成复验原件：`~/.cache/nozeli-smokes/nozeli-settings-iteration-a9WnpW/report.json`（13项设置、含最后的全局显示读写保护）、`nozeli-frozen-navigation-lZMlEY/report.json`（扩展历史26次精确关闭/焦点、零模型/错误）、`nozeli-reading-6pWeZs/report.json`（双配色可见组件）。原件保持独立，旧失败不覆盖；待executor只读审查，不自动安装。
- 用户再次授权后已安装`2026-10-22T04-18-11-149Z`，previous=`2026-10-22T01-47-35-274Z`保留；以上“未安装”是此前阶段记录。executor只读审查`job_753b5074bf8b`返回request_changes：P1确认恢复仅清主窗副本，未同步活WCV且旧viewState可复活跳过；P2迟到A布局响应可清B草稿；P2额度保存旧响应可覆盖提交后新输入。另宽屏截图曾含PROJECT_SCOPE_DENIED提示，errors=[]不等于没有可见错误。当前包仍含这些未修缺口，不签最终发布门；安装实测与继续审查分别记录，不用旧套件通过掩盖审查发现。
- 此固定安装二进制复验：`~/.cache/nozeli-smokes/nozeli-settings-iteration-Ntu0Lu/report.json`13项设置/多窗/冷开通过；`nozeli-frozen-navigation-9bsIYu/report.json`扩展历史双配色26次关闭精确恢复及焦点通过，errors=[]、modelRequests=0。均正常退出；这些既有旅程未覆盖上述三项审查反例，不据此关闭缺陷。继续交executor只读审查固定安装版，修复仍由当前助手负责。
- 审查反例后由当前助手修复：确认偏好由项目workspace.settings唯一保存并广播，宿主boundState显式保留合法确认字段；视图恢复始终采用项目值，主窗普通导航保存不覆盖确认权威。布局异步成功只失效原项目缓存，先校验当前page再重绘。额度保存记录编辑版本，后续新输入保留dirty并明确尚未保存，保存中禁止重复提交。项目切换从project.open之前暂停旧bounds/path检查，绑定新布局与renderer身份后恢复；旧异步回调按generation失效，未放宽宿主scope。
- 四项真实宿主源码复验`~/.cache/nozeli-smokes/nozeli-settings-iteration-VjTllT/`17检查通过：真实勾选删除备注不再提醒→设置恢复→同WCV与reload后再操作均确认；标签移除取消后未发送草稿完整；真实成功响应受控延迟下B布局草稿与额度13保留；IPC观察PROJECT_SCOPE_DENIED为零。正常退出与冷开原件保持。受控延迟用于验证时序边界，不代表自然发生频率；旧失败保留。随后用户授权安装修复版`2026-10-22T05-11-53-411Z`，previous=`2026-10-22T04-18-11-149Z`保留，安装产物重启复验另记。
- 修复版固定安装二进制`2026-10-22T05-11-53-411Z`重启复验完成：`~/.cache/nozeli-smokes/nozeli-settings-iteration-Xc9z00/report.json`17项通过，确认同活WCV/重载、标签草稿、两项实际宿主受控响应反例、A/B切换denials=[]、正常冷开/退出均覆盖；`nozeli-frozen-navigation-BQZ0to/report.json`扩展历史两配色26次精确恢复/焦点通过，modelRequests=0/errors=[]；相关32项行为回归通过。保留04:18作为previous；未提交或公开发布，Linux/Wayland限定，其他平台、完整Office/系统IME/TeX编译不外推。
- 后续复审剩余边界由当前助手修复：shell state.write读—合并—写与workspace.settings共享同一项目串行事务，导航始终保留项目确认权威；额度在途切项目保留待刷新，完成后读取当前项目；布局提交后按编辑版本保留同页新输入；workspace绑定失败回退原项目及原layout，再解除切换暂停。源码21项旅程`~/.cache/nozeli-smokes/nozeli-settings-iteration-smshY4/`通过，errors=[]/denials=[]，含一跳绑定失败及并发陈旧导航。固定独立候选`workflow-boundaries-20261022-0610`，未切current/previous。后续真实复杂任务HTTP准入与token仅统计、不限额，collector maxAttempts/maxInputOutput显式null；源/模型授权、重复发送防护及数据安全停止仍有效。
- 固定候选实际二进制复验`~/.cache/nozeli-smokes/nozeli-settings-iteration-cfIvtm/report.json`21项通过，errors=[]/denials=[]，正常退出及冷开通过；6项额度边界回归与13项请求统计控制回归通过，含显式null禁用次数/token限制但保持累计与主动安全停止。该候选用于后续复杂任务，尚未启动本轮真实推理，不将测试门通过等同executor最终签收。
- 真实任务审核后新增独立候选`workflow-feedback-20261022`：成果快照只接受严格`digest:null,size:0`缺失记录，有效文件仍校验来源/字节；缺失不读现文件兜底。composer旁持续提示当前target原生草稿占用并保留终端查看入口，发送前禁用；报告处置禁用显示原因及原连接重试。原现场零输入复验`~/.cache/nozeli-smokes/nozeli-real-todo-DWrQms/`通过，源码链接恢复、草稿提示可见/解除、原job/thread保持；相关23项回归通过。观察器已在原角色配置显式加载并修正相对依赖，`nozeli-observer-preflight-3PMxJo`返回2个loaded；必要前台澄清`xJ9k7z`实际记录4 HTTP和4 usage条目（旧测试误查events导致末尾断言失败，未重复付费澄清），HTTP/token不限额、仅统计，旧空账不补猜。
- 后续真实原现场已补：原算法同thread r1→r2恢复误删，另建剩余文档Work；接受时发现“分别提交”被正则误匹配“别提交”，现按独立否定词修正，真正禁止提交仍保护（20项处置回归）。固定独立候选`workflow-disposition-20261022`，GUI技术恢复后算法采用成功、文档丢弃，原两Work工作树清理及人工作品保持；证据`nozeli-disposition-recovery-ySc2af`。双Worker/长工具与独立排队取消、八场景几何、真实dirty同文件保护已补。新P1：原生故障恢复后对话reload将Work草稿呈现在frontdesk目标（未发送），证据`nozeli-workflow-continuation-f0WjvK`，已停依赖发送；不能签整体流程通过。完整阶段报告为`~/.cache/nozeli-smokes/nozeli-real-workflow-mA5MtM/iteration-2-assessment.md`，新候选未切日常安装。
- 对话输入按项目与接收目标恢复，窗口只记录身份，正文沿用原 managed draft 权威；附件和回复引文按同一目标保存。不存在、结束、只读、跨项目或缺少身份的旧输入保留并禁止发送，不猜测迁移到前台。普通“对话”入口仅打开现场，不等于显式选择前台；原生连接未完成时工作面仍可恢复、保存和切换目标，发送继续遵守真实会话就绪门。迟到连接不覆盖当前输入，发送回执同时检查目标、编辑世代和材料版本，改回相同文字也不清新稿。Linux 可见 Electron 零推理验收 `/tmp/nozeli-input-identity-nCqoVH/report.json` 八组通过；包含真实私有 OMP/材料 IPC、预置 Work、一次受控连接响应与两次受控发送回执，不冒充真实任务准入。相关身份回归17项通过；完整 renderer 命令59通过、2项因 Node 不识别既有 CSS import 而加载失败，未宣称全绿。新候选独立冻结在 `~/.cache/nozeli-smokes/nozeli-input-candidate-CYAAU4/releases/input-identity-ready`，未安装/提交，原真实故障现场另行续验。
- 同一冻结候选已在原真实故障现场完成无重放续验：`~/.cache/nozeli-smokes/nozeli-original-input-rzZQKU/report.json`。旧无身份view先隔离，显式选择原Work恢复原thread，reload及正常退出后冷开重开保持未发送草稿和目标；frontdesk稿仍空、原jobs和材料/oracle字节摘要不变。5个SDK loaded、0模型HTTP，原故障Work仍paused且不冒认完成。七个源码/打包renderer SHA一致；未切日常安装。完整Provider/renderer故障矩阵、其他平台与最终只读签收仍不在本次通过范围。
- 后续真实renderer故障测试未通过：`/tmp/nozeli-workflow-continuation-zxySPl`已有120102ms真实工具及冻结result，但原事件观察超时，job因`collab-drain-timeout`失败且Work paused；10模型HTTP计入累计，不重发任务。systemd-coredump完成记录晚于注入217019ms，超过驱动120000ms观察期限，不能据未采到事件判断产品没有事件，排空失败仍未归因。驱动注入修为renderer/shell隔离及出生stamp校验后SIGKILL；同一真实paused Work零推理补证`~/.cache/nozeli-smokes/nozeli-renderer-zero-qlJgkK`实际killed事件14ms、两步显式恢复、原native PID/thread/jobs/草稿保持、正常exit0、0模型HTTP。这仅覆盖进程终止后的暂停现场恢复，不冒充原执行中故障通过、SIGABRT/core或OS指针验收；旧两个负向与新paused Work均保留，完整恢复门继续待审。
- executor后续request_changes中的材料异步P1/引文清稿P2已由当前助手复现并修复，待复审：材料批次绑定原项目/目标/容器，晚回不进新目标，返回原目标可继续完成，reading禁发、reload未完成读取显式保留错误；主发送区分raw正文和含引文payload，原稿未变才清正文/引文，新稿、仅改引文、同文字重编辑均保留。零模型入口`npm run test:composer-identity`；源码11组`/tmp/nozeli-composer-ownership-68llA0`与固定候选`composer-identity-reviewed`实际二进制11组`/tmp/nozeli-composer-ownership-i4f9eh`通过，0模型HTTP/exit0，修前`LQAx3T`六项失败原件保留。真实材料IPC＋预置Work＋受控回执，不冒称模型准入；七个renderer包内/源码SHA与实际材料/清稿截图封存。原17身份回归通过、既有CSS加载失败不重新刷绿；新包未安装/提交，旧真实renderer排空失败与三个负向Work继续保留，未付费重跑。
- executor `job_6f102c82dbfd`限定accept Linux输入身份门，材料P1/引文P2关闭。真实OMP零模型sync六场景02qHRH及实际driver nonce全链d09GAp通过，不改8秒/业务结果；故障先封存、保留app/collector，不自动取消退出，rE6pYY验证外部退出独立记账。另修paused失败回合隐藏已保存result，精确receipt/job关联保留阅读和结算待核查提示，不改失败或允许采用，39回归、saved-result-state原真实现场7oe0hu及同包11项身份保护UcjSBf通过，0新增模型HTTP。旧drain/PID仍unknown，执行中门未签；下一必要真实验证使用独立项目/profile，原三负向/日常安装保留、不重派旧业务。越根profile首次预检被CONFIG_ROOT_INVALID拒绝后只修准备器，未放宽产品限制。
- 独立新项目/profile的真实SIGKILL在途恢复jOFIJ2已按封存断言通过：120100ms工具期间终止自有renderer，两步明确恢复后原native PID/stamp/owner/thread/job/request、target与未发稿保持，job最终completed/request settled、Work review、四文件候选/报告可读、正常exit0；原三负向/10文件guard均保持。单场景待executor签收，不覆盖旧SIGABRT/core/drain根因、复杂历史/跨平台或完整P5。本轮8模型HTTP/10SDK usage，累计86观察准入/SDK total608947不清旧账。executor bae69c6ac5b9已限定accept失败结果显示和零推理前置；其非阻断“找最新结果”提示P2改为当前报告可读、结算待核查、暂不可采用，settlement-guidance/2Nc1j1零模型核对通过，旧包未热改、日常安装未动。
- “终端”和“Zen专注模式”位于设置导航独立的“快捷操作”区，打开项目后可切换终端，不建立重复入口。终端顶部可直接“返回阅读”，切换不取消任务、不清空草稿。窄屏文件栏开关置于左侧中部，避免遮住设置。
- 文件树右键“隐藏”只隐藏当前项目的显示，不删除文件、不修改.gitignore、不取消已打开编辑，也不阻止Agent访问。“…”→“显示已隐藏”可查看并恢复隐藏项。隐藏与查看偏好按项目持久化，大目录在遍历和可见数量预算前排除。
- 检查入口：`node --test tests/provider-settings.test.mjs tests/file-tree-ops.test.mjs`；可见Electron为`tests/desktop-settings.test.mjs`和`tests/desktop-tree-visibility.test.mjs`。真实OAuth和其他平台不据此视为通过。
- 资源/模型联动 Linux 限定验证：153 项组合行为回归通过；后续 GUI 回合实际模型持久化及工作区身份修正的 62 项回归通过（集合有重叠，不累加）。真实私有 OMP＋本地 HTTP 通过跨项目休眠/原非空线程恢复、原生草稿保护、宿主 SIGKILL 冷恢复零请求重放、三分钟在途回合保护及完成后休眠；模型 A→B 保持 PID/线程与未发送输入，HTTP 和不可变回合实际模型分别 A/B，运行中新增 Provider 及 stop/resume 同样通过。实际可见 Wayland Electron 保存模型联动、29 项设置流程及 A/B 项目额度独立保存通过。只用合成凭据和本地模型响应，未验证公网推理、OAuth、Windows/macOS；长时项验证的是在途所有权保护，不是模型计算性能。
- 打开项目只更新当前资源归属并保护该项目，不隐式 connect 或唤醒空闲 Agent；显式聊天/请求仍走原准入。Linux 私有 OMP＋本地脚本 HTTP 实测跨项目休眠与原非空线程恢复、在途请求保护与完成后回收、宿主崩溃后原线程/草稿恢复且零 HTTP 重放；这是实际原生进程验证，不等于远程模型或跨平台验证。复验入口：`node --test tests/agent-resource-native.test.mjs`。
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
- 已安装`omp-recovery-visible`：修复提交`1503af0`，原生内容面终端被CSS隐藏及缺少可达入口修复`b91adf5`。日常真实项目前台/编排均ready，两PTY attached且可见、各32行，右键“打开Agent终端”实际点击通过，截图`~/.cache/nozeli-smokes/omp-recovery-visible-installed.png`。4个旧job身份/完成状态与草稿`1`保持，未发送推理请求或重放；旧Codex Worker仍只读，未强行迁移。空线程缺日志会重新生成，未据此宣称空线程冷恢复保持同threadId；总组合40/41的旧夹具失败保留。
- 修复新项目切换时先读取目录/state再绑定宿主项目导致`PROJECT_SCOPE_DENIED`：成功打开后先完成`workspace.project`绑定，再发布UI项目与读取资源。Linux真实跨项目10项通过`~/.cache/nozeli-smokes/nozeli-single-content-Dsh9su/`，含保存/浮窗隐藏恢复/草稿历史不重放；未放宽IPC项目隔离。
- 已提交项目scope顺序修复`dee83bf`并安装本机Release `project-scope-release-20261021`，回退`omp-recovery-visible`。实际包6组UI通过`~/.cache/nozeli-smokes/nozeli-workspace-chrome-u42Cv9/`；日常真实切到nozeli_git后宿主/布局projectId一致，目录18项，state.read/project.children成功。切换瞬间仍观察到PROJECT_SCOPE_DENIED toast，后续目标读取正常，未宣称所有异步旧请求已清零。另观察到默认模型不在原生registry提示，未作为本次scope修复通过项。仓库未配置remote、gh未认证，且对外发行许可审计未完成；只生成安装本机Release，未公开上传。包仍为当前工作树快照，非纯净commit发行归档。
- 2026-10-26项目切换/关闭补充修复：目录选择仅登记项目，读取项目不改变窗口归属；旧shell与文档/对话现场成功保全后，统一由工作区提交目标项目。保存或原生附着失败保持原项目/原内容，并显示具体原因；关闭前保存拒绝进入明确的工作区恢复提示，不伪报保存成功或静默退出。已打开项目的原生内容面在跨项目切换时隐藏驻留，返回复用同一WebContents、编辑器及缓冲；直到项目关闭或窗口退出才释放，不引入自动淘汰。最终退出先保全全部驻留项目内容面。
- 对精确`HEAD + 本次修复`隔离快照重新执行`npm run build:renderer && node tests/desktop-project-scope-live.mjs`，Linux/Wayland真实Electron八组通过：A带未保存正文/原生对话草稿经目录选择切B、取消与保存拒绝保持A/A、B附着失败回滚且提示可见、返回A同WebContents/编辑器及后续键盘编辑、B正常退出code=0、A恢复记录持久保留且B原文不串内容；pageerror为空。证据`~/.cache/nozeli-smokes/nozeli-project-scope-XlRUxb/`（含报告、独立内容面截图及实际关闭对话参数）。目录选择结果、恢复写入拒绝和原生附着失败由隔离launcher边界夹具控制，未声称物理文件选择器自动化；未发送模型请求。主renderer由候选源码构建，仅复用现有node_modules和固定`vendor/pptist/dist`依赖，不含工作树未提交guided-demo修改，未安装，其他平台与真实Office/涂鸦格式本轮未验。此前未保存正文回切丢失和绑定错误提示隐藏的失败原件分别保留于`/tmp/nozeli-project-scope-paAJew/`、`/tmp/nozeli-project-scope-UCIlXq/`，不将旧失败改记为通过。
- 修复“清空前台上下文”后对话窗仍显示旧记录：清空事务保存完整时间线sequence边界，当前最新帧只显示边界之后的内容，刷新不复活；显式历史分页/原始消息读取保留旧记录，不删除业务或主控状态。16项session-index回归与真实Electron/私有OMP/本地脚本HTTP七组清空流程通过，证据`~/.cache/nozeli-smokes/nozeli-frontdesk-clear-qeemNa/`，含取消不清空、确认旧回复消失、原历史可读、下一回合不带旧输入、草稿保留和零重放。源码未安装。
- 修复原生独立对话拖动时不移动、松手才跳动：drag.update实时更新原窗口几何，拖动源内容保持可见，Esc恢复起始位置；松手按最近有效屏幕坐标附着，避免窗口移动后释放坐标漂移。真实对话移动前松手断言/取消/草稿同DOM11项通过`~/.cache/nozeli-smokes/nozeli-single-content-FE1dHj/`；真实跨窗附着6组通过`~/.cache/nozeli-smokes/nozeli-workspace-chrome-Fo3z5s/`。Linux/Wayland限定，其他系统未验。
- 已安装并重启`conversation-realtime-drag-20261021`，回退`project-scope-release-20261021`；日常项目真实独立对话按住鼠标期间观察到原生窗口位移，Esc恢复0,0，右键返回主窗口且草稿一致。自动化首轮等待超时保留，分步前置bringToFront后观察移动成功；不把CDP本地坐标步进产生的累计位移当物理鼠标速度证据。仍观察到独立根窗IPC_DENIED提示，来源未在本轮消除；未宣称已修复所有权限提示。本次安装含前轮已验清空对话边界的工作树变更，未额外commit。
- 分屏流畅性专项修复：边界纯单击不提交浮点误差比例；resize按帧同步WCV尺寸、最小尺寸钳制、Esc/丢失捕获取消且不持久化；拖动中旧比例广播不覆盖预览；窄窗焦点为空时改呈现有内容；标题drag IPC按帧合并；原生moved/resized150ms合并并去重；drag结束在转移完成后统一恢复，重复/失效/导航取消释放隐藏状态。31项布局/原生回归通过，真实仓库上下/左右48步resize、边界单击、极限尺寸、取消、窄窗往返与原件SHA不变通过`~/.cache/nozeli-smokes/nozeli-real-project-q30Qfd/`：831帧P95 16.8ms、>50ms 1帧，启动长任务299ms，非提速对照。已呈现文件切换44.6–59.2ms，需重建的文件切换586.1–840.6ms，未宣称该延迟已消除。对话按点击激活分区打开/移动，同composer且唯一view通过`~/.cache/nozeli-smokes/nozeli-workspace-chrome-BvXbuX/`；多窗/取消/项目切换11组通过`~/.cache/nozeli-smokes/nozeli-single-content-Nb7xjB/`。Linux/Wayland源码限定，未安装/commit，不外推其他平台、物理多屏或系统IME。
- 独立窗`IPC_DENIED`已定位为隐藏的主导航文件列表监听在detached root执行`file.availability`；改为仅shell响应文件列表刷新，不放宽IPC授权。真实Electron断言独立窗不再出现该提示、脱离/拖回、对话按激活分区移动唯一composer七组通过`~/.cache/nozeli-smokes/nozeli-workspace-chrome-iGGkOO/`；多窗/取消/项目切换11组通过`~/.cache/nozeli-smokes/nozeli-single-content-yeT4Se/`。源码未安装/commit。
- 对话正文右键补齐与文本一致的向右/向下拆分；独立根窗标题右键也共享分屏项，仍只保留唯一对话/原composer，不复制上下文。已安装重启`split-flow-conversation-20261021`，回退`conversation-realtime-drag-20261021`；实际安装包真实右键x/y拆分、原composer身份、唯一对话、激活分区打开、拖回/取消与无IPC_DENIED流程通过`~/.cache/nozeli-smokes/nozeli-workspace-chrome-eQAFWe/`。包含前轮分屏流畅性修复工作树，未commit，Linux/Wayland限定。
- 深测确认独立窗“无法移动”包含空标题直接return、对话移走后全空浮窗遗留和拖动整窗工作区钳制三类：空标题改用group拖动，仅窗口移动不附着空内容；统一清理含内容→全空的detached，保留主动空窗/含内容split；交互移动不做冷恢复工作区钳制，Esc仍回起点。36项回归通过；隔离原生12组（含空分区标题移动与同composer草稿）`~/.cache/nozeli-smokes/nozeli-single-content-4Rmhbi/`，真实repo8组`nozeli-real-project-qr5UVg/`：835帧P95 16.8ms、>50ms零，启动长任务298ms；需重建文件切换570.3–697.6ms仍存在，非全桌面跟手延迟保证。真实多窗7组`nozeli-workspace-chrome-5lOKeD/`通过。日常交叠鼠标事件未用于性能结论；没有宣称物理多屏/系统IME/其他平台通过。
- 已安装重启`deep-float-movement-20261021`，回退`split-flow-conversation-20261021`。实际安装二进制隔离12组原生流程通过`~/.cache/nozeli-smokes/nozeli-single-content-sZuTZN/`，含对话与空分区标题按住时移动、Esc复位、项目隐藏恢复、原composer/草稿零重放；安装包7组控件/附着流程通过`~/.cache/nozeli-smokes/nozeli-workspace-chrome-UMFJo7/`。未commit；未验证真实系统鼠标持续运动延迟或物理多屏，不以CDP坐标累计移动冒称跟手速度达标。
- 完整分屏修复矩阵S01–S09已落盘于产品single-file-panes合同。新增pane独立512项MRU，标题关闭文件不删分区、closeContent收起对话恢复上一document，命名布局和冷启动保留历史。持续浮窗移动改为single-flight最新坐标直接IPC，不依赖可能停帧的root rAF；边界在跨WCV丢失pointer capture时由同窗surface在显式resize会话内转发输入，Esc/结束隔离，未放宽IPC。47项domain/native回归通过；源码连续8段水平/垂直/斜向/反向移动13组通过`~/.cache/nozeli-smokes/nozeli-single-content-84MgdN/`，8段响应1–68ms（含自动化，非物理输入延迟），无5秒停顿；pane-history-LP4Svt六组含主窗/浮窗MRU、草稿和冷重启通过；real-project-McpPV9上下/左右resize八组通过；native-lifecycle-pTEJZE九组、命名布局持久化、native-drivers-lZixHT六组与workspace-chrome-P7qqu1七组通过。先前跨正文lostpointercapture回弹、布局未保存history以及首段尚未focus的失败均保留，不更改为通过；最后安装验收另行记载。
- 完整修复已安装重启`split-complete-mru-drag-20261021`，回退`deep-float-movement-20261021`，尚未commit。实际包矩阵：native13组`~/.cache/nozeli-smokes/nozeli-single-content-f9yHvE/`（8段连续移动7–18ms自动化观测，无跨正文停顿）；history六组含冷重启`nozeli-pane-history-Jo2mIL/`；真实仓库resize八组`nozeli-real-project-Ui6Vsp/`；控件/唯一对话/附着七组`nozeli-workspace-chrome-H6gx2r/`全部通过。日常项目额外分步跨正文水平/垂直/斜向/反向七段12–18ms、Esc回原位、返回主窗同composer/草稿通过，截图`~/.cache/nozeli-smokes/split-complete-daily-conversation.png`；首轮合并浏览器run超时保留，分步确认实际每段pointer→drag与位置对应。47项domain/native回归含resize输入仅同窗会话可转发通过。测量包含自动化调度，不代表物理鼠标延迟；Linux/Wayland单显示器资格，不宣称Windows/macOS/物理多屏通过。文件按需重建仍约0.58–0.71s，启动长任务313ms单独保留，不属于拖动中断已修复的证据。
- 纠正旧移动验收：KWin真实窗口位置居中353,116且未随setBounds移动，Electron内部坐标不能证明系统位置。已安装`native-compositor-move-20261021`：上沿/标题空白区使用原生app-region:drag，文件名保留no-drag内容附着及右键；删除JS拖放的setBounds模拟移动/取消。47项回归、真实内容附着取消与同composer、右键返回通过；旧内部坐标移动验收删除，不再算桌面移动证明。系统观测到安装后独立窗frameGeometry从353,116变为851.57,172.63，但不是受控鼠标动作，不算完整跟手资格；本机XTest输入被Wayland拒绝，KDE fake-input未公开、无uinput写权限，未提权或绕过授权。原生系统鼠标拖动仍需现场确认，不宣称完成。未commit。
- 修复右键分区菜单导致全屏正文消失：移除菜单打开前groups空数组+overlay:true的全量隐藏，改传实际overlay矩形，仅遮挡相交WCV；bounds恢复以定时任务调度，不依赖可能暂停的root rAF。修复嵌套split flex子树最小尺寸溢出，pane使用border-box/min0并按分割条半宽补偿最小比例。22项native回归含局部遮挡/恢复通过；安装`context-menu-visibility-20261021`（回退`native-compositor-move-20261021`），实际包`~/.cache/nozeli-smokes/nozeli-real-project-6Q1MSF/`验证边界右键、暂停root rAF期间菜单打开/关闭后原生getVisible恢复、左右上下resize/最小值/窄窗和原件不变；七组控件分屏通过`nozeli-workspace-chrome-jA2Bos/`。未把CDP根鼠标点击当原生子视图命中证明；失败夹具/旧失败证据保留。未commit。
- 浮窗缩放内容消失已确定复现：真实KWin缩小到260×180后，迟到的旧792×760 bounds消息会把原生正文getVisible设false，虽已有正确259×145正文bounds。修复发送视口width/height作为布局身份，宿主拒绝尺寸不匹配的迟到包并通知viewport-changed重算；原生resize主动通知外壳，不靠落盘广播恢复。51项domain/native回归通过；源码五轮缩小/放大+旧包注入+同editor/原件/冷重启十组通过`~/.cache/nozeli-smokes/nozeli-native-lifecycle-cm7O6D/`。同轮加入用户新契约：每分区最多5个被覆盖内容，document/conversation/report/history/diff统一回退；旧长历史加载截到最近5项，保留旧资源记录，对话关闭收起不删除会话。安装验收另行记录。
- 已安装重启`float-resize-viewport-five-history-20261021`（回退context-menu-visibility-20261021），未commit。实际安装包五轮缩放/迟到旧包/原editor及冷重启十组通过`~/.cache/nozeli-smokes/nozeli-native-lifecycle-h2RM50/`，最终正文尺寸逐次匹配可用区域599×465、339×445、999×725、499×485、849×645，全程visible；六组回退/冷启`nozeli-pane-history-pbLYXS/`、七组控件`nozeli-workspace-chrome-RuaoHI/`通过。日常真实KWin将对话浮窗缩到420×320，正文419×285仍visible，注入旧1200×900布局返回stale:true且未隐藏，同composer保留；恢复792×760后正文791×725可见。截图`~/.cache/nozeli-smokes/float-resize-installed-conversation.png`。仅Linux/Wayland本机，不宣称其他平台通过。
- 对话回停后空白定位为同视口的旧revision空布局仍可隐藏刚移回WCV；已真实注入旧包将visible从true变false复现。新增layoutRevision和根renderer递增sequence校验，过期包只请求新布局不改显隐；重载重置序号；跨窗转移提交后激活接收view分区，避免窄主窗仍聚焦其他内容。24项native回归通过；源码窄窗回停/旧包/草稿通过8J0nWX，实际包11组`~/.cache/nozeli-smokes/nozeli-single-content-JMEhNd/`和七组`nozeli-workspace-chrome-TFBL05/`通过。已安装重启`dock-layout-focus-20261021`，日常原对话右键脱离/返回后main原生visible=true、同composer及草稿不变，旧revision包返回stale:true且正文继续visible；截图`~/.cache/nozeli-smokes/dock-layout-focus-daily.png`。源码未commit，Linux/Wayland本机限定。
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
