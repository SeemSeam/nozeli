# Windows alpha.6 原 host/owner 记录冷退休

固定已合并 PR27 `cb07c5180c85ca0e127ddc332089300498103cc5`，继续完整 W0–W5。此前已核对原 host 的完整 launch-set、原 Job/stdio/source/journal/tool/business 证据，提交 interrupted business hold，并通过 native 单向仲裁领取原 anchor。此批增加原 host 与完整 owner 记录的一次原子退休和代次历史保留。它只改变经过核验的本机登记记录；尚未释放旧资源、签发下一代 host 或开放默认 ManagedProjects。

## 同一事务与单调修订

`storage-worker.mjs` 新增 `compareAndPut`，复用已有 operation receipt、fingerprint、SQLite `BEGIN IMMEDIATE`、native database lease 和 UNKNOWN 机制。调用者必须提交所有比较集合的完整成员、值和 revision，每条写入必须属于比较集合且使用其原 expectedRevision。一次事务可以修改 host/owner 并新增历史，比较集合中未写入的工具、检查点和既有历史保持原值与修订号。已有行修订号增加 1，新增行从 1 开始，无删除与 revision 重置。

输入限制为 8 个集合、256 条写入、16,384 条比较记录和 32 MiB 聚合预算；读取实际值前先以 SQL 检查行数与 UTF-8 字节数。重复写入、未比较集合、缺 revision 和不匹配 revision 原子拒绝。原 operationId 的相同请求返回原 durable receipt；绑定不同请求则拒绝，不重复执行。

## 原 inspection 的退休入口

`retireWindowsManagedColdOwners(inspection, {storage, projectId})` 只接受 WeakMap 保留的原对象与精确 storage/project，不接受摘要副本、重建对象、已关闭或已 fenced inspection。同一对象并发调用共享一个 flight。入口先完成原 business hold 与 native anchor claim，再复核完整原证据。

本机事务比较五个完整集合：`managed_host_leases`、`managed_owner_launches`、`managed_cold_checkpoints`、`managed_owner_tools`、`managed_cold_retirements`。必须仍为精确原 host 行与完整原 owner 集合，历史 ID 使用原 hostLeaseId 且必须不存在。host 与每个 owner 转为 retired，修订号逐行增加 1；历史保留原 host/owner、退休后预期行、原 checkpoint 摘要、原证据摘要、hold operation、原 anchor File ID 和事务身份。

原不可变 summary 与 active/prepared 证据保持原样，另存当前 expected ledger。退休后的 journal 检查只能通过原 inspection 的内部读入口使用原登记基准，该入口还要求精确原 supervisor 包装对象，并先复核真实 retired ledger、全部历史/工具/检查点集合和 operation receipt。任意另一条真实连接也不能借同一 endpoint 取代原包装对象。没有调用者传入“旧行”的覆盖接口，也不把任意 retired 行视为可信历史。

事务提交后再次核对原 kernel/source/journal/tool/business/pending、当前 ledger、完整比较集合和 receipt。提交前的并发赢家使整个退休事务拒绝；提交后变化或实际 SQL COMMIT 后回复丢失返回 `STORAGE_RESULT_UNKNOWN`，保留原 pins/helper，不重试、不把事务描述为已回滚。原 journal 的旧 ownerRevision 继续绑定原证据，不能改写为退休后的修订号。

正常结果仅声明 `hostRetired`、`ownersRetired` 和 `businessHoldCommitted`。`nextHostActivated`、`ownerReleaseQualified`、`coldRecoveryQualified`、`productionSelected`、`executionAcknowledged`、`pendingReconciled` 和 `automaticReplay` 保持 false。Worker 继续 interrupted 且需要显式输入；候选、review、未发送草稿和原业务效果保留，原工具回复仍未决。

## 下一代接续的实施依赖

