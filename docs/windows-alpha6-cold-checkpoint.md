# Windows alpha.6 原生冷恢复前置（2026-11-09）

后续原生项目host启动集合与当前包见[最新记录](windows-alpha6-launch-set.md)；下文保留原批次事实和当时限制。

基线固定 merged PR27 `cb07c5180c85ca0e127ddc332089300498103cc5`；W0–W5 完整目标保留。本批继续处理默认托管任务入口的冷恢复依赖，尚未开放默认 ManagedProjects 或宿主接管。

## 实际缺口与修复

新冷连接原来只能从仍存活的 Job 成员取得 HANDLE。即使旧宿主中某个观察者已持有后代 HANDLE，新的观察者也得不到已经退出的成员，因此 Job 为空但完整 incarnation 未证明。新检查点首轮 Electron 9/9，而独立 Node 3/9、6 项 `MANAGED_COLD_STOP_UNCONFIRMED`；失败时实际快照为 totalProcesses=2、observedMembers=0。失败 TAP 和诊断保留，没有把条件放宽成只看 Job 空或 PID 消失。

将已有 `ObserveJobMembers` 的有界身份算法抽到 `process-members.h` 供 addon 和 helper 共用。helper 在宿主仍运行时持续保留查询／等待权限的后代 HANDLE，宿主退出后继续持有原实体；protocol 升到 v7，在精确内核 pipe peer、同用户和原 helper/image/Job 校验下向新观察者复制查询／等待权限。新观察者复核成员身份、Job、不可继承与重复项，按原总进程计数及每个 HANDLE 的退出事实作结论。数值 HANDLE 仅出现在有界本机 IPC，不进入 JS 或持久数据。发现未观察成员或查询错误仍拒绝资格。

本批实际重编 Windows process addon、supervisor 和合成 fixture；文件系统 addon 沿用未变输入对应的前次实编二进制。旧包独立保留，不覆盖其运行时。新版 helper 与旧版协议不混用，不因构建失败回退。

## 已登记 Job 检查点

新增 `openWindowsManagedColdInspection`，保持原 ProjectStorage、instance、local SQLite、catalog／project SQLite／manifest 的原生实体和实际记录 revision，核对当前 owner 行的完整集合及每条原 supervisor。只有旧宿主已退出、每个原 Job 为空且 incarnation 完整、stdout／stderr EOF、输入关闭且完成字节数一致、没有流错误时，才逐范围读取原输入和输出，核对总长度及 SHA256。最多 32 个登记 owner、合计 256 MiB，超界明确拒绝。

`commitWindowsManagedColdCheckpoint` 仅接受本模块签发且绑定原 storage／project 的保留对象，复用实际 SQLite `expectedRevision:0` 写入本机 `managed_cold_checkpoints`。前后检查登记来源、完整当前 owner 集合与实际检查点记录；提交后失去确认保留 UNKNOWN，禁止重写或重放。关闭检查只关闭自身观察连接，不 shutdown 原 helper，原输入输出、来源 custody、owner/home、草稿、pending、工具未知结果和业务账本继续保留。

这不是整宿主接管凭证。可变 SQLite 行不能证明历史上没有被删除的 launch；删除一条 owner 行的真实回归明确保持 `launchSetCompletenessVerified=false`、`processQuiescenceVerified=false`、`ownerReleaseQualified=false`、`coldRecoveryQualified=false`。当前已登记 Job 的事实单列为 `registeredJobQuiescenceVerified=true`。输入到达子进程也不等于任务已经执行确认。后续必须有原生完整启动集合屏障，再协调 journal／pending／tools／projection，才能安全开放默认入口。

## 回归与证据

命名套件 `node tools/test-suites.mjs windows-managed-cold-checkpoint`。新文件 11 项真实 Windows 测试覆盖正常／强制旧宿主退出、多 owner 原流摘要、先退出真实后代再建立全新连接、旧宿主存活、stdio 缺失、未完成 intent、owner 行事前删除、owner／catalog revision 赢家、真实 checkpoint 提交后并发 winner 的 UNKNOWN，以及克隆／序列化／异存储对象和关闭后的拒绝。全部使用独立合成项目和 profile，不调用真实模型或账号。

