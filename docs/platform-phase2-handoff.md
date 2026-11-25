2026-11-12 Windows 确认 journal 字节：flush 从原生同步读取的同一字节严格解析并创建SDK内存视图，拒绝损坏编码/JSON与重复/缺失父身份，避免SDK.open的迁移/跳过坏行及二次路径读取。源码Node/Electron完整Pi各52项通过；四宿主parser4/Pi5/ready丢回复1、独立包两布局Worker各2通过，完整性核对通过。各快照具体范围见 `D:\nozeli-test\20261112-alpha6-journal-snapshot\development-status.json`；恢复材料闭包及helper/home释放仍未完成，v50正式基线不变。详见[依赖与实现记录](windows-recovery-material-closure-design.md)。

# Windows / macOS 第二阶段开发交接

## 2026-11-14 当前 Windows 续作

授权目标为完整W0–W5实现和实测，完整[逐门清单](windows-w0-w5-qualification.md)与`N:/dev-cache/windows-supervisor/goal-status.json`为当前追踪入口；不按v57阶段边界停止。官方Spectre组件已真实UAC安装，当前文件／进程原生构建和Node/Electron子进程身份均有新证据。保留旧工作树、既有dirty/untracked、原生原始／失败／中间构建，不升级alpha.6+PR27、Electron44.9.1或SDK1.4.0。

v57模型/auth证据已接入原journal、完整归档与独立reader；两种材料分别重算，缺失／legacy不能互相绕过。源码完整owner两宿主各56/56已通过；先前52/56的readiness失败保留，未放宽原15秒观察门。项目终端使用Job创建绑定的ConPTY及仅在子进程重置Ctrl-C状态的固定System32 shell launcher；工具进程原生Job及强退worker不提升全局ownership声明。手工候选安装独立profile和精确CAS，自动更新继续明确unsupported。独立包与完整产品验收仍在执行，资源闭包／释放／pending/default入口仍待完成，v50基线和两个false发布标志不变。


2026-11-11 Windows v50：原owner home目录身份/ACL及父链在首次resume前交给helper，真实host退出后仍保持并约束cold journal/归档；修复伪造home重连在拒绝前的接收HANDLE清理，重复拒绝回归通过。完整恢复材料生命周期、归档协调、资源释放及默认入口仍未完成，见[本批记录](windows-alpha6-home-custody.md)。下文为历史。

2026-11-10 Windows v49：原inspection持久归档完整观察到的owner home、原helper三路stdio和账本；完整集合CAS intent/ready、独立摘要复核、并发赢家/丢回复UNKNOWN，原home/helper保留。正常归档后实际Controller启动和warm停止通过。原home全生命周期custody、完整恢复闭包、归档协调、资源释放及默认入口仍未完成；实际矩阵/包见[本批记录](windows-alpha6-cold-evidence-archive.md)。下文为历史。

2026-11-10 Windows v48：两次真实host死亡后第三共享Controller接管并启动两个resident；完整跨代原helper/launch-set/stdio/source与历史回执核验，旧retired Worker行及revision、paused/候选/草稿保持且零旧输入重放。源码/独立解压Node各8模式、Electron各3，详细实际矩阵与新包见[本批记录](windows-alpha6-repeat-cold.md)。旧资源释放、pending/default入口、完整W0–W5仍未完成；beta.1 main尚未整合。下文为历史阶段。

2026-11-10 Windows 单次冷接管：原受限anchor完整custody连续转移，一次性原inspection token和完整集合CAS接续精确原退休代次；共享Controller核对旧provider、竞争只一赢家并启动两个新resident，旧Worker interrupted／review／草稿保留且零旧输入重放。第二轮cold、资源释放、pending协调、默认入口与完整W0–W5仍未完成。原生文件／进程及renderer实编，新独立包与实际矩阵见[本批记录](windows-alpha6-cold-handoff.md)。远端main已推进beta.1增量，当前包仍固定alpha.6＋PR27。下文为历史阶段。

2026-11-10 Windows 原 host/owner 记录冷退休：精确 business hold 与原 anchor 领取后，同一 SQLite 事务比较五个完整集合，单调增加 host/owner 修订并保留原 generation 历史。退休后由原 inspection 内部绑定读入口继续核对原 journal；并发变化与提交后丢回复保留 UNKNOWN、不重试。记录退休已资格化，实际资源释放、新代接续、默认 ManagedProjects 与 W0–W5 仍未完成。当前包、实际矩阵和下一代设计见[本批记录](windows-alpha6-cold-retirement.md)。

2026-11-10 Windows 原 anchor 冷领取：协议v9／launch-set v2由原helper跨连接单向仲裁，只复制原文件对象的受限不可继承HANDLE，保留原写共享排他。managed入口先业务hold再复核原checkpoint／source／完整owner／kernel／journal／tool／business／pending；后检查变化或丢回复保留UNKNOWN、不重试。原host/owner未退休，新代与默认执行未开放，W0–W5仍未完成。当前包和实际矩阵见[本批记录](windows-alpha6-cold-anchor.md)。

2026-11-10 新增原工具 admitted／handler-returned 本机 CAS 记录及冷 stdio 关联，详见 [工具处理持久记录](windows-alpha6-tool-custody.md)。处理返回证据不能替代真实业务事务、pending／projection／owner 冷接管；默认 Windows ManagedProjects 与完整 W0–W5 仍未完成。

2026-11-10 Windows 强杀journal前缀：Pi启动／prompt／flush返回原生同步快照；宿主退出后核对原File ID与已确认前缀，保留未知尾部。工具效果已发生但未回复仍unresolved、不重放，文件／快照篡改拒绝。源码／解压Node与Electron各52项、cold各15项、Worker各2项，GUI各6项通过；业务冷接管与默认入口仍未完成。当前包见[本批记录](windows-alpha6-abrupt-journal.md)。

2026-11-10 Windows 原始请求／journal 冷核验：原始stdin、Pi返回、原生journal和输入摘要逐项匹配；缺回复保留execution-unknown，工具回复不等于业务完成。显式journal检查点在SQLite CAS前后复核metadata／journal，提交后变化保留UNKNOWN与外部赢家。源码／解压Node及Electron完整定向各47项、cold各15项、Worker各2项，GUI各6项通过；业务冷接管和默认入口仍未开放。当前包与边界见[本批记录](windows-alpha6-journal-reconciliation.md)。
2026-11-10 Windows 原生启动集合：每次启动意图先记入原生追加历史，supervisor保留只读mapping；原宿主退出后逐项核验完整历史、Job和原stdin/out/err。删除owner行／未完成意图／替代身份的真实回归均拒绝确认。仅原项目host lease的完整集合与进程停稳取得本批证据，业务冷接管和默认ManagedProjects仍未开放；当前包与实际结果见[本批记录](windows-alpha6-launch-set.md)。

2026-11-09 Windows 冷恢复前置：原生 helper 现保留已观察且退出的后代 HANDLE，新冷连接可取得受限原实体；当前已登记 Job 的原流／来源检查点复用本机 CAS／UNKNOWN。完整宿主启动集合、任务接管与默认入口仍未完成；实际验证与当前包见[本批记录](windows-alpha6-cold-checkpoint.md)。

2026-11-09 Windows managed 分离目录接入：已验证原登记存储逐路径原生宿主／来源、跨根执行证据、隔离 Git 长 ref，以及真实 Controller／Pi／Git 的编辑、明确审阅接受、归档和 warm reopen。生产默认选择与冷恢复仍未开放；当前验证包、实际计数和路径 unsupported 边界见[本批记录](windows-alpha6-managed-roots.md)。

2026-11-09 Windows 新进展：正式外部启动已接入原生持久队列及实际文档显示确认，冷恢复不重放；四宿主各179通过/0失败/1跳过，源码/解压生产GUI各8项通过。完整边界和当前ZIP见[外部打开记录](windows-alpha6-external-routing.md)；W1–W5完整资格仍未完成。


日期：2026-10-31。工作树：`nozeli_git`；产品内核：Pi。第一阶段是共享核心整理，不是 Windows/macOS 可运行或发行资格。不得用 Linux、Wine、修改 platform 参数或交叉打包代替原生验收。

## 已稳定的共享边界

| 能力 | 合同与真实 Linux 实现 | 第二阶段必须提供的等价事实 |
| --- | --- | --- |
| 安全文件 | `src/platform/shared/filesystem.mjs`；`linux/filesystem.mjs`；业务路径策略仍在 `agents/managed/file-stream.mjs` | 父目录和文件身份固定、拒绝链接/reparse 逃逸、读后身份校验、目录被替换时不写竞争者、Git 捕获与读到的 inode/句柄内容一致 |
| 进程 owner | `agents/managed/process-ownership.mjs`、`pi-process-ownership.mjs`；`platform/linux/process-ownership.mjs` | 进程 incarnation、owner 标签、子孙归属与退出证据；PID 消失不能代表全部后代退出；不确定不能释放 writer/额度 |
| 恢复来源 | `main/project-recovery-owner.mjs`；`platform/linux/recovery-owner.mjs` | 其他 Nozeli 实例真实登记/打开数据库的可核实来源；不可核实就保留恢复现场 |
| 隔离 | `agents/managed/process-isolation.mjs`；`platform/linux/bwrap-isolation.mjs` | 要求隔离时建立真实读写域；失败拒绝，不回落普通 spawn；普通用户权限执行与 OS 沙箱分开声明 |
| 持久化 | `platform/shared/persistence.mjs`；`linux/persistence.mjs` | 文件同步、原子替换和命名空间持久化；发布后屏障失败须保留 `committed=true` / `durability=uncertain`，不能按未发布回滚或重放 |
| 运行时资产 | `platform/shared/runtime-assets.mjs`；Pi/Git resolver | 固定版本/架构/资源布局、普通文件与可执行验证、摘要；不回落系统 Pi/Node/Git |
| 能力选择 | `platform/platform-capabilities.mjs` schema 1 | `implemented`、`not-run`、`unsupported` 分开。实现覆盖不等于实际机器 ready；不得仅翻矩阵为绿 |

运行目录、IPC、队列、会话与请求身份、Work/报告/材料/CAS、单 writer 和零重放保持共享，不复制 Windows 或 macOS 专属业务内核。已迁移的消费点及未原生验证边界见 [机器清单](platform-phase1-inventory.json) 和 `capabilitySnapshot().residualBoundaries`。

## 冻结的持久化决策

普通私有元数据原子发布已走共享持久化合同；Windows/macOS 当前拒绝尚未实现的屏障，不再跳过目录同步而冒称成功。演示登记在发布后持久化不确定时保留新内存/磁盘状态并阻断后续效果，重启后按原登记恢复；捕获丢弃在删除前预检能力。

`project-git`、文件剪贴板导入与文件树移动是多步事务，不是一次 `writeAtomic`。第一阶段保留 Linux 已有身份校验、日志与恢复顺序，并在副作用前要求安全文件和持久化能力；不新增断电完整性承诺。第二阶段启用平台能力前，必须逐路径验收 rename/link/move 的身份、冲突、已发布错误与恢复，不可只实现一次目录同步就宣告全部通过。

## 两平台独立开发顺序

1. **W0 / M0：真实主机基线**。记录 OS、arch、文件系统/大小写、权限、Node/npm/Electron。开发 Node 最低 `22.22.2`；生产使用固定随包 Node。使用锁文件；不导入个人凭据。开发命令直接用 Node/npm，不要求 WSL/Bash/Docker。
2. **W1 / M1：文件与持久化**。实现 native adapter，先跑合成目录中的 Unicode/空格、UNC/盘符（Windows）、符号链接/reparse、父目录替换、并发写、只读/锁、长路径和原子发布故障测试。macOS 另验证目录授权持久化/失效，不能以路径字符串代替权限。
3. **W2 / M2：进程与恢复**。实现 owner、进程树和恢复来源证明；验证 leader 退出但后代仍活、脱离进程组、身份复用、取消/崩溃、正常/强制退出、UNKNOWN 栅栏和零重放。现有 `force-quit`、TeX 与更新 helper 的原生机制必须逐项补齐，不能因 Pi 适配通过就默认通过。
4. **W3 / M3：隔离与系统权限**。明确原生隔离机制/有效范围。提权与普通执行分别验收；无可证隔离则禁用需要它的路径。更新器、原生 shell 和环境变量等机制按机器清单处理。
5. **W4 / M4：真实 Electron 工作面**。目录/保存对话框、菜单、剪贴板与拖放、中文 IME 组合、PDF/文本选区、未保存编辑、DPI、多屏独立窗/回嵌、冲突和恢复。不能以 renderer mock 代替。
6. **W5 / M5：原生包**。提供该平台固定 Node/Pi/Git/原生模块资产；分别构建安装/卸载/升级/回退。macOS 签名/公证及架构、Windows 签名/安装权限须另外授权与验收。当前工具仍明确 Linux-only，第一阶段没有伪造目标平台安装器。

## 可直接执行的开发入口

从仓库根：

```text
npm ci --prefix integrations/pi
npm run build --prefix integrations/pi
npm ci --prefix apps/desktop
npm run build:renderer --prefix apps/desktop
node apps/desktop/tools/platform-probe.mjs --pretty
npm test --prefix apps/desktop
```

`platform-probe` 实测当前主机安全读链/链接拒绝、原子持久化及重新打开、owner stamp、隔离、Git 与 Pi 摘要。开发树没有打包 Node 时明确 `not-run`；`--no-isolation` 只是不请求该测试，不能宣称隔离通过。Windows/macOS 初次运行返回不支持/未验证和非零退出是预期证据，不要删除失败或改为假成功。

证据统一记录 schema、平台/架构/版本、源码或候选摘要、输入为合成数据、执行动作、实际文件/进程状态、结果 `passed/failed/not-run/unsupported`、原件路径与限制；私人凭据、论文、浏览器数据不入库。

## 放行边界

共享整理允许两平台开始独立开发；不代表对应受管写入/Agent/升级已开放。只有对应 native 合同实现和实机证据完成，才更新能力矩阵。Linux 回归与真实 Electron 证据在 [第一阶段实施记录](pi-integration-execution.md) 追加；安装、提交、push 和发行仍按当轮授权执行。

## Windows 首轮实施记录（2026-11-01）

用户选定 `release/alpha.4`，原始 HEAD `cd0565375e9c7e5238302a9bfa9a85471a0d81fd`；开发分支 `platform/windows-native`。Git smart HTTPS 失败后，从官方 API 归档恢复并验证全部 1,149 个 blob、原始 tree 和 commit，`git fsck --full` 通过，没有创建替代提交。以下是该提交加本轮未提交修改的本机结果，不能作为 Linux/macOS 回归。

主机为 Windows 11 Pro 10.0.22631 x64、普通用户、本地 NTFS，目录大小写敏感关闭、LongPathsEnabled=0。工程专用 Node 22.23.4 / npm 10.9.9，PowerShell 7.6.0；全局 Node 与系统策略未修改。证据根为 `D:\nozeli-test\20261101-windows-native`，下表日志路径相对此根。项目、profile 与组件包为合成资料。

| 门 | 结果 | 实际范围与阻塞 |
| --- | --- | --- |
| W0 | passed | 源码可追溯；Pi、PPTist、renderer 构建成功。用户授权后安装器退出码 0，核实 MSVC 14.44.35207、Windows SDK 26100、Spectre x64；桌面 `npm ci` 与 `electron-rebuild -f -w node-pty` 均通过。能力探针仍因未实现的 Windows 核心能力返回 `ready=false`，这不否定 W0 构建门。 |
| W1 | unsupported | 私有文件/存储、共享登记/材料、Work/index/ref、WorkChanges 归档及直接业务报告/决定/集合 CAS 账本已有组件证据；源码/解压 Node、Electron 各 264/264。完整 Workspace.open/Controller/宿主与 Worker 归属、依赖复制、Plan Tree/worker-home、三个事务组、路径/mode/元数据及 namespace/断电未验收。 |
| W2 | unsupported | 身份/Job/stdio 与显式共享 PiSession 登记后放行组件已验证，源码/解包 Node/Electron 各70/70；真实本机SQLite CAS、换代/取消/UNKNOWN栅栏。正常start/Controller、精确home/runtime/宿主锁、完整Pi/Worker/stop/冷恢复仍待接入。 |
| W3 | unsupported | 要求隔离仍明确拒绝；Windows 提权未取得资格。修正 Linux pkexec 测试误入 Windows 提权机制的问题，不以 stub 测试代替 UAC 验收。 |
| W4 | not-run | smoke 在注册合成项目时被 `PERSISTENCE_UNSUPPORTED` 拒绝，尚未进入 Electron UI；无编辑/保存、IME、剪贴板、多屏或 Work 纵向验收。 |
| W5 | not-run | Windows x64 固定 Node 组件可打包、解压并独立执行；整应用 Windows 候选包、干净机、升级/回滚均未验收。现有候选包入口继续明确 Linux-only。 |

### 实际构建与回归

| 命令/场景（仓库根，另有说明除外） | 退出码/结果 | 证据 |
| --- | --- | --- |
| `npm ci --prefix integrations/pi`；`npm run build --prefix integrations/pi` | 均 0 | `W0/logs/npm-ci-pi.log`、`W0/logs/build-pi.log` |
| `npm ci --prefix apps/desktop`（首次） | 1，缺 MSVC；保留为历史基线 | `W0/logs/npm-ci-desktop-cached-git.log` |
| `npm ci --prefix apps/desktop`（Build Tools 完成后） | 0，`node-pty` 原生重建通过 | `W0/logs/npm-ci-desktop-after-buildtools.log` |
| Visual Studio Build Tools 安装 | 0；MSVC 14.44.35207、SDK 26100、Spectre x64 已核实，无重启要求 | `W0/buildtools-install-retry-result.json`、`W0/buildtools-installed.json`、`W0/buildtools-installer-logs/` |
| `npm run build:pptist --prefix apps/desktop`，提供 `NOZELI_PPTIST_ARCHIVE` | 0，首次 TLS 失败后降低 npm 下载并发重试成功 | `W0/logs/build-pptist-retry.log` |
| PPTist 错误缓存摘要拒绝，已有构建摘要保持不变 | 拒绝子命令 1；校验场景 0 | `W0/pptist-cache-negative.json` |
| `npm run build:renderer --prefix apps/desktop` | 0 | `W0/logs/build-renderer-after-pptist.log` |
| `node apps/desktop/tools/platform-probe.mjs --pretty`（Build Tools 完成后复核） | 1，`managedExecution.ready=false`；Git/Pi ok，safe-file-io、持久化、进程 owner、隔离仍 unsupported，开发树 Node bundle not-run | `W0/platform-probe-after-buildtools.json` |
| 六个平台测试文件（含新增 probe） | 47：30 pass、0 fail、17 skip | `W0/logs/platform-tests-native-rerun.tap` |
| `package-node-runtime.test.mjs` | 10：10 pass、0 fail | `W0/logs/package-node-runtime.tap` |
| 上述六个平台文件 + Node 打包文件最终合并复核 | 0；57：40 pass、0 fail、17 skip | `W0/logs/platform-and-node-final.tap`、`W0/final-validation.json`（含实际起止时间） |
| `npm run test:unit --prefix apps/desktop`（首轮基线） | 1；511：498 pass、12 fail、1 skip | `W0/logs/unit.log` |
| `npm run test:integration --prefix apps/desktop`（修正提权 fixture 后完整执行） | 1；1,534：461 pass、1,023 fail、50 skip | `W0/logs/integration-after-fixture-guard.log`、`W0/integration-summary.json` |
| `npm run test:smoke --prefix apps/desktop` | 1；项目持久化能力拒绝，GUI 未运行 | `W0/logs/smoke.log` |
| Electron 的 Node 模式加载原生模块 | 0，Electron 44.9.1 / 内置 Node 24.22.0 / ABI 149，node-pty 可加载 | `W0/logs/electron-native-load-after-cache.json` |
| ConPTY 普通用户合成 echo，等待宿主自然退出 | 子命令退出 0、nonce 匹配；宿主 ETIMEDOUT，场景失败 | `W0/logs/electron-conpty-component.json` |
| 固定 Node 组件打包→解压→使用绝对路径执行，无系统 PATH | 0，win32/x64/22.23.4，解压后摘要与 manifest 相符 | `W0/node-component-roundtrip.json` |
| `apps/desktop/tools/windows-native-probe.ps1 -EvidenceRoot <合成证据目录>` | 0，原语事实已采集，生产资格仍 unsupported | `W1/file-primitives-cross-process.log`、`W1/facts/*/facts.json` |
| W1 Node-API 读取与暂存写入：固定 Node 22.23.4 | 0；9 项读取 + 14 项写入，共 23/23；无跳过 | `W1/read-write-final/native-filesystem-node.tap` |
| W1 同一读取与写入套件：Electron 44.9.1 Node 模式 | 0；23/23，内置 Node 24.22.0 / N-API 10；无跳过 | `W1/read-write-final/native-filesystem-electron.tap`、`W1/read-write-final/native-filesystem-hosts-validation.json` |
| W1 暂存切片构建（历史产物） | 构建 0；MSBuild 使用 VS Build Tools、固定 Node 22.23.4 headers；当时产物摘要 `66f123a8726c6cbd0b9562a067a3efda76fcb98ab33162ce6a0517bf07556f37` | `W1/build-windows-native-write-v2.log`、`W1/read-write-final/native-filesystem-hosts-validation.json` |
| W1 组件 ZIP → 中文/空格目录解压 → 实际执行 | 固定 Node 随组件解压；Node/Electron 各 23/23；全部归档文件摘要匹配；完整应用仍未打包 | `W1/component-roundtrip/component-roundtrip.json` |
| 共享文件与 probe 门控回归 | 17：5 pass、0 fail、12 Linux 专属 skip；Windows 生产能力继续拒绝 | `W1/shared-filesystem-gate.tap` |
| 2026-11-02 TxF 替换切片构建（历史产物） | 0；当时二进制 SHA-256 `9140629a5f2c265eb24addbff6d22764f62a1907ffe540a25477590ac606b654` | `W1/build-windows-native-cas.log`、`W1/build-windows-native-cas.json` |
| 同一二进制：读取/暂存/TxF 替换完整套件 | Node 22.23.4 与 Electron 44.9.1 Node 模式各 37/37；含真实 30 秒事务超时，无失败/跳过 | `W1/transaction-cas-final/native-filesystem-hosts-validation.json`、两份 TAP |
| TxF 切片共享文件与 probe 门控回归 | 17：5 pass、0 fail、12 Linux 专属 skip；生产能力继续拒绝 | `W1/shared-filesystem-gate-cas.tap` |
| TxF 组件 ZIP → 中文/空格目录解压 → 实际执行 | 固定 Node 与开发依赖 Electron Node 模式各 37/37；全部归档文件摘要匹配；完整应用仍未打包 | `W1/transaction-component-roundtrip/component-roundtrip.json` |
| 私有 DACL 与权限保留切片构建（历史产物） | 0；当时 SHA-256 `fcebfdc722fc50cfa058f6214cca7c0d398e8fc72c2c9eec9a7068794b2a2335` | `W1/build-windows-native-security-v3.log`、`W1/build-windows-native-security.json` |
| 完整读取/暂存/替换/权限组件 | Node/Electron 各 48/48，无失败/跳过 | `W1/security-hosts-final/native-filesystem-hosts-validation.json` |
| 权限切片组件 ZIP → 解压 → 实际执行 | 解压后的固定 Node 与锁定 Electron 各 48/48；全部归档摘要匹配 | `W1/security-component-roundtrip-final/component-roundtrip.json` |
| 权限切片共享门控回归 | 17：5 pass、0 fail、12 Linux 专属 skip；生产能力继续拒绝 | `W1/shared-filesystem-gate-security.tap` |
| 固定目录屏障与持久化链切片 | 构建 0；源码/解压的 Node、Electron 各 58/58，无失败/跳过；仅报告 barriers-completed | `W1/build-windows-native-persistence.json`、`W1/persistence-hosts-final/native-filesystem-hosts-validation.json`、`W1/persistence-component-roundtrip/component-roundtrip.json` |
| 持久化切片共享门控 | 20：6 pass、0 fail、14 平台前置 skip | `W1/shared-filesystem-gate-persistence.tap` |
| HANDLE 共享读取/Git 切片构建（历史产物） | 0；SHA-256 `b0c2e9c7cdd73a686633d003216419f5677396846f1441d5b222a5c05445b1e7` | `W1/build-windows-native-read-consumer.log`、`W1/build-windows-native-read-consumer.json` |
| 共享读取/Git 切片源码与解压双宿主 | Node/Electron 源码各 68/68，解压后各 68/68，无失败/跳过；解压组件包含其自己的 Git 和 Node；Electron 仍为锁定开发宿主 | `W1/read-consumer-hosts/native-filesystem-hosts-validation.json`、`W1/read-consumer-component-roundtrip/component-roundtrip.json` |
| 共享读取/Git 切片共享门控 | 29：15 pass、0 fail、14 平台前置 skip；生产能力继续拒绝 | `W1/shared-filesystem-gate-read-consumer.tap` |
| 输入快照接入后的完整组件（历史切片） | 复用同一原生二进制；Node/Electron 源码各 70/70、解压各 70/70，无失败/跳过；输入捕获生成独立 tree/commit，原 refs/index/磁盘改动保留 | `W1/build-windows-native-snapshot.json`、`W1/snapshot-hosts/native-filesystem-hosts-validation.json`、`W1/snapshot-component-roundtrip/component-roundtrip.json` |
| 流式 TxF/共享版本化审校构建（历史切片） | 构建 0；SHA-256 `cbc8cf7eb3b1548e68c5668c56357c78cdbcad19c999c611ed1e69e374c51c06` | `W1/build-windows-native-stream-cas.log`、`W1/build-windows-native-stream-cas.json` |
| 流式审校切片完整组件与共享门控（历史） | 源码/解压 Node、Electron 各 84/84，无失败/跳过；共享门控 29：15 pass、0 fail、14 平台前置 skip | `W1/stream-cas-hosts-final/native-filesystem-hosts-validation.json`、`W1/stream-cas-component-roundtrip-final/component-roundtrip.json`、`W1/shared-filesystem-gate-stream-cas.tap` |
| 版本化删除/Git 文件安装构建（历史切片） | 构建 0；SHA-256 `f273421d2788dda8e6af8cc8c05adbab0f0c6123f574a8fd9173e6108ff69c80` | `W1/build-windows-native-install.log`、`W1/build-windows-native-install.json` |
| 安装切片组件与共享门控（历史） | 源码/解压 Node、Electron 各 101/101，无失败/跳过；共享门控 29：15 pass、0 fail、14 平台前置 skip | `W1/install-hosts/native-filesystem-hosts-validation.json`、`W1/install-component-roundtrip/component-roundtrip.json`、`W1/shared-filesystem-gate-install.tap` |
| 私有 SQLite 句柄/共享 worker 构建（历史） | 构建 0；SHA-256 `7333aa8cabc057ad730378f448567e0028f4f3f5dbec6dba3d7cfeb3162ea785` | `W1/build-windows-native-sqlite-v2.log`、`W1/build-windows-native-database.json` |
| SQLite 切片组件与共享门控（历史） | 源码/解压 Node、Electron 各 113/113，无失败/跳过；共享门控 29：15 pass、0 fail、14 平台前置 skip | `W1/database-hosts-final/native-filesystem-hosts-validation.json`、`W1/database-component-roundtrip-final/component-roundtrip.json`、`W1/shared-filesystem-gate-database.tap` |
| 共享存储安全回归 | 34：27 pass/7 fail，原始失败保留；明确正向选择的相关 27 项通过 | `W1/shared-storage-worker-database.tap`、`W1/shared-storage-worker-database-final.tap`；6 项依赖未开放初始化，1 项假定可 unlink 已打开 SQLite |
| 私有目录/ProjectStorage 构建（历史） | 构建 0；SHA-256 `75371265c79009cf29965bb9fba71707a4fc820de40c1b00a15571c684c97ca0` | `W1/build-windows-native-directories-v2.log`、`W1/build-windows-native-directories.json` |
| 私有目录切片与共享回归（历史） | 源码/解压 Node、Electron 各 125/125，无失败/跳过；共享门控 15 pass/14 skip；相关存储安全 27/27 | `W1/directories-hosts-final/native-filesystem-hosts-validation.json`、`W1/directories-component-roundtrip-final/component-roundtrip.json`、`W1/shared-filesystem-gate-directories.tap`、`W1/shared-storage-worker-directories.tap` |
| 私有目录移动构建（历史） | 构建 0；SHA-256 `b4f7159b8eaca77638b22ebf688ff7896f45da008588aba111322f5b3c7d4af5` | `W1/build-windows-native-directory-move-v2.log`、`W1/build-windows-native-directory-move.json` |
| 私有目录移动切片（历史） | 源码/解压 Node、Electron 各 139/139，无失败/跳过；共享门控及存储安全沿用前批，未重跑 | `W1/directory-move-hosts-final/native-filesystem-hosts-validation.json`、`W1/directory-move-component-roundtrip-final/component-roundtrip.json` |
| 私有树清单/屏障构建（历史） | 构建 0；SHA-256 `eb7ba2a23f2e466db4069d1df684dd67b493f838be416dac980997813068b185` | `W1/build-windows-native-private-tree-v2.log`、`W1/build-windows-native-private-tree.json` |
| 私有树清单切片（历史） | 源码/解压 Node、Electron 各 159/159，无失败/跳过；共享门控 15 pass/14 skip，相关存储安全 27/27 | `W1/private-tree-hosts-final/native-filesystem-hosts-validation.json`、`W1/private-tree-component-roundtrip-final/component-roundtrip.json`、`W1/shared-filesystem-gate-private-tree.tap`、`W1/shared-storage-worker-private-tree.tap` |
| 私有树复制/删除构建（历史） | 构建 0；SHA-256 `c2627855b77ef7c6416d3a8f25724d259ed3971d11d6d9d2c960f4594a72d2bd` | `W1/build-windows-native-tree-mutation-final.log`、`W1/build-windows-native-tree-mutation.json` |
| 私有树复制/删除切片（历史） | 源码/解压 Node、Electron 各 179/179，无失败/跳过；共享门控 15 pass/14 skip，相关存储安全 27/27 | `W1/tree-mutation-hosts-final-v2/native-filesystem-hosts-validation.json`、`W1/tree-mutation-component-roundtrip-final-v2/component-roundtrip.json`、`W1/shared-filesystem-gate-tree-mutation.tap`、`W1/shared-storage-worker-tree-mutation.tap` |
| 共享项目初始化原生构建（历史） | 构建 0；SHA-256 `09917c382f9e5cd47895baf7fbf0bc400735fc2b3f330afa233d6420926997cf` | `W1/build-windows-native-project-init-first.log`、`W1/build-windows-native-project-init.json` |
| 共享项目初始化组件与共享回归（历史） | 源码/解压 Node、Electron 各 201/201，无失败/跳过；共享门控 15 pass/14 skip，相关安全 27/27；完整安全文件当前仍 27 pass/7 fail | `W1/project-init-hosts-first/native-filesystem-hosts-validation.json`、`W1/project-init-component-roundtrip-first/component-roundtrip.json`、`W1/shared-filesystem-gate-project-init.tap`、`W1/shared-storage-worker-project-init-full.tap` |
| 共享材料对象库原生构建（历史） | 构建 0；SHA-256 `fa279a98d2deae3aa7e16c3184d1a6c33566b5c8b794b0648415267b980aeed2` | `W1/build-windows-native-material-first.log`、`W1/build-windows-native-material.json` |
| 共享材料组件与回归（历史） | 源码/解压 Node、Electron 各 223/223，无失败/跳过；共享材料与门控 23 pass/15 skip，选中存储安全 27/27，该批完整安全文件 27 pass/7 fail | `W1/material-hosts-final/native-filesystem-hosts-validation.json`、`W1/material-component-roundtrip-final/component-roundtrip.json`、`W1/shared-material-gates-final.tap`、`W1/shared-storage-worker-material-full.tap` |
| 共享 Work 原生构建（原生产物仍复用） | 构建 0；SHA-256 `24c50e7a9acf52fd77328621c676dc71020efaf0287bc232e3ef55a9ad342eda` | `W1/build-windows-native-work-first.log`、`W1/build-windows-native-work.json` |
| 共享 Work 组件与回归（历史 244 项） | 源码/解压 Node、Electron 各 244/244，无失败/跳过；共享门控 23 pass/15 skip；存储安全沿用材料批的定向 27/27、完整 27 pass/7 fail | `W1/work-hosts-final-v2/native-filesystem-hosts-validation.json`、`W1/work-component-roundtrip-final/component-roundtrip.json`、`W1/shared-work-gates-final.tap` |
| 当前 WorkChanges/业务组件与回归 | 源码/解压 Node、Electron 各 264/264，无失败/跳过；native 产物未变；共享门控 23 pass/15 skip；存储安全沿用材料批历史结果 | `W1/work-changes-hosts-final/native-filesystem-hosts-validation.json`、`W1/work-changes-component-roundtrip-final/component-roundtrip.json`、`W1/shared-work-changes-gates-final.tap`、`W1/build-windows-native-work-changes.json` |