1. 原生 custody 构造器当前只接受 writable `PrivateTreeFile`。需为受限原 cold anchor 定义跨 addon 的精确原生类型与验证路径，以原 File ID、ACL、父目录和 metadata 绑定构造新 supervisor 的 custody。不得通过数值 HANDLE、关闭后重开路径或放宽 writable 校验接续。
2. 原 inspection 在核对 retired ledger/history、business hold 和 pending 后签发一次性的 opaque cold handoff。消费必须直接转移保留的原 pin；失败或丢回复进入 UNKNOWN，不能再次签发。现有 warm `previousRelease` 与 exit proof 条件保持精确，不将 cold 摘要当作 warm proof。
3. 新 host 与 registry 只从该保留的可信退休代次初始化 expected revisions，开始新 owner 前保存完整旧 generation 历史，再 CAS 替换 target 槽位。新一轮 cold inspection 要核对当前 host 的 launch-set 与已验证旧代次，不得简单过滤 retired 行来凑齐集合。
4. 用真实新 Controller 验证只有一个竞争接管者成功、paused/review 保持、旧输入零重放、旧回复不被补确认，随后再次退出并验证第二轮 cold 历史。完成后才评估默认入口。

显式 pending 协调、派工前路径资格、初始化/重置、权限隔离、终端/TeX/回收站、普通账户与物理桌面、安装/更新/回滚/签名仍是 W0–W5 未完成项。

## 本批验证范围

证据目录 `C:\nozeli-test\20261110-alpha6-cold-retirement`；最终完成矩阵与 ZIP 以该目录的 `qualification.json` 为准。原生组件与 Pi 输入沿用上一批实际构建对应的未变字节并逐摘要核对，本批只实际重建 renderer。此前有效包和原 Windows checkout 保留。

11 种真实 Controller/Pi/Git 退休场景包括正常提交、提交前 owner/tool 同值修订赢家、提交后 owner/business/pending/checkpoint/history/tool/host 集合赢家，以及真实提交后回复丢失。相邻 hold/anchor、冷检查点、原 journal/Pi、共享恢复和独立解压包构成针对改动的回归范围；完整 unit/safety/integration 的历史失败不会被这些定向结果覆盖。

首轮正常退休在真实 COMMIT 后因预期对象字段顺序不同被保守判 UNKNOWN，已修正预期记录为 SQLite 实际读取结构并保留原失败收据。一次 runner 模式误含 `prior`，在载入 fixture 前选中不含该测试的旧路径；该次未执行产品测试，改用 `adjacent` 模式，单独保留 runner 错误记录。

## 最终实际验证

| 范围 | 结果 |
| --- | --- |
| business-retire-all-node-current | 11 通过／0 失败 |
| business-retire-three-electron-current | 3 通过／0 失败 |
| business-retire-all-extracted-node-current | 11 通过／0 失败 |
| business-retire-three-extracted-electron-current | 3 通过／0 失败 |
| business-adjacent-hold-node-current | 8 通过／0 失败 |
| business-adjacent-hold-extracted-node-current | 8 通过／0 失败 |
| cold-node-current | 20 通过／0 失败 |
| cold-electron-current | 20 通过／0 失败 |
| cold-extracted-node-current | 20 通过／0 失败 |
| cold-extracted-electron-current | 20 通过／0 失败 |
| recovery-node-initial | 43 通过／0 失败 |
| recovery-electron-current | 43 通过／0 失败 |
| recovery-extracted-node-current | 43 通过／0 失败 |
| recovery-extracted-electron-current | 43 通过／0 失败 |
| journal-node-current | 63 通过／0 失败 |
| journal-extracted-node-current | 63 通过／0 失败 |
| worker-node-current | 2 通过／0 失败 |
| worker-extracted-node-current | 2 通过／0 失败 |
| gui-source-current | 6 通过／0 失败 |
| gui-extracted-current | 6 通过／0 失败 |

共 426 次测试执行与 12 项 GUI 检查；JS 1249 文件通过。完整 business27、原生 process 全矩阵与完整 unit/safety/integration 本批未重跑，历史全量及 shared 失败保留。首轮正常退休修复后的单独 1/1 为补充证据，不重复计入矩阵。

ZIP `C:\nozeli-test\20261110-alpha6-cold-retirement\desktop-package-verified\Nozeli-windows-alpha6-cold-retirement-qualification.zip`；SHA256 `dbd272fbfa665f2eba3f521b82c1fdf3da1ba99defe51a86cb39ea34d7439c16`；43623 文件／1412907983 展开字节／1708 冻结文件。CRC、独立解压、当前源码/native/Pi、System32-only PATH 与运行后完整性通过。
