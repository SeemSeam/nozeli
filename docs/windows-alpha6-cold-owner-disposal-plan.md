# Windows 冷 owner 资源处置实施门

2026-11-11 Windows v50：原owner home目录身份/ACL及父链在首次resume前交给helper，真实host退出后仍保持并约束cold journal/归档；修复伪造home重连在拒绝前的接收HANDLE清理，重复拒绝回归通过。完整恢复材料生命周期、归档协调、资源释放及默认入口仍未完成，见[本批记录](windows-alpha6-home-custody.md)。下文为历史。

v49已完成完整观察到的home、原stdio和账本持久归档，见[实际记录](windows-alpha6-cold-evidence-archive.md)。下面的原home全生命周期custody、完整恢复闭包、归档协调、helper释放及已处置祖代后继cold证明仍为未完成实施门。

这是第二轮冷接管之后的下一批方案，未实现资源释放资格。当前 `managed-cold-checkpoint.mjs` 的退休只改变本机登记记录；原 helper 继续保留各代 Job、stdio、原受限 anchor 和 source。`owner-launch-registry.mjs` 的正常 retire 依赖同一活宿主的 opaque exit proof，不能拿冷检查点或数据库 retired 行代替。测试结束时对精确合成 fixture 执行的 shutdown 也不是产品资源处置验收。

2026-11-16 独立前置能力：native supervisor `observeExit()` 仅查询首次认证时保留的原 process HANDLE（PID + creation time），零等待、无管道请求、不重发 shutdown、不重新按 PID 打开。新合成 helper 的第二观察者在原 owner 明确 shutdown 后仍可核验同一进程对象退出，但不获得 shutdown ACK、owner release 或 cold recovery 资格；`experimentalSupervisorShutdownObserved` 不因观察而置位。实际 smoke `N:/dev-cache/helper-exit-observe-XVsUjz/report.json` 与源码 supervisor13/13 通过。旧 `helper-release-archive-test` exit4 和全部原 UNKNOWN 不由此修复或重做；下面的归档/接续/授权/单调处置回执等门仍未完成。

同日 cold inspection 增加 `helperExits()`：只查询该次 inspection 已认证并保留的完整原 helper HANDLE 集，逐项绑定 hostLeaseId/target/ownerRevision/launchId/进程创建时间，返回 running/exited/unknown。关闭 inspection 后拒绝，伪造 receiver 拒绝；不重连 endpoint、不做账本写入，明确 `ledgerRevalidated:false`、`shutdownAcknowledged:false`、`ownerReleaseQualified:false`。新真实 cold fixture 观察完整集合从 running 到 exited，验证全部本机记录未变；原 `inspection.check()` 在 helper 退出后仍拒绝，不以退出事实替代 kernel custody。源码定向原生集成1/1 通过；独立打包资格另列，不授权旧UNKNOWN处置。

独立 archive reader 开读不再只信当前 plan/archive 两行：先完整核验原归档、材料及原比较回执，再验证处置计划 ready 的精确 CAS 指纹、intent/ready receipt、修订和 owner 全集合；读取前后均复核原行与树身份。新真实 ready-lost-reply fixture 覆盖同修订号伪造 owner 计划、外部 owner/路径、原字节一致性、计划漂移与同字节文件替换；源码1/1 通过（274.95s，原600s界限）。这仍是只读认证，未赋予 helper/home release 或已释放祖代接管资格。

1. **先区分证据保留与业务处置。** 原 Worker 的工具回复、turn 和 pending 仍未决。只在显式处置流程确认业务保留项、原候选/草稿/工作区及恢复材料已经持久化后评估资源归档；不得把 Job 空、EOF 或已提交工具效果直接视为执行确认。无必要原实体、未知提交结果或未解释历史时保留并拒绝。
2. **从原 inspection 签发一次性处置能力。** 绑定精确 storage/project/instance、所有相关代次的 host/owner/history/checkpoint/revision、原 helper incarnation、完整 source/stdio 摘要及归档目标。token 只在当前进程有效，消费先于 await；不由 JSON、路径、PID 或 arbitrary verifier 构造。完整集合及 pending 在归档前后复核。
3. **用原生目录/文件能力建立独立归档。** 原私有 home 的 journal、metadata、工具材料和必要恢复内容从原句柄读取并写入新受限目录，写入和目录屏障、File ID、摘要、大小及完整文件集合均验证。必须先明确哪些 retained 文件构成完整恢复闭包，不能只复制已知 journal 后宣称整个 home 可删除。Windows rename/delete 的共享权限、reparse、hardlink、并发替换与失败阶段需独立资格化。
4. **分阶段保存处置回执。** 归档意图、归档已持久化、可释放范围、原 helper shutdown 已核实、最终处置分别有精确且单调的记录。跨 SQLite/文件系统/进程不伪装原子事务；实际 COMMIT 丢回复、归档完成未回复、shutdown 丢回复等保留 UNKNOWN，通过显式只读核对处置，不自动重做副作用。
5. **持续保留下一代需要的原 anchor。** shutdown 前证明当前活宿主和必要继承 helper 已独立持有同一原受限 anchor、source 和 launch-set 需要的实体。逐个原 endpoint shutdown，观察该精确进程对象退出后才关闭本端 pin；任一失败停止后续释放。禁止全盘 PID 扫描、按名称结束 helper 或以 endpoint 不存在推断释放成功。
6. **更新后继 cold 的证据模型。** 当前多代 inspection 明确要求全部原 helper 存活，释放后不能继续沿用该前提。必须新建并验证“已处置祖代”的完整归档/退出证据与原生 custody 接续门；否则即使本次释放完成，下一次 cold 也应明确 unsupported。warm-retired owner 历史同样单独处理，不过滤后伪造完整 launch-set。
7. **先真实故障回归，再默认入口。** Node/Electron 源码及独立解压覆盖持久化前失败、归档同值修订赢家、原材料/目录替换、归档后 pending、两个处置竞争、实际提交丢回复、shutdown 前后进程状态与下一次真实 cold。验证不删除新赢家、草稿/候选/暂停 Worker 保持、无旧输入重放，并记录精确残留资源。必要原生改动实际重建和打包验证后，才评估默认 ManagedProjects。

本门不改变当前能力矩阵，也不授权删除旧证据包、真实用户 home 或日常安装。完整 W0–W5 还包括 pending 显式协调、派工前路径资格、初始化/重置、OS 隔离、终端/TeX/回收站、普通账户和物理桌面、安装/更新/回滚/签名。
