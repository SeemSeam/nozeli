# Windows alpha.6 原 anchor 冷领取

固定 merged PR27 `cb07c5180c85ca0e127ddc332089300498103cc5`，延续 W0–W5。上一批业务 hold 后，原 helper 仍保留原 writable file object 的共享排他；重新按路径 open anchor 会被正确拒绝。本批新增受限原句柄复制和跨 helper 一次性仲裁，作为 owner 退休之前的原生前置。此步骤不退休原 host/owner，不签发下一代 host lease，不启动或重放旧任务，默认 ManagedProjects 仍未选择。

## 原生边界

supervisor 协议升级 v9，launch-set 升级 v2；旧协议明确拒绝，不连接旧 helper 或回退旧二进制。原 host 仍是启动条目的唯一写入者。helper 保留同一 mapping 的原生写访问，只在精确原 host PROCESS HANDLE 已退出后，使用 InterlockedCompareExchange 将单向 coldAnchorAttempted 从 0 置 1。冷客户端接收启动集合的 HANDLE 仍只有 FILE_MAP_READ。仲裁跨越同一 host 的所有 helper 和所有独立连接；未完成的原生 launch intent 即使 SQLite 行被删除也不能领取。

领取前要求完整来源 custody、原 host 与原 leader 已退出、原 Job ActiveProcesses=0 且 TotalProcesses 与保留成员数一致、stdout/stderr 两个真实 EOF、无输出错误、原 stdin 已关闭且所有原字节完成、无 pending/error。任一条件缺失拒绝。仲裁在复制之前消耗，丢回复不恢复为可重试；新进程不能借另一个 helper 重新领取。

只复制 anchor 的 FILE_READ_ATTRIBUTES、READ_CONTROL 和 SYNCHRONIZE 权限，HANDLE 不可继承。JS 只看到 type-tag 原对象、原 File ID、verify/close 与否定资格字段，不看到数值 HANDLE，也没有读写内容／改权限／改名接口。受限副本与 helper 的原文件 HANDLE 指向同一 file object，所以所有旧 helper 退出后仍保留原写共享排他；关闭副本只结束本地保留，不构成退休或恢复成功。原始 manifest、父目录和来源事实仍由原 helper 保留。

## Managed 绑定

显式 `claimWindowsManagedColdAnchor` 只接受原 inspection WeakMap 与精确 storage/project。先完成原 checkpoint 和本批之前的业务 hold，再复核原 kernel（包括每个保留成员的退出 HANDLE）、source/catalog/identity、完整 host/owner 修订、journal/metadata、工具 custody、业务回执、pending 页和 checkpoint。领取后核对原 File ID 并重新执行检查。摘要绑定 checkpointId、holdOperationId 和原 host lease；原 native pin 留在 inspection 内，调用者不能把摘要序列化后当作授权。

同 inspection 并发调用共用一个 flight。领取后 checkpoint 等观察变化、原生拒绝或不确定结果保留 STORAGE_RESULT_UNKNOWN，同 inspection 不再次领取，也不释放原 helper 证据。关闭 inspection 只关闭它的观察连接和领取的副本，不关闭 helper；已关闭 inspection 不能再次返回领取成功。

原 owner/host active/prepared 行逐行保留，工具业务回复仍未决，Work 保持暂停或 review、候选与未发送草稿保留。executionAcknowledged、pendingReconciled、ownerReleaseQualified、coldRecoveryQualified、productionSelected 和 automaticReplay 均未取得资格。

## 验证与证据

证据目录 `C:\nozeli-test\20261110-alpha6-cold-anchor`。最终实际矩阵和包以 qualification.json 为准。原生 process addon/helper/fixture 已以固定 Node22.23.4 和 MSVC 实际重建；renderer 实际重建。filesystem native 与 Pi 输入／此前实编字节逐摘要核对，本批未重编它们。旧有效包及原 Windows checkout 保留。

新增真实原生用例覆盖跨 helper／独立连接只一赢家、活 host 拒绝、SQLite 删除后的未完成 intent、缺原 stdio 拒绝、收到回复后冷观察进程退出且未确认的回复丢失、所有 helper 退出后副本仍阻止新 writer、伪造 receiver 和已关闭副本拒绝。实际 Controller/Pi/Git 的三个新增模式覆盖正常领取、领取后同值 checkpoint 修订赢家、另一观察者先领取；每个场景仍只有原脚本 Provider 三次请求，保持原 baseline、草稿与业务见证集合。

开发回归首次 process-node 为108通过1失败：原丢 stdin 回复 fixture 手写 v8 帧，本批协议升为 v9 后触发 EPIPE。已修正该 fixture 并保留原失败收据，最终完整进程回归以 process-node-final 为准；不把初轮失败删除或改记通过。

## 后续落地