integration 的失败码中 922 项为 `PERSISTENCE_UNSUPPORTED`，其余还包括平台能力拒绝、链接权限、POSIX 路径/权限/身份假设和断言失败；不能统称为环境问题。unit 的 12 个失败包含 Linux `/proc` 测试的 `process.getuid()`、终端 Linux baseline 假设及通知时序断言，保留原始失败，没有删除测试制造全绿。平台定向跳过包含 Linux-only 场景和普通用户无法创建文件 symlink；Windows junction 已实际验证，不能外推全部 reparse 类型。

第一次 integration 运行在 Linux pkexec fixture 未拦截 Windows PowerShell 提权路径时中止；日志显示调用返回 cancelled。仅按本轮进程树和创建时间终止自有测试进程，保留 `W0/logs/integration.log` 与 `integration-stop.json`。现将这些 Linux 专属提权测试显式分类，并让 fixture 在其他主机创建目录/启动机制前拒绝；新增拒绝回归。修正后完整套件的失败仍如上报告，Windows 真实 UAC 没有验收成功。

### 原语结论与下一步

本轮修改文件（前缀 `apps/desktop/`）：

- 探针与套件：`tools/platform-probe.mjs`、`tools/test-suites.mjs`、`tests/platform-probe.test.mjs`。
- 运行时打包：`tools/package-node-runtime.mjs`、`tools/node-runtime.win32-x64.lock.json`、`tools/package-pi-runtime.mjs`、`tests/package-node-runtime.test.mjs`。
- 构建与原语诊断：`tools/build-pptist.mjs`、`tools/windows-native-probe.ps1`、`tools/native/windows-file-primitives.cs`。
- W1 原生实验：`native/windows/anchored-common.h`、`native/windows/anchored-read.cc`、`native/windows/anchored-write.cc`、`native/windows/binding.gyp`、`native/windows/README.md`、`tools/build-windows-native.mjs`、`src/platform/windows/experimental-read.mjs`、`src/platform/windows/experimental-write.mjs`、`tests/windows-native-read.test.mjs`、`tests/windows-native-write.test.mjs`、`tests/windows-native-hosts.mjs`。
- 平台/权限 fixtures：`tests/platform-process-boundary.test.mjs`、`tests/platform-runtime-assets.test.mjs`、`tests/privilege-broker.test.mjs`。
- 文档：`apps/desktop/README.md`、`docs/platform-phase2-handoff.md`、`docs/platform-phase1-inventory.json`、`docs/testing.md`、`CHANGELOG.md`（本项路径相对仓库根）。

`windows-native-probe.ps1` 在内存编译 `tools/native/windows-file-primitives.cs`，调用真实 CreateFileW、GetFileInformationByHandle、FlushFileBuffers、MoveFileExW。读句柄的目录 flush 返回 5，读写句柄在本机普通用户 NTFS 上成功；这仍不证明断电完整性。独立 PowerShell 子进程对固定父目录的改名、受保护文件的写入/改名均返回共享冲突 32，释放句柄后写入成功；测试只涵盖受控竞争，不代签完整安全路径。

下一实现顺序仍为 W1→W2→W3→W4→W5。W1 的 Git 对象捕获现已支持固定 HANDLE 字节流，仍需将路径/mode 策略、异步 I/O、写入与草稿合同接入完整业务消费者，确定 TxF 产品政策及完整命名空间持久化，补扩展元数据和故障结果验证，再迁移 `chain.anchoredPath()` 及 Git/剪贴板/文件树多步事务。W2 需要独立的进程 incarnation 和 Job Object 原生证据，不能直接将 node-pty 的 PID 枚举/kill 当作可核验归属。

下一代码切片以 Node-API C/C++ bridge 为实现方向，使用系统 Win32 SDK，在独立 Node 22 与 Electron 两个实际宿主分别构建/运行；生产不要求 PowerShell 7 或动态 C# 编译。原生句柄必须有明确归属、关闭与异常清理，先在未接入选择器的合成场景证明安全，再迁移消费者与更新声明。目录 flush 的当前成功观察只支持继续原型，不能提前决定全部路径、共享模式和持久化语义都合格。

用户已明确授权安装 Visual Studio 2022 Build Tools 的 C++ x64/x86、Windows SDK 和 Spectre 库。首次显式 RunAs 启动返回 1223；用户反馈未看到 UAC 并要求重试。第二次从微软签名安装器的常规入口启动，安装器退出码为 0，组件清单与原生重建均已核实。能力矩阵未改为 implemented；签名、公开发布、提交和 push 未执行。

W1 新增 `native/windows/anchored-read.cc` 与 Node-API 8 构建配置，实验读取器使用 `NtCreateFile.RootDirectory` 从固定卷根逐级打开祖先和文件，拒绝 reparse、多个硬链接、非本地 NTFS 及不安全路径；显式关闭和 finalizer 负责释放句柄。`test:windows-native` 现由仓库内双宿主 driver 执行同一组测试：固定 Node 22.23.4 和 Electron 44.9.1 Node 模式各 9/9，通过摘要核实为同一产物。原 4 项 Electron smoke 已被完整套件替代，旧日志保留。此前通过 PowerShell 直接调用 GUI 子系统可执行文件得到的提前返回，不是 Electron 不等待异步操作的证明；driver 使用 `spawnSync` 等待实际退出，并拒绝空 TAP、失败或跳过。`src/platform/windows/experimental-read.mjs` 未接入共享 selector，不能代签 W1；CAS、写入、持久化屏障和多步消费者仍未资格化。

后续写入切片新增 `anchored-write.cc`，读取和写入共用 `anchored-common.h`。写入对象保留祖先与自有文件 HANDLE，独占创建、分块写入、文件 flush 后可进行相对父句柄的无覆盖 rename；暂存关闭通过原 HANDLE 的 disposition 清理，发布后关闭保留文件。两个独立进程竞争同一新名称，实测一个胜出、一个冲突；已有大小写等价文件、硬链接、目录和 junction 目标均被保留。Node 与 Electron 各 23/23，并完成组件 ZIP 解压后的同范围验证。

首轮边界测试曾因 Node-API `napi_is_buffer` 的识别范围与 JS Buffer 预期不同而在两宿主各失败一项；实现现检查 Uint8Array 类型、普通 ArrayBuffer backing 和块大小，拒绝其他 TypedArray、DataView 和共享内存。原失败日志保留为 `W1/native-read-write-first.log`。此前暂存切片仅提供文件同步及无覆盖发布；生产 selector 继续拒绝。接入任务和证据见 [Windows 文件设计](windows-filesystem-design.md)。

2026-11-02 新增 `native/windows/anchored-transaction.inc`、`src/platform/windows/experimental-replacement.mjs`、`tests/windows-native-replacement.test.mjs` 和原语诊断 `tools/native/windows-replacement-semantics.cs`。TxF 在事务锁内比较摘要、独占暂存并 flush、关闭事务文件句柄后准备替换，再显式提交。14 项新测试验证过期版本、独立竞争、硬链接拒绝、回滚、活宿主 GC、自然退出、强制结束自有子进程、长路径和真实 KTM 超时。Node/Electron 完整套件均 37/37；超时提交明确 aborted，外部赢家与事务前另存的恢复候选均保留。

微软强烈建议采用 TxF 替代方案，未来 Windows 可能没有此 API；组件动态检测失败便拒绝，不回退普通 rename。当前仅证明本机 NTFS 的实验合同。输入与候选各限 1 MiB，执行同步；下述 ACL 切片处理 owner/group/DACL，但扩展安全元数据、完整业务版本与草稿服务、committed-error/unknown 故障注入、映射写入、跨主机和断电资格仍待完成。成功提交仍报告 `namespace-not-qualified`，W1 不改绿。

同日继续新增 `native/windows/anchored-security.h`、`tests/windows-native-security.test.mjs` 和独立 ACL fixture。私有文件/目录在创建时即获得 protected user-only DACL，避免宽权限暂存窗口；已有同名条目不改权限。替换在候选创建时提供原 owner/group/DACL，检查实际访问规则；无法读取或复现、null DACL 则拒绝。11 个场景覆盖受保护/继承 ACL、私有 ACL、外部更改与回滚。普通暂存允许独立同用户 WRITE_DAC，随后操作检测并拒绝；本机 TxF 的路径式 ACL 更改在两个阶段都被拒绝。预打开安全句柄和最终竞态、SACL/完整性标签、私有凭据/SQLite 消费点仍未资格化。

源码双宿主 48/48 记录在 `W1/security-hosts-final/native-filesystem-hosts-validation.json`。组件解压首两次在 D: 因 fixture 重新设置未变化 owner 而要求 WRITE_OWNER，失败日志保留。已改成只修改 DACL、不重新设置 owner；不提升权限、不修改生产策略。最新解压结果见 `W1/security-component-roundtrip-final/component-roundtrip.json`。实现与验证细节见 [Windows 文件设计](windows-filesystem-design.md)。

随后新增固定目录 flush 与 root-scoped 持久化原型 `src/platform/windows/experimental-persistence.mjs`，补 10 项屏障链场景，共 58 项。父目录必须已存在；最终 flush 句柄允许 read/write share，继续拒绝 delete share，普通父接口维持原策略。实际文件 flush/发布/同句柄目录 flush 已串起，但成功仅报告 barriers-completed / namespace-not-qualified；发布后句柄关闭故障保留 committed/uncertain。官方资料及获取失败记录存于 `W1/persistence-contract-sources/`；不将该句柄故障宣称为存储设备故障，也不宣称完整断电保证。

当前再新增 `src/platform/windows/experimental-filesystem.mjs` 与 `tests/windows-native-read-consumer.test.mjs`。共享 `git-service.mjs` 增加可选 filesystem 注入：Linux 保留 fd 路径批处理；Windows 将固定 HANDLE 字节流送入随包 Git，核对独立 OID，再完成原身份核验。实际生成 SHA-1/SHA-256 对象，33 MiB 文件不走有界文本 API；取消/消费失败/摘要不符释放句柄且不推进 refs。源与解压双宿主各 68/68。新增 native stat/readAt、实验 adapter 和 Git 消费入口均不启用产品选择器；原生 chunk I/O 仍同步，Windows 工作树仅映射 100644，tracked mode 与完整业务消费者待接入。详见 [Windows 文件设计](windows-filesystem-design.md)。

随后修正 `execution-workspace.mjs` 四处 Git 捕获遗漏 filesystem 注入的问题，并新增 `tests/windows-native-snapshot.test.mjs` 两项输入捕获方法测试。真实共享方法生成独立 Git tree/commit，保留磁盘改动、用户 index 与原 refs；硬链接/默认 adapter 拒绝后只清理自有临时 index。最新源码/ZIP 解压的 Node、Electron 均各 70/70，复用同一 native 二进制。其他三条上层流程只完成参数接线，完整初始化/legacy/reconciliation、Work prepare/恢复、依赖供给、接受/回滚与生产持久化仍未获资格。当前记录见 `W1/build-windows-native-snapshot.json` 及上述 70 项验证路径。

流式审校切片增加 TxF 原语和 `experimentalWindowsVersionedFilesystem`，将共享 `applyReviewedFiles` 接到锁内基线摘要、候选摘要与原生条件发布。14 项新场景覆盖 33 MiB 基线/候选、ACL、生产者/取消/摘要不符回滚、独立竞争、实际审校方法、全计划漂移/路径预检、候选宿主退出及已发布不确定结果。多文件中后一步冲突附已发布 `appliedFiles`，保留前一步、外部赢家与计划草稿；不会自动重放。该切片源码/解压双宿主各 84/84，历史结果保留。

最新补齐同一事务目标 HANDLE 的 `prepareDelete()`，锁内核对摘要后提交删除、对固定父目录 flush；不修复 readonly 属性，不用路径式 unlink 回退。共享 `installFile` 显式路由流式写入/版本化删除，实际 Git 对象按需启动并有背压，流结束后仍等待 Git 退出；提前消费结束会清理并等待自有子进程。新增 17 项，验证 changed/new/deleted 文件的前向与反向恢复、33 MiB、SHA-1/SHA-256、对象损坏、路径/模式拒绝、并发赢家、取消、宿主退出与 committed/uncertain。原 refs/index/draft 保留；完整源码/ZIP 解压双宿主各 101/101，无失败/跳过，摘要匹配。首次 13/14 的错误是测试预期将 reparse 拒绝误写为一般条目拒绝，已更正，日志 `W1/install-first.tap` 保留。

此资格限已存在父目录、100644 模式与单文件方法；完整接受/index/ref/账本恢复、多文件回滚和生产持久化仍未成立。同步 I/O、TxF 未来可用性、扩展安全元数据与恶意映射/安全句柄竞争仍需解决。下一步接入业务持久化和完整 Work 恢复，能力选择器保持拒绝。实现和限制见 [Windows 文件设计](windows-filesystem-design.md)。

随后新增私有 SQLite namespace lease，并通过 `StorageDatabase({experimentalWindowsRoot})` 显式接入共享 worker，保留 SQLite DELETE/FULL、schema、操作 fingerprint/receipt、revision 与集合 CAS。已有 protected 私有父目录和主数据库 HANDLE 保持至实际连接关闭/worker 退出；sidecar 仅接受单链接且 sole-user ACE。首版属性句柄未阻止独立删除，真实失败 `W1/database-first.tap` 9/10 保留，已修成数据读取访问并通过竞争复核。12 项新 native/共享场景涵盖真实事务进程退出后的 hot journal 恢复、锁超时 quarantine、独立恢复草稿、主文件/父目录保护与 unsafe 拒绝；该切片完整源码/解压双宿主均 113/113。原生 postcommit unknown 故障注入、恶意 sidecar/security 竞态、WAL、项目初始化与业务 Work 账本恢复仍未资格化，不因 SQLite 局部通过启用生产持久化。

最新增加私有目录链原型，并经 `ProjectStorage(profile,{experimentalWindowsRoot})` 接入现有目录数据库准备和离线 local/recovery SQLite。子句柄在父 JS lease 关闭后仍固定祖先身份/私有 ACL；既有宽权限条目不修复，路径全计划在效果前检查，逐边执行子/父 flush。中途失败保留已创建 ID 和 committed/uncertain；两个独立进程可幂等创建同一私有树。新增 12 项，完整源码/解压双宿主各 125/125，无失败/跳过。目录数据库 lifecycle hold 与离线草稿冷开保留；离线测试明确预置合成 catalog binding，不代表项目登记。register 仍在项目写入前拒绝。下一步补目录发布/移动/删除/复制和共享初始化恢复，再接完整 Work；MaterialStore 恢复对象、恶意权限竞态、命名空间/断电持久化仍待资格化。

随后补 `anchored-directory-move.inc` 与私有目录移动入口：预期卷号/128 位 ID、DELETE HANDLE、保留两侧父链和源/父 ACL 快照，无覆盖相对 rename 后 flush 目录及两侧父目录。提交前冲突/取消保留源，提交后失败保留 destination 和 committed/uncertain 身份事实；关闭/宿主退出不清理名称。14 个真实场景通过，最新完整源码/解压双宿主各 139/139。包括真实 SQLite 草稿与 receipt 移动后冷开、独立晚到赢家/两个发布进程竞争、ACL 漂移、真实关闭屏障句柄和提交前后退出。第一轮 13/14 的测试关闭顺序错误日志保留。此资格只固定目录根；下一步补候选树递归核验/同步、固定身份删除与复制，再接共享初始化和恢复，W1 与生产能力继续 unsupported。

新增 `anchored-private-tree.inc` 和私有树入口，按相对 HANDLE 遍历并保持单链接私有文件 pins，以名字/身份/内容/ACL 摘要形成冻结清单，提供有界读取/流及文件、后序目录、固定父目录屏障。实际 NTFS 在严格后代句柄仍开放时拒绝 rename（5）；不降低共享模式，保持同一 DELETE 根，释放后代后无覆盖发布，再重新打开并核对完整清单。释放窗口的内容/成员/ACL 变化保留已移动树、committed/uncertain 与清单事实并禁止重放，调用者仍须停稳 writer。20 项新增场景通过，该历史切片完整源码/解压双宿主各 159/159；包括 420 项跨页、33 MiB、真实 SQLite 停稳/receipt 冷开、独立修改拒绝、屏障故障/取消/宿主退出。仅本地私有可写 NTFS、最多 10000 后代/默认 1 GiB；复制/删除、实际项目初始化、恶意映射/权限竞态、命名空间/断电与完整 Work 仍待完成。下一步以树清单为基线实现复制与固定身份删除，再接共享初始化状态机。

### 2026-11-02 私有树复制与删除续批

本轮补齐 `openExperimentalPrivateTree().copyTo()`：目标根和子目录由 FILE_CREATE 排他创建并保留原 HANDLE/真实 ID；源文件经固定句柄分块读取、清单摘要核对、私有暂存 flush 后无覆盖发布，重开时核对已发布 ID，随后保持 pins 并复核目标成员/内容和源清单，执行文件/后序目录/父目录屏障。已有根、晚到文件赢家及新增成员均保留；错误携带 privateTreeCopy.created 与已知 ID，发生创建后报 committed/uncertain。复制保持结构和内容，按私有策略重建权限/属性，不宣称克隆所有源元数据。未发布暂存仅经原 HANDLE 清理；部分已发布树不按名称回删。

删除须显式以 `{deletion:true}` 捕获，并提交此前批准的完整清单 SHA-256；清单包含根/条目身份、内容和 ACL。文件和子目录从捕获起请求 DELETE，删除前无释放再按路径重开的窗口。每项复核剩余成员、文件摘要和原生身份/ACL后，对同一 HANDLE 设置 disposition；文件后按后序删除空目录，每步同步受影响父目录。晚到成员停止进度，原生 nonempty 拒绝兜底；这不是整树原子事务。privateTreeRemoval.removed/rootRemoved 记录实际进度，部分失败/取消报 committed/uncertain。开始删除后的 lease 禁止继续读/写/重放，须冷开核查并批准新清单；发布移动后也须从新位置重开才能复制/删除。

新增 20 项真实场景，私有树文件现共 40 项，完整源码和中文空格 ZIP 解压后的固定 Node/Electron 均各 179/179，零失败/跳过。覆盖 33 MiB/块间取消、真实 SQLite 副本草稿/receipt 冷开、独立目标赢家、源/目标新增成员、部分删除、新清单恢复、活跃读者、真实关闭屏障句柄、根已删后故障及真实宿主退出。首轮 36 项中五项失败原日志保留：一项 fixture 对非私有测试根执行私有枚举；其余暴露单字符目标 rename 的结构体长度不足（Windows 错误 24），已修复文件/目录共用长度计算为至少 sizeof(RenameInformation)，并增加单字符文件/目录实际回归。

当前 native SHA-256 `c2627855b77ef7c6416d3a8f25724d259ed3971d11d6d9d2c960f4594a72d2bd`。证据 `W1/build-windows-native-tree-mutation.json`、`W1/tree-mutation-hosts-final-v2/native-filesystem-hosts-validation.json`、`W1/tree-mutation-component-roundtrip-final-v2/component-roundtrip.json`。重跑共享门控 15 pass/14 平台 skip，相关存储安全 27/27，日志为 `W1/shared-filesystem-gate-tree-mutation.tap`、`W1/shared-storage-worker-tree-mutation.tap`；完整共享文件原七项失败仍保留。解压验证使用固定开发 Electron，组件包不等于 W5 应用包；159 项及其二进制为历史切片。

下一步接入共享 ProjectStorage 初始化的 intent、来源副本、发布、冲突与逐阶段恢复，再接完整 Work/index/ref/账本和三个多步事务。仍限定本地私有可写 NTFS/既存父目录、默认 1 GiB/10000 后代，调用者须停稳 writer；恶意映射/安全句柄竞争、原生 UNKNOWN、命名空间/断电和完整产品持久化未资格化。W1 仍 unsupported、managedExecution.ready=false；W2 owner/Job/恢复来源和 W4/W5 实际应用链仍未完成。

### 2026-11-02 共享项目初始化与恢复续批

新增 `main/project-storage-io.mjs` 文件效果层，沿用同一 ProjectStorage 初始化状态机。默认入口继续要求生产持久化能力；仅同时传入 `experimentalWindowsRoot` 和 `experimentalWindowsInitialization:true` 才选择 Windows 显式实验实现，仅传 root 的旧离线/目录数据库用法仍拒绝初始化。没有在 UI、启动脚本或平台矩阵启用此选项，返回和目录记录明确携带 barriers-completed / namespace-not-qualified。

原生新增 `openAnchoredDirectoryIdentity`：只开已有目录，数据读取及 READ_CONTROL，读写共享但拒绝删除共享，保持实际 ACL 快照，不要求用户项目根具备私有元数据权限。初始化期间持有此根并在阶段/最终返回复核；嵌套持久化和 SQLite 打开仍兼容。项目和元数据身份以完整卷号/128 位 File ID 存储，避免 JS 数值 ino 丢失精度。元数据与候选的创建维持受保护私有 ACL；JSON 文件/父目录 pin 贯穿真实 SQLite 身份读取。

首次登记、已有登记冷开和 prepared/staging/staged/source-preserved/published/complete 六阶段恢复已实际通过。候选根排他创建后，先持久化分配 ID 再写 marker；未完成候选和有分配证据的无 marker 候选保留完整清单，显式重试改用新候选名，不因 marker 相符递归删除新加入的内容。安全或归属无法核验就保留并拒绝。完整候选的根身份/内容/ACL 清单在发布前入账；在 source-preserved 或 published 恢复时比对同一完整清单，不能仅凭复制来的 operation marker/SQLite 接纳替换目录。发布后真实关闭父句柄故障保留 committed/uncertain；冷开按已移动实体核查，不重复移动。`retry()` 的独立数据库探针保留显式 native SQLite root，复用已有回执核查。

新增 `windows-native-project-storage.test.mjs` 22 项，完整源码及中文空格 ZIP 解压后的固定 Node/Electron 各 201/201，零失败/跳过。真实验证 Unicode 首次登记、项目/本机/恢复草稿与 operation receipt 冷开、六阶段 checkpoint、部分/无 marker 候选保留、独立晚到赢家、候选/已发布目录替换、根权限/metadata ACL/hardlink 漂移、发布后关闭父句柄、分配/发布后的真实宿主退出及 scoped retry。受控 closed=false 回复只证明未确认关闭时的栅栏，不代签 native UNKNOWN 注入。最初探针发现把公开项目根当作私有链祖先的错误，改为从已固定项目根创建私有子链；测试清理对象及 --input-type 继承问题也已修正，失败日志保留。

