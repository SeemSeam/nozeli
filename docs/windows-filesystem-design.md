# Windows 文件原语与 W1 接入决策（进行中）

基线为 `release/alpha.4`，首轮证据限 Windows 11 Pro 10.0.22631 x64、普通用户、本地 NTFS。W1 生产门仍为 `unsupported`。本记录用于继续实现完整文件/持久化合同。

## 已实现并实测的原语

Node-API 8 bridge 中的读取与暂存写入共同使用 `anchored-common.h` 的路径校验、句柄检查和错误映射。根、祖先和最终条目分别由 HANDLE 持有，子条目通过 `NtCreateFile.RootDirectory` 打开。遇到 reparse、非固定本地 NTFS、UNC/device 根、ADS、路径穿越或共享冲突时拒绝。

写父目录只能操作单组件名称；允许创建相对于既有根的缺失目录。`FILE_CREATE` 独占创建暂存文件，持有读/写/删除访问，并只允许读共享。写入接收普通 ArrayBuffer 支持的 Uint8Array/Buffer，每块最多 1 MiB。`FlushFileBuffers` 后才能调用 `publishNew`；再写入会使该前提失效。

`publishNew` 对自有文件 HANDLE 调用 `NtSetInformationFile(FileRenameInformation)`，目标相对于固定父目录 HANDLE，`ReplaceIfExists=FALSE`。已有目标导致冲突。已有文件另有下述 TxF 条件替换实验；两者均未接入生产。

| 生命周期 | 行为与清理 |
| --- | --- |
| 暂存、尚未同步 | 可分块写入；发布拒绝 |
| 暂存、文件已同步 | 可尝试无覆盖发布；再次写入后须重新同步 |
| 目标冲突 | 暂存和外部赢家均保留；关闭暂存仅清理自有条目 |
| 发布成功 | 禁止继续写入/同步/再次发布；关闭后保留已发布文件 |
| 发布后检查失败 | `committed=true`、`durability=uncertain`；保留已发布文件用于恢复 |
| 暂存关闭/GC | 对原 HANDLE 设置删除 disposition，再关闭；失败则留下孤立暂存，避免按名称删除竞争者 |

JS 父对象关闭后，仍存活的暂存对象通过 native shared ownership 保留目录句柄。测试覆盖显式关闭、活宿主 GC、自然退出、长路径和两个独立进程竞争发布同一目标。共享锁不会阻止所有硬链接创建，因此在写入/同步/发布前后核验单链接身份，检测到变化即拒绝或报告已发布的不确定结果。

## 接入生产前必须完成的合同

1. **已有文件 CAS**：TxF 实验已验证本机的摘要比较、锁延续、提交/回滚与进程中断。仍须确定 TxF 生命周期与不支持环境的产品策略，补已打开映射和恶意竞争验证，以及生产版本身份/候选账本合同。不得用“先比较摘要，再按普通路径覆盖”填补该合同。
2. **命名空间持久化**：已有下述固定目录 flush、新建/替换/版本化删除屏障链与私有 SQLite worker；目录变化、完整业务消费者仍待资格化。文件与目录 flush 的成功分别记为屏障事实；当前发布结果明确标记 `namespace-not-qualified`，尚不授予断电或多步事务资格。
3. **路径与 ACL**：私有文件/目录创建与 owner/group/DACL 保留已有下述原型；仍需验证大小写目录、8.3 别名、保留设备名、受保护元数据/凭据/SQLite 消费点和扩展安全元数据。现有共享策略中的 `.git`/`.nozeli` 大小写判断仍需结合实际目录语义调整。
4. **共享读取接口**：已有下述显式注入的 HANDLE 流与 Git 捕获；原生 I/O 仍同步，完整取消/调度、tracked 可执行 mode、路径别名和生产消费者尚未资格化。继续迁移 `chain.anchoredPath()` 的 Linux 路径假设。
5. **共享写入与事务**：适配 `openWriteParent`、目录链操作，逐项验证 Git marker/index/ignore、剪贴板导入与文件树事务。安全暂存通过后仍需补消费点和故障恢复。
6. **精确放行**：当前模块仅由显式实验入口加载。上述合同及受影响消费点通过后再接入 selector、能力矩阵和完整平台探针。

保守的共享模式会拒绝部分并发打开场景；当前没有降低共享约束重试。原语同步执行，尚不适合直接放进 Electron 主线程的大文件工作流。最终产品仍须保持共享业务状态机。

## 2026-11-01 验证事实

证据根：`D:\nozeli-test\20261101-windows-native\W1`。

| 验证 | 结果 | 证据 |
| --- | --- | --- |
| VS/MSBuild 构建读取+写入模块 | 退出 0 | `build-windows-native-write-v2.json`、`.log` |
| 同一二进制、9 项读取 + 14 项写入 | Node 22.23.4 与 Electron 44.9.1 Node 模式各 23/23，无失败或跳过 | `read-write-final/native-filesystem-hosts-validation.json`、两份 TAP |
| 组件 ZIP → 中文/空格目录解压 → 执行 | 解压后的固定 Node 与锁定 Electron 各 23/23；全部归档文件摘要一致 | `component-roundtrip/component-roundtrip.json` |
| 共享文件与探针门控回归 | 17 项：5 pass、0 fail、12 Linux 专属 skip；Windows 生产能力继续拒绝 | `shared-filesystem-gate.tap` |
| 首轮输入类型边界失败 | 两个宿主均失败 1 项；改用明确的 TypedArray 类型与非共享 ArrayBuffer 检查后通过 | `native-read-write-first.log`；后续日志与验证记录分别保留 |

组件包只含原生实验、JS 包装器、合成测试、固定 Node 和许可文件。Electron 使用已锁定的开发依赖宿主。完整应用、干净机器、安装、升级和签名仍在 W4/W5 验收范围内。

## 2026-11-02 已有文件替换实验

`anchored-transaction.inc` 是 `anchored-write.cc` 的内部实现，复用同一目录句柄链。KTM DLL 仅从 System32 动态加载；创建事务失败或相关 API 缺失时明确拒绝，不回退到无保护覆盖。当前仅在上述主机、本地 NTFS、普通权限下资格化。

`openExperimentalReplacement(root, relative, expectedSha256)` 在事务持有目标写/删除冲突锁后读取并比较 SHA-256。`prepare(bytes, stageName)` 独占创建事务内的新文件，写入并 flush，关闭两个事务文件句柄，再在同一事务中替换；`commit()` 才使结果可见。TxF 路径来自固定父 HANDLE 的 `GetFinalPathNameByHandleW`，只追加经校验的单组件名称，目录祖先继续保持拒绝写/删除共享。测试证明关闭目标文件句柄后的锁由事务继续持有，独立进程的写入、删除、改名、替换及硬链接创建均被拒绝。

| 状态/错误 | 实验合同 |
| --- | --- |
| 基线摘要过期 | `FS_VERSION_CONFLICT`，提供 expected/actual 摘要；释放事务，外部赢家保留 |
| 已准备、未提交 | 普通读者仍见旧字节；事务内暂存不出现在外部目录列表 |
| 显式 close / 活宿主 GC / 自然退出 / 强制终止自有子进程 | 回滚；原文件保留，事务暂存消失 |
| 独占暂存名冲突 | 中止事务；保留外部同名文件及原目标 |
| 成功提交 | `{committed:true,durability:'namespace-not-qualified'}`；不授予断电资格 |
| 提交失败且 KTM 确认 aborted | `FS_TRANSACTION_ABORTED`、`transactionOutcome:'aborted'`；禁止自动重放 |
| 提交失败且结果 committed/unknown | 分别报告 committed 或 unknown；已知 committed 附 `committed:true,durability:'uncertain'`，不猜测回滚或自动重试 |

事务限定 30 秒。真实超时测试在两个宿主中均得到 aborted；随后外部写入成功，关闭失败事务不会删除外部赢家。成功提交与 aborted 分支已实测；committed-but-error、unknown 及回滚失败分支尚缺故障注入，不能据代码推断已经通过。

恢复候选必须由共享业务层在事务开始前另行保存。测试中的 `draft.recovery` 是预先写入的合成恢复文件，用于证明事务失败/进程退出不会清除它；本实验**不提供草稿持久化服务**。仅保存在事务暂存中的候选会随回滚消失。

**路线限制**：微软在 [CreateFileTransactedW 文档](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-createfiletransactedw) 中强烈建议采用替代方案，并提示 TxF 未来可能不可用。当前结果只支持继续评估这条实验路线，不将 TxF 作为所有 Windows 安装的无条件依赖。输入/候选各限 1 MiB、同步执行；版本比较仅以内容摘要为基线。初版继承父目录 ACL 的缺口已由下述 ACL 切片处理，但扩展安全元数据和完整业务版本身份仍未资格化。其他卷、大小写目录、映射写入、受保护路径、崩溃后业务账本、多文件事务与断电均未获资格。

## 2026-11-02 私有权限与替换权限保留

新增 `anchored-security.h`，仅依赖系统 Advapi32 SDK。`createPrivateExclusive(name)` 在 `NtCreateFile` 创建前构造 DACL：owner 为实际进程 token user，DACL 受保护且只有该 SID 的 FullControl ACE。`createPrivateDirectory(name)` 同样独占创建，只将当前用户 ACE 继承给子目录和文件。不会先创建宽权限文件再收紧，也不修改既有同名条目的权限。线程存在 impersonation token 时明确拒绝；不启用额外特权，不读取用户凭据。

私有暂存对象在写入、flush、verify 和发布前检查 owner/group/DACL。独立进程可用 WRITE_DAC 修改普通暂存文件；测试确认随后操作拒绝，清理仅处理自有句柄。因此这些核验不构成阻止所有同用户竞态的原子权限锁。

TxF 替换在读取目标时保存 owner/group/DACL，将其作为 `CreateFileTransactedW(CREATE_NEW)` 的安全描述符传入候选创建，再比较实际规则。无法复现、无法读取或 null DACL 在发布前拒绝。比较 owner、group、DACL protection 与每个 ACE；不把 Windows 对 `SE_DACL_AUTO_INHERITED` 的记账规范化误报为访问策略变化。受保护自定义 ACL、私有 ACL 和未保护的继承 ACL 均单独验证。

独立路径式 ACL 修改在持有目标阶段返回 32、准备后返回 6800；原权限与恢复候选在回滚后保留。尝试在准备后从非事务视图重新开原目标来增加最终检查也返回冲突，不能以此方式伪造完整检查；该尝试的失败保留于 `W1/security-fourth.tap`，最终实现不依赖它。预先打开的 WRITE_DAC 句柄、恶意高频竞争、同用户最终窗口、SACL/完整性标签、其他属性/流以及真实跨账号访问仍待资格化。私有 DACL 也不是对同账号 owner、管理员特权或备份特权的沙箱。

新增 11 项权限场景。首轮 fixture 受到 PowerShell 7 的模块搜索路径及 Set-Acl 审核权限请求影响；现测试子进程限定为系统自带 Windows PowerShell 模块，.NET 仅获取/写入 owner/group/access，不请求 SACL。它只用于合成测试，产品不依赖 PowerShell。另一次测试因 SDDL auto-inherited 记账位变化失败，现按完整访问策略核验，未放宽 ACE/owner/group/protection。原始失败保留在 `W1/security-first.tap` 至 `security-fourth.tap`。

组件前两次解压执行在 D: 失败：fixture 将 owner 重设为相同 SID 仍请求 WRITE_OWNER，而此卷继承策略不授予该权限；修改 DACL 本身可由 owner 完成。现 fixture 保留 owner/group，仅修改 DACL；不申请额外权限。失败日志保留在 `W1/security-component-roundtrip/`、`W1/security-component-roundtrip-v2/`。

生产私有配置/SQLite/凭据路径仍未接入，命名空间与断电资格不由本切片授予；W1 继续 unsupported。当前完整套件为 9 读取 + 14 暂存 + 14 替换 + 11 权限，共 48 项；源码及解压后的 Node/Electron 均各 48/48，无失败/跳过，归档摘要匹配。证据为 `W1/security-hosts-final/native-filesystem-hosts-validation.json` 与 `W1/security-component-roundtrip-final/component-roundtrip.json`。

## 固定目录屏障与持久化接入原型

新增 `openExperimentalPersistenceParent(root, relative)`：逐级固定卷根、祖先及最终父目录，最终父目录在首次打开时请求 `GENERIC_READ | GENERIC_WRITE`，`syncDirectory()` 直接对这个 HANDLE 调用 `FlushFileBuffers` 并前后核验身份。不会在发布后按普通路径重开目录，不使用管理员卷 flush，不修改全局策略。与此前可创建目录的实验父接口不同，此入口要求父目录全部存在，缺失即拒绝且不创建任何目录；卷根 flush 另行 unsupported。

首版保持最终目录只读共享，实测自身 no-replace rename 被共享冲突 32 拒绝，保留 `W1/persistence-first.tap`。当前显式 flush 父接口允许 read/write share，仍拒绝 delete share，从而允许自身 namespace 操作并阻止祖先改名/替换；其他入口的共享模式未变。增加写共享意味着目录属性/权限的恶意并发及最后检查窗口仍需独立验证，不能将该切片当作全路径安全资格。

`experimental-persistence.mjs` 组成 root-scoped 写入链：输入先校验，私有暂存 → 文件 flush → 无覆盖发布（新目标），或事务持锁摘要比较 → 候选 flush → 事务替换提交（已有目标），最后执行同一固定父目录的 flush。已有目标必须带 `expectedSha256`；无摘要仅允许新建，不能降为盲覆盖。发布前冲突不执行目录屏障；发布后屏障失败保留新内容并标记 `committed=true,durability=uncertain`。不自动重试，异常清理不覆盖主错误与结果事实。

定向故障在实际发布后关闭固定父对象，再调用其原生 sync，得到真实 `FS_HANDLE_CLOSED`；新建与已有目标替换分别证明已提交内容保留、临时文件不残留、没有自动重放。此为句柄失效故障，**不冒充存储设备 I/O 故障**。恢复候选仍由业务层预先另存。

