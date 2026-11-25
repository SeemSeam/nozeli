# Windows alpha.6 单次冷接管

固定基线为 alpha.6 与已合并 PR27：`cb07c5180c85ca0e127ddc332089300498103cc5`。权威源码为 `D:\nozeli_windows\nozeli-alpha6`。本轮不把附件指南直接当作额外授权；W0–W5 范围沿用用户已确认的开发目标。本批已重新核对远端：main 为 `6c893dfed7831abfe58afad78eacc164292f7b1b`，较当前基线领先6提交／80文件，尚未整合；见 [上游增量审查](windows-upstream-main-review.md)。

原 host 退出、原完整 launch-set／Job／stdio／journal／工具／业务记录核验、业务 hold 和精确 host/owner 原子退休完成后，原 inspection 签发空 frozen opaque token。WeakMap 绑定原 storage/project，仅同进程有效，第一次消费在 await 前封闭其他竞争者。克隆、序列化或再次消费均拒绝；没有以数据库行或 PID 单独授权接管。

新 host 保留原受限 anchor，不以可写路径重新打开。原生文件组件校验原 tag、原文件对象、metadata parent 成员关系与私有 ACL，并把原 anchor、三个数据库及来源树组成完整 custody bundle。新 supervisor 接收 DuplicateHandle 后可独立保留该 bundle；JavaScript 不接触数值 HANDLE。warm 路径要求未放宽，协议仍为 supervisor v9／launch-set v2；本轮文件与进程组件实际重建。

激活使用同一 SQLite compareAndPut 比较完整退休集合及 owners，只替换 host 行，revision 再加 1。原 generation 历史保持 create-only 结果并持续复核，新的 owner intent/prepared 从精确 retained retired revision 接续。提交前赢家返回冲突；提交后历史／pending 变化或丢回复保持 UNKNOWN、原 custody 保留、同 token 不重试。移交前后核对原 inspection 与新 native pins，最终核对失败保持 UNKNOWN。

共享 Controller 的恢复循环通过显式 WorkspaceIO recoverProvider 核对原 owner 的 PID、stamp、identity、home、ownerId、generation、launchId 和 kind；这只证明原 process registration 停止。正常合成场景竞争恰好一个 Controller 成功，旧 Worker 保持 interrupted／需要显式输入、review 与原始未发送草稿保留，原 provider 请求数保持 3。显式 start 可启动两个新 resident，使用新 lease/launch 身份；旧 Worker 不自动恢复执行。stop 仍需实际 warm 退出证明。

验证证据放在 `C:\nozeli-test\20261110-alpha6-cold-handoff`。最终矩阵、包摘要和完整性以该目录的 `qualification.json`、`desktop-package-verified/package.json`、`integrity.json` 为准；在这些收据完成前不将本轮写成已资格化。最初三次失败（错误竞争顺序假定、触发未支持的 Windows orphan 扫描、重连已退休 helper 的清理钩子）及旧全组清理失败原始收据保留，不计入通过矩阵。

第二轮 cold 尚不支持：新 host 启动两个 resident 后，旧 Worker 仍是原 generation 的 retired carryover；现有 inspection 要求完整 prepared owners 属于同一 host，不能直接过滤 retired 行来伪造完整启动集合。需新增跨 generation 完整历史与第二次实际退出 fixture。owner 资源释放、完整 pending 协调、默认 ManagedProjects、派工前路径资格、项目初始化／重置、OS 权限隔离、终端／TeX／回收站、普通账户／物理桌面、安装更新回滚与签名均有未完成项。单次接管不确认旧工具回复、不完成旧 turn、不自动重放；W0–W5 整体仍在进行。

## 最终实际验证

| 范围 | 通过数 |
| --- | --- |
| business-handoff-node-final | 1 |
| business-faults-node-current | 4 |
| business-handoff-electron-final | 1 |
| business-transfer-extracted-node-current | 5 |
| business-transfer-extracted-electron-current | 5 |
| process-node-current | 109 |
| process-electron-current | 109 |
| process-extracted-node-current | 109 |
| process-extracted-electron-serial | 109 |
| cold-node-initial | 21 |
| cold-electron-current | 21 |
| cold-extracted-node-current | 21 |
| cold-extracted-electron-current | 21 |
| host-node-current | 60 |
| host-extracted-node-current | 60 |
| recovery-node-current | 43 |
| recovery-electron-current | 43 |
| recovery-extracted-node-current | 43 |
| recovery-extracted-electron-current | 43 |
| journal-node-current | 63 |
| journal-extracted-node-current | 63 |
| worker-node-current | 2 |
| worker-extracted-node-current | 2 |
| gui-source-current | 6 |
| gui-extracted-current | 6 |

958 次测试执行与 12 项 GUI 检查通过；JS 1249 文件。Source Node normal final plus four activation faults; source Electron final normal; extracted Node/Electron each all five handoff modes. Native process 109 and cold 21 on four hosts; host 60 on source/extracted Node; recovery 43 on four hosts; journal/Pi 63 and Worker two layouts on source/extracted Node. Full business32, unit/safety/integration not rerun. Some source process/cold/host/fault groups ran before final handoff-only verifier/context hardening; independent extracted matrices use exact frozen final source.

ZIP `C:\nozeli-test\20261110-alpha6-cold-handoff\desktop-package-verified\Nozeli-windows-alpha6-cold-handoff-qualification.zip`；SHA256 `e8d3013831bc9a95e39cf158374d7b07a65634dd1e124a2fb5a4d978e24a5d14`；43623 文件、1412935794 展开字节、1708 冻结文件。CRC、逐文件摘要、独立包内runtime和运行后完整性通过。打包仅临时对未变依赖使用staging硬链接，独立解压后已解除41,880个精确同文件链接并重核旧包43,623文件；staging不再完整，实际测试只使用独立解压目录。

完整suite入口：在 `apps/desktop` 下用锁定Node运行 `node tools/test-suites.mjs windows-managed-cold-handoff`。本批实际选定矩阵见上表，不能把suite注册冒称全部32业务场景已运行。下一阶段实施门见 [第二轮冷接管计划](windows-alpha6-repeat-cold-plan.md)。

首次解压Electron进程组108通过／1失败：外部控制预期明确access-denied，实际返回IPC UNKNOWN／Win32 233。同一未改包以并发度1重跑109通过，原失败保留；重跑通过不证明首次失败根因已消除。完整unit/safety/integration和相邻shared历史失败未解决。