当前 native SHA-256 `09917c382f9e5cd47895baf7fbf0bc400735fc2b3f330afa233d6420926997cf`；证据 `W1/build-windows-native-project-init.json`、`W1/project-init-hosts-first/native-filesystem-hosts-validation.json`、`W1/project-init-component-roundtrip-first/component-roundtrip.json`。共享门控重跑 15 pass/14 平台 skip；相关存储安全 27/27，完整当前文件复跑 34 项为 27 pass/7 fail，六项仍调用禁用的默认初始化、一项假定已打开 SQLite 可 unlink。日志 `W1/shared-filesystem-gate-project-init.tap`、`W1/shared-storage-worker-project-init.tap`、`W1/shared-storage-worker-project-init-full.tap`。179 项及其二进制为历史切片；组件 ZIP 使用固定开发 Electron，不是 W5 整应用。

资格限定为同一显式 scope 内的本地 NTFS 项目/profile。外来元数据确实调用现有 recovery-source-ownership 选择器，当前返回 RECOVERY_OWNER_UNVERIFIED，在新初始化 intent 与来源修改前拒绝。共享来源复制/备份/清理已接平台文件效果，但完整 Windows 路径须待 W2 真实归属能力后验收，没有用 stub 放行。W1 仍 unsupported、managedExecution.ready=false。下一批继续 MaterialStore 的固定句柄对象读写、完整 Work/index/ref/账本和多步事务，并推进 W2 owner/Job/恢复来源；命名空间/断电、恶意映射/安全竞争、真实 UI 与完整候选包均未取得资格。Linux/macOS 本轮未运行。

### 2026-11-02 共享材料对象库续批

复用共享 MaterialStore 的摘要、大小限制、不可变 CAS 和流式导入流程，新增 `domain/material-store-io.mjs` 文件效果层与 `platform/windows/experimental-material-store.mjs`。显式 `experimentalWindowsRoot` 才选择 Windows 原语；共享生产选择器保持禁用。ProjectStorage 的项目材料、恢复材料、流式访问与恢复对象提升均传递此作用域，已有初始化仍额外要求双选项。

原生 `openPrivateObjectRead` 只请求数据读取及 READ_CONTROL，不请求数据写入或 DELETE；多个读者可共存，实际拒绝独立数据写入、unlink 与目录改名。校验受保护父目录、单硬链接对象、完整卷号/128 位 ID、内容摘要与 ACL/身份快照，读句柄和父链跨回调保留。对象目录的私有 ACL 快照进入 stage 所保留的链，在异步生产者期间变宽即拒绝发布，不只是开始时检查一次权限。只读文件属性允许读取；不能通过对象 reader 刷盘或删除。

写入排他创建自有 stage，每个输入块在异步写入前复制，按 256 KiB 原生块推进；flush 文件后使用 no-replace HANDLE rename，释放 writer 后核验实际赢家并 flush 固定父目录。既有损坏、硬链接、junction 或权限异常对象不会被修复或覆盖。发布后故障保留 committed/uncertain，并携带目录、digest、字节数、发布事实及 stage 完整 ID。真实宿主在 staging 退出留下的 pending 文件保留，不按名称清理/冒认；已发布退出的对象可冷开核验，但这不证明断电持久性。

新增 `windows-native-material-store.test.mjs` 22 项，完整源码及中文空格 ZIP 解压后的固定 Node/Electron 均各 223/223，零失败/跳过。覆盖空/Unicode/二进制冷开、12 路并发发布/读取、独立进程赢家、33 MiB 流式复制、readonly、ACL/link/损坏拒绝、输入块变化、回调/生产者失败、真实关闭父句柄、阶段宿主退出，以及共享 ProjectStorage 材料冷开、离线恢复和同 digest 提升。首轮 16 pass/1 fail 为测试在实际 SQLite 尚未关闭时改名，被 Windows 拒绝；修正为先确认关闭，保留原日志 `W1/material-first.tap`。补充私有父目录 ACL 漂移用例时确认 stage 必须保留该目录策略快照，已使用现有私有目录 lease 连接同一链。

材料批 native SHA-256 `fa279a98d2deae3aa7e16c3184d1a6c33566b5c8b794b0648415267b980aeed2`；构建退出 0，证据 `W1/build-windows-native-material.json`、`W1/material-hosts-final/native-filesystem-hosts-validation.json`、`W1/material-component-roundtrip-final/component-roundtrip.json`；22 项专项 `W1/material-final.tap`。共享 MaterialStore/能力/文件/持久化共 38 项：23 pass/15 平台 skip、0 fail（含旧 MaterialStore Windows symlink 场景跳过；新 native junction/hardlink 场景已实测），日志 `W1/shared-material-gates-final.tap`。当前完整存储安全重跑仍 34 项：27 pass/7 fail，明确选择的 27 项通过，日志 `W1/shared-storage-worker-material-full.tap`、`W1/shared-storage-worker-material.tap`；六项使用禁用的默认初始化、一项假定已打开 SQLite 可 unlink，未删除或绕开这些失败。

资格仍限定同一显式 scope 的本地 NTFS。同步 native 块带 JS yield；未知 pending 的归属恢复/垃圾回收、恶意映射/安全句柄竞争、原生 UNKNOWN 故障注入、namespace/断电、完整 Work/acceptance/index/ref/账本及三个多步事务未验收。下一步接这些共享业务消费点并推进 W2 owner/incarnation/Job/恢复来源。W1 仍 unsupported、managedExecution.ready=false；W2/W3 未完成，W4 真实工作面与 W5 整应用包仍 not-run。组件 ZIP 的 Electron 使用锁定开发宿主，不等于随包 Electron 或 W5 应用。Linux/macOS 本轮未运行。

## Windows 共享 Work 组件续批（2026-11-02，历史 244 项）

在 `experimentalWindowsRoot` 与实验 filesystem 的显式注入下，现复用共享 `ExecutionWorkspace`，完成真实 Git worktree 准备、输入冻结、候选发布、SQLite 报告回执、类型化合入授权核对、接受/放弃、文件与 index/ref 更新、清理以及显式冷恢复。新 `execution-workspace-io.mjs` 只抽出平台文件效果，默认路线保留原共享逻辑；生产 selector 未启用。测试使用真实 ProjectStorage 登记、SQLite 与随包 Git，以及最小合成 store，**没有经过完整 Workspace.open、Controller、业务决定账本或实际 Worker 进程**，回调 `isActive` 不能证明 W2 停稳/归属。

Windows 文件效果提供私有 manifest 读取/CAS、固定源 HANDLE 的排他证据复制、完整卷号/128 位执行目录身份及 Git 锁身份。Git 元数据父目录保留实际 ACL，不修复为私有；仅自有锁文件要求受保护 user-only 策略。锁的完整 File ID 在创建 HANDLE 释放前写入 intent，恢复同时核对 ID 与 token；复制 token 不能接管替换锁。index/ref 使用已批准摘要和锁内版本 CAS，保留独立赢家、用户 staged/磁盘/恢复草稿。

提交后屏障失败/未知结果保留 candidate、实际字节、全部自有锁与 recovery-held 事实，只由显式冷 `finish` 重核版本后继续。真实宿主分别在 locks-held、files-installed、ref-published 退出后可冷恢复同一 commit。额外竞争测试揭示：已安装文件的冷恢复若未取得全部锁，原异常分支会尝试回滚；已修正为直接保留现场并拒绝。修复前日志 `W1/work-lock-recovery-before.tap` 为 1 fail，修复后 `W1/work-lock-recovery-after.tap` 为 1 pass。未提供任何依赖/准备资源声明的冻结输入可返回真实空供给报告；声明了 payload 的项目仍拒绝 `DEPENDENCY_PLATFORM`，未伪造可用模块。

新增 `windows-native-work-lifecycle.test.mjs` **21 项**，完整组件源码及中文空格 ZIP 解压后的 Node 22.23.4 / Electron 44.9.1 Node 模式均各 **244/244**，无失败、跳过或取消。native SHA-256 `24c50e7a9acf52fd77328621c676dc71020efaf0287bc232e3ef55a9ad342eda`；构建退出 0，日志 `W1/build-windows-native-work-first.log`、收据 `W1/build-windows-native-work.json`。当前证据 `W1/work-hosts-final-v2/native-filesystem-hosts-validation.json`、`W1/work-component-roundtrip-final/component-roundtrip.json`，包括实际运行命令、宿主与源码摘要。早期 243 项双宿主通过是补充恢复竞争用例前的历史结果。共享材料/能力/文件/持久化重跑共 38 项：23 pass/15 平台 skip/0 fail，日志 `W1/shared-work-gates-final.tap`；存储安全沿用材料批的 27 pass/7 fail（完整文件）与定向 27/27，本轮未重跑，不外推为当前完整产品通过。

范围继续限定显式入口、本机 NTFS、现有父目录与 100644。普通回调/检查点故障与真实宿主退出、关闭父 HANDLE 的提交后故障分别标识；后者不是磁盘 I/O、断电或原生 UNKNOWN 注入。Git 清理仍是完整 ID/候选核查后的共享 `git worktree remove --force`，没有新增整树原子 HANDLE 删除合同；恶意清理窗口竞争未验收。依赖/准备资源复制、hooks 接受、legacy 迁移、扩展 Git 布局、路径/mode/安全元数据、TxF 产品可用性政策、完整 namespace/断电仍未资格化。

下一批优先接 `WorkChanges` 私有 archive intent/manifest 与完整业务报告/决定账本（当前仍调用全局 unsupported persistence），再补依赖/准备资源原生复制及三个多步事务；W2 原生 incarnation/Job/来源停稳证明是完整 Worker 与外来恢复链的依赖，之后才进入 W3 能力决定、W4 真实 Electron/Pi 工作面与 W5 整应用便携包/干净环境。W1/W2/W3 仍 unsupported，W4/W5 not-run，managedExecution.ready=false。

## Windows WorkChanges 与共享业务账本续批（2026-11-02，当前）

`WorkChanges` 现通过 `work-changes-io.mjs` 分离平台文件效果；显式 `experimentalWindowsRoot` 使用私有 intent/manifest CAS、排他分配、在释放分配句柄前记录完整卷号/128 位 Git 证据库 File ID，并在私有 Git 命令与 blob 流期间保留目录身份/ACL pin。既有未记账证据库保留并拒绝接管；复制 Git 字节到另一个实体也不能取得原归属。归档、不可变对象/receipt、核验、恢复及是否允许放弃仍使用共享状态机。放弃只按已固定的原生 DELETE 文件 HANDLE 删除本地 manifest/intent，保留项目可携的不可变闭包；部分删除/屏障失败保留准确 ID 与 committed/uncertain，不按名字猜测清理。

实际 Git pack 带只读属性。私有树新增显式 `rootAccess=readwrite` 与 `fileAccess=read`，读者可保留根身份、捕获/重核整树名字/ID/字节/ACL，执行目录与父目录 flush；该视图拒绝完整文件 `sync` 和根发布。归档保留 pack 属性，由固定 Git 写入器运行 `core.fsync=all`，本地 intent 明确记录 `directory-barriers-completed` 与 `files=not-flushed-by-this-lease`。这不是原生文件 flush、完整 namespace 或断电资格；新增接口没有改变原默认 writable/move 树合同。

共享 `Workspace` 构造器、报告工件快照与校验现可显式传递 filesystem。20 项新增 native/shared 用例中，3 项使用真实 Workspace/SessionIndex 方法及 SQLite：提交/激活、候选/HTML 报告、WorkChanges 归档、项目报告回执、用户接受决定与精确 mergeAuthorization 同事务落账，冷组件重载后使用已落账授权实际合入；集合 CAS 保留外部赢家、草稿与待核对候选；实际 SQLite 提交后受控丢回调会栅栏当前实例，显式核对转为 inspection-only，不自动续跑队列。测试直接构造未取得宿主归属的业务组件，未调用 Workspace.open/Controller、未启动 Pi/Worker、未伪造 stopped 事实，不能据此声明宿主或进程资格。

其余场景包括 SHA-1/SHA-256、文本/重命名/空文件/删除/二进制、33 MiB 流与文本预算、用户 staged/磁盘/恢复草稿、实际源 GC 与本地缓存丢失、真实宿主在 intent/manifest/receipt 三阶段退出、实际 SQLite 回执提交前/后的回调故障、引用状态拒绝清理、ACL 漂移/损坏赢家保留，以及真正删除后关闭父 HANDLE 的屏障故障。后者与受控业务回调故障分开留证，均不冒充原生 UNKNOWN 或断电注入。早期 `W1/work-changes-first.tap`、`work-changes-second.tap` 保留根 lease 冲突/只读 pack 未支持及 fixture 前置失败；业务首轮 2 pass/1 fail 是缺少共享 SessionIndex 初始化，改为调用实际初始化方法后 3/3，原日志保留。

当前完整组件源码与中文空格 ZIP 解压后的 Node 22.23.4、Electron 44.9.1 Node 模式均各 **264/264**，无失败、跳过或取消。证据 `W1/work-changes-hosts-final/native-filesystem-hosts-validation.json`、`W1/work-changes-component-roundtrip-final/component-roundtrip.json`，逐文件源码/资源摘要随包核对。native SHA-256 `24c50e7a9acf52fd77328621c676dc71020efaf0287bc232e3ef55a9ad342eda`，本批未改 C++/构建入口，复用已实际成功的 `W1/build-windows-native-work-first.log` / `W1/build-windows-native-work.json`；`W1/build-windows-native-work-changes.json` 记录复用来源和逐项未变的 native 源码摘要，不宣称新编译。共享材料/能力/文件/持久化重跑 38 项：23 pass/15 平台 skip/0 fail，日志 `W1/shared-work-changes-gates-final.tap`。完整存储安全 27 pass/7 fail、定向 27/27 仍是材料批历史证据，本批未重跑。

下一关键依赖为 W2 原生进程 incarnation/HANDLE、Job Object 与真实归属/停稳证明，以支持 Workspace.open/Controller 和外来恢复来源。W1 仍需依赖/准备资源复制、Plan Tree/worker-home 技术闭合、三个自定义事务组、路径/mode/扩展元数据/TxF 政策及持久化资格；私有 Git 后代恶意替换和并发清理授权竞争亦未验收。W3 能力决定、W4 真实 Electron/Pi UI、W5 整应用/干净环境继续待办。W1/W2/W3 unsupported，W4/W5 not-run，managedExecution.ready=false；组件 ZIP 使用锁定开发 Electron 宿主，不能视为随包应用资格。Linux/macOS 本轮未运行。

## Windows W2 进程身份首批（2026-11-02，当前）

新增独立 `native/windows-process` Node-API 组件和显式 `experimental-process-identity.mjs`。只读、非继承 HANDLE 固定进程对象，保存精确 100 ns FILETIME 字符串，以同一 HANDLE 的 signaled 状态观察该进程退出；真实退出码 259 与 STILL_ACTIVE 已区分。无法打开的 PID 明确报错，不推断整树退出；结果始终 `treeExitVerified=false`。不 spawn/终止/取得 owner/释放预算或 writer，共享 selector 不变。

实际重建 `W2/build-process-identity-final.log`，回执 `W2/build-process-identity.json`；native SHA-256 `aa5c1a6ad10831768038aa9b554f61530eafb441b08ad70004831ed42a5ec125`。独立组件源码及中文空格 ZIP 解包的固定 Node 22.23.4、Electron 44.9.1 Node 模式各 13/13，零失败/跳过/取消，证据 `W2/process-identity-roundtrip-final-v2/process-component-roundtrip.json`。测试含真实正常退出、退出码 259、两个 incarnation、无关哨兵，以及 leader 退出而显式 detached 后代仍运行；后代由合成 stop 文件自行退出。第一包 Node 13/13、Electron 12/13 的原夹具后代也已退出，失败原件保留，不能视作 Electron 全树回收证明。改为 detached/无管道依赖/文件握手后四组通过。

设计与后续顺序见 [Windows 进程决策记录](windows-process-design.md)：下一批验证执行前 Job 纳管、generation/请求登记、后代继承/脱离/嵌套和宿主崩溃/真实整树停稳，再接共享 owner/冷恢复及 Workspace.open/Controller。创建时间/路径字符串不能代替冷恢复或镜像信任证明。该包使用锁定开发 Electron，仍非整应用。W1 文件桥与 264 项源码/解包资格均未改变；W1/W2/W3 unsupported，W4/W5 not-run，managedExecution.ready=false。

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

## Windows W2 真实 Pi 与共享 Controller（2026-11-02，历史批次）

显式 Windows 服务已接入正常 PiSession.start 与共享 Controller.makeSession，绑定原生私有目录、精确 runtime entry/command、登记前后 owner guard，providers 缓存在 resume 前持久化。修复实际 Pi 日志 readonly fsync EPERM：预建受保护 session 目录，使用现有原生文件 HANDLE lease 刷盘并核对身份，namespace 继续 not-qualified。

9 项实际 Pi SDK/回环 Provider/原生 read/取消/摘要拒绝/并发元数据/Controller/预算场景，连同原 70 项，源码和中文空格 ZIP 解包的 Node 22.23.4 / Electron 44.9.1 均各 **79/79**。证据 `W2/pi-owner-roundtrip-third/process-component-roundtrip.json`，Pi 实际构建 `W2/build-pi-owner-final.log`。ZIP 含固定 Node、角色资源、实际 SDK 与 121 个锁定 Pi 依赖包/许可，执行前后摘要和 CRC 通过；Electron 仍用明确锁定开发宿主，非整应用包。共享回归最终37 pass/2 Linux skip，预算单项1/1，显式 Windows Pi suite9/9；首轮共享文件级无诊断退出及所有开发失败保留。完整说明见 [Windows 进程记录](windows-process-design.md)。

Controller 测试直接构造真实 scoped Workspace/SQLite 组件，不含 Workspace.open/宿主锁资格。完整 journal/租约/stop/cold 恢复、登记释放及再次启动、Worker/候选/接受/重启、其他进程消费点、W1 资源/事务、W3/W4/W5 仍待推进。stop 仍 PI_EXIT_UNCONFIRMED 并保留登记与预算。W0 passed；W1/W2/W3 unsupported；W4/W5 not-run；managedExecution.ready=false；生产矩阵未启用。下一批为宿主/owner 监督租约与可核验退出/冷恢复。

## Windows W2 同一宿主正常退出与恢复（2026-11-02，历史批次）

显式 Pi stop 已接通最后journal回执、原Job/all-incarnation等待、两路EOF、clean protocol与有界host/native drain、日志File ID/摘要/原生刷盘、原登记revision CAS及后检查。opaque平台证明拒绝伪造摘要/克隆receipt；正常确认后共享预算释放，Controller实际恢复原线程且零重放。仅当前活registry持有的明确retired回执允许下一次CAS启动；冷registry、crash无回执、日志漂移、未观察成员、未知提交/后检查失败继续保留登记与预算。

当前源码/中文空格ZIP解包Node22.23.4/Electron44.9.1均各91/91：身份13、Job19、transport22、登记18、实际Pi19。证据W2/owner-exit-roundtrip-first/process-component-roundtrip.json，Pi实际构建W2/build-owner-exit-final.log；共享37pass/2Linuxskip，预算单项1/1。构建/摘要/CRC和全部失败历史见docs/windows-process-design.md当前批次。C++与W1的84项源码闭包未改；未重跑W1全组。

这只证明显式同一宿主局部退出与warm resume。Workspace.open/Controller.open宿主锁、监督租约与冷恢复、完整SDK journal/lease、Worker/候选/接受/重启、其他消费点和W1剩余事务仍待推进。未观察成员即使Job空也不释放；namespace/power-loss仍not-qualified。Electron仍依赖明确开发宿主，组件ZIP不是整应用包。W1/W2/W3 unsupported、W4/W5 not-run、managedExecution.ready=false，生产矩阵未启用。

## Windows W2 显式宿主租约与冷启动拒绝（2026-11-02，历史批次）

新增基于现有W1原生HANDLE的共享项目anchor和本机SQLite宿主代次登记，绑定实际项目/目录/数据库/宿主实体。owner登记显式绑定hostLeaseId；同步保留启动占位，停止宿主立即封住admission，最终登记/身份检查后唯一resume。正常Pi原生确认退休才解除占位；宿主退休做revision CAS和集合/原生后检查。丢回执/外部赢家/后检查失败保留证据，UNKNOWN不重放。冷宿主、另一profile、克隆或旧receipt均不采纳；只有同活实例原始未消费release receipt允许显式再取得租约。

最终源码/中文空格ZIP解包Node22.23.4/Electron44.9.1各115/115（宿主21、实际Pi22等）。真实Pi与scoped Controller warm resume接入，宿主退出/强退后旧登记/草稿保留且模型请求仍一次。权威W2/host-lease-roundtrip-final/process-component-roundtrip.json，原生实际build-host-lease-final.log/build-host-lease.json；共享37pass/2Linuxskip，budget1/1。W1的84项源码与文件桥未改、未重跑264项，开发Electron仍非整包。初轮SQLite初始化失败和历史110项原件均保留，详见windows-process-design.md。

这仍是显式宿主租约前置组件，尚缺保留原Job的监督者、冷来源/catalog/数据库与全树证明、生产Workspace.open/Controller.open及Worker业务闭环。冷取得包括正常retired仍拒绝，不能声称产品重启完成。继续补监督/来源协议，再接共享Workspace/Controller、W1剩余事务、其他进程消费点及W3–W5。W1/W2/W3 unsupported、W4/W5 not-run、managedExecution.ready=false，生产矩阵保持拒绝。

## Windows W2 原 Job 持续监督与冷连接（2026-11-02，历史批次）

新增独立native supervisor，恢复执行前用限定HANDLE_LIST保留原Job/leader/宿主，CompareObjectHandles确认原Job；宿主退出时通过原HANDLE终止并观察原Job。protected用户SID message pipe、实际server/client PID、helper EXE实体/摘要和完整FILETIME核对后，冷连接获得QUERY-only原内核对象。端点不是释放证明，未知/未观察成员继续保留。显式Pi可选supervise，监督绑定真实SQLite prepared行并在最终resume前核验；实际Pi宿主退出/强退后能从登记取端点观察原Job，旧登记/草稿及零重放仍保持。

最终四宿主各127/127（新增监督12项）；证据W2/supervisor-roundtrip-first/process-component-roundtrip.json，实际native build-supervisor-final.log/build-supervisor.json。共享37pass/2Linuxskip、预算1/1。W1的84项源码与文件桥未改且未重跑264项，Pi runtime未改；开发Electron组件ZIP非整包。首次映像路径拒绝与开发日志保留，详见windows-process-design.md。

冷业务恢复仍缺helper保留的项目/数据库/来源catalog租约、完整历史成员及输出/journal证明和UNKNOWN处理协议。helper死亡/系统退出不生成停止结论；端点不能采纳旧owner或释放预算。继续绑定监督与来源实体，再接共享Workspace.open/Controller.open、Worker/候选/Git/重启及W1剩余事务与W3–W5。W1/W2/W3 unsupported、W4/W5 not-run、managedExecution.ready=false，生产矩阵未启用。

## Windows W2 监督者持有宿主 anchor 与本机数据库（2026-11-02，历史批次）

监督者现在可通过W1原生opaque bundle持有共享项目managed-host.lease、实际本机ui.sqlite和两侧完整目录HANDLE链。交付前核对原lease和File ID/已固定ACL；降权DuplicateHandle保留同一FileObject的共享限制，经限定HANDLE_LIST和只读匿名mapping交付helper。固定256个实体/4096字节单ACL上限，原始HANDLE数字仅存在原生临时交付，不进入JS或SQLite。helper从原HANDLE核验实体及ACL，SHA-256指纹排除HANDLE并绑定prepared端点；每次查询/清理重新核验，观察到漂移后持续拒绝。SQLite内容允许正常事务写入，namespace替换仍被拒绝。

显式Pi从同一registry/hostLease创建监督者，登记拒绝其他宿主的监督者；最终resume仍核验原Job与监督。正常退出在原Job/EOF/journal/登记退休证明后确认helper退出；宿主release要求每个原监督者的实际退出确认。helper消失或仅关闭观察对象不生成释放证明。实际Pi宿主正常退出/强退后，旧host/owner/草稿保留、模型请求仍一次，新宿主在helper持有anchor时因真实共享冲突被拒绝。

本批W1已改动并重建：源码Node/Electron、ZIP解包Node/Electron完整回归各264/264。W2源码与中文空格ZIP解包Node22.23.4/Electron44.9.1各134/134，其中新增custody7项、原监督12项、实际Pi22项。证据W1/custody-source-final/native-filesystem-hosts-validation.json、W1/custody-roundtrip-final/component-roundtrip.json及W2/custody-roundtrip-first/process-component-roundtrip.json；双原生构建W2/build-custody.json。共享37pass/2Linuxskip、UNKNOWN预算定向1/1；完整预算suite另有3pass/12fail，均为生产PERSISTENCE_UNSUPPORTED路径，不宣称该suite或生产Workspace可用。开发失败与全部原日志保留。

这只补齐宿主anchor/本机UI数据库实体持有，不包含来源catalog/project.sqlite、完整历史成员、冷输出与journal、业务采纳/释放/重放或生产Workspace.open/Controller.open。helper长期无人接管、外层Job/系统退出与clean app依赖闭包仍未资格化；组件ZIP及开发Electron不是整应用发行包。下一步补来源catalog/project数据库实体与冷核验协议，再接共享Worker/候选/接受/Git/重启和W1剩余事务、W3–W5。W0 passed；W1/W2/W3 unsupported；W4/W5 not-run；managedExecution.ready=false；能力矩阵保持禁用。

## Windows 来源实体与监督者独立摘要绑定（2026-11-03，历史批次）

实验宿主现在同时固定实际 catalog.sqlite、project.sqlite、只读 project.json、宿主 anchor、ui.sqlite 及其原生目录链/已固定 ACL。数据库通过 File ID/单链接/属性/ACL 核验，允许无关业务事务；来源记录直接从共享 SQLite worker 读取 value+revision，不用缓存登记替代。project.json 有界严格 UTF-8/JSON、projectId 与实体摘要核验。每次准入/登记前后复核真实来源修订；同值更新和 ABA 均会拒绝，提交后来源变化保留 STORAGE_RESULT_UNKNOWN 与现场。

独立 helper 持有原始来源记录 SHA-256，经只读原生 manifest v3 交付，纳入 custody 指纹与 IPC v4 返回核验。冷查询对照 helper 保留的原摘要：外部写入者即使同时改写实际来源和宿主 source 声明，仍返回 HOST_SOURCE_BINDING_CHANGED；继续伪造 owner 端点摘要也被原生响应拒绝。攻击前后实测证据分别为 W2/source-binding-probe-before/probe.json（错误接受）及 W2/source-binding-probe-after/probe.json（正确拒绝），永久回归同时核对竞争赢家保留。

冷查询只返回来源与原 Job 的观察事实，不生成任务采纳、退出释放或自动重放许可。四种 normal/forced × prepared/running 宿主退出场景中，先关闭原父进程所有源数据库连接，再验证 helper 独自阻止来源/目录替换，避免其他 SQLite 连接掩盖缺失的保管。真实 Pi 两种宿主退出也核对来源；只读 manifest pin 与正常 checkedMetadata 读取兼容。

最终真实验证：W2 源码 Node/Electron、中文空格 ZIP 解包 Node/Electron 各143/143，无失败/跳过；W1 已重建，同样四宿主各264/264。回执 W2/source-binding-roundtrip-verified/process-component-roundtrip.json、W1/source-binding-source-final/native-filesystem-hosts-validation.json 和 W1/source-binding-roundtrip-final/component-roundtrip.json；双原生构建 W2/build-source-binding.json。共享39项为37pass/2Linuxskip。独立定向28/28。source-custody-roundtrip-first及source-binding-roundtrip-final的解包失败均保留：原测试无条件断言历史完整；换原生fixture仍失败，独立5次探针核对新增成员均为实际System32/conhost.exe（W2/source-binding-history-images.json）。最终测试等待原生fixture实际执行标记，再核验/持有live成员后终止，不假定只有一个进程；漏掉瞬时历史成员仍保留false，原生判断未放宽。完整预算suite沿用此前3pass/12fail的未资格化事实，本批未重跑，不宣称生产预算业务通过。

