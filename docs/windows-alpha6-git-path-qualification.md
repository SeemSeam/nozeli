# Windows alpha.6：Git 工作目录与 worktree 管理路径

2026-11-12。固定 alpha.6＋已合并 PR27；正式基线 v50，v51 继续开发。证据根为 `D:\nozeli-test\20261112-alpha6-git-admin`，每组最终命令、退出码和 TAP 分别保存在该目录，汇总为 `development-status.json`。

本轮修正的是已被真实 MinGit 重现的目录限制。`core.longpaths=true` 允许长 tracked 文件路径，但 Git 在读取仓库配置前仍会对工作目录和 worktree 管理目录执行 MAX_PATH 检查。真实探针中，管理目录长度 249 个 UTF-16 单元可创建，250 时因 `commondir` 子路径达到 260 而失败；中文路径同样按 UTF-16 计数，UTF-8 超过 260 字节本身不代表不支持。独立进程边界探针、失败 stderr 和原试验均保留，未将失败试验覆盖成通过。

共享 ExecutionWorkspace 在读取执行清单、初始化 Git 和写入恢复证据前，先检查项目 cwd、Worker `.git` 路径及实际 worktree 管理路径。已有仓库只读查询 Git 返回的 `commonDir`，包括 linked worktree；新项目按将创建的 `.git` 位置检查。已有同名管理目录使用 Git 的数字后缀规则选择检查对象，已注册 Worker 使用自身实际 `gitDir`，避免冷恢复把原注册误判为新冲突。真正注册前再次检查。超限返回 `UNSUPPORTED_GIT_WORKTREE_ADMIN_PATH`，由既有人工边界处理；不自动修复或重试 Git 写入。

目录长度检查只判断当前 MinGit 已证实的限制，不构成身份或所有权证明。原有原生目录/FileID、Git 双向注册、清单 CAS、锁身份和原子发布核对继续执行。独立外部 Git 进程在检查后竞争同一 admin 名称的 TOCTOU 并未消除，Git 本身的失败仍需保留并通过现有恢复流程处理。UNC、junction、设备路径、不同长路径策略或其他 Git 版本不由本轮本机路径测试外推。

新增真实回归覆盖：无 Git 新项目在 init 前拒绝；已有仓库保留 refs/config/index；短 linked worktree 正确检查另一处 commonDir；同名 admin 目录加数字后缀超限时保留外部 worktree；249 单元且 UTF-8 超过 260 字节的中文 admin 路径实际创建、检出及冷恢复；中文 cwd 超过 260 UTF-8 字节正常初始化。既有长 tracked 中文文件检出/提交与深 Worker 根拒绝继续验证。

本轮 renderer 实际重建，候选使用冻结的当前 `src/dist/tests/tools`；native/Pi 未修改，复用且核对 v50 的实编二进制和输入。完整四宿主结果、包摘要和独立完整性核对以 `development-status.json` 为准，不能以打包成功或定向测试通过代替完整 W0–W5 验收。

此前 `20261112-alpha6-git-paths` 快照的源码 Electron 归档矩阵实际 8/8，清理时已停止尚未开始的包内后续队列。该快照不能冒充本轮最终源码资格。更早一次 owner 在启动确认前退出仍未解释，后续通过不消除该失败；本轮保留新增启动诊断以便再次出现时核查。

完整 Windows 目标仍需完成恢复材料与 helper/home 生命周期、后继 cold 恢复、pending 显式协调、默认 ManagedProjects、终端/TeX/回收及其他产品工作面、普通用户/物理桌面、安装与更新回滚等。W3 可按指南明确 unsupported，不代表完整 Windows 版已交付。

本轮最终结果：四宿主路径专项各 3+8 项通过；完整 Work 生命周期四宿主各 31/31；ready 丢回复四宿主各 1/1。renderer 重建退出 0，ZIP CRC、43,631 个独立解压文件、1,716 项冻结文件和 36 项 native 输入/输出核对通过。候选 `D:\nozeli-test\20261112-alpha6-git-admin\desktop-package-candidate\Nozeli-windows-alpha6-git-admin-candidate.zip`，SHA-256 `683037a33bc3e98c68b4720782b5c3fbeaa172fbf5071e16666c85179255a7bf`。完整归档八场景矩阵未在该最终快照四宿主完成，v50 正式基线保持不变。

2026-11-12 后续实际结果：原冻结 v51 Git admin 候选（SHA256 `683037a33bc3e98c68b4720782b5c3fbeaa172fbf5071e16666c85179255a7bf`）四宿主完整八场景各8/8通过，共32次。源码两组结束后才修改共享Pi进行v52开发；解压两组一直运行原冻结包。该矩阵不能冒充v52全矩阵；v52的独立包及ready丢回复范围见[恢复材料实现记录](windows-recovery-material-closure-design.md)。v50正式基线及完整恢复/发行缺口保持。
