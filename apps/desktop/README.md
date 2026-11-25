# Nozeli 桌面应用开发说明

## Windows beta.8 开发入口（2026-11-17）

产品源码迁移到上游 `v0.1.0-beta.8`／`bf7483fd9880cb926b0daf67f00f77754a98b511`，保留本仓库 Windows 原生存储、进程归属、普通 Bash、草稿与未决效果保护。Node22.23.4、Electron44.9.1、Pi SDK1.4.0保持固定；此前真实VS/UAC补齐Spectre14.44，原生构建不能关闭缓解或回退旧二进制。上游公开包仅Linux x64/macOS arm64，本 Windows 包是本机迁移构建，不冒充上游Windows发行。自动更新和无法证明全树其他实例停稳的“强制恢复访问”仍明确拒绝；普通阅读、编辑和搜索不依赖这些恢复能力。完整W0–W5尚未完成，见[逐门清单](../../docs/windows-w0-w5-qualification.md)。

从权威repo根在PowerShell执行（仅修改当前进程环境；不改全局HOME/CODEX_HOME）：

```powershell
& .\apps\desktop\tools\Start-NozeliWindowsDev.ps1
& .\apps\desktop\tools\Start-NozeliWindowsDev.ps1 -CommandArguments @('integrations/pi/build.mjs')
& .\apps\desktop\tools\Start-NozeliWindowsDev.ps1 -CommandArguments @('apps/desktop/tools/build-windows-native.mjs')
& .\apps\desktop\tools\Start-NozeliWindowsDev.ps1 -CommandArguments @('apps/desktop/tools/build-windows-process.mjs')
```

迁移VM默认使用同工作区固定Node和所在固定盘`dev-cache`；其他开发位置可显式指定`-Workspace`／`-CacheRoot`。JavaScript路径必须放进`-CommandArguments`，`-Executable`只接受明确.exe/.cmd，拒绝通过文件关联打开脚本。真实Node/Electron专项可用`tools/test-windows-qualification.mjs`（从desktop目录以固定Node调用，参数见脚本usage）；记录实际子进程版本/nonce/PID，TAP仅保留无私密原文的结构/代码/源码位置。

新增正式suite：`windows-project-terminal`、`windows-tool-lifecycle`、`windows-manual-install`；SDK精确重放为`integrations/pi`下`npm run test:storage-patch`。ConPTY需要同批`nozeli_windows_terminal.exe`，仅该子launcher重置继承的Ctrl-C忽略状态，再启动固定System32 `cmd.exe /d /q`；不改变Electron宿主控制台状态。TeX/TexLab/JS-TS工具使用创建前Job约束，未知停止保留原对象；源码与包内运行时分别验证。强退只对已捕获原后代HANDLE尽力终止，整个树退出不作伪确认。

Windows原生候选／隔离手工安装工具为`tools/package-windows-candidate.mjs`与`tools/install-windows.mjs`，必须显式给专用绝对目标；不可采用旧日常目录。版本不可变、profile独立且启动前验证归属；升级／回退不覆盖原版本与草稿，未知结果保留锁和材料。自动Windows更新、签名和公开发行未资格化或未获授权。包必须覆盖全部六份SDK补丁输出、build/spec/tools和实际原生输入输出；构建或打包成功本身不是资格结论。

Windows Pi 原生 `bash` 工具依赖本机安装的 Git for Windows（这不是随包 MinGit 提供的能力）。宿主按 SDK 支持的位置核对 `%ProgramFiles%\Git\bin\bash.exe`、`%ProgramFiles(x86)%\Git\bin\bash.exe`，再查主机 PATH；实际运行 `--version` 确认 GNU Bash 后，把绝对 Shell 路径交给原生 Bash 工具。普通 Bash 按当前用户权限执行，无命令白名单；托管 PATH 依次包含随包 Node、System32 和应用启动时的用户工具 PATH，已安装的 Python／编译器等不再因路径被丢弃而不可达。私有 HOME／配置目录、凭据清理和进程所有权保留。没有 Bash 时明确说明依赖，阅读与对话不禁用；安装新工具或修改 PATH 后需重启应用。具体管理员提权、广泛破坏性操作和敏感导出走宿主确认待办，批准后按冻结效果执行，必要时使用系统 UAC；取消或拒绝不执行。这是与 Linux 一致的可信 Agent 策略，不承诺识别任意 Bash 脚本的全部危险效果，也不自动赋予管理员权限。

普通主控文件读取使用 `nozeli_document_read`；项目初始化工具只在对应受限事件中公布。项目诊断事件只公布 `debug`、`debug.inspect`、`debug.report`、`debug.continue`，bug 身份由宿主当前精确事件绑定，不要求模型重复传递；显式外来身份和项目／事件变化仍拒绝。执行围栏保持独立校验；诊断文字不等于已修复，不授权重放原任务。实时消息快照至多每50ms投递一次，结束／工具／持久记录边界前刷新最后快照；完整持久消息不截断，原生输出保留上限不放宽。

生成的Windows PowerShell启动器以UTF-8及`.NET Path.Combine`／扩展Win32路径读取归属、清单和长路径成员，校验所有字节与摘要并保留读句柄直到应用退出；不依赖PowerShell provider的MAX_PATH行为。启动前Windows明确未准入的同步／异步错误保留active版本和profile，释放本次原锁以允许用户显式回退；已准入后的不明结果仍保留核查fence，不自动重投。`windows-manual-install`还运行实际生成启动器的Unicode／长路径／篡改／junction拒绝回归；合成Node准入不冒充Electron端到端产品验收。

Windows正常退出后的Agent重开：只有在原启动声明已退休、Job／supervisor停稳、完整owner集合和来源身份核验完成后，才持久发布该代独立的normal-release完成回执。新进程在原生独占anchor下只读核对原CAS指纹、完整owner版本及文件实体，再以完整集合CAS激活新host；不依赖旧进程内存中的receipt，不重放旧输入。最终完成回执提交后回复丢失时，原调用方仍报告UNKNOWN；后续进程可以核对已持久完成的发布，但不据此认定旧调用方收到回复。未正常释放、旧格式或并发变化仍拒绝；这不授权异常冷接管或删除旧home。各代完成回执分区比较，不将全部历史累加到单次CAS预算。当前源码生产回归已实测新进程重开后完成一个显式新输入，并保持异常host拒绝。

Windows beta.8 原生工具子进程归属：Job 在创建 leader 前关联完成端口，独立观察线程按创建通知保留子进程 HANDLE 与 creation-time；supervisor 接手唯一观察者并发布有界成员事实。结束时同时核对累计进程数、已宣布／已捕获身份、原句柄退出、输出 EOF、停止回复、日志与注册 CAS，不凭 Job 为空清除占用。通知丢失或进程身份无法固定时仍保留 UNKNOWN；这种情况不能靠等待、删锁或重放原输入转为成功。新构建与旧 helper 被锁定的二进制隔离，旧现场继续引用旧字节。

Windows异常退出后的显式恢复：连接与历史面板提供“检查异常退出资料”及“核验后恢复新输入”。检查仅保留原生核验对象，不退休host或改写任务；确认绑定当前项目实例、原host租约与版本的主进程一次性challenge，再经业务hold及原anchor交接启用正式Windows入口。旧任务的未知效果仍挂起，草稿／报告／历史保留，不自动重发或删除。只有原helpers仍可核验、原host和Job确实退出、原journal／工具业务回执完整且无未决业务intent的受支持场景可恢复；缺失、存活、并发变化或UNKNOWN均拒绝。此功能不是通用的强制解锁；未核验现场不能通过换PID、等待超时或复制旧记录放行。

2026-11-10 Windows 冷证据归档开发：原inspection显式入口先核对业务hold/冷退休，再以本机完整集合CAS登记归档意图。原生句柄捕获完整当前owner home并核对原journal/metadata，复制全部文件、原helper中完整stdin/stdout/stderr和账本快照，独立复核后保存ready回执。原目录和helper保留；未资格化原home全生命周期身份、helper释放或完整恢复闭包，不把归档变成业务确认。实际资格见 [冷证据归档记录](../../docs/windows-alpha6-cold-evidence-archive.md)。