限制：多数据库读仍非跨库原子快照；256个保管实体、单ACL4096字节、每helper64次inspect transfer限制保持。完整历史成员保管、冷输出/journal与UNKNOWN恢复、业务采纳/释放、生产 Workspace.open/Controller.open 尚未接通。W0 passed；W1/W2/W3 unsupported；W4/W5 not-run；managedExecution.ready=false，能力矩阵未放行。组件ZIP及开发Electron Node模式不等于整应用发行包或产品UI。

下一批按产品闭环推进：先补持续保管历史成员和输出/journal边界，接共享恢复/UNKNOWN协议；再接生产 Workspace/Controller 与实际 Worker → 候选 → 审阅 → 接受 → Git → 重启，补齐W1依赖/资源复制、PlanTree/worker home和剩余多步事务；随后验收W3普通权限/隔离选择、W4实际Electron工作面、W5整应用包和干净用户环境。以Windows产品完成为目标，可调整不适合Windows的共享源码；继续复用业务状态机并保留草稿/竞争赢家/不确定结果。

## Windows 原监督者保管输出与来源绑定冷读取（2026-11-03，历史批次）

原监督者在首次resume前接收stdout/stderr的原始读取HANDLE，精确HANDLE_LIST继承，不重开路径或猜PID。宿主原始读取端关闭后，原生直接readOutput明确拒绝，避免与helper抢读；显式transport一次性attachSupervisor后保持共享Node readable接口，PiSession原业务协议不变。helper持续读取双输出、保留原字节和真实EOF，完成时生成各自SHA-256；IPC v5按channel/offset提供最多64KiB不可消费的range，多个观察者各自从零核验。重复读取不向PiSession重放，不改变原始输出证据。

IPC等待请求/响应/ACK期间继续泵出双流，半连接客户端不能令原Job因管道塞满而无法退出。固定合计64MiB lifetime字节上限，宿主正常消费不删除原证据；超限/读取错误/内存不足保留非零outputError，终止原Job并拒绝完整输出/释放结论。EOF与错误单独报告，空流核对真实EOF及SHA-256(empty)。关闭helper仅在原leader/Job空且输出终结后允许，仍只属于组件清理，不产生业务退休证明。

新增inspectExperimentalColdHostOutput复用真实host/source/owner/原监督者核验：要求Job空、双EOF、无outputError、总量在界内，逐范围读取原始字节并比对helper独立摘要，结束后复核kernel事实和真实来源登记。返回observation-only与automaticReplay=false/ownerReleaseQualified=false；结果不被registry当退出证明。该API不解析/采纳Pi stop-ack，也未固定冷journal。实际Pi在宿主normal/forced退出后均核对已被原宿主消费过的原始协议字节仍可读、摘要一致、来源绑定通过、草稿/owner保留且Provider请求仍一次。

最终W2真实源码Node/Electron、中文空格ZIP解包Node/Electron各153/153，新增输出10项：4MiB二进制+Unicode/独立range读者、无宿主消费者双流、leader先退而后代持管道、normal/forced宿主退出、无效handoff/range/伪造端点、64MiB超限、空流、半连接IPC、helper丢失。既有真实Pi22项在四宿主中通过，共享37pass/2Linuxskip。回执W2/output-custody-roundtrip-first/process-component-roundtrip.json，原生构建W2/build-output-custody.json，最终完整性W2/output-custody-final-integrity.json。本批未修改W1源码/原生模块，按当前二进制和86份源码摘要核对沿用前批源码/解包Node/Electron各264/264；不是本批重跑。前批W1回执为source-binding-source-final和source-binding-roundtrip-final。

开发失败output-custody-first.tap为6pass/1fail，唯一失败是清理钩子通过两个观察者重复关闭同一个helper；按原PID+FILETIME记录并仅关闭一次后，second为7/7、最终扩展为10/10，原失败日志保留。完整生产预算suite此前3pass/12fail的未资格化事实保持，本批不宣称生产预算业务通过。

输出证据保存在原helper内存，helper退出/系统重启后不可验证；不能据此宣称磁盘持久化或恢复完成。完整历史成员、冷journal/stop-ack与共享UNKNOWN恢复、任务采纳/释放、生产Workspace/Controller/实际Worker到候选接受Git重启仍待接入；W1资源/依赖/多步事务及W3–W5保持原缺口。W0 passed；W1/W2/W3 unsupported；W4/W5 not-run；managedExecution.ready=false，能力矩阵未放行。下一批继续将原输出中的结束事实与实际journal和owner代次绑定，再接共享恢复及完整产品流程。

## Windows 原始停止响应与冷会话日志核验（2026-11-03，历史批次）

共享prepareRegisteredOwner将冻结的ownerId/generation/launchId/target/home交给显式准备器；Windows准备器验证后以独立环境传入原Pi进程。绑定启动的成功响应携带method及同一ownerLaunch身份，普通未绑定平台响应维持原形状。实际重建Pi runtime并核对manifest，原生进程/helper/W1二进制与源码摘要保持前批不变，本批不宣称原生重编译。

新增inspectExperimentalColdHostJournal，先核对原监督者保管的完整双流及实际来源/owner修订，再复用共享严格JSONL读取器解析原始stdout。仅接受唯一start、最后唯一stop、不同请求ID、相同原始启动身份及匹配session。终态响应须有原生文件/目录flush、File ID与SHA-256；元数据和journal以W1原始父目录链及拒绝并发写入/替换的文件HANDLE固定，有界读取并核对SDK v3头、cwd、entry数、唯一ID/父链、leaf和原生entry事件。保持pin完成实际屏障和来源/输出后检后释放。范围仍为observation-only，namespace-not-qualified，不生成owner退休凭证。

真实Pi宿主正常/强退、Pi先停止再正常/强退宿主、停止帧截断/重复/代次错误/session错误/屏障未确认共9项通过。先停止的正向场景验证原始stop+journal；仍运行即崩溃、缺帧或错误证据均拒绝。另在真实日志上实测追加字节、同字节换File ID、元数据改写、文件缺失、owner代次竞争；不重建缺失文件，不覆盖并发赢家，草稿和prepared登记保留，provider始终仅收到一次输入。registry拒绝将观察对象当作OWNER_EXIT凭证。

完整源码Node/Electron与中文空格ZIP解包Node/Electron各160/160，无失败/跳过，其中真实Pi29项。定向宿主9/9，共享55pass/2Linuxskip，Pi facts/questions14/14。回执W2/cold-journal-roundtrip-first/process-component-roundtrip.json；Pi重建W2/build-cold-journal.json；最终完整性W2/cold-journal-final-integrity.json。W1按当前86份源码/原生与721项解包闭包摘要核对，沿用前批四宿主各264/264，本批未重跑。首轮cold-journal-host-first.tap为2pass/2fail：夹具在Pi已退出后新开进程身份，改为使用原监督者持有身份后4/4，再扩展9/9；两遗留空Job helper通过原登记端点精确关闭，回执cold-journal-failed-fixture-cleanup.json。失败证据保留。历史完整生产预算3pass/12fail仍未资格化，本批未重跑。

该观察不能证明原宿主实际stop请求准入、pending请求/工具调用/宿主投影全部落稳，不能补齐未观察历史Job成员；stopRequestAdmissionQualified=false、hostProjectionQualified=false、coldRecoveryQualified=false、ownerReleaseQualified=false、automaticReplay=false。helper或系统退出后内存证据丢失。下一批仍须补实际请求准入及宿主投影证据、共享UNKNOWN/冷恢复与完整历史成员，然后接生产Workspace/Controller、真实Worker到文件候选/审阅接受/Git/重启流程。W1资源/依赖/多步事务、W3普通权限执行和W4/W5整应用验收仍待完成。W0 passed；W1/W2/W3 unsupported；W4/W5 not-run；managedExecution.ready=false，能力矩阵未变。

## Windows 原宿主输入保管与停止请求绑定（2026-11-03，历史批次）

监督者在首次resume前接管原始stdin写入HANDLE，同时保留双输出原始读取端，宿主原端关闭，native直接write/poll/close/abort明确拒绝。共享Node Writable接口保持原样；每个最多64KiB输入块只提交一次，helper先保留实际字节再发起overlapped写，累计确认原生完成字节，不确定结果不重发。独立64MiB lifetime输入上限；超限终止原Job并保留非零inputError。pending abort保留错误和实际已确认前缀，不把取消报告当完整投递。

IPC v6从kernel取得pipe peer并用CompareObjectHandles核对原宿主进程HANDLE，只有仍存活的原宿主可write/poll/close/abort；冷观察者及同用户其他进程只读。offset CAS拒绝陈旧重发，客户端在失去结果后保持UNKNOWN；原宿主或leader退出时固定关闭输入，完整字节生成独立SHA-256。readInput按不可消费的有界range供观察；IPC等待中继续泵出双输出与pending输入，不因背压停止输出保管。

inspectExperimentalColdHostInput要求实际来源/owner修订、原helper身份、Job已空、inputClosed、无pending/error、accepted==completed及摘要一致。冷journal检查同时解析原宿主输入，要求唯一且有序的start/stop请求，stop为最后输入帧，请求ID各自匹配原Pi响应，原start路径与启动身份一致；结束时复核输入、输出、来源及固定journal。stopRequestAdmissionQualified=true仅限original-host-native-delivery-and-matching-Pi-dispatch-only，不表示宿主业务准入/投影落稳；hostProjectionQualified=false、coldRecoveryQualified=false、ownerReleaseQualified=false、automaticReplay=false继续保持。

新增8项真实输入场景：多MiB Unicode/二进制与独立读者、先写/关闭拒绝handoff、真实背压与abort、64MiB超限、外进程控制拒绝、真实丢IPC回复/陈旧offset零重发、正常/强退宿主后的输入保管和冷写拒绝。新增实际Pi停止响应请求ID不匹配拒绝，真实Pi共30项；其余stop/journal/草稿/并发赢家/单次provider行为维持。定向输入+输出+Pi为48/48；完整源码Node/Electron与中文空格ZIP解包Node/Electron各169/169，无失败/跳过。共享55pass/2Linuxskip。首轮定向16pass/2fail是夹具固定延时和raw IPC连接竞争，改为实际握手/在resume前连接后通过；原失败日志保留。共享首轮误写不存在测试basename只运行52项，已纠正真实pi-session-admission.test.mjs并完整运行57项，最终证据不使用缺项首轮代签。

权威回执W2/input-custody-roundtrip-first/process-component-roundtrip.json，实际原生重建W2/build-input-custody.json（最终构建日志build-input-custody-second.log），完整性W2/input-custody-final-integrity.json。Pi runtime未改，manifest与前批实际重建摘要一致。W1按86份源码、原生摘要及721项解包闭包核对沿用前批四宿主各264/264，本批未重跑。历史完整生产预算3pass/12fail不变且未重跑。

原helper内存证据不跨helper退出或系统重启；宿主pending请求、工具效果与native投影落稳尚无可恢复闭环，历史成员与共享UNKNOWN/冷登记退休尚未资格化。下一步补共享业务投影/恢复，继续接生产Workspace/Controller和真实Worker文件修改→候选审阅→接受→Git→重启；W1资源/依赖/多步事务、W3普通权限执行、W4真实Electron、W5整应用依赖和干净用户验收仍需完成。W0 passed；W1/W2/W3 unsupported；W4/W5 not-run；managedExecution.ready=false，能力矩阵未变。

## Windows 真实共享打开入口（2026-11-03，历史批次）

将 Workspace 的宿主获取、目录/Plan Tree 和 SessionIndex 文件效果抽为 workspace-io.mjs，复用原共享 Workspace/Controller/SQLite 状态机。默认 Windows 打开在创建 runtime/host.lock 前拒绝。显式 createExperimentalWindowsWorkspaceIO 使用原生共享项目宿主租约，核对获取前后的项目绑定，固定 runtime 目录和 create-only workspace-binding.json；绑定项目/实例/metadataRoot/本地数据库目录及其 File ID。另一项目不能共用目录，已有绑定不被覆盖。目录/文件都经原父链及私有 ACL 检查；SessionIndex 采用原生 create-only 发布和有界读取，Plan Tree 用原生 SHA CAS 和目录屏障，MemoryVersion 注入原生读取。Worker home 归档尚未接入，副作用前明确 WORKSPACE_CLEANUP_UNSUPPORTED。

共享写入在宿主登记检查前后运行；业务前检查拒绝并发宿主赢家，实际存储提交后宿主检查失败保留 STORAGE_RESULT_UNKNOWN、草稿和宿主登记，不自动重投或退休。close 同步封口并等待队列，只返回原始不透明租约退休凭证；同进程原凭证可单次 warm reopen，序列化/缺失凭证与真实宿主退出后 cold reopen 均拒绝。Controller.open 使用真实初始化/restore，ownerLaunchFactory 接收原 hostLease，stop 在原 Pi 退出确认后返回宿主凭证。尚不声明整套投影/工具效果恢复或生产能力。

新增16项真实公开入口场景，含草稿/Work 激活/warm reopen、默认与非法适配器拒绝、重叠目录、跨 runtime 争用/独立进程重命名拒绝、伪造凭证、SessionIndex 归档/冷读取/损坏赢家保留、真实共享 Plan Tree 外部 CAS 赢家、MemoryVersion 主题版本、Controller.restore 零启动、ACL 漂移、实际提交后宿主丢失 UNKNOWN、SQLite 宿主登记赢家、Worker 清理拒绝、跨项目 runtime 绑定、实际 public-open 宿主退出。新增1项 Controller.open→真实 Pi 单次 loopback 输入→共享原生投影/归档→确认 stop→宿主退休；Pi 共31项。该 Pi 测试使用隔离夹具显式模型目录，不声明生产配置或冷来源恢复。

完整 W2 源码 Node/Electron 与中文空格 ZIP 解包 Node/Electron 各186/186，无失败/跳过；入口定向16/16，含Pi定向16/16，共享57项55pass/2Linuxskip。W1因共享源码变化实际重跑，源码及解包 Node/Electron 各264/264；闭包新增 workspace-io，不沿用旧源码摘要。回执 W2/workspace-open-roundtrip-second/process-component-roundtrip.json、W1/workspace-open-source-first/native-filesystem-hosts-validation.json、W1/workspace-open-roundtrip-first/component-roundtrip.json；完整性 W2/workspace-open-final-integrity.json。原生和Pi源码/二进制摘要与最近实际构建一致，本批没有宣称重新编译。早期夹具断言、已退休registry读取、eval参数继承和旧源码字符串测试失败全部保留，已由实际运行验证修正。

首轮完整W2 driver在并行W1负载下触及原有180秒总时限，源码Node组未完整收尾，回执workspace-open-roundtrip-first为failed；保留原日志，不计通过。W1结束后用相同180秒时限独立重跑，当前权威为workspace-open-roundtrip-second；未放宽超时。

当前只取得显式公开入口组件资格。生产 selector、宿主 pending/tool/native 投影落稳与共享 UNKNOWN/历史成员/冷退休、资源/依赖复制、Worker 目录归档、多步事务、Worker→候选→审阅接受→Git→重启全程、W3普通权限执行、W4真实Electron/IME/剪贴板/多窗口、W5整应用包/干净用户仍未取得资格。W0 passed；W1/W2/W3 unsupported；W4/W5 not-run；managedExecution.ready=false，能力矩阵未放行。

## Windows 实际 Worker 审校与 Git 归档闭环（2026-11-03，历史批次）

共享 Controller 显式传递 Workspace 的 ExecutionWorkspace/WorkChanges 文件效果和工件 filesystem；文档编辑复用共享 intent/重复调用合同，Windows 用原生 SHA CAS 发布，冷组件重读可核对已生效修改而不重复应用。工件校验读取实际摘要，发布前后变动可被发现。原生接受身份检查使用当前真实 Session/Job incarnation、原 prepared 登记回执及本机 SQLite 当前 revision/全部字段，拒绝 Linux 格式误判、伪造代次和独立登记赢家；原 Linux 路径保持原合同。

实际场景经 Controller.open/start/send 和原共享调度器启动前台、后台及 Worker 三个真实 Pi owner。隔离模型配置在各自真实 home/config 中，全部请求仅发往本机脚本 HTTP：真实文档读→SHA CAS修改→冻结候选报告，共3次请求。源项目接受前保持基线；用户 reviewSave 保存精确人工审校版本，旧 reviewVersion 接受零写入拒绝，reviewAccept 绑定当前版本并交给共享宿主 Git 合入。原始 Session/Job/EOF/最终原生 journal 确认后才停止/释放 Worker 名额，保留其他文件及前台/后台未发送草稿。

Worker home 归档复用共享 closure 状态机：先核对原宿主内存保留的真实 owner 退休回执与当前 SQLite 行。退休证明携带启动时原生pin的home File ID，以及最终确认journal的原相对路径/File ID/SHA；首次创建意图前即拒绝被替换的源目录、已修改或被改名的journal。再 pin 完整私有树，持久化原 home/destination/File ID/身份内容ACL清单摘要，执行无覆盖目录发布/屏障。范围是完整私有 owner home，包含真实 config/sessions journal 与配置；没有宣称凭据删除。实际移动后注入回调丢失，closure 被阻断且 Git结果/intent 保留；重新出现的源目录、journal内容漂移及替换目标目录均拒绝并保留独立赢家。恢复原实体/内容后精确重试只核对/同步原归档，不执行第二次移动。最终 journal SHA 与原生停稳证明相符。完整配置供给、跨目录事务原子性和恶意释放窗口/断电持久性仍未取得产品资格。

确认停止全部3个owner并取得原宿主退休凭证后，同进程 Controller.open 恢复已完成 closure/人工版本/Git状态和未发送草稿，零会话启动、零 provider重放。此为原始不透明单次凭证的 warm reopen；进程重启/异常退出后的 cold 宿主/owner恢复依然拒绝，不以本场景代签。

W2 源码 Node/Electron 与中文空格 ZIP 解包 Node/Electron 每组190/190，无失败/跳过；包含18项打开入口、32项实际Pi/Worker场景。公开入口/owner定向40/40，共享回归57项中55pass/2Linuxskip。W1新增3项真实文档CAS/外部赢家/提交后丢回调恢复，受影响的共享源码实际重跑，源码与ZIP解包 Node/Electron每组267/267。权威回执 W2/worker-flow-roundtrip-first/process-component-roundtrip.json、W1/worker-flow-source-first/native-filesystem-hosts-validation.json、W1/worker-flow-roundtrip-first/component-roundtrip.json；完整性 W2/worker-flow-final-integrity.json。原生/Pi源码与二进制逐项摘要仍等于最近实际构建，本批复用，不宣称重新编译；组件ZIP也不是完整应用包。

开发过程失败日志 worker-flow-first 至 ninth（seventh 为早期正常路径通过）全部保留：工具开关夹具、Linux stamp实际接入缺口、绕过调度器导致的正确in-flight拒绝，以及新增故障测试的字段/字节类型错误。最终使用公开调度器，未放松执行中/进程停稳/UNKNOWN保护。

当前交付仍为显式组件范围。下一阶段优先完整依赖/准备资源供给、共享 pending/工具效果/native投影/UNKNOWN及宿主冷恢复，再做W3普通权限执行、W4真实Electron工作面/IME/系统剪贴板/多窗口、W5整应用依赖闭包和干净用户运行。W0 passed；W1/W2/W3 unsupported；W4/W5 not-run；managedExecution.ready=false，能力矩阵未放行。

## Windows 公开源依赖与准备资源供给（2026-11-03，历史批次）

共享 worktree-dependencies 抽离文件效果，继续统一判定冻结 package/lock、资源声明、出处、已有目标与供给报告；修复根声明被重复处理。显式 Windows versioned adapter 仅增加窄 provisioning 接口，supported=false、泛用 chain/rename 与生产能力矩阵保持禁用。

新增原生只读 public-source directory 类型，与私有写入类型用不同 native receiver tag 隔离；借用 private mutator 也真实拒绝。固定祖先/子目录/单链接文件 HANDLE，观察原 owner/group/DACL、不修复源 ACL，逐级相对枚举，冻结名字/File ID/内容/ACL摘要和有界流。复用同一个树清单/流式独立复制实现，将普通 ACL 源复制成排他私有目录与文件，并核对创建 ID、字节和文件/目录屏障。目标以无覆盖 native move 发布，既有目录/文件/交接点及晚到赢家保持原样。门文件读取 HANDLE 保留至结束，独立进程改写实际被拒绝；发布前复核源成员/内容。NTFS 必须释放后代后移动，释放窗口中的真实字节修改会在移动后复核中报告 committed/UNKNOWN，保留赢家而不伪称原子快照。

暂存 marker 先同步。清理只接受当前操作原始分配的整树 File ID 与字节，新增或替换内容使清理拒绝；未知旧目录不按 workId marker 擅自删除。旧 matching stage 经原生读取 marker 后要求显式恢复，阻止新复制；真实复制宿主中途 exit 后新宿主实测保留原 marker/部分负载，未再分配。已记录 copy-result-unknown 的共享报告在普通 prepare/reopen 中原样保留，不自动重放。尚未实现旧暂存/UNKNOWN 的显式冷协调，不能把“保留并拒绝”写成恢复完成。

新增19项：普通源ACL/不同native类型权限、Unicode/空目录/33MiB、真实独立Node导入与写入隔离、源/Worker冻结不符、已有目标/交接点、源硬链接/交接点拒绝、复制中源新增、独立门文件写入拒绝、晚到目标、发布回调丢失、真实宿主退出、清理新增赢家、发布释放窗口变化、根/嵌套依赖与资源、声明无效/已跟踪资源，以及实际共享 Work.prepare→候选Git排除。公开 Controller 的真实三Pi owner闭环新增冻结依赖/资源，实际Worker执行目录的Node可导入/读取；原文档工具→候选→精确人工审校/Git→原owner退休→完整home归档中断重试→warm reopen仍通过，Provider只收到3次本机请求。没有宣称模型执行过依赖工具、安装脚本或联网安装。

实际重建 W1 native，构建回执 W1/build-provisioning.json；process/helper/Pi摘要核对复用既有构建。最终W1源码Node/Electron、中文空格ZIP解包Node/Electron每组286/286；W2同样四宿主每组190/190。共享相关52项为50pass/2Linuxskip；平台文件/持久化回归详见W1/provisioning-platform-first.tap。权威回执 W1/provisioning-source-final/native-filesystem-hosts-validation.json、W1/provisioning-roundtrip-first/component-roundtrip.json、W2/provisioning-roundtrip-third/process-component-roundtrip.json；最终完整性 W1/provisioning-final-integrity.json。初轮专项8pass/6fail、初轮全量旧假设失败、W2首轮静态测试import收集失败均保留。W2第二轮三个宿主190/190、解包Electron189/190：只读监督者测试假定Job-empty时原后代HANDLE立即signalled；改为分别等待各原HANDLE实际退出后复核，生产停稳规则/native未变。监督者定向Node/Electron各12/12，再按最终源码完整重跑。

范围：本机NTFS x64、普通单链接文件/目录、每树最多10000项/1GiB。源symlink/junction/hardlink、未资格化别名/卷拒绝，不悄悄跳过后宣称可用；目标复制屏障为namespace-not-qualified。源链接实体化、更大真实项目负载、旧暂存/UNKNOWN冷协调、完整生产消费/多步事务、历史进程成员与pending/工具/native投影冷恢复、普通权限产品执行、实际Electron工作面及整应用包仍待验收。W0 passed；W1/W2/W3 unsupported；W4/W5 not-run；managedExecution.ready=false，能力矩阵未变。

## Windows 供给完整副本的持久意图与冷协调（2026-11-03，历史批次）

共享 worktree-dependencies 继续统一冻结门文件、资源声明、出处、报告和已有目标策略；ExecutionWorkspace 在原 Work manifest CAS 中保存独立 operation ID、Work/源/目标/冻结门绑定、分配前命名与父 File ID/实际 ACL、已分配暂存根及完整复制后的原始 ID/内容/ACL 清单。普通项目父目录只观察实际 ACL，不改权限；private-only 写入检查不放宽。恢复入口 reconcileDependencies 使用同一Work串行队列，先要求项目在线并验证 Work 的原 Git/执行目录身份。默认 prepare/reopen 对未决意图仍保持拒绝，显式协调先于普通 existing-target 快捷路径；源/Worker资源声明发生变化、当前无法再发现原负载时，共享报告仍从持久意图补回原UNKNOWN，不能用新声明抹去旧分配。

完整复制已获确认后退出，可复核原父/暂存实体及清单，继续发布同一副本；发布前先保存意图，发布后退出或丢回调则核对原目标的完整清单、重新完成真实文件/目录屏障，零重复移动。清理前持久化原剩余成员清单，每次删除前记录 pending，删除和真实父目录屏障后记录 remaining；新宿主核对仅原 pending 可能缺失的精确剩余树，恢复到根删除后的最终保存窗口。原目标/源/门文件/父目录发生变化、同字节换 File ID 或新增暂存成员均保留 UNKNOWN/现场，晚到目标赢家不被删除。manifest CAS 未获确认时直接中断后续发布/清理/其他资源，不把不确定提交当作已失败。

新增11项、供给专项共30项：真实子进程在完整复制、移动前、发布后、marker删除后和根删除后退出；原副本/发布零重放；晚到目标与清理恢复；字节/相同字节身份/成员/绑定/源/门/父替换；部分复制退出继续UNKNOWN；CAS提交前失败或真实提交丢回复阻止后续资源。实际共享 Work.prepare 注入真实发布后丢回调，新 ExecutionWorkspace 显式协调后继续生成真实 Git 候选，依赖/准备资源保持候选排除。已有实际Controller/三Pi Worker审校/Git/退休/归档/warm reopen场景也完整重跑。

W1 native实际重建，build-provisioning-recovery.json；源码与中文空格ZIP解压 Node/Electron 各297/297，无失败/跳过。W2 process/helper/Pi按原构建摘要复用；源码/解压四组各190/190。共享57项为55pass/2Linuxskip。证据 W1/provisioning-recovery-source-authoritative/native-filesystem-hosts-validation.json、W1/provisioning-recovery-roundtrip-second/component-roundtrip.json、W2/provisioning-recovery-roundtrip-second/process-component-roundtrip.json，最终完整性 W1/provisioning-recovery-final-integrity.json。开发first/second/third的ACL类型/句柄冲突与fifth旧Linux默认入口10项拒绝及一项fixture预期错误全部保留；最终没有放宽生产检查。

本批取得的是已确认完整副本的显式冷协调。复制中途/原分配身份尚未入账的现场继续UNKNOWN，marker不授予删除权；尚无逐文件分配前账本/部分字节协调。每树10000项/1GiB、Work证据16MiB有界，重复完整CAS保存的大规模性能未资格化。namespace/断电屏障仍未取得产品保证，不等于系统重启、宿主pending/tool/native投影或owner冷退休恢复。源链接/更大项目、完整生产消费/多步事务、W3普通权限、W4实际Electron/IME/剪贴板/多窗口/应用重启、W5整应用包仍待验收。W0 passed；W1/W2/W3 unsupported；W4/W5 not-run；managedExecution.ready=false，能力矩阵未变。

## Windows 真实桌面启动与私有 profile（2026-11-03，历史批次）

