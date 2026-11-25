# Windows alpha.6 原业务回执冷核对

基线固定 merged PR27 `cb07c5180c85ca0e127ddc332089300498103cc5`，继续完整 W0–W5 计划。本批显式 `inspectBusinessReceipts:true` 必须与 `inspectJournals:true` 配合，默认 ManagedProjects 入口仍未启用。工具回复与业务结算保持分开。

真实共享 Controller／Pi／Git 在独立 Worker 目录读取和修改合成文档、持久发布候选后，测试暂停原 stdin 的成功回复并终止原宿主。保留全部三个原 owner supervisor；完整 Job／EOF／原始 journal 前缀和 handler custody 核验后，再核对原 job/work revision、文档 fileOperations／job.documentOperations、发布 receipt／原参数摘要／candidate、message／todo／work投影、冻结 manifest 和项目不可变对象。Worker 启动 cwd 从已登记桌面本机目录精确推导，避免误当项目根目录；仍与原请求及原返回逐项匹配。

本机 publication prepared 恢复记录必须与原项目 receipt 完全关联；单独核对 bounded pending page/version 并保留待协调数，不调用 generic reconcile，不打开新 Controller，不提升对象。六个业务集合合计最多16384行／16MiB，pending最多200条／1MiB，单publication恢复记录1MiB，对象验证合计256MiB，冻结manifest读取16MiB。超限明确拒绝，保留数据。

inspection 与 checkpoint 提交前后均重新核对这些观察。缺行、回执／投影变化、对象损坏或prepared恢复记录赢家必须拒绝；提交后的变化返回UNKNOWN，禁止第二次写入；新pending使旧inspection失效，新inspection只观察、不合并。未送达工具回复继续未决，即使业务receipt已经匹配，也不能冒充Worker已经收到结果。

`businessEffectQualified`、`businessSettlementQualified`、`hostProjectionQualified`、`ownerReleaseQualified`、`coldRecoveryQualified`、`productionSelected`、`automaticReplay`仍为false。尚未实现业务冷接管、pending合并、owner退休／下一代接续。匹配业务行不证明宿主投影完整、文档当前磁盘内容或后续修订可接续。普通账户、默认入口、权限／终端／TeX、安装更新回滚及签名发行保持未完成。

证据根 `C:\nozeli-test\20261110-alpha6-business-receipts`。使用隔离合成项目和本机脚本Provider，无真实账号／付费模型。renderer实际重建；Pi/native输入未变，复核此前实际构建字节，不声明本批重编。GitHub本批两次连接失败，不声称已经确认新的远端版本。

首轮fixture会话构造错误与后续Worker cwd产品缺口、扩展测试语法错误、并发重负载下45秒fixture等待超时均保留原收据。fixture等待改为120秒，外层150秒，不修改产品RPC超时。最终源码／独立解压验证和包摘要在qualification.json中记录。

## 最终实际验证

| 范围 | 结果 |
| --- | --- |
| business-node-verified | 8通过／0失败 |
| business-electron-final | 8通过／0失败 |
| business-extracted-node | 8通过／0失败 |
| business-extracted-electron | 8通过／0失败 |
| journal-node-final | 63通过／0失败 |
| journal-electron-final | 63通过／0失败 |
| journal-extracted-node | 63通过／0失败 |
| journal-extracted-electron | 63通过／0失败 |
| cold-node-final | 15通过／0失败 |
| cold-electron-final | 15通过／0失败 |
| cold-extracted-node | 15通过／0失败 |
| cold-extracted-electron | 15通过／0失败 |
| worker-node-final | 2通过／0失败 |
| worker-electron-final | 2通过／0失败 |
| worker-extracted-node | 2通过／0失败 |
| worker-extracted-electron | 2通过／0失败 |
| database-node-final | 13通过／0失败 |
| database-electron-final | 13通过／0失败 |
| database-extracted-node | 13通过／0失败 |
| database-extracted-electron | 13通过／0失败 |
| gui-source | 6通过／0失败 |
| gui-extracted | 6通过／0失败 |

ZIP `C:\nozeli-test\20261110-alpha6-business-receipts\desktop-package-verified\Nozeli-windows-alpha6-business-receipts-qualification.zip`；SHA256 `8b398a40b6017144859e5ff186bf2c6fdc583beb5d35799853c98e8ce93d3507`；43622文件，1412835401展开字节，1707冻结文件。CRC、中文空格路径独立解压、当前源码／Pi／native、System32-only PATH及运行后完整性核验通过。

原五场景Node首次完整通过后，扩展pending回归并行造成fixture等待超时；fixture等待提高、最终串行验证。失败清理最初仅在正常连接循环后收集supervisor，导致失败残留；修正为每个合成profile原登记endpoint清理。一次按本批时间和镜像清理残留时也终止正在冷检查的helper，首business-node-final故而拒绝SUPERVISOR_IDENTITY_UNVERIFIED；保留失败，停止该批量清理后新完整矩阵验证。首候选因测试清理最终修正与冻结hash不一致被准确拒绝，原候选保留，verified包单独重建。

相邻shared沿用前批Node／Electron各67通过8失败、旧包同8项复现；历史unit813／8／1、safety12／25／16、integration766／1111／58，本批未重跑。完整业务冷接管及Windows产品未完成。