2026-11-10 Windows 连续冷接管开发：显式入口逐代核验完整原生启动集合、原检查点／hold／退休／激活回执及精确旧退休行，保留旧Worker暂停与候选；原inspection内部私有读入口在完整ledger前后检查之间核对各代journal，公开读入口仍需重新核验。第二轮采用两次真实宿主退出与第三个Controller启动回归，历史／owner变化拒绝，提交后丢回复或pending变化保留UNKNOWN。具体资格、包与限制见 [第二轮冷接管记录](../../docs/windows-alpha6-repeat-cold.md)；默认入口、资源释放与完整W0–W5仍在进行。

2026-11-10 Windows 单次冷接管：原 inspection 签发仅同进程有效的一次性 opaque handoff；新 host 以完整集合 CAS 接续精确退休 revision，保留原受限 anchor 文件对象，向新 supervisor 转交完整来源 custody。共享 Controller 通过显式 WorkspaceIO 核对旧 provider，恢复中断／review／草稿并启动新常驻角色；旧工具回复仍未决，旧输入不重放。第二轮冷接管、owner 资源处置、pending 协调和默认入口仍未完成。当前进度与验证见 [单次冷接管记录](../../docs/windows-alpha6-cold-handoff.md)；下文为此前阶段边界。

2026-11-10 Windows 原 anchor 冷领取：已增加跨原 helper 的一次性原生仲裁，只传只查询／等待且不可继承的原文件对象句柄，继续保留写共享排他；不关闭后重开路径。显式 managed 入口先持久业务 hold，再核对原检查点／journal／业务／pending，领取后变化为 UNKNOWN、不重试。此步骤不退休 host/owner、不激活新代、不重放旧输入；完整冷接管及默认入口仍未完成。验证与当前包见 docs/windows-alpha6-cold-anchor.md。

2026-11-10 Windows 原业务回执冷核对：在原宿主终止、原Job／stdio／journal和工具处理记录核验后，显式关联原文档operation、发布receipt／candidate、message／todo／work投影、冻结对象及本机prepared恢复记录；检查点前后重新核对。未送达回复仍未决，pending只观察，不合并或重放。默认托管入口及完整冷接管未开放，见 docs/windows-alpha6-business-receipts.md。

2026-11-10 Windows 工具处理持久记录：显式 registered launch 在调用前先登记原工具身份，处理返回后持久精确结果，再向原 Pi 回复。冷检查区分未返回与已返回未送达，检查点前后复核 SQLite 原记录，缺行／并发赢家／UNKNOWN 不重放。正常文档修改和成果发布关联既有业务回执；业务 pending／projection／owner 冷接管与默认执行仍未完成。见 docs/windows-alpha6-tool-custody.md。

2026-11-10 Windows 强杀后journal前缀：Windows Pi启动／prompt／flush原生同步快照携带File ID、摘要与长度；原宿主退出且完整Job／stdio停稳后，可核对无stop路径的原确认前缀。尾部字节保留为未知，不截断、不重放；有工具效果但无回复仍需业务协调。完整journal、业务接管和默认托管入口仍未资格化，见 docs/windows-alpha6-abrupt-journal.md。

2026-11-10 Windows 原始请求／journal 冷核验：逐项匹配原宿主 stdin RPC、原 Pi stdout 返回值、原生 journal entry 和精确输入摘要；缺回复保留 execution-unknown，host tool 回复只证明传递、不证明业务效果。显式 inspectJournals 检查点在真实 SQLite CAS 前后重新核对 journal／metadata 与原生来源；默认托管入口和业务接管仍未开放。详见 docs/windows-alpha6-journal-reconciliation.md。

Windows 原生宿主启动集合（2026-11-10）：每个项目 host lease 在启动意图落库前向原生匿名 mapping 追加 launch UUID；supervisor 保留原启动集合；v9 helper 另持原 mapping 的原生写访问，仅在原 host 退出后以 Interlocked 单向仲裁 anchor 领取，冷客户端仍只取得 FILE_MAP_READ 和受限 HANDLE。完整集合最多256条且不可删除，超限在分配新进程前拒绝；未完成、漏行或替代身份保持拒绝。该证据仅覆盖原项目 host lease，不授权业务 owner 接管、任务重放或默认 ManagedProjects。当前协议为 v9／launch-set v2（本批实际重建，拒绝旧版，不回退），必须与同批 addon/helper 配套；详细结果见仓库 docs/windows-alpha6-launch-set.md。

Windows managed 冷恢复前置进一步补齐原生 helper 对已观察后代进程的持续 HANDLE 保留，以及新冷连接的只查询／等待传递；漏观察的短命成员仍拒绝完整进程实例资格。新增显式检查点核对当前已登记 Job、原输入／输出完整摘要和来源版本，复用本机 SQLite CAS／UNKNOWN；不把当前 owner 行列表当作完整历史启动集合，也不接管任务、释放资源或重放输入。生产默认选择、整宿主启动集合证明及 pending／工具／投影恢复仍未完成，见 [冷恢复前置记录](../../docs/windows-alpha6-cold-checkpoint.md)。

Windows managed 原生接入新增实际桌面 profile／项目分离布局：宿主来源按原登记存储逐路径授权，执行证据支持跨根原生读写；显式 Workspace 工厂绑定原 storage 与 instance/runtime。永久回归保留单根实验布局并增加分离根的真实 Controller／Pi／Git 任务流程。生产默认选择和冷恢复尚未开放，详细边界与本批验证见 [managed 分离目录记录](../../docs/windows-alpha6-managed-roots.md)。

WorkChanges 的隔离 Git 子进程支持长 ref；Windows 私有成果仓库目录的 UTF-8 路径达到 248 字节时，因当前随包 Git 的初始化／cwd 限制，在创建归档及 intent 前明确返回 `CHANGES_PATH_UNSUPPORTED`，保留原任务、候选和草稿。

