# Windows alpha.6 异常退出业务待核对处置

固定 merged PR27 `cb07c5180c85ca0e127ddc332089300498103cc5`，继续 W0–W5。原生 host／完整 launch set／Job／原 stdio／journal 前缀／handler custody／业务回执检查通过后，显式 `holdWindowsManagedColdBusiness` 可把精确原 Worker job 原子写成 interrupted，并持久标记 job/work 需要显式核对。running work 转 paused；review 保留 review 和原候选。此入口尚未接入默认 ManagedProjects。

前置检查点保留原始观察、完整 owner 注册和原 kernel 来源。项目事务只写 jobs/works，以六个原业务集合及原行修订号为比较条件；fileOperations、receipts、messages、todos 只比较，不重写。事务操作收据与业务行同提交，job 的 restartRecovery 绑定 checkpoint、operationId、原 host lease 和原始证据摘要。复用共享 `holdInterruptedExecution` 状态迁移，不重新解释成果完成与审阅状态。

只支持有原 handler 返回、效果工具业务回执完整、无待协调 pending、单一精确未完成 Worker turn 的情况。resident turn、重复 turn、未知效果工具、待协调 pending、缺失或超限证据明确拒绝；不调用通用 pending 合并，不提升对象。项目与 recovery 数据库没有跨库事务；前后观察变化会阻断或返回 UNKNOWN，不能宣称跨库原子协调。

项目提交前另有赢家时，整个业务处置不写入；同值但修订号不同也拒绝。提交后 job／业务／pending／owner／来源观察变化保留 `STORAGE_RESULT_UNKNOWN`，同一 inspection 的重复调用共用原 flight，不再次提交。原未送达工具回复仍未决，不标记 Worker 已收到回复或原回合已完成。原 owner、home、supervisor 和候选保持保留。

共享重启恢复、Controller pump、runJob 准入、Work 激活以及启动扫描都尊重 `recoveryRequiresExplicitInput`。同 target 后续输入、绑定 Work 的主控输入和新 Work 激活不能绕过恢复门。普通发送、手工恢复暂停不解除旧效果核对门；完整显式核对／owner 退休／下一代接续仍待实现。

真实 fixture 使用共享 Controller／Pi／Git，在修改执行目录文档并发布候选后截住原 stdin 回复，再杀原 host。测试核对正常处置、提交前赢家、提交后赢家、提交时 pending 赢家；完整旧观察测试继续检查缺失回执、publication 恢复记录变化、对象损坏和 checkpoint 后赢家。每个场景使用本地脚本 Provider，3 次请求后不再调用模型，原项目文档保持 baseline，未发送草稿和四个业务见证集合逐行保留。正常处置后通过真实存储重新读取状态，再验证共享重启不能续跑；尚未证明新 Controller 可以冷接管旧 owner。

本批证据目录 `C:\nozeli-test\20261110-alpha6-business-hold`。最终矩阵、包和摘要以该目录 `qualification.json` 为准；未结束的进程不计通过。初轮 fixture 存储接口缺失、增强扫描回归失败与修正原始收据保留；最初 4 场景收据误写前批 evidence 后已复制到本批 `retained-initial-*`，旧有效包未改动。本批没有修改构建依赖／native／Pi 输入，renderer 实际重建；native/Pi 与此前实际构建字节逐摘要核对，不声称重编。

已查询 GitHub 近期 PR 列表并复核 alpha.6 标签和 PR27 head；PR27 已合并，列表里的依赖升级仍开放。latest release 接口返回 404，单独 main 引用查询可能受网络影响，原始成功／失败记录都保留，不把开放 PR 计成已合并基线。

`executionAcknowledged`、`pendingReconciled`、`ownerReleaseQualified`、`coldRecoveryQualified`、`productionSelected` 和 `automaticReplay` 为 false。此次只取得中断业务待核对处置的限定证据；Windows 完整落地、默认派工、完整冷恢复、路径资格、初始化／重置、权限／隔离、终端／TeX／回收站、普通账户／物理桌面以及安装更新回滚／签名发行仍未完成。历史全量与 shared 失败保持未解决，不外推本批定向通过。

## 下一批 owner 冷退休的实施边界

当前同宿主 `retainExperimentalOwnerExitProof` 绑定原 transport，registry 的 `retire` 只接受本 registry 发出的 prepared receipt；cold checkpoint 不能伪装这两种对象。host lease 的 `previousRelease` 也只接受同进程 WeakMap 内原 release receipt。下一批需要独立的 cold 事务接口，不放宽上述 warm 合同。

实施顺序为：在本批业务 hold 后继续保留原 complete launch-set 和所有 supervisor／来源 pin；取得 managed-host anchor 的写入排他权并核对原 File ID，确认期间不能建立新代 host；把精确原 owner 与原 host lease 在本机数据库同一事务内标记冷退休，CAS 包含原 host、完整 owner 集合、本批 checkpoint 和业务 hold 绑定；提交前／后核对原 kernel、journal、local tool custody、项目 hold 与 pending 页。任何提交后不确定都保留 UNKNOWN，不释放旧证据，也不签发新代授权。

只有完成后检查的原 opaque cold release receipt 才可一次性交给新的 host lease；新 host 来源和原退休版本必须完全一致，重新建立 native launch-set。旧 launch/history/工具回执保留，新一代注册用原退休 revision CAS，历史不能被删除后按 PID 重建。暂停任务仍等待显式业务核对，不把新 host 存在等同于重新发送旧输入。

该阶段必须以实际冷进程重启而非仅 `readManagedState` 验收：新代创建和原输入不重放、两竞争宿主只允许一个赢家、缺 owner 行／未完成 launch intent 拒绝、原 anchor／database／journal 替换拒绝、业务／pending／checkpoint 的提交前后赢家与 UNKNOWN、旧 receipt 第二次使用拒绝。完成这些前不接入默认 ManagedProjects，不把本节计划计为已实现。

## 最终实际验证

| 范围 | 结果 |
| --- | --- |
| business-node-final | 12通过／0失败 |
| business-hold-node-verified | 5通过／0失败 |
| business-hold-electron-final | 5通过／0失败 |
| business-extracted-node | 13通过／0失败 |
| business-hold-extracted-electron | 5通过／0失败 |
| recovery-node-package | 39通过／0失败 |
| recovery-electron-final | 39通过／0失败 |
| recovery-extracted-node | 39通过／0失败 |
| recovery-extracted-electron | 39通过／0失败 |
| journal-node-final | 63通过／0失败 |
| journal-extracted-node | 63通过／0失败 |
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

源码完整业务首轮加载12场景，checkpoint修订加固后的5个hold场景另在Node／Electron实跑；解压Node完整13场景，解压Electron5个hold。journal/Pi本批仅Node源码／解压各63项，Electron沿用历史。本批没有完整unit／safety／integration重跑，历史失败及相邻shared各67通过8失败仍未解决。

ZIP `C:\nozeli-test\20261110-alpha6-business-hold\desktop-package-verified\Nozeli-windows-alpha6-business-hold-qualification.zip`；SHA256 `0b4d7f902d6529acbf83cc66717b40d81e5e30e357cf47b42ee50fa330c9e0e8`；43623文件／1412854814展开字节／1708冻结文件。CRC、独立解压、当前源码／Pi／native、System32-only PATH和运行后完整性通过。
