# Windows 进程边界决策与验收

2026-11-02，W2 原语阶段；基线 `release/alpha.4`。生产 `verified-process-ownership`、`recovery-source-ownership` 仍为 unsupported，`managedExecution.ready=false`。

## ADR-WIN-03：先观察内核对象，再证明归属与停稳

进程事实放在原生 adapter，owner generation、请求/Work、预算、writer、恢复和零重放仍由共享状态机决定。现有 `process-ownership.mjs` / `pi-process-ownership.mjs` 的 stamp 校验含 Linux boot-id 格式；后续接入时须由平台验证版本化身份，不能给 Windows 伪造 Linux stamp。

W2 先采用独立 `native/windows-process` Node-API 组件，随后可在该边界内增加 Job/启动原语。文件桥及其构建入口、产物没有变化；两者分别打包、核对摘要，分别保留资格。独立模块不会自动获得共享 selector 的支持状态。

### 已实现的只读身份 HANDLE

`openExperimentalProcessIdentity(pid)` 只执行 `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid)`，不请求终止/写入/复制句柄权，不修改权限或启用调试特权。句柄不得继承，失败抛出带 Win32 错误的 `PROCESS_OPEN_UNVERIFIED`，不返回“已退出”或“可释放”。

`snapshot()` 在同一个持有的 HANDLE 上读取 PID、`GetProcessTimes` 创建时间和 `WaitForSingleObject(handle, 0)` 状态。100 ns FILETIME 用十进制字符串保存，避免超过 JS 安全整数；序列化 stamp 为 `win32:<pid>:<creationTime100ns>`。镜像路径由打开时的 `QueryFullProcessImageNameW` 取得，只是路径观察，不是签名/文件摘要或代码可信证明。活 HANDLE 固定内核进程对象；保存的 PID/创建时间字符串不能替代重新证明冷恢复归属。

只有 HANDLE signaled 才报告该进程 `exited`，再读取退出码和退出时间；真实退出码 259 也可能是退出结果，不能把 `STILL_ACTIVE` 当唯一存活判据。每个结果固定标明 `scope=single-process-observation-only`、`treeExitVerified=false`。状态是一次观察，`running` 不能保证返回后仍运行。

`close()` 幂等；关闭后查询拒绝。Node-API type tag 拒绝伪造、派生和其他对象的 receiver，最终器负责兜底关闭。该组件不 spawn、不 signal、不取得 owner、不释放预算/锁/writer、不调用 Workspace.open/Controller。打开一个已执行进程的查询 HANDLE，不构成在执行前纳管的证明。

### 当前实测

固定 Node 22.23.4 与 Electron 44.9.1 Node 模式，在源码及中文空格 ZIP 解压目录均各 **13/13**，零失败/跳过/取消。独立组件包包含固定 Node、Node 许可、原生模块、源码/测试闭包与逐文件 SHA-256 清单；解包 Electron 明确使用锁定开发宿主，未将 Electron 或完整产品随包验收。

真实场景包含本进程、两个独立 HANDLE、精确时间、无效/无法打开的 PID、receiver/关闭、正常退出和退出码 259、两个实际 incarnation、重复打开、无关哨兵存活，以及 leader 退出而显式 detached 后代仍运行。后代通过合成 stop 文件自行退出，夹具有有界超时；无进程名批量结束。最后一项实际检查共享 selector 仍拒绝 ownerAlive/spawn。

首个双宿主包中，Node 13/13、Electron 12/13：原后代夹具在 Electron 下随 leader 退出，未满足“仍存活”前提。该观察保留，不据此推断 Electron 完成整树回收；改用显式 detached、无管道依赖和文件握手后，四组均通过。尚未验证普通/脱离后代的所有宿主 Job/继承差异，属于下一批。

证据根 `D:/nozeli-test/20261101-windows-native`：

- 实际重建 `W2/build-process-identity-final.log`，构建/源码/二进制回执 `W2/build-process-identity.json`。
- 当前四组与归档清单 `W2/process-identity-roundtrip-final-v2/process-component-roundtrip.json`。
- 原失败 `W2/process-identity-roundtrip-final/process-component-roundtrip.json` 与对应 Electron TAP。
- 微软原文及摘要 `W2/contract-sources/sources.json`。

### Job 纳管候选与下一批顺序

Job Object 是优先候选，不等于隔离，也不凭 API 名字取得资格。下一批先在普通用户、真实 Node/Electron 上比较以下边界：

| 候选 | 要解决的具体问题 | 通过前仍拒绝的情况 |
| --- | --- | --- |
| 挂起创建 → AssignProcessToJobObject → 登记 → ResumeThread | 命令执行前绑定 Job/owner | 创建与纳管之间宿主崩溃可能留下挂起对象；失败不得只丢 PID |
| 创建属性原子关联 Job，加挂起/登记屏障 | 缩小未纳管进程的创建窗口 | API/嵌套/权限受限时明确失败，不回落先 spawn 再绑定 |
| 非继承 Job HANDLE、禁止 breakaway、KILL_ON_JOB_CLOSE | 受管宿主崩溃时清理受管后代 | 句柄泄漏/复制、脱离、孙进程再建 Job、嵌套限制尚未实测 |
| Job 空、各进程 HANDLE 和可信监督事实 | leader 退出后保留 writer/预算，整树停稳后再释放 | 只见 leader exited、PID 缺失、taskkill 成功或没有 Job 句柄都不足以释放 |

实施次序：

1. 建立执行前纳管与失败清理原语，实测正常、取消、leader 先退出而后代活、脱离请求、嵌套 Job、句柄继承和无关哨兵。
2. 建立版本化 owner generation/请求/进程/Job 绑定与登记屏障；真实 host/runtime 崩溃和关闭 Job 后等待整树退出。命令和环境的 Windows quoting、stdio/JSONL 必须独立验收。
3. 形成冷恢复协议。未命名 Job 的 HANDLE 丢失不能由名字/字符串重新证明；监督者、私有原生租约、实际数据库/项目实体证据需一起设计，未知继续保留登记/锁/预算，不重放排队请求。
4. 在共享 Pi/Workspace/Controller 调用链接入，验证实际 owner/worker、UNKNOWN 栅栏与零重放，再逐项接终端、force-quit、TeX/LSP/Git/工具；允许跨宿主生存的更新 helper 单独建协议。

W1 的依赖/资源、Plan Tree/worker-home、三个多步事务及路径/元数据/持久化限制仍待完成。W2 第一块组件通过不解除 W1、W3、真实产品工作面或整应用包的门。

## 复现入口

从 `apps/desktop`，使用固定开发 Node 22.23.4：

```powershell
node tools/build-windows-process.mjs
node tools/qualify-windows-process-component.mjs --output D:\nozeli-test\新的唯一证据目录
```

第二条同时运行源码双宿主和解包双宿主；输出目录必须不存在，失败也写原始 receipt/TAP，不覆盖已有证据。仅身份定向调试可执行 `node --test tests/windows-process-identity.test.mjs`，但不能替代四组资格。

## 原语依据

