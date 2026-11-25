# Windows alpha.6：D 盘恢复开发与归档核对验证

2026-11-12。继续固定 alpha.6＋已合并 PR27，未同步 beta.1/main。正式已验收基线仍为 v50，本批仍为 v51 开发候选。

本批在 D 盘重新运行真实 Windows x64 Controller/Pi 流程。源码 Node 的归档矩阵 8/8 通过：正常归档、intent 提交丢回复、原材料并发变化、intent 后出现 pending、归档目标竞争、ready 提交丢回复、ready 同值修订、退休历史并发修订。测试核对原 home/helper 保留、候选与草稿保留、暂停 Worker 和旧输入零重放。

ready 提交丢回复场景在源码 Node、源码 Electron、独立解压包 Node 和包内 Electron 均实际通过。该场景启动独立核对进程：原始 ready 提交可返回 ready-verified；修改归档流或伪造原提交比较指纹被拒绝。不授予 helper/home 释放资格。其他七个归档场景尚未在另外三种运行方式完成，本批不声明完整四宿主归档资格。

新发现并修正随包 Git 对长文件路径的调用问题：Windows Git 命令增加进程级 `-c core.longpaths=true`，不修改全局或项目 Git 配置。真实合成回归在 PATH 无系统 Git、项目显式 core.longpaths=false 时，完成超过 300 字符的中文文件添加、worktree 检出、候选提交和独立读取；验证原配置与原文件保留。四种运行方式各通过一次。

超过 MAX_PATH 的进程 cwd／worktree 根仍有独立限制。本批实验记录过 `$GIT_DIR too big`、ENOTCONN 和 Git chdir 失败；没有通过缩短 fixture 就宣称这一限制已解决。归档验证使用 D 盘的较短专用测试根，深 cwd 支持仍需单独修复或在副作用前完成路径资格检查。

原生 SQLite 回归四种运行方式各 14/14，共 56 次通过。共享 Work 的实际候选提交、接受、索引/ref 更新和清理定向场景通过。通用 Git 四项回归为 3 通过、1 失败；失败位于默认 ProjectStorage 的 Windows 持久化能力拒绝，不计为整组通过。一次真实 owner 在确认前退出仍未解释，保留启动失败、账本及日志；后续通过不抹去这次失败。

测试清理补充了启动失败早于 parent pin 时，按精确已登记 endpoint 回收合成 fixture helper 的路径。另有四个此前残留的 helper 通过原端点的 PID、创建时间、镜像和 custody 核对，确认 host 已退出、Job 空且 stdio EOF 后执行原生 shutdown 并观察实际退出；这只是合成测试资源回收，不是产品冷资源释放验收。

renderer 已实际重建；本批未修改 native/Pi，36 项 native 源码/二进制与 v50 实编证据一致，Pi 内容与 v50 独立包一致。新 ZIP CRC、43,631 个独立解压文件和 1,716 项冻结源码/构建文件核对通过。详细命令、退出码和内存采样见本批 evidence 根。

本批 evidence：`D:\nozeli-test\20261111-alpha6-archive-resumed`。

本批候选：`D:\nozeli-test\20261111-alpha6-archive-resumed\desktop-package-candidate\Nozeli-windows-alpha6-archive-reconciliation-candidate.zip`。

SHA-256：`f33fb8895ac9acd88c3726b7ca6a357128118f8c1720b00db649c698ba9090ea`。

完整 Windows W0–W5 仍未完成：其余宿主归档矩阵、完整恢复材料生命周期与 helper/home 处置、已处置祖代的后继冷恢复、pending 显式协调、默认 ManagedProjects、深路径资格、终端/TeX/回收与完整产品工作面、普通账户/物理桌面、安装/更新/回滚/签名等门仍需继续。W3 隔离允许按指南明确 unsupported；不能据此外推其他门已完成。
