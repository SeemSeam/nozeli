# Windows alpha.6 工具处理持久记录

基线固定 merged PR27 `cb07c5180c85ca0e127ddc332089300498103cc5`。本批复用共享 PiSession 和本机 ProjectStorage SQLite CAS，在显式 Windows registered launch 中增加调用前 admitted 与处理函数返回后 handler-returned 两阶段记录，不复制 Controller／Work 状态机。生产默认 ManagedProjects 仍未选择该实验入口。

原工具帧绑定唯一 launch／owner／generation／host lease、原 prepared revision、session／request／job、reverse ID／call ID／turn ID、工具名与完整帧 SHA256。只有同一个活 registry 发出的原 prepared receipt 可登记；相同 reverse ID 在首次异步操作前同步占用，不因失败重试。处理函数调用前需确认 admitted 已落库且 owner／记录未变；返回后记录精确 JSON 回复与摘要并重新核验，之后才写入原 stdin。每个 registry／session 最多16384工具身份，单帧／回复1MiB，超限明确拒绝。

结果写入失败、SQLite 确认丢失、owner／工具行并发赢家或业务处理抛出 UNKNOWN 都阻断原 session，保留现场，不自动发送成功或重放。普通处理异常也保存精确 error，不能从异常推断业务回滚。重复帧不执行也不再次回复。非此显式 registered launch 的其他平台调用顺序保持原合同。

冷检查在原宿主退出、原 Job／完整 stdio 和原 journal 前缀核对后，从同一私有本机 SQLite 核对记录。toolCustodySchema=1 的 launch 缺少任何原始调用记录时明确拒绝，不把缺行解释成没有效果；原旧 launch 没有声明则仅报告 custody-unavailable。调用记录必须匹配原 prompt／job／session 和原始完整工具帧；handler-returned 若有 stdin 回复，必须与记录摘要逐字相符。单独持久记录仅证明宿主处理函数返回，不能证明业务副作用原子提交。

冷结果区分 handler-outcome-unknown、handler-returned-reply-unobserved 与 handler-returned-reply-observed；仍保留 unresolvedToolIds。显式 inspectJournals 检查点在 SQLite CAS 前后再次读取并核对工具记录；变化变为 UNKNOWN，保留外部赢家且不重复写检查点。查询先在同一 SQLite 读事务内计数／测量原 UTF8，再加载解析，最多16384行和16MiB，超限或损坏拒绝，不删历史。

实际 Worker 流程核对文档 read／apply／publish 三条记录：绑定原 job／session；apply callId 与现有 fileOperations 的 before/after／event 回执关联；publish callId 与原 receipt.id、返回的 object 与原 receipt.objectId 关联。审阅、Git 接受、归档和 warm reopen 后记录保持，Provider 三次请求，不重放。该正常链的关联不能代替业务 pending／projection／owner 冷接管证明。

businessEffectQualified、businessSettlementQualified、hostProjectionQualified、ownerReleaseQualified、coldRecoveryQualified、productionSelected 与 automaticReplay 全部仍为 false。没有推进自动派工／恢复开关。完整 W0–W5、旧历史全量失败及普通账户／安装更新回滚／签名发行保持未完成。

证据根 `C:\nozeli-test\20261110-alpha6-tool-custody`，独立合成项目、本地 HTTP Provider，无真实账号或付费模型。原生协议仍v8，filesystem/process 输入及以前实际构建字节核对；Pi src/dist/manifest 未改，renderer实际重建。最终计数和包摘要写入本批 qualification.json，完成后补充下表。

## 最终实际验证

| 范围 | 结果 |
| --- | --- |
| journal-node-release | 63通过／0失败 |
| journal-electron-release | 63通过／0失败 |
| journal-extracted-node | 63通过／0失败 |
| journal-extracted-electron | 63通过／0失败 |
| cold-node-final | 15通过／0失败 |
| cold-electron-final | 15通过／0失败 |
| cold-extracted-node | 15通过／0失败 |
| cold-extracted-electron | 15通过／0失败 |
| worker-node-release | 2通过／0失败 |
| worker-electron-release | 2通过／0失败 |
| worker-extracted-node | 2通过／0失败 |
| worker-extracted-electron | 2通过／0失败 |
| database-node-verified | 13通过／0失败 |
| database-electron-final | 13通过／0失败 |
| database-extracted-node | 13通过／0失败 |
| database-extracted-electron | 13通过／0失败 |
| gui-source | 6通过／0失败 |
| gui-extracted | 6通过／0失败 |

完整journal组每套63项，含51项实际Pi／原生监管／Controller与12项解析器。原工具效果各一次；结果提交但确认丢失、服务关闭、重复帧、普通错误与业务UNKNOWN、外部赢家、缺失记录及检查点后篡改均按实际合同保留，不重放。Worker新增断言最初将publish返回误作统一ok结构，2项失败保留；改核对saved／object及原receipt、fileOperations后完整两布局通过。

相邻共享组两宿主各67通过／8失败，上一批原包在相同宿主复现同8项；包含EBUSY、storage未知结果／close断言及PERSISTENCE_UNSUPPORTED。未修成全绿。旧unit813／8／1、safety12／25／16及integration766／1111／58本批未重跑。

ZIP `C:\nozeli-test\20261110-alpha6-tool-custody\desktop-package-verified\Nozeli-windows-alpha6-tool-custody-qualification.zip`；SHA256 `b5cb7916145c7b49bce2f2dccc942c3542fe54e4e4f332bc1141cdc40fa9f9fa`；43619文件、1412808900展开字节、1704冻结文件。CRC、中文空格路径独立解压、逐文件摘要、当前native／Pi／runtime及运行后完整性通过；JS1245通过。首候选因最终服务关闭修正与源码不一致，hash检查准确拒绝，该候选与失败收据保留；只交付verified包。没有安装、签名、发布、commit或push。