微软 [进程 HANDLE/PID](https://learn.microsoft.com/en-us/windows/win32/procthread/process-handles-and-identifiers)、[OpenProcess](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-openprocess)、[GetProcessTimes](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getprocesstimes)、[WaitForSingleObject](https://learn.microsoft.com/en-us/windows/win32/api/synchapi/nf-synchapi-waitforsingleobject)、[GetExitCodeProcess](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-getexitcodeprocess) 与 [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects) 原文已获取并保存摘要。文档描述的机制不代替此主机/调用链的验收。

## Windows W2 创建前 Job 纳管续批（2026-11-02，历史批次）

新增原生 `createSuspendedProcessJob` 与显式 `experimental-process-job.mjs`。`CreateProcessW` 用 `PROC_THREAD_ATTRIBUTE_JOB_LIST` 在创建时关联私有未命名 Job，并保持主线程挂起，避免先 spawn 再 Assign 的窗口；不支持/嵌套/权限失败明确拒绝。Job HANDLE 不继承，配置 KILL_ON_JOB_CLOSE，不允许 breakaway。显式本地绝对 executable/cwd、CRT argv 和独立 Unicode 环境块，不回落 shell 或继承宿主环境；尚无 stdio/JSONL 产品接口。

resume 只可一次，取消调用实际 TerminateJobObject；请求终止不是退出确认。query 固定当前成员的完整进程创建身份/HANDLE，终止前再次捕获；只有 leader signaled、Job ActiveProcesses=0、全部已观察成员 HANDLE signaled 才报本地 jobEmptyObserved。close 在未满足时拒绝并保留 HANDLE，超时同样保留事实；异常/GC 只请求内核回收，不冒充业务 stopped。短暂未观察成员会令 allProcessIncarnationsObserved=false，因此不能据此签署全域 owner/冷恢复/资源释放资格。

新增 19 项 Job 场景；连同 13 项身份测试，实际源码与中文空格 ZIP 解包的 Node 22.23.4 / Electron 44.9.1 Node 模式均各 **32/32**，无失败/跳过/取消。真实验证挂起不执行、取消、重复 resume 拒绝、超时保留、Unicode/空字符串/引号/尾反斜线/元字符 argv 与显式环境、未继承合成 secret、中文 executable 路径、无关 Job 哨兵、leader 退出后 detached 后代仍活、原生 CREATE_BREAKAWAY_FROM_JOB 返回 5 且逃逸命令零执行、原生嵌套 Job 及外层终止，以及宿主正常退出/强制结束后 leader 和 detached 后代实际退出、resume 前宿主强退零执行。后代创建时间与 Job 观察成员逐项对应，不按进程名回收。原生 helper 只属于合成测试，不是产品运行时。

证据 `W2/process-job-roundtrip-final/process-component-roundtrip.json`；实际重建 `W2/build-job-final.log` / `W2/build-process-job.json`，native `6649909b1582023f7fddbe79494016e46b882472c8c397a986faf33fa7cdde15`。组件含固定 Node、许可、源码/测试/helper/二进制与逐文件摘要；Electron 明确使用锁定开发宿主，仍非整应用包。首次 `W2/process-job-first.tap` 为 8/10：发现 accounting 归零但已观察后代 HANDLE 尚未 signaled，改为保留并等待成员 HANDLE；另一项错误比较了动态系统辅助进程计数。`process-job-second.tap` 10/10；第三轮 15/17 两项错误期待 ChildProcess.kill 的数字退出码，修正为实际 `[null,SIGTERM]`，第四轮 19/19。失败原件保留。

共享能力/拒绝门定向两文件 19 项：17 pass/2 Linux skip/0 fail，`W2/shared-process-job-selected.tap`。较宽四文件重跑 `W2/shared-process-job-gates.tap` 31 项：19 pass/10 fail/2 skip，失败为既有 Linux /proc mock 在 Windows 调用 getuid，W0 原日志已有相同问题；两项 Pi 测试在 Windows 提前 return，其 pass 不作为原生回收证据。没有把较宽回归称为全通过。

W1 文件桥与 264 项源码/解包闭包未改；原始 13 项身份批为历史，当前使用 32 项合并资格。生产 verified-process-ownership / recovery-source-ownership、W1/W2/W3 仍 unsupported，W4/W5 not-run，managedExecution.ready=false。完整 generation/请求登记与 resume 屏障、stdin/stdout JSONL、Pi/Worker、Workspace.open/Controller、冷恢复/外来来源、所有进程消费点仍待推进；瞬态未观察成员、恶意同用户句柄复制、不可读/持续变化成员及创建后结果发布失败路径未资格化。Job 也不提供隔离。


该历史批次的下一步为原生 stdin/stdout/stderr 与明确 HANDLE 继承清单；这些局部原语现已在下述 52 项批次验证。共享 owner 接入与冷恢复仍未取得资格。

## Windows W2 stdio 与共享 JSONL 续批（2026-11-02，历史批次）

新增 `process-stdio.inc` 和显式 `experimental-process-transport.mjs`。三个命名管道对均由创建者在创建子进程前连接；protected 当前用户 SID DACL、256 位随机名字、FIRST_PIPE_INSTANCE、REJECT_REMOTE_CLIENTS，实际核对 client/server PID。父端 overlapped，子端标准同步 HANDLE；仅 stdin/stdout/stderr 三个子端进入 `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`，Job/事件/父端不得继承。仍使用创建时 Job 原子关联与 CREATE_SUSPENDED；旧四参数不带管道入口保留。

Node Readable/Writable 使用 64 KiB chunk/highWaterMark 和 2 ms 轮询，遵守读背压、串行处理部分写入。取消先 CancelIoEx，再收取完成结果，内核完成前保留 OVERLAPPED/事件/缓冲区；写入失败只记录已确认字节与 transferUnconfirmed，不自动重放。leader exit、Job empty、stdout/stderr EOF 分别观察；显式 close 要求本地 Job empty，但会丢弃未读输出，产品接入必须先排空并分别判断协议/进程事实。轮询规模和性能尚未做广域资格验证。

共享 `jsonl-reader.mjs` 按原始字节处理任意 UTF-8 分块、LF/CRLF，帧上限 64 MiB；严格拒绝无换行超限、非法 UTF-8/JSON、非对象、空帧、截断 EOF/断连与 handler 故障，一次失败后栅栏后续消息。PiSession.start 改用此 reader，业务 receiveFrame/request 与 admission 继续共享。15 项纯 reader 测试已加入 unit 显式清单。真实原生管道用例调用 PiSession.request/receiveFrame 校验关联，但没有调用 PiSession.start，也没有启动真实 Pi SDK/模型或证明完整 owner 生命周期；Pi owner 自身的入站 reader 仍待接入。

新增 20 项真实 transport 场景，包括 Unicode/空输入/EOF、4 MiB 精确二进制回环、双路各 2 MiB 输出与事件循环进展、读背压、leader 退出后原生后代继续写 tail、pending read/write 终止、阻塞输入取消、实际 EPIPE、分块协议/错误帧，以及宿主正常退出和强退时仍挂起 I/O 的子进程回收。实际重建 `W2/build-stdio-final.log` / `W2/build-process-transport.json`；当前 native SHA-256 `74f881c77491437975dd45418de34a0578b9e82b11a1c3a32112343a210469a2`。身份 13 + Job 19 + transport 20，源码及中文空格 ZIP 解包后的 Node 22.23.4 / Electron 44.9.1 Node 模式均各 **52/52**，无失败/跳过/取消；逐文件源码、ZIP CRC、解包与执行后摘要核对通过。当前证据 `W2/process-transport-roundtrip-final/process-component-roundtrip.json`；此前 13/32 项记录为历史批次。组件使用锁定开发 Electron 宿主，仍非整应用包。

开发日志 `W2/process-transport-first.tap` 保留 11/12：原 Node 后代夹具未按预期继承输出，改为原生标准 HANDLE 继承夹具后仍要求 leader 后 tail 完整到达，第二轮 12/12、第三轮 18/18，新增宿主退出后最终四组各 52/52。共享四文件定向 `W2/shared-transport-final.tap` 为 39 项：37 pass/2 Linux skip/0 fail；不是完整 unit/Linux 回归。上一 Job 批较宽共享回归 19 pass/10 fail/2 skip 的 getuid 平台失败仍保留，本轮未重跑该组。W1 264 项资格闭包和文件桥摘要再次核对未变；未重跑 W1 或历史存储安全全组。

下一步在现有共享 PiSession/Controller/Workspace/Budget 上实现 owner generation 与请求/登记绑定，以及 prepare → durable registration → resume 闸门；不能把 transport 包装成 verified ChildProcess 就放行。现有 onSpawn 在启动后执行，而且 Controller 重新读取 stamp，须先补可验证的平台身份契约。停机须分别等待树、管道、native drain 和业务持久化回执。冷恢复需要重新证明监督租约/项目数据库实体与来源，不能从旧 PID/字符串或未命名 Job 猜测停稳。恶意同用户管道/句柄/访问竞争、未观察瞬态成员、创建后发布失败及断电域仍未资格化。W1/W2/W3 unsupported，W4/W5 not-run，managedExecution.ready=false，生产能力矩阵未变绿。

## 共享 owner 登记与挂起放行实施合同（部分已实现，完整接入待验收）

本节记录完整接入目标；下述70项续批仅验证共享显式登记/放行组件，正常 start/Controller/冷恢复仍未取得资格。先完成共享合同与显式组件实测，再决定是否允许某一完整消费链使用 Windows adapter；生产选择器保持拒绝，直到对应恢复和资源释放条件均成立。文件/持久化仍需已有显式 W1 根与真实 SQLite 证据，不用普通 fs 写文件替代其门控。

### 调用点与修改边界

| 调用点 | 当前行为与缺口 | 计划修改与验收边界 |
| --- | --- | --- |
| `PiSession.start` | spawn 后读取 stamp、调用 onSpawn；解析和 exit handler 挂在已运行的进程上 | 共享会话增加 prepare 能力分支；先保存挂起 child/lease 和安装监听，再等待持久登记回执，最后单次 resume；原 Linux 分支保持既有合同并独立回归 |
| `Controller` 的 Pi `onSpawn` 与预算 wrapper | 只传 PID，重新 processStamp；providers 仅存 pid/stamp/home/kind/ownerId | 将同一内核 HANDLE 产生的版本化身份和会话代次传给共享登记路径；与 target 的当前绑定及已有 providers 赢家作 CAS；不得覆盖新 owner |
| `Workspace.mutate` / ProjectStorage | 已有集合 CAS、SQLite receipt 与未知结果栅栏 | 共享业务事务保持原合同；已增加本机独立登记表的真实 revision CAS/回执，避免把本机进程归属写入可移植业务集合；丢回调保留 UNKNOWN |
| `AgentProcessBudget.bind` | 根据 session.pid/groupRecord、exit/stop receipt 判定额度保留 | prepare 一取得内核对象即视为占用；leader exit 只置 unconfirmed；登记失败/超时与停止失败不冒充 never-spawned；只有共享完整退出回执才能释放 |
| `process-ownership` / `pi-process-ownership` | regex 固定 Linux boot-id stamp，Windows 默认拒绝 | 将版本化身份验证交给平台边界；保留 Linux 原 stamp 的兼容分支；不把 Windows FILETIME 转成伪 Linux stamp，也不令 read-only identity 获得树资格 |
| `Controller` 的 Worker 回收与冷恢复、`Workspace.open`、`project-recovery-owner` | 多处 Linux stamp/宿主锁与来源证明 | 逐一消费同一身份验证合同；尚无重新证明手段的 Windows 冷路径继续拒绝并保留登记、预算、锁与草稿 |

共享 `PiSession.epoch` 已存在，可作为当前会话代次绑定来源，不另建 Windows 会话代次状态机。持久登记需同时绑定项目/宿主锁实体、target、ownerId、generation、独立 launchId、私有 home 身份、固定 runtime 身份与原生 leader incarnation；内核 HANDLE 仅留当前进程内，不序列化 HANDLE 数值。runtime 镜像路径观察不能代替随包摘要/资源资格。具体 schema 和旧记录迁移须与现有存储版本一起确定，不能把表中字段当作已落地的数据格式。

空闲 owner 启动和 prompt 分开建模：启动登记绑定 launchId/owner generation；已受理 prompt 继续使用共享 requestId/jobId/attempt/contentDigest/epoch，不为本来没有 Work 的空闲启动伪造 job。晚到回调必须重新核对当前 owner、generation、target 与既有 admission 对象；换代或 stop 后只保留诊断事实，不再派发副作用。

### 必须成立的执行顺序

1. 检查共享宿主/项目资格与启动授权，保留既有预算 reservation；在真实存储登记唯一 launch intent，CAS 拒绝并发或替换 owner。
2. 通过原生 Job 创建挂起进程与管道，立即把 lease/child 与既有会话/预算绑定；安装 exit、transport-error、JSONL 和 stderr 消费者。这个阶段即使发生错误也不能再宣称 never-spawned。
3. 从持有 HANDLE 读取版本化 incarnation；在原 launch intent/target/generation 上持久写入 prepared registration，等待实际 SQLite 回执。创建后登记前异常只允许终止挂起对象、等待真实本地退出并保留失败事实，不能 resume。
4. 回执成功后再次检查 store 栅栏、session 是否 stopping、generation 与 target 是否仍当前、lease 是否仍 prepared；只有全部成立才能调用唯一 resume。不能把“登记过”当成可以在换代后继续放行。
5. resume 后使用原共享 start/request/receiveFrame 和 journal/projection drain。登记一直承担资源保留责任，直到完整 stop receipt 与准确记录 CAS 清理完成；不依赖额外 running 写回成功才能承认进程可能已经执行。
6. 任何发送/回执/恢复未知结果都不自动重发输入、不自动重新 resume、不新建替代 owner；保留原 registration 与候选、进入既有 inspection/reconciliation 路径。

### 失败矩阵与退出事实

| 真实触发点 | 必须观察的结果 |
| --- | --- |
| intent 集合 CAS 外部赢家/数据库不可用 | 不创建进程，保留赢家与用户数据；按现有事务结果处理 reservation |
| prepare 成功、prepared 登记未确认 | marker 零执行；终止实际挂起 Job；未知存储结果保留待核对记录，不用内存 rollback 擦除可能已提交事实 |
| SQLite 实际提交后丢回调/宿主强退 | 不 resume、不自动重试启动；冷读保留同一 launchId/原始身份及 UNKNOWN，不能从宿主 PID 消失推断整树释放 |
| 登记返回期间 stop/代次更换/target 换 owner | 原 lease 零执行；晚到登记不得覆盖新 owner；清理须 CAS 同一 launchId |
| resume 调用失败或返回结果丢失 | 视为执行结果可能未知，终止/核验原 lease；不能第二次 resume 或建立同请求替身 |
| leader 退出、后代保留输出/继续运行 | 继续保留 lease 和预算；分别等树事实、两路 EOF、协议完整性与 native drain |
| 管道截断、EPIPE、半帧或输入传输不明 | 栅栏后续业务输入，保存错误与确认字节；不重放、不将进程退出当 journal 成功 |
| 树已空但输出/持久化回执未确认 | 不提前 transport.close 丢弃尾部；协议失败和持久化不明分别保留，按共享 stop receipt 规则判断清理 |
| 无关哨兵、伪造记录、旧 generation 或冷 PID 复用 | 无关进程零信号；无法证明的旧登记继续占用，拒绝清理其 writer/锁/额度 |

本地 lease 的 jobEmptyObserved/observed HANDLE 等待只是进程事实。业务 confirmationComplete 是否可成立还取决于所选平台的完整归属资格、未观察成员政策以及共享 stop/journal 合同；不直接把 jobEmptyObserved 映射成 confirmationComplete。冷恢复尤其不能重新打开同 PID 就取得原 Job 归属：当前未命名 Job 随宿主 HANDLE 丢失，KILL_ON_JOB_CLOSE 只提供回收机制，缺少可重建的监督证明。监督/租约与来源实体证明另立后续批次，不通过添加名字或保存句柄整数解决。

### 下一批交付与验收顺序

先提交共享版本化身份/prepare 契约及其拒绝路径，再以显式 W1 根和真实 SQLite 为持久化端，跑上表的挂起 marker/并发赢家/实际提交丢回调/宿主退出矩阵。之后才接完整 PiSession.start 与真实 Pi SDK，使用合成项目、独立私有运行目录和本地脚本化 Provider；不调用付费模型，不读取个人凭据。验证角色队列、原生事件、工具 admission、journal 与取消仍遵守共享规则。

本批新增或修改构建/原生运行闭包后，必须实际 build → 组件 ZIP → 中文空格路径解包执行，并为 Node/Electron 分别记录身份/Job/transport/登记测试计数。完整 Pi/Controller 与冷恢复未通过前，组件成功不能将 W2 标绿。随后继续普通终端、TeX、force-quit、更新 helper 等独立消费点，W3 权限/隔离决策，W4 原生桌面业务闭环，最后 W5 整应用资源闭包与干净环境候选包。

## Windows W2 共享登记后放行续批（2026-11-02，历史批次）

新增共享 `prepared-owner-launch.mjs`、本机 `owner-launch-registry.mjs`，并提供 PiSession.prepareRegisteredOwner 显式组件入口。复用现有会话 epoch/ownerId、原生 transport 与 SQLite worker 的 revision CAS/操作回执/原生数据库 lease：先持久 intent，再同步取得挂起 child/身份并安装共享监听，持久 prepared incarnation 登记确认后，再次核对会话代次、target/current guard 和同一 HANDLE 身份，最后唯一 resume。登记表位于本机 ui.sqlite 的专用 managed_owner_launches collection，不写入可移植项目集合，也不把 providers 普通缓存当并发 CAS。

任一 owner 换代、停止、登记失败/丢回调、实例变更或回执后 lifecycle seal 均拒绝放行；实际 resume 返回丢失也不允许重试。输入在未放行/协议失败/启动失败后被栅栏。共享 AgentProcessBudget 观察 prepared，并在存在 launchAttempt 时拒绝走 never-spawned 释放分支；PiSession.stop 在此未完全资格化的组件路径只请求本地终止并保留登记/额度，仍返回 PI_EXIT_UNCONFIRMED，不将局部 Job empty 冒充完整 confirmationComplete。本机注册器尚无删除、采纳或自动重放接口。

18 项新增真实组件测试覆盖：挂起阶段 marker 零执行、真实 SQLite intent/prepared 回执后执行和 Pi 请求关联、本机单 target CAS 赢家、独立进程写入的新赢家保留、generation/target 换代、等待实际登记回执时取消、intent/prepared 两个实际提交点受控丢回调、失败创建、重复启动、实际 resume 后受控丢结果、伪造 receipt/非法身份拒绝、共享协议错误回收、受控实例漂移/实际提交后的 lifecycle seal，以及宿主正常/强退后冷登记保留和零执行。宿主退出场景保留 parent 已打开的实际 leader HANDLE 并观察退出；不外推冷整树来源证明。

实际进程桥重建 `W2/build-owner-launch-final.log` / `W2/build-owner-launch.json`，当前 native SHA-256 `bede2043f695d373dffdb3661d0f96466e940c85ec6cc6c9161668344d6c0d58`。身份 13 + Job 19 + transport 20 + 登记放行 18，源码与中文空格 ZIP 解包的 Node 22.23.4 / Electron 44.9.1 Node 模式均各 **70/70**，无失败/跳过/取消。证据 `W2/owner-launch-roundtrip-final-v2/process-component-roundtrip.json`。解包包同时包含固定 Node/许可、未变的 W1 文件桥、模块/worker 依赖闭包、package-lock 与实际锁定 @lezer 依赖包/许可；ZIP CRC、执行前后源码/解包摘要均通过。仍使用锁定开发 Electron 宿主，不是整应用包。

共享四文件定向 `W2/shared-owner-launch-final.tap`：39 项，37 pass/2 Linux skip/0 fail；既有预算 unknown-native-exit 单项 `W2/shared-owner-budget-selected.tap`：1/1，不声明整个预算/Controller 或 Linux 套件通过。W1 264 项源码闭包与原 native 摘要再次核对未变，本轮未重跑 W1全组。首轮 owner-launch-first.tap 为 13/15，两个夹具错误期待字面量反斜线 n，修正为实际换行后 second 15/15；扩展场景后首包源码 Node/Electron 各69/69，解包因遗漏 @lezer/html 拒绝；补锁定依赖后第三包四组69/69，但运行期间源码变动令最终摘要检查正确拒绝整轮。全部失败日志保留；最终冻结后重建/打包四组70/70才作为当前证据。

此批没有把 prepareRegisteredOwner 接进正常 PiSession.start/Controller，也未伪造 verified=true。精确 home/runtime 文件身份、共享宿主锁、真实 Pi SDK/Worker/journal/完整 stop、冷监督租约/来源、其他终端/TeX/force-quit/helper 和恶意同用户竞争域仍待推进；当前 registry 保留策略还不能支撑用户连续启动/重启产品闭环。下一步将当前真实登记回执接入共享 Controller 启动/回收与 PiSession.start，补 W1 私有 owner-home/固定 runtime 资源绑定，在完整 owner 退出和冷来源具备证明前继续保留资源。W1/W2/W3 unsupported，W4/W5 not-run，managedExecution.ready=false，能力矩阵未变。

## Windows W2 真实 Pi 与共享 Controller 续批（2026-11-02，历史批次）

本批将登记后放行接入正常 `PiSession.start`，由显式品牌化的 `registeredOwnerLaunch` 服务提供平台文件/进程效果；默认 Windows 选择器继续拒绝。共享 Controller 的可选 `ownerLaunchFactory` 传入项目、target、ownerId 与 current-owner guard；onSpawn 消费真实登记回执并在 resume 前持久化 providers 缓存，不重新猜测 Windows PID stamp。复用原有 Controller、SessionIndex、SQLite 与 Pi admission/事件状态机。

`experimental-pi-owner-launch.mjs` 原生创建并固定私有 home/config/environment/temporary 目录，保留可执行文件、owner entry 与文件桥的原生只读句柄并核对摘要；仅允许精确 entry，无预加载参数。子进程环境重新构建，使用专用私有目录，不继承个人凭据、NODE_PATH 或 NODE_OPTIONS。元数据使用 W1 原生 CAS，启动失败栅栏后续输入。这个局部绑定没有将整个 SDK 资源树变为运行期不可变对象。

实际 SDK 暴露 Windows readonly Node descriptor 的 fsync 返回 EPERM，以及 SDK 自动创建的继承权限目录不满足私有目录合同。新增 Nozeli `journal-io.mjs`：在 SDK 写入前通过原生 HANDLE 创建并固定受保护 session 目录，核对 SDK 的实际目录；通过现有单链接/用户权限文件 lease 同步实际文件和目录，保留同一文件身份到解析与 SessionManager 重读结束。已有不合格目录拒绝且不修权限。明确返回 file/directory=flushed、namespace=not-qualified；不静默忽略屏障失败。上游 vendor 源码未改，Pi driver 实际重建，runtime-manifest 包含新文件。SDK 其他写入/租约、完整 journal 协议及 namespace/power-loss 仍未资格化。

新增 9 项真实 Pi SDK 1.4.0 场景：无模型调用启动/私有元数据与原生日志刷盘、精确中文/emoji/空白输入与回复/native entry/delivery 事实、回环请求取消且零重放、entry/command 摘要错误分别在执行与 intent 前拒绝、并发元数据赢家保留与输入栅栏、实际 native read 工具读取合成文件、已有不受保护 sessions 目录拒绝，以及共享 Controller.makeSession/角色指令/SQLite 运输事实/未确认预算保留。Controller 测试直接构造具有显式 W1 filesystem 的真实 Workspace 组件，不调用 Workspace.open，不代表完整宿主锁或生产 Controller.open 资格。测试使用合成项目、私有配置与 127.0.0.1 脚本 Provider，无个人账号或付费调用。

固定源码后实际 Pi build → ZIP → 中文空格解包 → 执行：身份 13 + Job 19 + transport 20 + 登记 18 + 实际 Pi 9，源码 Node 22.23.4、源码 Electron 44.9.1、解包 Node、解包 Electron 四组均各 **79/79**，零失败/跳过/取消。当前证据 `W2/pi-owner-roundtrip-third/process-component-roundtrip.json`。包含 16,285 个文件、实际锁定的 121 个 Pi 生产/可选依赖包及许可、角色资源、模块/worker/原生依赖与固定 Node。ZIP CRC、逐文件摘要、源码/解包执行前后摘要均通过；解包 Pi 根显式指向解包目录，NODE_PATH/NODE_OPTIONS 被移除。Electron 为明确锁定的开发宿主，仍非独立整应用包。

共享四文件最终串行回归 `W2/shared-pi-owner-serial-final.tap`：39 项，37 pass/2 Linux skip/0 fail；普通重试 `W2/shared-pi-owner-second.tap` 同样通过。首轮 `shared-pi-owner-final.tap` 为 29 pass/1 文件级失败，platform-process-boundary 子进程退出 1 且没有诊断，原因未定位，保留为间歇失败记录，不称首次全绿。既有预算单项 `shared-pi-owner-budget-final.tap` 1/1；显式 suite `pi-owner-suite-final.log` 9/9。开发中 Pi 首两轮分别因 fsync EPERM/目录 ACL 而 0/3，third 3/3；扩展 fourth 5/7、fifth 6/7 为夹具预期错误/缺少共享初始化，修正后 sixth 9/9。组包 first 的 string_decoder 与 builtin 同名解析问题、second 的依赖扫描误读模板文字均保留失败日志，修正后第三包四组通过。没有将开发失败覆盖为通过。

原生 C++ 未改；进程桥复用 `W2/build-owner-launch.json` 的实际构建，SHA-256 `bede2043f695d373dffdb3661d0f96466e940c85ec6cc6c9161668344d6c0d58`；W1 文件桥 SHA-256 `24c50e7a9acf52fd77328621c676dc71020efaf0287bc232e3ef55a9ad342eda`，84 项 W1 源码闭包再次核对未变，未重跑 W1 264 项或历史存储全组。Pi 构建日志为 `W2/build-pi-owner-final.log`。

完整产品仍有明确前置：Workspace.open 宿主锁与监督/冷来源证明；完整 stop 的树/两路 EOF/protocol/native drain/持久化收据；登记的安全释放与再次启动；真实 Worker/候选/接受/重启业务闭环；其他终端/TeX/helper 消费点及 W1 资源/事务闭合。当前 Pi stop 仍 PI_EXIT_UNCONFIRMED，登记与预算保留，不能连续启动/重启产品。瞬态未观察成员、恶意同用户句柄/ACL/映射竞争未资格化。下一批先实现宿主及 owner 监督租约、正常/崩溃后的可核验释放，随后推进 W3/W4/W5。W0 passed；W1/W2/W3 unsupported；W4/W5 not-run；managedExecution.ready=false，能力矩阵未变绿。

## Windows W2 同一宿主正常退出与恢复（2026-11-02，历史批次）

正常 PiSession.stop 现可消费明确的局部退出资格。Pi owner 在关闭实际 SDK 会话后返回最终 sessionId 与完整 flush 回执。宿主保持原 Job HANDLE、全部观察到的 incarnation、两路输出、协议 reader 与日志 HANDLE，直到所有条件通过：leader/全部已观察成员 signaled、Job accounting=0、TotalProcesses 与所有已观察 incarnation 数量完全相符、stdout/stderr 实际 EOF、输入无在途写、协议 clean EOF、无待定请求/工具/业务回合、native projection 完成且无错误，以及实际日志 File ID/摘要与最后回执一致。日志在读取/再次文件与目录刷盘/登记 CAS/后检查期间持续固定；namespace 仍 not-qualified。

新增平台 opaque exit proof，由原生创建 transport 的内存身份绑定实际 Job；序列化摘要、克隆 prepared receipt、伪造 callback/字段不能成为登记释放凭据。共享本机登记器仍不删除、不采纳、不重放：以原 launchId/revision/完整 prepared 记录和前后原生证明 CAS 写入 retired。当前活 registry 仅在明确收到并验证该次 retired 回执后才持有再次 begin 的 revision；新 registry 即使读到 retired，也不能由冷记录授权启动。提交后丢回执或后检查失败会 sticky UNKNOWN，保留额度并拒绝新 launch。SQLite 操作回执保留原请求，prepared/intent/retired 结果不导入项目可移植集合。

同一宿主确认后关闭 transport 与私有 runtime/home pins，PiSession.closed=true，原有共享 AgentProcessBudget 才释放名额，Controller 才移除对应旧 provider 缓存。新 owner 仍走 intent→prepared→登记→resume。真实 Controller 已验证重新读取工具元数据、恢复原 threadId、再次停止，且已接受输入只向回环模型提交一次。宿主重启、崩溃登记采纳与生产 Controller.open/Workspace.open 不在此资格内。

修复实际 leader-exit/pipe-tail 时序：原生 leader 退出可能早于最后回执被 JS 读取，现等待原管道排空再拒绝尚未收到的回执；协议失败仍立即栅栏，不被普通请求 timeout 掩盖。reader 的 completed 仅在无残帧 clean EOF 时为 true，主动 detach 不能伪造完成。stop 控制帧单次发送，与普通业务停止栅栏分离；超时/错误不重发。工具/回合/native drain 使用有界等待，未确认保持 PI_EXIT_UNCONFIRMED。

本批新增 12 项：transport 两项验证未读 stderr 拒绝和 leader 后尾帧关联；Pi 十项验证 stop 单航班与新 generation、真实 crash 无回执、最终日志后改动、实际 assistant 的宿主投影失败、外部登记赢家、真实退休 SQL 提交后受控丢回执、真实瞬态未观察 Job 后代、实际提交后关闭原生 pin 的后检查故障、伪造摘要/克隆回执、未完成投影的有界拒绝。原 Controller 用例增强为实际停止/名额释放/同线程恢复/零重放/再次停止。原有18项 prepared-only 场景继续保持未资格化 stop；未把所有 Job empty 直接映射成成功。

实际 Pi build→冻结 ZIP→中文空格路径解包→执行：身份13 + Job19 + transport22 + 登记18 + 真实Pi19，源码 Node22.23.4、源码 Electron44.9.1、解包 Node、解包 Electron 均各 **91/91**，无失败/跳过/取消。当前证据 W2/owner-exit-roundtrip-first/process-component-roundtrip.json；Pi 构建 W2/build-owner-exit-final.log。ZIP 含实际SDK、锁定生产依赖/许可、角色资源与固定Node；Electron仍为明确开发宿主，不是独立整应用包。源码/解包执行前后摘要与ZIP CRC通过。

共享四文件 W2/shared-owner-exit-final.tap 为39项37pass/2Linuxskip/0fail，既有预算单项 W2/shared-owner-exit-budget-final.tap 为1/1。开发失败原件保留：owner-exit-first 7/9为旧预期仍要求正常stop拒绝；second 26/27暴露协议错误被等待EOF延迟而变为请求timeout，改为协议错误立即拒绝；third 54/55为投影夹具早于模型调用即失败，改为真实assistant后故障；fourth55/55；fifth16/17为错误假定瞬态helper只增加一个Job进程，实际Windows还可加入辅助进程，改为核对实际增加与allProcessIncarnationsObserved=false；sixth17/17；最后伪造证明/未完成投影两项定向2/2。此前79项及其失败记录保留为历史。

本批未改原生C++，进程桥复用 W2/build-owner-launch.json 的真实构建，SHA-256 bede2043f695d373dffdb3661d0f96466e940c85ec6cc6c9161668344d6c0d58；W1桥24c50e7a9acf52fd77328621c676dc71020efaf0287bc232e3ef55a9ad342eda与84项源码闭包再次核对未变，未重跑W1的264项。宿主锁/监督租约/冷恢复、其他SDK文件和完整journal/lease域、同用户恶意句柄/ACL/映射、未观察后代、namespace/power-loss、Worker产品闭环及其他进程消费点仍无资格。新鲜registry继续拒绝冷retired/prepared/intent采纳；W1/W2/W3 unsupported，W4/W5 not-run，managedExecution.ready=false。下一批为宿主/owner监督租约及重启/崩溃后的来源证明，不以本批warm resume代签。

## Windows W2 显式宿主租约与冷启动拒绝（2026-11-02，历史批次）

新增 experimental-host-lease.mjs，复用现有 W1 原生能力，不改 C++：在已核验项目 metadataRoot 下 create-only 发布固定 managed-host.lease，通过持续保留的 writable private-file HANDLE 排斥第二写入者、删除和替换，并固定全部父目录、ACL、File ID、真实 ui.sqlite 原生数据库租约与当前宿主 HANDLE/FILETIME。标记保留，不把删除锁文件或 PID 消失当释放协议。实际宿主登记落在本机 ui.sqlite 的 managed_host_leases，绑定 projectId、instanceId、leaseId、目录实体与宿主 incarnation；不用 project.sqlite 的可移植集合保存内核所有权。

这是宿主所有权的显式前置组件，尚非生产 Workspace.open/Controller.open adapter。正常关闭前先同步停止 admission；begin 在第一次 await 前保留宿主启动占位，prepared/retired 持久登记绑定 hostLeaseId。共享 prepared-owner-launch 复用当前代次校验，增加 registry 的同步 admission 与最后异步登记核验，然后在同一同步段校验实际 child 身份并唯一 resume。停止、关闭 pin 或登记变更均不放行挂起 child。只有原 registry 的正常原生退出证明及确认退休 receipt 才解除占位；intent/prepared 丢回执、失败启动或 UNKNOWN 持续保留。

宿主 release 核对全部 owner 行与本活实例保留的确认退休 receipts，并做宿主 revision CAS、native/项目/登记/owner 集合后检查；序列化 retired 行不能充当凭据，提交后漂移或丢回执保留 pin 并进入 sticky UNKNOWN。成功后关闭 pin、保留宿主 retired 行和 anchor，仅同一进程中原始、未消费的 release receipt 可允许显式再次取得租约。跨对象克隆、冷进程、另一 profile、旧 receipt、单纯文件可打开均不能授权启动。正常 host lease 再取得不采纳旧 owner registry 的冷记录。

新增21项宿主用例，实际 Pi由19增至22项；真实 scoped Controller 的同线程 warm resume 也接入宿主租约并确认最后宿主退休。实际宿主在 Pi 接受输入后直接退出/强退，parent 保留原宿主和 Pi leader HANDLE 并观察退出；冷 host/owner 登记保留、未发送草稿不变、模型请求仍仅一次。另验证独立进程替换/删除/父目录移动拒绝、两个实际 profile 的共享项目实体争用、ACL不修复、硬链接漂移、真实 SQLite 外部赢家、active/retired/owner-intent 提交丢回执、lifecycle seal、最终 resume 四类失效及退休后的外部 owner 漂移。无关哨兵始终存活。两 profile 用例由合成独立 catalog 登记建模，不替代生产来源导入/迁移验收。

最终源码 Node22.23.4/Electron44.9.1、中文空格 ZIP 解包 Node/Electron 均各115/115，0失败/跳过/取消：身份13、Job19、transport22、登记18、宿主21、实际Pi22。权威 receipt W2/host-lease-roundtrip-final/process-component-roundtrip.json；实际原生重建 W2/build-host-lease-final.log/build-host-lease.json；Pi源码/runtime未改，沿用摘要匹配的 W2/build-owner-exit-final.log。源码、ZIP CRC、解包与执行后逐文件摘要通过；组件仍显式使用开发 Electron，非整应用包。共享定向39项37pass/2Linuxskip，budget1/1；W1的84项既有源码与文件桥摘要未改，未重跑历史264项或完整unit。

开发原件：host-lease-first.tap 为1pass/12fail，发现原生先创建空 ui.sqlite 后共享worker按既有文件拒绝无schema；修为先由共享worker初始化且再持有 mustExist 原生租约。host-lease-second.tap13/13、boundaries5/5、pi-death2/2；首轮四宿主110/110仅为补最终 admission/后检查前的历史批。host-lease-third.tap21/21；最终115为本批资格。无失败记录被覆盖。

仍缺宿主死亡后原 Job HANDLE 的持续监督者、全域后代/输出/journal/来源 catalog 与数据库实体的冷恢复证明。当前强退测试只在parent原本持有实际leader HANDLE的域内确认该leader退出；没有冷重建整个旧Job或从PID/持久标记推断整树停止。即使正常 retired，冷取得也拒绝，不宣称普通产品重启已完成。恶意同用户句柄复制、绕过协议的持续外部SQL/namespace变化、断电持久化和完整SDK lease域仍未资格化。下一步应先实现监督者及项目/本机来源绑定的可恢复协议，再接共享 Workspace.open/Controller.open，随后 Worker/候选/Git/重启、其他进程消费点、W1剩余事务、W3、W4真实Electron工作面和W5整包/干净环境。W1/W2/W3仍unsupported，W4/W5 not-run，managedExecution.ready=false，生产能力矩阵未变。

## Windows W2 原 Job 持续监督与冷连接（2026-11-02，历史批次）

新增原生nozeli_windows_supervisor.exe和process-supervision.inc/protocol、显式experimental-process-supervisor.mjs。原Job保持CREATE_SUSPENDED时，限定HANDLE_LIST向独立helper交付原Job QUERY/TERMINATE、原leader和原宿主QUERY/SYNCHRONIZE及ready事件；helper清除继承标志，不进入被监督Job，不设breakaway，不继承宿主环境，仅构造SystemRoot。原宿主用CompareObjectHandles核对helper返回的实际Job与原Job完全同一。监督启动一次性，失败/恢复执行后不重试或补挂监督，不提供任意PID纳管入口。

helper保留原Job/leader/宿主HANDLE，监视宿主signaled后TerminateJobObject；连接等待及有界I/O期间也持续监视宿主。helper建protected当前用户SID DACL、FIRST_PIPE_INSTANCE、REJECT_REMOTE_CLIENTS、256位随机名字的message pipe；服务端从内核取client PID并核对主token用户，将QUERY-only Job与QUERY/SYNCHRONIZE进程HANDLE复制到实际peer。客户端保留原helper HANDLE/FILETIME，核对pipe实际server PID、固定helper EXE File ID/摘要与原host/leader incarnation，再取得实际内核对象。HANDLE整数只用于瞬时原生交付，不导出或持久化。ACK后断开，避免Disconnect丢弃未读回复；请求有界，丢回执报告UNKNOWN不自动重放。

JS包装用现有W1 anchored read持续固定helper及父目录与字节，helper自身也持有EXE读HANDLE。冷端点记录携带helper File ID/SHA、pipe与三组PID/FILETIME，明确scope=supervisor-endpoint-observation-only；它不是owner释放证明。观察对象只提供snapshot、受控helper shutdown与本地close，不能resume或terminate owner。原生snapshot不伪造已恢复执行状态，executionState=not-observed。Job/accounting来自原对象，新的观察端没有历史成员HANDLE时，allProcessIncarnationsObserved仍严格保留false。helper shutdown仅要求leader退出与accounting空，用于关闭组件，不授予业务预算/写入者释放资格。

显式Pi服务增加supervise选项（默认false）。在共享prepare返回前建立监督，把原始监督包装与exact Job关联；registry prepared CAS保存supervision端点，并在回执后核验原监督。恢复执行前同步再核验原helper/原挂起Job；监督创建失败仍返回实际保留child交给共享session监听和清理，不隐藏子进程或走never-spawned释放。原始监督包装才能登记；冷连接观察对象不能充当新prepared监督。正常Pi退出仍按既有完整Job/EOF/protocol/native drain/最终日志证明退休；随后显式关闭空Job的helper。没有替代共享会话/Controller状态机。

新增12项监督用例，含正常/强退宿主的挂起、运行与原生后代三种状态，客户端连接后不发消息时宿主强退、原helper丢失、leader先退出而后代活着、实际瞬态未观察成员、伪造receiver/代次/helper摘要、查询对象拒绝新登记、重复或晚挂监督拒绝。无关哨兵保持活着。真实Pi现验证supervise+host lease正常stop，以及宿主退出/强退后从真实ui.sqlite prepared行取端点，冷连接取得原Job观察退出；旧host/owner登记与草稿保留，原输入只调用一次回环模型。观察成功后冷业务取得仍拒绝，无队列重放。

实际重建W2/build-supervisor-final.log/build-supervisor.json，组件包含新EXE/header/原生桥/固定Node及Pi锁定依赖。源码Node22.23.4/Electron44.9.1、中文空格ZIP解包Node/Electron均各127/127，无失败/跳过/取消：身份13、Job19、transport22、监督12、登记18、宿主21、实际Pi22。权威receipt W2/supervisor-roundtrip-first/process-component-roundtrip.json。源码/解包执行前后摘要与ZIP CRC通过；Electron仍是明确开发宿主，非完整应用包。共享定向37pass/2Linuxskip，budget1/1。W1桥与84项源码闭包未改，未重跑264项；Pi runtime源码未改，沿用匹配W2/build-owner-exit-final.log。

开发失败保留：supervisor-first.tap为1pass/8fail，首次运行时路径字符串比较拒绝helper映像；补为保留文件HANDLE并比较EXE实体File ID，helper也固定自身映像。second9/9、third31/31（22项Pi+9监督）、fourth12/12、final-selected12/12。其后最终四宿主127项包含全部最终断言。build-supervisor-first/second日志保留，final为当前原生构建。

当前仍未完成冷业务恢复：helper不持有W1项目/数据库/来源catalog租约，不持久化全域成员HANDLE证据，也没有完整输出与最终journal冷证明；没有采纳旧owner记录或清理UNKNOWN的API。helper若随外层Job/系统退出或自身崩溃，端点不可用必须保留UNKNOWN；外层约束、断电、长期无人恢复策略及完整发行DLL闭包未资格化。未收到的handle-transfer回复可能在peer留有查询句柄，每helper最多64次inspect控制增长；不自动重试，持续同用户恶意/资源耗尽域未资格化。保护访问域是当前用户，不是沙箱。下一批需把监督生命周期绑定项目/本机来源实体和可恢复登记协议，补历史成员/冷journal与来源核验，再接生产Workspace.open/Controller.open及Worker业务。W1/W2/W3 unsupported、W4/W5 not-run、managedExecution.ready=false，能力矩阵保持拒绝。

## Windows W2 监督者持有宿主 anchor 与本机数据库（2026-11-02，历史批次）

监督者现在可通过W1原生opaque bundle持有共享项目managed-host.lease、实际本机ui.sqlite和两侧完整目录HANDLE链。交付前核对原lease和File ID/已固定ACL；降权DuplicateHandle保留同一FileObject的共享限制，经限定HANDLE_LIST和只读匿名mapping交付helper。固定256个实体/4096字节单ACL上限，原始HANDLE数字仅存在原生临时交付，不进入JS或SQLite。helper从原HANDLE核验实体及ACL，SHA-256指纹排除HANDLE并绑定prepared端点；每次查询/清理重新核验，观察到漂移后持续拒绝。SQLite内容允许正常事务写入，namespace替换仍被拒绝。

显式Pi从同一registry/hostLease创建监督者，登记拒绝其他宿主的监督者；最终resume仍核验原Job与监督。正常退出在原Job/EOF/journal/登记退休证明后确认helper退出；宿主release要求每个原监督者的实际退出确认。helper消失或仅关闭观察对象不生成释放证明。实际Pi宿主正常退出/强退后，旧host/owner/草稿保留、模型请求仍一次，新宿主在helper持有anchor时因真实共享冲突被拒绝。

本批W1已改动并重建：源码Node/Electron、ZIP解包Node/Electron完整回归各264/264。W2源码与中文空格ZIP解包Node22.23.4/Electron44.9.1各134/134，其中新增custody7项、原监督12项、实际Pi22项。证据W1/custody-source-final/native-filesystem-hosts-validation.json、W1/custody-roundtrip-final/component-roundtrip.json及W2/custody-roundtrip-first/process-component-roundtrip.json；双原生构建W2/build-custody.json。共享37pass/2Linuxskip、UNKNOWN预算定向1/1；完整预算suite另有3pass/12fail，均为生产PERSISTENCE_UNSUPPORTED路径，不宣称该suite或生产Workspace可用。开发失败与全部原日志保留。

这只补齐宿主anchor/本机UI数据库实体持有，不包含来源catalog/project.sqlite、完整历史成员、冷输出与journal、业务采纳/释放/重放或生产Workspace.open/Controller.open。helper长期无人接管、外层Job/系统退出与clean app依赖闭包仍未资格化；组件ZIP及开发Electron不是整应用发行包。下一步补来源catalog/project数据库实体与冷核验协议，再接共享Worker/候选/接受/Git/重启和W1剩余事务、W3–W5。W0 passed；W1/W2/W3 unsupported；W4/W5 not-run；managedExecution.ready=false；能力矩阵保持禁用。


实现文件：native/windows/custody-transfer.h、anchored-custody.inc；process-supervision.inc、process-supervisor.cc和protocol v2；experimental-host-lease/experimental-process-supervisor、owner-launch-registry及显式Pi服务。opaque bundle一次性交付，关闭/克隆/错误接收者/复用均拒绝；256上限含重复父链，未实施路径重开或PID猜测。bootstrap只读mapping只作原生临时交付，SHA指纹固定kind/File ID/属性/初始事实/已固定ACL。祖先中W1未固定ACL的句柄不新增ACL保证。DB侧car锁和业务读写仍归共享SQLite worker；helper只固定现有DB实体，不替代SQLite锁或证明来源代次。

新增7项：opaque/指纹伪造、closed/consumed及原FileObject共享限制；normal/forced × prepared/running四组合下helper独自保留anchor/DB/父目录，实际竞争写入/rename失败，helper退出后可重开和rename但冷host仍被旧记录拒绝；ACL漂移拒绝查询/空Job清理及host release，测试仅终止自己创建并保留原process HANDLE的精确helper，绝不伪造退休证明。Pi22项已包含真实normal/forced宿主退出，改正fixture必须先关闭supervisor再删除项目的清理顺序。

开发记录：custody-first.tap为6pass/1fail，权限恢复的Windows自动继承标记断言失败；custody-second.tap为38pass/3fail，其中两项是Pi测试清理顺序，另一项是anchor ACL修改同时改变ChangeTime、不能恢复为原实体证明。最终改为漂移持续拒绝及fixture显式处置，custody-final-selected.tap为7/7。build-custody-w2-final.log首次因失败fixture留存helper映像导致EBUSY，核对四个合成helper的原process HANDLE/FILETIME/精确映像后处置；final-second与final-third重建成功，third为最终版本。W1/custody-roundtrip-first在多个完整suite同时运行时解包Node超过driver的240秒上限，记录failed，未改原语或放宽timeout；待W2结束后新目录重跑W1，最终结果见final回执。shared-custody-budget-full-not-qualified.tap记录广泛预算测试3pass/12fail，不能外推生产Windows业务通过；仅原UNKNOWN预算定向回归1/1。

## Windows 来源实体与监督者独立摘要绑定（2026-11-03，历史批次）

实验宿主现在同时固定实际 catalog.sqlite、project.sqlite、只读 project.json、宿主 anchor、ui.sqlite 及其原生目录链/已固定 ACL。数据库通过 File ID/单链接/属性/ACL 核验，允许无关业务事务；来源记录直接从共享 SQLite worker 读取 value+revision，不用缓存登记替代。project.json 有界严格 UTF-8/JSON、projectId 与实体摘要核验。每次准入/登记前后复核真实来源修订；同值更新和 ABA 均会拒绝，提交后来源变化保留 STORAGE_RESULT_UNKNOWN 与现场。

独立 helper 持有原始来源记录 SHA-256，经只读原生 manifest v3 交付，纳入 custody 指纹与 IPC v4 返回核验。冷查询对照 helper 保留的原摘要：外部写入者即使同时改写实际来源和宿主 source 声明，仍返回 HOST_SOURCE_BINDING_CHANGED；继续伪造 owner 端点摘要也被原生响应拒绝。攻击前后实测证据分别为 W2/source-binding-probe-before/probe.json（错误接受）及 W2/source-binding-probe-after/probe.json（正确拒绝），永久回归同时核对竞争赢家保留。

冷查询只返回来源与原 Job 的观察事实，不生成任务采纳、退出释放或自动重放许可。四种 normal/forced × prepared/running 宿主退出场景中，先关闭原父进程所有源数据库连接，再验证 helper 独自阻止来源/目录替换，避免其他 SQLite 连接掩盖缺失的保管。真实 Pi 两种宿主退出也核对来源；只读 manifest pin 与正常 checkedMetadata 读取兼容。

最终真实验证：W2 源码 Node/Electron、中文空格 ZIP 解包 Node/Electron 各143/143，无失败/跳过；W1 已重建，同样四宿主各264/264。回执 W2/source-binding-roundtrip-verified/process-component-roundtrip.json、W1/source-binding-source-final/native-filesystem-hosts-validation.json 和 W1/source-binding-roundtrip-final/component-roundtrip.json；双原生构建 W2/build-source-binding.json。共享39项为37pass/2Linuxskip。独立定向28/28。source-custody-roundtrip-first及source-binding-roundtrip-final的解包失败均保留：原测试无条件断言历史完整；换原生fixture仍失败，独立5次探针核对新增成员均为实际System32/conhost.exe（W2/source-binding-history-images.json）。最终测试等待原生fixture实际执行标记，再核验/持有live成员后终止，不假定只有一个进程；漏掉瞬时历史成员仍保留false，原生判断未放宽。完整预算suite沿用此前3pass/12fail的未资格化事实，本批未重跑，不宣称生产预算业务通过。

限制：多数据库读仍非跨库原子快照；256个保管实体、单ACL4096字节、每helper64次inspect transfer限制保持。完整历史成员保管、冷输出/journal与UNKNOWN恢复、业务采纳/释放、生产 Workspace.open/Controller.open 尚未接通。W0 passed；W1/W2/W3 unsupported；W4/W5 not-run；managedExecution.ready=false，能力矩阵未放行。组件ZIP及开发Electron Node模式不等于整应用发行包或产品UI。

下一批按产品闭环推进：先补持续保管历史成员和输出/journal边界，接共享恢复/UNKNOWN协议；再接生产 Workspace/Controller 与实际 Worker → 候选 → 审阅 → 接受 → Git → 重启，补齐W1依赖/资源复制、PlanTree/worker home和剩余多步事务；随后验收W3普通权限/隔离选择、W4实际Electron工作面、W5整应用包和干净用户环境。以Windows产品完成为目标，可调整不适合Windows的共享源码；继续复用业务状态机并保留草稿/竞争赢家/不确定结果。

## Windows 原监督者保管输出与来源绑定冷读取（2026-11-03，历史批次）

原监督者在首次resume前接收stdout/stderr的原始读取HANDLE，精确HANDLE_LIST继承，不重开路径或猜PID。宿主原始读取端关闭后，原生直接readOutput明确拒绝，避免与helper抢读；显式transport一次性attachSupervisor后保持共享Node readable接口，PiSession原业务协议不变。helper持续读取双输出、保留原字节和真实EOF，完成时生成各自SHA-256；IPC v5按channel/offset提供最多64KiB不可消费的range，多个观察者各自从零核验。重复读取不向PiSession重放，不改变原始输出证据。

IPC等待请求/响应/ACK期间继续泵出双流，半连接客户端不能令原Job因管道塞满而无法退出。固定合计64MiB lifetime字节上限，宿主正常消费不删除原证据；超限/读取错误/内存不足保留非零outputError，终止原Job并拒绝完整输出/释放结论。EOF与错误单独报告，空流核对真实EOF及SHA-256(empty)。关闭helper仅在原leader/Job空且输出终结后允许，仍只属于组件清理，不产生业务退休证明。

新增inspectExperimentalColdHostOutput复用真实host/source/owner/原监督者核验：要求Job空、双EOF、无outputError、总量在界内，逐范围读取原始字节并比对helper独立摘要，结束后复核kernel事实和真实来源登记。返回observation-only与automaticReplay=false/ownerReleaseQualified=false；结果不被registry当退出证明。该API不解析/采纳Pi stop-ack，也未固定冷journal。实际Pi在宿主normal/forced退出后均核对已被原宿主消费过的原始协议字节仍可读、摘要一致、来源绑定通过、草稿/owner保留且Provider请求仍一次。

最终W2真实源码Node/Electron、中文空格ZIP解包Node/Electron各153/153，新增输出10项：4MiB二进制+Unicode/独立range读者、无宿主消费者双流、leader先退而后代持管道、normal/forced宿主退出、无效handoff/range/伪造端点、64MiB超限、空流、半连接IPC、helper丢失。既有真实Pi22项在四宿主中通过，共享37pass/2Linuxskip。回执W2/output-custody-roundtrip-first/process-component-roundtrip.json，原生构建W2/build-output-custody.json，最终完整性W2/output-custody-final-integrity.json。本批未修改W1源码/原生模块，按当前二进制和86份源码摘要核对沿用前批源码/解包Node/Electron各264/264；不是本批重跑。前批W1回执为source-binding-source-final和source-binding-roundtrip-final。

开发失败output-custody-first.tap为6pass/1fail，唯一失败是清理钩子通过两个观察者重复关闭同一个helper；按原PID+FILETIME记录并仅关闭一次后，second为7/7、最终扩展为10/10，原失败日志保留。完整生产预算suite此前3pass/12fail的未资格化事实保持，本批不宣称生产预算业务通过。

输出证据保存在原helper内存，helper退出/系统重启后不可验证；不能据此宣称磁盘持久化或恢复完成。完整历史成员、冷journal/stop-ack与共享UNKNOWN恢复、任务采纳/释放、生产Workspace/Controller/实际Worker到候选接受Git重启仍待接入；W1资源/依赖/多步事务及W3–W5保持原缺口。W0 passed；W1/W2/W3 unsupported；W4/W5 not-run；managedExecution.ready=false，能力矩阵未放行。下一批继续将原输出中的结束事实与实际journal和owner代次绑定，再接共享恢复及完整产品流程。

## Windows 原始停止响应与冷会话日志核验（2026-11-03，历史批次）

共享prepareRegisteredOwner将冻结的ownerId/generation/launchId/target/home交给显式准备器；Windows准备器验证后以独立环境传入原Pi进程。绑定启动的成功响应携带method及同一ownerLaunch身份，普通未绑定平台响应维持原形状。实际重建Pi runtime并核对manifest，原生进程/helper/W1二进制与源码摘要保持前批不变，本批不宣称原生重编译。

新增inspectExperimentalColdHostJournal，先核对原监督者保管的完整双流及实际来源/owner修订，再复用共享严格JSONL读取器解析原始stdout。仅接受唯一start、最后唯一stop、不同请求ID、相同原始启动身份及匹配session。终态响应须有原生文件/目录flush、File ID与SHA-256；元数据和journal以W1原始父目录链及拒绝并发写入/替换的文件HANDLE固定，有界读取并核对SDK v3头、cwd、entry数、唯一ID/父链、leaf和原生entry事件。保持pin完成实际屏障和来源/输出后检后释放。范围仍为observation-only，namespace-not-qualified，不生成owner退休凭证。

真实Pi宿主正常/强退、Pi先停止再正常/强退宿主、停止帧截断/重复/代次错误/session错误/屏障未确认共9项通过。先停止的正向场景验证原始stop+journal；仍运行即崩溃、缺帧或错误证据均拒绝。另在真实日志上实测追加字节、同字节换File ID、元数据改写、文件缺失、owner代次竞争；不重建缺失文件，不覆盖并发赢家，草稿和prepared登记保留，provider始终仅收到一次输入。registry拒绝将观察对象当作OWNER_EXIT凭证。

完整源码Node/Electron与中文空格ZIP解包Node/Electron各160/160，无失败/跳过，其中真实Pi29项。定向宿主9/9，共享55pass/2Linuxskip，Pi facts/questions14/14。回执W2/cold-journal-roundtrip-first/process-component-roundtrip.json；Pi重建W2/build-cold-journal.json；最终完整性W2/cold-journal-final-integrity.json。W1按当前86份源码/原生与721项解包闭包摘要核对，沿用前批四宿主各264/264，本批未重跑。首轮cold-journal-host-first.tap为2pass/2fail：夹具在Pi已退出后新开进程身份，改为使用原监督者持有身份后4/4，再扩展9/9；两遗留空Job helper通过原登记端点精确关闭，回执cold-journal-failed-fixture-cleanup.json。失败证据保留。历史完整生产预算3pass/12fail仍未资格化，本批未重跑。

该观察不能证明原宿主实际stop请求准入、pending请求/工具调用/宿主投影全部落稳，不能补齐未观察历史Job成员；stopRequestAdmissionQualified=false、hostProjectionQualified=false、coldRecoveryQualified=false、ownerReleaseQualified=false、automaticReplay=false。helper或系统退出后内存证据丢失。下一批仍须补实际请求准入及宿主投影证据、共享UNKNOWN/冷恢复与完整历史成员，然后接生产Workspace/Controller、真实Worker到文件候选/审阅接受/Git/重启流程。W1资源/依赖/多步事务、W3普通权限执行和W4/W5整应用验收仍待完成。W0 passed；W1/W2/W3 unsupported；W4/W5 not-run；managedExecution.ready=false，能力矩阵未变。

## Windows 原宿主输入保管与停止请求绑定（2026-11-03，历史批次）

监督者在首次resume前接管原始stdin写入HANDLE，同时保留双输出原始读取端，宿主原端关闭，native直接write/poll/close/abort明确拒绝。共享Node Writable接口保持原样；每个最多64KiB输入块只提交一次，helper先保留实际字节再发起overlapped写，累计确认原生完成字节，不确定结果不重发。独立64MiB lifetime输入上限；超限终止原Job并保留非零inputError。pending abort保留错误和实际已确认前缀，不把取消报告当完整投递。

IPC v6从kernel取得pipe peer并用CompareObjectHandles核对原宿主进程HANDLE，只有仍存活的原宿主可write/poll/close/abort；冷观察者及同用户其他进程只读。offset CAS拒绝陈旧重发，客户端在失去结果后保持UNKNOWN；原宿主或leader退出时固定关闭输入，完整字节生成独立SHA-256。readInput按不可消费的有界range供观察；IPC等待中继续泵出双输出与pending输入，不因背压停止输出保管。

inspectExperimentalColdHostInput要求实际来源/owner修订、原helper身份、Job已空、inputClosed、无pending/error、accepted==completed及摘要一致。冷journal检查同时解析原宿主输入，要求唯一且有序的start/stop请求，stop为最后输入帧，请求ID各自匹配原Pi响应，原start路径与启动身份一致；结束时复核输入、输出、来源及固定journal。stopRequestAdmissionQualified=true仅限original-host-native-delivery-and-matching-Pi-dispatch-only，不表示宿主业务准入/投影落稳；hostProjectionQualified=false、coldRecoveryQualified=false、ownerReleaseQualified=false、automaticReplay=false继续保持。

新增8项真实输入场景：多MiB Unicode/二进制与独立读者、先写/关闭拒绝handoff、真实背压与abort、64MiB超限、外进程控制拒绝、真实丢IPC回复/陈旧offset零重发、正常/强退宿主后的输入保管和冷写拒绝。新增实际Pi停止响应请求ID不匹配拒绝，真实Pi共30项；其余stop/journal/草稿/并发赢家/单次provider行为维持。定向输入+输出+Pi为48/48；完整源码Node/Electron与中文空格ZIP解包Node/Electron各169/169，无失败/跳过。共享55pass/2Linuxskip。首轮定向16pass/2fail是夹具固定延时和raw IPC连接竞争，改为实际握手/在resume前连接后通过；原失败日志保留。共享首轮误写不存在测试basename只运行52项，已纠正真实pi-session-admission.test.mjs并完整运行57项，最终证据不使用缺项首轮代签。

权威回执W2/input-custody-roundtrip-first/process-component-roundtrip.json，实际原生重建W2/build-input-custody.json（最终构建日志build-input-custody-second.log），完整性W2/input-custody-final-integrity.json。Pi runtime未改，manifest与前批实际重建摘要一致。W1按86份源码、原生摘要及721项解包闭包核对沿用前批四宿主各264/264，本批未重跑。历史完整生产预算3pass/12fail不变且未重跑。

原helper内存证据不跨helper退出或系统重启；宿主pending请求、工具效果与native投影落稳尚无可恢复闭环，历史成员与共享UNKNOWN/冷登记退休尚未资格化。下一步补共享业务投影/恢复，继续接生产Workspace/Controller和真实Worker文件修改→候选审阅→接受→Git→重启；W1资源/依赖/多步事务、W3普通权限执行、W4真实Electron、W5整应用依赖和干净用户验收仍需完成。W0 passed；W1/W2/W3 unsupported；W4/W5 not-run；managedExecution.ready=false，能力矩阵未变。

## Windows 真实共享打开入口（2026-11-03，历史批次）

将 Workspace 的宿主获取、目录/Plan Tree 和 SessionIndex 文件效果抽为 workspace-io.mjs，复用原共享 Workspace/Controller/SQLite 状态机。默认 Windows 打开在创建 runtime/host.lock 前拒绝。显式 createExperimentalWindowsWorkspaceIO 使用原生共享项目宿主租约，核对获取前后的项目绑定，固定 runtime 目录和 create-only workspace-binding.json；绑定项目/实例/metadataRoot/本地数据库目录及其 File ID。另一项目不能共用目录，已有绑定不被覆盖。目录/文件都经原父链及私有 ACL 检查；SessionIndex 采用原生 create-only 发布和有界读取，Plan Tree 用原生 SHA CAS 和目录屏障，MemoryVersion 注入原生读取。Worker home 归档尚未接入，副作用前明确 WORKSPACE_CLEANUP_UNSUPPORTED。

共享写入在宿主登记检查前后运行；业务前检查拒绝并发宿主赢家，实际存储提交后宿主检查失败保留 STORAGE_RESULT_UNKNOWN、草稿和宿主登记，不自动重投或退休。close 同步封口并等待队列，只返回原始不透明租约退休凭证；同进程原凭证可单次 warm reopen，序列化/缺失凭证与真实宿主退出后 cold reopen 均拒绝。Controller.open 使用真实初始化/restore，ownerLaunchFactory 接收原 hostLease，stop 在原 Pi 退出确认后返回宿主凭证。尚不声明整套投影/工具效果恢复或生产能力。

新增16项真实公开入口场景，含草稿/Work 激活/warm reopen、默认与非法适配器拒绝、重叠目录、跨 runtime 争用/独立进程重命名拒绝、伪造凭证、SessionIndex 归档/冷读取/损坏赢家保留、真实共享 Plan Tree 外部 CAS 赢家、MemoryVersion 主题版本、Controller.restore 零启动、ACL 漂移、实际提交后宿主丢失 UNKNOWN、SQLite 宿主登记赢家、Worker 清理拒绝、跨项目 runtime 绑定、实际 public-open 宿主退出。新增1项 Controller.open→真实 Pi 单次 loopback 输入→共享原生投影/归档→确认 stop→宿主退休；Pi 共31项。该 Pi 测试使用隔离夹具显式模型目录，不声明生产配置或冷来源恢复。

完整 W2 源码 Node/Electron 与中文空格 ZIP 解包 Node/Electron 各186/186，无失败/跳过；入口定向16/16，含Pi定向16/16，共享57项55pass/2Linuxskip。W1因共享源码变化实际重跑，源码及解包 Node/Electron 各264/264；闭包新增 workspace-io，不沿用旧源码摘要。回执 W2/workspace-open-roundtrip-second/process-component-roundtrip.json、W1/workspace-open-source-first/native-filesystem-hosts-validation.json、W1/workspace-open-roundtrip-first/component-roundtrip.json；完整性 W2/workspace-open-final-integrity.json。原生和Pi源码/二进制摘要与最近实际构建一致，本批没有宣称重新编译。早期夹具断言、已退休registry读取、eval参数继承和旧源码字符串测试失败全部保留，已由实际运行验证修正。

首轮完整W2 driver在并行W1负载下触及原有180秒总时限，源码Node组未完整收尾，回执workspace-open-roundtrip-first为failed；保留原日志，不计通过。W1结束后用相同180秒时限独立重跑，当前权威为workspace-open-roundtrip-second；未放宽超时。

当前只取得显式公开入口组件资格。生产 selector、宿主 pending/tool/native 投影落稳与共享 UNKNOWN/历史成员/冷退休、资源/依赖复制、Worker 目录归档、多步事务、Worker→候选→审阅接受→Git→重启全程、W3普通权限执行、W4真实Electron/IME/剪贴板/多窗口、W5整应用包/干净用户仍未取得资格。W0 passed；W1/W2/W3 unsupported；W4/W5 not-run；managedExecution.ready=false，能力矩阵未放行。

## Windows 实际 Worker 审校与 Git 归档闭环（2026-11-03，历史批次）

共享 Controller 显式传递 Workspace 的 ExecutionWorkspace/WorkChanges 文件效果和工件 filesystem；文档编辑复用共享 intent/重复调用合同，Windows 用原生 SHA CAS 发布，冷组件重读可核对已生效修改而不重复应用。工件校验读取实际摘要，发布前后变动可被发现。原生接受身份检查使用当前真实 Session/Job incarnation、原 prepared 登记回执及本机 SQLite 当前 revision/全部字段，拒绝 Linux 格式误判、伪造代次和独立登记赢家；原 Linux 路径保持原合同。

实际场景经 Controller.open/start/send 和原共享调度器启动前台、后台及 Worker 三个真实 Pi owner。隔离模型配置在各自真实 home/config 中，全部请求仅发往本机脚本 HTTP：真实文档读→SHA CAS修改→冻结候选报告，共3次请求。源项目接受前保持基线；用户 reviewSave 保存精确人工审校版本，旧 reviewVersion 接受零写入拒绝，reviewAccept 绑定当前版本并交给共享宿主 Git 合入。原始 Session/Job/EOF/最终原生 journal 确认后才停止/释放 Worker 名额，保留其他文件及前台/后台未发送草稿。

Worker home 归档复用共享 closure 状态机：先核对原宿主内存保留的真实 owner 退休回执与当前 SQLite 行。退休证明携带启动时原生pin的home File ID，以及最终确认journal的原相对路径/File ID/SHA；首次创建意图前即拒绝被替换的源目录、已修改或被改名的journal。再 pin 完整私有树，持久化原 home/destination/File ID/身份内容ACL清单摘要，执行无覆盖目录发布/屏障。范围是完整私有 owner home，包含真实 config/sessions journal 与配置；没有宣称凭据删除。实际移动后注入回调丢失，closure 被阻断且 Git结果/intent 保留；重新出现的源目录、journal内容漂移及替换目标目录均拒绝并保留独立赢家。恢复原实体/内容后精确重试只核对/同步原归档，不执行第二次移动。最终 journal SHA 与原生停稳证明相符。完整配置供给、跨目录事务原子性和恶意释放窗口/断电持久性仍未取得产品资格。

确认停止全部3个owner并取得原宿主退休凭证后，同进程 Controller.open 恢复已完成 closure/人工版本/Git状态和未发送草稿，零会话启动、零 provider重放。此为原始不透明单次凭证的 warm reopen；进程重启/异常退出后的 cold 宿主/owner恢复依然拒绝，不以本场景代签。

W2 源码 Node/Electron 与中文空格 ZIP 解包 Node/Electron 每组190/190，无失败/跳过；包含18项打开入口、32项实际Pi/Worker场景。公开入口/owner定向40/40，共享回归57项中55pass/2Linuxskip。W1新增3项真实文档CAS/外部赢家/提交后丢回调恢复，受影响的共享源码实际重跑，源码与ZIP解包 Node/Electron每组267/267。权威回执 W2/worker-flow-roundtrip-first/process-component-roundtrip.json、W1/worker-flow-source-first/native-filesystem-hosts-validation.json、W1/worker-flow-roundtrip-first/component-roundtrip.json；完整性 W2/worker-flow-final-integrity.json。原生/Pi源码与二进制逐项摘要仍等于最近实际构建，本批复用，不宣称重新编译；组件ZIP也不是完整应用包。

开发过程失败日志 worker-flow-first 至 ninth（seventh 为早期正常路径通过）全部保留：工具开关夹具、Linux stamp实际接入缺口、绕过调度器导致的正确in-flight拒绝，以及新增故障测试的字段/字节类型错误。最终使用公开调度器，未放松执行中/进程停稳/UNKNOWN保护。

当前交付仍为显式组件范围。下一阶段优先完整依赖/准备资源供给、共享 pending/工具效果/native投影/UNKNOWN及宿主冷恢复，再做W3普通权限执行、W4真实Electron工作面/IME/系统剪贴板/多窗口、W5整应用依赖闭包和干净用户运行。W0 passed；W1/W2/W3 unsupported；W4/W5 not-run；managedExecution.ready=false，能力矩阵未放行。

## Windows Worker 的依赖/准备资源供给（2026-11-03）

当前 Controller/实际Pi Worker闭环增加冻结package/lock和声明准备资源，在实际执行目录由真实Node导入独立模块并读取资源，候选仍只含正文，审校/Git/退休/归档/warm reopen无模型重放。共享供给策略与原生public-source只读/private-target复制详见windows-filesystem-design.md当前批次。W2四宿主每组190/190，证据W2/provisioning-roundtrip-third/process-component-roundtrip.json；重建的W1四宿主每组286/286。源链接、旧暂存/UNKNOWN冷协调与完整产品范围仍未资格化。

## Windows 供给完整副本冷协调回归（2026-11-03）

共享Work清单持久化完整副本的原始分配/身份/内容/ACL和发布/逐项清理意图，显式冷协调已完成副本/发布而不重放；部分复制仍UNKNOWN。W1源码/解压Node、Electron各297/297，实际Controller/三Pi Worker流程在W2四宿主各190/190。此证据不覆盖宿主pending/tool/native投影/历史Job成员/owner冷退休，能力矩阵不变。详见windows-filesystem-design.md当前批次及W2/provisioning-recovery-roundtrip-second/。
