# Windows 原生开发 Agent 执行指南

日期：2026-11-01。适用仓库：`https://github.com/SeemSeam/nozeli`。目标：在真实 Windows 上接续第一阶段共享核心，完成 Windows 原生适配和逐门验收；不是另建 Windows 产品分支副本。

## 1. 直接交给 Windows Agent 的指令

将下面这段连同本文件交给 Windows 机器上的编码 Agent：

> 请在当前 Nozeli Git checkout 中执行 Windows 第二阶段开发。先读本指南、`docs/platform-phase2-handoff.md`、`docs/platform-phase1-inventory.json`、`CONTRIBUTING.md` 和 `apps/desktop/README.md`，核实实际源码，不把历史通过记录当本机证据。
>
> 从 W0 环境与源码基线开始，按 W1 文件/持久化、W2 进程/恢复、W3 权限/隔离、W4 Electron 产品工作面、W5 原生包的依赖顺序推进。先调查已有接口、调用者及 Windows 分支，再复用共享业务和 UI 实现 Windows native adapter；不要复制 Controller、Work、会话或文件版本状态机。
>
> 本任务允许在 checkout 内实施源码、行为回归和文档修改，使用隔离合成项目执行本地构建、真实 Windows 文件/进程及 Electron 验证。不授权修改个人资料、导入真实账号、付费模型调用、系统提权/安全策略变更、日常安装替换、签名、发布、提交、push 或合并。需要安装系统工具或进行管理员操作时，说明确切前置条件并请求用户授权，不擅自执行。
>
> 不以 WSL、Wine、Docker、模拟 `process.platform`、交叉打包或 mock 作为 Windows 通过证据。不要为了启动而关掉安全检查、取消持久化屏障、忽略 UNKNOWN、放宽文件访问范围，或把能力矩阵直接改绿。未实现能力必须在副作用前明确拒绝。
>
> 每个验收门先给实施范围和风险，完成后运行对应真实场景并记录证据；有可行动步骤就继续，不能只交付空目录、接口占位或待实现列表。缺少不可替代前置条件时保留现场、完成可达工作，报告准确阻塞；不得把未运行或不支持写成通过。最后更新能力声明、消费点清单、交接文档和 CHANGELOG，交付逐门结果、修改文件、实际命令/退出码及剩余限制。

## 2. 先确认拉到的是正确源码

第一阶段指共享合同和 Linux 实现已落地，不指 Windows 已能启动或安全写入。开发以拉取时的实际提交为准，不锁定本文写作时的 Alpha 版本号。

在 PowerShell 中，新建 checkout 可执行：

```powershell
git clone https://github.com/SeemSeam/nozeli.git
Set-Location nozeli
git status --short
git rev-parse HEAD
git switch -c platform/windows-native
```

已有 checkout：先检查未提交内容与所在分支；仅在确认无冲突且用户允许同步时 `git pull --ff-only`，不 reset、stash 或覆盖已有修改。分支名已存在时复用经核对的开发分支，不强制重建。

必须确认以下文件存在；不存在时查明远端版本或缺少的推送，不凭空补造一套第一阶段合同：

- `docs/platform-phase2-handoff.md`
- `docs/platform-phase1-inventory.json`
- `apps/desktop/src/platform/platform-capabilities.mjs`
- `apps/desktop/src/platform/shared/filesystem.mjs`
- `apps/desktop/src/platform/shared/persistence.mjs`
- `apps/desktop/src/platform/shared/runtime-assets.mjs`
- `apps/desktop/tools/platform-probe.mjs`

记录 HEAD、分支和已有修改。本文在 Linux checkout 创建，未核实远端已经包含本文或全部第一阶段变更；仅拷贝本文到 Windows 不会自动同步对应源码。

## 3. W0：Windows 环境与构建基线

### 开发前置

- 真实 Windows 桌面、普通用户账号。先以本机原生架构为一个明确目标，不把 x64 通过推广为 ARM64 通过。
- Git、Node.js **22.22.2 或以上的兼容 22.x 版本**及 npm。Node 是开发工具；正式用户不能被要求全局安装 Node、Pi CLI 或 Bash。
- `node-pty` 原生重建可能需要 Python 与 Visual Studio C++ Build Tools/Windows SDK。先根据锁定依赖实际报错核实所需版本，不擅自安装全局组件，不用 `--ignore-scripts` 绕开原生构建。
- 工作区与测试输出放在本机可写磁盘。使用仓库外、专用测试根；不使用 OneDrive、真实论文目录、现有 Nozeli profile 或凭据目录作测试数据。UNC/网络盘作为后续单独场景验证。

