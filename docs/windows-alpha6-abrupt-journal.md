# Windows alpha.6 强杀后的原生 journal 前缀核验

基线固定 merged PR27 `cb07c5180c85ca0e127ddc332089300498103cc5`，原生监管协议仍为v8。上批要求最终stop回执，本批让Windows实际Pi启动、prompt返回带上该次已有原生flush的journal快照，显式flush也带精确byteLength。快照含File ID、SHA256、条目数、leaf及文件／目录同步结果。Linux／Mac返回合同不增加该Windows字段。

宿主死亡、原Job停稳、原输入输出EOF／完整摘要和来源登记均核实后，冷检查器可在没有stop回执时核对原始响应所确认的journal前缀。每份快照必须关联唯一原始RPC／method／launch，文件身份不变、前缀长度单调、SHA256／完整JSONL／条目数／leaf一致；无原生同步证据、身份替换、摘要变化或超预算均拒绝。最多256快照、累计256MiB前缀校验预算，超限明确unsupported，不删旧历史。

最后确认前缀之后的字节作为未确认尾部保存长度和摘要，允许不完整UTF8／JSONL而不截断、改写或作为任务完成证据。前缀外entry事件只统计为未确认；没有原prompt返回仍是execution-unknown。已完成工具效果但宿主尚未回复时，原tool调用保留unresolved，禁止重放。journalDigestVerified在无stop路径为false，只有confirmedPrefixDigestVerified为true；finalJournalComplete保持false。当前观察者可同步现存文件，但不把它等同于原owner确认了尾部。

显式inspectJournals冷检查点仍复用ProjectStorage原生来源、原宿主launch集合、实际SQLite CAS和UNKNOWN；提交前后复核当前整文件／metadata摘要，尾部变化也会阻断。前缀观察不退休owner、不清理home、不释放业务额度、不改变任务和projection，不选择默认ManagedProjects。businessSettlementQualified、coldRecoveryQualified、ownerReleaseQualified及productionSelected仍为false。

证据根 `D:\nozeli-test\20261110-alpha6-abrupt-journal`。测试使用真实Windows Pi SDK、原生Job和独立合成项目／本地HTTP Provider，无真实账号或付费模型。真实强杀、分离目录、尾部残留、替换文件、篡改快照、丢回复以及工具效果一次但无回复均纳入永久回归。最终结果见下表；W0–W5全部目标和历史全量失败保留。


## 最终实际结果

总收据 `D:\nozeli-test\20261110-alpha6-abrupt-journal\qualification.json`。全部0 fail／0 skip／0 cancelled，仅为本批定向资格。

| 范围 | 结果 |
| --- | --- |
| journal-node-verified | 52/52 |
| journal-electron-verified | 52/52 |
| journal-extracted-node | 52/52 |
| journal-extracted-electron | 52/52 |
| cold-node-final | 15/15 |
| cold-electron-final | 15/15 |
| cold-extracted-node | 15/15 |
| cold-extracted-electron | 15/15 |
| worker-node-final | 2/2 |
| worker-electron-verified | 2/2 |
| worker-extracted-node | 2/2 |
| worker-extracted-electron | 2/2 |
| gui-source | 6/6 |
| gui-extracted | 6/6 |

每套52项含40项真实Pi／原生监管／Controller与12项解析器。强杀后的桌面分离根检查点成功；工具效果已写一次但无回复仍unresolved，Provider仅调用一次，不重发。原文件前缀改动、替换File ID和原响应快照摘要篡改均拒绝；不完整尾部保留原字节。最初50项完整跑通过后增加2项边界，再以最终52项四环境复验。筛选测试的8个pass包含一个空文件subtest，不作为完整套件计数。

Pi及renderer本批实际构建，原生filesystem／process沿用输入未变对应实编字节，protocol v8不变；本批未干净npm ci。JS语法1243文件通过。

ZIP `C:\nozeli-test\20261110-alpha6-abrupt-journal\desktop-package-final\Nozeli-windows-alpha6-abrupt-journal-qualification.zip`；SHA256 `a1a75488ad018a426108d89557959b5e26f8dd10cbe97c2bc09462b61a9b09e1`。43617文件、1412782818展开字节、1702当前src／dist／tests／tools冻结文件。CRC、中文空格目录独立解压、逐文件摘要、原生输入／二进制、当前Pi src／dist和manifest及仅System32 PATH包内Node／Electron／Git／Pi解析通过。旧包独立保留。

Worker各2项使用真实Controller／Pi SDK／Git与本地合成HTTP Provider，单根及分离根的修改、明确接受、归档与warm reopen通过。GUI各6项仅签收可见shell、原生IPC保存CAS、冲突草稿及重启恢复，不代签物理Explorer／IME／多屏或完整文档显示。无真实／付费模型或日常账号。

全量unit813通过／8失败／1跳过、safety12／25／16、integration766／1111／58为历史未清零，本批未重跑。完整业务冷接管／默认派工和W0–W5仍未完成；当前仅为带合成harness的本地开发ZIP，未安装／签名／发布／commit／push。

首轮打包因D盘ENOSPC失败，部分测试进程／收据也受影响；失败TAP与disk-full-failure.json保留，不将Electron已出现的52-pass TAP代作成功收据。删除本轮失败staging的命令被自动审批拒绝，该副本保留；新包改放C盘并独立复制，受影响完整套件以新模式重新执行后才记为通过。
