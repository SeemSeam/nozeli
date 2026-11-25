# Windows alpha.6 managed 分离目录接入（2026-11-09）

后续原生项目host启动集合与当前包见[最新记录](windows-alpha6-launch-set.md)；下文保留原批次事实和当时限制。

后续原生冷检查点与当前源码包见[最新记录](windows-alpha6-cold-checkpoint.md)；下文保留分离目录批次的原始结果。

固定基线为 merged alpha.6 PR27 `cb07c5180c85ca0e127ddc332089300498103cc5`。当前改动解决 managed 原生宿主／来源和执行证据仅支持一个实验根目录的问题：桌面实际布局的项目与 profile 分离，不能为了通过测试改成共同祖先授权。完整生产 managed 入口与冷恢复仍未完成，W0–W5 范围不变。

## 实现与权限边界

`managedStorageLocation` 逐路径调用原 ProjectStorage 的 `nativeRootForPath`，分别取得 profile 或已选项目的原生锚点。宿主租约的项目 anchor、profile 本地 SQLite、catalog、项目 SQLite 和 manifest 各自使用相应锚点，保留原生 File ID、私有权限、实际行 revision、CAS、UNKNOWN 与原 Job／supervisor 证明。

新增显式 `createWindowsDesktopWorkspaceIO({storage,previousHostRelease})`，绑定原 storage 对象，并限定 runtime 必须为该注册 instance 的 `execution` 目录。metadata 写入只准入原项目 `.nozeli`，运行态写入只准入原 runtime；执行证据允许当前项目和 runtime，其他已登记项目及 profile 的无关路径也拒绝。私有目录准备从已选项目根内部开始，用户项目目录保持普通目录权限，不修 ACL。

ExecutionWorkspace 的 I/O 工厂新增互斥的 `windowsRootForPath` 注入，用同一共享准备／发布／索引／ref 状态机处理不同锚点的来源和目标。逐文件读取、流复制、manifest SHA CAS、Git lock 身份及 uncertain fence 没有改成普通路径覆盖。WorkChanges 和 Pi owner 继续使用 profile 私有根。

真实 Worker 进一步暴露 WorkChanges 的长 ref 锁路径问题。归档 Git 环境现在仅为自有子进程设置 `core.longpaths=true`，使用 Windows `NUL` 隔离全局配置，不写用户配置或仓库配置。当前随包 Git 对仓库目录本身过长的初始化／cwd 支持仍未通过：独立探针保留绝对路径、环境／参数 Git dir、相对初始化及 namespace cwd 的原始失败。已撤去这些尝试，未短路权限或引入目录别名；Windows 私有成果仓库路径 UTF-8 字节数达到 248 时，在创建归档目录和 intent 之前返回 `CHANGES_PATH_UNSUPPORTED`。这是一项明确的保守资格边界，后续需继续解决，不代表 Windows 所有路径均可执行任务。

原 `createExperimentalWindowsWorkspaceIO({root})` 单根限定入口保留。新的桌面入口用于明确注入和资格验证，`productionSelected=false`、`coldRecoveryQualified=false`；没有自动选择到 ManagedProjects，也没有放宽共享 Windows 能力矩阵。原 WeakMap 签发的一次性 release receipt 仍是 warm reopen 唯一凭证，序列化记录、进程消失或可打开 HANDLE 不能授权冷接管和重放。

## 永久回归

新增 `windows-desktop-managed-roots.test.mjs` 共 10 项，真实注册两个独立临时根，验证业务草稿／排队任务／不可变历史、原 instance/runtime／storage 绑定、跨根证据复制和独立赢家、其他已选项目拒绝、catalog revision 赢家、runtime ACL 变化、实际 recovery commit 后丢失 custody 的 UNKNOWN，以及独立新进程冷启动拒绝自动接管且保留未发送草稿。另验证超过 MAX_PATH 的真实 ref 发布／归档与配置不改写，以及过长仓库目录在任何分配前明确拒绝。fixture 的数据库停止必须得到确认后才删除合成目录。

命名入口为 `node tools/test-suites.mjs windows-desktop-managed-roots`。`windows-worker-flow.test.mjs` 增加真实桌面分离根布局，原单根布局与相同业务断言保留；通过真实 Controller／本地脚本 HTTP Provider／Pi SDK／随包 Git 验证实际修改、原项目不提前改动、审校与版本拒绝、明确接受、Git 合入、原 home/journal 身份归档和 warm reopen。没有调用真实账号或付费模型。

证据根为 `D:\nozeli-test\20261109-alpha6-managed-roots`。首轮实测发现从项目父目录准备私有链会错误要求用户项目目录具有私有 ACL；修正为原已选项目内部的较窄锚点，原始失败 TAP 保留。最终运行与包收据在完成后追加，不以运行中状态冒称通过。

## 到完整产品仍缺

生产 ManagedProjects 的 workspace／owner 工厂选择、Host 停稳／pending／tools／projection 的明确冷协调、Windows 初始化与永久重置仍未接通。默认 unit 与完整 integration 的历史失败不由本批定向结果消除。后续必须先证明冷恢复与停止条件，再开放正式 managed 入口；本批显式任务链不能替代这些资格。