PowerShell 环境采集示例（从仓库根执行）：

```powershell
Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, OSArchitecture
node -p "JSON.stringify({platform:process.platform,arch:process.arch,node:process.versions.node})"
npm --version
git --version
git rev-parse HEAD
```

此外记录磁盘文件系统、大小写/长路径策略、当前权限、PowerShell 版本、构建工具版本和路径长度。日志不得包含环境变量全集或凭据。

### 构建入口

以下是既有 Node/npm 入口，不是 Windows 已实测承诺；每条命令检查 `$LASTEXITCODE`，失败先定位并保留日志，不继续串成假成功。命令从仓库根运行：

```powershell
npm ci --prefix integrations/pi
npm run build --prefix integrations/pi
npm ci --prefix apps/desktop
npm run build:pptist --prefix apps/desktop
npm run build:renderer --prefix apps/desktop
node apps/desktop/tools/platform-probe.mjs --pretty
```

Pi 与 Electron 版本以当前锁文件/manifest 为准。桌面 `postinstall` 会重建 `node-pty`；失败需解决本机工具链或源码问题，不回退旧机器二进制。不得随意重写依赖锁以“修好安装”。

首轮探针的非零退出、`unsupported` 和 `not-run` 是重要基线：当前 Windows 的安全文件、持久化、进程归属、隔离与随包 Node 尚缺 native 资格。保留完整 JSON、时间和退出码；不要用 `--no-isolation` 结果证明隔离通过。

W0 通过条件：源码与环境可追溯、锁定依赖可重现构建，或每项构建阻塞已准确定位；未适配能力如实记录。构建通过不等于产品通过。

## 4. 代码导航与修改边界

| 能力 | 先读的现有文件 | Windows 需要交付 |
| --- | --- | --- |
| 能力选择 | `src/platform/platform-capabilities.mjs` | 按真实实现与实测证据更新状态，不让声明代替执行证据 |
| 文件安全 | `src/platform/shared/filesystem.mjs`、`src/platform/linux/filesystem.mjs`、`src/agents/managed/file-stream.mjs` | 等价的稳定文件/目录身份与并发保护，不照抄 Linux `/proc` |
| 持久化 | `src/platform/shared/persistence.mjs`、`src/platform/linux/persistence.mjs` | Windows 原子替换、文件/命名空间持久化及不确定结果语义 |
| 进程/恢复 | `src/agents/managed/process-ownership.mjs`、`pi-process-ownership.mjs`、`pi-session.mjs`、`src/main/project-recovery-owner.mjs` | incarnation、后代归属、退出核验、恢复来源证明 |
| 权限与隔离 | `src/agents/managed/process-isolation.mjs`、`src/platform/linux/bwrap-isolation.mjs`、`src/main/privilege-broker.mjs` | 普通执行/提权/隔离分别建模，不宣称普通 spawn 是沙箱 |
| Runtime | `src/platform/shared/runtime-assets.mjs`、`src/agents/managed/pi-runtime.mjs`、`git-runtime.mjs`、`integrations/pi/` | 固定 Windows 运行时、架构/摘要/资源布局及环境清理 |
| 原生集成 | `src/main/`、`src/renderer/`、`tools/start-pi-isolated.mjs` | 真实 Electron 工作面与可核验生命周期 |

表内 `src/`、`tools/` 均相对 `apps/desktop/`。平台文件放在既有 platform 层，名称按实际接口确定；不要先创建空适配器。新 native 依赖须评估维护性、许可、架构、打包和 Windows CI 成本，再做有依据的选择。

Renderer 仍仅使用窄 Host API。不向网页/报告开放 Node、文件系统或命令执行能力；平台判断留在适配层，业务层按能力合同消费。

## 5. W1–W5 的实施和验收门

### W1：文件系统与持久化（先完成）

