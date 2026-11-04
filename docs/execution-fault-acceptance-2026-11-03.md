# 任务执行故障验收报告

日期：2026-11-03。结论：**测试已执行，产品验收部分失败，不是完整恢复闭环通过。**

## 范围与证据等级

- Linux/x64，当前源码；实际 DesktopHost/ManagedProjects、私有原生 Pi/OMP 进程、Git/worktree、文件、bash 和 HTTP；用户操作另用真实 Electron 界面验收。
- Provider 是隔离 loopback HTTP 服务，响应和工具选择由测试脚本控制；不是付费模型，不构成真实模型自主诊断、推理或修复软件 bug 的能力证明。
- 无用户项目、凭据、论文或日常 profile 操作；未安装、未提交。原始源文件不自动采用；测试创建的隔离任务可显式丢弃以验证清理和名额释放。
- HTTP 失败均可复现；服务恢复通过真实 ProviderSettings 配置保存及故障解除 API 模拟用户处理，不修改 job 状态来制造成功。

## 场景结果

| 场景 | 实际表现 | 验收结论 |
| --- | --- | --- |
| 宿主暂时准备故障 | 原 callback 在模型准入前有界恢复，持久化 `repaired`，不启动模型 | 通过宿主精确恢复 |
| Git 发布 ref-lock 暂时阻塞 | 宿主首次 repair 未验证；测试程序撤销自己持有的锁；原生 Orchestrator 调用 status/retry，原发布事务验证成功 | 通过精确恢复接线；不代表模型自主移除锁 |
| 持续 Git ref-lock 故障 | 两次 repair attempt 后 `needs-version-fix`；再次请求不执行效果；原 Work/结果/源文件保持 | 通过有限预算和升级边界，故障本身未修好 |
| 404 `model_not_found` | 单次失败，无服务故障卡或解除能力；切换模型后原失败输入未续接 | **失败：缺用户可处理故障报告／恢复闭环** |
| 402 `insufficient_balance` | 正确归类 balance/user-critical，落盘报告；用户修正后解除返回 `needs-reconciliation` | 报告／防重放通过；**原失败任务续接失败** |
| 429 `insufficient_quota` | 正确归类 quota/user-critical，落盘报告；修正后原任务仍 paused/failed | 报告／防重放通过；**原失败任务续接失败** |
| 503 `service_unavailable` | 原生重试3次后停止并记录故障，不递归派生维修模型回合；解除后原任务未续接 | 重试边界通过；**原失败任务续接失败** |
| Electron 用户解除402 | 真实界面显示故障来源／影响范围／证据；点击“故障解除，继续”后尚未投递的原队列输入执行一次并发布 | 队列解除通过；已投递失败 Work 仍待核查，不算恢复成功 |
| 项目并发名额1 | 第一个 Work 待审仍占名额；第二个排队且没有 Worker；显式结束并完成第一个的清理后，原第二项自动执行一次 | 通过；这是任务名额，不是模型账户余额 |

## HTTP 故障发生在真实副作用之后

每个场景先通过实际原生 bash 向隔离 `effect.log` 追加一行，再发生服务错误。恢复后副作用仍为一次；没有通过从头重放来换取表面成功。

| HTTP | Provider请求总数 | 故障重试数 | 恢复前副作用次数 | 恢复后副作用次数 | 原失败任务完成 |
| --- | ---: | ---: | ---: | ---: | --- |
| 404 | 3 | 0 | 1 | 1 | 否 |
| 402 | 3 | 0 | 1 | 1 | 否 |
| 429 | 3 | 0 | 1 | 1 | 否 |
| 503 | 6 | 3 | 1 | 1 | 否 |

请求总数包含一次 Orchestrator 派工、一次 Worker 工具调用及后续故障请求，不等于重试次数。四场景各只有一次派工；Work/thread/job/native requestId/collabAttempts 保留。没有伪造第二个“继续”输入替代原失败输入。

## 未通过项与修复边界

### F01：模型不存在没有可处理的服务故障报告

`src/agents/managed/service-faults.mjs` 的 `classifyServiceFault` 接受401/403、402、429及500–504，但HTTP404未归类。实际 `model_not_found` 进入错误记录却没有服务卡／解除能力。不能将所有404都当模型不可用：修复需要可信的结构化模型错误证据，并提供与对应模型设置绑定的处理说明，不能通过任意错误正文猜测或扩大服务阻塞范围。

### F02：已准入失败输入缺少安全续接能力