本地 Windows x64 整合基线：官方 `v0.1.0-alpha.6`（`9a2466a`）与已合并的 PR [#27](https://github.com/SeemSeam/nozeli/pull/27)，当前上游固定为 main 合并提交 `cb07c5180c85ca0e127ddc332089300498103cc5`（最终 PR HEAD `b72e744`），再保留 Windows 改动。最终 PR 的 15 文件安全修正已迁入；检查点隔离 Git 调用另启用 Windows 长路径，避免正常私有 profile 下 UUID 暂存路径仍超过 MAX_PATH。前批已实际重建 Windows 文件／进程组件、Pi、PPTist 与 renderer；本批 renderer 重新构建，Windows 原生输入及二进制逐摘要复核，没有把未重编写成新构建。完整结果与分批证据见 [Windows alpha.6 整合记录](../../docs/windows-alpha6-integration.md)。当前平台的项目语义整理与永久重置明确拒绝，完整 W0–W5 资格尚未完成。

Electron 桌面阅读、批注、编辑与受管 Pi 协作应用。本独立整合分支保留前台／主控／Worker 三角色，不改已发布 tag 或已安装版；回归与边界见 [Pi 整合记录](../../docs/pi-integration-execution.md)。

Linux x64 保留既有验证；本机开发新增 **macOS arm64** 原生文件锚定、F_FULLFSYNC 持久化、进程身份／回收与独立 `.app` 打包。Mac 已实际启动并验证合成项目阅读、Command-S 保存、项目 zsh 终端与正常退出；这不是全功能或公开发行资格认证。Windows x64 原生开发改动已迁入本地 alpha.6 整合树；本轮构建及回归结果单独记录，尚不具备完整产品资格。

- Mac当前开发基线 `v0.1.0-alpha.6`（`9a2466a847267620747b79f9c1b97fbac8f00280`，分支 `macos-alpha6`，工作树 `/Users/bfly/nozeli-macos-alpha6`）；旧工作树 `/Users/bfly/nozeli` 保留。新包 `dist/Nozeli-0.1.0-alpha.6-macos-arm64-verified/Nozeli.app` 位于新工作树，完整默认回归和初始化／重置／任务限定实测见[记录](../../docs/testing.md#alpha6-macos-本机迁移与验收2026-11-09)。后文旧 `dist/macos-*` 路径保留为alpha.5历史，不是当前包。
- alpha.6 Mac专用验收：`NOZELI_TEST_BINARY=<app>/Contents/MacOS/Nozeli npm run test:macos-alpha6`，顺序运行受限项目初始化／拒绝取消冷恢复、合成项目明确永久重置／PTY停稳、双任务与只读过程工作区。重置脚本只处理其新建fixture，禁止替换为日常项目路径。新增chain合同回归：`node --test tests/platform-chain-boundaries.test.mjs`。首次npm安装若当前脚本许可策略跳过Electron/dugite安装，必须显式执行其锁定包内安装器；不使用旧运行时回退。

Windows 的历史证据及 W0–W5 未完成项见 [第二阶段交接](../../docs/platform-phase2-handoff.md)；历史 alpha.5 通过项不代表当前 alpha.6 已通过。

## 前提

- Linux x64 桌面会话，或 macOS arm64 与 Xcode Command Line Tools（`xcode-select --install`）。
- Node.js 22+、npm、Git。
- Pi SDK 固定 1.4.0，pi-gui 驱动固定 commit；不需要系统 Pi 或 Bun。开发期由 Node 构建私有运行环境。
- Node 原生编译工具链与 Electron 44.9.1；`npm ci` 的 `postinstall` 用锁定的 `@electron/rebuild` 重建 `node-pty`。Mac 原生 helper 另由 `npm run build:macos-native` 编译，需要 Node-API 头文件（Homebrew Node 自带，或通过 `NODE_HEADERS` 指定）。
- 可选系统依赖：`bubblewrap`（仅显式启用隔离时需要，不声明普通执行已沙箱隔离）；`latexmk`＋XeLaTeX/pdfLaTeX/LuaLaTeX 或 Tectonic（TeX 编译）；TexLab（TeX 补全）。Pi 会话没有 PTY 接管入口。

## 构建源码

在 `apps/desktop` 下：

```sh
npm ci                 # 安装依赖并为 Electron 重建 node-pty
npm run build:pptist   # 构建内嵌 PPTist（vendor/pptist）
npm run build:pi       # 安装锁定 Pi 依赖并构建 vendored pi-gui 驱动
npm run build:renderer # 构建渲染层到 dist/renderer/
npm run build:macos-native # 仅 Mac：编译文件／持久化 helper 与进程事实工具
```
私有 Pi 源码、46 项上游文件摘要、三份精确补丁与依赖锁位于 `integrations/pi`。默认会话为独立 Node owner，既不调用系统 CLI，也不依赖旧运行时；源码与验收记录见 [Pi 整合记录](../../docs/pi-integration-execution.md)。依赖、构建产物与运行 profile 不进入 Git。

Git 下载受限时，`NOZELI_PPTIST_ARCHIVE` 可指向固定 revision 的原始 `git archive --format=tar` 文件；构建仍要求脚本内的固定 SHA-256，不接受摘要不同的 GitHub tarball。坏缓存会在解包和修改已有 vendor 构建前拒绝。

Windows 原生开发使用兼容 Node 22.x ≥22.22.2、Python、Visual Studio C++ Build Tools、Windows SDK 和锁定 node-pty 要求的 Spectre 库。系统工具安装需要用户授权；缺 MSVC 时 `npm ci` 会明确失败，不能以 `--ignore-scripts` 代替。`tools/windows-native-probe.ps1 -EvidenceRoot <专用合成证据目录>` 可独立收集 Win32 文件原语事实，它不是产品 adapter，也不代表 W1 已通过。

W1 Node-API 文件实验的源码、独立构建和测试入口见 [native/windows](native/windows/README.md)。它使用 Win32/NT 父句柄逐级打开，支持独占暂存、文件同步、无覆盖发布、创建时的私有 DACL 及实验性 TxF 条件替换；替换时验证 owner/group/DACL 保留。当前未接入产品能力选择器；`npm run build:windows-native` 与 `npm run test:windows-native` 为显式组件资格入口，测试会在 Node 和 Electron Node 模式运行同一组场景，包含真实 30 秒事务超时。TxF 在未来 Windows 可能不可用，失败时拒绝操作。现有 postinstall 保持原有 node-pty 重建。

实验 adapter 已在显式 scope 下验证共享读取/Git 捕获、快照/审校/安装、私有目录/SQLite/材料、双选项登记/恢复、Work/index/ref、WorkChanges 归档和直接 Workspace/SessionIndex 报告/用户接受/集合 CAS 账本。当前完整组件源码及中文空格 ZIP 解压后的 Node/Electron 各 264/264；外部赢家、草稿、未知 pending 与提交后不确定事实保留。Workspace.open/Controller/实际宿主与 Worker owner/Job/停稳、依赖资源复制、Plan Tree/worker-home、三个事务组、路径/mode/元数据及 namespace/断电仍待资格化。生产 selector 禁用、W1 unsupported、managedExecution.ready=false；真实 UI 与整应用包尚未验收。存储安全沿用材料批历史的定向 27/27 与完整 27 pass/7 fail，本批未重跑。

另有固定父目录 flush 与 root-scoped 持久化接入原型，验证文件/目录屏障及发布后失败的已提交结果保留。它报告 `barriers-completed`、`namespace-not-qualified`，尚不能替代共享生产 `durable` 合同；不因组件通过而启用 Windows 持久化能力。
- 原生 Pi 路径回归：`node --test tests/pi-native-tools-live.mjs tests/pi-lifecycle-live.mjs`；只用隔离本地 HTTP Provider，实际运行 SDK、文件工具与 Node owner，不代表付费模型质量或真实 OAuth 登录验收。

## 运行

```sh
npm run start:pi-isolated
```

本整合候选优先用 `start:pi-isolated`：先构建 renderer，再启动真实 Electron，配置与singleton隔离在本仓库 `.runtime/pi-development`，不会连接日常安装profile。该开发入口已实际验证启动/退出；图形平台优先DISPLAY/X11，再WAYLAND_DISPLAY，也可显式 `NOZELI_OZONE=wayland|x11`。不要把尚未验收的候选直接指向个人业务项目或日常profile。

- 普通启动使用同一 OS 用户的 Electron 单实例锁，重复启动退出并把打开请求交给已有实例。`NOZELI_TEST_INSTANCE=1` 是隔离测试例外，不是普通用户启动方式；测试必须同时隔离配置与合成项目。
- 应用元数据默认在平台用户数据目录；项目内容、批注与修改账本保存在项目目录的 `.nozeli/` 下。

## 测试

- `npm test` 运行显式注册的 unit + integration；真实 Electron 与真实 Pi owner 分开执行，不能把逻辑测试计作 GUI 或原生内核验收。
- 原生 Pi：`npm run test:live`（需显式 `NOZELI_TEST_LIVE=1`）；真实 Pi GUI：`npm run test:pi-gui`；其余文档、编辑器、TeX、文件树与 Work 回归按 `package.json` 的显式脚本执行。已退役的 OMP TUI 适配器用例不计作 Pi 验收。
- 普通测试使用合成 fixtures、真实临时文件与真实 Electron 宿主，**不发起付费模型请求**，也不读写用户项目或凭据。
- 测试名前缀 `live` 本身不代表会访问真实模型：部分脚本用本机确定性模型，部分需要真实账号。运行前阅读各脚本的环境准入与说明；真实账号检查必须显式授权，不把脚本模型结果当作公网模型质量验证。
- Pi 原生路径回归：`node --test tests/pi-native-tools-live.mjs tests/pi-lifecycle-live.mjs`；只用隔离本地 HTTP Provider，实际运行 SDK、文件工具与 Node owner，不代表付费模型质量或真实 OAuth 登录验收。

测试输出（截图、日志、临时 profile）写入忽略的 `.test-output/`，不进入 Git，也不属于发行物。

## 本机开发与打包（macOS arm64）

完成上述依赖、PPTist 与 Pi 构建后，在 `apps/desktop` 下：

```sh
npm run build:macos-native
npm run start:pi-isolated
# 原生构建 + renderer + 独立 app（默认仓库 dist/macos/Nozeli.app）
npm run package:macos
# 自定义新输出目录：先构建原生与 renderer，再执行
node tools/package-macos.mjs /absolute/new-output-directory
```

- 输出已存在的 `Nozeli.app` 会拒绝覆盖；迭代时选新的输出目录。开发入口与产物均不修改 `/Applications`，不自动提交或推送。
- 应用图标统一使用透明留白、抗锯齿圆角资源：`node tools/build-app-icons.mjs` 从未修改的 `assets/brand/nozeli-paired-tabs-icon.png` 生成原生图标 `assets/nozeli.png`（1024px）和界面图标 `assets/brand/nozeli-small-icon.png`（256px）；renderer构建复制小图标，Linux安装入口和原生窗口读取原生图标，Mac Dock与ICNS也共用该原生图稿。Mac打包生成16至1024像素ICNS并写入 `CFBundleIconFile=Nozeli.icns`，生成失败中止打包，不回退Electron默认图标。品牌原图／README宣传图不改变。
- 包内自带 SHA-256 锁定 Node 22.23.4、Git 2.53.0、Pi SDK；无需依赖用户安装的 Node/Git/Pi。原生 `.node` helper 与进程工具随包携带，缺失时明确拒绝，不放松安全边界。
- 签名仅 **ad-hoc**，无 Developer ID、无公证、无自动更新验收；不应当作已完成审计的公开安装包。macOS 沙箱隔离和外部系统终端接管仍明确不支持，普通 Agent／内置项目终端以当前用户权限执行。
- 本机专项：`node tools/platform-probe.mjs --no-isolation --pretty`；文件／耐久性回归 `node --test tests/platform-filesystem.test.mjs tests/platform-persistence.test.mjs`；真实 Pi 本地夹具 `node --test tests/pi-native-tools-live.mjs tests/pi-lifecycle-live.mjs`（Linux bubblewrap 专项在 Mac 跳过）。隔离临时根使用 `realpath(os.tmpdir())`；不要将 `/tmp` 符号链接当作安全锚定根。
- 真实包 GUI 串行终验：`NOZELI_TEST_BINARY=/absolute/Nozeli.app/Contents/MacOS/Nozeli npm run test:macos-ui`，依次覆盖连续快速打开、分屏／独立窗／正常重启与未保存稿、Office编辑保存／副本导出／冲突恢复。单独入口为 `test:macos-quick-open`、`test:macos-workspace`、`test:macos-office`；不可并发争抢同一 Mac 图形焦点。Office导出目的地选择被自动化，原生saveDialog本身不算验收。
- 完整默认回归使用 canonical 临时目录：`TMPDIR=/private/tmp npm test`。平台专属跳过单独报告；默认套件通过不等于真实模型OAuth、管理员提权、完整Office保真、TeX系统工具链、Mac自动更新或公证通过。最终覆盖与原件见[测试说明](../../docs/testing.md#macos-真实-nozeli-项目全面验收2026-11-06)。

## 显式继承本机 OMP API 与静态 key

在 `apps/desktop` 下，先正常退出 Nozeli，再执行：

```sh
# 只预览脱敏计划；--discover 仅访问模型列表，不调用推理
npm run import:omp-api -- --discover --adopt-default
# 明确落盘；三角色采用 OMP modelRoles.default（须在导入目录中）
npm run import:omp-api -- --discover --adopt-default --apply
```

源由 OMP profile／agentDir 规则解析，目标是 `~/.Nozeli/pi/models.json` 与角色默认文件（0600）。仅显式运行，不在启动时自动读取 OMP；不修改原 OMP 配置，不执行命令型 key，不迁移 OAuth。支持三种现有 Pi API 协议及共同兼容开关；已有同名不同配置拒绝覆盖。没有 `--discover` 时仅用显式模型或同源默认模型；模型列表失败的源跳过且不启用。导入后重启应用。`--adopt-default` 明确覆盖三角色默认，不传则保留默认配置。模型列出仅证明目录可读，不证明推理授权或任意 OMP 协议特性兼容。



## 本机安装与打包（Linux）

安装根为 `~/.local/opt/nozeli`，通过 `current`／`previous` 指针管理版本；受管 release 必须是自有真实目录，激活指针由安装工具维护。

```sh
# 构建 renderer、打包、校验并原子激活为 current（保留一个 previous 回退）
node tools/install-local.mjs
# 重新激活已存在的 release，不复制第二棵运行时树
node tools/install-local.mjs --existing-release <label-或-绝对路径>

# 独立候选快照：校验但不改动 current、启动器与菜单
node tools/package-candidate.mjs <unique-label>

# Linux x64 便携归档（要求源码树已全部提交）
node tools/package-portable.mjs <绝对输出目录>

# 保留策略清理：预览或执行，仅处理本工具标记的自有 release 目录
node tools/release-retention.mjs --dry-run
node tools/release-retention.mjs --apply
```

- 激活前对 release 做完整性校验（符号链接、可执行／主进程／renderer、私有 Pi 输入摘要、独立 Node 与捆绑 Git）；校验或构建失败不删除已安装版本、不激活半成品。本轮 Build Tools 已获授权并完成安装；签名、发行和日常安装仍未执行。
- 清理保护未知目录、外部/符号链接 release 与仍在运行进程对应的版本；`--dry-run` 输出完整保留／删除清单，先用它审阅。
- 安装切换不热替换运行中的旧进程：旧窗口正常退出后重开才加载新版本。
- Windows 安装与打包未实现；macOS 使用上面的独立本机开发入口，不使用 Linux current/previous 安装器。
- 便携包流程与已发布的 [`v0.1.0-alpha.1`](https://github.com/SeemSeam/nozeli/releases/tag/v0.1.0-alpha.1) 预发布附件一致；公开分发的第三方许可与对应源码义务审计未完成，发布不是合规认证，见[发布说明与发行边界](../../docs/release.md)与[合规清单](compliance-inventory.json)。

## 关键产品契约（开发时保持）

- 保存本地批注不派工；只有显式发送才冻结材料交接（来源、版本、选区与上下文）。
- 普通文件保存不产生 Git 提交；仅用户显式接受后台 Work 才执行受管合入，无自动 push／reset／stash。
- 文件写入带摘要基线与冲突检测；外部变化显式提示，绝不静默覆盖未保存编辑或把未知外部修改冒认给 Agent。
- API 密钥仅存 Nozeli 私有 Pi 配置（mode 0600）与 Pi 认证存储，设置读取接口不回传。
- 运行数据、账号、密钥、个人文件与生成的二进制不入 Git；上游依赖固定版本／哈希，构建失败不回退旧本机源码或二进制。

材料对象库现复用共享 MaterialStore CAS 流程，显式 root 下使用多读者只读 HANDLE、私有父目录策略 pin、排他 stage/no-replace 发布和文件/目录屏障，覆盖项目/恢复对象及离线提升。材料批新增 22 项；该批完整源码/解压双宿主各 223/223。未知临时对象保留、损坏赢家不修复、发布后故障报告 committed/uncertain。证据 `W1/material-hosts-final/`、`W1/material-component-roundtrip-final/`；完整 Work/W2 owner/真实 UI/W5 应用包与生产持久化继续未验收。

## Windows 共享 Work 组件续批（2026-11-02，历史 244 项）

在 `experimentalWindowsRoot` 与实验 filesystem 的显式注入下，现复用共享 `ExecutionWorkspace`，完成真实 Git worktree 准备、输入冻结、候选发布、SQLite 报告回执、类型化合入授权核对、接受/放弃、文件与 index/ref 更新、清理以及显式冷恢复。新 `execution-workspace-io.mjs` 只抽出平台文件效果，默认路线保留原共享逻辑；生产 selector 未启用。测试使用真实 ProjectStorage 登记、SQLite 与随包 Git，以及最小合成 store，**没有经过完整 Workspace.open、Controller、业务决定账本或实际 Worker 进程**，回调 `isActive` 不能证明 W2 停稳/归属。

Windows 文件效果提供私有 manifest 读取/CAS、固定源 HANDLE 的排他证据复制、完整卷号/128 位执行目录身份及 Git 锁身份。Git 元数据父目录保留实际 ACL，不修复为私有；仅自有锁文件要求受保护 user-only 策略。锁的完整 File ID 在创建 HANDLE 释放前写入 intent，恢复同时核对 ID 与 token；复制 token 不能接管替换锁。index/ref 使用已批准摘要和锁内版本 CAS，保留独立赢家、用户 staged/磁盘/恢复草稿。

提交后屏障失败/未知结果保留 candidate、实际字节、全部自有锁与 recovery-held 事实，只由显式冷 `finish` 重核版本后继续。真实宿主分别在 locks-held、files-installed、ref-published 退出后可冷恢复同一 commit。额外竞争测试揭示：已安装文件的冷恢复若未取得全部锁，原异常分支会尝试回滚；已修正为直接保留现场并拒绝。修复前日志 `W1/work-lock-recovery-before.tap` 为 1 fail，修复后 `W1/work-lock-recovery-after.tap` 为 1 pass。未提供任何依赖/准备资源声明的冻结输入可返回真实空供给报告；声明了 payload 的项目仍拒绝 `DEPENDENCY_PLATFORM`，未伪造可用模块。

新增 `windows-native-work-lifecycle.test.mjs` **21 项**，完整组件源码及中文空格 ZIP 解压后的 Node 22.23.4 / Electron 44.9.1 Node 模式均各 **244/244**，无失败、跳过或取消。native SHA-256 `24c50e7a9acf52fd77328621c676dc71020efaf0287bc232e3ef55a9ad342eda`；构建退出 0，日志 `W1/build-windows-native-work-first.log`、收据 `W1/build-windows-native-work.json`。当前证据 `W1/work-hosts-final-v2/native-filesystem-hosts-validation.json`、`W1/work-component-roundtrip-final/component-roundtrip.json`，包括实际运行命令、宿主与源码摘要。早期 243 项双宿主通过是补充恢复竞争用例前的历史结果。共享材料/能力/文件/持久化重跑共 38 项：23 pass/15 平台 skip/0 fail，日志 `W1/shared-work-gates-final.tap`；存储安全沿用材料批的 27 pass/7 fail（完整文件）与定向 27/27，本轮未重跑，不外推为当前完整产品通过。

范围继续限定显式入口、本机 NTFS、现有父目录与 100644。普通回调/检查点故障与真实宿主退出、关闭父 HANDLE 的提交后故障分别标识；后者不是磁盘 I/O、断电或原生 UNKNOWN 注入。Git 清理仍是完整 ID/候选核查后的共享 `git worktree remove --force`，没有新增整树原子 HANDLE 删除合同；恶意清理窗口竞争未验收。依赖/准备资源复制、hooks 接受、legacy 迁移、扩展 Git 布局、路径/mode/安全元数据、TxF 产品可用性政策、完整 namespace/断电仍未资格化。

下一批优先接 `WorkChanges` 私有 archive intent/manifest 与完整业务报告/决定账本（当前仍调用全局 unsupported persistence），再补依赖/准备资源原生复制及三个多步事务；W2 原生 incarnation/Job/来源停稳证明是完整 Worker 与外来恢复链的依赖，之后才进入 W3 能力决定、W4 真实 Electron/Pi 工作面与 W5 整应用便携包/干净环境。W1/W2/W3 仍 unsupported，W4/W5 not-run，managedExecution.ready=false。

## Windows WorkChanges 与共享业务账本续批（2026-11-02，当前）

新增 20 项，当前源码/解包双宿主各 264/264。显式 root 下接通私有 archive intent/manifest CAS、完整证据库 File ID、保留只读 pack 的目录屏障及精确 HANDLE 清理；直接共享业务方法已验证 HTML 报告/归档/接受授权和冷重载合入、集合 CAS/草稿保留、显式 inspection-only 恢复。完整 Workspace.open/Controller/进程资格仍待 W2，尚未启动产品工作面。详细范围见 `docs/platform-phase2-handoff.md` 最新章节；证据 `W1/work-changes-hosts-final/`、`W1/work-changes-component-roundtrip-final/`。native 产物复用上一批，未新编译；只读树不声明原生文件 flush。

## Windows W2 进程身份首批（2026-11-02，当前）

新增独立 `native/windows-process` Node-API 组件和显式 `experimental-process-identity.mjs`。只读、非继承 HANDLE 固定进程对象，保存精确 100 ns FILETIME 字符串，以同一 HANDLE 的 signaled 状态观察该进程退出；真实退出码 259 与 STILL_ACTIVE 已区分。无法打开的 PID 明确报错，不推断整树退出；结果始终 `treeExitVerified=false`。不 spawn/终止/取得 owner/释放预算或 writer，共享 selector 不变。

实际重建 `W2/build-process-identity-final.log`，回执 `W2/build-process-identity.json`；native SHA-256 `aa5c1a6ad10831768038aa9b554f61530eafb441b08ad70004831ed42a5ec125`。独立组件源码及中文空格 ZIP 解包的固定 Node 22.23.4、Electron 44.9.1 Node 模式各 13/13，零失败/跳过/取消，证据 `W2/process-identity-roundtrip-final-v2/process-component-roundtrip.json`。测试含真实正常退出、退出码 259、两个 incarnation、无关哨兵，以及 leader 退出而显式 detached 后代仍运行；后代由合成 stop 文件自行退出。第一包 Node 13/13、Electron 12/13 的原夹具后代也已退出，失败原件保留，不能视作 Electron 全树回收证明。改为 detached/无管道依赖/文件握手后四组通过。

设计与后续顺序见 [Windows 进程决策记录](../../docs/windows-process-design.md)：下一批验证执行前 Job 纳管、generation/请求登记、后代继承/脱离/嵌套和宿主崩溃/真实整树停稳，再接共享 owner/冷恢复及 Workspace.open/Controller。创建时间/路径字符串不能代替冷恢复或镜像信任证明。该包使用锁定开发 Electron，仍非整应用。W1 文件桥与 264 项源码/解包资格均未改变；W1/W2/W3 unsupported，W4/W5 not-run，managedExecution.ready=false。

## Windows W2 创建前 Job 纳管续批（2026-11-02，历史批次）

新增原生 `createSuspendedProcessJob` 与显式 `experimental-process-job.mjs`。`CreateProcessW` 用 `PROC_THREAD_ATTRIBUTE_JOB_LIST` 在创建时关联私有未命名 Job，并保持主线程挂起，避免先 spawn 再 Assign 的窗口；不支持/嵌套/权限失败明确拒绝。Job HANDLE 不继承，配置 KILL_ON_JOB_CLOSE，不允许 breakaway。显式本地绝对 executable/cwd、CRT argv 和独立 Unicode 环境块，不回落 shell 或继承宿主环境；尚无 stdio/JSONL 产品接口。

resume 只可一次，取消调用实际 TerminateJobObject；请求终止不是退出确认。query 固定当前成员的完整进程创建身份/HANDLE，终止前再次捕获；只有 leader signaled、Job ActiveProcesses=0、全部已观察成员 HANDLE signaled 才报本地 jobEmptyObserved。close 在未满足时拒绝并保留 HANDLE，超时同样保留事实；异常/GC 只请求内核回收，不冒充业务 stopped。短暂未观察成员会令 allProcessIncarnationsObserved=false，因此不能据此签署全域 owner/冷恢复/资源释放资格。

新增 19 项 Job 场景；连同 13 项身份测试，实际源码与中文空格 ZIP 解包的 Node 22.23.4 / Electron 44.9.1 Node 模式均各 **32/32**，无失败/跳过/取消。真实验证挂起不执行、取消、重复 resume 拒绝、超时保留、Unicode/空字符串/引号/尾反斜线/元字符 argv 与显式环境、未继承合成 secret、中文 executable 路径、无关 Job 哨兵、leader 退出后 detached 后代仍活、原生 CREATE_BREAKAWAY_FROM_JOB 返回 5 且逃逸命令零执行、原生嵌套 Job 及外层终止，以及宿主正常退出/强制结束后 leader 和 detached 后代实际退出、resume 前宿主强退零执行。后代创建时间与 Job 观察成员逐项对应，不按进程名回收。原生 helper 只属于合成测试，不是产品运行时。

证据 `W2/process-job-roundtrip-final/process-component-roundtrip.json`；实际重建 `W2/build-job-final.log` / `W2/build-process-job.json`，native `6649909b1582023f7fddbe79494016e46b882472c8c397a986faf33fa7cdde15`。组件含固定 Node、许可、源码/测试/helper/二进制与逐文件摘要；Electron 明确使用锁定开发宿主，仍非整应用包。首次 `W2/process-job-first.tap` 为 8/10：发现 accounting 归零但已观察后代 HANDLE 尚未 signaled，改为保留并等待成员 HANDLE；另一项错误比较了动态系统辅助进程计数。`process-job-second.tap` 10/10；第三轮 15/17 两项错误期待 ChildProcess.kill 的数字退出码，修正为实际 `[null,SIGTERM]`，第四轮 19/19。失败原件保留。

共享能力/拒绝门定向两文件 19 项：17 pass/2 Linux skip/0 fail，`W2/shared-process-job-selected.tap`。较宽四文件重跑 `W2/shared-process-job-gates.tap` 31 项：19 pass/10 fail/2 skip，失败为既有 Linux /proc mock 在 Windows 调用 getuid，W0 原日志已有相同问题；两项 Pi 测试在 Windows 提前 return，其 pass 不作为原生回收证据。没有把较宽回归称为全通过。

W1 文件桥与 264 项源码/解包闭包未改；原始 13 项身份批为历史，当前使用 32 项合并资格。生产 verified-process-ownership / recovery-source-ownership、W1/W2/W3 仍 unsupported，W4/W5 not-run，managedExecution.ready=false。完整 generation/请求登记与 resume 屏障、stdin/stdout JSONL、Pi/Worker、Workspace.open/Controller、冷恢复/外来来源、所有进程消费点仍待推进；瞬态未观察成员、恶意同用户句柄复制、不可读/持续变化成员及创建后结果发布失败路径未资格化。Job 也不提供隔离。

## Windows W2 stdio 与共享 JSONL 续批（2026-11-02，历史批次）

新增 `process-stdio.inc` 和显式 `experimental-process-transport.mjs`。三个命名管道对均由创建者在创建子进程前连接；protected 当前用户 SID DACL、256 位随机名字、FIRST_PIPE_INSTANCE、REJECT_REMOTE_CLIENTS，实际核对 client/server PID。父端 overlapped，子端标准同步 HANDLE；仅 stdin/stdout/stderr 三个子端进入 `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`，Job/事件/父端不得继承。仍使用创建时 Job 原子关联与 CREATE_SUSPENDED；旧四参数不带管道入口保留。

Node Readable/Writable 使用 64 KiB chunk/highWaterMark 和 2 ms 轮询，遵守读背压、串行处理部分写入。取消先 CancelIoEx，再收取完成结果，内核完成前保留 OVERLAPPED/事件/缓冲区；写入失败只记录已确认字节与 transferUnconfirmed，不自动重放。leader exit、Job empty、stdout/stderr EOF 分别观察；显式 close 要求本地 Job empty，但会丢弃未读输出，产品接入必须先排空并分别判断协议/进程事实。轮询规模和性能尚未做广域资格验证。

共享 `jsonl-reader.mjs` 按原始字节处理任意 UTF-8 分块、LF/CRLF，帧上限 64 MiB；严格拒绝无换行超限、非法 UTF-8/JSON、非对象、空帧、截断 EOF/断连与 handler 故障，一次失败后栅栏后续消息。PiSession.start 改用此 reader，业务 receiveFrame/request 与 admission 继续共享。15 项纯 reader 测试已加入 unit 显式清单。真实原生管道用例调用 PiSession.request/receiveFrame 校验关联，但没有调用 PiSession.start，也没有启动真实 Pi SDK/模型或证明完整 owner 生命周期；Pi owner 自身的入站 reader 仍待接入。

新增 20 项真实 transport 场景，包括 Unicode/空输入/EOF、4 MiB 精确二进制回环、双路各 2 MiB 输出与事件循环进展、读背压、leader 退出后原生后代继续写 tail、pending read/write 终止、阻塞输入取消、实际 EPIPE、分块协议/错误帧，以及宿主正常退出和强退时仍挂起 I/O 的子进程回收。实际重建 `W2/build-stdio-final.log` / `W2/build-process-transport.json`；当前 native SHA-256 `74f881c77491437975dd45418de34a0578b9e82b11a1c3a32112343a210469a2`。身份 13 + Job 19 + transport 20，源码及中文空格 ZIP 解包后的 Node 22.23.4 / Electron 44.9.1 Node 模式均各 **52/52**，无失败/跳过/取消；逐文件源码、ZIP CRC、解包与执行后摘要核对通过。当前证据 `W2/process-transport-roundtrip-final/process-component-roundtrip.json`；此前 13/32 项记录为历史批次。组件使用锁定开发 Electron 宿主，仍非整应用包。

开发日志 `W2/process-transport-first.tap` 保留 11/12：原 Node 后代夹具未按预期继承输出，改为原生标准 HANDLE 继承夹具后仍要求 leader 后 tail 完整到达，第二轮 12/12、第三轮 18/18，新增宿主退出后最终四组各 52/52。共享四文件定向 `W2/shared-transport-final.tap` 为 39 项：37 pass/2 Linux skip/0 fail；不是完整 unit/Linux 回归。上一 Job 批较宽共享回归 19 pass/10 fail/2 skip 的 getuid 平台失败仍保留，本轮未重跑该组。W1 264 项资格闭包和文件桥摘要再次核对未变；未重跑 W1 或历史存储安全全组。

下一步在现有共享 PiSession/Controller/Workspace/Budget 上实现 owner generation 与请求/登记绑定，以及 prepare → durable registration → resume 闸门；不能把 transport 包装成 verified ChildProcess 就放行。现有 onSpawn 在启动后执行，而且 Controller 重新读取 stamp，须先补可验证的平台身份契约。停机须分别等待树、管道、native drain 和业务持久化回执。冷恢复需要重新证明监督租约/项目数据库实体与来源，不能从旧 PID/字符串或未命名 Job 猜测停稳。恶意同用户管道/句柄/访问竞争、未观察瞬态成员、创建后发布失败及断电域仍未资格化。W1/W2/W3 unsupported，W4/W5 not-run，managedExecution.ready=false，生产能力矩阵未变绿。

## Windows W2 共享登记后放行续批（2026-11-02，历史批次）

新增共享 `prepared-owner-launch.mjs`、本机 `owner-launch-registry.mjs`，并提供 PiSession.prepareRegisteredOwner 显式组件入口。复用现有会话 epoch/ownerId、原生 transport 与 SQLite worker 的 revision CAS/操作回执/原生数据库 lease：先持久 intent，再同步取得挂起 child/身份并安装共享监听，持久 prepared incarnation 登记确认后，再次核对会话代次、target/current guard 和同一 HANDLE 身份，最后唯一 resume。登记表位于本机 ui.sqlite 的专用 managed_owner_launches collection，不写入可移植项目集合，也不把 providers 普通缓存当并发 CAS。

任一 owner 换代、停止、登记失败/丢回调、实例变更或回执后 lifecycle seal 均拒绝放行；实际 resume 返回丢失也不允许重试。输入在未放行/协议失败/启动失败后被栅栏。共享 AgentProcessBudget 观察 prepared，并在存在 launchAttempt 时拒绝走 never-spawned 释放分支；PiSession.stop 在此未完全资格化的组件路径只请求本地终止并保留登记/额度，仍返回 PI_EXIT_UNCONFIRMED，不将局部 Job empty 冒充完整 confirmationComplete。本机注册器尚无删除、采纳或自动重放接口。

18 项新增真实组件测试覆盖：挂起阶段 marker 零执行、真实 SQLite intent/prepared 回执后执行和 Pi 请求关联、本机单 target CAS 赢家、独立进程写入的新赢家保留、generation/target 换代、等待实际登记回执时取消、intent/prepared 两个实际提交点受控丢回调、失败创建、重复启动、实际 resume 后受控丢结果、伪造 receipt/非法身份拒绝、共享协议错误回收、受控实例漂移/实际提交后的 lifecycle seal，以及宿主正常/强退后冷登记保留和零执行。宿主退出场景保留 parent 已打开的实际 leader HANDLE 并观察退出；不外推冷整树来源证明。

实际进程桥重建 `W2/build-owner-launch-final.log` / `W2/build-owner-launch.json`，当前 native SHA-256 `bede2043f695d373dffdb3661d0f96466e940c85ec6cc6c9161668344d6c0d58`。身份 13 + Job 19 + transport 20 + 登记放行 18，源码与中文空格 ZIP 解包的 Node 22.23.4 / Electron 44.9.1 Node 模式均各 **70/70**，无失败/跳过/取消。证据 `W2/owner-launch-roundtrip-final-v2/process-component-roundtrip.json`。解包包同时包含固定 Node/许可、未变的 W1 文件桥、模块/worker 依赖闭包、package-lock 与实际锁定 @lezer 依赖包/许可；ZIP CRC、执行前后源码/解包摘要均通过。仍使用锁定开发 Electron 宿主，不是整应用包。

共享四文件定向 `W2/shared-owner-launch-final.tap`：39 项，37 pass/2 Linux skip/0 fail；既有预算 unknown-native-exit 单项 `W2/shared-owner-budget-selected.tap`：1/1，不声明整个预算/Controller 或 Linux 套件通过。W1 264 项源码闭包与原 native 摘要再次核对未变，本轮未重跑 W1全组。首轮 owner-launch-first.tap 为 13/15，两个夹具错误期待字面量反斜线 n，修正为实际换行后 second 15/15；扩展场景后首包源码 Node/Electron 各69/69，解包因遗漏 @lezer/html 拒绝；补锁定依赖后第三包四组69/69，但运行期间源码变动令最终摘要检查正确拒绝整轮。全部失败日志保留；最终冻结后重建/打包四组70/70才作为当前证据。

此批没有把 prepareRegisteredOwner 接进正常 PiSession.start/Controller，也未伪造 verified=true。精确 home/runtime 文件身份、共享宿主锁、真实 Pi SDK/Worker/journal/完整 stop、冷监督租约/来源、其他终端/TeX/force-quit/helper 和恶意同用户竞争域仍待推进；当前 registry 保留策略还不能支撑用户连续启动/重启产品闭环。下一步将当前真实登记回执接入共享 Controller 启动/回收与 PiSession.start，补 W1 私有 owner-home/固定 runtime 资源绑定，在完整 owner 退出和冷来源具备证明前继续保留资源。W1/W2/W3 unsupported，W4/W5 not-run，managedExecution.ready=false，能力矩阵未变。

## Explicit Windows Pi owner qualification (2026-11-02)

Normal PiSession.start and a scoped shared Controller.makeSession now consume an explicit branded Windows launch service: native private directories/runtime pins, local SQLite registration and provider persistence before resume, private metadata CAS and native journal file/directory flush. Nine actual Pi SDK/loopback-provider cases include exact Unicode delivery, cancellation without replay, native read, digest rejection, concurrent metadata preservation and retained unconfirmed budget. Source/extracted Node22.23.4/Electron44.9.1 each pass79/79. Receipt: W2/pi-owner-roundtrip-third/process-component-roundtrip.json; actual Pi build: W2/build-pi-owner-final.log. Run the explicit suite with NOZELI_TEST_LIVE=1 and node tools/test-suites.mjs windows-pi-owner; qualify the packaged dependency closure with --with-pi on tools/qualify-windows-process-component.mjs.

The ZIP includes actual Pi production dependencies/licenses, role resources and pinned Node; Electron is the declared development host. This is not an application package. Tests construct a real scoped Workspace component, not Workspace.open/host locking. Full SDK journal/lease/stop/cold recovery, registry release/restart, Worker/product flow and other consumers remain unqualified. stop preserves PI_EXIT_UNCONFIRMED, registry and budget. Default capabilities stay disabled; W1/W2/W3 unsupported, W4/W5 not-run. See docs/windows-process-design.md for exact scope and retained failure history.

## Same-host owner exit and warm resume qualification

The explicit Windows Pi service now retires the exact local registration only after a final SDK journal acknowledgement, retained Job/all-incarnation waits, both output EOFs, clean protocol, bounded host/native drain, pinned journal identity/digest and native barriers, and revision CAS with postchecks. An opaque proof binds the actual native-created transport; forged summaries and cloned registrations refuse. Shared budget/provider cleanup occurs after confirmation. Actual Controller warm resume preserves the original thread and does not replay accepted input. Only the current live registry's confirmed retired receipt permits the next CAS launch; cold records remain fenced.

Source/extracted Node22.23.4/Electron44.9.1 each pass91/91 (13 identity,19 Job,22 transport,18 registration,19 actual Pi). Receipt W2/owner-exit-roundtrip-first/process-component-roundtrip.json; actual Pi build W2/build-owner-exit-final.log. The native C++/binaries are unchanged and reuse matching actual build receipts. Crash without acknowledgement, unobserved transient members, changed journals, unknown commits/postchecks and unsettled projection preserve registration/budget. Host locking/cold supervision/recovery, full SDK journal/lease domains, Worker/product and app packaging remain unqualified; namespace remains not-qualified and selectors stay disabled. See docs/windows-process-design.md for retained failure history.

## Explicit host custody prerequisite qualification

The explicit Windows host lease retains the existing native private-file/database/parent/process pins, a shared-project immutable anchor and local SQLite host generation. The shared launch registry synchronously retains launch claims, binds hostLeaseId, and checks host admission and the exact prepared record before resume. Actual Pi/native proof retirement alone clears a claim. Host retirement checks confirmed owner receipts, revision CAS and postchecks; unknown replies or changed winners retain custody. Cold records, cloned/old receipts and another profile never authorize activation. Only an exact unused live release receipt permits explicit host lease reacquisition, without adopting old owner registry records.

Source/extracted Node22.23.4/Electron44.9.1 each pass115/115:13 identity,19 Job,22 transport,18 registration,21 host,22 actual Pi. Actual scoped Controller warm resume uses host custody; actual host exit/force termination preserves old host/owner rows and drafts with one model request and no replay. Receipt W2/host-lease-roundtrip-final/process-component-roundtrip.json; native rebuild W2/build-host-lease-final.log/build-host-lease.json. Pi runtime unchanged; shared37pass/2Linuxskip and budget1/1. W1 source closure/native bytes unchanged and not rerun. This is not a production Workspace.open/Controller.open, cold supervision/source recovery, full SDK lease, Worker/product or complete app package qualification. Cold acquisition still refuses even retired markers; default capabilities remain disabled. See docs/windows-process-design.md for exact boundaries and retained development failures.

## Native retained Job supervisor qualification (historical batch)

The explicit Windows supervisor receives original Job/leader/host handles before owner resume through an exact HANDLE_LIST. The creator compares actual Job kernel objects. The native helper observes original host exit, terminates the original Job, and serves bounded protected user-SID message-pipe requests. Cold observers verify actual pipe-server PID, retained helper process incarnation, pinned helper EXE entity/hash and original host/leader incarnations before receiving query-only original kernel objects. No numeric HANDLE is persisted or exposed to JS. Unknown endpoints and unobserved historical members never authorize owner release.

Optional explicit Pi supervision binds the endpoint to the real local SQLite prepared record and rechecks supervision before resume. Actual Pi host exit/force termination can reconnect through that record while preserving registrations/drafts and one loopback model request. Source/extracted Node22.23.4/Electron44.9.1 each pass127/127, including12 supervision cases. Receipt W2/supervisor-roundtrip-first/process-component-roundtrip.json; native build W2/build-supervisor-final.log/build-supervisor.json. Shared37pass/2Linuxskip, budget1/1; W1 source/native bytes and Pi runtime unchanged, not rerun. This does not qualify cold business recovery, source/catalog/database custody, full historical members/output/journal, production Workspace/Controller opening, Worker/product or complete packaging. Helper loss stays UNKNOWN; query-only transfer is not a budget/writer retirement receipt. See docs/windows-process-design.md for bounded transfer limits, development failures and residual domains.

## Supervisor host anchor and local database custody (2026-11-02)

The explicit supervisor now retains the original native host anchor, local ui.sqlite and directory chains after host death. A one-use type-tagged W1 bundle passes restricted duplicate handles through a bounded read-only native manifest and exact HANDLE_LIST. Entity/ACL checks and a fingerprint excluding HANDLE values bind the handoff to the endpoint; observed drift remains fenced. No numeric HANDLE reaches JS or persistent registrations. Retained sharing restrictions deny another anchor writer and database/directory replacement after original host exit. Normal Pi retirement observes supervisor shutdown before host release; closing an observation or losing a helper supplies no retirement proof.

W1 was changed and rebuilt: source/extracted Node/Electron each pass264/264. W2 source/extracted hosts each pass134/134, including7 new custody cases and22 actual Pi cases. Evidence: W1/custody-roundtrip-final/component-roundtrip.json and W2/custody-roundtrip-first/process-component-roundtrip.json; final dual builds W2/build-custody.json. Shared regression37pass/2Linuxskip; selected UNKNOWN budget1/1. Full budget suite separately remains unqualified (3pass/12fail through the unsupported production persistence path). Catalog/project.sqlite, full historical members/cold output/journal/business recovery, production opening and complete app packaging remain unqualified. All production selectors stay disabled.

## Native host source binding (2026-11-03)

Explicit host custody now retains the original catalog.sqlite, project.sqlite and read-only project.json alongside the host anchor/local database. Fresh shared SQLite values and revisions are checked around admission/registration; unrelated writes remain allowed. The original helper independently retains the source-record SHA-256 in native manifest v3/protocol v4. Cold inspection rejects coordinated rewriting of source revisions and host declarations, and native reconnect rejects forged endpoint digests. This is observation only: no cross-database atomicity, business adoption, release or automatic replay. Rebuilt W1 source/extracted Node/Electron each pass264/264; W2 each143/143 with the actual Pi runtime. Evidence: W2/source-binding-roundtrip-verified/process-component-roundtrip.json and W1/source-binding-roundtrip-final/component-roundtrip.json. Production gates and full app qualification remain disabled.

## Supervisor output custody (2026-11-03)

The original helper now takes both native read endpoints before resume and retains exact stdout/stderr bytes, EOF and final SHA-256. The supervised transport keeps the shared readable/PiSession interface; native direct reads after handoff refuse. Protocol v5 provides immutable bounded ranges and continues draining while an IPC peer stalls. Combined lifetime retention is capped at64MiB; overflow terminates the original Job and keeps output unconfirmed. Source-bound cold inspection verifies both complete streams and rechecks source/owner generations, but provides no replay or retirement authority. Evidence remains in the original helper's memory and is lost on helper/system exit; cold journal/stop-ack business recovery is unqualified.

Actual W2 source/extracted Node/Electron each pass153/153 including10 output cases and22 real Pi cases. Evidence: W2/output-custody-roundtrip-first/process-component-roundtrip.json, build W2/build-output-custody.json. Unchanged W1 hashes match the prior four-host264/264 batch; it was not rerun here. Shared37pass/2Linuxskip. Production capability selectors, full Workspace/Controller and app packaging remain unqualified.

## Cold original stop and journal observation (2026-11-03)

Explicit Windows prepared launches now bind original Pi responses to ownerId/generation/launchId/home/cwd. Cold inspection verifies the original helper-retained start and terminal stop responses, native journal File ID/SHA-256, metadata, SDK header/entry chain and matching native events while original directory/file pins are held. Invalid/truncated/duplicate/mismatched responses, changed files or competing registrations refuse; drafts and pending owners remain. This is observation only: original host stop-request admission, host projection settlement, historical membership and cold retirement remain unqualified. No replay or release authority.

The actual Pi runtime was rebuilt and manifest hashes checked; native binaries are unchanged. W2 source/extracted Node/Electron each pass160/160, including29 real Pi cases and9 host-death protocol modes. Shared55pass/2Linuxskip; Pi facts/questions14/14. Evidence: W2/cold-journal-roundtrip-first/process-component-roundtrip.json and W2/build-cold-journal.json. Unchanged W1 hashes match the prior four-host264/264 batch; not rerun here. Production selectors and full application qualification remain disabled.

## Original-host input custody (2026-11-03)

Protocol v6 transfers original stdin before resume and closes the host's direct endpoint. The helper retains each bounded chunk before native write, tracks actual completion, seals input with a digest, and rejects stale offsets or replays after UNKNOWN. A separate64MiB lifetime input limit terminates the original Job on overflow. Kernel pipe-peer identity permits input controls only from the original live host; other processes and cold observers can only read retained bytes. The transport keeps the shared Writable/PiSession interface. Cold inspection matches original start/stop request IDs and paths with retained Pi responses and pinned journals. Its stop-request qualification covers native delivery and matching Pi dispatch only; host projection settlement and cold owner retirement remain unqualified.

Actual native rebuild: W2/build-input-custody.json. W2 source/extracted Node/Electron each pass169/169 including8 input cases and30 real Pi cases; selected48/48, shared55pass/2Linuxskip. Receipt: W2/input-custody-roundtrip-first/process-component-roundtrip.json. Pi runtime and W1 hashes are unchanged; W1 prior four-host264/264 was not rerun. Helper/system loss supplies no volatile evidence verdict. Production selectors remain disabled; no replay/adoption/release authority or full app qualification.

## Windows explicit public-open component (2026-11-03)

The shared Workspace.open/Controller.open now accept an explicit branded native I/O adapter: original host custody, immutable runtime/project/database binding, private directories, native SessionIndex objects, Plan Tree SHA CAS and MemoryVersion reads. A real Controller.open test performs one actual Pi loopback turn and confirmed owner/host retirement. Warm reopen requires the original unused same-process receipt; serialized/cold recovery and native Worker archival remain refused. Production selection and the full Worker lifecycle stay unqualified.

W2 source/extracted Node/Electron each186/186 including16 public-open cases and31 actual Pi cases. W1 shared sources changed and were actually rerun: source/extracted Node/Electron each264/264. Shared regression55pass/2Linuxskip. Evidence: W2/workspace-open-roundtrip-second/process-component-roundtrip.json and W1/workspace-open-{source,roundtrip}-first/. Native binaries and Pi runtime match their last actual builds; this batch does not claim a new native build or a whole-app package. Product gates remain closed.

## Windows explicit scheduled Worker flow (2026-11-03)

The shared public Controller scheduler now drives an actual isolated Pi Worker through native document tools, frozen candidate publication, exact human review acceptance and host Git integration. Original owner retirement gates complete private-home archival, including the actual config/sessions journal. A real lost publication callback and independent source/content/directory contenders preserve the archive intent and winners; exact reconciliation performs no second move. All three owners stop before original-receipt same-process warm reopen restores drafts and completed review/Git state without model replay. Archival retains the complete owner home; it does not delete credentials. Cold recovery and production selection remain disabled.

W2 source/extracted Node/Electron each190/190; W1 current shared source/extracted Node/Electron each267/267. Shared regression55pass/2Linuxskip. Evidence: W2/worker-flow-roundtrip-first/process-component-roundtrip.json and W1/worker-flow-{source,roundtrip}-first/. Actual native/Pi build hashes remain unchanged. This is an explicit component ZIP, not the full Windows application package. W1/W2/W3 remain unsupported; W4/W5 remain not-run.

## Windows explicit dependency/prepared-resource provisioning (2026-11-03)

The shared frozen package/lock/resource policy now accepts narrow Windows effects: read-only public-source HANDLE trees copied into exclusive private objects, real content/ID/ACL checks, no-replace publication and barriers. Existing/late targets and source ACLs are preserved. Original allocation-bound cleanup refuses foreign additions; matching old stages and retained UNKNOWN reports block another copy. Real host exit, lost callback and rename-release-window byte changes preserve evidence. Source links/unsupported aliases and oversized trees refuse explicitly. The actual public Controller/Pi Worker flow includes independent modules/resources and real Node import/read in the Worker directory; candidate/review/Git/retirement/archive/warm reopen still pass with three loopback requests.

W1 rebuilt source/extracted Node/Electron each286/286; W2 source/extracted each190/190. Evidence: W1/provisioning-source-final/, W1/provisioning-roundtrip-first/, W2/provisioning-roundtrip-third/. Scope is local NTFS x64 ordinary single-link trees, <=10000 entries/1GiB; namespace durability, source links, stale-stage/UNKNOWN cold reconciliation, production selectors, real desktop and whole application package remain unqualified. W1/W2/W3 unsupported; W4/W5 not-run.

## Windows explicit durable provisioning reconciliation (2026-11-03)

ExecutionWorkspace now checkpoints original provisioning intent, parent/root IDs and observed ACLs, complete copy manifests, publication and exact cleanup progress in the shared Work manifest CAS. Explicit reconcileDependencies can continue the same verified complete stage, verify an already published target without another move, and finish interrupted original deletions. Unacknowledged checkpoints fence subsequent effects; changed bytes/IDs/members/bindings and incomplete copies remain UNKNOWN. Real child-host exits and shared Work/Git recovery pass. W1 rebuilt source/extracted Node/Electron each297/297; W2 each190/190, including actual Controller/Pi Worker flow. Evidence W1/provisioning-recovery-source-authoritative/, W1/provisioning-recovery-roundtrip-second/, W2/provisioning-recovery-roundtrip-second/. Partial-copy recovery, large-workload checkpoint performance, namespace/system durability, owner cold recovery, production selectors, real desktop and full app package remain unqualified.


Windows alpha.6 外部启动已接入私有持久队列：启动参数／第二次启动请求先持久接收；主进程向实际活动文档面发出代次绑定的显示确认，核对读取版本及文本正文后才记录完成。不支持的输入、显示失败、重启中断请求保留，冷启动不自动重放；主窗口“外部打开”提供显式重试、两步移除及持久保存重试。尚未接收的请求明确显示为仅内存保留。验证范围与最新本地包见 `../../docs/windows-alpha6-external-routing.md`；不代表物理 Explorer／IME、全部 Office 恢复或完整 W1–W5 已通过。
# Windows home directory custody qualification

The explicit Windows owner supervisor now retains the original private owner home directory and its parent chain before the owner first resumes. Cold journal inspection and evidence archival compare the helper-held File ID with the reopened home. This qualifies directory identity and policy custody only; complete recovery-material lifetime custody, archive reconciliation, helper disposal and the default managed entry remain incomplete. The native custody ABI is version 4 and supervisor protocol is version 10; older helpers are refused. See `docs/windows-alpha6-home-custody.md` in the repository for actual qualification results.