- 明确盘符/UNC、路径规范化、大小写、Unicode/空格、长路径、ACL、共享锁和 reparse point 行为。字符串前缀比较不是身份保护。
- 用 native handle 或经验证的等价机制固定父目录/目标身份；覆盖读前/读后变化、父目录替换、junction/符号链接逃逸和文件替换竞争。无法保证的路径保持禁用。
- CAS 失败保留外部赢家与未保存编辑；不通过删除竞争者、重试覆盖或清理草稿来“修复冲突”。
- 持久化合同区分未发布失败与已发布但屏障失败；后者保留 `committed=true`、`durability=uncertain`，不按未执行回滚或自动重放。
- 分别验收 `main/project-git.mjs`、`file-clipboard-import.mjs`、`file-tree-ops.mjs` 的 rename/link/move 事务、发布后失败和恢复；一次 writeAtomic 通过不能代签多步事务。
- 运行真实合成项目读取/编辑/保存/重开、并发外部替换、只读/锁定文件、故障与冷恢复场景；核对实际字节、身份与恢复资料。

### W2：进程树、Runtime 与恢复

- 先形成 Windows 原语决策记录。Job Object 等只是候选；须实测子孙继承、逃逸/脱离、嵌套与权限限制，不直接宣称满足合同。
- 绑定 owner generation、请求和 incarnation；PID 消失不能代表后代均退出，身份不明不得释放 writer、锁或运行额度。
- 覆盖正常退出、取消、leader 先退出、后代仍存活、Runtime/Host 崩溃、强制结束、重启 UNKNOWN 栅栏及零重放；保留无关哨兵进程存活证据。
- Pi 的身份、队列、原生事件与 journal 保持现有共享合同。IPC 验证认证、ACL/访问域、消息边界、断连、晚到事件；不因 Windows 重新设计业务协议。
- 普通项目终端、TeX、force-quit、更新 helper 分别核验，不以 Pi 生命周期通过替代它们。普通终端冷恢复不自动启动 shell，关闭回收可核验的自有后代。

### W3：普通权限、提权与可选隔离

- 普通任务执行使用现有产品权限方向；当前用户权限不等于 OS 沙箱。
- 显式要求隔离的路径必须有真实机制与有效读写域证据，初始化失败拒绝执行；不回落普通 spawn。没有合格机制时可明确保持 unsupported，但不能声称全能力完成。
- 提权是单独能力：用户确认不等于系统 UAC 已成功；只有实际 token/执行主体核验后才报告成功。Electron/renderer 不整体提权，认证信息不经过模型。
- 实测采用的原生机制需要用户相应授权；拒绝/撤销后零执行，不重放未知系统效果。

### W4：真实 Electron 产品纵向验收

先审查启动脚本的路径、环境和进程信号行为，必要时完成 Windows 适配。既有隔离开发入口（从仓库根）：

```powershell
npm run start:pi-isolated --prefix apps/desktop
```

它使用 checkout 的 `.runtime/pi-development`，不是日常 profile；仍可能继承环境，运行前审查并清除敏感配置，绝不默认加载个人 API 凭据。未完成 W1/W2 前遇到能力拒绝应修 native 层，不绕过。

至少在合成项目实测：

- 打开目录，浏览 PDF/文本/Markdown/受支持 Office；Office 不超出现有支持范围承诺。
- 编辑、撤销、保存、重开；未保存编辑与外部冲突保留；原文件与候选文件身份不串绑。
- 中文 IME 组合态、Ctrl 快捷键、菜单、文本/文件系统剪贴板与拖放；独立进程/系统粘贴目标核验，不能只用 Electron 内部读回证明系统复制。
- 选区、备注与讨论：保存不派工；显式发送才冻结来源和材料；本地脚本化 Provider 经真实 Pi owner 收到正确版本。
- Work 受理→实际文件修改→冻结成果→原生候选阅读/Diff/人工意见→同 Worker 续改→明确接受→真实 Git 合入；核对历史、未发送草稿及重启不重放。
- 分屏、独立窗口、拖出/回嵌、多 DPI/多显示器和退出/恢复；真实桌面截图与文件/进程证据并存，不用浏览器模拟产品。

### W5：Windows 原生候选包与发行门

