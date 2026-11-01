# Windows / macOS 第二阶段开发交接

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