下一步在保留此 pin 与所有原 helper 的情况下，实现本机同事务的原 owner/host 冷退休。需要将原 immutable journal/kernel 证据与当前退休 ledger 的精确期望分开，保持原记录／修订／工具历史可复核；不能放宽 warm exit proof、warm previousRelease 或接受任意调用者提供的旧行。项目 hold/pending 的提交前后赢家继续阻断或 UNKNOWN。

之后才能签发原 opaque 一次性 cold release，交给新 host lease 和 registry 建立新 launch-set，按原退休 revision 开下一代；实际新 Controller 必须证明暂停／review 不变、原输入不重放、并发宿主只一个赢家。以上未实现，也未接入默认入口。W0–W5 的路径资格、初始化／重置、权限隔离、终端／TeX／回收站、普通账户／物理桌面、安装更新回滚及签名发行继续保留未完成；历史全量和 shared 失败不因本批定向通过而消失。

## 下一批事务设计细化（尚未实现）

本机退休事务需要保留单调行修订，不能直接使用当前会把写入集合 revision 重置为1的 replace。拟新增受限的多集合 compare-and-put：同一 BEGIN IMMEDIATE 内先比较完整原 host、owner、checkpoint 和本机 custody/history 集合（值与行修订、完整集合），再将原 host/owner 按原 revision+1 标记冷退休，同时追加不可覆盖的原 launch/generation 退休历史与操作收据；任一比较失败全回滚，丢提交回复保留 UNKNOWN。项目 hold/pending 无跨库原子性，必须继续在事务前后验证，不能把本机事务成功提升为跨库完成。

journal/input/output 复核仍以原 prepared 行及原 ownerRevision 关联工具 receipt；退休后实际 ledger 应与精确预期退休行比较，再由原 inspection 内的 opaque scope提供原 immutable 基础。拆分“实际 ledger 检查”与“原 journal 解析”，避免递归复核或新增任意 caller-supplied old-record 参数。失去原 scope 的序列化 checkpoint 不能自动重建这份权限。

新 host 需要直接移交本批 pin，不能尝试重新打开 writable anchor。W1 的 custody 构造将需要明确识别原生 type-tag 的冷 anchor pin，核对原 File ID／ACL／登记 metadata parent，并保留同一原 file object 的 share restriction；不能把它转换为裸 HANDLE 或接受普通对象。冷 release 在进入新宿主第一轮异步操作之前一次性消耗，任何失败仍封闭，不把旧 warm previousRelease 解释成 cold receipt。

新 registry 只可从原 host 私有退休集合取得下一代 CAS 基础，不能从一行 phase=retired 即推定授权。覆盖 target 当前槽位之前必须已持久原 generation 历史；下一代的冷检查也必须按 hostLeaseId 验证当前 launch-set，并对被排除的旧退休行逐一验证原历史，而非直接过滤 retired 行。旧 Worker／review／原未送达回复与草稿继续保留，原 work home 仍不得清理。最终需真实新 Controller 的关闭、启动、只一个竞争赢家、无旧输入重放与后续再次冷退出验证，才能讨论默认入口。

## 最终实际验证

| 范围 | 结果 |
| --- | --- |
| business-anchor-node | 3通过／0失败 |
| business-anchor-electron | 3通过／0失败 |
| business-hold-extracted-node | 8通过／0失败 |
| business-anchor-extracted-electron | 3通过／0失败 |
| process-node-final | 109通过／0失败 |
| process-electron | 109通过／0失败 |
| process-extracted-node | 109通过／0失败 |
| process-extracted-electron | 109通过／0失败 |
| cold-node | 20通过／0失败 |
| cold-electron | 20通过／0失败 |
| cold-extracted-node | 20通过／0失败 |
| cold-extracted-electron | 20通过／0失败 |
| host-electron | 60通过／0失败 |
| journal-node | 63通过／0失败 |
| recovery-node | 39通过／0失败 |
| recovery-extracted-node | 39通过／0失败 |
| gui-source | 6通过／0失败 |
| gui-extracted | 6通过／0失败 |

只统计本批实际运行：进程四宿主各109、cold各20；业务解压Node为8个hold/anchor，Electron解压3个anchor；完整business16未重跑。journal/Pi只在源码Node63，host/Workspace只源码Electron60。共享恢复只Node源码／解压39；完整unit／safety／integration与历史shared未重跑。历史失败及相邻shared各67通过8失败仍未解决。

ZIP `C:\nozeli-test\20261110-alpha6-cold-anchor\desktop-package-verified\Nozeli-windows-alpha6-cold-anchor-qualification.zip`；SHA256 `f1a2b630dcf11a38ac258dd7348b0a773e7520f2bc9b154346952b6b0039a39e`；43623文件／1412883711展开字节／1708冻结文件。CRC、独立解压、当前源码／native／Pi、System32-only PATH及运行后完整性通过。
