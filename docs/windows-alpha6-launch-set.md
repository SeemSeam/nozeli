# Windows alpha.6 原生项目宿主启动集合

基线固定 merged PR27 `cb07c5180c85ca0e127ddc332089300498103cc5`。本批推进 W2 冷恢复前置：原项目 host lease 的历史启动集合由原生匿名 mapping 保留，SQLite owner 行不再是唯一枚举来源。默认托管任务入口、journal／pending／tools／projection 协调和业务接管仍未完成。

每次 registry.begin 在首次 await 和 SQLite intent 之前，先追加 UUID。原生集合单写者为原宿主，无删除／替换 API，重复 UUID 和第257次启动在进程分配前拒绝。原生 claim 为带类型标记的原对象；StartSupervisor 消耗一次并绑定实际 Job leader 与 helper 的 PID／创建时间。JS registry 同时核对原 intent 的 launchId，不能交叉登记同宿主的另一个 supervisor。

supervisor 仅继承 FILE_MAP_READ，inspect 仅向精确内核 pipe peer 复制只读 mapping HANDLE。数值 HANDLE 不进入 JS 或持久记录。新观察者等待原宿主 PROCESS HANDLE 退出后才读取集合；原宿主中断写入、未准备 intent 或无法读取均保持未确认。nonce、leaseId、源摘要、宿主 PID／创建时间和集合中每个 Job／helper incarnation 必须与原实体、完整当前 owner 行和完整 stdio 证据一致。不能从一条存活记录推断被删除的行从未存在。

冷检查点仍复用 ProjectStorage 的原生来源、实际 SQLite revision／CAS 和提交后 UNKNOWN；关闭 inspection 只关闭观察者，不关闭原监管。全部原生历史和 Job／流证据一致时可确认该原项目 host lease 的 launchSetCompletenessVerified 与 processQuiescenceVerified；这不证明同一桌面进程中的其他项目，也不证明任务或工具业务结果。ownerReleaseQualified、coldRecoveryQualified 与 productionSelected 持续为 false，不回放、不清理 home 或退休 owner。包含既往 retired 行／已关闭 helper、无 helper 的空宿主以及256条历史用尽后的冷恢复暂不支持；正常 warm release 仍依赖原保留回执。

本批证据根 `D:\nozeli-test\20261110-alpha6-launch-set`。测试使用独立合成项目及本地 Provider，无真实／付费模型或日常数据。实际构建、最终测试和 ZIP 结果在本批完成后追加；原全量 unit／safety／integration 失败不由定向验证消除。

## 最终实际结果与验证包

总收据 `D:\nozeli-test\20261110-alpha6-launch-set\qualification.json`。以下是本批实际执行结果，全部0 fail／0 skip／0 cancelled；不代表全量套件通过。

| 范围 | 结果 |
| --- | --- |
| cold-node-final | 15/15 |
| cold-electron-final | 15/15 |
| cold-extracted-node | 15/15 |
| cold-extracted-electron | 15/15 |
| process-node-initial | 109/109 |
| process-electron | 109/109 |
| process-extracted-node | 109/109 |
| process-extracted-electron | 109/109 |
| host-node-final | 60/60 |
| host-electron-final | 60/60 |
| host-extracted-node | 60/60 |
| host-extracted-electron | 60/60 |
| worker-node-final | 2/2 |
| worker-electron-final | 2/2 |
| worker-extracted-node | 2/2 |
| worker-extracted-electron | 2/2 |
| gui-source | 6/6 |
| gui-extracted | 6/6 |

另有 roots-node 广泛目录／Work 回归 103 项通过；JS语法 1241 文件通过。process addon／helper／fixture及renderer本批实际重建，文件系统addon沿用未变输入对应实编字节；依赖／Pi／PPTist闭包逐摘要核对，本批未干净npm ci。

ZIP `D:\nozeli-test\20261110-alpha6-launch-set\desktop-package\Nozeli-windows-alpha6-launch-set-qualification.zip`，SHA256 `3a5ee183deeb026ceaa5903974182db1397d74133f098cdfead84599f8752d2d`；43615 文件、1412757502 展开字节、1700 冻结源码／dist／tests／tools。CRC、中文空格路径独立解压、全部文件及原生输入／二进制／Pi manifest、仅System32 PATH的包内运行时解析均通过，旧包独立保留。

Worker使用真实Controller／Pi SDK／Git和本地合成HTTP Provider，单根及真实桌面分离目录的修改／明确接受／归档／warm reopen均通过；无真实或付费模型。GUI各6项为可见shell和真实IPC登记／读写CAS／冲突／草稿重启恢复，不代签文档显示、物理Explorer／IME／多屏。

完整unit／safety／integration未重跑，历史失败继续保留。仅原项目host lease启动集合及进程／流停稳有新证据，owner／业务冷接管与默认派工未开放。产物含合成资格harness，尚非安装器；未安装／签名／发布／commit／push。