**持久化决策**：微软 [IRP_MJ_FLUSH_BUFFERS](https://learn.microsoft.com/en-us/windows-hardware/drivers/ifs/irp-mj-flush-buffers) 要求文件系统/过滤驱动将关联文件对象的重要数据或元数据刷盘；[ZwFlushBuffersFile](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/nf-ntifs-zwflushbuffersfile) 文档说明 flush 同步执行。TxF 文档确认文件内容与命名空间变更受事务管理，但 `CommitTransaction` 的简短说明本身不能单独证明本应用整套持久化合同。当前证据支持继续采用“文件 flush + namespace 操作 + 固定目录 flush”进行原型验证，不将普通用户目录调用成功等同于完整断电与多步事务保证。硬件缓存、断电/存储故障、mkdir/删除/跨目录 move 两侧屏障、standalone syncDirectory 与业务账本仍缺验收。

成功回执因此为 `state:'barriers-completed',durability:'namespace-not-qualified'` 并记录 `{file:'flushed',directory:'flushed'}`，adapter 的 `supported` 仍 false。此回执有意不能充当共享生产 `writeAtomic()` 的 `state:'durable'`；root/relative、强制版本参数、1 MiB 上限、同步 native 执行也尚未适配所有消费者。共享 selector、能力矩阵与生产拒绝保持原状。

官方文档正文/原始 HTML、摘要、Git blob 与失败下载记录保留在 `W1/persistence-contract-sources/`。其中原始 GitHub 路径曾 404；更正后的 TxF/驱动文档已取得，IRP 文档使用真实 Learn 页面正文而非失败下载结果作依据。新增 10 项屏障链场景，完整套件共 58 项，证据在 `W1/persistence-hosts-final/native-filesystem-hosts-validation.json` 和 `W1/persistence-component-roundtrip/component-roundtrip.json`。

普通 rename 与 POSIX rename 的原语观察见 `W1/platform-semantics/replacement-observations-native.json`：拒绝删除共享的目标不能被本次替换；允许删除共享时虽可 POSIX 替换，但旧句柄继续读旧对象，不能单独证明 CAS。首版 `replacement-observations.json` 使用了不适用的相对 rename 调用，结果无效，保留但不作为资格依据。官方文档缓存与摘要在同目录 `sources-api.json`。

此前 TxF 切片为 9 项读取、14 项暂存、14 项替换，共 37 项；固定 Node 与 Electron Node 模式均 37/37，无跳过。历史证据：`W1/transaction-cas-final/native-filesystem-hosts-validation.json`，构建日志 `W1/build-windows-native-cas.log`。当时组件 ZIP 在中文/空格目录解压后两个宿主也各 37/37，全部归档摘要匹配，记录在 `W1/transaction-component-roundtrip/component-roundtrip.json`。生产 W1 继续 unsupported。

## 固定 HANDLE 接入共享读取与 Git 对象捕获

新增只读实验 adapter `experimentalWindowsReadFilesystem`，仅供显式注入 `createFileStream({filesystem})`。原生 `stat()` 返回首次 HANDLE 检查得到的 BigInt size/nlink 与文件属性；`readAt(offset, size)` 使用同一保留句柄按绝对偏移读取，拒绝非安全整数和大于 1 MiB 的块。包装器每条流独立从零计数，按 256 KiB 输出并服从 Node 流背压；并行游标不会共用顺序读位置。stream destroy/消费异常/提前结束后，共享边界统一关闭全部 native guards。只有 Win32 缺失错误 2/3 映射为 null，其他权限/共享/链接错误仍拒绝；不根据 DOS 路径补开或虚构 POSIX inode。

`git-service.mjs` 的 `blobFiles(..., {filesystem})` 与 `blobFile(..., {filesystem})` 复用同一共享读取器。声明 `gitFdSourcePaths=true` 的 Linux adapter 保留原批处理；无 fd 路径的 adapter 将第二遍固定句柄字节流送入随包 Git `hash-object -w --no-filters --stdin`，对比第一遍独立计算的 Git OID，消费结束后核验身份。没有重开源文件路径，也不把整个二进制装入内存。传输错误或对象摘要不符时不返回可接受结果、关闭句柄，不更新 ref/index；已经写入的无引用对象无需冒险删除。已知且摘要相同的对象保留只读一次的优化。Windows 分支目前每个变化文件启动一个 Git 进程，后续需要结合真实快照批量性能评估。

新增 10 项真实 Windows 共享读取/Git 场景：stat/偏移边界、Unicode 与二进制、独立并发游标、缺失/目录/junction/硬链接拒绝、有界文本、回调失败及提前结束、独立进程竞争与后验硬链接变化、实际 SHA-1/SHA-256 对象、33 MiB 二进制、已知对象/缺失条目、传输失败及摘要不符释放。后两类故障只作用于实验注入的流，不能冒充磁盘故障。完整 68 项在源码及 ZIP 解压后的 Node/Electron 各 68/68，无失败/跳过；组件包含自己的 Node、dugite/Git 及所需源码，全部归档文件摘要匹配，Electron 仍为锁定开发宿主。

当前二进制 `b0c2e9c7cdd73a686633d003216419f5677396846f1441d5b222a5c05445b1e7`；构建 receipt `W1/build-windows-native-read-consumer.json`、源码验证 `W1/read-consumer-hosts/native-filesystem-hosts-validation.json`、解压验证 `W1/read-consumer-component-roundtrip/component-roundtrip.json`。共享门控 29 项：15 pass、0 fail、14 平台前置 skip；Linux 原生回归没有在 Windows 代签。

该 adapter 仍 `supported=false`，写入/目录链拒绝，生产 selector 与能力矩阵不变。流可在块间取消但 native 单次 I/O 同步，尚无后台调度或被阻塞系统调用的取消机制。Windows 工作树无 POSIX execute bit，此原型映射 `100644`；已有 tracked 可执行 mode 的保留政策未实现。完整快照/接受/回滚、恶意映射写、路径别名/大小写、权限、业务写入/恢复与断电持久化仍须后续资格化。

## 输入快照消费点接入

继续检查发现 `ExecutionWorkspace` 虽已持有显式 filesystem，但快照/初始化批量捕获、legacy 导入与已批准 reconciliation 的单文件捕获没有传给 Git helper，仍会回到默认 unsupported adapter。现四处均显式传入 `this.filesystem`；默认选择与所有能力门不变。

新增两项真实 `ExecutionWorkspace.snapshot` 方法验证：在合成 Git 仓库中捕获磁盘改动、用户 index 与磁盘不同的已暂存文件、新建二进制、删除条目，排除 `.env`/`node_modules`；生成独立 tree/commit 后，原分支 refs、用户 index 的逐字节摘要、磁盘内容及状态保持不变。硬链接拒绝及默认 unsupported adapter 拒绝后，源和用户索引保留，仅删除该次私有临时 index。没有伪造 shared snapshot 方法或用替身 Git。

输入捕获切片当时完整组件为 70 项，源码与 ZIP 解压后的 Node/Electron 均各 70/70，无失败/跳过。组件增加此方法的固定源码及依赖闭包，所有归档文件摘要匹配。沿用上一切片同一 native 二进制；历史证据 `W1/build-windows-native-snapshot.json`、`W1/snapshot-hosts/native-filesystem-hosts-validation.json`、`W1/snapshot-component-roundtrip/component-roundtrip.json`。

仅此输入捕获方法已跑通；初始化/legacy/reconciliation 的参数传递已修正，但其完整流程未验收。Work prepare/恢复、worktree 依赖供给、持久化账本、接受/回滚与 production selector 仍未获资格，不把该 tree/commit 事实当作整条执行链完成。

## 流式 CAS 与共享审校写入

TxF replacement 增加 `readChunk(offset,size)`、`beginCandidate(name)`、`writeCandidate(bytes)`、`finishCandidate()`。每次 native 读取/写入最多 1 MiB；JS 使用 256 KiB 块，在块间让出 event loop 并检查 abort。目标在摘要比较前已被事务写锁固定，候选在创建时提供原 owner/group/DACL，每次写入及准备前检查权限、身份和单链接；flush 后关闭候选/目标句柄，再准备事务替换，最后显式 commit。事务始终保留冲突锁。流式候选与旧 `prepare(bytes,name)` 不可混用；close/finalizer/宿主退出负责关闭候选并回滚。

`createExperimentalWindowsPersistence(root).writeStream(relative,source,{expectedSha256,expectedNewSha256,signal})` 接受 byte-chunk iterable。新文件走私有独占暂存与 no-replace 发布；已有文件分块哈希锁内基线，再分块写候选。若提供候选摘要，必须在准备/发布前匹配；共享审校 adapter 强制要求该摘要。生产者错误、候选不符或块间取消会关闭原生资源并回滚，保留外部目标及调用者另存的草稿。实际验证 33 MiB 基线和候选，未构造整文件 native buffer。小型 `writeAtomic` 便捷入口仍限制传入字节不超过 1 MiB，旧 native `read/prepare` 也保留该限制。

该流接口不会中断阻塞的生产者或单次同步系统调用；未开始消费的 source 仍归调用者所有。事务超时仍为 30 秒，慢输入不能假定无限保锁。恢复草稿必须在进入事务前由业务层独立保存；原生候选并非持久化草稿服务。所有成功回执仍是 barriers-completed / namespace-not-qualified，发布后错误保留 committed/uncertain。

新增 `experimentalWindowsVersionedFilesystem`，仅额外提供可选 `versionedWrite` 操作，仍 supported=false，通用 openWriteParent/rename/remove/chain 拒绝。共享 `createFileStream` 提供纯路径预检及明确的 `writeVersioned` 路由，缺少该能力即拒绝。共享 `ExecutionWorkspace.applyReviewedFiles` 先预检全计划路径及原有漂移，再逐文件以捕获摘要调用该操作；不回落普通 rename。过期基线映射 WORKTREE_DRIFT，候选不符、权限和其他错误保留具体事实；发布后复核失败也携带 committed/uncertain。

多文件审校仍是逐文件提交，**不是整组原子事务**。若前一文件已发布、后一文件遇到竞争，异常附 `appliedFiles`，逐项记录已知发布的 relPath/candidateDigest，并保留 committed=true/durability=uncertain；保留外部赢家和调用者的计划/草稿，不谎报整组未执行。此字段描述已发布候选，不能断言目标随后没有外部修改。后续仍须接入业务账本与恢复，不能据该方法资格宣称完整接受/回滚已成立。

Windows 版本化写入保守拒绝 `.git/.nozeli/.ccb` 和凭据的大小写/规范化等价拼写、所有含 `~` 的组件以及 DOS 保留设备名。比较仅用于拒绝，不修改实际路径；因此会额外拒绝部分普通文件名。整计划在首次发布前运行相同路径预检。此策略尚不能代签通用 8.3 别名、自定义短名、大小写敏感目录或其他卷的资格。

新增 14 项真实 native/共享写入场景，完整组件为 84 项。首轮 `W1/versioned-write-first.tap` 13/14：权限测试误比较 AUTO_INHERITED SDDL 记账字段；现严格比较 owner/group/protection/每个 ACE，规则并未放宽。后续定向与旧持久化共 24/24；最终源码/ZIP 解压的 Node、Electron 各 84/84，无失败/跳过，全部归档摘要匹配。共享门控 29 项：15 pass、0 fail、14 平台前置 skip，Linux/macOS 没有代签。

该切片 native SHA-256 `cbc8cf7eb3b1548e68c5668c56357c78cdbcad19c999c611ed1e69e374c51c06`；历史构建 `W1/build-windows-native-stream-cas.log`，验证 `W1/stream-cas-hosts-final/native-filesystem-hosts-validation.json`、`W1/stream-cas-component-roundtrip-final/component-roundtrip.json`。后续删除和 Git 单文件方法结果如下；W1 和生产选择器保持 unsupported。

## 版本化删除与 Git 单文件安装/反向回滚

TxF 对象新增 `prepareDelete()`，在已经检查过的同一目标 HANDLE 上设置 FileDispositionInfo，关闭目标后标记 prepared，再由已有 commit/close 生命周期提交或回滚。不按可变路径重开/删除，不去掉 readonly 属性；已有候选时拒绝删除。`removeVersioned(relative,{expectedSha256,signal})` 必须给出基线 SHA-256，在事务锁内分块哈希并比较后准备删除、提交、flush 同一固定父目录。删除回执只记录 directory barrier，未声称执行 file flush；成功仍为 barriers-completed / namespace-not-qualified，发布后故障保留 committed/uncertain。

实验 filesystem 增加精确的 versionedWriteStream/versionedRemove 能力与对应方法，共享 file-stream 在能力或方法缺失时明确拒绝。`installFile` 首先校验写路径；保留原有摘要/幂等规则，然后对显式版本化 adapter 使用流式 Git blob、基线摘要和批准候选摘要。删除使用强制基线摘要。过期基线/候选不符映射 SOURCE_CHANGED；发布后复核失败附 relPath 和 committed/uncertain，不覆盖随后出现的外部赢家。默认 unsupported selector 与 Linux 原有安装分支保留。

`blobStream` 为惰性 async generator，实际消费时才启动随包 Git `cat-file blob`；管道 highWaterMark 为 256 KiB，有背压且不收集整文件。仅接受完整 40/64 位对象 ID。stdout 结束后仍等待 Git 的退出结果，防止尾部错误被当成功；消费者提前结束则销毁输出并等待已有 transport 清理、回收自有 Git 子进程。它不运行 hook、不推进 refs/index。安装适配层在消费流之前拒绝 100644 之外的 mode；缺少父目录也拒绝，不创建未获资格的目录链。

新增 `windows-native-install.test.mjs` 17 项，完整组件为 101 项。验证事务删除提交前不可见/独立写锁/回滚/宿主退出、错误 receiver/候选状态、硬链接/重解析/readonly 拒绝、删除摘要与块间取消、真实关闭父句柄的已提交删除故障，以及共享 Git changed/new/deleted/Unicode 文件的前向安装与反向恢复。包含 33 MiB、SHA-1/SHA-256、缺失/损坏对象、候选摘要不符、流提前结束、检查后竞争、幂等重试与原 index/refs/draft 保留。第一次定向运行 13/14，失败为测试错误预期 reparse 错误码，修正后加完整场景 17/17，原日志保留。

最新源码 Node/Electron 各 101/101，ZIP 中文/空格目录解压后各 101/101，均无失败/跳过，所有归档摘要匹配。原生 SHA-256 `f273421d2788dda8e6af8cc8c05adbab0f0c6123f574a8fd9173e6108ff69c80`；证据 `W1/build-windows-native-install.json`、`W1/install-hosts/native-filesystem-hosts-validation.json`、`W1/install-component-roundtrip/component-roundtrip.json`。共享门控为 29 项：15 pass、0 fail、14 平台前置 skip。同步修正证据生成器覆盖新版 persistence limits 的问题，当前清单准确区分小型 byte API 与 33 MiB 流式资格。

单文件方法通过不能代签完整接受/回滚：业务 intent/账本、index/ref 锁及恢复仍需接入，未验证多文件故障恢复与生产草稿链。通用目录链/移动/剪贴板/文件树事务、命名空间/断电持久化、tracked executable mode、异步原生 I/O、扩展安全元数据、恶意映射/安全句柄、unknown 提交故障仍待资格化。TxF 未来可用性政策仍未定，W1 保持 unsupported。

## 私有 SQLite 句柄与共享存储线程

新增 `anchored-database.inc`，通过固定 persistence parent 的 `openPrivateDatabase(name,mustExist)` 创建或打开数据库。要求父目录为受保护 current-user-only DACL；主文件在创建时即提供私有权限，已有文件不截断、不迁移、不修权限。主文件必须普通单链接；文件 HANDLE 请求数据读取、READ_CONTROL 和同步访问，允许读写共享，拒绝删除共享；SQLite 仍通过真实 Windows VFS 打开由固定父句柄解析的路径。数据库连接活跃期间保留所有祖先和主文件句柄，真实连接关闭或 worker 退出后才释放。

首版仅请求 FILE_READ_ATTRIBUTES 时，独立进程删除未被阻止，定向测试 9/10，日志 `W1/database-first.tap` 保留。这是原生共享保护缺陷，已改为参与共享检查的数据读取访问，复核独立 rename/delete 拒绝及退出后释放，未放宽测试。最终父目录保持 GENERIC_READ/WRITE；最终数据库只读 pin 与 SQLite 的正常读写兼容。

lease 在打开前和请求核验时检查父目录/主文件权限、同一 file ID 与单链接，以及既存 `-journal/-wal/-shm` 的普通文件/单链接/sole-user FullControl ACE。SQLite 默认创建的 sidecar 可继承私有父目录唯一用户 ACE，不要求强行改成 protected。unsafe sidecar 在创建主文件之前拒绝，错误不清理外部条目。此核验不是恶意同用户 sidecar/security 句柄竞态的原子锁；现有 DACL 不证明不存在预先打开的外部句柄，这些仍未资格化。WAL/SHM 仅拒绝性检查，尚未资格化 WAL 模式。

`openExperimentalDatabaseLease(root,file)` 限明确本地根内的绝对路径；缺少父目录或受保护权限即拒绝。`StorageDatabase({experimentalWindowsRoot})` 将配置显式传至现有 worker，不修改生产默认选择。原 SQLite DELETE journal/FULL synchronous、格式检查、请求 fingerprint、operation_receipts、revision 和集合 CAS 保留。主线程不执行同步 SQLite；原生 lease 检查也在 worker 内。缓存连接每次核验；提交前核验与提交后的核验分别保留已知失败和可能已提交事实。后者或关闭未确认报告 STORAGE_RESULT_UNKNOWN，主进程封闭该 generation 的全部已接纳请求，不重建/重放，等实际退出后显式读回 receipt。

12 项新真实测试覆盖私有 ACL、外部目录/数据库改名删除、受保护/单链接检查、错误 receiver/close、已有字节保留、缺失 mustExist 不创建、真实共享 worker 的 schema/receipt/revision/集合 CAS、独立恢复库、权限/硬链接变化拒绝、锁超时与显式核查。另用真实 SQLite 打开事务、强制进程退出留下非空 hot journal，随后由共享 worker 冷开恢复原值与已提交 receipt；这证明该进程中断场景，不代签断电。

完整组件源码和解压后 Node/Electron 各 113/113，无失败/跳过；native SHA-256 `7333aa8cabc057ad730378f448567e0028f4f3f5dbec6dba3d7cfeb3162ea785`。证据 `W1/build-windows-native-database.json`、`W1/database-hosts-final/native-filesystem-hosts-validation.json`、`W1/database-component-roundtrip-final/component-roundtrip.json`。共享门控仍 29 项：15 pass/0 fail/14 skip。共享 storage-worker-safety 文件原始运行 34 项：27 pass/7 fail（6 项需要禁用中的项目初始化，1 项假定可 unlink 已打开数据库）；尝试的负向名称筛选匹配文件根，实际执行了全文件。改用明确正向选择后，相关 27 项均通过；原失败日志 `W1/shared-storage-worker-database.tap` 保留。新增受控 worker 用例只验证 UNKNOWN 回复封闭与停止逻辑，不能代替原生 postcommit 故障注入。

该 SQLite lease 自身限已存在的 protected 私有父目录；其后的私有目录准备见下节。不能用 SQLite 本身 FULL 模式代替元数据命名空间或产品持久化资格。W1 与生产初始化继续 unsupported。

## 私有目录链与 ProjectStorage 本机状态

新增 `anchored-directory.inc`：`openPrivateDirectory(name,create)` 通过已有父 HANDLE 相对打开/创建子目录，创建时提供 protected current-user-only DACL。既有宽权限目录直接拒绝，不改权限。每个子目录持有祖先 shared ownership 和私有 ACL 快照；父 JS lease 关闭后仍能验证整链并拒绝祖先改名。`created` 来自真实 NtCreateFile information，`identity()` 返回卷号与 128 位 file ID。私有链限 128 层；重解析、非目录和身份/ACL 漂移明确拒绝。

`ensureExperimentalPrivateDirectory(root,absoluteDirectory)` 在效果前检查完整路径计划，保守拒绝 DOS/NFKC 设备名、tilde 别名、尾点/空格、相对/非规范路径及根外路径。逐级保留句柄并 flush 子目录和父目录；既存组件也执行屏障，允许失败后的显式重试补齐。成功仍只报告 barriers-completed / namespace-not-qualified。错误附实际已创建目录的 relative/identity，部分创建保留 committed/uncertain，不按名称删除；原生后创建错误也保留 committed 事实。

通过 `ProjectStorage(profile,{experimentalWindowsRoot})` 接入现有 `ready()`、`localDirectory()` 与 `recoveryDirectory()`，复用共享目录数据库/SQLite worker 和 lifecycle hold。普通构造默认不选择该实验。`initialize()` 仍首先要求生产持久化支持，`register()` 在项目效果前拒绝。离线 local/recovery 测试明确预置合成 catalog binding，只验证已登记实例离线存储方法，不能推导真实登记或完整项目恢复通过。MaterialStore 恢复对象、retry、项目复制/来源保留/发布/清理路径未取得本节资格。

12 项新增真实场景覆盖 Unicode 私有树、幂等 ID、ACL/祖先变化、外部文件/junction/宽权限保留、完整计划拒绝、128 层上限、实际关闭句柄屏障故障、取消、后续组件冲突、目录数据库/lifecycle hold 冷开、离线 local/recovery SQLite 冷开和两个独立进程同时创建同一树。并发实测创建数总和为 3、最终 ID 相同；失败后重试保留既存 ID。

该目录切片完整源码/ZIP 中文空格解压 Node/Electron 各 125/125，无失败/跳过；native SHA-256 `75371265c79009cf29965bb9fba71707a4fc820de40c1b00a15571c684c97ca0`。证据 `W1/build-windows-native-directories.json`、`W1/directories-hosts-final/native-filesystem-hosts-validation.json`、`W1/directories-component-roundtrip-final/component-roundtrip.json`。重跑共享门控 29：15 pass/0 fail/14 平台 skip；明确选择的相关存储安全 27/27。此前 113 项二进制为历史证据，原始共享全文件七项失败保留。

下一步仍需固定身份的目录发布/跨目录移动/删除与复制、项目初始化共享状态机逐阶段恢复，再接完整 Work intent/index/ref/账本和三个自定义文件事务。当前文件安装仍要求已存在父目录；本节目录原型未赋予文件安装自动建目录能力。同步原生 I/O、恶意安全句柄/sidecar 竞态、命名空间/断电和 TxF 产品政策仍待处理，生产 W1 保持 unsupported。

## 按预期身份的私有目录无覆盖移动

新增 `anchored-directory-move.inc` 和 `moveExperimentalPrivateDirectory(root,source,destination,{expectedIdentity})`。两条完整计划在效果前验证；只接受同卷、已存在父目录和受保护 current-user-only 源目录。`beginPrivateDirectoryMove` 按源父 HANDLE 打开源目录，要求 DELETE 数据访问并拒绝 delete share，核对预期卷号/128 位 File ID；保持源、目标父链，并分别快照源目录和两侧父目录的 owner/group/DACL。后续操作核验身份和权限变化；不会修复权限，也不会按名称清理。

`commit()` 对同一目录 HANDLE 使用相对目标父 HANDLE 的 NtSetInformationFile FileRenameInformation，replace=false；目标已经存在文件、目录、junction 或大小写等价名称都保留。提交成功后不允许再次提交；关闭/finalizer/宿主退出只释放句柄，源或已发布目录均不删除。高层入口先 flush 源目录，再提交，随后 flush 移动后的目录与两侧父目录；仅报告 barriers-completed / namespace-not-qualified。提交前取消保留源；提交后取消仍完成屏障。发布后错误携带 source/destination/identity/moved 及 committed=true、durability=uncertain，禁止按未执行重放。

此合同只固定**目录根身份**。它不递归核验、冻结或同步后代文件；调用方必须先停稳 writer、按固定身份核验整个候选树并完成文件屏障，再用业务 operationId/清单核查发布与恢复。移动后读取 SQLite receipt 成功也不能代签整棵元数据树或项目初始化。

新增 14 项真实场景：同/跨父目录、Unicode 内容/私有 ACL、父 JS lease 关闭后保持祖先 pin、错误 ID/源替换、宽权限/重解析/文件源拒绝、既存和独立晚到赢家、两进程发布竞争、提交前 ACL 漂移、预检/取消、真实关闭句柄导致的目录及两侧父屏障失败、非 Error 失败、提交前后宿主退出。跨父目录后共享 SQLite worker 冷开读回原草稿和操作 receipt。首轮 13/14 失败为测试在独占移动 lease 未关闭时重开源目录，被正确共享拒绝；修正关闭顺序后 14/14，原日志 `W1/directory-move-first.tap` 保留。

该移动切片完整源码/中文空格目录 ZIP 解压 Node/Electron 均 139/139，无失败/跳过，归档逐文件摘要匹配；native SHA-256 `b4f7159b8eaca77638b22ebf688ff7896f45da008588aba111322f5b3c7d4af5`。证据 `W1/build-windows-native-directory-move.json`、`W1/directory-move-hosts-final/native-filesystem-hosts-validation.json`、`W1/directory-move-component-roundtrip-final/component-roundtrip.json`。共享门控与存储安全沿用上节日志，未重复宣称新跑。125 项目录二进制为历史切片。

下一步补目录树内容核验/同步、固定身份删除与复制，再接共享项目初始化的 intent/发布/来源保留/重试。当前移动没有接入生产初始化；不能用成功的根目录 rename 替换整树恢复验收。原生未知 rename 故障、恶意安全/映射竞争、命名空间/断电、完整 Work 和三个多步事务仍待资格化，W1 继续 unsupported。

## 私有树清单、屏障与发布后复核

新增 `anchored-private-tree.inc`，目录通过固定 HANDLE 的 FileIdExtdDirectoryInfo/RestartInfo 分页枚举，不使用路径式 readdir。每项提供实际名字、128 位 ID、类型和属性；真正相对打开子项后再次比对 ID。目录须 protected current-user-only；文件须普通单链接、sole-user FullControl，允许唯一用户 ACE 由父目录继承。文件 HANDLE 请求数据读写以执行真实 flush，拒绝写/删除共享；目录/文件/父 ACL 保留快照，已有权限不修复。相对文件读取有界，支持独立 offset；最终关闭只释放句柄，不删除条目。

`openExperimentalPrivateTree(root,directory,options)` 保持根与全部后代句柄，生成冻结清单：名字、类型、File ID、文件属性/字节数、内容 SHA-256、owner/group/DACL 自相对描述符的 SHA-256。清单另有整体摘要；严格路径预检、歧义名称拒绝和数量/字节限额避免无界遍历。默认最多 10000 后代/1 GiB 文件字节；`readFile` 默认 1 MiB，`streamFile` 每块最多 256 KiB。`verify` 重新核对成员、身份、权限和字节；`sync` 先核验，再 flush 文件、后序目录及固定父目录，最后重新核验，只报告 barriers-completed / namespace-not-qualified。

真实 NTFS 在严格后代句柄开放时拒绝目录 rename，错误 5；原始失败和释放后成功观察为 `W1/private-tree-probe.log`、`W1/private-tree-release-probe.log`。实现不降低共享模式。`publishTo` 先同步树，保留原 DELETE 根句柄，显式释放后代，再通过同一根句柄的 duplicate 执行无覆盖发布；同步根及两侧父目录后，从仍固定的根重新打开全部后代，与原始完整清单比对。父目录和移动 lease 保留至树关闭；后续同步也覆盖目标父目录。取消只在提交前停止；提交后继续屏障和复核。

释放/复核不是原子冻结整树，调用者仍须停稳 writer。该窗口的字节修改、新增成员或 ACL 变化（即使仍符合 sole-user 策略）会报告 committed/uncertain 和 source/destination/root/manifest 摘要，保留已经移动的内容并禁止重放。发布前目标竞争保留源和外部赢家，只有显式核验后才允许新的重试。活跃流式读取阻断发布。屏障失败、已关闭句柄和未通过清单的重开不能冒称恢复成功；不按名字清理或覆盖变化。

新增 20 项真实场景包括 420 项跨页枚举、Unicode/空目录、33 MiB 摘要与流、严格文件/祖先 pin 的独立写入/删除/改名拒绝、实际 SQLite worker 存活时拒绝及停稳后核验、移动后 receipt 冷开、成员/权限漂移、硬链接/junction/宽权限/readonly 拒绝、预算/读者/取消、真实关闭屏障句柄、显式重试与提交前后宿主退出。复制与删除不在本节资格内。

该历史切片完整源码/中文空格目录 ZIP 解压 Node/Electron 均 159/159，无失败/跳过；native SHA-256 `eb7ba2a23f2e466db4069d1df684dd67b493f838be416dac980997813068b185`。证据 `W1/build-windows-native-private-tree.json`、`W1/private-tree-hosts-final/native-filesystem-hosts-validation.json`、`W1/private-tree-component-roundtrip-final/component-roundtrip.json`。重跑共享门控为 15 pass/14 平台 skip，相关存储安全 27/27；原始共享全文件七项失败仍保留。139 项移动二进制转为历史证据。

当时下一步为以树清单为基线实现固定身份复制/删除，再接共享项目初始化 intent、来源副本、发布/重试与完整 Work。当前入口尚未接生产初始化；恶意映射/安全句柄竞态、原生未知 rename、命名空间/断电及多步业务事务继续待资格化，W1 仍 unsupported。

## 私有树清单约束复制与固定身份逐项删除（2026-11-02）

本轮补齐 `openExperimentalPrivateTree().copyTo()`：目标根和子目录由 FILE_CREATE 排他创建并保留原 HANDLE/真实 ID；源文件经固定句柄分块读取、清单摘要核对、私有暂存 flush 后无覆盖发布，重开时核对已发布 ID，随后保持 pins 并复核目标成员/内容和源清单，执行文件/后序目录/父目录屏障。已有根、晚到文件赢家及新增成员均保留；错误携带 privateTreeCopy.created 与已知 ID，发生创建后报 committed/uncertain。复制保持结构和内容，按私有策略重建权限/属性，不宣称克隆所有源元数据。未发布暂存仅经原 HANDLE 清理；部分已发布树不按名称回删。

删除须显式以 `{deletion:true}` 捕获，并提交此前批准的完整清单 SHA-256；清单包含根/条目身份、内容和 ACL。文件和子目录从捕获起请求 DELETE，删除前无释放再按路径重开的窗口。每项复核剩余成员、文件摘要和原生身份/ACL后，对同一 HANDLE 设置 disposition；文件后按后序删除空目录，每步同步受影响父目录。晚到成员停止进度，原生 nonempty 拒绝兜底；这不是整树原子事务。privateTreeRemoval.removed/rootRemoved 记录实际进度，部分失败/取消报 committed/uncertain。开始删除后的 lease 禁止继续读/写/重放，须冷开核查并批准新清单；发布移动后也须从新位置重开才能复制/删除。

新增 20 项真实场景，私有树文件现共 40 项，完整源码和中文空格 ZIP 解压后的固定 Node/Electron 均各 179/179，零失败/跳过。覆盖 33 MiB/块间取消、真实 SQLite 副本草稿/receipt 冷开、独立目标赢家、源/目标新增成员、部分删除、新清单恢复、活跃读者、真实关闭屏障句柄、根已删后故障及真实宿主退出。首轮 36 项中五项失败原日志保留：一项 fixture 对非私有测试根执行私有枚举；其余暴露单字符目标 rename 的结构体长度不足（Windows 错误 24），已修复文件/目录共用长度计算为至少 sizeof(RenameInformation)，并增加单字符文件/目录实际回归。

该历史切片 native SHA-256 `c2627855b77ef7c6416d3a8f25724d259ed3971d11d6d9d2c960f4594a72d2bd`。证据 `W1/build-windows-native-tree-mutation.json`、`W1/tree-mutation-hosts-final-v2/native-filesystem-hosts-validation.json`、`W1/tree-mutation-component-roundtrip-final-v2/component-roundtrip.json`。重跑共享门控 15 pass/14 平台 skip，相关存储安全 27/27，日志为 `W1/shared-filesystem-gate-tree-mutation.tap`、`W1/shared-storage-worker-tree-mutation.tap`；完整共享文件原七项失败仍保留。解压验证使用固定开发 Electron，组件包不等于 W5 应用包；159 项及其二进制为历史切片。

下一步接入共享 ProjectStorage 初始化的 intent、来源副本、发布、冲突与逐阶段恢复，再接完整 Work/index/ref/账本和三个多步事务。仍限定本地私有可写 NTFS/既存父目录、默认 1 GiB/10000 后代，调用者须停稳 writer；恶意映射/安全句柄竞争、原生 UNKNOWN、命名空间/断电和完整产品持久化未资格化。W1 仍 unsupported、managedExecution.ready=false；W2 owner/Job/恢复来源和 W4/W5 实际应用链仍未完成。

## 共享项目初始化及检查点恢复（显式 Windows 实验，2026-11-02）

新增 `main/project-storage-io.mjs` 文件效果层，沿用同一 ProjectStorage 初始化状态机。默认入口继续要求生产持久化能力；仅同时传入 `experimentalWindowsRoot` 和 `experimentalWindowsInitialization:true` 才选择 Windows 显式实验实现，仅传 root 的旧离线/目录数据库用法仍拒绝初始化。没有在 UI、启动脚本或平台矩阵启用此选项，返回和目录记录明确携带 barriers-completed / namespace-not-qualified。

原生新增 `openAnchoredDirectoryIdentity`：只开已有目录，数据读取及 READ_CONTROL，读写共享但拒绝删除共享，保持实际 ACL 快照，不要求用户项目根具备私有元数据权限。初始化期间持有此根并在阶段/最终返回复核；嵌套持久化和 SQLite 打开仍兼容。项目和元数据身份以完整卷号/128 位 File ID 存储，避免 JS 数值 ino 丢失精度。元数据与候选的创建维持受保护私有 ACL；JSON 文件/父目录 pin 贯穿真实 SQLite 身份读取。

首次登记、已有登记冷开和 prepared/staging/staged/source-preserved/published/complete 六阶段恢复已实际通过。候选根排他创建后，先持久化分配 ID 再写 marker；未完成候选和有分配证据的无 marker 候选保留完整清单，显式重试改用新候选名，不因 marker 相符递归删除新加入的内容。安全或归属无法核验就保留并拒绝。完整候选的根身份/内容/ACL 清单在发布前入账；在 source-preserved 或 published 恢复时比对同一完整清单，不能仅凭复制来的 operation marker/SQLite 接纳替换目录。发布后真实关闭父句柄故障保留 committed/uncertain；冷开按已移动实体核查，不重复移动。`retry()` 的独立数据库探针保留显式 native SQLite root，复用已有回执核查。

新增 `windows-native-project-storage.test.mjs` 22 项，完整源码及中文空格 ZIP 解压后的固定 Node/Electron 各 201/201，零失败/跳过。真实验证 Unicode 首次登记、项目/本机/恢复草稿与 operation receipt 冷开、六阶段 checkpoint、部分/无 marker 候选保留、独立晚到赢家、候选/已发布目录替换、根权限/metadata ACL/hardlink 漂移、发布后关闭父句柄、分配/发布后的真实宿主退出及 scoped retry。受控 closed=false 回复只证明未确认关闭时的栅栏，不代签 native UNKNOWN 注入。最初探针发现把公开项目根当作私有链祖先的错误，改为从已固定项目根创建私有子链；测试清理对象及 --input-type 继承问题也已修正，失败日志保留。

当前 native SHA-256 `09917c382f9e5cd47895baf7fbf0bc400735fc2b3f330afa233d6420926997cf`；证据 `W1/build-windows-native-project-init.json`、`W1/project-init-hosts-first/native-filesystem-hosts-validation.json`、`W1/project-init-component-roundtrip-first/component-roundtrip.json`。共享门控重跑 15 pass/14 平台 skip；相关存储安全 27/27，完整当前文件复跑 34 项为 27 pass/7 fail，六项仍调用禁用的默认初始化、一项假定已打开 SQLite 可 unlink。日志 `W1/shared-filesystem-gate-project-init.tap`、`W1/shared-storage-worker-project-init.tap`、`W1/shared-storage-worker-project-init-full.tap`。179 项及其二进制为历史切片；组件 ZIP 使用固定开发 Electron，不是 W5 整应用。

资格限定为同一显式 scope 内的本地 NTFS 项目/profile。外来元数据确实调用现有 recovery-source-ownership 选择器，当前返回 RECOVERY_OWNER_UNVERIFIED，在新初始化 intent 与来源修改前拒绝。共享来源复制/备份/清理已接平台文件效果，但完整 Windows 路径须待 W2 真实归属能力后验收，没有用 stub 放行。W1 仍 unsupported、managedExecution.ready=false。下一批继续 MaterialStore 的固定句柄对象读写、完整 Work/index/ref/账本和多步事务，并推进 W2 owner/Job/恢复来源；命名空间/断电、恶意映射/安全竞争、真实 UI 与完整候选包均未取得资格。Linux/macOS 本轮未运行。

## 共享材料对象库（显式 Windows 实验，2026-11-02）

复用共享 MaterialStore 的摘要、大小限制、不可变 CAS 和流式导入流程，新增 `domain/material-store-io.mjs` 文件效果层与 `platform/windows/experimental-material-store.mjs`。显式 `experimentalWindowsRoot` 才选择 Windows 原语；共享生产选择器保持禁用。ProjectStorage 的项目材料、恢复材料、流式访问与恢复对象提升均传递此作用域，已有初始化仍额外要求双选项。

原生 `openPrivateObjectRead` 只请求数据读取及 READ_CONTROL，不请求数据写入或 DELETE；多个读者可共存，实际拒绝独立数据写入、unlink 与目录改名。校验受保护父目录、单硬链接对象、完整卷号/128 位 ID、内容摘要与 ACL/身份快照，读句柄和父链跨回调保留。对象目录的私有 ACL 快照进入 stage 所保留的链，在异步生产者期间变宽即拒绝发布，不只是开始时检查一次权限。只读文件属性允许读取；不能通过对象 reader 刷盘或删除。

写入排他创建自有 stage，每个输入块在异步写入前复制，按 256 KiB 原生块推进；flush 文件后使用 no-replace HANDLE rename，释放 writer 后核验实际赢家并 flush 固定父目录。既有损坏、硬链接、junction 或权限异常对象不会被修复或覆盖。发布后故障保留 committed/uncertain，并携带目录、digest、字节数、发布事实及 stage 完整 ID。真实宿主在 staging 退出留下的 pending 文件保留，不按名称清理/冒认；已发布退出的对象可冷开核验，但这不证明断电持久性。

新增 `windows-native-material-store.test.mjs` 22 项，完整源码及中文空格 ZIP 解压后的固定 Node/Electron 均各 223/223，零失败/跳过。覆盖空/Unicode/二进制冷开、12 路并发发布/读取、独立进程赢家、33 MiB 流式复制、readonly、ACL/link/损坏拒绝、输入块变化、回调/生产者失败、真实关闭父句柄、阶段宿主退出，以及共享 ProjectStorage 材料冷开、离线恢复和同 digest 提升。首轮 16 pass/1 fail 为测试在实际 SQLite 尚未关闭时改名，被 Windows 拒绝；修正为先确认关闭，保留原日志 `W1/material-first.tap`。补充私有父目录 ACL 漂移用例时确认 stage 必须保留该目录策略快照，已使用现有私有目录 lease 连接同一链。

材料批 native SHA-256 `fa279a98d2deae3aa7e16c3184d1a6c33566b5c8b794b0648415267b980aeed2`；构建退出 0，证据 `W1/build-windows-native-material.json`、`W1/material-hosts-final/native-filesystem-hosts-validation.json`、`W1/material-component-roundtrip-final/component-roundtrip.json`；22 项专项 `W1/material-final.tap`。共享 MaterialStore/能力/文件/持久化共 38 项：23 pass/15 平台 skip、0 fail（含旧 MaterialStore Windows symlink 场景跳过；新 native junction/hardlink 场景已实测），日志 `W1/shared-material-gates-final.tap`。当前完整存储安全重跑仍 34 项：27 pass/7 fail，明确选择的 27 项通过，日志 `W1/shared-storage-worker-material-full.tap`、`W1/shared-storage-worker-material.tap`；六项使用禁用的默认初始化、一项假定已打开 SQLite 可 unlink，未删除或绕开这些失败。

资格仍限定同一显式 scope 的本地 NTFS。同步 native 块带 JS yield；未知 pending 的归属恢复/垃圾回收、恶意映射/安全句柄竞争、原生 UNKNOWN 故障注入、namespace/断电、完整 Work/acceptance/index/ref/账本及三个多步事务未验收。下一步接这些共享业务消费点并推进 W2 owner/incarnation/Job/恢复来源。W1 仍 unsupported、managedExecution.ready=false；W2/W3 未完成，W4 真实工作面与 W5 整应用包仍 not-run。组件 ZIP 的 Electron 使用锁定开发宿主，不等于随包 Electron 或 W5 应用。Linux/macOS 本轮未运行。

## Windows 共享 Work 组件续批（2026-11-02，历史 244 项）

在 `experimentalWindowsRoot` 与实验 filesystem 的显式注入下，现复用共享 `ExecutionWorkspace`，完成真实 Git worktree 准备、输入冻结、候选发布、SQLite 报告回执、类型化合入授权核对、接受/放弃、文件与 index/ref 更新、清理以及显式冷恢复。新 `execution-workspace-io.mjs` 只抽出平台文件效果，默认路线保留原共享逻辑；生产 selector 未启用。测试使用真实 ProjectStorage 登记、SQLite 与随包 Git，以及最小合成 store，**没有经过完整 Workspace.open、Controller、业务决定账本或实际 Worker 进程**，回调 `isActive` 不能证明 W2 停稳/归属。

Windows 文件效果提供私有 manifest 读取/CAS、固定源 HANDLE 的排他证据复制、完整卷号/128 位执行目录身份及 Git 锁身份。Git 元数据父目录保留实际 ACL，不修复为私有；仅自有锁文件要求受保护 user-only 策略。锁的完整 File ID 在创建 HANDLE 释放前写入 intent，恢复同时核对 ID 与 token；复制 token 不能接管替换锁。index/ref 使用已批准摘要和锁内版本 CAS，保留独立赢家、用户 staged/磁盘/恢复草稿。

提交后屏障失败/未知结果保留 candidate、实际字节、全部自有锁与 recovery-held 事实，只由显式冷 `finish` 重核版本后继续。真实宿主分别在 locks-held、files-installed、ref-published 退出后可冷恢复同一 commit。额外竞争测试揭示：已安装文件的冷恢复若未取得全部锁，原异常分支会尝试回滚；已修正为直接保留现场并拒绝。修复前日志 `W1/work-lock-recovery-before.tap` 为 1 fail，修复后 `W1/work-lock-recovery-after.tap` 为 1 pass。未提供任何依赖/准备资源声明的冻结输入可返回真实空供给报告；声明了 payload 的项目仍拒绝 `DEPENDENCY_PLATFORM`，未伪造可用模块。

新增 `windows-native-work-lifecycle.test.mjs` **21 项**，完整组件源码及中文空格 ZIP 解压后的 Node 22.23.4 / Electron 44.9.1 Node 模式均各 **244/244**，无失败、跳过或取消。native SHA-256 `24c50e7a9acf52fd77328621c676dc71020efaf0287bc232e3ef55a9ad342eda`；构建退出 0，日志 `W1/build-windows-native-work-first.log`、收据 `W1/build-windows-native-work.json`。当前证据 `W1/work-hosts-final-v2/native-filesystem-hosts-validation.json`、`W1/work-component-roundtrip-final/component-roundtrip.json`，包括实际运行命令、宿主与源码摘要。早期 243 项双宿主通过是补充恢复竞争用例前的历史结果。共享材料/能力/文件/持久化重跑共 38 项：23 pass/15 平台 skip/0 fail，日志 `W1/shared-work-gates-final.tap`；存储安全沿用材料批的 27 pass/7 fail（完整文件）与定向 27/27，本轮未重跑，不外推为当前完整产品通过。

范围继续限定显式入口、本机 NTFS、现有父目录与 100644。普通回调/检查点故障与真实宿主退出、关闭父 HANDLE 的提交后故障分别标识；后者不是磁盘 I/O、断电或原生 UNKNOWN 注入。Git 清理仍是完整 ID/候选核查后的共享 `git worktree remove --force`，没有新增整树原子 HANDLE 删除合同；恶意清理窗口竞争未验收。依赖/准备资源复制、hooks 接受、legacy 迁移、扩展 Git 布局、路径/mode/安全元数据、TxF 产品可用性政策、完整 namespace/断电仍未资格化。

下一批优先接 `WorkChanges` 私有 archive intent/manifest 与完整业务报告/决定账本（当前仍调用全局 unsupported persistence），再补依赖/准备资源原生复制及三个多步事务；W2 原生 incarnation/Job/来源停稳证明是完整 Worker 与外来恢复链的依赖，之后才进入 W3 能力决定、W4 真实 Electron/Pi 工作面与 W5 整应用便携包/干净环境。W1/W2/W3 仍 unsupported，W4/W5 not-run，managedExecution.ready=false。

## Windows WorkChanges 与共享业务账本续批（2026-11-02，当前）

`WorkChanges` 现通过 `work-changes-io.mjs` 分离平台文件效果；显式 `experimentalWindowsRoot` 使用私有 intent/manifest CAS、排他分配、在释放分配句柄前记录完整卷号/128 位 Git 证据库 File ID，并在私有 Git 命令与 blob 流期间保留目录身份/ACL pin。既有未记账证据库保留并拒绝接管；复制 Git 字节到另一个实体也不能取得原归属。归档、不可变对象/receipt、核验、恢复及是否允许放弃仍使用共享状态机。放弃只按已固定的原生 DELETE 文件 HANDLE 删除本地 manifest/intent，保留项目可携的不可变闭包；部分删除/屏障失败保留准确 ID 与 committed/uncertain，不按名字猜测清理。

实际 Git pack 带只读属性。私有树新增显式 `rootAccess=readwrite` 与 `fileAccess=read`，读者可保留根身份、捕获/重核整树名字/ID/字节/ACL，执行目录与父目录 flush；该视图拒绝完整文件 `sync` 和根发布。归档保留 pack 属性，由固定 Git 写入器运行 `core.fsync=all`，本地 intent 明确记录 `directory-barriers-completed` 与 `files=not-flushed-by-this-lease`。这不是原生文件 flush、完整 namespace 或断电资格；新增接口没有改变原默认 writable/move 树合同。

共享 `Workspace` 构造器、报告工件快照与校验现可显式传递 filesystem。20 项新增 native/shared 用例中，3 项使用真实 Workspace/SessionIndex 方法及 SQLite：提交/激活、候选/HTML 报告、WorkChanges 归档、项目报告回执、用户接受决定与精确 mergeAuthorization 同事务落账，冷组件重载后使用已落账授权实际合入；集合 CAS 保留外部赢家、草稿与待核对候选；实际 SQLite 提交后受控丢回调会栅栏当前实例，显式核对转为 inspection-only，不自动续跑队列。测试直接构造未取得宿主归属的业务组件，未调用 Workspace.open/Controller、未启动 Pi/Worker、未伪造 stopped 事实，不能据此声明宿主或进程资格。

其余场景包括 SHA-1/SHA-256、文本/重命名/空文件/删除/二进制、33 MiB 流与文本预算、用户 staged/磁盘/恢复草稿、实际源 GC 与本地缓存丢失、真实宿主在 intent/manifest/receipt 三阶段退出、实际 SQLite 回执提交前/后的回调故障、引用状态拒绝清理、ACL 漂移/损坏赢家保留，以及真正删除后关闭父 HANDLE 的屏障故障。后者与受控业务回调故障分开留证，均不冒充原生 UNKNOWN 或断电注入。早期 `W1/work-changes-first.tap`、`work-changes-second.tap` 保留根 lease 冲突/只读 pack 未支持及 fixture 前置失败；业务首轮 2 pass/1 fail 是缺少共享 SessionIndex 初始化，改为调用实际初始化方法后 3/3，原日志保留。

当前完整组件源码与中文空格 ZIP 解压后的 Node 22.23.4、Electron 44.9.1 Node 模式均各 **264/264**，无失败、跳过或取消。证据 `W1/work-changes-hosts-final/native-filesystem-hosts-validation.json`、`W1/work-changes-component-roundtrip-final/component-roundtrip.json`，逐文件源码/资源摘要随包核对。native SHA-256 `24c50e7a9acf52fd77328621c676dc71020efaf0287bc232e3ef55a9ad342eda`，本批未改 C++/构建入口，复用已实际成功的 `W1/build-windows-native-work-first.log` / `W1/build-windows-native-work.json`；`W1/build-windows-native-work-changes.json` 记录复用来源和逐项未变的 native 源码摘要，不宣称新编译。共享材料/能力/文件/持久化重跑 38 项：23 pass/15 平台 skip/0 fail，日志 `W1/shared-work-changes-gates-final.tap`。完整存储安全 27 pass/7 fail、定向 27/27 仍是材料批历史证据，本批未重跑。

下一关键依赖为 W2 原生进程 incarnation/HANDLE、Job Object 与真实归属/停稳证明，以支持 Workspace.open/Controller 和外来恢复来源。W1 仍需依赖/准备资源复制、Plan Tree/worker-home 技术闭合、三个自定义事务组、路径/mode/扩展元数据/TxF 政策及持久化资格；私有 Git 后代恶意替换和并发清理授权竞争亦未验收。W3 能力决定、W4 真实 Electron/Pi UI、W5 整应用/干净环境继续待办。W1/W2/W3 unsupported，W4/W5 not-run，managedExecution.ready=false；组件 ZIP 使用锁定开发 Electron 宿主，不能视为随包应用资格。Linux/macOS 本轮未运行。

## W1 为监督者交付原生租约（2026-11-02）

新增custody-transfer.h及anchored-custody.inc，createSupervisorCustody只接收原生writable非deletable私有文件lease和原生SQLite lease。前后核验原目录链/安全策略/文件实体，降权DuplicateHandle复制同一FileObject，opaque type-tagged bundle仅提供close，不能通过JS字段或JSON重建；W2只能一次性消费。anchor保留不可变字节事实，DB保留File ID/单链接/属性/ACL并允许共享SQLite事务；两侧目录链和原有已固定ACL一并保留，未给原未固定ACL的祖先补造保证。256个实体/每ACL4096字节上限越界明确拒绝，数字HANDLE不进入JS和登记。helper运行不替代SQLite锁、sidecar验证或来源catalog/project.sqlite归属合同。

W1文件桥已实际重建；源码Node/Electron及中文空格ZIP解包Node/Electron完整回归各264/264，源码与解包回执为W1/custody-source-final/native-filesystem-hosts-validation.json及W1/custody-roundtrip-final/component-roundtrip.json；原生双构建W2/build-custody.json。首轮W1解包Node在并发suite期间超过240秒，原failed回执保留；最终串行批次未放宽同一timeout。W2四宿主134/134含独立于SQLite连接的helper单独持有/竞争写入与rename验证。新组件证据不补齐W1多步事务、namespace/断电、来源恢复、完整业务/产品工作面及W5整包。W1仍unsupported，生产矩阵未启用。

## 来源租约与只读manifest并存（2026-11-03）

createSupervisorCustody 现在接收原宿主pair，或完整五个原生租约加来源SHA-256；部分/错序角色、可写manifest、缺失/错误摘要拒绝。manifest v3将摘要与File ID/ACL/角色一并固定。SQLite lease新增受核验的identity()；shared checkedMetadata改用只读对象lease，与长期只读project.json保管并存。原生W1已实际重建，源码和中文空格ZIP解包Node/Electron各264/264；当前证据W1/source-binding-source-final及W1/source-binding-roundtrip-final，双构建W2/build-source-binding.json。来源修改/缓存过期/同值修订/ABA/提交后UNKNOWN等9项和4种helper独立保管场景已在W2四宿主各143/143中覆盖。跨库原子性及业务冷恢复仍未资格化，生产W1保持unsupported。详见windows-process-design.md当前批次。

## 共享 Workspace 文件效果接入（2026-11-03）

显式 experimental-workspace-io 将原生私有目录、SessionIndex create-only 对象、有界 HANDLE 读取、Plan Tree SHA CAS/目录屏障接入真实 Workspace.open/Controller.open；MemoryVersion 通过注入复用共享内容版本规则。宿主/runtime 绑定与16项公开入口检查见 windows-process-design.md 当前批次。因 Workspace/SessionIndex 共享源码变化，本批实际重跑 W1 源码和中文空格ZIP解包 Node/Electron，各264/264；回执 W1/workspace-open-source-first/ 与 W1/workspace-open-roundtrip-first/。原生二进制未变，复用最近实际构建。Worker 目录归档明确拒绝；依赖/资源与完整事务/产品 W1 资格仍待补齐。

## 实际 Worker 文档与完整 home 归档（2026-11-03）

共享文档编辑保存versioned intent后调用原生SHA CAS，按实际目标摘要协调提交后丢回调/重复调用；外部赢家保留。Controller显式接入ExecutionWorkspace/WorkChanges和工件摘要读取。共享closure在原Windows owner退休证明下，持久化完整private home的File ID/内容ACL清单后无覆盖移动；实际config/sessions日志与配置全部保留。移动后失去回调、替换源/目标及内容漂移的真实闭环见windows-process-design.md当前批次；不声明凭据删除、冷宿主恢复或完整目录事务。

本批共享源码与3项文档测试实际重跑，W1源码/中文空格ZIP解包Node、Electron每组267/267；W2每组190/190包含真实Worker接受/Git/归档重试及warm reopen。证据W1/worker-flow-source-first/、W1/worker-flow-roundtrip-first/、W2/worker-flow-roundtrip-first/。Native/Pi摘要未变，复用最近实际构建；生产选择、完整依赖/准备资源复制、多步事务/断电持久性仍待完成。

## Windows 公开源依赖与准备资源供给（2026-11-03，历史批次）

共享 worktree-dependencies 抽离文件效果，继续统一判定冻结 package/lock、资源声明、出处、已有目标与供给报告；修复根声明被重复处理。显式 Windows versioned adapter 仅增加窄 provisioning 接口，supported=false、泛用 chain/rename 与生产能力矩阵保持禁用。

新增原生只读 public-source directory 类型，与私有写入类型用不同 native receiver tag 隔离；借用 private mutator 也真实拒绝。固定祖先/子目录/单链接文件 HANDLE，观察原 owner/group/DACL、不修复源 ACL，逐级相对枚举，冻结名字/File ID/内容/ACL摘要和有界流。复用同一个树清单/流式独立复制实现，将普通 ACL 源复制成排他私有目录与文件，并核对创建 ID、字节和文件/目录屏障。目标以无覆盖 native move 发布，既有目录/文件/交接点及晚到赢家保持原样。门文件读取 HANDLE 保留至结束，独立进程改写实际被拒绝；发布前复核源成员/内容。NTFS 必须释放后代后移动，释放窗口中的真实字节修改会在移动后复核中报告 committed/UNKNOWN，保留赢家而不伪称原子快照。

暂存 marker 先同步。清理只接受当前操作原始分配的整树 File ID 与字节，新增或替换内容使清理拒绝；未知旧目录不按 workId marker 擅自删除。旧 matching stage 经原生读取 marker 后要求显式恢复，阻止新复制；真实复制宿主中途 exit 后新宿主实测保留原 marker/部分负载，未再分配。已记录 copy-result-unknown 的共享报告在普通 prepare/reopen 中原样保留，不自动重放。尚未实现旧暂存/UNKNOWN 的显式冷协调，不能把“保留并拒绝”写成恢复完成。

新增19项：普通源ACL/不同native类型权限、Unicode/空目录/33MiB、真实独立Node导入与写入隔离、源/Worker冻结不符、已有目标/交接点、源硬链接/交接点拒绝、复制中源新增、独立门文件写入拒绝、晚到目标、发布回调丢失、真实宿主退出、清理新增赢家、发布释放窗口变化、根/嵌套依赖与资源、声明无效/已跟踪资源，以及实际共享 Work.prepare→候选Git排除。公开 Controller 的真实三Pi owner闭环新增冻结依赖/资源，实际Worker执行目录的Node可导入/读取；原文档工具→候选→精确人工审校/Git→原owner退休→完整home归档中断重试→warm reopen仍通过，Provider只收到3次本机请求。没有宣称模型执行过依赖工具、安装脚本或联网安装。

实际重建 W1 native，构建回执 W1/build-provisioning.json；process/helper/Pi摘要核对复用既有构建。最终W1源码Node/Electron、中文空格ZIP解包Node/Electron每组286/286；W2同样四宿主每组190/190。共享相关52项为50pass/2Linuxskip；平台文件/持久化回归详见W1/provisioning-platform-first.tap。权威回执 W1/provisioning-source-final/native-filesystem-hosts-validation.json、W1/provisioning-roundtrip-first/component-roundtrip.json、W2/provisioning-roundtrip-third/process-component-roundtrip.json；最终完整性 W1/provisioning-final-integrity.json。初轮专项8pass/6fail、初轮全量旧假设失败、W2首轮静态测试import收集失败均保留。W2第二轮三个宿主190/190、解包Electron189/190：只读监督者测试假定Job-empty时原后代HANDLE立即signalled；改为分别等待各原HANDLE实际退出后复核，生产停稳规则/native未变。监督者定向Node/Electron各12/12，再按最终源码完整重跑。

范围：本机NTFS x64、普通单链接文件/目录、每树最多10000项/1GiB。源symlink/junction/hardlink、未资格化别名/卷拒绝，不悄悄跳过后宣称可用；目标复制屏障为namespace-not-qualified。源链接实体化、更大真实项目负载、旧暂存/UNKNOWN冷协调、完整生产消费/多步事务、历史进程成员与pending/工具/native投影冷恢复、普通权限产品执行、实际Electron工作面及整应用包仍待验收。W0 passed；W1/W2/W3 unsupported；W4/W5 not-run；managedExecution.ready=false，能力矩阵未变。

## Windows 供给完整副本的持久意图与冷协调（2026-11-03，历史批次）

共享 worktree-dependencies 继续统一冻结门文件、资源声明、出处、报告和已有目标策略；ExecutionWorkspace 在原 Work manifest CAS 中保存独立 operation ID、Work/源/目标/冻结门绑定、分配前命名与父 File ID/实际 ACL、已分配暂存根及完整复制后的原始 ID/内容/ACL 清单。普通项目父目录只观察实际 ACL，不改权限；private-only 写入检查不放宽。恢复入口 reconcileDependencies 使用同一Work串行队列，先要求项目在线并验证 Work 的原 Git/执行目录身份。默认 prepare/reopen 对未决意图仍保持拒绝，显式协调先于普通 existing-target 快捷路径；源/Worker资源声明发生变化、当前无法再发现原负载时，共享报告仍从持久意图补回原UNKNOWN，不能用新声明抹去旧分配。

完整复制已获确认后退出，可复核原父/暂存实体及清单，继续发布同一副本；发布前先保存意图，发布后退出或丢回调则核对原目标的完整清单、重新完成真实文件/目录屏障，零重复移动。清理前持久化原剩余成员清单，每次删除前记录 pending，删除和真实父目录屏障后记录 remaining；新宿主核对仅原 pending 可能缺失的精确剩余树，恢复到根删除后的最终保存窗口。原目标/源/门文件/父目录发生变化、同字节换 File ID 或新增暂存成员均保留 UNKNOWN/现场，晚到目标赢家不被删除。manifest CAS 未获确认时直接中断后续发布/清理/其他资源，不把不确定提交当作已失败。

新增11项、供给专项共30项：真实子进程在完整复制、移动前、发布后、marker删除后和根删除后退出；原副本/发布零重放；晚到目标与清理恢复；字节/相同字节身份/成员/绑定/源/门/父替换；部分复制退出继续UNKNOWN；CAS提交前失败或真实提交丢回复阻止后续资源。实际共享 Work.prepare 注入真实发布后丢回调，新 ExecutionWorkspace 显式协调后继续生成真实 Git 候选，依赖/准备资源保持候选排除。已有实际Controller/三Pi Worker审校/Git/退休/归档/warm reopen场景也完整重跑。

W1 native实际重建，build-provisioning-recovery.json；源码与中文空格ZIP解压 Node/Electron 各297/297，无失败/跳过。W2 process/helper/Pi按原构建摘要复用；源码/解压四组各190/190。共享57项为55pass/2Linuxskip。证据 W1/provisioning-recovery-source-authoritative/native-filesystem-hosts-validation.json、W1/provisioning-recovery-roundtrip-second/component-roundtrip.json、W2/provisioning-recovery-roundtrip-second/process-component-roundtrip.json，最终完整性 W1/provisioning-recovery-final-integrity.json。开发first/second/third的ACL类型/句柄冲突与fifth旧Linux默认入口10项拒绝及一项fixture预期错误全部保留；最终没有放宽生产检查。

本批取得的是已确认完整副本的显式冷协调。复制中途/原分配身份尚未入账的现场继续UNKNOWN，marker不授予删除权；尚无逐文件分配前账本/部分字节协调。每树10000项/1GiB、Work证据16MiB有界，重复完整CAS保存的大规模性能未资格化。namespace/断电屏障仍未取得产品保证，不等于系统重启、宿主pending/tool/native投影或owner冷退休恢复。源链接/更大项目、完整生产消费/多步事务、W3普通权限、W4实际Electron/IME/剪贴板/多窗口/应用重启、W5整应用包仍待验收。W0 passed；W1/W2/W3 unsupported；W4/W5 not-run；managedExecution.ready=false，能力矩阵未变。

## Windows 真实桌面启动与私有 profile（2026-11-03，历史批次）

基于 release/alpha.4 的真实 main.cjs 入口，修复窗口前演示登记表 eager save 使用 Linux persistence 而退出的问题。共享 GuidedDemo 仍统一恢复 epoch、保留 inflight UNKNOWN 和串行 mutation；桌面记录文件效果单独抽出，Windows 只选择私有 profile 内有界原生 HANDLE 读取、保护 ACL 子目录、SHA CAS 文件发布与实际屏障。演示登记保存使用原始读取版本；DesktopHost 外观/修改者设置也绑定观察版本，writeVersioned 不为旧 mutation 偷换成新读取版本。独立进程赢家、损坏 JSON、ACL 漂移均拒绝并保留。Chromium 启动前建立 desktop/omp/migrations 私有子目录；已有宽松 ACL 不自动修复。

DesktopHost 仅为私有 profile catalog 显式传递原生 ProjectStorage/SQLite root，实际保留原始目录和数据库 HANDLE、拒绝独立重命名；没有启用项目 initialization。真实 project.pick 在项目 .nozeli 分配前仍返回 PERSISTENCE_UNSUPPORTED。project-git 的全局能力检查、POSIX 身份和 path 写入尚待抽离/接入，不能为了阅读跳过 Git 初始化或在不安全路径上继续写。

新增6项定向测试，源码 Node/Electron 与解压包内 Node/重命名 Nozeli.exe 的 Node 模式四组各6/6，无失败/跳过。固定入口 node tools/test-suites.mjs windows-desktop-profile。实际渲染器构建退出0；受影响共享回归6项为3pass/3Linuxskip，不宣称 Linux/macOS 实机回归。本批未修改 native/Pi 构建输入，逐项核对最新 W1 build-provisioning-recovery、W2 build-input-custody/build-cold-journal 后复用二进制，没有伪称重编译。

实际制作完整目录候选闭包，包含 Electron、当前 src/renderer/assets、生产依赖、W1/W2 native/supervisor、固定 Node/Pi/MinGit 及许可证资料；25,270文件、1,240,745,718字节，ZIP SHA-256 为 7e890a55a287a5ed02ca759fa847daefb93dfc1d083cd010e54ebc03fd1a5d32。中文和空格目录解压，逐文件摘要/ZIP CRC/运行后源码一致性通过。包内 Pi/固定 Node/MinGit 在仅 Windows System32 的 PATH 下实际解析/执行版本检查；未启动 Pi 或模型。

源码客户端和解压 Nozeli.exe 分别执行“显示原生窗口→稍后配置→真实IPC保存外观与修改者设置→准确拒绝项目初始化→正常关闭→全进程重启→读回精确设置/空恢复表→正常关闭”，各4项检查、两个进程均退出0，无 renderer error。测试使用全新合成 profile，当前继承宿主为非管理员令牌；没有读取个人项目/账号或发起付费请求。记录 native isVisible；早期 renderer document.visibilityState 在窗口被遮挡时为hidden，不以截图或页面就绪冒充物理输入/IME资格。

证据 W4/profile-qualification.json、W4/profile-suite-final-cas/report.json、W4/profile-extracted-final/report.json、W4/startup-source-authoritative/report.json、W4/startup-extracted-final/report.json、W4/profile-package-final/package.json、W4/runtime-extracted-final.json、W4/profile-final-integrity.json。开发失败、历史旧快照和打包中源码变动被拒绝的回执全部保留。

范围仍是隔离测试实例的启动/私有设置和空 catalog。未验收真实账户 singleton/启用自动更新、旧 profile ACL/配置锁迁移、项目登记/Git baseline/源读写/草稿/批注、物理IME/系统剪贴板/多窗口、托管业务冷恢复和干净账户/DLL闭包。应用候选可启动不等于可日常工作或可发行；随包合成测试只用于本地资格验证。全局能力矩阵未放行，managedExecution.ready=false；W0 passed，W1/W2/W3/W4/W5 unsupported。W4/W5由not-run改为unsupported，表示已实际运行部分场景但完整门未通过。

## Windows 项目阅读、编辑与草稿主链（2026-11-04，历史批次）

基于 release/alpha.4 继续落地。DesktopHost 已选择分别核验 profile 和每个已选择项目的原生作用域；主线程保留项目根 File ID/ACL 句柄直到全部数据库线程确认停止。未选择的 sibling 与 profile/project 重叠拒绝，项目同路径换实体保留外部赢家与原私有草稿。StorageDatabase 关闭同步封闭 admission，并等待关闭前已接收的 receipt reconciliation；实际停止未确认继续保留作用域，不以 request 已回复冒充 worker 已退出。

共享 ensureProjectGit 仍统一新建/已有仓库、敏感文件名排除、初始基线、ignore、index/ref、原 operation journal 和重试策略；文件效果抽到 project-git-io，Windows 选择原生目录身份/保留句柄、源 HANDLE 流、排他锁、原读取 SHA CAS、create-only index 和实际 flush。已有 dirty HEAD/index/源字节不覆盖，父仓库仅增项目范围 ignore，commit-prepared 之后不捕获后来的用户文件。公开 .gitignore 保留 owner/group/protection/全部 ACE；Windows 可规范化自动继承 bookkeeping。Windows 链接/重定向 Git 目录、含 reparse 的基线目录继续准确拒绝。

DesktopHost 源读取改用已选择作用域内的原生 HANDLE；文本保存沿用共享草稿/历史/批注映射状态机，在 TxF 锁内比较原先读取摘要。基线使用独立私有恢复材料库；外部原文变化、最终检查后的晚到写入、原文件删除/明确重建、外部 index/ignore 赢家都保留原事实。TxF 不可用时没有普通 rename 回退，namespace/断电持久性仍未资格化。Office 等调用点已传原基线摘要，但此批不为其完整界面验收签字。

固定测试入口 node tools/test-suites.mjs windows-desktop-project。本批36项（含原profile6项）：源码 Node/Electron 与解压固定Node/Nozeli.exe Node模式四组各36/36，无失败/跳过；独立实际进程验证草稿/材料冷重开。共享关闭回归10/10，renderer实际构建退出0。native/Pi源码输入未变，按W1/W2原实际构建回执逐项复核复用，没有宣称新native编译或Linux/macOS实机回归。

两套真实GUI在源码和中文空格解压Nozeli.exe均通过：第一套6项，窗口可见→稍后配置→项目pick/共享Git基线→HANDLE读→文本CAS保存→外部冲突/草稿保留→退出与全进程重开；第二套5项，实际Markdown→CDP鼠标选区及Shift+Arrow含中文锚点→本地批注与原始材料→键盘编辑/Ctrl+S→未保存文本恢复账本→全进程重启读回原批注。四套共8个应用进程正常退出0，无renderer error，child PATH仅System32。当前继承令牌非管理员；CDP键盘/选区不等于物理中文IME，未配置provider或调用模型。

新本地候选闭包共25,282文件、1,240,816,620字节，ZIP SHA-256 6f148de0fec5e0ae1d2631a0d17587aa908e78557f3fc0882da8161c22e58529；包含当前src/dist/assets、生产依赖、Electron/native/supervisor/固定Node/Pi/MinGit及许可证数据和合成验证文件。CRC、25,282解压文件摘要、770个src/dist与源码一致性、测试文件一致性、native输入与Git diffcheck均通过；无非忽略二进制进入Git。此为本地资格候选，不是安装器或完整发行。

证据：W4/project-qualification.json、W4/project-source-first/report.json、W4/project-extracted-first/report.json、W4/project-startup-source-authoritative/report.json、W4/project-startup-extracted-first/report.json、W4/project-reading-source-authoritative/report.json、W4/project-reading-extracted-first/report.json、W4/project-package-first/package.json、W4/project-runtime-extracted.json、W4/project-final-integrity.json。早期同步断言、祖先可写权限、SDDL bookkeeping、shell未绑定和一次真实关闭超时均保留。关闭超时后两次源码与一次解压真实阅读均正常退出；不据此宣称长时间关闭压力资格。

剩余：物理IME/系统剪贴板/多窗口、旧profile ACL/配置锁迁移与账户singleton/更新门、文件树变更/Office/TeX/终端等剩余消费、托管pending/tool/native投影/owner冷恢复、源链接与大项目、TxF可用性/完整namespace屏障，以及干净普通账户DLL/安装发行。项目根在storage存活期间保持pin，不宣称支持在线移动。W0 passed；W1/W2/W3/W4/W5 unsupported；managedExecution.ready=false，全局能力矩阵未放行。

## Windows 系统文本剪贴板、多窗口与关闭重开（2026-11-04，历史批次）

本批新增真实Windows交互验收，生产src/dist与上一项目批逐文件摘要一致；没有修改业务状态机或放宽能力。新增 tests/windows-desktop-interaction.mjs 与独立 Python ctypes/Win32 clipboard oracle。实际Ctrl+C/Ctrl+X、剪切撤销、独立Win32写入后Ctrl+V（CRLF转LF，中文/emoji/组合字符保留）、document.clipboard IPC和可信navigator.clipboard写入均经独立进程读取CF_UNICODETEXT核对。原剪贴板各格式只保存在oracle内存，拒绝无法安全恢复的handle格式；最终源码和解压测试均恢复各自开始前的6种格式，不输出原内容，更新的外部赢家继续保留。

真实双文档WebContentsView同时可见，分别键入只改变焦点文档；合成compositionstart期间拆出请求准确返回COMPOSITION_ACTIVE，原窗口/缓冲保留。结束组合后通过UI拆出为第二个可见原生窗口，再停靠；WebContents ID、generation、原DOM编辑器、精确Unicode缓冲、选区与真实撤销栈不变。截图仅记录宿主chrome或内容面，不冒充整个系统合成窗口。CDP键盘/合成composition不是物理中文IME/TSF候选证据。

随后双面关闭前新输入草稿，正常退出后核对磁盘原基线不被关闭覆盖，完整重开从恢复账本读回精确草稿；另做4组键入→正常关闭→全进程重开→逐字核对→正常关闭。源码和中文空格解压Nozeli.exe各7组检查、10个实际应用进程正常退出0、renderer errors为空；共20进程及8组追加编辑/重开。每进程释放调试listener，PATH仅System32，未初始化provider或调用模型。这个有界批次不代表长期压力、崩溃/系统重启，前批一次真实关闭超时仍无根因结论。

开发失败均保留：空executable参数、Python按Windows locale误解UTF-8 JSON、断言错误的内部composition码，以及忽略现有自动保存的磁盘预期。编码误判的早期second/third/fourth运行结束时保留了测试生成文本，未恢复测试前剪贴板；原内容只在已退出oracle内存，不能从日志还原。第五次起使用显式UTF-8并识别nonce合成赢家，最终源码和解压运行恢复各自开始状态。不能把最终恢复成功描述为恢复了整批调试前的剪贴板。

renderer实际构建退出0，共享WindowRecovery回归26/26。本批native/Pi输入未变，按原W1/W2构建回执核对复用，不宣称新native编译或新四宿主组件重跑。新本地资格候选25284文件、1240841844字节，ZIP SHA-256 d069790072937261dd11b4708a7061350973c2021f757022fa9dae511566aac6；CRC、完整解压摘要、770个当前src/dist与所有随包测试、native输入均核对；包内固定Node/Electron/MinGit/Pi解析在System32-only PATH下通过。Python仅用于随包合成验证，不是用户运行依赖。不是安装器或完整发行。

证据 W4/interaction-qualification.json、W4/interaction-source-eighth/report.json、W4/interaction-extracted-first/report.json、W4/interaction-package-first/package.json、W4/interaction-final-integrity.json、W4/interaction-runtime-extracted.json、W4/interaction-shared-close.tap。完整门仍为W0 passed，W1/W2/W3/W4/W5 unsupported；managedExecution.ready=false，能力矩阵未放行。

下一批：默认启动/更新准确门控、旧profile ACL/配置锁与账户singleton。已观察Windows更新器先进入Linux ownedDirectory/getuid并显示内部异常，须在任何更新存储/网络前明确unsupported。物理IME、文件系统剪贴板/拖放、Office/文件树等剩余消费、托管pending/tool/native投影与owner冷退休、部分复制UNKNOWN/源链接/大项目、TxF/namespace屏障及干净普通账户发行仍缺。

## Windows 独立配置与更新平台门控（2026-11-04，历史批次）

修复Windows启动更新器先进入Linux ownedDirectory/process.getuid、创建updates后显示内部异常的问题。共享AutoUpdater在构造/初始化、显式/自动检查、偏好写入、安装、直接请求/标签解析与停止状态路径上准确保持unsupported；文件目录检查、解包、安装helper和health回执也在副作用前拒绝。仅Linux x64保留既有发布合同和源码check-only语义，Windows/macOS/其他架构不读取更新文件、不建目录/排定时器、不发请求/派生helper/退出应用。主入口不消费不支持平台的health交接。状态增加checksSupported、平台/架构/reason/policy，界面准确说明此平台不支持并禁用检查/启用控件；没有实现Windows自动更新。

共享nozeli-config继续拥有独立初始化staged→complete判定，Windows file effects接入原生私有HANDLE有界读取、原观察摘要CAS与真实屏障。原PID+unlink配置锁改为Windows专用持久gate：固定内容的私有文件由原排他HANDLE持有，正常/进程直接退出只释放HANDLE，文件保留，不根据PID存活推断删除。独立进程竞争准确拒绝，实际holder process.exit(37)不执行JS finally后原gate继续可用。未知旧configuration.lock、未知gate内容/权限或损坏JSON保留并拒绝，不自动迁移修复。

Windows独立配置的暂存目录由原分配File ID入共享journal，恢复核对原目录实体并保留native pin直至结束；独立stage必须为空，marker仍用原读取SHA CAS。只通过原HANDLE删除已核对的空目录，替换目录/新增内容/外部marker赢家保留；无原stageIdentity旧记录要求显式恢复。Windows legacy import准确unsupported且不读取外部配置；apiKeyImportSupported=false。完成marker后清理中断仍可能保留stage，通用orphan清理和断电/重启保证尚未完成。

固定入口 node tools/test-suites.mjs windows-desktop-update；11项（4更新/7配置）在源码Node/Electron与中文空格解压固定Node/Nozeli.exe Node模式各11/11，无失败/跳过。包含缺失更新目录保持缺失、enabled偏好/未决handoff/损坏status字节保留、强造candidate/health/direct helper拒绝、原生配置CAS外部赢家、ACL漂移、legacy lock、原stage恢复/替换/新增及真实持有宿主退出。原项目scope/storage/Git/读写/草稿36项在四宿主完整重跑各36/36，renderer实际构建退出0；共享release语义排序1/1，平台策略验证Linux x64可用，未取得Linux/macOS更新器实机回归。

真实GUI在源码和解压各4项、2进程正常退出：启用本机loopback更新fixture并传health交接→可见启动→实际更新设置准确禁用与直接IPC阻断→经“查看初始化状态/使用独立配置”完成真实配置→退出重开读取同一complete→已有enabled偏好/未完成handoff/损坏status不变；本机feed请求始终0，不生成health回执。真实阅读/选区批注/键盘保存/草稿重开GUI也在源码和解压各5项、2进程退出0。四套共8应用进程，无renderer error，仅System32 PATH，未创建个人项目/配置账号或调用模型。

新本地资格包25290文件、1240876761字节，ZIP SHA-256 d72009f912d3b3394b4e480fb6c54e938c705b6de5f4e998d7431632bccdba1a；CRC、所有解压文件、772个src/dist及随包测试与当前源码一致，native/Pi输入核对原实际构建回执复用，无新native编译声明。包内固定Node/Electron/MinGit/Pi解析通过；不是安装器/正式发行。

证据 W4/default-qualification.json、W4/default-source-authoritative/report.json、W4/default-extracted-authoritative/report.json、W4/default-project-regression-source/report.json、W4/default-project-regression-extracted/report.json、W4/default-gui-source-fourth/report.json、W4/default-gui-extracted-first/report.json、W4/default-reading-source/report.json、W4/default-reading-extracted/report.json、W4/default-package-first/package.json、W4/default-final-integrity.json、W4/default-runtime-extracted.json。早期缺少test resize开关、错误等待启动初始化对话框、误传包内Node路径的失败原件保留。

下一批仍缺：真实账户singleton/默认home启动与旧profile ACL/旧锁显式恢复；物理IME、文件剪贴板/拖放、文件树/Office/TeX/终端剩余消费；托管pending/tool/native投影与owner冷退休、部分复制UNKNOWN/源链接/大项目、TxF可用性/完整namespace屏障、干净普通账户DLL/安装发行。本批未重跑前批多窗口/系统剪贴板，不以历史交互回执代签改动后的全部产品资格。W0 passed，W1/W2/W3/W4/W5 unsupported，managedExecution.ready=false，全局矩阵未放行。

## Windows 原生单实例与启动路由（2026-11-04，历史批次）

账户锁根仍从 OS 账户元数据 userInfo().homedir 解析，独立于 HOME/USERPROFILE/XDG、checkout 与实际 profile。Windows 在 profile 初始化前通过原生 HANDLE 创建/核验私有 singleton 子目录并固定原目录身份；Electron 持有原生单实例 mutex/IPC 和崩溃接替。争锁时临时设置 userData，随后恢复真实 profile；失败实例关闭自己的 pin，主实例在 will-quit 释放，强制退出由 OS 回收 HANDLE。已存在宽权限目录保留并拒绝，不自动改 ACL 或删除未知锁。单实例和独立配置 gate 是不同合同。

修复 Windows Chromium 在 second-instance argv 中插入开关后，按固定位置截断可能将源码 main.cjs 当作待打开文件的问题；只传发送方 app.isPackaged 仍不足。当前发送方经 Electron additionalData 传 schema1 原始 argv、cwd 和打包标记，接收方核验后按原发送数据解析；原始/Chromium 实际传递参数在显式合成测试日志中可对照。不含此元数据的旧版本仍使用旧参数回退，未宣称跨版本/跨形态兼容。最终测试逐步断言最近项目只能包含合成 fixture，应用入口不能被登记为项目。

固定入口 node tools/test-suites.mjs windows-desktop-singleton。源码 Node/Electron、最终中文空格解压固定 Node/Nozeli.exe Node 模式各 3/3，无失败/跳过，验证 profile 恢复、失败清理、主实例 pin 生命周期和发送端参数元数据。源码和解压实际 GUI 各 9 项，另加两个方向跨可执行文件/打包形态各 10 项：可见启动、独立 ACL 检查、不同 profile 二次启动在初始化前退出0、绝对中文空格文件/相对 cwd 文件准确打开、原未保存文本与磁盘原文保留、独立目录 rename 拒绝、三进程并发争锁、三个 helper 在 singleton/profile 前分流且缺 payload 退出1、正常退出接替、受控强制结束后的接替，以及 ACL 漂移拒绝并原样保留。

所有 GUI 使用显式合成账户 singleton，未取得/写入个人账户实际 singleton；纯测试核对默认解析器不等于真实默认 home/旧安装共存资格。崩溃场景只证明 singleton 和目录 HANDLE 回收，不代签草稿/托管业务冷恢复。GUI 驱动在源码测试环境运行，实际产品进程从解压包启动、PATH 仅 System32；生产包不携带 puppeteer-core。最终包再跑默认独立配置/更新门控 4 项和阅读/编辑/批注/草稿重开 5 项，共 4 应用进程正常退出0；所有最终 GUI renderer errors 为空，未配置 provider 或调用模型。

renderer 实际构建退出0，共享关闭回归26/26。native/Pi 输入核对原实际 W1/W2 构建回执复用，未修改 native 或宣称重编译。新本地资格候选 25293 文件、1240897645 字节，ZIP SHA-256 3548a35b1e372971176f72d3d8eabe551350f388320f07354d68fa0503e5a36d；CRC、全部解压摘要、772 个当前 src/dist 和随包测试一致性、native 输入、包内固定 Node/Electron/Pi/MinGit 解析均通过。单实例四宿主与双向 GUI 在 original-argv 包实际完成；最终 settled 包逐项比较所有文件，唯一变化为合成 reading 驱动等待保存回执，产品/依赖/native/单实例验证文件完全相同，回执 W4/singleton-package-equivalence.json。最终包另实际运行配置与阅读 GUI。候选是本地目录/ZIP，未制作安装器或替换日常安装。

证据 W4/singleton-qualification.json、W4/singleton-source-original-argv-final/report.json、W4/singleton-extracted-original-argv-final/report.json、W4/singleton-cross-source-original-argv/report.json、W4/singleton-cross-extracted-original-argv/report.json、W4/singleton-defaults-settled-extracted/report.json、W4/singleton-reading-settled-extracted/report.json、W4/singleton-package-settled/package.json、W4/singleton-settled-final-integrity.json、W4/singleton-settled-runtime-extracted.json。早期 Electron reporter 计数失败、包内缺开发 GUI 驱动，以及真实跨形态路由超时与诊断原件保留；开发依赖缺失在应用启动前停止。阅读回归还暴露驱动在磁盘发布、界面保存回执未落稳时立即输入下一段的时序错误，共享保存循环吸收了前两个新字符；改为等待真实 save-status=saved 后才开始独立未保存阶段，未修改产品保存逻辑。

早期“跨形态通过”缺少禁止登记入口路径的断言，不能作为最终资格。参数错误曾在源码 src/main 创建 .nozeli 项目元数据；已核对该批 operationId/projectId，将原5个文件和目录整体同卷移到 W4/singleton-unintended-source-project，未删除原始材料；移动前后根/文件身份和所有字节一致，回执 W4/singleton-unintended-source-project-move.json。源码内已无该意外元数据，当前最终回归明确拒绝再出现此类项目。

仍缺旧 profile ACL/旧 PID 锁显式恢复、真实默认账户/旧安装共存、物理 IME/文件剪贴板/拖放、文件树/Office/TeX/终端剩余消费、托管 pending/tool/native 投影/owner 冷退休、部分复制 UNKNOWN/源链接/大项目、TxF 可用性/namespace 屏障与干净普通账户 DLL/安装发行。W0 passed；W1/W2/W3/W4/W5 unsupported；managedExecution.ready=false，全局矩阵未放行。

## Windows Office 保存、导入与完整表格恢复（2026-11-04，当前）

固定 release/alpha.4 基线继续推进实际桌面消费。Word/XLSX 的共享 saveOffice 包装现在保留原生 committed、durability、commitUnknown、operationId、win32Code，顶层与 IPC details 均携带；真实发布后目录屏障失败不得伪装为“未写入”，保留编辑副本并提示核对原件。DOC 导入使用共享 replaceFile/createOnly，导入候选先留独立不可变恢复对象；仅明确未发布的目标碰撞可换后缀，发布不确定立即停止并保留实际路径/副本，不覆盖外部赢家。

实际 GUI 验收发现格式不支持时“保留恢复副本并关闭表格”会在共享 session.flush 中再次导出失败。当前 retainWorkspace 在 XLSX 导出失败时捕获完整 schema1 编辑快照（原 XLSX + Fortune 模型），宿主校验快照和原包，恢复设置提供 .recovery.json 导出。保留 dirty/冲突事实，不以清空脏标志绕过关闭；捕获/持久化期间 revision 或源身份变化仍拒绝关闭。完整快照永不记为可清理的 cleanOfficeBaseline，避免重开时被当作已写回原件丢弃。此快照用于保留/导出，尚未实现自动还原成可编辑工作簿或无损格式化 XLSX 写回。

源码 Node/Electron、中文空格解压固定 Node/Nozeli.exe Node 模式各16/16（11 原生 Host + 5 共享恢复），无失败/跳过。覆盖 Word/Sheet 原生 ACL、内容/公式保存与历史、独立进程外部赢家/删除/晚到 CAS、真实发布后屏障错误和冷重开；真实 OLE DOC 转换、目标碰撞与已发布不确定不重试。源码项目读写/Git/草稿/profile 回归 Node/Electron 各36/36。共享 workspace-native 广泛运行仍因默认 Windows persistence 门出现71项 fixture拒绝，原日志保留；不可宣称该套件通过。

源码/解压实际 GUI 各8项，4个真实应用进程正常退出0、renderer errors为空：真实 Word 键盘/中文字符/Ctrl+S、表格 B2与SUM依赖和邻格不变、格式不支持且原件不变、快照期间新编辑阻止关闭、重试后完整原包/两次格式/公式保留、真实 DOC 导入控件、正常进程重开与快照字节不变。驱动是外部 Puppeteer，产品从解压 Nozeli.exe/resources/app 实际运行，PATH仅System32；未配置provider或调用模型，自动Unicode输入不代签物理IME。

renderer实际构建退出0；native/Pi输入与原W1/W2构建回执核对后复用，未改native或宣称新编译。新本地资格ZIP 25300文件、1241000888字节，SHA-256 bdf252154a04a0545de13fbe302a578d12edeb0af596b627a6ea7bdec3881154；CRC、全清单解压摘要、当前src/dist和包内测试一致、native输入及固定Node/Electron/Pi/MinGit解析通过。仅本地目录/ZIP候选，不是安装发行资格。

证据：W4/office-qualification.json、W4/office-source-recovery-final/report.json、W4/office-extracted-final/report.json、W4/office-gui-source-race/report.json、W4/office-gui-extracted-final/report.json、W4/office-project-regression/report.json、W4/office-package-recovery/package.json、W4/office-final-integrity.json、W4/office-runtime-extracted.json。首次原生测试驱动错误、实际恢复关闭失败、广泛共享fixture失败均保留。

W0 passed；W1/W2/W3/W4/W5 unsupported；managedExecution.ready=false，能力矩阵未放行。旧profile/未知锁恢复、默认账户共存、公共文件树变更/文件剪贴板/拖放、物理IME、PPT/TeX/终端、托管冷恢复及干净账户发行仍缺；本批不外推其他系统或完整Office兼容性。

## alpha.5 公共普通文件传输租约

`anchored-public-file.inc` 的 `beginPublicFileTransfer(sourceName,destinationParent,destinationName,move)` 仅接受有公共 ACL 观察快照、可同步且仍稳定的原生父对象。源与目标父链保留 shared ownership；租约是独立 native type，不能借用到只读目录或伪造对象上。只打开已有单链接普通文件，拒绝重解析、跨卷及额外数据流。源 HANDLE 只共享读取，复制只请求读取权，移动另请求写入/DELETE；复制租约不能借用 commit 获得移动权。

`stat` 绑定 File ID 和长度，`readAt` 每次最多1MiB且前后核验原始字节版本/ACL。移动通过目标父 HANDLE 相对 FileRenameInformation、replace=FALSE 发布；系统成功后先置 published，再核验和同步。rename允许自身ChangeTime变化，File ID、LastWriteTime、长度、属性、链接数与安全描述符仍须相同。close仅释放HANDLE，从不按公共路径删除。NTFS可以在源租约期间新增硬链接，必须在发布前/后复核链接数；若发生变化，保留原名和外部链接，不谎称共享模式已拒绝该操作。

JS窄适配层在512MiB上限内分块摘要/复制，复制候选使用目标父目录内独占自有stage，stage入prepared回执后才填充字节，完整sync后no-replace发布。移动保留原native身份与ACL，复制分配新File ID并继承目标父ACL。租约跨共享metadata/draft回调保留；任何已发布故障携带committed/uncertain和真实身份，stage仅由原HANDLE清理，公共源/目标不作路径rollback/rm。

共享FileTreeOps在命名空间作用前持久化intent及原/目标元数据、草稿计划，prepared补齐身份/长度/摘要，published后使用expectedCollections提交标签/历史/来源，使用expectedRevision迁移草稿。全局meta锁和项目锁保护本宿主操作，SQLite CAS保留独立并发赢家。失去确认、已发布错误、未知stage清理均保留needs-attention；工作面保持recoveryHeld，冷启动暂停后续变更，没有自动重放或通用冷协调。成功仍只声明barriers-completed/namespace-not-qualified，不能外推断电、目录递归、系统回收站或完整W1资格。


## alpha.5 Windows 公共目录递归传输（2026-11-04，最新批次）

继续固定官方 v0.1.0-alpha.5（26b39d61d44edf30988efcb1bddcdba1ff7cffdf）。同项目/同 NTFS 卷内目录重命名、剪切、递归复制现已接入共享 FileTreeOps 的元数据集合 CAS、草稿 revision CAS 和恢复 admission。新 native 公共树根保留原根 HANDLE 和实际继承 ACL；独立只读 SourceDirectory view 共享该根，不能借用 Parent 写方法。复制先独占分配 .nozeli-tree-<operationId>.pending，分配前意图、分配后 File ID 和完整源清单均进入 prepared；文件分块写入并 flush，再核对暂存目录的全部成员与字节，整体 HANDLE 相对无覆盖发布。复制采用新 ID/目标继承 ACL，不克隆任意扩展元数据。

复用已有 retained-tree 捕获/校验状态机，固定全部目录/文件身份、ACL 与 SHA256。Windows 改目录名必须释放子项 HANDLE，因此保留精确根句柄，发布后相对同一根重新捕获并比较完整清单；新成员、字节/权限变化、链接与元数据漂移保留实际发布结果及 needs-attention，不按旧路径 rollback/rm。部分复制或分配回执不确定保留隐藏暂存根及完整计划，冷启动阻止新变更，不自动删除或重放。这个合同是有界观察/复核，未宣称目录 namespace 冻结或断电原子事务。目录移动的子文件是只读租约，回执明确 files=not-flushed-by-read-lease；目录和两个父屏障已实际执行，完整 namespace 持久性未资格化。

边界：目录最多 1,024 个子孙、合计 512 MiB、最多 128 级路径；恢复计划上限 8 MiB。原生清单拒绝任意层 .git/.nozeli（含大小写/规范化别名）、reparse/junction、硬链接与文件/目录 ADS，不截断树后伪装成功。现有普通文件上限仍 512 MiB；跨项目、回收站、文件剪贴板/拖放与仅大小写改名保持拒绝。

源码/最终解压双宿主：文件树各48/48（原32加目录16）、原生各297/297、共享各102/102、项目各36/36；最终解压 Office 各16/16，无失败/跳过。目录16含嵌套/空目录/Unicode/多块复制、标签/历史/来源新旧身份、草稿/未保存复制保护、嵌套 metadata/ADS/硬链接/junction、晚到外部目标、释放窗口成员/字节漂移、实际发布后屏障失败、部分暂存和元数据赢家，以及复制/移动发布前后真实子进程退出与冷不重放。真实 GUI 源码/最终解压各10项、共4个应用进程正常退出0、renderer errors为空：实际文件夹菜单改名带动打开子文档，主进程 IPC 递归复制/剪切，整进程重开读回正文。仍使用逐进程记录的测试专用 Chromium 遮挡开关，不代签默认无遮挡、物理 IME 或文件剪贴板/拖放。

新 native 已实际编译，15项输入，SHA256 `b4e5434140affcb3960908f31e09e0bbbf64e7c5cdd8e4d85ed9ff793a266f3e`；renderer 实际构建退出0，171项修改/新增JS语法通过。最新本地 ZIP 28197文件、1275138366字节展开内容，SHA256 `058ba2c4ce791dccd73fcd6d1705eb52d98f8b6b93fb4e3410067373cb240c83`；路径 `D:\nozeli-test\20261104-alpha5-directory-transfer\desktop-package-qualified\Nozeli-windows-alpha5-qualification.zip`。完整 ZIP CRC、全量解压清单、当前src/dist/tests、native构建输入、Pi manifest 与包内 Node/Electron/MinGit/Pi 解析均核验。仅本地资格产物，不是安装器或完整发行。进程/Pi190组本批未重跑，原二进制/输入复核后复用，既有 pipe-busy失败仍保留；默认套件此前619通过/12失败/1跳过仍不是全绿。未在Linux/macOS实机验收共享改动。

首次 GUI 在刷新后点击已脱离 DOM 的旧节点失败，原 gui-source/report.json 保留；改为测试 locator 重试后源码 gui-source-stable 和解压 GUI 各10项通过，产品未因该驱动问题改变。

权威证据：`D:/nozeli-test/20261104-alpha5-directory-transfer/qualification.json`；同根 native-build.json、hosts-source/report.json、hosts-extracted/report.json、native-source/report.json、native-extracted/report.json、shared-source/report.json、shared-extracted/report.json、project-source/report.json、project-extracted/report.json、office-extracted/report.json、gui-source-stable/report.json、gui-extracted/report.json、desktop-package-qualified/package.json、final-integrity.json、runtime-extracted.json、syntax.json。

W0 passed；W1–W5 unsupported，managedExecutionReady=false，全局能力矩阵未放行。后续：系统回收站身份/恢复协议与跨项目/文件剪贴板/拖放、旧profile/未知锁和默认账户、物理IME/PPT/TeX/终端、托管生产冷恢复、部分暂存显式协调及干净普通账户安装发行。完整目标保持进行中；未创建开发提交、推送、公开发布或替换日常安装。


## alpha.5 Windows 跨项目文件和目录传输（2026-11-04，最新批次）

继续固定官方 v0.1.0-alpha.5，HEAD 26b39d61d44edf30988efcb1bddcdba1ff7cffdf，远端标签对象 b7c32b1afc2d00c5c036af4283c616ff91e55fa2 已核实。两个已选择项目之间的普通文件/递归目录复制与同卷原生剪切已接入共享 FileTreeOps 和 WorkspaceNative。目标取得新的逻辑文档身份；源项目批注、修改历史、来源和草稿留在原项目，不迁移会话。剪切保留物理 File ID 和源 ACL；复制使用新 File ID/目标继承 ACL。Linux 既有 copy+trash 分支保留，未在 Linux/macOS 实机验收。主进程仍要求 shell 的活动目标项目，不放宽全局授权。

两个项目按固定次序加锁，再取得共享元数据锁。两侧 intent 和本机 catalog 的 tree_cross_transfers 总账先持久化，再分配/发布。各次 prepared 同步两侧回执及总账；发布前重查源已保存、目标恢复资料无冲突。发布后先记共同事实，两侧 acknowledged 后才提交总账 complete，最后两侧 complete。任一发布/结果不确定、部分暂存、CAS 赢家或丢回调保留现场；共同总账加两侧 admission 阻止继续变更，冷开不自动重放。总账在 SQLite 内验证原始 JSON 类型/schema/UUID归属，再生成有界投影，不能从 UI 默认 kind 或数字化布尔值推导归属。未知/损坏归属阻止所有项目；每页50项/64KiB，超过1,024项无关 pending 则拒绝本次操作。仍缺显式协调/清理 UI。

源码/最终解压 Node、Electron 两宿主：新增跨项目各17/17、原文件树各48/48、共享各102/102、项目各36/36，均无失败/跳过。17项覆盖文件/目录复制剪切、独立逻辑身份/ACL/字节、空目录/Unicode、多块复制、目标文件/元数据赢家、源未保存草稿、根替换/ACL变化、部分复制/丢回调、真实发布屏障失败、真实子进程在复制/移动前后及完成时退出、冷双项目 admission、2MiB未知记录有界投影、分页、原始类型/缺失kind、两侧/总账CAS竞争，以及共享源工作面 hold。真实 GUI 源码/最终解压各7项、共4个进程正常退出0且renderer errors为空：实际键盘/Ctrl+S、跨项目主IPC复制/剪切、活源文档保留、目录传输、目标赢家/活动项目权限、全进程重开。逐进程记录测试遮挡开关与forceVisible，不代签物理IME/无测试开关或真实文件剪贴板/拖放。

renderer实际构建退出0，174项修改/新增JS语法通过。本批未改native，复用公共目录批实际构建，15项输入及全部原生二进制摘要均复核；未宣称新编译。native297、Office16、process/Pi190组本批未重跑，历史证据与既有pipe-busy失败保留。此前alpha.5默认619通过/12失败/1跳过仍不是全绿。最终本地资格ZIP 28200文件、1275185434字节展开内容，SHA256 `df33fa1c7d213c2c319f189754aa8cf1c00849722884ad2da64bf25a2d1b8d54`，路径 `D:\nozeli-test\20261104-alpha5-cross-project\desktop-package-final\Nozeli-windows-alpha5-qualification.zip`。全量CRC/解压摘要、当前src/dist/tests、Pi manifest、包内Node/Electron/MinGit/Pi解析均核对；子测试PATH仅System32，不回落checkout运行时。仅本地资格闭包，不是安装器/发行版。

失败原件保留：cross-first.tap 14通过/2失败（一处测试误认为读取创建批注身份，一处产品漏导入path，均已修正）；中间包的源码一致性检查捕获了总账审查时的源码变动，原desktop-package-qualified记录保留，最终重新打包至desktop-package-final。最终17项双宿主通过数来自新报告，不使用中间结果补数。

权威证据 `D:/nozeli-test/20261104-alpha5-cross-project/qualification.json`；同根 cross-source-final、cross-extracted、hosts-source、hosts-extracted、shared-source-final、shared-extracted、project-source、project-extracted、gui-source-final、gui-extracted 的report.json，以及 desktop-package-final/package.json、final-integrity.json、runtime-extracted.json、syntax.json。

边界仍为本机固定NTFS、同卷、文件512MiB/目录合计512MiB和1,024子孙、128级路径、8MiB恢复计划。拒绝ADS/多硬链接/reparse及独立.git/.nozeli元数据，部分暂存保留。目录移动子文件只读租约不声明file flush；namespace/断电事务未资格化。W0 passed；W1–W5 unsupported，managedExecutionReady=false，能力矩阵未放行。下一步：系统回收站身份/恢复协议、真实文件剪贴板/拖放、旧profile/未知锁与默认账户、物理IME/PPT/TeX/终端、托管生产冷恢复、显式暂存协调及普通账户安装/更新/签名发行。完整目标继续，未提交、推送、发布或替换日常安装。


## alpha.5 Windows 原生文件剪贴板与外部复制（2026-11-05，最新批次）

基线固定官方 v0.1.0-alpha.5，HEAD 26b39d61d44edf30988efcb1bddcdba1ff7cffdf。接通真实 Ctrl+C/Ctrl+X/Ctrl+V、标准 Win32 CF_HDROP 文件列表导出、外部本地文件/递归目录粘贴和外部 Chromium File 拖入。独立 Win32 进程读写标准格式验证互通，修正 Electron 注册同名自定义格式不能替代标准 CF_HDROP 的问题。原生接口在 OpenClipboard 内核对 GetClipboardSequenceNumber 后才清空并发布；所有缓冲区预先分配，发布后失败保留 committed/uncertain。仅 CLIPBOARD_BUSY 异步每20ms重试，最多1秒；不重试代次变化或已提交错误。

外部输入一律明确复制，Preferred DropEffect MOVE 也保留源。readonly 原生源句柄/身份/内容清单接入既有 FileTreeOps 独占暂存、无覆盖发布与回执协议，不注册或修改外部源、不修复源ACL、不隐式保存项目源。目标为新逻辑身份与继承ACL；源批注、历史和草稿保留。文件512MiB/目录合计512MiB、1,024子孙、128级路径、8MiB恢复计划；拒绝ADS、多硬链接、reparse和嵌套.git/.nozeli。部分暂存/结果不确定保留现场并阻止继续变更，冷开不自动重放。完成回执丢确认时保留CAS赢家并增加独立needs-attention记录，避免原赢家complete消除冷开阻塞。仍缺显式协调/清理UI和完整namespace/断电保证。

外部拖入由preload的webUtils.getPathForFile处理实际File对象，主进程核验活动项目并签发绑定窗口/项目/TTL的一次性票据；renderer仅获得票据和名称。既有内部拖动继续共享文件树复制/移动状态机。已测Chromium实际鼠标内部拖动，以及CDP native File drag经过preload/主进程/复制流程；尚未验收资源管理器中物理鼠标拖入，不将CDP证据外推为Explorer实测。

实际重建Windows文件原生模块退出0，16项构建输入与二进制均复核，SHA256 `aed0f453abcb178f7fca6fd8e158d94b9e09b0e876594300c645785a779c1cad`。源码和最终解压Node/Electron各：剪贴板17、native297、文件树48、跨项目17、共享102、项目36，均无失败/跳过；renderer相关7项通过。真实GUI源码/解压剪贴板各10项、跨项目活源文档/Ctrl+S各7项，共8次正常退出0，无renderer errors。GUI使用显式遮挡测试开关与forceVisible；不代签物理IME/默认无遮挡/全工作面验收。Office16、process/Pi190本批未重跑，进程二进制及原构建输入重新核对。此前alpha.5默认619通过/12失败/1跳过仍保留，不能报告全套绿灯。

最终本地资格ZIP 28205文件、1275254538字节展开内容，SHA256 `1ca305e6577cb4a11bde1be4f8ea8903c015df26a0e65238151c957dbbed10b6`，路径 `D:\nozeli-test\20261104-alpha5-file-clipboard\desktop-package-stable\Nozeli-windows-alpha5-qualification.zip`。完整CRC、解压摘要、当前src/dist/tests、Pi manifest与包内Node/Electron/MinGit/Pi解析通过；测试子进程PATH仅System32。两次中间包因测试期间源码变更被一致性检查拒绝，失败原件保留，最终重新打包至desktop-package-stable。此包为本地资格产物，不是安装器或完整发行。

剪贴板测试事故如实保留：早期gui-third曾覆盖测试前的图片，恢复失败且原内存快照随进程退出丢失，无法恢复；已告知用户，不能宣称整批恢复成功。后续改为保存序列化CF_DIB/CF_DIBV5并让Windows再生CF_BITMAP；独立合成2×2图片验证精确DIB与再生位图尺寸，最终源码/解压GUI运行开始时的剪贴板状态得到恢复或保留外部赢家。该修复不能恢复早期丢失图片。其余保留失败包括旧代次读取、前操作尚忙/脱离DOM的测试时序、实际CLIPBOARD_BUSY，以及独立hold加入后的测试选错回执。首次gui-extracted在启动中Target closed、尚未执行复制，原因未确定；所查时间段无Windows应用崩溃事件。原剪贴板已恢复，同一未改包在gui-extracted-retry通过全部10项；首次关闭仍列启动稳定性待查项，不能用重试消除该记录。具体记录见qualification.json。

针对首次启动关闭，另用同一解压包和合成profile连续5次启动、激活项目及正常退出，5次均退出0且无renderer errors；未读写剪贴板。startup-probe/report.json与独立harness保留。未复现不代表已确定首次原因，该项仍待观察。

权威证据 `D:/nozeli-test/20261104-alpha5-file-clipboard/qualification.json`；同根native-build.json、image-restoration.json、syntax.json、final-integrity.json、runtime-extracted.json和各source/extracted目录report.json。W0 passed；W1–W5 unsupported，managedExecutionReady=false，未放宽能力矩阵。下一优先项：系统回收站身份/恢复协议、物理Explorer拖入、旧profile/未知锁与默认账号共存、IME/PPT/TeX/终端、托管生产冷恢复、显式暂存协调及干净普通账户安装/更新/签名发行。完整目标继续，未提交、推送、发布或替换日常安装。


## alpha.5 Windows 外部复制显式恢复核对（2026-11-05，最新批次）

固定官方 v0.1.0-alpha.5，HEAD 26b39d61d44edf30988efcb1bddcdba1ff7cffdf。本机恢复设置为已识别的外部文件/目录复制记录新增“核对复制结果…”和显式确认。只读原生父/文件/目录句柄核对原 File ID、完整内容及目录暂存清单；已发布副本保留，未发布复制明确放弃且保留全部暂存和外部目标赢家。此确认只更新回执，不执行复制、删除、清理、重命名、源写入、ACL修复或元数据迁移。

确认绑定主窗口/代次/项目根、完整回执revision与摘要和现场摘要，5分钟有效、一次使用；确认时重新捕获核验。只允许在线原项目，项目锁后取得共享meta锁，接入track/withProjectOperation以参与关闭排空。主记录与关联不确定记录各自expectedRevision CAS；原complete或已核对refused主记录原样保留。中间写入失败继续保留剩余hold，冷重开后重新预览/确认，不重放文件操作。新增第16项回归修复了“放弃复制主记录已确认、关联hold写入失败后不能重试”的缺口。独立批注/来源和草稿赢家保留。记录每项8MiB、关联合计16MiB、pending扫描256项、每页50项/64KiB；文件/目录512MiB、目录1,024子孙，超过上限拒绝且保留现场。

本轮最终源码/解压Node、Electron各恢复16/16、剪贴板源/票据回归17/17、共享102/102；renderer相关7项通过。真实恢复GUI各6项，跨项目/活源Ctrl+S GUI各7项，共8次正常应用退出0，无renderer errors。实际恢复界面验证真实子进程退出留下的原生文件stage、保留字节/源、确认后另一次新操作、已发布文件和完整目录/空目录、文档窗口权限拒绝、预览后目标替换拒绝及整进程冷重开零重放。GUI仍使用逐进程记录的Chromium遮挡测试开关与forceVisible，不代签物理IME/Explorer拖入/默认无遮挡。本轮不读取或写入系统剪贴板；17项回归使用注入的剪贴板接口，真实标准Win32互通沿用上一批证据。

renderer实际构建退出0，190项修改/新增JS语法通过。本轮未改native，复用上一批真实构建，16项输入和文件原生二进制摘要重新匹配；SHA256 aed0f453abcb178f7fca6fd8e158d94b9e09b0e876594300c645785a779c1cad，进程二进制/原构建输入也复核。native297、文件树48、跨项目单测17、项目36、Office16、process/Pi190本批未重跑，不冒称新通过；native297源码/解压历史结果见20261104-alpha5-file-clipboard。此前默认619通过/12失败/1跳过仍保留；共享改动未在Linux/macOS实机验收。

新本地资格ZIP 28212文件、1275311989字节展开内容，SHA256 `a29e1b6ebe0eb07258719d6808d3a09d9185d52d991d08e7cee85eef3c72731f`，路径 `D:\nozeli-test\20261105-alpha5-tree-recovery\desktop-package-stable\Nozeli-windows-alpha5-qualification.zip`。完整CRC、全量解压摘要、当前src/dist/tests、Pi manifest和包内固定Node/Electron/MinGit/Pi解析通过，子进程PATH仅System32。它是本地资格产物，不是安装器/完整发行。中间desktop-package-final因修复期间源码变动被一致性检查拒绝，最终desktop-package-stable重新生成。早期hosts-source-first 5通过/8失败来自父句柄权限冲突及夹具误认普通关闭后文件stage仍存，已改只读父和真实进程退出；两次早期GUI分别为按钮locator与拒绝文案断言问题，失败原件保留。

权威证据 `D:/nozeli-test/20261105-alpha5-tree-recovery/qualification.json`，同根hosts-source-stable、recovery-extracted、clipboard-source、clipboard-extracted、shared-source、shared-extracted、gui-source-stable、gui-extracted、gui-cross-source、gui-cross-extracted的report.json，以及desktop-package-stable/package.json、final-integrity.json、runtime-extracted.json、syntax.json。上一批剪贴板图片丢失事故及一次未解释的启动Target closed仍保留历史记录；本轮通过不能恢复旧图片或证明首次启动原因已解决。

W0 passed；W1–W5 unsupported，managedExecutionReady=false，未放宽能力矩阵。仅外部复制记录获得显式核对，内部/跨项目/剪切/创建记录结算、系统回收站和暂存显式清理仍unsupported。后续继续这些事务的恢复合同、旧profile/未知锁与默认账号共存、托管生产冷恢复、终端/TeX/PPT、物理桌面和干净账户安装/升级/回滚。namespace/断电和TxF普适性未资格化。完整目标保持进行中，未创建开发提交、推送、发布或替换日常安装。


## alpha.5 Windows 跨项目复制/剪切显式恢复（2026-11-05，最新批次）

固定官方 v0.1.0-alpha.5，HEAD 26b39d61d44edf30988efcb1bddcdba1ff7cffdf。设置的本机恢复新增“核对跨项目操作…”，识别两个已登记项目之间的普通文件/有界递归目录复制和同卷原生剪切。复用外部复制的只读原生观察句柄，核对原 File ID、完整字节摘要、复制目标stageManifest或移动原manifest及空目录。剪切核对原对象位于原名还是目标名；原名被另一个对象占用时保留该外部赢家，不冒充原对象。已发布结果保留，未发布操作可明确放弃且保留全部暂存。确认只更新回执，不复制、移动、删除、修ACL或重新投影批注/历史/来源/草稿。

两个项目按稳定次序取得项目锁，再取共享meta锁；两侧withProjectOperation和host.track纳入关闭排空。严格核对原project/instance/root绑定、同一operation/action/source/destination、两侧角色、元数据策略、各原生效果及共同tree_cross_transfers总账。每条完整记录8MiB、三处合计24MiB；真实文件/目录512MiB、目录1,024子孙；未知schema、缺失/损坏对侧记录、根绑定漂移、冲突效果/完整清单均保留hold，不猜测归属或重建对侧资料。总账完整读取复用共享recoveryRecord的collection参数，仍有界且使用真实revision和数据库version。

预览令牌绑定主窗口/代次、两侧实际根与元数据身份、三条回执revision/摘要、现场摘要，5分钟有效且一次使用。确认重新捕获完整现场。两侧先CAS写入仍可见的needs-attention核对确认；观察到两处精确确认后，才CAS完成共同总账；最后分别CAS结束本机记录。任何一处失去确认或竞争，都留下共同或本机待处理记录，冷重开可重新预览/确认；不自动重放。原complete/refused回执与已完成总账保持原revision和完整值。原同宿主操作留下的WorkspaceNative恢复保护不由回执确认自动解除或改绑；仍需显式关闭/重新打开或使用原缺失文档恢复，完整活工作面衔接待补。GUI异常现场由独立合成宿主生成，不冒称覆盖同宿主失败后活源工作面的解除。这个顺序防止“本机记录先隐藏、总账写失败”导致恢复入口消失；总账确认后各项目按自有最后回执分别释放。

最终源码/解压Node、Electron各新增恢复24/24、原外部复制恢复16/16、跨项目传输回归17/17、共享102/102，无失败/跳过；renderer相关7项通过。新增24项覆盖文件/目录复制和剪切发布、实际子进程在发布前/后和首个确认后退出、暂存和空目录、目标相同字节但新File ID、原名外部赢家、独立来源/草稿、三处CAS竞争、部分确认及最终本机CAS失败后的冷重试、原完成总账/回执保留、owner/TTL/代次/单次确认、无关恢复hold和损坏/缺失对侧拒绝。最终源码和解压24组驱动每宿主前后校验8项源码/测试输入摘要，禁止测试期间输入漂移。

真实跨项目恢复GUI源码/解压各7项、原外部恢复GUI各6项，共8次正常退出0、renderer errors为空。实际UI覆盖保留真实进程退出stage、两个项目新操作、文件/目录复制剪切、外部源名赢家、文档窗口权限拒绝、共同总账失败后待处理仍可见并重新确认、目标替换拒绝和整进程冷重开零重放。GUI使用已记录Chromium遮挡测试开关与forceVisible，不代签物理IME/Explorer拖入/默认无遮挡；本轮不读写系统剪贴板。

renderer实际构建退出0，197项修改/新增JS语法通过。native未改未重建，复用20261104-alpha5-file-clipboard实际构建，16项输入和文件二进制摘要重新核对：aed0f453abcb178f7fca6fd8e158d94b9e09b0e876594300c645785a779c1cad；进程二进制和原构建输入也复核。native297、文件树48、项目36、Office16、process/Pi190本批未重跑。此前默认619通过/12失败/1跳过仍保留，未在Linux/macOS实机验收共享改动。

最新本地资格ZIP 28219文件、1275375261字节展开内容，SHA256 `1cc0cd403a731880a968bcb0a1dd13936949945026fc5d781b0ffc99e5fd2805`，路径 `D:\nozeli-test\20261105-alpha5-cross-recovery\desktop-package-stable\Nozeli-windows-alpha5-qualification.zip`。全量CRC/解压摘要、当前src/dist/tests、Pi manifest和包内固定Node/Electron/MinGit/Pi解析通过，子进程PATH仅System32。本地资格产物不是安装器或完整发行。首次20项Node18通过/2失败，是普通未发布剪切已自动refused而夹具仍找pending，改真实子进程退出后验证；中间hosts-source-final在审查追加effect.kind一致性期间运行，最终hosts-source-stable使用冻结输入摘要重新验证，原件保留。

权威证据 `D:/nozeli-test/20261105-alpha5-cross-recovery/qualification.json`；同根hosts-source-stable、recovery-extracted、external-source、external-extracted、cross-source、cross-extracted、shared-source、shared-extracted、gui-source-first、gui-extracted、gui-external-source、gui-external-extracted的report.json，以及desktop-package-stable/package.json、final-integrity.json、runtime-extracted.json、syntax.json。旧剪贴板图片丢失及一次未解释启动关闭继续保留历史记录，不以本轮通过消除。

W0 passed，W1–W5 unsupported，managedExecutionReady=false，未放宽能力矩阵。尚缺同宿主失败后活源工作面的保护解除/重绑/脏输入保留、同项目复制/移动的批注/历史/草稿协调及创建恢复、系统回收站合同/暂存显式清理、旧profile/未知锁、托管生产冷恢复、终端/TeX/PPT/物理桌面、namespace/断电与TxF普适性、干净普通账户安装/升级/回滚/发行。缺失或无法证明的跨项目对侧仍阻塞，不能用本轮已识别组的资格代签全部UNKNOWN。完整目标保持进行中，未提交、推送、发布或替换日常安装。


## alpha.5 Windows 同宿主活源文档恢复（2026-11-05，最新批次）

固定官方v0.1.0-alpha.5，HEAD 26b39d61d44edf30988efcb1bddcdba1ff7cffdf。本批接通WorkspaceNative真实源工作面与跨项目回执确认：文件操作的保护按operationId独立保存，不清除预览/网页等通用recoveryHeld，也不解除其他操作的保护。源工作面先实际flush/document-sync，再在原生只读句柄上捕获每个原文件的卷/File ID、完整SHA256与长度，绑定两侧项目/实例/根/元数据及原工作面代次。最多1,024个文档、合计512MiB，核对失败在文件操作前拒绝。

恢复预览/确认与原操作使用同序的两个工作区队列，再取得两侧项目锁及共享meta锁，纳入两侧项目操作排空和host.track。确认持有源或移动目标文档的原生观察句柄，直到两侧回执/共同总账终态CAS完成。源身份/内容仍匹配的复制或放弃移动释放自己的保护，保留原缓冲对象、租约、选区和未发送内容；一般恢复保护及其他操作保护仍有效。源换成相同字节的新File ID、工作面重载/代次变化或绑定无法匹配时继续只读；用户恢复原对象后可明确“核验原文件并继续编辑”。最后写入实际成功但响应丢失时，此入口重新核验原终态回执/总账，不修改或重放文件效果。

已发布剪切保留原项目阅读面、文档身份、批注和未发送内容；不静默改绑到新项目。单独“打开目标文件”入口重新核验原目标File ID/内容和项目绑定后，通过主窗口打开独立目标工作面。原位置存在外部新对象时保留该对象，原窗口不冒充它。普通成功剪切也使用相同保护与目标入口。renderer的独立恢复提示放在被inert保护的文档区之外；受保护工作面flush使用原workspace恢复保存路径，不写回项目。

最终源码/解压Node、Electron各31项通过：15项新增真实Windows文件/回执/WorkspaceNative衔接，11项browser及5项update回归；两侧回执恢复24与跨项目传输17各在源码/解压双宿主通过，均无失败/跳过。31项驱动每宿主核对19项冻结输入摘要。覆盖已发布文件/目录剪切、复制、未发布目录stage与剪切、外部同字节新File ID、原对象恢复、脏缓冲/原租约、独立预览和另一操作保护、部分最后CAS失败、最后响应丢失、代次、权限/猜测operation及晚到目标替换拒绝、串行顺序和普通成功剪切。

真实同宿主GUI源码/解压各6项，使用独立合成故障入口加载实际production main/IPC/WorkspaceNative，仅在真实native效果检查点制造故障，不添加产品故障IPC，不伪造owner/stop事实。源码使用开发Electron；解压故障GUI使用只从候选包复制的独立Electron运行目录，exe摘要与包一致，直接加载包内原fixture/main/src/dist，未改原包入口。原包入口另行通过跨项目GUI7和两侧回执GUI7；源码原入口跨项目GUI7也通过。五组GUI共10次正常退出0，renderer errors为空。源码GUI实际键入/保存、未发送备注、恢复后Ctrl+S、独立目标按钮、源替换拒绝与恢复按钮、完整冷重开均验证；未读写系统剪贴板。测试遮挡开关/forceVisible沿用并记录，不代签物理IME或Explorer拖入。

首次新增Node14通过/1失败：普通未发布文件复制不保留测试预期的目录stage，改为实际目录复制保留场景；中间live-source因新增update测试造成输入漂移被驱动拒绝，最终live-source-stable和live-extracted以19项冻结摘要重新验证。首次GUI源复制恢复已通过，剪切目标按钮因位于inert文档区而无法点击；修复独立恢复banner后最终6项通过，失败原件保留。通用工作区扩展检查workspace-node-first为15通过/74失败：73项fixture仍使用未配置Windows native的默认ProjectStorage而在PERSISTENCE_UNSUPPORTED处拒绝；1项browser固定POSIX路径断言已改path.join并在双宿主重跑全部11项通过。通用fixture仍待适配，没有放宽生产能力门。

renderer实际构建退出0，209项改动/新增JS语法检查通过。native未改未重建，复用原真实构建；16项filesystem输入及二进制、process原输入/二进制重新核对。native297、external16、shared102、project36、Office16、process/Pi190本批未重跑；历史默认619通过/12失败/1跳过亦未重跑，不能当作全套绿灯。Linux/macOS实机未资格化。

最新本地资格ZIP 28226文件、1275431832字节展开内容，SHA256 `4816becf3452ff0acc7857e544797ff29688de8943a29dce39654ac34ea27548`，路径 `D:\nozeli-test\20261105-alpha5-live-recovery\desktop-package-stable\Nozeli-windows-alpha5-qualification.zip`。全量CRC、解压摘要、当前src/dist/tests、随包固定Node/Electron/MinGit/Pi解析通过。权威证据 `D:/nozeli-test/20261105-alpha5-live-recovery/qualification.json`，同根各report、desktop-package-stable/package.json、final-integrity.json、runtime-extracted.json、syntax.json和fault-harness-runtime.json。没有创建开发提交、推送、发布、安装或替换日常版本。旧图片丢失和一次未解释启动Target closed仍保留历史记录。

W0 passed，W1–W5 unsupported，managedExecutionReady=false，能力矩阵未放宽。仍需整进程重启后原源阅读面的持久保护恢复（尤其原名被同字节外部对象占用时）、同项目元数据/草稿及创建恢复、系统回收站/明确暂存清理、通用workspace Windows fixture、旧profile/未知锁、托管生产冷恢复、终端/TeX/PPT、物理桌面、namespace/断电/TxF普适性及干净普通账户安装升级回滚发行。内存中的operation保护不冒充持久owner；本轮整进程重开只证明目标/暂存/外部赢家和零重放，不代签原源阅读面保护的持久重建。完整Windows目标保持进行中。


## alpha.5 Windows 原文本源文档整进程冷恢复（2026-11-05，最新批次）

固定官方v0.1.0-alpha.5，HEAD 26b39d61d44edf30988efcb1bddcdba1ff7cffdf。新增CrossTreeSurfaceJournal，使用既有私有recovery对象存储保存原文件响应（正文与原二进制字节分离）、原buffer、原workspace快照和view状态；摘要引用、卷/128位File ID/完整SHA256/长度及两侧项目绑定写入host生成描述。描述成为原两侧回执共同不可变内容；两侧intent及共同总账建立之后、原生文件效果之前写入各原view的tree-surface保护记录。部分写入或响应丢失在活窗口先保护，操作拒绝，效果不提前开始。

原生窗口冷bootstrap及文档IPC先加载原view保护记录，再解析文件；校验原项目/根/元数据绑定、操作号、原源回执、描述摘要和不可变恢复对象。正文、编辑缓冲、原备注与后续由host绑定的workspace恢复记录得以保留。相同字节的外部新对象不作为原源；缺失源路径仍可打开原保留正文。file.read、阅读副本snapshot和导出共同走原保护内容，PPT保护读取避免重新解析当前源路径。保护本身不推断任何进程owner或冷停稳事实。

原两侧回执核对后，受保护源窗口也在同项目重命名/剪切/删除前拒绝，不能把外部占用原名的对象移走。精确原源通过核验的复制/放弃移动先CAS写入该操作保护released，再释放活窗口；丢失释放响应可明确重核。未来/未知并发status保留，不能标准化后覆盖。已移动源经原终态记录重核后仍保持原阅读面，只允许明确另开精确目标；未知/更换目标拒绝。完整拒绝且没有prepared效果的原intent，只能在原回执和精确原文件验证后解除自身保护。保留其他操作及网页/预览hold。最多1,024文档、合计512MiB观察、每恢复对象256MiB、原view历史记录4,096；预算/对象校验失败保留资料并拒绝，未截断正文。

最终源码/解压Node、Electron各47项全部通过，无失败/跳过；16项新增真实Windows检查覆盖独立进程重开、同字节源替换、原名缺失、正文/后续备注、成功/部分/丢响应释放、回执变更、未知并发status、目标替换、无buffer的导出与阅读副本，以及在真实原生prepared发布前检查点终止源宿主后由新进程重建保护和原输入。与此前15项活源、11项browser及5项update一起在每个宿主核对26项冻结输入。两侧回执24和跨项目传输17各在源码/解压双宿主通过。

真实GUI源码/解压各8项，包含原生编辑/Ctrl+S、实际原生故障、两侧设置确认、明确目标/原源按钮，以及完整关闭/重启后原正文和通过真实键盘选区/可见备注菜单创建的未发送备注恢复。源码使用开发Electron；解压故障检查使用从合格包单独复制、exe摘要一致的Electron运行目录，直接加载原包fixture/main/src/dist。解压原程序入口另行通过跨项目及两侧回执GUI各7；五组共10次正常退出0，无renderer errors。未添加生产故障IPC。沿用并记录遮挡测试开关，不代签物理输入。当前实际冷阅读面资格为文本；Office/PDF/图片字节捕获已实现，但冷GUI/投影/导出尚未完整资格化。

首次cold-node-first为7通过/1失败：夹具把未保存正文放在操作前恢复记录，被生产保存检查正确拒绝，改为已保存正文加未发送备注；随后定向检查暴露pending核验为moved后仍尝试原路径继续编辑，现返回保留移动状态。中间cold-source-stable虽然Node44通过，但因追加并发status/导出检查造成输入变化而被驱动拒绝；最终两侧各47以26项冻结摘要完成。中间GUI冷开原正文保护通过，但未锚定隐藏输入中的文字不是有效备注，后续又选用了不可点击页脚按钮；最终gui-source-frozen-v6使用真实键盘选区及可见备注菜单，原正文/备注/保护均在整进程重启后通过。原包入口GUI还发现源窗口集合为空时描述绑定报错，文件效果前拒绝；修复空集合分支，新增真实无源窗口递归目录复制/剪切回归。初始gui-cross-extracted失败及旧ZIP保留。最终源码GUI还因后台保存使恢复分页游标失效而停止，保留RECOVERY_CURSOR_INVALID原件并以同源码重试。分页读夹具现在最多12次重新读取失效页；不自动确认或重放任何文件效果。中间包的源码/测试变化由一致性检查拒绝，原始输出保留，后续审查还统一了较新保留正文与冷buffer，断言显示/导出/阅读副本都使用同一版本；定向通过后重新执行最终双宿主检查并生成最终候选，仅采用desktop-package-final-v6。首轮解压冷GUI已通过7项正文/备注/保护/目标检查，随后最后页面操作超时，第一次退出0、第二次未确认，失败原件保留；首次同包重试在早期Target closed停止，原因未明，原包入口两组7项GUI另外通过；采用第二次同包独立重试结果，保留前两次失败。

renderer实际构建退出0，215项变更/新增JS语法检查通过。原native未改未重建；filesystem16项构建输入及二进制、process原输入/二进制重新核对。native297、external16、shared102、project36、Office16、process/Pi190及默认套件本批未重跑。默认619通过/12失败/1跳过和通用workspace扩展15通过/74失败的历史记录保留（73项存储fixture门控；browser路径已修并重跑），不宣称全套绿灯。

最新本地资格ZIP 28232文件、1275486753字节展开内容，SHA256 `14910b2df3b1d49684442a46303dc2903ba5dca8cc2742be72ff3120fbbd96a7`，路径 `D:\nozeli-test\20261105-alpha5-cold-source\desktop-package-final-v6\Nozeli-windows-alpha5-qualification.zip`。权威证据 `D:/nozeli-test/20261105-alpha5-cold-source/qualification.json` 及同根各report、desktop-package-final-v6/package.json、final-integrity.json、runtime-extracted.json、syntax.json、fault-harness-runtime-v6.json。全CRC/解压摘要、当前src/dist/tests、固定Node/Electron/MinGit/Pi解析通过。没有创建开发提交、推送、发布、安装或替换日常版本；未读写系统剪贴板。旧图片丢失和一次未解释启动关闭的历史记录不删除。

W0 passed、W1–W5 unsupported、managedExecutionReady=false，能力矩阵不放宽。下一批先补Office/PDF/图片冷阅读面和更大负载资格，然后继续同项目元数据/草稿及创建恢复、系统回收站/明确暂存清理、Windows通用workspace夹具、旧profile/未知锁、托管生产pending/工具/投影/owner冷恢复、终端/TeX/PPT/物理桌面及干净普通账户安装升级回滚发行。完整Windows目标保持进行中。


## alpha.5 Windows Office/PDF/图片原阅读面冷恢复（2026-11-05，最新批次）

最新证据 `D:/nozeli-test/20261105-alpha5-cold-office/qualification.json`：基于官方v0.1.0-alpha.5，Word/Sheet/PPT/PDF/图片的跨项目操作原阅读面冷恢复已补齐本地资格。原保护对象先核验再读取；Office保留候选包重新验证后显示和导出，候选摘要与原源摘要分开；完整表格快照转换为Fortune初始化格式，恢复格式/单元格/跨表公式，完整格式尚不支持写回XLSX时拒绝不完整导出。PPT恢复标题及幻灯片保留；受保护owner供给阅读副本，不误读外部同名路径。

源码/解压Node和Electron各75项通过，冻结36项相关输入；真实五格式冷GUI源码/解压各11检查、各10次正常退出0，无renderer errors。解压原生产入口Office GUI另8检查/2次正常退出0。PDF/图片冷前后画布逐字节相同；合成晚到的引擎编辑经正常recovery保留，不冒充物理Office/IME资格。

最新本地资格ZIP 28235文件、1275518902字节展开内容，SHA256 `ae0be3eeaaed200189bd70452316e91e36e0da85128db7cc5fe92d376de9b34a`，路径 `D:\nozeli-test\20261105-alpha5-cold-office\desktop-package-final-v3\Nozeli-windows-alpha5-qualification.zip`。完整CRC/全部解压摘要、当前src/dist/tests及运行时解析通过。native输入/二进制复核，未重建。默认619通过/12失败/1跳过和通用workspace失败仍保留。W0 passed、W1–W5 unsupported、managedExecutionReady=false。未安装/发布/提交/推送，未操作系统剪贴板。

实际修复：CrossTreeSurfaceJournal异步重验Office候选包/完整sheetSnapshot；file.read返回原源身份摘要及单独候选摘要。document.export.read对保留编辑计算真实候选摘要和长度，origin明确retained-edit/retained-source；完整sheetSnapshot拒绝假装完整XLSX导出。workspace.document.snapshot和受保护owner的阅读副本共用保留内容。saveRecovery即时更新活hold候选，不将受保护Office标记clean baseline。renderer从候选bytes或完整sheet模型初始化并保留dirty；后台同步遇树保护使用既有host资料，不弹TRANSFER_HELD。Fortune初次mount始终从celldata重建，现显式转换每个runtime单元格，保留配置/公式/格式；恢复模型不支持完整格式导出时保留完整JSON。PPT草稿恢复后不再以文件名覆盖标题。

新增10项实际Windows独立进程检查，覆盖五格式原名被外部占用、Office候选验证/导出/摘要/阅读副本、完整sheetSnapshot及损坏候选拒绝；与原Office11、office recovery5、sheet readiness2、live15、cold16、browser11、update5共75项，在源码和解压两种Node/Electron宿主各通过。真实GUI逐格式使用生产main/IPC、真实native cut、两侧恢复确认和整进程退出重开：Word保留正文、表格粗体/斜体/B2=35/SUM=55、PPT标题与幻灯片，PDF/图片画布精确一致；原名外部赢家和移动原件不改变。native故障fixture与晚到引擎输入明确为合成，不宣称物理输入或完整Office能力。源码/解压各11检查，20次正常退出0；解压原生产入口原Office8检查，2次正常退出0。

中间失败全部保留：首次测试连续切换单内容布局使旧page脱离，改为逐格式完整冷循环；v2发现Fortune丢失runtime二维矩阵，修复celldata转换；v3发现PPT标题被文件名覆盖，修复；v4夹具structuredClone不能复制Vue proxy，改用引擎自身JSON模型。source-v5通过后截图发现后台TRANSFER_HELD提示并修复，最终source-frozen重跑。中间Node75通过但源码变化被driver拒绝；初driver错误预期80改为实际75，采用source-final75。首候选包因构建期间源码变化拒绝，v2被测试driver校正取代，仅v3权威。既有Target closed未解释历史、默认/通用workspace失败及旧clipboard图片丢失不删除。

renderer实际构建退出0，217项变更新增JS语法通过，冻结1514项src/dist/tests摘要；native未改未重建，原输入和二进制复核。native297/external16/shared102/project36/processPi190未重跑，Office本批实际11，不冒用历史16数。完整CRC/28千余解压文件摘要与固定运行时验证通过；仅本地资格包，不是安装包或发行。剩余同项目metadata/draft/create、回收站/清理、通用Windowsfixture、旧profile/未知锁、生产托管pending/tools/projection/owner冷恢复、终端/TeX/PPT更广功能、物理桌面和普通账户干净安装/升级/回滚/签名发行。完整Windows目标继续进行中。


## alpha.5 Windows 项目内元数据/草稿/新建显式恢复（2026-11-05，最新批次）

最新证据 `D:/nozeli-test/20261105-alpha5-same-tree/qualification.json`：固定官方v0.1.0-alpha.5，当前HEAD 26b39d61d44edf30988efcb1bddcdba1ff7cffdf。新增项目内复制、改名、剪切及新建对象的显式恢复。原生身份和完整字节/目录清单核对后，补齐原计划中的标签、历史、来源和草稿，保留无关记录、外部赢家和暂存数据。目标草稿、源草稿清除和完成回执在同一SQLite事务中比较全部版本并提交，文件效果零重放。

源码及解压Node、Electron各93项通过：项目内恢复18、原子存储3、文件16、目录16、外部恢复16、跨项目恢复24。冻结24项驱动输入、1527项src/dist/tests，229项变更新增JS语法通过。真实生产入口GUI源码/解压各6项，两侧各2次正常退出0、无renderer errors，覆盖恢复设置、保留草稿/批注、Ctrl+S、新建文件/目录、同名目标替换拒绝、整进程重开。故障由独立合成宿主生成，不证明同宿主原编辑窗口完整活/冷衔接。

本地资格ZIP 28243文件、1275575383展开字节，SHA256 `3f17fc4279ac9e30e72b30b58728c8ce7efeb400d4e6289cabd1cc6ea896a0fd`，路径 `D:\nozeli-test\20261105-alpha5-same-tree\desktop-package-final-v2\Nozeli-windows-alpha5-qualification.zip`。完整CRC/解压摘要、当前源码/测试和内置运行时核对通过。native未改未重建，复核原构建输入和二进制。W0 passed，W1–W5 unsupported，managedExecutionReady=false。默认619通过/12失败/1跳过、通用workspace15通过/74失败的历史保留；本批扩展storage另33通过/8失败，不能宣称全套通过。未安装/发布/提交/推送，未操作系统剪贴板。

新增sameProject标记与项目/实例/根/元数据身份绑定；旧无标记记录仍unsupported。预览令牌绑定owner/代次、回执revision/hash、原生现场和metadata/draft计划，5分钟有效且单次使用。项目锁后取meta锁，withProjectOperation及host.track纳入排空。确认重验真实File ID、完整SHA256或含空目录的manifest。已发布保留，未发布明确放弃且保留全部暂存；新建对象已有用户内容时拒绝结算并保留内容。不会重新复制、移动、删除、清理文件或修ACL。

元数据按原before/after差量合并，只接受受影响行仍等于before或after，无关新增行保留，受影响行并发赢家拒绝。项目数据库先CAS，恢复数据库再putMany单事务检查全部草稿源/目标及终态回执；任一revision冲突整批无写入。两数据库不是跨库原子事务，前阶段成功后失败仍留pending供明确重试。可识别旧的目标单写/源已清除部分状态；complete已落盘但响应丢失时，后续stale CAS不能覆盖成功回执。存储层另验证后项冲突全回滚、真实worker重开后幂等回执/请求指纹冲突、重复ID/无效版本/缺值无部分写入。

新增18项真实Windows恢复覆盖文件/目录复制移动、新建文件/空目录、元数据响应丢失后独立进程重开、旧部分草稿迁移、整批响应丢失、同字节草稿revision赢家、最终事务边界目标赢家、预览后metadata/draft/file赢家、回执赢家及未发布stage保留。原file-transfer故障夹具更新到原子批次边界；完整事务成功但响应丢失时核对保留complete回执并允许后续独立操作。

失败和中间产物保留：first/second为恢复版本purpose及stage生命周期夹具问题；third13/fourth17/atomic18在冻结前通过。hosts-source-first因源码漂移停止；hosts-source-final/首解压组合的旧600秒预算不足，在核实合成进程身份后停止，不能作为通过。初driver计数92随后按真实93修正；最终两个独立测试文件并发、每宿主1200秒预算，只采用desktop-package-final-v2。扩展storage33/8分别为打开SQLite不能unlink的Windows旧假设1项、旧controlled worker消息通道1项、通用初始化/retry fixture被Windows存储门控6项；保留TAP，不放宽生产门控。旧Target closed、默认/workspace失败及历史clipboard图片丢失继续保留。

原编辑窗口在项目内操作失败后的完整活/冷恢复、成功改名后的buffer/lease迁移仍未资格化；本GUI是独立宿主产生故障后用生产应用核对并打开目标，不代表覆盖原活窗口。下一批先处理该边界，再继续回收站/显式stage清理、通用Windowsfixture/默认套件、旧profile/未知锁、生产managed pending/tools/projection/owner冷恢复、终端/TeX/PPT、物理IME/Explorer/多屏、普通账户干净安装/依赖/升级回滚/签名发行。完整目标保持进行中。


## alpha.5 Windows 项目内原编辑窗口活/冷衔接（2026-11-05，v27）

最新证据 `D:/nozeli-test/20261105-alpha5-same-surface/qualification.json`：固定官方v0.1.0-alpha.5，HEAD 26b39d61d44edf30988efcb1bddcdba1ff7cffdf。项目内原编辑窗口活/冷衔接已完成本地定向验证：正常改名迁移buffer、lease、layout和恢复记录，原窗口Ctrl+S只保存新路径；发布/未发布故障保留原文、批注与未发送备注，核对后显式打开独立目标，旧路径同名外部赢家不变。旧版本备注保留原摘要，不自动改绑到后来保存的新正文。

源码及解压Node、Electron各149项通过：原窗口15、项目内恢复18、原子存储3、文件16、目录16、外部恢复16、跨项目恢复24、活源15、冷文本16、冷Office10。冻结35项驱动输入、1531项src/dist/tests，233项变更新增JS语法通过。原窗口故障GUI及正式生产入口GUI，源码/解压各6项、每组2次退出0、无renderer errors；前者通过独立合成fault entry加载真实main/IPC，后者直接启动生产入口。

本地资格ZIP 28247文件、1275626206展开字节，SHA256 `a0cc6a9fcd223099a49a44207e6f89b92ec09cb29ed2cd129b681cbf0877b629`，路径 `D:\nozeli-test\20261105-alpha5-same-surface\desktop-package-final\Nozeli-windows-alpha5-qualification.zip`。ZIP CRC、全部解压文件摘要、源码/测试/native原构建输入及内置Git/Node/Pi清单核对通过。native未改未重建。W0 passed，W1–W5 unsupported，managedExecutionReady=false。历史默认619/12/1、通用workspace15/74及storage33/8结果保留，本批未重跑，不能宣称全套通过。未安装/发布/提交/推送，未操作系统剪贴板。

原生效果前持久保存每个源文档的不可变capsule及host-only描述符，包含原文件、缓冲、恢复输入、布局和批注。回执绑定原项目实例/根/metadata身份、精确File ID及内容摘要。目录后代、阅读镜像复用共享保护；同项目终态核对取workspace串行、项目锁及meta锁，不复制业务状态机。

正常移动先迁移恢复记录并持久化新布局，再释放原保护与迁移buffer/lease；丢失布局响应时，独立冷宿主仅接受终态回执和同一原生目标快照，避免读取旧路径赢家。改名后更新renderer documentKey。最终UI reconcile失败不会重建旧路径hold。失败移动继续保留原阅读面只读，按原capsule显示批注，确认不会改绑旧选区或未发送备注。

中间失败TAP/GUI报告全部保留。夹具缺少layout/projectId、annotation kind与读后关闭时序已修复；GUI发现annotation.list返回envelope的生产判断错误已修复并用真实批注验证。GUI最初native pointer metrics等待超时，使用稳定窗口后renderer激活，仅为测试驱动修正。曾错误预期旧版本备注随正文保存自动改绑，现改为核对保留原materialDigest和新路径。远端本轮复核发生连接重置/超时，沿用既有官方alpha.5基线证据，不宣称最新网络核验成功。

仍缺：多窗口部分journal release的完整故障矩阵、Office正常改名全部变体、回收站与显式stage清理、通用Windows fixture/default/storage失败、旧profile/未知锁、生产managed pending/tools/projection/owner冷恢复、终端/TeX/PPT、物理IME/Explorer/多屏、命名空间/断电/TxF可用性/大目录，以及普通账户干净安装/依赖/升级回滚/签名发行。完整Windows目标继续进行。


## alpha.5 Windows 多窗口改名部分确认与冷恢复（2026-11-05，v28）

最新证据 `D:/nozeli-test/20261105-alpha5-multi-surface/qualification.json`：固定官方v0.1.0-alpha.5，HEAD 26b39d61d44edf30988efcb1bddcdba1ff7cffdf。多窗口改名部分确认故障已完成本地定向验证：两个编辑窗口与阅读镜像保留原文和未发送备注；首个/第二个journal写入前故障及响应丢失、晚到旧布局、整进程冷恢复均保留原阅读身份。旧路径同名外部赢家不变。冷开可以恢复到已核验的新路径，也可保留只读原阅读面并显式核对目标。

源码及解压Node、Electron各157项通过：多窗口8、原窗口15、项目内恢复18、原子存储3、文件16、目录16、外部恢复16、跨项目恢复24、活源15、冷文本16、冷Office10。冻结38项驱动输入、1534项src/dist/tests，236项变更新增JS语法通过。多窗口故障GUI源码/解压各5项，原窗口故障GUI及正式生产入口GUI各6项；每组2次退出0、无renderer errors。故障GUI仅通过合成entry加载真实main/IPC；正式入口GUI直接启动生产入口。

本地资格ZIP 28250文件、1275656224展开字节，SHA256 `250520c23d89e5aef93791bb6c558da2c75930a27bdab27acbde54f77ad1222c`，路径 `D:\nozeli-test\20261105-alpha5-multi-surface\desktop-package-final\Nozeli-windows-alpha5-qualification.zip`。ZIP CRC、全部解压文件摘要、源码/测试/native原构建输入及内置Git/Node/Pi清单核对通过。native与renderer本批未改；沿用先前实际构建并核对输出。W0 passed，W1–W5 unsupported，managedExecutionReady=false。历史默认619/12/1、通用workspace15/74及storage33/8结果保留，本批未重跑。官方基线沿用已固定证据，本批未重新网络核验。未安装/发布/提交/推送，未操作系统剪贴板。

故障复现：目录原生改名与新布局落盘成功后，首个文档保护记录释放成功而第二个失败；所有原窗口保留旧身份，晚到的旧布局可能覆盖新布局。若首个记录已标为released，重启会忽略原capsule并读到旧路径外部文件。第二轮TAP保留该失败证据。

改为可验证的relocated状态，保留原身份capsule及明确relocatedTo。冷开旧身份继续使用原capsule；非原身份只有合法同项目、非copy、complete回执与精确目标公式的标记才可越过旧保护。尚未完成relocated写入的新目标需重新核验精确File ID、摘要与长度。再次正常改名允许当前身份继续，历史原身份仍保留。此批不追溯修复历史已released的记录，也不自动重放操作。

8项原生定向场景覆盖3个文档面、两处部分写入、两处响应丢失、旧/新身份独立冷宿主、同字节不同File ID目标拒绝及连续改名。真实Electron GUI验证两个带锚点未发送备注的编辑窗口与阅读镜像，实际原生rename、主进程部分release故障、正常关闭和重启。冷窗口需逐个激活；首次显式核对可同时更新其他阅读面的状态，测试允许这一真实并发结果。所有中间失败证据保留。

完整Windows目标仍缺：Office正常改名全部变体、回收站与显式stage清理、通用Windows fixture/default/storage失败、旧profile/未知锁、生产managed pending/tools/projection/owner冷恢复、终端/TeX/PPT、物理IME/Explorer/多屏、命名空间/断电/TxF可用性/大目录，以及普通账户干净安装/依赖/升级回滚/签名发行。


2026-11-06 补充边界复核：外部合成验证脚本在源码/解压Node、Electron四组各3项通过、退出0。目标字段不符、非终态回执拒绝冷开；正常原生保存后新身份可继续读取，旧身份仍保留原capsule且不读取旧路径外部赢家。证据 `D:/nozeli-test/20261105-alpha5-multi-surface/marker-supplemental.json`；脚本及摘要记录在内。这3项是外部补充验证，不计入永久157项套件；源码/包内容未改。


## alpha.5 Windows Office正常改名及PPT模型迁移（2026-11-07，v29）

最新证据 `D:/nozeli-test/20261107-alpha5-office-rename/qualification.json`：固定官方v0.1.0-alpha.5，HEAD 26b39d61d44edf30988efcb1bddcdba1ff7cffdf。本批接通Office正常改名：Word、表格、PPT保持原编辑窗口身份，改名前后继续编辑，Ctrl+S只保存新路径；整进程重启保留内容与Word原版本未发送备注，旧路径同名外部赢家不变。PPT源文件不随独立模型编辑改写；全部索引版本和独立模型随项目内移动原子迁移，目标/并发模型冲突明确拒绝，已发布故障可显式完成元数据且零重放文件效果。

新增PPT迁移6项已在锁定源码Node22定向通过，全部扩展套件包含既有157项共163项。源码Node24扩展162通过/1失败/0跳过：既有successful-copy冷恢复在Git初始化报not a git repository，单独重跑1通过，但原因未确定，原失败保留。源码Electron扩展163通过/0失败；解压宿主结果为node:163通过/0失败/0跳过; electron:163通过/0失败/0跳过。开发机Node24.13.0与随包锁定Node22.23.4为不同宿主，不宣称源码目录Node22整组重跑。源码/解压GUI各Office7项、多窗口5项、原窗口6项，共12次正常退出0，无renderer errors。Office使用正式生产入口；故障GUI使用合成entry加载真实main/IPC。选区为DOM/编辑器接口合成，明确使用forceVisible和遮挡测试开关，不代签物理IME或默认窗口。renderer实际重建退出0；241项变更新增JS语法检查通过，冻结1538项src/dist/tests摘要。

当前本地资格ZIP 28254文件、1275685908展开字节，SHA256 `cbc60a7b04a290d20f5c1d4efd24a2b66745f3b8fb2ddf1f6ce0eb5c830245cf`，路径 `D:\nozeli-test\20261107-alpha5-office-rename\desktop-package-final-v2\Nozeli-windows-alpha5-qualification.zip`。完整CRC、全部解压摘要、当前src/dist/tests和包内Git/Node/Pi解析通过；native未改未重建，复核原实际构建输入和二进制。官方alpha.5标签本批首次网络复核成功，后续重复查询超时记录保留。W0 passed，W1–W5 unsupported，managedExecutionReady=false。默认619/12/1、通用workspace15/74及storage33/8历史失败本批未重跑，不能宣称全套绿灯。未安装、发布、提交、推送或操作系统剪贴板。

复用共享文件树回执、恢复扫描与SQLite批次CAS；PPT版本索引和每个模型绑定原摘要，正常迁移与故障显式恢复均核对源/目标revision。copy保留源草稿且不建立目标模型身份。旧回执没有pptDrafts字段时继续原行为，不追溯修复历史丢失模型。目录迁移覆盖全部索引版本，任一后项冲突整批不提交。

中间失败保留：首五次Office GUI停在改名前的选区/驱动环节；修正可见性和实际渲染DOM选区后sixth及正式重建后的final通过。额外旧多窗口GUI在键盘选区超时，现等待编辑器正文并用接口选区，retry通过；这是合成输入证据。首轮163宿主测试因测试输入变更而停止，不计通过；核对合成进程树后终止，残留查询已退出。首候选包desktop-package-final因后续测试夹具修改被取代，仅desktop-package-final-v2为当前一致闭包。

完整目标剩余：Office更广改名/损坏旧恢复记录/跨项目PPT模型迁移、系统回收站与显式stage清理、通用Windows fixture/default/storage失败、旧profile/未知锁、生产managed pending/tools/projection/owner冷恢复、终端/TeX/PPT更广工作面、物理IME/Explorer/多屏、namespace/断电/TxF与大目录，以及普通账户干净安装、依赖、升级回滚、签名发行。


## alpha.5 Windows 默认单元兼容与集成失败基线（2026-11-07，v30）

最新证据 `D:/nozeli-test/20261107-alpha5-default-portability/qualification.json`：固定官方v0.1.0-alpha.5，HEAD 26b39d61d44edf30988efcb1bddcdba1ff7cffdf。本批修复默认单元套件的Windows兼容性：Linux合成恢复算法显式提供UID、使用POSIX路径；模拟终端在spawn前注入基线；屏幕80ms通知用可控时钟验证并修复排队写入在dispose后残留定时器的问题。共享Windows恢复与终端unsupported拒绝保留。

定向修复前29通过/12失败/1跳过，修复后72通过/0失败/1跳过；后续原本因顶层getuid异常未注册的Linux合成用例现在执行。默认unit共71文件，源码锁定Node22、源码Electron、解压Node22、解压Electron四组各665通过/0失败/1跳过；跳过为Linux实机进程树用例，合成Linux算法不代表Windows原生所有权证明。完整integration已实际执行：527通过/1149失败/50跳过。624项报PERSISTENCE_UNSUPPORTED、377项报Cannot open pinned child；只归类失败入口，根因仍待逐项确认。全套default不能标绿，旧619/12/1历史保留。

本地资格ZIP 43412文件、1398864172展开字节，SHA256 `cdd943e9742239353efe213110a26cb06ce97498fe182a857f495cb75c07bf06`，路径 `D:\nozeli-test\20261107-alpha5-default-portability\desktop-package-final-v2\Nozeli-windows-alpha5-qualification.zip`。CRC/全部解压摘要、当前src/dist/tests和随包Node/Git/Pi解析通过。冻结1538项，246项变更新增JS语法通过。renderer/native未改未重建，沿用已实际构建输出并核对native输入与二进制。本批未重新查询远端，使用上一批已核验官方alpha.5标签。W0 passed，W1–W5 unsupported，managedExecutionReady=false；未安装、发布、提交、推送或调用系统剪贴板。

首解压包两宿主各637通过/5失败/1跳过：四个Pi测试按仓库相对路径导入失败，一个测试缺少esbuild。第二包两宿主各660通过/1失败/1跳过：桥接测试间接导入的Pi SDK依赖不完整。此为资格测试闭包缺失，不能称全套通过；原包、TAP及JSON保留。仅最终desktop-package-final-v2额外携带仓库布局Pi源码、SDK依赖和esbuild工具，全部71文件重跑通过；这些依赖只用于本地资格验证，不宣称最终用户发行包。没有删除、跳过失败用例或放宽生产平台门控。

下一批优先复现默认integration中的私有目录打开失败、生产持久化选择与SQLite关闭占用；区分真实产品缺口、宿主不匹配和测试夹具，再继续pending/tools/projection/owner冷恢复与Work/Git接受闭环。Office v29源码Node24 Git初始化单项失败、旧workspace/storage失败继续保留，不能用本批unit通过抹去。


## alpha.5 Windows 首次私有profile准备（2026-11-09，v31）

最新证据 `D:/nozeli-test/20261107-alpha5-profile-bootstrap/qualification.json`：官方v0.1.0-alpha.5，HEAD 26b39d61d44edf30988efcb1bddcdba1ff7cffdf。本批接通桌面首次使用时缺少profile的原生私有目录准备：仅初始锚点缺失、尚无分配回执时从已存在的直接父目录创建完整私有链；设置记录和桌面ProjectStorage共享此逻辑。项目根不走备用锚点，不递归创建任意祖先，不修已有ACL，不跟随junction，不覆盖同名赢家，分配后/屏障失败保留现场。

新增11项真实Windows回归覆盖首次catalog与设置、真实冷进程草稿、并发创建、缺失祖先、同名文件、junction、目录竞争、刷新失败和closed scope。源码Node22/Electron与解压Node22/Electron单元四组各665通过/0失败/1跳过；相邻profile/配置/项目存储四组各29通过/0失败/0跳过。Windows profile命名入口已纳入新增测试，源码两宿主各17通过。源码/解压正式生产入口GUI各6项、各两次退出0、无renderer errors；为可见Electron+CDP/invoke合成驱动，不代签物理IME/Explorer。完整integration567通过/1109失败/50跳过，比v30多40通过；624项PERSISTENCE_UNSUPPORTED、110项PROCESS_OWNERSHIP_UNSUPPORTED、108项EBUSY、41项OPEN_PERSISTENCE_UNCONFIRMED等仍待修复，失败码仅为入口分类，全套default未通过。

当前本地资格ZIP 43414文件、1398873016展开字节，SHA256 `5bf985c4750c25a5cfb2669ad1dc557e616a12b6aaaf0c898f945b1d5f36a408`，路径 `D:\nozeli-test\20261107-alpha5-profile-bootstrap\desktop-package-final\Nozeli-windows-alpha5-qualification.zip`。ZIP CRC/全部解压摘要、当前src/dist/tests、随包Git/Node/Pi解析通过；冻结1540项、248项变更新增JS语法通过。renderer/native本批未改未重建，复核原实际构建输入与二进制；无构建入口或依赖变化。沿用已固定官方标签，本批未查询远端。W0 passed，W1–W5 unsupported，managedExecutionReady=false。未安装、发布、提交、推送或调用系统剪贴板。

初始复现：全新合成profile未经正式配置初始化而直接传入DesktopHost，catalog打开返回WIN32_IO_ERROR/win32Code2；相同目录预先通过原生私有创建后登记成功。旧资格包独立重复复现，当前实现两种情况都成功。现有正式应用启动会提前创建profile，这次补齐独立桌面消费者首次使用合同。

首次11项测试有2个驱动问题：冷读进程使用--input-type参数被worker继承、ACL拒绝码预期写错。改用独立.mjs冷进程并按实际FS_SECURITY_CHANGED核对，原失败TAP保留。目录屏障测试特别注入同样的Win32 missing错误，核对它不会触发备用锚点；分配后失败要求committed与uncertain保留。

完整integration实际耗时约1112秒，原生目录准备后部分长用例不再立即失败，继续执行真实文件/worker操作。剩余失败不能全部归为fixture：生产持久化、进程所有权和外部打开队列仍有明确能力缺口；EBUSY需核验宿主/SQLite实际关闭和项目pin释放，不通过宽松删除绕开。下一批优先这些消费点及pending/tools/projection/owner冷恢复，再推进回收站、普通账户安装与完整W1–W5。