基于 release/alpha.4 的真实 main.cjs 入口，修复窗口前演示登记表 eager save 使用 Linux persistence 而退出的问题。共享 GuidedDemo 仍统一恢复 epoch、保留 inflight UNKNOWN 和串行 mutation；桌面记录文件效果单独抽出，Windows 只选择私有 profile 内有界原生 HANDLE 读取、保护 ACL 子目录、SHA CAS 文件发布与实际屏障。演示登记保存使用原始读取版本；DesktopHost 外观/修改者设置也绑定观察版本，writeVersioned 不为旧 mutation 偷换成新读取版本。独立进程赢家、损坏 JSON、ACL 漂移均拒绝并保留。Chromium 启动前建立 desktop/omp/migrations 私有子目录；已有宽松 ACL 不自动修复。

DesktopHost 仅为私有 profile catalog 显式传递原生 ProjectStorage/SQLite root，实际保留原始目录和数据库 HANDLE、拒绝独立重命名；没有启用项目 initialization。真实 project.pick 在项目 .nozeli 分配前仍返回 PERSISTENCE_UNSUPPORTED。project-git 的全局能力检查、POSIX 身份和 path 写入尚待抽离/接入，不能为了阅读跳过 Git 初始化或在不安全路径上继续写。

新增6项定向测试，源码 Node/Electron 与解压包内 Node/重命名 Nozeli.exe 的 Node 模式四组各6/6，无失败/跳过。固定入口 node tools/test-suites.mjs windows-desktop-profile。实际渲染器构建退出0；受影响共享回归6项为3pass/3Linuxskip，不宣称 Linux/macOS 实机回归。本批未修改 native/Pi 构建输入，逐项核对最新 W1 build-provisioning-recovery、W2 build-input-custody/build-cold-journal 后复用二进制，没有伪称重编译。

实际制作完整目录候选闭包，包含 Electron、当前 src/renderer/assets、生产依赖、W1/W2 native/supervisor、固定 Node/Pi/MinGit 及许可证资料；25,270文件、1,240,745,718字节，ZIP SHA-256 为 7e890a55a287a5ed02ca759fa847daefb93dfc1d083cd010e54ebc03fd1a5d32。中文和空格目录解压，逐文件摘要/ZIP CRC/运行后源码一致性通过。包内 Pi/固定 Node/MinGit 在仅 Windows System32 的 PATH 下实际解析/执行版本检查；未启动 Pi 或模型。

源码客户端和解压 Nozeli.exe 分别执行“显示原生窗口→稍后配置→真实IPC保存外观与修改者设置→准确拒绝项目初始化→正常关闭→全进程重启→读回精确设置/空恢复表→正常关闭”，各4项检查、两个进程均退出0，无 renderer error。测试使用全新合成 profile，当前继承宿主为非管理员令牌；没有读取个人项目/账号或发起付费请求。记录 native isVisible；早期 renderer document.visibilityState 在窗口被遮挡时为hidden，不以截图或页面就绪冒充物理输入/IME资格。

证据 W4/profile-qualification.json、W4/profile-suite-final-cas/report.json、W4/profile-extracted-final/report.json、W4/startup-source-authoritative/report.json、W4/startup-extracted-final/report.json、W4/profile-package-final/package.json、W4/runtime-extracted-final.json、W4/profile-final-integrity.json。开发失败、历史旧快照和打包中源码变动被拒绝的回执全部保留。

范围仍是隔离测试实例的启动/私有设置和空 catalog。未验收真实账户 singleton/启用自动更新、旧 profile ACL/配置锁迁移、项目登记/Git baseline/源读写/草稿/批注、物理IME/系统剪贴板/多窗口、托管业务冷恢复和干净账户/DLL闭包。应用候选可启动不等于可日常工作或可发行；随包合成测试只用于本地资格验证。全局能力矩阵未放行，managedExecution.ready=false；W0 passed，W1/W2/W3/W4/W5 unsupported。W4/W5由not-run改为unsupported，表示已实际运行部分场景但完整门未通过。

## Windows 项目阅读、编辑与草稿主链（2026-11-04，历史批次）

基于 release/alpha.4 继续落地。DesktopHost 已选择分别核验 profile 和每个已选择项目的原生作用域；主线程保留项目根 File ID/ACL 句柄直到全部数据库线程确认停止。未选择的 sibling 与 profile/project 重叠拒绝，项目同路径换实体保留外部赢家与原私有草稿。StorageDatabase 关闭同步封闭 admission，并等待关闭前已接收的 receipt reconciliation；实际停止未确认继续保留作用域，不以 request 已回复冒充 worker 已退出。

共享 ensureProjectGit 仍统一新建/已有仓库、敏感文件名排除、初始基线、ignore、index/ref、原 operation journal 和重试策略；文件效果抽到 project-git-io，Windows 选择原生目录身份/保留句柄、源 HANDLE 流、排他锁、原读取 SHA CAS、create-only index 和实际 flush。已有 dirty HEAD/index/源字节不覆盖，父仓库仅增项目范围 ignore，commit-prepared 之后不捕获后来的用户文件。公开 .gitignore 保留 owner/group/protection/全部 ACE；Windows 可规范化自动继承 bookkeeping。Windows 链接/重定向 Git 目录、含 reparse 的基线目录继续准确拒绝。

DesktopHost 源读取改用已选择作用域内的原生 HANDLE；文本保存沿用共享草稿/历史/批注映射状态机，在 TxF 锁内比较原先读取摘要。基线使用独立私有恢复材料库；外部原文变化、最终检查后的晚到写入、原文件删除/明确重建、外部 index/ignore 赢家都保留原事实。TxF 不可用时没有普通 rename 回退，namespace/断电持久性仍未资格化。Office 等调用点已传原基线摘要，但此批不为其完整界面验收签字。

固定测试入口 node tools/test-suites.mjs windows-desktop-project。本批36项（含原profile6项）：源码 Node/Electron 与解压固定Node/Nozeli.exe Node模式四组各36/36，无失败/跳过；独立实际进程验证草稿/材料冷重开。共享关闭回归10/10，renderer实际构建退出0。native/Pi源码输入未变，按W1/W2原实际构建回执逐项复核复用，没有宣称新native编译或Linux/macOS实机回归。

两套真实GUI在源码和中文空格解压Nozeli.exe均通过：第一套6项，窗口可见→稍后配置→项目pick/共享Git基线→HANDLE读→文本CAS保存→外部冲突/草稿保留→退出与全进程重开；第二套5项，实际Markdown→CDP鼠标选区及Shift+Arrow含中文锚点→本地批注与原始材料→键盘编辑/Ctrl+S→未保存文本恢复账本→全进程重启读回原批注。四套共8个应用进程正常退出0，无renderer error，child PATH仅System32。当前继承令牌非管理员；CDP键盘/选区不等于物理中文IME，未配置provider或调用模型。

新本地候选闭包共25,282文件、1,240,816,620字节，ZIP SHA-256 6f148de0fec5e0ae1d2631a0d17587aa908e78557f3fc0882da8161c22e58529；包含当前src/dist/assets、生产依赖、Electron/native/supervisor/固定Node/Pi/MinGit及许可证数据和合成验证文件。CRC、25,282解压文件摘要、770个src/dist与源码一致性、测试文件一致性、native输入与Git diffcheck均通过；无非忽略二进制进入Git。此为本地资格候选，不是安装器或完整发行。

证据：W4/project-qualification.json、W4/project-source-first/report.json、W4/project-extracted-first/report.json、W4/project-startup-source-authoritative/report.json、W4/project-startup-extracted-first/report.json、W4/project-reading-source-authoritative/report.json、W4/project-reading-extracted-first/report.json、W4/project-package-first/package.json、W4/project-runtime-extracted.json、W4/project-final-integrity.json。早期同步断言、祖先可写权限、SDDL bookkeeping、shell未绑定和一次真实关闭超时均保留。关闭超时后两次源码与一次解压真实阅读均正常退出；不据此宣称长时间关闭压力资格。

剩余：物理IME/系统剪贴板/多窗口、旧profile ACL/配置锁迁移与账户singleton/更新门、文件树变更/Office/TeX/终端等剩余消费、托管pending/tool/native投影/owner冷恢复、源链接与大项目、TxF可用性/完整namespace屏障，以及干净普通账户DLL/安装发行。项目根在storage存活期间保持pin，不宣称支持在线移动。W0 passed；W1/W2/W3/W4/W5 unsupported；managedExecution.ready=false，全局能力矩阵未放行。

## Windows 系统文本剪贴板、多窗口与关闭重开（2026-11-04，历史批次）

本批新增真实Windows交互验收，生产src/dist与上一项目批逐文件摘要一致；没有修改业务状态机或放宽能力。新增 tests/windows-desktop-interaction.mjs 与独立 Python ctypes/Win32 clipboard oracle。实际Ctrl+C/Ctrl+X、剪切撤销、独立Win32写入后Ctrl+V（CRLF转LF，中文/emoji/组合字符保留）、document.clipboard IPC和可信navigator.clipboard写入均经独立进程读取CF_UNICODETEXT核对。原剪贴板各格式只保存在oracle内存，拒绝无法安全恢复的handle格式；最终源码和解压测试均恢复各自开始前的6种格式，不输出原内容，更新的外部赢家继续保留。

真实双文档WebContentsView同时可见，分别键入只改变焦点文档；合成compositionstart期间拆出请求准确返回COMPOSITION_ACTIVE，原窗口/缓冲保留。结束组合后通过UI拆出为第二个可见原生窗口，再停靠；WebContents ID、generation、原DOM编辑器、精确Unicode缓冲、选区与真实撤销栈不变。截图仅记录宿主chrome或内容面，不冒充整个系统合成窗口。CDP键盘/合成composition不是物理中文IME/TSF候选证据。

随后双面关闭前新输入草稿，正常退出后核对磁盘原基线不被关闭覆盖，完整重开从恢复账本读回精确草稿；另做4组键入→正常关闭→全进程重开→逐字核对→正常关闭。源码和中文空格解压Nozeli.exe各7组检查、10个实际应用进程正常退出0、renderer errors为空；共20进程及8组追加编辑/重开。每进程释放调试listener，PATH仅System32，未初始化provider或调用模型。这个有界批次不代表长期压力、崩溃/系统重启，前批一次真实关闭超时仍无根因结论。

开发失败均保留：空executable参数、Python按Windows locale误解UTF-8 JSON、断言错误的内部composition码，以及忽略现有自动保存的磁盘预期。编码误判的早期second/third/fourth运行结束时保留了测试生成文本，未恢复测试前剪贴板；原内容只在已退出oracle内存，不能从日志还原。第五次起使用显式UTF-8并识别nonce合成赢家，最终源码和解压运行恢复各自开始状态。不能把最终恢复成功描述为恢复了整批调试前的剪贴板。

renderer实际构建退出0，共享WindowRecovery回归26/26。本批native/Pi输入未变，按原W1/W2构建回执核对复用，不宣称新native编译或新四宿主组件重跑。新本地资格候选25284文件、1240841844字节，ZIP SHA-256 d069790072937261dd11b4708a7061350973c2021f757022fa9dae511566aac6；CRC、完整解压摘要、770个当前src/dist与所有随包测试、native输入均核对；包内固定Node/Electron/MinGit/Pi解析在System32-only PATH下通过。Python仅用于随包合成验证，不是用户运行依赖。不是安装器或完整发行。

证据 W4/interaction-qualification.json、W4/interaction-source-eighth/report.json、W4/interaction-extracted-first/report.json、W4/interaction-package-first/package.json、W4/interaction-final-integrity.json、W4/interaction-runtime-extracted.json、W4/interaction-shared-close.tap。完整门仍为W0 passed，W1/W2/W3/W4/W5 unsupported；managedExecution.ready=false，能力矩阵未放行。

下一批：默认启动/更新准确门控、旧profile ACL/配置锁与账户singleton。已观察Windows更新器先进入Linux ownedDirectory/getuid并显示内部异常，须在任何更新存储/网络前明确unsupported。物理IME、文件系统剪贴板/拖放、Office/文件树等剩余消费、托管pending/tool/native投影与owner冷退休、部分复制UNKNOWN/源链接/大项目、TxF/namespace屏障及干净普通账户发行仍缺。

## Windows 独立配置与更新平台门控（2026-11-04，历史批次）

修复Windows启动更新器先进入Linux ownedDirectory/process.getuid、创建updates后显示内部异常的问题。共享AutoUpdater在构造/初始化、显式/自动检查、偏好写入、安装、直接请求/标签解析与停止状态路径上准确保持unsupported；文件目录检查、解包、安装helper和health回执也在副作用前拒绝。仅Linux x64保留既有发布合同和源码check-only语义，Windows/macOS/其他架构不读取更新文件、不建目录/排定时器、不发请求/派生helper/退出应用。主入口不消费不支持平台的health交接。状态增加checksSupported、平台/架构/reason/policy，界面准确说明此平台不支持并禁用检查/启用控件；没有实现Windows自动更新。

共享nozeli-config继续拥有独立初始化staged→complete判定，Windows file effects接入原生私有HANDLE有界读取、原观察摘要CAS与真实屏障。原PID+unlink配置锁改为Windows专用持久gate：固定内容的私有文件由原排他HANDLE持有，正常/进程直接退出只释放HANDLE，文件保留，不根据PID存活推断删除。独立进程竞争准确拒绝，实际holder process.exit(37)不执行JS finally后原gate继续可用。未知旧configuration.lock、未知gate内容/权限或损坏JSON保留并拒绝，不自动迁移修复。

Windows独立配置的暂存目录由原分配File ID入共享journal，恢复核对原目录实体并保留native pin直至结束；独立stage必须为空，marker仍用原读取SHA CAS。只通过原HANDLE删除已核对的空目录，替换目录/新增内容/外部marker赢家保留；无原stageIdentity旧记录要求显式恢复。Windows legacy import准确unsupported且不读取外部配置；apiKeyImportSupported=false。完成marker后清理中断仍可能保留stage，通用orphan清理和断电/重启保证尚未完成。

固定入口 node tools/test-suites.mjs windows-desktop-update；11项（4更新/7配置）在源码Node/Electron与中文空格解压固定Node/Nozeli.exe Node模式各11/11，无失败/跳过。包含缺失更新目录保持缺失、enabled偏好/未决handoff/损坏status字节保留、强造candidate/health/direct helper拒绝、原生配置CAS外部赢家、ACL漂移、legacy lock、原stage恢复/替换/新增及真实持有宿主退出。原项目scope/storage/Git/读写/草稿36项在四宿主完整重跑各36/36，renderer实际构建退出0；共享release语义排序1/1，平台策略验证Linux x64可用，未取得Linux/macOS更新器实机回归。

真实GUI在源码和解压各4项、2进程正常退出：启用本机loopback更新fixture并传health交接→可见启动→实际更新设置准确禁用与直接IPC阻断→经“查看初始化状态/使用独立配置”完成真实配置→退出重开读取同一complete→已有enabled偏好/未完成handoff/损坏status不变；本机feed请求始终0，不生成health回执。真实阅读/选区批注/键盘保存/草稿重开GUI也在源码和解压各5项、2进程退出0。四套共8应用进程，无renderer error，仅System32 PATH，未创建个人项目/配置账号或调用模型。

新本地资格包25290文件、1240876761字节，ZIP SHA-256 d72009f912d3b3394b4e480fb6c54e938c705b6de5f4e998d7431632bccdba1a；CRC、所有解压文件、772个src/dist及随包测试与当前源码一致，native/Pi输入核对原实际构建回执复用，无新native编译声明。包内固定Node/Electron/MinGit/Pi解析通过；不是安装器/正式发行。

证据 W4/default-qualification.json、W4/default-source-authoritative/report.json、W4/default-extracted-authoritative/report.json、W4/default-project-regression-source/report.json、W4/default-project-regression-extracted/report.json、W4/default-gui-source-fourth/report.json、W4/default-gui-extracted-first/report.json、W4/default-reading-source/report.json、W4/default-reading-extracted/report.json、W4/default-package-first/package.json、W4/default-final-integrity.json、W4/default-runtime-extracted.json。早期缺少test resize开关、错误等待启动初始化对话框、误传包内Node路径的失败原件保留。

下一批仍缺：真实账户singleton/默认home启动与旧profile ACL/旧锁显式恢复；物理IME、文件剪贴板/拖放、文件树/Office/TeX/终端剩余消费；托管pending/tool/native投影与owner冷退休、部分复制UNKNOWN/源链接/大项目、TxF可用性/完整namespace屏障、干净普通账户DLL/安装发行。本批未重跑前批多窗口/系统剪贴板，不以历史交互回执代签改动后的全部产品资格。W0 passed，W1/W2/W3/W4/W5 unsupported，managedExecution.ready=false，全局矩阵未放行。

## Windows 原生单实例与启动路由（2026-11-04，历史批次）

账户锁根仍从 OS 账户元数据 userInfo().homedir 解析，独立于 HOME/USERPROFILE/XDG、checkout 与实际 profile。Windows 在 profile 初始化前通过原生 HANDLE 创建/核验私有 singleton 子目录并固定原目录身份；Electron 持有原生单实例 mutex/IPC 和崩溃接替。争锁时临时设置 userData，随后恢复真实 profile；失败实例关闭自己的 pin，主实例在 will-quit 释放，强制退出由 OS 回收 HANDLE。已存在宽权限目录保留并拒绝，不自动改 ACL 或删除未知锁。单实例和独立配置 gate 是不同合同。

修复 Windows Chromium 在 second-instance argv 中插入开关后，按固定位置截断可能将源码 main.cjs 当作待打开文件的问题；只传发送方 app.isPackaged 仍不足。当前发送方经 Electron additionalData 传 schema1 原始 argv、cwd 和打包标记，接收方核验后按原发送数据解析；原始/Chromium 实际传递参数在显式合成测试日志中可对照。不含此元数据的旧版本仍使用旧参数回退，未宣称跨版本/跨形态兼容。最终测试逐步断言最近项目只能包含合成 fixture，应用入口不能被登记为项目。

固定入口 node tools/test-suites.mjs windows-desktop-singleton。源码 Node/Electron、最终中文空格解压固定 Node/Nozeli.exe Node 模式各 3/3，无失败/跳过，验证 profile 恢复、失败清理、主实例 pin 生命周期和发送端参数元数据。源码和解压实际 GUI 各 9 项，另加两个方向跨可执行文件/打包形态各 10 项：可见启动、独立 ACL 检查、不同 profile 二次启动在初始化前退出0、绝对中文空格文件/相对 cwd 文件准确打开、原未保存文本与磁盘原文保留、独立目录 rename 拒绝、三进程并发争锁、三个 helper 在 singleton/profile 前分流且缺 payload 退出1、正常退出接替、受控强制结束后的接替，以及 ACL 漂移拒绝并原样保留。

所有 GUI 使用显式合成账户 singleton，未取得/写入个人账户实际 singleton；纯测试核对默认解析器不等于真实默认 home/旧安装共存资格。崩溃场景只证明 singleton 和目录 HANDLE 回收，不代签草稿/托管业务冷恢复。GUI 驱动在源码测试环境运行，实际产品进程从解压包启动、PATH 仅 System32；生产包不携带 puppeteer-core。最终包再跑默认独立配置/更新门控 4 项和阅读/编辑/批注/草稿重开 5 项，共 4 应用进程正常退出0；所有最终 GUI renderer errors 为空，未配置 provider 或调用模型。

renderer 实际构建退出0，共享关闭回归26/26。native/Pi 输入核对原实际 W1/W2 构建回执复用，未修改 native 或宣称重编译。新本地资格候选 25293 文件、1240897645 字节，ZIP SHA-256 3548a35b1e372971176f72d3d8eabe551350f388320f07354d68fa0503e5a36d；CRC、全部解压摘要、772 个当前 src/dist 和随包测试一致性、native 输入、包内固定 Node/Electron/Pi/MinGit 解析均通过。单实例四宿主与双向 GUI 在 original-argv 包实际完成；最终 settled 包逐项比较所有文件，唯一变化为合成 reading 驱动等待保存回执，产品/依赖/native/单实例验证文件完全相同，回执 W4/singleton-package-equivalence.json。最终包另实际运行配置与阅读 GUI。候选是本地目录/ZIP，未制作安装器或替换日常安装。

证据 W4/singleton-qualification.json、W4/singleton-source-original-argv-final/report.json、W4/singleton-extracted-original-argv-final/report.json、W4/singleton-cross-source-original-argv/report.json、W4/singleton-cross-extracted-original-argv/report.json、W4/singleton-defaults-settled-extracted/report.json、W4/singleton-reading-settled-extracted/report.json、W4/singleton-package-settled/package.json、W4/singleton-settled-final-integrity.json、W4/singleton-settled-runtime-extracted.json。早期 Electron reporter 计数失败、包内缺开发 GUI 驱动，以及真实跨形态路由超时与诊断原件保留；开发依赖缺失在应用启动前停止。阅读回归还暴露驱动在磁盘发布、界面保存回执未落稳时立即输入下一段的时序错误，共享保存循环吸收了前两个新字符；改为等待真实 save-status=saved 后才开始独立未保存阶段，未修改产品保存逻辑。

早期“跨形态通过”缺少禁止登记入口路径的断言，不能作为最终资格。参数错误曾在源码 src/main 创建 .nozeli 项目元数据；已核对该批 operationId/projectId，将原5个文件和目录整体同卷移到 W4/singleton-unintended-source-project，未删除原始材料；移动前后根/文件身份和所有字节一致，回执 W4/singleton-unintended-source-project-move.json。源码内已无该意外元数据，当前最终回归明确拒绝再出现此类项目。

仍缺旧 profile ACL/旧 PID 锁显式恢复、真实默认账户/旧安装共存、物理 IME/文件剪贴板/拖放、文件树/Office/TeX/终端剩余消费、托管 pending/tool/native 投影/owner 冷退休、部分复制 UNKNOWN/源链接/大项目、TxF 可用性/namespace 屏障与干净普通账户 DLL/安装发行。W0 passed；W1/W2/W3/W4/W5 unsupported；managedExecution.ready=false，全局矩阵未放行。

## Windows Office 保存、导入与完整表格恢复（2026-11-04，当前）

固定 release/alpha.4 基线继续推进实际桌面消费。Word/XLSX 的共享 saveOffice 包装现在保留原生 committed、durability、commitUnknown、operationId、win32Code，顶层与 IPC details 均携带；真实发布后目录屏障失败不得伪装为“未写入”，保留编辑副本并提示核对原件。DOC 导入使用共享 replaceFile/createOnly，导入候选先留独立不可变恢复对象；仅明确未发布的目标碰撞可换后缀，发布不确定立即停止并保留实际路径/副本，不覆盖外部赢家。

实际 GUI 验收发现格式不支持时“保留恢复副本并关闭表格”会在共享 session.flush 中再次导出失败。当前 retainWorkspace 在 XLSX 导出失败时捕获完整 schema1 编辑快照（原 XLSX + Fortune 模型），宿主校验快照和原包，恢复设置提供 .recovery.json 导出。保留 dirty/冲突事实，不以清空脏标志绕过关闭；捕获/持久化期间 revision 或源身份变化仍拒绝关闭。完整快照永不记为可清理的 cleanOfficeBaseline，避免重开时被当作已写回原件丢弃。此快照用于保留/导出，尚未实现自动还原成可编辑工作簿或无损格式化 XLSX 写回。

源码 Node/Electron、中文空格解压固定 Node/Nozeli.exe Node 模式各16/16（11 原生 Host + 5 共享恢复），无失败/跳过。覆盖 Word/Sheet 原生 ACL、内容/公式保存与历史、独立进程外部赢家/删除/晚到 CAS、真实发布后屏障错误和冷重开；真实 OLE DOC 转换、目标碰撞与已发布不确定不重试。源码项目读写/Git/草稿/profile 回归 Node/Electron 各36/36。共享 workspace-native 广泛运行仍因默认 Windows persistence 门出现71项 fixture拒绝，原日志保留；不可宣称该套件通过。

源码/解压实际 GUI 各8项，4个真实应用进程正常退出0、renderer errors为空：真实 Word 键盘/中文字符/Ctrl+S、表格 B2与SUM依赖和邻格不变、格式不支持且原件不变、快照期间新编辑阻止关闭、重试后完整原包/两次格式/公式保留、真实 DOC 导入控件、正常进程重开与快照字节不变。驱动是外部 Puppeteer，产品从解压 Nozeli.exe/resources/app 实际运行，PATH仅System32；未配置provider或调用模型，自动Unicode输入不代签物理IME。

renderer实际构建退出0；native/Pi输入与原W1/W2构建回执核对后复用，未改native或宣称新编译。新本地资格ZIP 25300文件、1241000888字节，SHA-256 bdf252154a04a0545de13fbe302a578d12edeb0af596b627a6ea7bdec3881154；CRC、全清单解压摘要、当前src/dist和包内测试一致、native输入及固定Node/Electron/Pi/MinGit解析通过。仅本地目录/ZIP候选，不是安装发行资格。

证据：W4/office-qualification.json、W4/office-source-recovery-final/report.json、W4/office-extracted-final/report.json、W4/office-gui-source-race/report.json、W4/office-gui-extracted-final/report.json、W4/office-project-regression/report.json、W4/office-package-recovery/package.json、W4/office-final-integrity.json、W4/office-runtime-extracted.json。首次原生测试驱动错误、实际恢复关闭失败、广泛共享fixture失败均保留。

W0 passed；W1/W2/W3/W4/W5 unsupported；managedExecution.ready=false，能力矩阵未放行。旧profile/未知锁恢复、默认账户共存、公共文件树变更/文件剪贴板/拖放、物理IME、PPT/TeX/终端、托管冷恢复及干净账户发行仍缺；本批不外推其他系统或完整Office兼容性。


## alpha.5 Windows 基线与恢复接口迁移（2026-11-04）

用户最新要求基于GitHub alpha.5推进。当前 `platform/windows-native` HEAD为官方 `v0.1.0-alpha.5` 原始提交 `26b39d61d44edf30988efcb1bddcdba1ff7cffdf`；迁移时验证1221个blob和根tree。旧alpha.4源码、Windows已修改/新增文件、Git状态及索引已保存到 `D:/nozeli-test/20261104-alpha5-migration/pre-migration-source.zip`（SHA256 `5d72a4f677ff497f6cffa2e4f9a74ffbdf2359ab5c4aa66ba621cf62930f7d71`），未创建开发提交或推送。API/raw取回只是传输后备，Git对象哈希独立核验，未用旧源码假装新版本。

共享Controller/PiSession保留新版模型意图、activity、admission、错误归因和重启规则；Windows只提供I/O、原Job/stdio/宿主lease与owner custody。数据库同时保留新版转移MessagePort和completedAt期限，以及原生路径路由/lease/UNKNOWN栅栏。SessionIndex对象读取继续受原生HANDLE和累计/单对象字节预算约束。首次迁移测试已暴露且修正旧工具html参数、新版never-admitted重启测试预期、恢复列表/详情分离等变化；不得恢复alpha.4语义去迎合旧断言。

公共文件/目录创建已接 `recoveryPage`，SQL过滤完成/拒绝记录；未知、未来和损坏操作记录继续占据恢复准入。恢复UI只显示有界摘要，完整详情绑定SQLite revision/version，仍可导出完整不支持表格快照。新增34条大记录分页/失效测试；实际源码文件树GUI包括菜单、对话框、Unicode/空格创建、中文键盘输入、Ctrl+S、冲突/取消和整进程重开。

alpha.5新增的完整恢复导出通过窄I/O接口接Windows原生公开父HANDLE、私有ACL独占stage、无覆盖发布和目录屏障。共享代码仍拥有分块framing、源revision/version/digest、窗口generation检查；发布后错误保留committed/uncertain。真实SQLite记录、在线项目与离线恢复材料的多块字节、摘要和原件保留均纳入测试，junction、外部赢家、取消、最终发布前窗口关闭及真实屏障失败不通过路径删除或自动重放规避。