402/429/503服务解除实际返回 `needs-reconciliation`；已进入原生执行的原输入仍 paused/failed。配置更新与模型切换未提供续接原 native turn 的能力。当前防重放是必要的，但“用户修好条件后继续执行”尚未闭环。

修复应在原request/thread/已确认工具回执上区分：未投递、已准入但无效果、工具效果已确认、效果未知。仅在原生运行时有权威续接能力且不重复已完成工具时续接；未知效果保留核查，不通过重新发送原prompt、改写失败job或新建Work伪造恢复。

### 能力限制

本轮验证 Orchestrator 能调用宿主已暴露的精确恢复能力、且宿主验证结果，不验证一个真实模型能够自行定位并编写通用软件bug修复。暂时锁由测试程序撤销，明确不归功于模型。持续内部缺陷升级为版本修复，不应伪装成用户需修SQLite、协议或进程内部状态的工作。

## 执行命令与原件

| 执行 | 观察结果 | 证据 |
| --- | --- | --- |
| `node tests/pi-repair-lifecycle-live.mjs` | exit0，8项检查，真实原生恢复，持久化故障报告 | `/tmp/nozeli-pi-repair-live-fAbNIj/report.json`、`fault-report.json` |
| `node tests/service-fault-native-live.mjs` | **exit1**；`harnessOk:true`、`acceptancePassed:false`，4种故障均跑完，记录F01/F02 | `/tmp/nozeli-service-fault-native-O8QBQ8/report.json`，各状态码子目录 `fault-report.json`、`state.json` |
| 真实Electron用户服务故障定向场景 | exit0，故障报告／解除队列／防重放3项检查；并非原失败任务恢复通过 | `/tmp/nozeli-agent-control-ui-Lc65og/report.json`、`balance-fault-report.png`、`user-resolution-report.png` |
| 真实原生并发名额定向场景 | exit0，3项检查，2次dispatch/2次publication；原排队Work自动推进 | `/tmp/nozeli-concurrency-fault-bilNX6/report.json` |
| `node --test tests/service-fault-control.test.mjs tests/maintenance-runtime.test.mjs tests/maintenance-status-page.test.mjs` | **41/41通过**；确定性守卫测试不替代上述运行验收 | 本轮工具执行输出，约27.8秒 |

新增 `tests/service-fault-native-live.mjs` 是显式运行的故障验收脚本，不把已知产品缺口改成宽松绿灯。既有 `pi-repair-lifecycle-live.mjs` 增补持续故障和真实工具回执；没有修改生产恢复策略来掩盖失败。临时UI／并发驱动已删除，报告和截图原件保留。Windows/macOS、真实远程Provider账户故障及付费模型推理能力未验。

## 真实项目补充：已准入回合误触确认超时

本节不同于以上隔离 HTTP 故障验收：用户明确授权在真实任务与原用户 profile 推进和验收；没有更新安装版、接受合入或改写失败记录。F01/F02 的失败结论不因此变为通过。

- 真实第 6 轮已有 `admitted` 事实及两个只读工具回执，却在 600 秒被 `Pi prompt acknowledgement timed out` 中止；原生日志末项为 `aborted`，HTML、数值验证脚本与视频渲染器的摘要均与第 5 版一致。确认本轮未写入后才补充新指令，没有重放旧命令。
- 根因：`PiSession.request('prompt')` 的确认 timer 一直保留到完整原生回合响应。修复以当前 prompt、native requestId、owner/session/generation 精确匹配的真实 `admitted` 同步解除该 timer，不增加时限；RPC 继续等待结果／错误／进程退出。晚到准入证据独立保存，不复活超时 promise，不把准入当作持久化或完成。
- `node --test tests/pi-session-admission.test.mjs tests/pi-activity.test.mjs`：28/28；`node --test --test-name-pattern='real native admitted prompt survives acknowledgement deadline' tests/pi-lifecycle-live.mjs`：2/2。真实私有 runtime 的 1000ms 准入时限后继续阻塞 loopback provider 1200ms，解除阻塞后正常完成；另一场景中终止 owner 后仍拒绝原 promise 并清空 pending。均只投递一次，无真实模型调用。
- 真实应用经正常窗口关闭、exit 0 后，以源码候选和原 profile 重开并正常连接角色。宿主核查回执仍明确 `inspection-required`、`requiresExplicitSupplement:true`、`automaticReplay:false`；新的第 7 轮保持原 Work、Agent、原生 thread，第 6 轮仍为 failed，第 5 版报告保留。**这是核查后的显式新补充，不是原失败 native request 的原位续接证明。** 此时第 7 轮仅已受理／执行中，不宣称成果验收通过。
- 第 7 轮真实 Worker 执行时，打开当前聊天实测 57.8ms；执行状态条在时间线外，显示活跃 1、排队 0、本轮经过 3 分 21 秒。5 秒可见前台采样 299 个帧间隔，P95 17.4ms、最大 24.9ms，零个 >50ms 帧间隔及零个 long-task。该短样本不代表硬件输入延迟、后台长时性能或所有设备。