- 为目标架构提供固定随包 Node/Pi/Git 与原生模块，校验摘要、DLL/helper 和资源闭包；不靠系统 PATH 或 Git Bash 掩盖漏包。开发使用系统 Node 不等于生产可依赖系统 Node。
- 现有 Linux-only 打包/安装器不能直接当 Windows 安装器；先选定原生发行形态并记录理由，保留数据目录和升级/回滚合同。
- 在无开发工具依赖的干净普通用户环境，真实验证候选包冷启动、文件操作、Pi、本地恢复和退出；卸载/升级/回滚用专用隔离安装目标，执行前取得授权。
- 签名、证书、公开发布和真实日常安装替换另行授权。开发包通过只能声明该架构/环境开发包通过，未签名不得冒称签名通过。

## 6. 回归、已知问题与禁止误判

从仓库根可运行既有入口；初到 Windows 不保证全套能通过，先阅读 runner 与各脚本前置条件，真实失败必须保留并归因：

```powershell
npm run test:unit --prefix apps/desktop
npm run test:integration --prefix apps/desktop
npm run test:smoke --prefix apps/desktop
```

平台定向入口：

```powershell
Set-Location apps/desktop
node --test tests/platform-capabilities.test.mjs tests/platform-filesystem.test.mjs tests/platform-process-boundary.test.mjs tests/platform-persistence.test.mjs tests/platform-runtime-assets.test.mjs
```

后续命令注意当前目录；根目录命令须先回到仓库根。`test:smoke` 要求 renderer/PPTist 已构建；按实际 suite 清单核实依赖。Pi live 仅在审查当前 runner 与脚本、确认使用无凭据回环 Provider 后显式启用，不照抄历史 OMP 命令。`docs/testing.md` 部分说明尚留 OMP 历史文字，Pi 当前入口以源码、`package.json` 和 `tools/test-suites.mjs` 为准，不恢复已退役后端。

已知本轮 Linux 复核：平台定向 43 项中 42 通过、1 失败。`tests/platform-process-boundary.test.mjs` 的 bwrap 用例把 `os.tmpdir()` 整体用作 cwd，在其为 `/tmp` 时被生产安全策略拒绝。应改为精确合成子目录的行为场景，不放宽 `/tmp` 隔离策略；Windows 不应伪装 Linux 执行该场景。此问题不阻止 W0/W1 开发，也不能被标记为已修复。历史第一阶段完整绿灯不能替代新 checkout 的实际回归。

不得为全绿删除有效边界测试、跳过待实现功能后报整体通过，或将全套缩成几个简单用例。平台专属用例可明确按平台归类；Windows native 必须补等价真实场景，报告跳过及原因。保留 Linux 路径，不擅改 macOS 能力声明；跨平台回归由对应主机分别验证。

## 7. 证据与最后交付

测试资料均为合成输入。原始日志、截图、临时 profile 与包放在忽略的 `.test-output/` 或仓库外专用证据根，不提交数据库、会话、密钥、私人截图或生成发行包。项目目录与 profile 分开隔离；结束只清理本轮可证明自有的进程/临时目录，不按进程名批量终止。

每门记录：

- HEAD 与未提交改动范围；OS/架构、Node/npm/Electron、文件系统与权限。
- 实际命令、开始/结束时间、退出码；测试通过/失败/跳过数与原因。
- 文件字节/身份/CAS/恢复事实、owner/后代退出和无关进程存活事实。
- 结果 `passed`、`failed`、`not-run` 或 `unsupported`，证据路径与覆盖限制。

在现有文档中更新真实进度，不复写另一套产品规划：

1. `docs/platform-phase2-handoff.md`：逐门 Windows 结果与剩余阻塞。
2. `docs/platform-phase1-inventory.json`：适配器/消费点和新发现边界；不得抹掉未验事项。
3. `apps/desktop/src/platform/platform-capabilities.mjs`：只有满足对应合同且有 native 证据才改声明；完善探针以执行真实 Windows 检查，不仅输出矩阵。
4. `apps/desktop/README.md`、`docs/testing.md` 与 `CHANGELOG.md`：更新实际 Windows 入口、前置及限制，不宣称其他平台通过。

最终向用户交付一份 W0–W5 结果表、修改文件列表、真实执行证据、仍禁用的能力、需额外授权的动作以及复现命令。未完成项写清缺失原语/资源和已尝试路径；“能启动”“能编译”或“探针某几项通过”都不能替代完整 Windows 原生资格。
