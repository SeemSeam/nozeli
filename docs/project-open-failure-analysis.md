# 项目打开故障：现场证据与因果链（2026-11-08）

Status: 深度调查；未修改产品、用户项目或生命周期围栏。登记入口见[Plan Tree](plantree/README.md)。本页不是已修复/已恢复声明。

## 结论与证据等级

**直接阻断已确认：nozeli_test 存在持久remove生命周期围栏。原项目实体/身份正确，普通打开、重试、重新选目录均先被围栏拒绝。最强底层原因是跨进程flush capability漏接视图状态保存；需要实际安装包隔离复现确认子错误。**

真实只读现场证据：`/tmp/nozeli-project-open-analysis-aq_2g_do/catalog-snapshot.json`、`lifecycle-records.json`、`workspace-layout.json`。记录含本地项目身份，不提交用户正文/凭据。

- 项目`7d9ed862-bbdc-4c7c-946d-a63b368fba6e`，instance`150dc709-14e0-44f7-85d4-f9a384da1766`，root为`nozeli_test`，removed=false。
- root dev/ino=66308/26130527；metadata dev/ino=66308/26108200，均匹配登记。project.json的projectId匹配当前ID。另一个正常项目无持久hold。
- 当前catalog hold：action=remove，operationId=`3f7836e1-d887-4573-9b0a-1365d4bd1d7c`。
- 两次remove：`27646c08-b71a-4a79-b6eb-9611487ba104`及上述操作；2026-11-08T00:19:13Z均停在needs-attention / failedPhase=prepared / PROJECT_FLUSH_FAILED。对应workspace close journal同为保存失败，没有完成移除。
- 现场布局为干净网页`https://www.baidu.com/`及保留的conversation，无打开正文文件、无可见dirty状态。存在一份早期native pending投影，不能未经对账宣布全部写入已结算；它不是当前保存失败的已证主因。
- 分析所用main.cjs/project-storage/project-lifecycle/workspace-native/preload/online-browser-view与实际安装副本逐字节相同。

## 因果链

1. `ProjectLifecycle.run`先持久hold；apply写prepared，然后needsStopCheck=true，停止writers/drain，再调用workspace.closeProject。
2. closeProject要求全部真实renderer flush成功。网页`online-browser-view.save/flush`即使没有草稿也无条件执行`workspace.command restoreViewState`；会话retainWorkspace成功后writeView也执行同类写入，settings变化时另写workspace.settings。
3. preload的flushScopedWrites与native.lifecycleFlushOwner均不包括workspace.command/restoreViewState，也不包括workspace.settings。因此请求缺少flush receipt/真实owner。
4. main.cjs外层withProjectOperation在业务execute/native.authorize前就调用assertActive，持久hold下抛PROJECT_LIFECYCLE_ACTIVE。native内部允许restoreViewState并不能穿透这层拒绝。
5. renderer保存失败→聚合PROJECT_FLUSH_FAILED。closeProject未成功，所以needsStopCheck不清；finally保留hold，登记仍removed=false。下次ready从catalog恢复hold且needsStopCheck=true；open/retry/register均在实体核验前拒绝。
6. 普通retry并非生命周期reconcile。重启也不是证明writers已停稳，故不会自动解锁；反复打开/重加不能处理这一状态。

## 为什么几轮修复和Debug没有覆盖

- 临时metadata不可用修复处理unavailable/quarantine缓存；退役身份修复处理旧ID误隔离新ID共享数据库。两者都不解决持久remove围栏及renderer flush授权缺口。
- 既有生命周期测试用host内callback替代workspace.closeProject，继承了AsyncLocalStorage owner，绕过真实renderer→IPC准入边界。
- native.authorize单独测到restoreViewState可用，但未经过main外层storage admission。
- 保存失败原异常有error.failures，但close journal及lifecycle journal只记code/message，IPC respond只读error.details，丢掉每个view/code/message；现场仅留下通用“部分内容未能保存”，导致旧调查难以归因。
- 此次现场明确是PROJECT_FLUSH_FAILED，不应把所有历史项目打不开都归为同因，也不能将过去隔离通过篡改为现场彻底解决。

## 正确处理顺序（待实施/授权）

1. 先在安装ELF隔离项目复现干净web/conversation移除；采集原生session.flushed每个owner的code、操作、requestId和恢复journal。覆盖非空地址草稿、会话草稿、正文编辑分别失败/成功。
2. 修跨进程保存能力：只给真实pending receipt所属record/generation/project的必要持久化操作放行；workspace.command仅允许该view的restoreViewState，不能把所有布局命令或项目写入加入宽泛豁免。同步preload envelope、native验证、main owner传播与payload校验，保留CAS、恢复失败和unknown门。
3. 错误可诊断：有界保存失败owner/op/code/message到details及恢复记录，不写用户正文/账号；UI给出明确恢复入口而非只写“保持打开”。
4. 修复后以显式生命周期核查处理现场旧hold：验证原instance、日志身份、无pending/active stop，停稳/drain成功再由正式reconcile解除围栏；不手删hold/host.lock，不以再次remove当成无副作用诊断。
5. 打开/重试遇到生命周期hold应导航到准确operation的“核查停稳状态”，不是盲目重试storage.retry。reconcile成功后刷新可用性和入口，不能把needs-attention journal与仍有hold混为一谈。
6. 验收须证明正常打开→web/conversation→remove→重新添加→冷开完整链，以及同场景保存真实失败仍阻断；防止只通过删除保存屏障/延长超时/清锁假修复。

本轮仅分析；不会对真实项目执行reconcile/remove/reset。实际隔离复现结果在后续追加，不以源码推断冒充运行证据。

## 实际安装包隔离复现（已执行）

1. **原生renderer原路径复现**：`/tmp/nozeli-open-flush-diagnosis-XO0jXc/report.json`。实际current/nozeli＋独立临时profile/project，干净web surface打开后真实project.remove返回PROJECT_FLUSH_FAILED，登记removed=false，prepared→needs-attention，随后project.recent与session.requestClose也被PROJECT_LIFECYCLE_ACTIVE拒绝。无模型请求/用户账号/真实目录修改。首次驱动清理遗漏存储worker关闭，命令最终120秒超时；其中ok=true不能视为成功关闭或修复通过，只以明确返回和journal为故障证据。
2. **最小renderer保存请求诊断**：`/tmp/nozeli-open-flush-diagnosis-HhXtOW/report.json`。仍运行同一实际安装包；仅在隔离网页wrapper的flush handler中替换为与原save完全相同的restoreViewState调用，以记录返回子错误（不是原handler未修改的第二次复现）。真实pending flush期间该调用返回PROJECT_LIFECYCLE_ACTIVE，project.remove再聚合为PROJECT_FLUSH_FAILED，后续recent同样阻断，journal同形，reproduced=true。没有修改安装字节或准入规则；只终止/清理独立测试进程，未终止日常应用。

两次结合证明“实际安装版正常web保存链会失败”及“同一IPC保存操作被自身hold拒绝”的运行时闭环。真实现场最初未持久子错误，故不能反向宣称已重建那次失败的完整回执；但现场相同web布局、相同安装源码、相同错误/围栏形态与复现一致，证据强于仅凭泛化错误猜因。

调查尚未执行产品修复或真实项目解锁；下一轮必须同时修flush协议、可观察诊断与旧围栏正式核查路径，再以原生renderer跨IPC场景复测。不能因为隔离回执reproduced=true就称产品已通过。