自动收尾维修碰到独立目录后会记录终态；修复后显式 `retryClosure` 可绕过旧维修终态重新检查原始收尾。原决定、reviewVersion/候选绑定、requestKey幂等、原目录/日志身份和UNKNOWN栅栏仍必须通过，自动路径不增加重试额度。新增真实原生Workspace/Controller回归和实际Pi Worker流程：只执行原三次本地loopback请求，保留未发草稿/原日志、竞争者与完整home归档，接受人工版本后Git合入，原宿主确认后warm重开零重放。

新版renderer/Pi实际重建完成。alpha.5每项实际执行、失败/取消/超时、最终本地ZIP及解压逐宿主结果，以迁移证据目录和后续qualification.json为准；此段不替代未取得的包内实测。第一轮源码变动中的包在最终一致性核对准确失败，保留供追溯，禁止将其当作候选。最终包须重新生成并核验CRC、全部文件摘要、当前src/dist/tests和native原构建输入。原生C++本批未变，复用前按最近真实构建回执重新哈希，不宣称重新编译。

默认unit仍有真实Windows失败（/proc/getuid定向fixture、终端mock/定时断言），原始632项中619通过、12失败、1跳过，默认integration未继续。尝试广泛maintenance-runtime还出现未经Windows注入的PERSISTENCE_UNSUPPORTED；该套件没有通过，未修改共享测试平台去伪装。新的显式重试回归已独立使用真实Windows storage/workspace适配。

W0 passed；W1–W5仍unsupported，managedExecutionReady=false，能力矩阵未放行。下一批仍是剩余公共文件树变更、旧profile/未知锁恢复、物理IME/文件剪贴板拖放、PPT/TeX/终端、生产托管冷恢复，以及干净普通账户/DLL和安装发行验收。alpha.4结果保持历史，不外推alpha.5、Linux/macOS或全Windows资格。


### 同批真实GUI发现的表格初始化竞争

最新候选重跑出现两种真实失败，原日志和截图均保留：一次文件树DOM刷新导致Puppeteer旧元素脱离；另一次表格已渲染但初始SUM无值并被当作不支持的格式变更。后者已定位为产品时序缺陷：Fortune在passive初始化前暴露ref，原两次setTimeout可提前计算/冻结未materialize的基线。新增 `sheet-readiness.mjs` 等待预期sheet集合和活动sheet矩阵实际就绪，然后计算公式、跨渲染帧提交后冻结基线；未就绪时保持inert，不产生用户changed。两个确定性顺序测试覆盖早到ref/延迟活动sheet/计算提交、快照隔离和关闭取消。实际源码Office8项重跑通过。需使用包含此修复的新候选（desktop-package-readiness）；较早候选的Office成功不代签最终包。

同批压力运行出现过原生pipe忙（Win32 231）导致observer返回SUPERVISOR_CONNECTION_UNVERIFIED；该轮按真实失败保留，不能变成absence/owner release。下一次独立回归核对可用性；未改安全判定、未重试未知写入。多批同时运行造成耗时显著，超时和首次失败不从证据中删除。


### alpha.5 本地验证最终记录

最终证据 `D:/nozeli-test/20261104-alpha5-migration/qualification.json`：源码及解压native297、process190、project36、tree16、Office16，每组每宿主通过，无跳过；共享新接口/表格初始化源码和最终解压双宿主各102。最终包源码/解压实际GUI树6项、Office8项，共8次正常进程退出0。最终包28194文件，展开内容1275055732字节，ZIP SHA256 `0bf2fba9d4362960c32e5e63335bab0e4350ddc955c8e057a6ca6b71abd6279d`；完整性与随包运行时核验见final-integrity.json/runtime-extracted.json。包在desktop-package-readiness，含初始化修复。native/process/project/tree/Office Host仍指向上一包的真实报告，component-equivalence.json比较全部28194条清单，确认对应源码/测试/native/runtime完全相同；最新shared与GUI已在最终包重跑。Node进程初次pipe忙失败保留，独立完整190项重核通过；不能抹掉压力可用性风险。

计划已更新v16，旧总结果仅增加currentAlpha5Validation指向本次报告，alpha.4既有证据仍历史。完整Windows门槛未放行，任务继续。


## alpha.5 Windows 公共普通文件传输（2026-11-04，历史批次）

原生新增 anchored-public-file.inc，通过有类型的租约固定源文件与两个父目录，拒绝数据写入/删除共享，绑定 File ID/大小/字节摘要/安全描述符，目标使用 HANDLE 相对 no-replace rename。复制每块至多1MiB，源租约直到元数据、草稿及完成回执落定后才释放；close不删除公共名字。源链接数复核不能省略：NTFS实测可在租约期间新增硬链接，此时拒绝发布并保留外部链接。ADS、已有多链接、跨卷/跨项目、目录、仅大小写改名、超过512MiB等当前拒绝。

共享FileTreeOps继续负责路径、标签/历史/来源计划及恢复。原始/目标元数据和草稿先入intent，固定分配事实与摘要入prepared，发布和屏障后再以expectedCollections提交元数据、以expectedRevision迁移草稿。任何已发布/UNKNOWN失败不执行旧路径rollback/rm，保留现场和needs-attention；原文档recoveryHeld保持，防止旧路径继续编辑保存。未保存草稿阻止copy，不把磁盘旧字节伪装成当前缓冲。当前只保留/导出恢复计划，没有自动重放/通用冷协调。

源码/最终包文件树双宿主各32/32，共享各102/102，项目各36/36；源码原生双宿主各297/297，最终包Office双宿主各16/16。源/包真实GUI各8项、共4个实际应用正常退出0，renderer errors为空；测试专用CalculateNativeWinOcclusion/backgrounding开关逐进程记录，无参数的遮挡/超时失败原件保留。复制/剪切GUI证据是主进程IPC，菜单改名保留打开文档并整进程重开；不宣称文件剪贴板/真实拖放/物理IME通过。

新native SHA256 2d11981eecc3f3f897892416d8c236f32be7a6acd48fc2c4c6d8477167e1a8e7，14项构建输入；renderer实际构建退出0，169项当前修改/新增JS语法通过。ZIP 28195文件、1275101319字节，SHA256 dad00d8e3ab60fee1f2ea607cb194256def400543df877d67ce7b34dc750b0e4。完整CRC/清单、src/dist/tests、Pi manifest与固定运行时已核对；进程组件未改且对照原构建回执复用，190组本批未重跑。第一轮28/2、第二轮31/1、崩溃fixture启动参数失败、GUI无occlusion开关的失败与打包期间输入改变的失败均保留。

权威回执：D:/nozeli-test/20261104-alpha5-file-transfer/qualification.json、native-build.json、hosts-source-final/report.json、hosts-extracted/report.json、native-source/report.json、shared-source/report.json、shared-extracted/report.json、project-source/report.json、project-extracted/report.json、office-extracted/report.json、gui-source-occlusion/report.json、gui-extracted/report.json、desktop-package-qualified/package.json、final-integrity.json、runtime-extracted.json、syntax.json。

W0 passed；W1–W5 unsupported，managedExecutionReady=false，能力矩阵未放行。后续首项：目录递归转移/回收站→跨项目/文件剪贴板/拖放→未知锁/旧profile与默认账户→其他工作面/托管冷恢复→干净账户安装发行。未提交、推送、公开发布或替换日常安装。


## alpha.5 Windows 公共目录递归传输（2026-11-04，最新批次）

继续固定官方 v0.1.0-alpha.5（26b39d61d44edf30988efcb1bddcdba1ff7cffdf）。同项目/同 NTFS 卷内目录重命名、剪切、递归复制现已接入共享 FileTreeOps 的元数据集合 CAS、草稿 revision CAS 和恢复 admission。新 native 公共树根保留原根 HANDLE 和实际继承 ACL；独立只读 SourceDirectory view 共享该根，不能借用 Parent 写方法。复制先独占分配 .nozeli-tree-<operationId>.pending，分配前意图、分配后 File ID 和完整源清单均进入 prepared；文件分块写入并 flush，再核对暂存目录的全部成员与字节，整体 HANDLE 相对无覆盖发布。复制采用新 ID/目标继承 ACL，不克隆任意扩展元数据。

复用已有 retained-tree 捕获/校验状态机，固定全部目录/文件身份、ACL 与 SHA256。Windows 改目录名必须释放子项 HANDLE，因此保留精确根句柄，发布后相对同一根重新捕获并比较完整清单；新成员、字节/权限变化、链接与元数据漂移保留实际发布结果及 needs-attention，不按旧路径 rollback/rm。部分复制或分配回执不确定保留隐藏暂存根及完整计划，冷启动阻止新变更，不自动删除或重放。这个合同是有界观察/复核，未宣称目录 namespace 冻结或断电原子事务。目录移动的子文件是只读租约，回执明确 files=not-flushed-by-read-lease；目录和两个父屏障已实际执行，完整 namespace 持久性未资格化。

边界：目录最多 1,024 个子孙、合计 512 MiB、最多 128 级路径；恢复计划上限 8 MiB。原生清单拒绝任意层 .git/.nozeli（含大小写/规范化别名）、reparse/junction、硬链接与文件/目录 ADS，不截断树后伪装成功。现有普通文件上限仍 512 MiB；跨项目、回收站、文件剪贴板/拖放与仅大小写改名保持拒绝。

源码/最终解压双宿主：文件树各48/48（原32加目录16）、原生各297/297、共享各102/102、项目各36/36；最终解压 Office 各16/16，无失败/跳过。目录16含嵌套/空目录/Unicode/多块复制、标签/历史/来源新旧身份、草稿/未保存复制保护、嵌套 metadata/ADS/硬链接/junction、晚到外部目标、释放窗口成员/字节漂移、实际发布后屏障失败、部分暂存和元数据赢家，以及复制/移动发布前后真实子进程退出与冷不重放。真实 GUI 源码/最终解压各10项、共4个应用进程正常退出0、renderer errors为空：实际文件夹菜单改名带动打开子文档，主进程 IPC 递归复制/剪切，整进程重开读回正文。仍使用逐进程记录的测试专用 Chromium 遮挡开关，不代签默认无遮挡、物理 IME 或文件剪贴板/拖放。

新 native 已实际编译，15项输入，SHA256 `b4e5434140affcb3960908f31e09e0bbbf64e7c5cdd8e4d85ed9ff793a266f3e`；renderer 实际构建退出0，171项修改/新增JS语法通过。最新本地 ZIP 28197文件、1275138366字节展开内容，SHA256 `058ba2c4ce791dccd73fcd6d1705eb52d98f8b6b93fb4e3410067373cb240c83`；路径 `D:\nozeli-test\20261104-alpha5-directory-transfer\desktop-package-qualified\Nozeli-windows-alpha5-qualification.zip`。完整 ZIP CRC、全量解压清单、当前src/dist/tests、native构建输入、Pi manifest 与包内 Node/Electron/MinGit/Pi 解析均核验。仅本地资格产物，不是安装器或完整发行。进程/Pi190组本批未重跑，原二进制/输入复核后复用，既有 pipe-busy失败仍保留；默认套件此前619通过/12失败/1跳过仍不是全绿。未在Linux/macOS实机验收共享改动。

首次 GUI 在刷新后点击已脱离 DOM 的旧节点失败，原 gui-source/report.json 保留；改为测试 locator 重试后源码 gui-source-stable 和解压 GUI 各10项通过，产品未因该驱动问题改变。

权威证据：`D:/nozeli-test/20261104-alpha5-directory-transfer/qualification.json`；同根 native-build.json、hosts-source/report.json、hosts-extracted/report.json、native-source/report.json、native-extracted/report.json、shared-source/report.json、shared-extracted/report.json、project-source/report.json、project-extracted/report.json、office-extracted/report.json、gui-source-stable/report.json、gui-extracted/report.json、desktop-package-qualified/package.json、final-integrity.json、runtime-extracted.json、syntax.json。

W0 passed；W1–W5 unsupported，managedExecutionReady=false，全局能力矩阵未放行。后续：系统回收站身份/恢复协议与跨项目/文件剪贴板/拖放、旧profile/未知锁和默认账户、物理IME/PPT/TeX/终端、托管生产冷恢复、部分暂存显式协调及干净普通账户安装发行。完整目标保持进行中；未创建开发提交、推送、公开发布或替换日常安装。


## alpha.5 Windows 跨项目文件和目录传输（2026-11-04，最新批次）

继续固定官方 v0.1.0-alpha.5，HEAD 26b39d61d44edf30988efcb1bddcdba1ff7cffdf，远端标签对象 b7c32b1afc2d00c5c036af4283c616ff91e55fa2 已核实。两个已选择项目之间的普通文件/递归目录复制与同卷原生剪切已接入共享 FileTreeOps 和 WorkspaceNative。目标取得新的逻辑文档身份；源项目批注、修改历史、来源和草稿留在原项目，不迁移会话。剪切保留物理 File ID 和源 ACL；复制使用新 File ID/目标继承 ACL。Linux 既有 copy+trash 分支保留，未在 Linux/macOS 实机验收。主进程仍要求 shell 的活动目标项目，不放宽全局授权。

两个项目按固定次序加锁，再取得共享元数据锁。两侧 intent 和本机 catalog 的 tree_cross_transfers 总账先持久化，再分配/发布。各次 prepared 同步两侧回执及总账；发布前重查源已保存、目标恢复资料无冲突。发布后先记共同事实，两侧 acknowledged 后才提交总账 complete，最后两侧 complete。任一发布/结果不确定、部分暂存、CAS 赢家或丢回调保留现场；共同总账加两侧 admission 阻止继续变更，冷开不自动重放。总账在 SQLite 内验证原始 JSON 类型/schema/UUID归属，再生成有界投影，不能从 UI 默认 kind 或数字化布尔值推导归属。未知/损坏归属阻止所有项目；每页50项/64KiB，超过1,024项无关 pending 则拒绝本次操作。仍缺显式协调/清理 UI。

源码/最终解压 Node、Electron 两宿主：新增跨项目各17/17、原文件树各48/48、共享各102/102、项目各36/36，均无失败/跳过。17项覆盖文件/目录复制剪切、独立逻辑身份/ACL/字节、空目录/Unicode、多块复制、目标文件/元数据赢家、源未保存草稿、根替换/ACL变化、部分复制/丢回调、真实发布屏障失败、真实子进程在复制/移动前后及完成时退出、冷双项目 admission、2MiB未知记录有界投影、分页、原始类型/缺失kind、两侧/总账CAS竞争，以及共享源工作面 hold。真实 GUI 源码/最终解压各7项、共4个进程正常退出0且renderer errors为空：实际键盘/Ctrl+S、跨项目主IPC复制/剪切、活源文档保留、目录传输、目标赢家/活动项目权限、全进程重开。逐进程记录测试遮挡开关与forceVisible，不代签物理IME/无测试开关或真实文件剪贴板/拖放。

renderer实际构建退出0，174项修改/新增JS语法通过。本批未改native，复用公共目录批实际构建，15项输入及全部原生二进制摘要均复核；未宣称新编译。native297、Office16、process/Pi190组本批未重跑，历史证据与既有pipe-busy失败保留。此前alpha.5默认619通过/12失败/1跳过仍不是全绿。最终本地资格ZIP 28200文件、1275185434字节展开内容，SHA256 `df33fa1c7d213c2c319f189754aa8cf1c00849722884ad2da64bf25a2d1b8d54`，路径 `D:\nozeli-test\20261104-alpha5-cross-project\desktop-package-final\Nozeli-windows-alpha5-qualification.zip`。全量CRC/解压摘要、当前src/dist/tests、Pi manifest、包内Node/Electron/MinGit/Pi解析均核对；子测试PATH仅System32，不回落checkout运行时。仅本地资格闭包，不是安装器/发行版。

失败原件保留：cross-first.tap 14通过/2失败（一处测试误认为读取创建批注身份，一处产品漏导入path，均已修正）；中间包的源码一致性检查捕获了总账审查时的源码变动，原desktop-package-qualified记录保留，最终重新打包至desktop-package-final。最终17项双宿主通过数来自新报告，不使用中间结果补数。

权威证据 `D:/nozeli-test/20261104-alpha5-cross-project/qualification.json`；同根 cross-source-final、cross-extracted、hosts-source、hosts-extracted、shared-source-final、shared-extracted、project-source、project-extracted、gui-source-final、gui-extracted 的report.json，以及 desktop-package-final/package.json、final-integrity.json、runtime-extracted.json、syntax.json。

边界仍为本机固定NTFS、同卷、文件512MiB/目录合计512MiB和1,024子孙、128级路径、8MiB恢复计划。拒绝ADS/多硬链接/reparse及独立.git/.nozeli元数据，部分暂存保留。目录移动子文件只读租约不声明file flush；namespace/断电事务未资格化。W0 passed；W1–W5 unsupported，managedExecutionReady=false，能力矩阵未放行。下一步：系统回收站身份/恢复协议、真实文件剪贴板/拖放、旧profile/未知锁与默认账户、物理IME/PPT/TeX/终端、托管生产冷恢复、显式暂存协调及普通账户安装/更新/签名发行。完整目标继续，未提交、推送、发布或替换日常安装。


## alpha.5 Windows 原生文件剪贴板与外部复制（2026-11-05，最新批次）

基线固定官方 v0.1.0-alpha.5，HEAD 26b39d61d44edf30988efcb1bddcdba1ff7cffdf。接通真实 Ctrl+C/Ctrl+X/Ctrl+V、标准 Win32 CF_HDROP 文件列表导出、外部本地文件/递归目录粘贴和外部 Chromium File 拖入。独立 Win32 进程读写标准格式验证互通，修正 Electron 注册同名自定义格式不能替代标准 CF_HDROP 的问题。原生接口在 OpenClipboard 内核对 GetClipboardSequenceNumber 后才清空并发布；所有缓冲区预先分配，发布后失败保留 committed/uncertain。仅 CLIPBOARD_BUSY 异步每20ms重试，最多1秒；不重试代次变化或已提交错误。

外部输入一律明确复制，Preferred DropEffect MOVE 也保留源。readonly 原生源句柄/身份/内容清单接入既有 FileTreeOps 独占暂存、无覆盖发布与回执协议，不注册或修改外部源、不修复源ACL、不隐式保存项目源。目标为新逻辑身份与继承ACL；源批注、历史和草稿保留。文件512MiB/目录合计512MiB、1,024子孙、128级路径、8MiB恢复计划；拒绝ADS、多硬链接、reparse和嵌套.git/.nozeli。部分暂存/结果不确定保留现场并阻止继续变更，冷开不自动重放。完成回执丢确认时保留CAS赢家并增加独立needs-attention记录，避免原赢家complete消除冷开阻塞。仍缺显式协调/清理UI和完整namespace/断电保证。

外部拖入由preload的webUtils.getPathForFile处理实际File对象，主进程核验活动项目并签发绑定窗口/项目/TTL的一次性票据；renderer仅获得票据和名称。既有内部拖动继续共享文件树复制/移动状态机。已测Chromium实际鼠标内部拖动，以及CDP native File drag经过preload/主进程/复制流程；尚未验收资源管理器中物理鼠标拖入，不将CDP证据外推为Explorer实测。

实际重建Windows文件原生模块退出0，16项构建输入与二进制均复核，SHA256 `aed0f453abcb178f7fca6fd8e158d94b9e09b0e876594300c645785a779c1cad`。源码和最终解压Node/Electron各：剪贴板17、native297、文件树48、跨项目17、共享102、项目36，均无失败/跳过；renderer相关7项通过。真实GUI源码/解压剪贴板各10项、跨项目活源文档/Ctrl+S各7项，共8次正常退出0，无renderer errors。GUI使用显式遮挡测试开关与forceVisible；不代签物理IME/默认无遮挡/全工作面验收。Office16、process/Pi190本批未重跑，进程二进制及原构建输入重新核对。此前alpha.5默认619通过/12失败/1跳过仍保留，不能报告全套绿灯。

最终本地资格ZIP 28205文件、1275254538字节展开内容，SHA256 `1ca305e6577cb4a11bde1be4f8ea8903c015df26a0e65238151c957dbbed10b6`，路径 `D:\nozeli-test\20261104-alpha5-file-clipboard\desktop-package-stable\Nozeli-windows-alpha5-qualification.zip`。完整CRC、解压摘要、当前src/dist/tests、Pi manifest与包内Node/Electron/MinGit/Pi解析通过；测试子进程PATH仅System32。两次中间包因测试期间源码变更被一致性检查拒绝，失败原件保留，最终重新打包至desktop-package-stable。此包为本地资格产物，不是安装器或完整发行。

剪贴板测试事故如实保留：早期gui-third曾覆盖测试前的图片，恢复失败且原内存快照随进程退出丢失，无法恢复；已告知用户，不能宣称整批恢复成功。后续改为保存序列化CF_DIB/CF_DIBV5并让Windows再生CF_BITMAP；独立合成2×2图片验证精确DIB与再生位图尺寸，最终源码/解压GUI运行开始时的剪贴板状态得到恢复或保留外部赢家。该修复不能恢复早期丢失图片。其余保留失败包括旧代次读取、前操作尚忙/脱离DOM的测试时序、实际CLIPBOARD_BUSY，以及独立hold加入后的测试选错回执。首次gui-extracted在启动中Target closed、尚未执行复制，原因未确定；所查时间段无Windows应用崩溃事件。原剪贴板已恢复，同一未改包在gui-extracted-retry通过全部10项；首次关闭仍列启动稳定性待查项，不能用重试消除该记录。具体记录见qualification.json。

针对首次启动关闭，另用同一解压包和合成profile连续5次启动、激活项目及正常退出，5次均退出0且无renderer errors；未读写剪贴板。startup-probe/report.json与独立harness保留。未复现不代表已确定首次原因，该项仍待观察。

权威证据 `D:/nozeli-test/20261104-alpha5-file-clipboard/qualification.json`；同根native-build.json、image-restoration.json、syntax.json、final-integrity.json、runtime-extracted.json和各source/extracted目录report.json。W0 passed；W1–W5 unsupported，managedExecutionReady=false，未放宽能力矩阵。下一优先项：系统回收站身份/恢复协议、物理Explorer拖入、旧profile/未知锁与默认账号共存、IME/PPT/TeX/终端、托管生产冷恢复、显式暂存协调及干净普通账户安装/更新/签名发行。完整目标继续，未提交、推送、发布或替换日常安装。


## alpha.5 Windows 外部复制显式恢复核对（2026-11-05，最新批次）

固定官方 v0.1.0-alpha.5，HEAD 26b39d61d44edf30988efcb1bddcdba1ff7cffdf。本机恢复设置为已识别的外部文件/目录复制记录新增“核对复制结果…”和显式确认。只读原生父/文件/目录句柄核对原 File ID、完整内容及目录暂存清单；已发布副本保留，未发布复制明确放弃且保留全部暂存和外部目标赢家。此确认只更新回执，不执行复制、删除、清理、重命名、源写入、ACL修复或元数据迁移。

确认绑定主窗口/代次/项目根、完整回执revision与摘要和现场摘要，5分钟有效、一次使用；确认时重新捕获核验。只允许在线原项目，项目锁后取得共享meta锁，接入track/withProjectOperation以参与关闭排空。主记录与关联不确定记录各自expectedRevision CAS；原complete或已核对refused主记录原样保留。中间写入失败继续保留剩余hold，冷重开后重新预览/确认，不重放文件操作。新增第16项回归修复了“放弃复制主记录已确认、关联hold写入失败后不能重试”的缺口。独立批注/来源和草稿赢家保留。记录每项8MiB、关联合计16MiB、pending扫描256项、每页50项/64KiB；文件/目录512MiB、目录1,024子孙，超过上限拒绝且保留现场。

本轮最终源码/解压Node、Electron各恢复16/16、剪贴板源/票据回归17/17、共享102/102；renderer相关7项通过。真实恢复GUI各6项，跨项目/活源Ctrl+S GUI各7项，共8次正常应用退出0，无renderer errors。实际恢复界面验证真实子进程退出留下的原生文件stage、保留字节/源、确认后另一次新操作、已发布文件和完整目录/空目录、文档窗口权限拒绝、预览后目标替换拒绝及整进程冷重开零重放。GUI仍使用逐进程记录的Chromium遮挡测试开关与forceVisible，不代签物理IME/Explorer拖入/默认无遮挡。本轮不读取或写入系统剪贴板；17项回归使用注入的剪贴板接口，真实标准Win32互通沿用上一批证据。

renderer实际构建退出0，190项修改/新增JS语法通过。本轮未改native，复用上一批真实构建，16项输入和文件原生二进制摘要重新匹配；SHA256 aed0f453abcb178f7fca6fd8e158d94b9e09b0e876594300c645785a779c1cad，进程二进制/原构建输入也复核。native297、文件树48、跨项目单测17、项目36、Office16、process/Pi190本批未重跑，不冒称新通过；native297源码/解压历史结果见20261104-alpha5-file-clipboard。此前默认619通过/12失败/1跳过仍保留；共享改动未在Linux/macOS实机验收。

新本地资格ZIP 28212文件、1275311989字节展开内容，SHA256 `a29e1b6ebe0eb07258719d6808d3a09d9185d52d991d08e7cee85eef3c72731f`，路径 `D:\nozeli-test\20261105-alpha5-tree-recovery\desktop-package-stable\Nozeli-windows-alpha5-qualification.zip`。完整CRC、全量解压摘要、当前src/dist/tests、Pi manifest和包内固定Node/Electron/MinGit/Pi解析通过，子进程PATH仅System32。它是本地资格产物，不是安装器/完整发行。中间desktop-package-final因修复期间源码变动被一致性检查拒绝，最终desktop-package-stable重新生成。早期hosts-source-first 5通过/8失败来自父句柄权限冲突及夹具误认普通关闭后文件stage仍存，已改只读父和真实进程退出；两次早期GUI分别为按钮locator与拒绝文案断言问题，失败原件保留。

权威证据 `D:/nozeli-test/20261105-alpha5-tree-recovery/qualification.json`，同根hosts-source-stable、recovery-extracted、clipboard-source、clipboard-extracted、shared-source、shared-extracted、gui-source-stable、gui-extracted、gui-cross-source、gui-cross-extracted的report.json，以及desktop-package-stable/package.json、final-integrity.json、runtime-extracted.json、syntax.json。上一批剪贴板图片丢失事故及一次未解释的启动Target closed仍保留历史记录；本轮通过不能恢复旧图片或证明首次启动原因已解决。

W0 passed；W1–W5 unsupported，managedExecutionReady=false，未放宽能力矩阵。仅外部复制记录获得显式核对，内部/跨项目/剪切/创建记录结算、系统回收站和暂存显式清理仍unsupported。后续继续这些事务的恢复合同、旧profile/未知锁与默认账号共存、托管生产冷恢复、终端/TeX/PPT、物理桌面和干净账户安装/升级/回滚。namespace/断电和TxF普适性未资格化。完整目标保持进行中，未创建开发提交、推送、发布或替换日常安装。


## alpha.5 Windows 跨项目复制/剪切显式恢复（2026-11-05，最新批次）

固定官方 v0.1.0-alpha.5，HEAD 26b39d61d44edf30988efcb1bddcdba1ff7cffdf。设置的本机恢复新增“核对跨项目操作…”，识别两个已登记项目之间的普通文件/有界递归目录复制和同卷原生剪切。复用外部复制的只读原生观察句柄，核对原 File ID、完整字节摘要、复制目标stageManifest或移动原manifest及空目录。剪切核对原对象位于原名还是目标名；原名被另一个对象占用时保留该外部赢家，不冒充原对象。已发布结果保留，未发布操作可明确放弃且保留全部暂存。确认只更新回执，不复制、移动、删除、修ACL或重新投影批注/历史/来源/草稿。