## 最终实际结果与当前包

总收据 `D:\nozeli-test\20261109-alpha6-managed-roots\qualification.json`。所有以下测试均针对本批源码或新独立解压包实际执行；不是完整 unit／safety／integration 全套通过。

GitHub API 在 2026-11-09T10:00:32.810809+00:00 再核对：main `cb07c5180c85ca0e127ddc332089300498103cc5`、最新功能 PR27 的 merged／HEAD、最新预发布 alpha.6 均未变化；开放依赖升级 PR 未纳入。releases/latest 对全部预发布仓库返回 404，随后 releases 列表确认最新 tag，原响应保留。证据 `D:\nozeli-test\20261109-alpha6-managed-roots\upstream-final-api.json`。

| 范围 | 结果 |
| --- | --- |
| roots-node-final | 103 pass / 0 fail / 0 skip / 0 cancelled；共 103 项 |
| roots-electron-final | 103 pass / 0 fail / 0 skip / 0 cancelled；共 103 项 |
| roots-extracted-node | 103 pass / 0 fail / 0 skip / 0 cancelled；共 103 项 |
| roots-extracted-electron | 103 pass / 0 fail / 0 skip / 0 cancelled；共 103 项 |
| worker-node-final | 2 pass / 0 fail / 0 skip / 0 cancelled；共 2 项 |
| worker-electron-final | 2 pass / 0 fail / 0 skip / 0 cancelled；共 2 项 |
| worker-extracted-node | 2 pass / 0 fail / 0 skip / 0 cancelled；共 2 项 |
| worker-extracted-electron | 2 pass / 0 fail / 0 skip / 0 cancelled；共 2 项 |
| custody-node | 7 pass / 0 fail / 0 skip / 0 cancelled；共 7 项 |
| custody-electron | 7 pass / 0 fail / 0 skip / 0 cancelled；共 7 项 |
| custody-extracted-node | 7 pass / 0 fail / 0 skip / 0 cancelled；共 7 项 |
| custody-extracted-electron | 7 pass / 0 fail / 0 skip / 0 cancelled；共 7 项 |
| gui-source | 6 pass / 0 fail / 0 skip / 0 cancelled；共 6 项 |
| gui-extracted | 6 pass / 0 fail / 0 skip / 0 cancelled；共 6 项 |

最终 JS 语法检查 1237 文件通过。renderer 本批实际重建；native 输入与此前实际构建二进制逐摘要一致，本批未重编；依赖、Pi、PPTist 沿用已验证未变闭包，没有宣称 clean npm ci。

当前 ZIP：`D:\nozeli-test\20261109-alpha6-managed-roots\desktop-package-final-v2\Nozeli-windows-alpha6-managed-roots-qualification.zip`。SHA256 `0516562ad3bab2987ff03efe343f3cf116c6f2f6765056686353be224a9a8153`；43581 文件、1412373103 展开字节，冻结 src／dist／tests／tools 1695 文件。ZIP CRC、独立中文空格路径解压与全部文件摘要、当前源码、native／Pi 闭包、包内 Node／Git／Pi 与仅 System32 PATH 的解析均通过。打包采用独立复制，不共享旧产物硬链接。

源码与解压生产 GUI 各 6 项验证可见窗口、IPC 项目登记／原文读取／文本 CAS／冲突与草稿冷恢复，renderer errors=0。报告中的 documentVisibility=hidden，不能据此宣称实际文档面显示通过；物理 Explorer、IME、多屏未签收。本批没有重跑外部队列专项 GUI，之前的专项结果作为历史证据。

中间失败完整保留：最初 101 项有 6 项因私有链锚点错误失败；修复后通过。并行 Worker 复验发生一项原 180 秒超时及取消；顺序复验恢复单根通过，并确认分离根发布实际 CHANGES_GIT ref-lock 失败。补实际维护账本诊断后修复隔离 Git 长 ref。极深 bare 目录的探针和多种调用尝试均失败，未把失败转成通过；最终明确路径拒绝用例与超过 MAX_PATH 的 ref 成功用例分别保留。原超时、主业务和用户数据保护断言未放宽。

首轮解压包 Worker harness 沿用源码布局默认 Pi 路径，两个用例均在读取 manifest 时 ENOENT，失败后未注册的本地 provider 清理使测试进程仍存活；核对 PID／父进程后停止该测试子树并保留失败收据、TAP。随后仅在外部资格驱动中显式设置已有 NOZELI_TEST_PI_ROOT 为包内 resources/app/integrations/pi。产品源码、测试断言和 ZIP 均未因此更改；最终包内 Worker 结果以表格及独立收据为准。

默认 unit 的 8 项持久化失败、安全批次 25 项失败和历史完整 integration 失败仍须逐类处理；本批没有删除或跳过这些断言。完整生产入口、冷恢复及安装发行资格未完成。
