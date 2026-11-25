# Windows alpha.6 冷证据持久归档

本批沿用固定alpha.6＋已合并PR27 `cb07c5180c85ca0e127ddc332089300498103cc5`，承接v48第二轮真实冷接管。上游beta.1 main增量尚未整合。

`archiveWindowsManagedColdEvidence` 只接受原模块签发的inspection与精确storage/project绑定，同一inspection的并发调用合并为一次归档。先完成原业务hold、原anchor领取及冷记录退休，然后从每个原generation的精确owner home捕获完整有界目录树，核对原journal和metadata的File ID/摘要。它不是只复制journal：目录树中的其他文件、空目录、文件集合及全部内容都纳入原生身份、ACL、单链接/reparse和摘要检查。归档前观察到的完整home身份不会被冒称整个owner存活期间一直持有的home身份。

本机 `managed_cold_archives` 的create-only intent比较host/owner/checkpoint/tool/history和整个archive集合。意图持久化并核验后才分配新目录，目录使用唯一operationId及原生exclusive create。用现有原生private-tree复制和屏障保存每个完整home；从各代原helper读取原stdin/stdout/stderr，按原独立摘要持久化。manifest保存原检查点、退休凭据、完整本机与业务集合快照及原journal核验信息。独立打开复制结果，核对完整文件集合、全部摘要和原始stdio后，ready只将本归档行从revision1递增为2，并持续复核intent和ready回执。

完整业务核验在各阶段前后执行；复制每项及stdio每段间仍核对原kernel/source/完整本机ledger。原home内容改变、目录竞争、pending变化、历史或归档行同值修订赢家、实际COMMIT丢回复都拒绝或UNKNOWN，不自动重试，不删除原目录或竞争者。部分归档路径及意图保留，供后续显式协调。归档期间原helper继续持有各代原实体，代码没有shutdown/remove调用。

预算：最多32个已核验原owner，原home目录树总计最多10,000项/512MiB，完整manifest最多64MiB，stdio沿用原inspection的256MiB上限。目录、文件命名、ACL、身份、reparse和hardlink限制复用现有native接口，失败不回退Node路径读写。

真实回归包含normal、intent-lost-reply、source-winner、pending-after-intent、destination-winner、ready-lost-reply、ready-revision、ready-history-winner。合成共享Controller由真实Pi执行read/apply/publish，宿主在回复前被实际终止。额外二进制文件证明完整home复制；核对原暂停Worker/候选、3次provider请求、原文本、原home及helper均保留。所有故障通过实际文件/数据库变化或实际COMMIT后丢回复注入。

证据目录 `C:\nozeli-test\20261110-alpha6-cold-archive`；最终资格以该目录qualification/package/integrity收据为准，未完成前不宣称通过。suite入口：在apps/desktop使用锁定Node运行 `node tools/test-suites.mjs windows-managed-cold-archive`。

未完成：原home整个生命周期native custody、引用项目/工作区/对象的完整恢复闭包、归档显式协调、已归档祖代在无原helper时的后继cold证明、原helper确认shutdown与home释放、warm退休历史、完整pending协调、默认ManagedProjects及完整W0–W5。归档不确认原工具回复或turn，不授权自动恢复和重放。下一步继续[冷owner资源处置实施门](windows-alpha6-cold-owner-disposal-plan.md)。

## 最终实际验证

| 实际运行 | 通过数 |
| --- | --- |
| archive-all-node-final | 8 |
| archive-selected-electron-final | 3 |
| archive-all-extracted-node-final | 8 |
| archive-selected-extracted-electron-final | 3 |
| cold-node-current | 21 |
| cold-electron-current | 21 |
| cold-extracted-node-current | 21 |
| cold-extracted-electron-current | 21 |
| recovery-node-current | 43 |
| recovery-electron-current | 43 |
| recovery-extracted-node-current | 43 |
| recovery-extracted-electron-current | 43 |
| journal-node-current | 63 |
| journal-extracted-node-current | 63 |
| repeat-normal-node-current | 1 |
| repeat-normal-extracted-node-current | 1 |
| gui-source-current | 6 |
| gui-extracted-current | 6 |

406次测试执行及12项GUI检查通过；JS 1255文件。Final source and independent extracted Node each all eight actual cold archive modes; Electron each normal/ready-lost-reply/ready-revision. Final normal archives then performs real opaque handoff, Controller startup of two residents and warm stop. Adjacent cold21 and recovery43 on four hosts; journal/Pi63 on source/extracted Node; two-death normal on source/extracted Node and visible GUI six each. Full two-death faults, host60, ordinary Worker2, native process109 and single-handoff5 retained from v48/v47, not rerun or counted. Early source recovery and renderer build predate archive-only error return fix; their relevant shared code/build inputs unchanged. All extracted matrices use final frozen source. Full business32/unit/safety/integration/shared not rerun.

ZIP `C:\nozeli-test\20261110-alpha6-cold-archive\desktop-package-verified\Nozeli-windows-alpha6-cold-archive-qualification.zip`；SHA256 `46d3723e168f7936254f755942e49aeba1453eaa74e3e3048e6980940d05d47b`；43629文件/1412987623展开字节/1714冻结文件。renderer实编；native/Pi未改，逐字节核对此前实编结果。独立解压后解除临时staging精确硬链接，staging不完整，所有包测试使用独立解压目录。

首次归档共享锁失败、早期提交后fence错误码失败、冻结源码变化导致旧候选拒绝、复用staging mkdir失败原收据均保留。旧候选完整展开文件由上一有效ZIP及六文件差异ZIP、完整manifest和原ZIP metadata重建保存；没有删改任何旧有效包。历史全量/shared失败未解决。本资格只覆盖观察到的完整home/原stdio/账本归档，原实体释放及W0–W5整体仍未完成。