两个项目按稳定次序取得项目锁，再取共享meta锁；两侧withProjectOperation和host.track纳入关闭排空。严格核对原project/instance/root绑定、同一operation/action/source/destination、两侧角色、元数据策略、各原生效果及共同tree_cross_transfers总账。每条完整记录8MiB、三处合计24MiB；真实文件/目录512MiB、目录1,024子孙；未知schema、缺失/损坏对侧记录、根绑定漂移、冲突效果/完整清单均保留hold，不猜测归属或重建对侧资料。总账完整读取复用共享recoveryRecord的collection参数，仍有界且使用真实revision和数据库version。

预览令牌绑定主窗口/代次、两侧实际根与元数据身份、三条回执revision/摘要、现场摘要，5分钟有效且一次使用。确认重新捕获完整现场。两侧先CAS写入仍可见的needs-attention核对确认；观察到两处精确确认后，才CAS完成共同总账；最后分别CAS结束本机记录。任何一处失去确认或竞争，都留下共同或本机待处理记录，冷重开可重新预览/确认；不自动重放。原complete/refused回执与已完成总账保持原revision和完整值。原同宿主操作留下的WorkspaceNative恢复保护不由回执确认自动解除或改绑；仍需显式关闭/重新打开或使用原缺失文档恢复，完整活工作面衔接待补。GUI异常现场由独立合成宿主生成，不冒称覆盖同宿主失败后活源工作面的解除。这个顺序防止“本机记录先隐藏、总账写失败”导致恢复入口消失；总账确认后各项目按自有最后回执分别释放。

最终源码/解压Node、Electron各新增恢复24/24、原外部复制恢复16/16、跨项目传输回归17/17、共享102/102，无失败/跳过；renderer相关7项通过。新增24项覆盖文件/目录复制和剪切发布、实际子进程在发布前/后和首个确认后退出、暂存和空目录、目标相同字节但新File ID、原名外部赢家、独立来源/草稿、三处CAS竞争、部分确认及最终本机CAS失败后的冷重试、原完成总账/回执保留、owner/TTL/代次/单次确认、无关恢复hold和损坏/缺失对侧拒绝。最终源码和解压24组驱动每宿主前后校验8项源码/测试输入摘要，禁止测试期间输入漂移。

真实跨项目恢复GUI源码/解压各7项、原外部恢复GUI各6项，共8次正常退出0、renderer errors为空。实际UI覆盖保留真实进程退出stage、两个项目新操作、文件/目录复制剪切、外部源名赢家、文档窗口权限拒绝、共同总账失败后待处理仍可见并重新确认、目标替换拒绝和整进程冷重开零重放。GUI使用已记录Chromium遮挡测试开关与forceVisible，不代签物理IME/Explorer拖入/默认无遮挡；本轮不读写系统剪贴板。

renderer实际构建退出0，197项修改/新增JS语法通过。native未改未重建，复用20261104-alpha5-file-clipboard实际构建，16项输入和文件二进制摘要重新核对：aed0f453abcb178f7fca6fd8e158d94b9e09b0e876594300c645785a779c1cad；进程二进制和原构建输入也复核。native297、文件树48、项目36、Office16、process/Pi190本批未重跑。此前默认619通过/12失败/1跳过仍保留，未在Linux/macOS实机验收共享改动。

最新本地资格ZIP 28219文件、1275375261字节展开内容，SHA256 `1cc0cd403a731880a968bcb0a1dd13936949945026fc5d781b0ffc99e5fd2805`，路径 `D:\nozeli-test\20261105-alpha5-cross-recovery\desktop-package-stable\Nozeli-windows-alpha5-qualification.zip`。全量CRC/解压摘要、当前src/dist/tests、Pi manifest和包内固定Node/Electron/MinGit/Pi解析通过，子进程PATH仅System32。本地资格产物不是安装器或完整发行。首次20项Node18通过/2失败，是普通未发布剪切已自动refused而夹具仍找pending，改真实子进程退出后验证；中间hosts-source-final在审查追加effect.kind一致性期间运行，最终hosts-source-stable使用冻结输入摘要重新验证，原件保留。

权威证据 `D:/nozeli-test/20261105-alpha5-cross-recovery/qualification.json`；同根hosts-source-stable、recovery-extracted、external-source、external-extracted、cross-source、cross-extracted、shared-source、shared-extracted、gui-source-first、gui-extracted、gui-external-source、gui-external-extracted的report.json，以及desktop-package-stable/package.json、final-integrity.json、runtime-extracted.json、syntax.json。旧剪贴板图片丢失及一次未解释启动关闭继续保留历史记录，不以本轮通过消除。

W0 passed，W1–W5 unsupported，managedExecutionReady=false，未放宽能力矩阵。尚缺同宿主失败后活源工作面的保护解除/重绑/脏输入保留、同项目复制/移动的批注/历史/草稿协调及创建恢复、系统回收站合同/暂存显式清理、旧profile/未知锁、托管生产冷恢复、终端/TeX/PPT/物理桌面、namespace/断电与TxF普适性、干净普通账户安装/升级/回滚/发行。缺失或无法证明的跨项目对侧仍阻塞，不能用本轮已识别组的资格代签全部UNKNOWN。完整目标保持进行中，未提交、推送、发布或替换日常安装。


## alpha.5 Windows 同宿主活源文档恢复（2026-11-05，最新批次）

固定官方v0.1.0-alpha.5，HEAD 26b39d61d44edf30988efcb1bddcdba1ff7cffdf。本批接通WorkspaceNative真实源工作面与跨项目回执确认：文件操作的保护按operationId独立保存，不清除预览/网页等通用recoveryHeld，也不解除其他操作的保护。源工作面先实际flush/document-sync，再在原生只读句柄上捕获每个原文件的卷/File ID、完整SHA256与长度，绑定两侧项目/实例/根/元数据及原工作面代次。最多1,024个文档、合计512MiB，核对失败在文件操作前拒绝。

恢复预览/确认与原操作使用同序的两个工作区队列，再取得两侧项目锁及共享meta锁，纳入两侧项目操作排空和host.track。确认持有源或移动目标文档的原生观察句柄，直到两侧回执/共同总账终态CAS完成。源身份/内容仍匹配的复制或放弃移动释放自己的保护，保留原缓冲对象、租约、选区和未发送内容；一般恢复保护及其他操作保护仍有效。源换成相同字节的新File ID、工作面重载/代次变化或绑定无法匹配时继续只读；用户恢复原对象后可明确“核验原文件并继续编辑”。最后写入实际成功但响应丢失时，此入口重新核验原终态回执/总账，不修改或重放文件效果。

已发布剪切保留原项目阅读面、文档身份、批注和未发送内容；不静默改绑到新项目。单独“打开目标文件”入口重新核验原目标File ID/内容和项目绑定后，通过主窗口打开独立目标工作面。原位置存在外部新对象时保留该对象，原窗口不冒充它。普通成功剪切也使用相同保护与目标入口。renderer的独立恢复提示放在被inert保护的文档区之外；受保护工作面flush使用原workspace恢复保存路径，不写回项目。

最终源码/解压Node、Electron各31项通过：15项新增真实Windows文件/回执/WorkspaceNative衔接，11项browser及5项update回归；两侧回执恢复24与跨项目传输17各在源码/解压双宿主通过，均无失败/跳过。31项驱动每宿主核对19项冻结输入摘要。覆盖已发布文件/目录剪切、复制、未发布目录stage与剪切、外部同字节新File ID、原对象恢复、脏缓冲/原租约、独立预览和另一操作保护、部分最后CAS失败、最后响应丢失、代次、权限/猜测operation及晚到目标替换拒绝、串行顺序和普通成功剪切。

真实同宿主GUI源码/解压各6项，使用独立合成故障入口加载实际production main/IPC/WorkspaceNative，仅在真实native效果检查点制造故障，不添加产品故障IPC，不伪造owner/stop事实。源码使用开发Electron；解压故障GUI使用只从候选包复制的独立Electron运行目录，exe摘要与包一致，直接加载包内原fixture/main/src/dist，未改原包入口。原包入口另行通过跨项目GUI7和两侧回执GUI7；源码原入口跨项目GUI7也通过。五组GUI共10次正常退出0，renderer errors为空。源码GUI实际键入/保存、未发送备注、恢复后Ctrl+S、独立目标按钮、源替换拒绝与恢复按钮、完整冷重开均验证；未读写系统剪贴板。测试遮挡开关/forceVisible沿用并记录，不代签物理IME或Explorer拖入。

首次新增Node14通过/1失败：普通未发布文件复制不保留测试预期的目录stage，改为实际目录复制保留场景；中间live-source因新增update测试造成输入漂移被驱动拒绝，最终live-source-stable和live-extracted以19项冻结摘要重新验证。首次GUI源复制恢复已通过，剪切目标按钮因位于inert文档区而无法点击；修复独立恢复banner后最终6项通过，失败原件保留。通用工作区扩展检查workspace-node-first为15通过/74失败：73项fixture仍使用未配置Windows native的默认ProjectStorage而在PERSISTENCE_UNSUPPORTED处拒绝；1项browser固定POSIX路径断言已改path.join并在双宿主重跑全部11项通过。通用fixture仍待适配，没有放宽生产能力门。

renderer实际构建退出0，209项改动/新增JS语法检查通过。native未改未重建，复用原真实构建；16项filesystem输入及二进制、process原输入/二进制重新核对。native297、external16、shared102、project36、Office16、process/Pi190本批未重跑；历史默认619通过/12失败/1跳过亦未重跑，不能当作全套绿灯。Linux/macOS实机未资格化。

最新本地资格ZIP 28226文件、1275431832字节展开内容，SHA256 `4816becf3452ff0acc7857e544797ff29688de8943a29dce39654ac34ea27548`，路径 `D:\nozeli-test\20261105-alpha5-live-recovery\desktop-package-stable\Nozeli-windows-alpha5-qualification.zip`。全量CRC、解压摘要、当前src/dist/tests、随包固定Node/Electron/MinGit/Pi解析通过。权威证据 `D:/nozeli-test/20261105-alpha5-live-recovery/qualification.json`，同根各report、desktop-package-stable/package.json、final-integrity.json、runtime-extracted.json、syntax.json和fault-harness-runtime.json。没有创建开发提交、推送、发布、安装或替换日常版本。旧图片丢失和一次未解释启动Target closed仍保留历史记录。

W0 passed，W1–W5 unsupported，managedExecutionReady=false，能力矩阵未放宽。仍需整进程重启后原源阅读面的持久保护恢复（尤其原名被同字节外部对象占用时）、同项目元数据/草稿及创建恢复、系统回收站/明确暂存清理、通用workspace Windows fixture、旧profile/未知锁、托管生产冷恢复、终端/TeX/PPT、物理桌面、namespace/断电/TxF普适性及干净普通账户安装升级回滚发行。内存中的operation保护不冒充持久owner；本轮整进程重开只证明目标/暂存/外部赢家和零重放，不代签原源阅读面保护的持久重建。完整Windows目标保持进行中。


## alpha.5 Windows 原文本源文档整进程冷恢复（2026-11-05，最新批次）

固定官方v0.1.0-alpha.5，HEAD 26b39d61d44edf30988efcb1bddcdba1ff7cffdf。新增CrossTreeSurfaceJournal，使用既有私有recovery对象存储保存原文件响应（正文与原二进制字节分离）、原buffer、原workspace快照和view状态；摘要引用、卷/128位File ID/完整SHA256/长度及两侧项目绑定写入host生成描述。描述成为原两侧回执共同不可变内容；两侧intent及共同总账建立之后、原生文件效果之前写入各原view的tree-surface保护记录。部分写入或响应丢失在活窗口先保护，操作拒绝，效果不提前开始。

原生窗口冷bootstrap及文档IPC先加载原view保护记录，再解析文件；校验原项目/根/元数据绑定、操作号、原源回执、描述摘要和不可变恢复对象。正文、编辑缓冲、原备注与后续由host绑定的workspace恢复记录得以保留。相同字节的外部新对象不作为原源；缺失源路径仍可打开原保留正文。file.read、阅读副本snapshot和导出共同走原保护内容，PPT保护读取避免重新解析当前源路径。保护本身不推断任何进程owner或冷停稳事实。

原两侧回执核对后，受保护源窗口也在同项目重命名/剪切/删除前拒绝，不能把外部占用原名的对象移走。精确原源通过核验的复制/放弃移动先CAS写入该操作保护released，再释放活窗口；丢失释放响应可明确重核。未来/未知并发status保留，不能标准化后覆盖。已移动源经原终态记录重核后仍保持原阅读面，只允许明确另开精确目标；未知/更换目标拒绝。完整拒绝且没有prepared效果的原intent，只能在原回执和精确原文件验证后解除自身保护。保留其他操作及网页/预览hold。最多1,024文档、合计512MiB观察、每恢复对象256MiB、原view历史记录4,096；预算/对象校验失败保留资料并拒绝，未截断正文。

最终源码/解压Node、Electron各47项全部通过，无失败/跳过；16项新增真实Windows检查覆盖独立进程重开、同字节源替换、原名缺失、正文/后续备注、成功/部分/丢响应释放、回执变更、未知并发status、目标替换、无buffer的导出与阅读副本，以及在真实原生prepared发布前检查点终止源宿主后由新进程重建保护和原输入。与此前15项活源、11项browser及5项update一起在每个宿主核对26项冻结输入。两侧回执24和跨项目传输17各在源码/解压双宿主通过。

真实GUI源码/解压各8项，包含原生编辑/Ctrl+S、实际原生故障、两侧设置确认、明确目标/原源按钮，以及完整关闭/重启后原正文和通过真实键盘选区/可见备注菜单创建的未发送备注恢复。源码使用开发Electron；解压故障检查使用从合格包单独复制、exe摘要一致的Electron运行目录，直接加载原包fixture/main/src/dist。解压原程序入口另行通过跨项目及两侧回执GUI各7；五组共10次正常退出0，无renderer errors。未添加生产故障IPC。沿用并记录遮挡测试开关，不代签物理输入。当前实际冷阅读面资格为文本；Office/PDF/图片字节捕获已实现，但冷GUI/投影/导出尚未完整资格化。

首次cold-node-first为7通过/1失败：夹具把未保存正文放在操作前恢复记录，被生产保存检查正确拒绝，改为已保存正文加未发送备注；随后定向检查暴露pending核验为moved后仍尝试原路径继续编辑，现返回保留移动状态。中间cold-source-stable虽然Node44通过，但因追加并发status/导出检查造成输入变化而被驱动拒绝；最终两侧各47以26项冻结摘要完成。中间GUI冷开原正文保护通过，但未锚定隐藏输入中的文字不是有效备注，后续又选用了不可点击页脚按钮；最终gui-source-frozen-v6使用真实键盘选区及可见备注菜单，原正文/备注/保护均在整进程重启后通过。原包入口GUI还发现源窗口集合为空时描述绑定报错，文件效果前拒绝；修复空集合分支，新增真实无源窗口递归目录复制/剪切回归。初始gui-cross-extracted失败及旧ZIP保留。最终源码GUI还因后台保存使恢复分页游标失效而停止，保留RECOVERY_CURSOR_INVALID原件并以同源码重试。分页读夹具现在最多12次重新读取失效页；不自动确认或重放任何文件效果。中间包的源码/测试变化由一致性检查拒绝，原始输出保留，后续审查还统一了较新保留正文与冷buffer，断言显示/导出/阅读副本都使用同一版本；定向通过后重新执行最终双宿主检查并生成最终候选，仅采用desktop-package-final-v6。首轮解压冷GUI已通过7项正文/备注/保护/目标检查，随后最后页面操作超时，第一次退出0、第二次未确认，失败原件保留；首次同包重试在早期Target closed停止，原因未明，原包入口两组7项GUI另外通过；采用第二次同包独立重试结果，保留前两次失败。

renderer实际构建退出0，215项变更/新增JS语法检查通过。原native未改未重建；filesystem16项构建输入及二进制、process原输入/二进制重新核对。native297、external16、shared102、project36、Office16、process/Pi190及默认套件本批未重跑。默认619通过/12失败/1跳过和通用workspace扩展15通过/74失败的历史记录保留（73项存储fixture门控；browser路径已修并重跑），不宣称全套绿灯。

最新本地资格ZIP 28232文件、1275486753字节展开内容，SHA256 `14910b2df3b1d49684442a46303dc2903ba5dca8cc2742be72ff3120fbbd96a7`，路径 `D:\nozeli-test\20261105-alpha5-cold-source\desktop-package-final-v6\Nozeli-windows-alpha5-qualification.zip`。权威证据 `D:/nozeli-test/20261105-alpha5-cold-source/qualification.json` 及同根各report、desktop-package-final-v6/package.json、final-integrity.json、runtime-extracted.json、syntax.json、fault-harness-runtime-v6.json。全CRC/解压摘要、当前src/dist/tests、固定Node/Electron/MinGit/Pi解析通过。没有创建开发提交、推送、发布、安装或替换日常版本；未读写系统剪贴板。旧图片丢失和一次未解释启动关闭的历史记录不删除。

W0 passed、W1–W5 unsupported、managedExecutionReady=false，能力矩阵不放宽。下一批先补Office/PDF/图片冷阅读面和更大负载资格，然后继续同项目元数据/草稿及创建恢复、系统回收站/明确暂存清理、Windows通用workspace夹具、旧profile/未知锁、托管生产pending/工具/投影/owner冷恢复、终端/TeX/PPT/物理桌面及干净普通账户安装升级回滚发行。完整Windows目标保持进行中。


## alpha.5 Windows Office/PDF/图片原阅读面冷恢复（2026-11-05，最新批次）

最新证据 `D:/nozeli-test/20261105-alpha5-cold-office/qualification.json`：基于官方v0.1.0-alpha.5，Word/Sheet/PPT/PDF/图片的跨项目操作原阅读面冷恢复已补齐本地资格。原保护对象先核验再读取；Office保留候选包重新验证后显示和导出，候选摘要与原源摘要分开；完整表格快照转换为Fortune初始化格式，恢复格式/单元格/跨表公式，完整格式尚不支持写回XLSX时拒绝不完整导出。PPT恢复标题及幻灯片保留；受保护owner供给阅读副本，不误读外部同名路径。

源码/解压Node和Electron各75项通过，冻结36项相关输入；真实五格式冷GUI源码/解压各11检查、各10次正常退出0，无renderer errors。解压原生产入口Office GUI另8检查/2次正常退出0。PDF/图片冷前后画布逐字节相同；合成晚到的引擎编辑经正常recovery保留，不冒充物理Office/IME资格。

最新本地资格ZIP 28235文件、1275518902字节展开内容，SHA256 `ae0be3eeaaed200189bd70452316e91e36e0da85128db7cc5fe92d376de9b34a`，路径 `D:\nozeli-test\20261105-alpha5-cold-office\desktop-package-final-v3\Nozeli-windows-alpha5-qualification.zip`。完整CRC/全部解压摘要、当前src/dist/tests及运行时解析通过。native输入/二进制复核，未重建。默认619通过/12失败/1跳过和通用workspace失败仍保留。W0 passed、W1–W5 unsupported、managedExecutionReady=false。未安装/发布/提交/推送，未操作系统剪贴板。

实际修复：CrossTreeSurfaceJournal异步重验Office候选包/完整sheetSnapshot；file.read返回原源身份摘要及单独候选摘要。document.export.read对保留编辑计算真实候选摘要和长度，origin明确retained-edit/retained-source；完整sheetSnapshot拒绝假装完整XLSX导出。workspace.document.snapshot和受保护owner的阅读副本共用保留内容。saveRecovery即时更新活hold候选，不将受保护Office标记clean baseline。renderer从候选bytes或完整sheet模型初始化并保留dirty；后台同步遇树保护使用既有host资料，不弹TRANSFER_HELD。Fortune初次mount始终从celldata重建，现显式转换每个runtime单元格，保留配置/公式/格式；恢复模型不支持完整格式导出时保留完整JSON。PPT草稿恢复后不再以文件名覆盖标题。

新增10项实际Windows独立进程检查，覆盖五格式原名被外部占用、Office候选验证/导出/摘要/阅读副本、完整sheetSnapshot及损坏候选拒绝；与原Office11、office recovery5、sheet readiness2、live15、cold16、browser11、update5共75项，在源码和解压两种Node/Electron宿主各通过。真实GUI逐格式使用生产main/IPC、真实native cut、两侧恢复确认和整进程退出重开：Word保留正文、表格粗体/斜体/B2=35/SUM=55、PPT标题与幻灯片，PDF/图片画布精确一致；原名外部赢家和移动原件不改变。native故障fixture与晚到引擎输入明确为合成，不宣称物理输入或完整Office能力。源码/解压各11检查，20次正常退出0；解压原生产入口原Office8检查，2次正常退出0。

中间失败全部保留：首次测试连续切换单内容布局使旧page脱离，改为逐格式完整冷循环；v2发现Fortune丢失runtime二维矩阵，修复celldata转换；v3发现PPT标题被文件名覆盖，修复；v4夹具structuredClone不能复制Vue proxy，改用引擎自身JSON模型。source-v5通过后截图发现后台TRANSFER_HELD提示并修复，最终source-frozen重跑。中间Node75通过但源码变化被driver拒绝；初driver错误预期80改为实际75，采用source-final75。首候选包因构建期间源码变化拒绝，v2被测试driver校正取代，仅v3权威。既有Target closed未解释历史、默认/通用workspace失败及旧clipboard图片丢失不删除。

renderer实际构建退出0，217项变更新增JS语法通过，冻结1514项src/dist/tests摘要；native未改未重建，原输入和二进制复核。native297/external16/shared102/project36/processPi190未重跑，Office本批实际11，不冒用历史16数。完整CRC/28千余解压文件摘要与固定运行时验证通过；仅本地资格包，不是安装包或发行。剩余同项目metadata/draft/create、回收站/清理、通用Windowsfixture、旧profile/未知锁、生产托管pending/tools/projection/owner冷恢复、终端/TeX/PPT更广功能、物理桌面和普通账户干净安装/升级/回滚/签名发行。完整Windows目标继续进行中。


## alpha.5 Windows 项目内元数据/草稿/新建显式恢复（2026-11-05，最新批次）

最新证据 `D:/nozeli-test/20261105-alpha5-same-tree/qualification.json`：固定官方v0.1.0-alpha.5，当前HEAD 26b39d61d44edf30988efcb1bddcdba1ff7cffdf。新增项目内复制、改名、剪切及新建对象的显式恢复。原生身份和完整字节/目录清单核对后，补齐原计划中的标签、历史、来源和草稿，保留无关记录、外部赢家和暂存数据。目标草稿、源草稿清除和完成回执在同一SQLite事务中比较全部版本并提交，文件效果零重放。

源码及解压Node、Electron各93项通过：项目内恢复18、原子存储3、文件16、目录16、外部恢复16、跨项目恢复24。冻结24项驱动输入、1527项src/dist/tests，229项变更新增JS语法通过。真实生产入口GUI源码/解压各6项，两侧各2次正常退出0、无renderer errors，覆盖恢复设置、保留草稿/批注、Ctrl+S、新建文件/目录、同名目标替换拒绝、整进程重开。故障由独立合成宿主生成，不证明同宿主原编辑窗口完整活/冷衔接。

本地资格ZIP 28243文件、1275575383展开字节，SHA256 `3f17fc4279ac9e30e72b30b58728c8ce7efeb400d4e6289cabd1cc6ea896a0fd`，路径 `D:\nozeli-test\20261105-alpha5-same-tree\desktop-package-final-v2\Nozeli-windows-alpha5-qualification.zip`。完整CRC/解压摘要、当前源码/测试和内置运行时核对通过。native未改未重建，复核原构建输入和二进制。W0 passed，W1–W5 unsupported，managedExecutionReady=false。默认619通过/12失败/1跳过、通用workspace15通过/74失败的历史保留；本批扩展storage另33通过/8失败，不能宣称全套通过。未安装/发布/提交/推送，未操作系统剪贴板。

新增sameProject标记与项目/实例/根/元数据身份绑定；旧无标记记录仍unsupported。预览令牌绑定owner/代次、回执revision/hash、原生现场和metadata/draft计划，5分钟有效且单次使用。项目锁后取meta锁，withProjectOperation及host.track纳入排空。确认重验真实File ID、完整SHA256或含空目录的manifest。已发布保留，未发布明确放弃且保留全部暂存；新建对象已有用户内容时拒绝结算并保留内容。不会重新复制、移动、删除、清理文件或修ACL。

元数据按原before/after差量合并，只接受受影响行仍等于before或after，无关新增行保留，受影响行并发赢家拒绝。项目数据库先CAS，恢复数据库再putMany单事务检查全部草稿源/目标及终态回执；任一revision冲突整批无写入。两数据库不是跨库原子事务，前阶段成功后失败仍留pending供明确重试。可识别旧的目标单写/源已清除部分状态；complete已落盘但响应丢失时，后续stale CAS不能覆盖成功回执。存储层另验证后项冲突全回滚、真实worker重开后幂等回执/请求指纹冲突、重复ID/无效版本/缺值无部分写入。

新增18项真实Windows恢复覆盖文件/目录复制移动、新建文件/空目录、元数据响应丢失后独立进程重开、旧部分草稿迁移、整批响应丢失、同字节草稿revision赢家、最终事务边界目标赢家、预览后metadata/draft/file赢家、回执赢家及未发布stage保留。原file-transfer故障夹具更新到原子批次边界；完整事务成功但响应丢失时核对保留complete回执并允许后续独立操作。

失败和中间产物保留：first/second为恢复版本purpose及stage生命周期夹具问题；third13/fourth17/atomic18在冻结前通过。hosts-source-first因源码漂移停止；hosts-source-final/首解压组合的旧600秒预算不足，在核实合成进程身份后停止，不能作为通过。初driver计数92随后按真实93修正；最终两个独立测试文件并发、每宿主1200秒预算，只采用desktop-package-final-v2。扩展storage33/8分别为打开SQLite不能unlink的Windows旧假设1项、旧controlled worker消息通道1项、通用初始化/retry fixture被Windows存储门控6项；保留TAP，不放宽生产门控。旧Target closed、默认/workspace失败及历史clipboard图片丢失继续保留。

原编辑窗口在项目内操作失败后的完整活/冷恢复、成功改名后的buffer/lease迁移仍未资格化；本GUI是独立宿主产生故障后用生产应用核对并打开目标，不代表覆盖原活窗口。下一批先处理该边界，再继续回收站/显式stage清理、通用Windowsfixture/默认套件、旧profile/未知锁、生产managed pending/tools/projection/owner冷恢复、终端/TeX/PPT、物理IME/Explorer/多屏、普通账户干净安装/依赖/升级回滚/签名发行。完整目标保持进行中。


## alpha.5 Windows 项目内原编辑窗口活/冷衔接（2026-11-05，v27）

最新证据 `D:/nozeli-test/20261105-alpha5-same-surface/qualification.json`：固定官方v0.1.0-alpha.5，HEAD 26b39d61d44edf30988efcb1bddcdba1ff7cffdf。项目内原编辑窗口活/冷衔接已完成本地定向验证：正常改名迁移buffer、lease、layout和恢复记录，原窗口Ctrl+S只保存新路径；发布/未发布故障保留原文、批注与未发送备注，核对后显式打开独立目标，旧路径同名外部赢家不变。旧版本备注保留原摘要，不自动改绑到后来保存的新正文。

源码及解压Node、Electron各149项通过：原窗口15、项目内恢复18、原子存储3、文件16、目录16、外部恢复16、跨项目恢复24、活源15、冷文本16、冷Office10。冻结35项驱动输入、1531项src/dist/tests，233项变更新增JS语法通过。原窗口故障GUI及正式生产入口GUI，源码/解压各6项、每组2次退出0、无renderer errors；前者通过独立合成fault entry加载真实main/IPC，后者直接启动生产入口。