原件：`/tmp/nozeli-li-normal-restart-A5HTyL/report.json`、`/tmp/nozeli-li-verified-supplement-kuGbeW/report.json`、`/tmp/nozeli-li-real-navigation-avWzPr/report.json` 及其截图。源码候选构建 `npm run build:renderer` 与原 profile 启动通过；Linux 限定，未安装／发布，Windows/macOS 未验。

### 原任务最终第 9 版：成果与界面定向验收完成

第 7、8、9 轮均由配置的真实模型在同一 Work、Agent 与原生 thread 完成并发布；第 9 版停在 `review`，`merge:null`，未接受合入，旧报告和第 6 轮失败记录保留。第 8、9 轮反馈均经真实报告的本地保存、确切审核版本确认、“继续原 Worker”交接，不复制新 Work。再次强调：这些是显式新补充，不改变上述 F02 原失败 native request 续接仍未闭环的结论。

| 验收 | 实际观察 | 范围／限制 |
| --- | --- | --- |
| 页面物理 | 96/96 参数角点、1,197,364 个运行子步的宿主相对位置／速度、根数与守恒检查通过；P 初始最大偏心率 `1.49e-8`，不再出现 `e=1、a=R/2` | A/B/P，有限行星质量；各角点仅 0.223607–2 年，不是长期稳定性证明 |
| 验证器一致性 | 第 8 版修正 P 初速和恒星-only COM 诊断；独立 A/B/P 六组、1,145 个运行子步，完整状态、能量、相对距离与页面误差均为 0；S/A、S/B 保持 | 验证器自带页面对照仅初始状态；动态一致性由独立审计提供，不夸称自测能力 |
| 原生浏览器行为 | 53/53：A/B/P 往返、六滑块各模式 min/max、播放／暂停、动态默认重置、宽窄首屏画布及播放控件可见 | 隔离原生 HTML fixture，不替代真实 Worker 执行证明；无模型请求 |
| 原项目最终真实预览 | 第 9 版确切冻结源，dirty/unsaved 均 false；首屏画布中心及播放按钮可见；新预览打开 1261.6ms；5 秒 300 个帧间隔，P95 17.9ms、最大 24.8ms，无 >50ms 帧或 long-task | 原用户 profile／真实源码候选；零新增 job；非硬件输入到整桌面最终合成延迟 |
| 最终视频 | 实际解码 H.264、1280×720、24fps、12 秒、288/288 帧；代表帧及预览已查看；全系统质心、初始双星间距、初始二体周期估算明确 | 修改标签实际字体 bbox：面板 `(973,306)–(1166,323)`，页脚 `(40,678)–(1018,695)`，均不裁切；短视频不是任意参数长期轨道证明 |

最终 HTML SHA `f3056414b7c73f3c71d730ec065d693d8835621e93d062eae189577b5cbd4d41` 与已验第 7 版逐字节一致；验证器 SHA `a9d227121991d1f3c777e94c5a204cdc3a3b281aa9c1911ef0fc1d8eed40cb15` 与已验第 8 版一致。第 9 版渲染器除字幕字符串外可执行 AST 与第 8 版完全一致，因此不重复 96/53 套件或渲染器积分；仅对最终资产、文字边界、实际解码及当前版本接线复验。实际原项目预览截图来自 guest WebContents；shell 截图不证明原生子视图的整桌面合成，ImageGrab 整桌面截图尝试失败，不据此宣称该层验证通过。

证据：`/tmp/orbital-final7-physics-t3gC3spz/physics-report.json`、`/tmp/orbital-final7-native-80jqbtnh/report.json`、`/tmp/orbital-final8-physics-vg5AFH9O/targeted-report.json`、`/tmp/orbital-final8-video-audit-xvostwef/video-audit.json`；最终发布快照及剩余项复验 `/tmp/nozeli-li-final9-frozen-aCnPFL/freeze-report.json`、`final-residual-checks.json`；真实当前报告与预览 `/tmp/nozeli-li-final9-real-surface-Zh8nVM/report.json` 及截图。应用最后停在第 9 版报告，等待用户决定，源码候选保持可用；未安装、发布或接受合入，Linux 限定。
