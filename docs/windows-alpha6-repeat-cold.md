# Windows alpha.6 第二轮冷接管

本轮沿用alpha.6＋已合并PR27 `cb07c5180c85ca0e127ddc332089300498103cc5`。远端beta.1增量尚未合入，审查见 [上游增量](windows-upstream-main-review.md)。W0–W5整体仍在进行。

`cold-generation-history.mjs` 将当前host的精确coldPredecessor逐代解析为完整原host／owner登记集，复核create-only历史修订、原检查点及摘要、原业务hold、退休与后继激活回执。各代原生helper仍须分别证明原完整launch-set、精确进程实例、Job停稳、完整stdin／stdout／stderr及source custody；历史数据库记录不能独立授权接管。当前旧retired行必须与原历史的完整行值及revision一致，不能过滤后忽略。最多16代、32个原生owner、16MiB有界历史，超过预算拒绝。

新的inspection保留当前代与历史各代完整原实体，核对各代原journal／原工具处理记录／业务回执。内部journal读使用仅模块持有的opaque scope，并由完整ledger核验包围；对外的原inspection读入口仍执行ledger核验。旧Worker只有精确匹配原hold的checkpoint／operation／host／evidence绑定，且仍interrupted、需显式输入时才视为继承的暂停；不改写该旧hold。新代没有待持久hold的turn时，以比较全部业务集合的无业务行写入事务保存本次核验回执。

本次退休只递增当前代prepared owner，旧代retired carryover行完全保留；同一事务比较整个当前host／owner／checkpoint／tool／history集合并追加本代历史。下一次opaque handoff继续一次性消费，实际anchor从当前代原helper领取。原生协议及native二进制未变，必须逐摘要核对v47实际构建结果。

新回归由外层进程启动原宿主，实际Pi执行read／apply／publish后停在未回复屏障并终止；独立adopter自行打开inspection、消费同进程opaque token并启动两个新resident；外层再次终止adopter后，第三Controller接管。token从不跨进程序列化。原provider请求数保持3，原项目文本未被接受覆盖，暂停Worker／候选／未发送草稿保留。正常路径还验证竞争只一赢家、第三Controller启动两个resident及实际warm停止。

当前测试包含正常、历史缺失、历史同值修订赢家、旧Worker同值修订赢家、当前owner删除、inspection后历史变化、第二次退休实际COMMIT后丢回复、第三host激活后pending变化。源码修正前已真实复现第二次退出时被旧retired owner阻挡；首次新实现漏改一处宿主代次比较，修正后又暴露fixture把原暂停态错误写成review，均保留原失败收据。后者改为验证真实paused和原候选保持，没有改变业务状态满足断言。

证据目录为 `C:\nozeli-test\20261110-alpha6-repeat-cold`。最终资格以该目录qualification／package／integrity收据为准，完成前不宣称本轮已通过。suite入口：在apps/desktop用锁定Node运行 `node tools/test-suites.mjs windows-managed-repeat-cold`。

当前仍未资格化：旧owner资源释放、完整pending协调、含已完成warm退休或无保留helper的历史代次、超过预算的历史、resident未完成业务turn、默认ManagedProjects、派工前路径资格、初始化／重置、OS隔离、终端／TeX／回收站、普通账户／物理桌面与安装／更新／回滚／签名。任一必要原helper丢失时拒绝，不从PID缺失、数据库状态或已存在anchor文件推断可安全接管。此流程不确认旧工具回复、不完成旧turn、不自动重放。

## 最终实际验证

| 实际运行 | 通过数 |
| --- | --- |
| repeat-all-node-current | 8 |
| repeat-selected-electron-current | 3 |
| repeat-all-extracted-node-current | 8 |
| repeat-selected-extracted-electron-current | 3 |
| cold-node-initial | 21 |
| cold-electron-current | 21 |
| cold-extracted-node-current | 21 |
| cold-extracted-electron-current | 21 |
| recovery-node-current | 43 |
| recovery-electron-current | 43 |
| recovery-extracted-node-current | 43 |
| recovery-extracted-electron-current | 43 |
| host-node-current | 60 |
| host-extracted-node-current | 60 |
| journal-node-current | 63 |
| journal-extracted-node-current | 63 |
| worker-node-current | 2 |
| worker-extracted-node-current | 2 |
| business-transfer-node-current | 5 |
| business-transfer-extracted-node-current | 5 |
| gui-source-current | 6 |
| gui-extracted-current | 6 |

538次测试执行及12项GUI检查通过，JS 1253文件。Source and independent extracted Node each eight real two-death modes; Electron each three key modes. Adjacent cold 21 and recovery 43 on four hosts; host 60, journal/Pi 63, ordinary Worker two layouts and single cold handoff five modes on source/extracted Node. Source cold-node-initial predates the final per-generation lease comparison correction, whose first-generation comparison is identical. All extracted matrices use exact frozen final source. Native process matrix retained from v47 with byte-identical inputs/binaries; not rerun. Full business32/unit/safety/integration/shared not rerun or claimed resolved.

ZIP `C:\nozeli-test\20261110-alpha6-repeat-cold\desktop-package-verified\Nozeli-windows-alpha6-repeat-cold-qualification.zip`；SHA256 `cfb3d9854188dcb4b2bcd7aa8daac517b9c02845e6a771ab6d508b704a55dc15`；43627文件、1412961661展开字节、1712冻结文件。renderer实际构建；native/Pi未重编，核对v47实编字节。独立解压后解除临时staging精确依赖硬链接，staging不再完整，所有包测试使用独立解压目录。

资格仅覆盖两次真实宿主退出和第三Controller常驻角色启动；新repeat fixture实测paused/候选保持，没有声称实测review态。普通Worker流程另有真实review/accept回归。历史全量/shared失败和v47首次Electron IPC UNKNOWN保留，未宣称根因修复。下一步门见[冷owner资源处置计划](windows-alpha6-cold-owner-disposal-plan.md)。W0–W5整体仍未完成。