本地资格ZIP 28247文件、1275626206展开字节，SHA256 `a0cc6a9fcd223099a49a44207e6f89b92ec09cb29ed2cd129b681cbf0877b629`，路径 `D:\nozeli-test\20261105-alpha5-same-surface\desktop-package-final\Nozeli-windows-alpha5-qualification.zip`。ZIP CRC、全部解压文件摘要、源码/测试/native原构建输入及内置Git/Node/Pi清单核对通过。native未改未重建。W0 passed，W1–W5 unsupported，managedExecutionReady=false。历史默认619/12/1、通用workspace15/74及storage33/8结果保留，本批未重跑，不能宣称全套通过。未安装/发布/提交/推送，未操作系统剪贴板。

原生效果前持久保存每个源文档的不可变capsule及host-only描述符，包含原文件、缓冲、恢复输入、布局和批注。回执绑定原项目实例/根/metadata身份、精确File ID及内容摘要。目录后代、阅读镜像复用共享保护；同项目终态核对取workspace串行、项目锁及meta锁，不复制业务状态机。

正常移动先迁移恢复记录并持久化新布局，再释放原保护与迁移buffer/lease；丢失布局响应时，独立冷宿主仅接受终态回执和同一原生目标快照，避免读取旧路径赢家。改名后更新renderer documentKey。最终UI reconcile失败不会重建旧路径hold。失败移动继续保留原阅读面只读，按原capsule显示批注，确认不会改绑旧选区或未发送备注。

中间失败TAP/GUI报告全部保留。夹具缺少layout/projectId、annotation kind与读后关闭时序已修复；GUI发现annotation.list返回envelope的生产判断错误已修复并用真实批注验证。GUI最初native pointer metrics等待超时，使用稳定窗口后renderer激活，仅为测试驱动修正。曾错误预期旧版本备注随正文保存自动改绑，现改为核对保留原materialDigest和新路径。远端本轮复核发生连接重置/超时，沿用既有官方alpha.5基线证据，不宣称最新网络核验成功。

仍缺：多窗口部分journal release的完整故障矩阵、Office正常改名全部变体、回收站与显式stage清理、通用Windows fixture/default/storage失败、旧profile/未知锁、生产managed pending/tools/projection/owner冷恢复、终端/TeX/PPT、物理IME/Explorer/多屏、命名空间/断电/TxF可用性/大目录，以及普通账户干净安装/依赖/升级回滚/签名发行。完整Windows目标继续进行。


## alpha.5 Windows 多窗口改名部分确认与冷恢复（2026-11-05，v28）

最新证据 `D:/nozeli-test/20261105-alpha5-multi-surface/qualification.json`：固定官方v0.1.0-alpha.5，HEAD 26b39d61d44edf30988efcb1bddcdba1ff7cffdf。多窗口改名部分确认故障已完成本地定向验证：两个编辑窗口与阅读镜像保留原文和未发送备注；首个/第二个journal写入前故障及响应丢失、晚到旧布局、整进程冷恢复均保留原阅读身份。旧路径同名外部赢家不变。冷开可以恢复到已核验的新路径，也可保留只读原阅读面并显式核对目标。

源码及解压Node、Electron各157项通过：多窗口8、原窗口15、项目内恢复18、原子存储3、文件16、目录16、外部恢复16、跨项目恢复24、活源15、冷文本16、冷Office10。冻结38项驱动输入、1534项src/dist/tests，236项变更新增JS语法通过。多窗口故障GUI源码/解压各5项，原窗口故障GUI及正式生产入口GUI各6项；每组2次退出0、无renderer errors。故障GUI仅通过合成entry加载真实main/IPC；正式入口GUI直接启动生产入口。

本地资格ZIP 28250文件、1275656224展开字节，SHA256 `250520c23d89e5aef93791bb6c558da2c75930a27bdab27acbde54f77ad1222c`，路径 `D:\nozeli-test\20261105-alpha5-multi-surface\desktop-package-final\Nozeli-windows-alpha5-qualification.zip`。ZIP CRC、全部解压文件摘要、源码/测试/native原构建输入及内置Git/Node/Pi清单核对通过。native与renderer本批未改；沿用先前实际构建并核对输出。W0 passed，W1–W5 unsupported，managedExecutionReady=false。历史默认619/12/1、通用workspace15/74及storage33/8结果保留，本批未重跑。官方基线沿用已固定证据，本批未重新网络核验。未安装/发布/提交/推送，未操作系统剪贴板。

故障复现：目录原生改名与新布局落盘成功后，首个文档保护记录释放成功而第二个失败；所有原窗口保留旧身份，晚到的旧布局可能覆盖新布局。若首个记录已标为released，重启会忽略原capsule并读到旧路径外部文件。第二轮TAP保留该失败证据。

改为可验证的relocated状态，保留原身份capsule及明确relocatedTo。冷开旧身份继续使用原capsule；非原身份只有合法同项目、非copy、complete回执与精确目标公式的标记才可越过旧保护。尚未完成relocated写入的新目标需重新核验精确File ID、摘要与长度。再次正常改名允许当前身份继续，历史原身份仍保留。此批不追溯修复历史已released的记录，也不自动重放操作。

8项原生定向场景覆盖3个文档面、两处部分写入、两处响应丢失、旧/新身份独立冷宿主、同字节不同File ID目标拒绝及连续改名。真实Electron GUI验证两个带锚点未发送备注的编辑窗口与阅读镜像，实际原生rename、主进程部分release故障、正常关闭和重启。冷窗口需逐个激活；首次显式核对可同时更新其他阅读面的状态，测试允许这一真实并发结果。所有中间失败证据保留。

完整Windows目标仍缺：Office正常改名全部变体、回收站与显式stage清理、通用Windows fixture/default/storage失败、旧profile/未知锁、生产managed pending/tools/projection/owner冷恢复、终端/TeX/PPT、物理IME/Explorer/多屏、命名空间/断电/TxF可用性/大目录，以及普通账户干净安装/依赖/升级回滚/签名发行。


2026-11-06 补充边界复核：外部合成验证脚本在源码/解压Node、Electron四组各3项通过、退出0。目标字段不符、非终态回执拒绝冷开；正常原生保存后新身份可继续读取，旧身份仍保留原capsule且不读取旧路径外部赢家。证据 `D:/nozeli-test/20261105-alpha5-multi-surface/marker-supplemental.json`；脚本及摘要记录在内。这3项是外部补充验证，不计入永久157项套件；源码/包内容未改。


## alpha.5 Windows Office正常改名及PPT模型迁移（2026-11-07，v29）

最新证据 `D:/nozeli-test/20261107-alpha5-office-rename/qualification.json`：固定官方v0.1.0-alpha.5，HEAD 26b39d61d44edf30988efcb1bddcdba1ff7cffdf。本批接通Office正常改名：Word、表格、PPT保持原编辑窗口身份，改名前后继续编辑，Ctrl+S只保存新路径；整进程重启保留内容与Word原版本未发送备注，旧路径同名外部赢家不变。PPT源文件不随独立模型编辑改写；全部索引版本和独立模型随项目内移动原子迁移，目标/并发模型冲突明确拒绝，已发布故障可显式完成元数据且零重放文件效果。

新增PPT迁移6项已在锁定源码Node22定向通过，全部扩展套件包含既有157项共163项。源码Node24扩展162通过/1失败/0跳过：既有successful-copy冷恢复在Git初始化报not a git repository，单独重跑1通过，但原因未确定，原失败保留。源码Electron扩展163通过/0失败；解压宿主结果为node:163通过/0失败/0跳过; electron:163通过/0失败/0跳过。开发机Node24.13.0与随包锁定Node22.23.4为不同宿主，不宣称源码目录Node22整组重跑。源码/解压GUI各Office7项、多窗口5项、原窗口6项，共12次正常退出0，无renderer errors。Office使用正式生产入口；故障GUI使用合成entry加载真实main/IPC。选区为DOM/编辑器接口合成，明确使用forceVisible和遮挡测试开关，不代签物理IME或默认窗口。renderer实际重建退出0；241项变更新增JS语法检查通过，冻结1538项src/dist/tests摘要。

当前本地资格ZIP 28254文件、1275685908展开字节，SHA256 `cbc60a7b04a290d20f5c1d4efd24a2b66745f3b8fb2ddf1f6ce0eb5c830245cf`，路径 `D:\nozeli-test\20261107-alpha5-office-rename\desktop-package-final-v2\Nozeli-windows-alpha5-qualification.zip`。完整CRC、全部解压摘要、当前src/dist/tests和包内Git/Node/Pi解析通过；native未改未重建，复核原实际构建输入和二进制。官方alpha.5标签本批首次网络复核成功，后续重复查询超时记录保留。W0 passed，W1–W5 unsupported，managedExecutionReady=false。默认619/12/1、通用workspace15/74及storage33/8历史失败本批未重跑，不能宣称全套绿灯。未安装、发布、提交、推送或操作系统剪贴板。

复用共享文件树回执、恢复扫描与SQLite批次CAS；PPT版本索引和每个模型绑定原摘要，正常迁移与故障显式恢复均核对源/目标revision。copy保留源草稿且不建立目标模型身份。旧回执没有pptDrafts字段时继续原行为，不追溯修复历史丢失模型。目录迁移覆盖全部索引版本，任一后项冲突整批不提交。

中间失败保留：首五次Office GUI停在改名前的选区/驱动环节；修正可见性和实际渲染DOM选区后sixth及正式重建后的final通过。额外旧多窗口GUI在键盘选区超时，现等待编辑器正文并用接口选区，retry通过；这是合成输入证据。首轮163宿主测试因测试输入变更而停止，不计通过；核对合成进程树后终止，残留查询已退出。首候选包desktop-package-final因后续测试夹具修改被取代，仅desktop-package-final-v2为当前一致闭包。

完整目标剩余：Office更广改名/损坏旧恢复记录/跨项目PPT模型迁移、系统回收站与显式stage清理、通用Windows fixture/default/storage失败、旧profile/未知锁、生产managed pending/tools/projection/owner冷恢复、终端/TeX/PPT更广工作面、物理IME/Explorer/多屏、namespace/断电/TxF与大目录，以及普通账户干净安装、依赖、升级回滚、签名发行。


## alpha.5 Windows 默认单元兼容与集成失败基线（2026-11-07，v30）

最新证据 `D:/nozeli-test/20261107-alpha5-default-portability/qualification.json`：固定官方v0.1.0-alpha.5，HEAD 26b39d61d44edf30988efcb1bddcdba1ff7cffdf。本批修复默认单元套件的Windows兼容性：Linux合成恢复算法显式提供UID、使用POSIX路径；模拟终端在spawn前注入基线；屏幕80ms通知用可控时钟验证并修复排队写入在dispose后残留定时器的问题。共享Windows恢复与终端unsupported拒绝保留。

定向修复前29通过/12失败/1跳过，修复后72通过/0失败/1跳过；后续原本因顶层getuid异常未注册的Linux合成用例现在执行。默认unit共71文件，源码锁定Node22、源码Electron、解压Node22、解压Electron四组各665通过/0失败/1跳过；跳过为Linux实机进程树用例，合成Linux算法不代表Windows原生所有权证明。完整integration已实际执行：527通过/1149失败/50跳过。624项报PERSISTENCE_UNSUPPORTED、377项报Cannot open pinned child；只归类失败入口，根因仍待逐项确认。全套default不能标绿，旧619/12/1历史保留。

本地资格ZIP 43412文件、1398864172展开字节，SHA256 `cdd943e9742239353efe213110a26cb06ce97498fe182a857f495cb75c07bf06`，路径 `D:\nozeli-test\20261107-alpha5-default-portability\desktop-package-final-v2\Nozeli-windows-alpha5-qualification.zip`。CRC/全部解压摘要、当前src/dist/tests和随包Node/Git/Pi解析通过。冻结1538项，246项变更新增JS语法通过。renderer/native未改未重建，沿用已实际构建输出并核对native输入与二进制。本批未重新查询远端，使用上一批已核验官方alpha.5标签。W0 passed，W1–W5 unsupported，managedExecutionReady=false；未安装、发布、提交、推送或调用系统剪贴板。

首解压包两宿主各637通过/5失败/1跳过：四个Pi测试按仓库相对路径导入失败，一个测试缺少esbuild。第二包两宿主各660通过/1失败/1跳过：桥接测试间接导入的Pi SDK依赖不完整。此为资格测试闭包缺失，不能称全套通过；原包、TAP及JSON保留。仅最终desktop-package-final-v2额外携带仓库布局Pi源码、SDK依赖和esbuild工具，全部71文件重跑通过；这些依赖只用于本地资格验证，不宣称最终用户发行包。没有删除、跳过失败用例或放宽生产平台门控。

下一批优先复现默认integration中的私有目录打开失败、生产持久化选择与SQLite关闭占用；区分真实产品缺口、宿主不匹配和测试夹具，再继续pending/tools/projection/owner冷恢复与Work/Git接受闭环。Office v29源码Node24 Git初始化单项失败、旧workspace/storage失败继续保留，不能用本批unit通过抹去。


## alpha.5 Windows 首次私有profile准备（2026-11-09，v31）

最新证据 `D:/nozeli-test/20261107-alpha5-profile-bootstrap/qualification.json`：官方v0.1.0-alpha.5，HEAD 26b39d61d44edf30988efcb1bddcdba1ff7cffdf。本批接通桌面首次使用时缺少profile的原生私有目录准备：仅初始锚点缺失、尚无分配回执时从已存在的直接父目录创建完整私有链；设置记录和桌面ProjectStorage共享此逻辑。项目根不走备用锚点，不递归创建任意祖先，不修已有ACL，不跟随junction，不覆盖同名赢家，分配后/屏障失败保留现场。

新增11项真实Windows回归覆盖首次catalog与设置、真实冷进程草稿、并发创建、缺失祖先、同名文件、junction、目录竞争、刷新失败和closed scope。源码Node22/Electron与解压Node22/Electron单元四组各665通过/0失败/1跳过；相邻profile/配置/项目存储四组各29通过/0失败/0跳过。Windows profile命名入口已纳入新增测试，源码两宿主各17通过。源码/解压正式生产入口GUI各6项、各两次退出0、无renderer errors；为可见Electron+CDP/invoke合成驱动，不代签物理IME/Explorer。完整integration567通过/1109失败/50跳过，比v30多40通过；624项PERSISTENCE_UNSUPPORTED、110项PROCESS_OWNERSHIP_UNSUPPORTED、108项EBUSY、41项OPEN_PERSISTENCE_UNCONFIRMED等仍待修复，失败码仅为入口分类，全套default未通过。

当前本地资格ZIP 43414文件、1398873016展开字节，SHA256 `5bf985c4750c25a5cfb2669ad1dc557e616a12b6aaaf0c898f945b1d5f36a408`，路径 `D:\nozeli-test\20261107-alpha5-profile-bootstrap\desktop-package-final\Nozeli-windows-alpha5-qualification.zip`。ZIP CRC/全部解压摘要、当前src/dist/tests、随包Git/Node/Pi解析通过；冻结1540项、248项变更新增JS语法通过。renderer/native本批未改未重建，复核原实际构建输入与二进制；无构建入口或依赖变化。沿用已固定官方标签，本批未查询远端。W0 passed，W1–W5 unsupported，managedExecutionReady=false。未安装、发布、提交、推送或调用系统剪贴板。

初始复现：全新合成profile未经正式配置初始化而直接传入DesktopHost，catalog打开返回WIN32_IO_ERROR/win32Code2；相同目录预先通过原生私有创建后登记成功。旧资格包独立重复复现，当前实现两种情况都成功。现有正式应用启动会提前创建profile，这次补齐独立桌面消费者首次使用合同。

首次11项测试有2个驱动问题：冷读进程使用--input-type参数被worker继承、ACL拒绝码预期写错。改用独立.mjs冷进程并按实际FS_SECURITY_CHANGED核对，原失败TAP保留。目录屏障测试特别注入同样的Win32 missing错误，核对它不会触发备用锚点；分配后失败要求committed与uncertain保留。

完整integration实际耗时约1112秒，原生目录准备后部分长用例不再立即失败，继续执行真实文件/worker操作。剩余失败不能全部归为fixture：生产持久化、进程所有权和外部打开队列仍有明确能力缺口；EBUSY需核验宿主/SQLite实际关闭和项目pin释放，不通过宽松删除绕开。下一批优先这些消费点及pending/tools/projection/owner冷恢复，再推进回收站、普通账户安装与完整W1–W5。


## alpha.5 Windows 宿主夹具生命周期（2026-11-09，v32）

证据 `D:/nozeli-test/20261109-alpha5-host-lifetime/qualification.json`。本批重新查询 GitHub 官方 `v0.1.0-alpha.5`：annotated tag `b7c32b1afc2d00c5c036af4283c616ff91e55fa2`，剥离后仍为当前 HEAD `26b39d61d44edf30988efcb1bddcdba1ff7cffdf`。保留既有 Windows 工作树。仅修改测试夹具与命名测试入口，生产源码/renderer/native未修改或重建。

实际复现 annotation-package 首项的 hookFailed/EBUSY：旧夹具直接删除项目，原宿主和同进程“重启”宿主仍持有原生目录与数据库归属。为8个文件显式管理全部宿主；关闭先等待已准入任务，再确认所有数据库worker退出，失败保留合成目录，不放宽产品保护、不吞关闭失败。新增2项真实Windows检查：只关第一个宿主仍拒绝独立进程移动原目录；全部关闭后原项目/profile才允许改名，原文保持；关闭等待最后一次准入写入，冷开草稿/精确回执保持，旧revision写入拒绝。新增测试纳入integration。

原8文件源码Node22：74通过/7失败/1跳过。源码Electron与解压Electron加入2项后各75通过/8失败/1跳过；解压Node22为76通过/7失败/1跳过。源码Node22新增与相邻存储生命周期7项通过。所有本批定向组无EBUSY、无取消。对照v31全部82个同名测试：原68项EBUSY中62项通过，其余6项露出原被清理错误遮住的能力门控；未删除/跳过原失败用例。剩余普通Node7项为6个RECOVERY_OWNER_UNVERIFIED（特殊/复制项目恢复）与1个NOZELI_CAPABILITY_UNAVAILABLE（回收站操作）。Electron额外1项为document-entry在ELECTRON_RUN_AS_NODE下仍访问app.commandLine，源码/解压同样复现，普通Node通过；真实产品辅助入口兼容性仍待修复。

完整默认命令实际退出1。unit 665通过/0失败/1跳过；integration 631通过/1047失败/50跳过，共1728项。全套default未通过。入口失败码分类为{"'WIN32_IO_ERROR'": 34, "'PROCESS_OWNERSHIP_UNSUPPORTED'": 110, "'PERSISTENCE_UNSUPPORTED'": 624, "'PROJECT_ROOT_OVERLAP'": 23, "'ERR_ASSERTION'": 72, "'UPDATE_PLATFORM_UNSUPPORTED'": 1, "'EPERM'": 22, "'NOZELI_CAPABILITY_UNAVAILABLE'": 13, "'RECOVERY_OWNER_UNVERIFIED'": 8, "'OPEN_PERSISTENCE_UNCONFIRMED'": 41, "'ERR_TEST_FAILURE'": 10, "'EBUSY'": 40, "'ENOENT'": 15, '1': 1, "'PROJECT_IDENTITY_CONFLICT'": 4, "'DEMO_IDENTITY_CHANGED'": 13, "'FS_PLATFORM_UNSUPPORTED'": 11, "'EINVAL'": 1, "'CONFIG_IMPORT_UNSUPPORTED'": 2, "'EACCES'": 1, "'EADDRINUSE'": 1}，不是根因或完成率。首次只给System32 PATH的default在unit通过后因缺Git前置退出2，原件default-system-path.tap/json保留；补独立测试进程Git和固定Node路径后执行本次完整default，不修改系统环境。外部打开队列仍使用全局持久化门控，不以profile专项可用推断它已经适配。

本地资格ZIP 43416文件、1398878361展开字节，SHA256 `9444520b12173f78bdac9b94177ef120711817c1cd9fb61d1ffa25eed996173d`，路径 `D:\nozeli-test\20261109-alpha5-host-lifetime\desktop-package\Nozeli-windows-alpha5-qualification.zip`。ZIP CRC/全部解压摘要、当前src/dist/tests、随包Node/Git/Pi解析通过；冻结1542项、258项变更新增JS语法通过。native输入与既有实际构建二进制复核。源码相同的定向失败保留，资格包不称用户发行包；无GUI/物理桌面新增资格。W0 passed，W1–W5 unsupported，managedExecutionReady=false。未安装、发布、提交、推送、使用个人资料或系统剪贴板。

下一批：修document/handoff/terminal辅助入口对Electron Node模式的判断并实测真实CLI；接通外部打开队列的Windows私有读写、CAS、屏障与未知结果；继续特殊项目恢复owner原实体/原注册/停稳证明，其他仍未释放的fixture逐个确认全部宿主归属；生产pending/tools/projection/owner冷恢复及Work/Git接受闭环随后推进。历史默认失败、旧Office Git一次失败和未解释GUI关闭保留，不能用本批62项改善替代完整W1–W5。

## Windows alpha.6 + PR27 本地整合（2026-11-09）

当前 Windows 开发切换到 `D:\nozeli_windows\nozeli-alpha6` / `platform/windows-alpha6-pr27`，固定官方 alpha.6 `9a2466a` 与 Draft PR27 HEAD `5fbc482`，原 alpha.5 工作树完整保留。Windows 原生组件、Pi、PPTist、renderer 已在新树实际构建；当前包、源码／解压四宿主回归、可见 Electron 与失败边界见 [Windows alpha.6 整合记录](windows-alpha6-integration.md)。

W1–W5 完整产品资格仍 unsupported；Windows 新语义初始化在 Controller／模型派发前明确拒绝，永久重置在枚举范围前明确拒绝。能力矩阵不改绿。默认／集成失败、广泛 Windows 批次超时、旧手工 Workspace fixture 的拒绝与首包快照失败均保留，不能用局部通过覆盖。ExternalOpenQueue 尚未接入主入口持久路由。后续开发使用新树与最终验证包，不在保留的 alpha.5 树叠加新改动。


## Windows alpha.6 / 已合并 PR27 增量（2026-11-09）

当前 Windows 工作树以 main `cb07c51` 为固定上游，保留未提交 Windows 改动；最终 PR HEAD 为 `b72e744`。15 文件最终安全修正和 Windows 检查点 Git 长路径补修已落地。源码／解压 Node／Electron Node 四组各 166 通过 / 0 失败 / 1 跳过（167 项），真实 GUI 各6项通过；unit 813 通过 / 8 失败 / 1 跳过（822 项），上游安全批次 12 通过 / 25 失败 / 16 跳过（53 项）。全部失败保留；full integration 本批未重跑，旧结果不外推。renderer 实际重建，native 本批未重编且输入／二进制核对一致。新 ZIP SHA256 `76cab383ca5a758fabfc83d96699e7479eb920054fccefd36b4769b2522e4ffe`。详见 [最终合并版记录](windows-alpha6-pr27-merged.md)；前文 Draft/初稿记录为历史。生产能力矩阵及完整 W1–W5 状态不改绿，未安装／提交／push／签名／发布。

## Windows v53 原生恢复意图与同字节恢复检查（2026-11-12）

源码 Node/Electron 完整 Pi 各54/54；源码及独立包 Node/Electron 原生意图各3/3、实际续作各2/2；独立包 Worker 两布局各2/2通过。Pi实际重建，renderer/native未改未重编，核对36项原构建输入/输出。ZIP43633文件、冻结1734输入及包摘要通过，SHA256 `ba12c985c791644ebb0df8d23822938cb966f8b667f35a72f866b080f83f6739`。四宿主ready丢回复已完成4/4，以本批development-status.json和原始TAP/JSON为准，不提前计通过。

完整恢复材料生命周期、metadata/journal实体交接、项目配置/角色runtime依赖、独立恢复读取和原helper/home释放、祖代处置后二次cold、pending/default入口、终端/TeX/回收/物理桌面/普通账户安装更新回滚及剩余W0–W5继续未完成。v50正式基线保持，v53仅开发候选，固定alpha.6＋已合并PR27。没有安装替换、提交、推送、签名或发布。

消费点：`journal-io.mjs` 的 has/publishRecoveryIntent；`bridge.mjs` 的 inspectRecovery/recover/readJournalSnapshot。原生create-only发布保留赢家，发布后屏障或关闭失败保留UNKNOWN；显式续作丢回复不会重放原输入。故障注入器首次重复吞掉只读完成回复的失败与修正证据保留。

下一批实际新发现：配置管理层RuntimeSupervisor在角色session过滤前自动执行项目JS扩展，隔离探针已复现（零模型请求）。详见恢复材料闭包设计新增小节；尚未修复，v53包不含此修正。先收紧实际资源读取边界，保留项目模型配置权限，再推进全生命周期与释放。

## Windows v54 owner配置管理资源边界（2026-11-12）

2026-11-12 Windows v54：修复配置管理层在角色会话前自动执行项目JS扩展的提前加载链。可选driver资源策略保持上游默认行为和SDK项目模型设置权限，Nozeli owner提前过滤非发行包资源；显式空SYSTEM/APPEND来源避免先读后覆盖。最终源码Node/Electron完整Pi各55/55、provider回归各26/26通过；独立v2包两宿主各资源3/技能8/真实owner1/恢复意图3/显式续作2/Worker布局2通过。v50正式基线不变，完整W0–W5未完成。见[本批记录](windows-alpha6-runtime-resource-boundary.md)。

证据 `D:\nozeli-test\20261112-alpha6-resource-boundary\development-status.json`。补丁0006在隔离LF文本上正反应用与原文完全一致；初次混合CRLF反向检查失败保留。Pi已重建，native/renderer未改。最终v2包SHA256 `19056e22a79720501d71cd78a1784d19e9dfdb0b2e3456f4e0f44b23a78786f9`；运行后核对43636包文件、1790冻结输入、36项未改native输入/输出。初版包的技能导入和共享冻结清单限制保留在证据中，不作为最终资格。


<!-- windows-v55-settings-read-boundary -->
## Windows v55 配置实际读取版本（2026-11-12）

2026-11-12 Windows v55：SDK配置存储接入原生实际读取字节与FileID证据；项目优先级、迁移、dirty-field合并及reload保留，写入比较身份与字节后原子提交。源码Node/Electron完整Pi各56/56通过。独立包两宿主各配置9/资源技能11/读写23/替换ACL持久化49/进程25/实际owner6/Worker布局2通过，包与冻结输入核对通过。正式v50基线不变，完整恢复材料闭包、helper/home释放、pending/default及W0–W5产品发行门继续未完成。见[本批记录](windows-alpha6-settings-read-boundary.md)。

证据 `D:\nozeli-test\20261112-alpha6-settings-reads\development-status.json`。最终ZIP SHA256 `189565b3fcb6acd739a7aed3e9013d4762ec530531bc3f81727ca6f7fc8a554e`；43639文件、1793冻结输入及36项本轮重建native输入/输出核对一致。
<!-- /windows-v55-settings-read-boundary -->


<!-- windows-v56-settings-cold -->
2026-11-12 Windows v56：配置读取证据增加记录/blob原生FileID链和stdout head身份；原host冷检查、完整home归档及独立只读读取器核对同一确认前缀，未确认尾部/孤立文件/历史流/旧schema明确保留UNKNOWN。源码Node/Electron完整Pi各56/56；四宿主配置9、冷读取19、真实冷owner替换拒绝及正常/ready丢回复归档专项通过，独立包资源/实际owner/Worker通过。正式v50基线保持；完整读取生命周期、models/auth/import/角色/metadata/journal、helper/home处置、pending/default及其余W0–W5产品发行门仍未完成。见[本批记录](windows-alpha6-settings-cold.md)。

证据 `D:\nozeli-test\20261112-alpha6-settings-cold\development-status.json`。最终v2 ZIP SHA256 `d0c7e682cbef5fa1c71bfaf8dbe3cd1bdbcf51467181f0fc6cc69771f28580b3`。
<!-- /windows-v56-settings-cold -->