证据根 `D:\nozeli-test\20261109-alpha6-cold-checkpoint`。扩大后的原生进程回归发现旧“一个短命子进程必漏观察”的 fixture 假设失效，64 个短命 native burst 也被 helper 观察齐全。最终 harness 用真实、受控的 helper 暂停窗口制造确定的观察缺口：每次操作前核对原 supervisor 的完整 image 路径、创建时间及仍运行的 HANDLE，在 finally 中恢复；只作用于本项合成 helper，不新增产品旁路、不修改系统策略。原来的 `allProcessIncarnationsObserved=false` 断言保留；已退出、已观察真实后代的独立正例验证新传递路径。Windows PowerShell 5 不识别 ulong alias 的中间 harness 失败与修正为 uint64 后的结果也保留。实际最终源码／解压包结果和当前产物在完成后追加。

## 仍须完成

整宿主启动集合证明、pending／tools／projection／owner 冷协调、默认入口与派工前路径资格检查、初始化／永久重置、剩余终端／TeX／回收站消费者、物理桌面、干净普通账号和安装／升级／签名发行均未完成。前批完整 unit／safety／integration 的历史失败不由本批定向结果消除。

## 最终实际结果与验证包

总收据 `D:\nozeli-test\20261109-alpha6-cold-checkpoint\qualification.json`；本批针对实际 Windows x64 源码与独立新解压包运行，不代表全量 unit／safety／integration 通过。

| 范围 | 结果 |
| --- | --- |
| cold-node-verified | 11/11 pass；0 fail、0 skip、0 cancelled |
| cold-electron-verified | 11/11 pass；0 fail、0 skip、0 cancelled |
| cold-extracted-node | 11/11 pass；0 fail、0 skip、0 cancelled |
| cold-extracted-electron | 11/11 pass；0 fail、0 skip、0 cancelled |
| process-node-verified | 109/109 pass；0 fail、0 skip、0 cancelled |
| process-electron-verified | 109/109 pass；0 fail、0 skip、0 cancelled |
| process-extracted-node | 109/109 pass；0 fail、0 skip、0 cancelled |
| process-extracted-electron | 109/109 pass；0 fail、0 skip、0 cancelled |
| worker-node | 2/2 pass；0 fail、0 skip、0 cancelled |
| worker-electron | 2/2 pass；0 fail、0 skip、0 cancelled |
| worker-extracted-node | 2/2 pass；0 fail、0 skip、0 cancelled |
| worker-extracted-electron | 2/2 pass；0 fail、0 skip、0 cancelled |
| gui-source | 6/6 pass；0 fail、0 skip、0 cancelled |
| gui-extracted | 6/6 pass；0 fail、0 skip、0 cancelled |

JS 语法 1240 文件通过。renderer 本批实际重建；process addon／helper／fixture 本批实际重编，文件系统 addon 输入及前次实编字节核对一致。本批未重新 npm ci，未变依赖／Pi／PPTist 使用逐摘要验证的独立副本。

验证 ZIP `D:\nozeli-test\20261109-alpha6-cold-checkpoint\desktop-package\Nozeli-windows-alpha6-cold-checkpoint-qualification.zip`；SHA256 `3c36f842fff2bc0b3184ed85de6c15f7b3ebf8160a9db444de4d7ec03ffa4122`；43612 文件、1412714116 展开字节、1699 当前 src／dist／tests／tools 冻结文件。CRC、独立中文空格路径解压、全部文件摘要、当前原生输入／二进制、Pi manifest 和仅 System32 PATH 下的包内 Node／Git／Pi 解析通过。没有覆盖旧包或使用硬链接。

完整 Worker 回归仍通过真实 Controller／本地合成 HTTP Provider／Pi SDK／Git 验证单根和真实桌面分离目录下的修改、明确审阅接受、归档和原 receipt warm reopen；未调用真实或付费模型。GUI 各6项仅证明可见窗口与 IPC 登记／读写 CAS／冲突／草稿冷恢复，documentVisibility=hidden，不能宣称文档面显示或物理 Explorer／IME／多屏验收。

正常调用会保留原 helper，关闭 inspection 不关闭源进程监管。已登记 Job 的停稳和原流核验已补齐，但历史完整启动集合仍无原生屏障；current owner 行删除回归证明检查点持续保持整宿主 quiescence／owner release／cold adoption 为 false。默认产品入口仍未启用，不自动恢复派工或重放。

完整 unit／safety／integration 本批未重跑，原失败继续保留；本包为包含合成资格 harness 的本地 ZIP，尚非安装器，未安装／签名／发布／commit／push。
