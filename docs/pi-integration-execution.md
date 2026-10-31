# Nozeli + Pi GUI 独立整合执行记录

Date: 2026-10-30
Status: strict functional parity execution in progress against the frozen original development tree; previous evidence remains historical, not acceptance of this new candidate. No installation or public release authorized.

## 授权与输入

用户要求在 `../nozeli_pi` 整合当前 Nozeli + pi-gui，并充分回归。用户在本次选择中明确保留 frontdesk / orchestrator / Worker 三角色；此前方案中删除纯路由 orchestrator 的建议不在本次实施范围。

- Nozeli 来源：同级 `nozeli_git` 当前工作树，基础提交 `0f60923de47573cdc02c3be0e914767fbc6a6f2b`；包括当时 tracked diff 和 15 个未忽略新源码文件，不只复制已发布 alpha.2。
- 独立快照：本仓库 `e2fad88`，36 个文件的当前源码改动纳入快照。源工作树未提交、未修改。
- pi-gui 来源：同级只读参考仓库，固定 `eddfb19367b3ec4e59314eddfa83ed5aa6989f03`。最小运行时代码闭包、MIT 许可和本地补丁另由 `integrations/pi` 记录。
- SDK：固定 `@earendil-works/pi-coding-agent` 1.4.0，不能推定与 OMP API 兼容。
- 新目录独立 Git 分支 `integration/pi-gui`，已移除指向原本地仓库的 origin，避免误推。未复制被忽略的用户配置、论文、凭据、node_modules 或浏览器资料。
- 不安装、不发布、不替换日常版本，不操作用户业务项目。模型能力实测优先使用隔离确定性本地 Provider，不使用用户凭据。

## 不变量

Nozeli 保留唯一 GUI、Work/版本/报告/审核/任务队列/进程额度/材料账本权威；Pi 独立 Node owner 只拥有原生会话、模型调用与工具生命周期。不得引入 pi-gui 第二任务账本或自主重派队列。保持三角色权限、当前授权内直接工作、文档 CAS/未保存编辑保护、批注显式交接、冻结发布、采用/丢弃/关闭语义。未知副作用不自动重放。历史 OMP 原件保留，不把旧会话改名为 Pi 或悄悄回退旧内核。

## 实施分工

1. `integrations/pi`：上游最小源码与许可、固定依赖、Node IPC 生命周期、宿主工具桥、会话持久屏障、取消/退出与父进程死亡处理。
2. Host/Controller：单 owner 会话适配、真实 Pi 原生 entry 投影、Host admission、队列、恢复身份、进程退出确认。
3. Provider/启动/打包：Nozeli 私有 Pi 设置目录、模型与认证、默认模型传播、启动/打包不依赖系统 OMP/Pi/Bash。
4. GUI：保留 Nozeli 工作面，移除 OMP TUI 专用接管入口，保留真实会话模型/思考档位和上下文操作；不伪造终端。

## 回归门

| 门 | 必需证据 | 当前结果 |
| --- | --- | --- |
| 源码与依赖冻结 | 当前源快照、上游 commit、依赖锁、许可 | Pi 上游46文件原始/修改后摘要、三份精确补丁、SDK1.4.0依赖锁、MIT原许可已保留；最终428输入摘要 `159ee509d7b8f1cfae3579e44540aa51a9815ebdc6fb1d79cfb8b16b55d08728` |
| 合并前 Nozeli 基线 | 独立目录完整现有确定性套件，单列既有失败 | `npm test`：471/471 unit + 1379/1379 integration；186 文件，0 failed/skipped/cancelled，475.81s。原始结果 `artifact://9557`；持久 TAP 在 `apps/desktop/.test-output/ci/{unit,integration}.tap`（后续运行会覆盖）。这是原 OMP 基线，不计 Pi 验收 |
| Pi 前台纵向 | 真 Node + 本地 Provider + 原生会话文件；读写、CAS冲突、草稿保护、图片取材 | 已验真实 SDK 文件写入、Host文档读取/精确修改、UNSAVED及STALE_VERSION保护、图片协议与原线程恢复；reload后Host工具仍执行。确定性本地HTTP，不称模型理解质量验收 |
| 后台工作闭环 | 三角色真实工具路由、Worker候选、冻结发布与用户决定 | 真实 frontdesk→orchestrator→Worker 工具链写候选、冻结HTML并发布、用户丢弃、冷历史零重放通过；采用/续改/审核等由现有行为回归覆盖，不冒充本轮真实Pi模型逐路径验收 |
| 生命周期 | 取消、重开、reload、持久失败、Host/Node死亡、后代清理 | 实际取消前无文件副作用、图片后精确resume、Host投影失败原生journal保留与持久化hold、SIGKILL owner／关闭Host管道后的真实SDK detached bash/Node后代清收通过；重用PID拒绝。模型effort返回原生clamp后的值，不回显请求档位 |
| Electron 工作面 | 实际设置、发送、阅读、选区、批注、冷恢复、窗口 | 源码及随包Node候选真实Pi设置/模型菜单/发送/回复/退出/未发送草稿冷恢复通过；真实Unicode选区批注、原始材料摘要、文本保存与未保存内容恢复账本、批注冷重开通过。X11完整8次脱离/返回曾通过；重复压力轮仍见save/undo键盘与原生焦点不稳定，不能称完整矩阵稳定通过 |
| 全量回归 | 显式unit/integration + 真Pi live + Electron | 最终完整461/461 unit +1377/1377 integration，187文件，0 failed/skipped/cancelled；串行轮1319.88s，原始 `artifact://10006`。Pi真实live12/12通过。晚期/tmp EDQUOT污染轮保留且不计通过；改用已证SQLite读写的独立/var/tmp目录，并将真实存储transfer测试的3s等待对齐既有30s集成deadline，不改业务结算超时 |
| 平台 | Linux / macOS / Windows 分别记录 | Linux x64、Node22.22.1开发／随包22.23.4、Electron44.9.1；X11主验，Wayland撤销专项失败；Windows/macOS未验，孤儿进程确认不伪签，跨平台未签收 |

测试通过不能冒充真实产品场景，确定性 Provider 不能冒充付费模型质量或 OAuth 实际登录。不得以隐藏失败、伪造 Collab/PTY 属性、静默省略回归功能得到全绿。最终记录具体命令、结果、场景原件与缺失能力，验收不等于安装授权。

## 已发现并处理的实际问题

- Pi SDK将原生命令启动为独立process group；仅检查owner的group会错误释放名额。增加每owner代次UUID和私有home双绑定扫描，真实detached子进程回归修前失败、修后通过；恢复不因PID复用而误杀。
- 原先窗口close未等待逐键composer持久队列，冷重开主草稿可能短于保留快照。接入现有面板返回的flushDrafts，drain追踪最新watermark并保留逐项目写入失败；真实输入后立即退出/冷重开完整草稿通过，两个确定性边界用例保留。
- 模型菜单异步回调比较临时对象引用，导致目录读回后不渲染；改为项目/目标/owner身份对比。真实Electron菜单选模型通过。
- 原生entry事件不能单独充当落盘证明；settle后fsync并读实际journal逐ID投影，Host drain成功才结算。工具回执使用Pi toolCallId，不用反向IPC帧序号代替；投影失败保留原journal并阻止成功声明。
- 自定义源不能先调用上游仅支持内置Provider的authSetKey。改为复用上游CustomProviderStore原子保存endpoint/api/model/key，并保留Nozeli已有三种API协议、0600文件。真实设置进程三协议保存、密钥脱敏、OAuth选择器取消与再次打开通过；真实账号OAuth登录未验。
- 三角色保持用户选择；旧OMP居民身份归档、旧Worker需显式同Work交接，不将原日志改名为Pi或自动重派。旧TUI人工输入/PTY专属测试退休，文档CAS、发布字段、历史冻结、队列和错误hold行为测试迁移保留。

## 隔离与原目录事件

`nozeli_git` 来源工作树、日常安装版及用户业务项目未改动。Provider子任务曾误写旧同级 `nozeli` 目录；已按其首次status和逐项操作前快照恢复原main启动段、provider源码/测试、打包原稿及仅本轮追加文档，移走仅其创建且与新目录字节一致的Pi文件。未用reset/restore覆盖原有工作；恢复前产物保存在忽略的 `.test-output/source-recovery`。其余三个子任务的写/edit记录核对均指向新目录。新目录建立时创建了本地快照提交 `e2fad88`，整合代码未另提交、未push、未安装。

## 可复用命令与证据

在 `apps/desktop`：

```sh
npm run start:pi-isolated
NOZELI_TEST_LIVE=1 npm run test:live
node tests/desktop-pi-live.mjs
NOZELI_OZONE=x11 node tests/desktop-reading-current.test.mjs
NOZELI_OZONE=x11 node tests/desktop-native-workspace.test.mjs
npm test
```

首条使用本仓库 `.runtime/pi-development` 独立profile及singleton，不升级或迁移日常Nozeli资料；隔离启动实际空profile/正常退出已验。测试根的普通配置路径和以上命令不构成跨平台操作签收。磁盘配额受限时可给测试显式设置全新可写TMPDIR，不能复用或清理他人的临时项目。

持久证据（忽略、非发行物）位于 `apps/desktop/.test-output/pi-integration-evidence/`：完整曾通过日志、live TAP、源码/随包GUI报告、原生窗口报告、quota失败日志、最终输入摘要与随包Node/Pi清单。原生阅读完整通过原件 `/var/tmp/nozeli-pi-regression-k7q9eor4/nozeli-reading-native-T2kjeJ/report.json`；最后随包GUI `/var/tmp/nozeli-pi-regression-k7q9eor4/nozeli-pi-electron-oHoa6O/report.json`。候选只暂存执行，不激活安装；通过后删除仅自建暂存包，保留报告及清单。

多格式当前原生宿主补验：`desktop-dynamic-geometry-live.mjs`七格式（DOCX、XLSX、PPTX、PDF、PNG、Markdown、Python）均通过主窗/脱离窗resize、maximize、fullscreen、restore、dock同owner和源文件保护；`errors:[]`。原件 `apps/desktop/.test-output/pi-office-geometry/dynamic-geometry-live-HWwzFy/result.json`，已固定副本 `pi-integration-evidence/office-native-geometry.json`。这是实际内容几何/选区/缓冲保持验收，不冒充Office所有编辑命令逐项验收。

补验中发现低级CDP `bringToFront`/DOM焦点不等于原生键盘送达，压力脚本有save/undo超时；一次X11全13组通过原件保留，后续不稳定亦保留。另删除“拖动期间整个layout revision不变”的实现断言，改验证真实产品不变量：持久ratio不变、DOM与native尺寸随拖动变化、Escape回退、release提交；阅读位置等元数据提交不再被误报为ratio持久化。

首次Pi设置仅提供独立配置，旧系统OMP配置/凭据导入入口退役并由main IPC明确拒绝，不把YAML导入空Pi设置伪称成功；旧setup记录与历史保留。`config.initialize {mode:'independent'}`真实源码与随包GUI均已验。


## 不扩大验收

真实OAuth账号／付费模型质量／物理多屏／Windows／macOS未测；TeX真实编译、Office逐格式编辑全矩阵本轮尚未签收。原生键盘压力回归的不稳定与晚期配额故障如实保留。源码整合不等于可发布验收；第三方全闭包许可/二进制对应源码签收仍待完成。旧OMP通告、只读历史解析与孤儿进程清收保留，不作为可执行内核回退；全量确定性套件中的旧适配器单测不计入Pi能力证明。


## 用户授权接入 OMP 模型源与真实任务（2026-10-30）

本轮用户明确要求“集成omp的模型源，然后进行真实任务测试”。仅迁移模型服务数据与必要静态API凭据至本仓库忽略的 `.runtime/pi-development/pi/models.json`，目录0700、文件0600；`nozeli-role-defaults.json`将三角色设为OMP已有默认 `paratera/gpt-6.1-sol`。独立开发profile已按现有API完成independent初始化。系统OMP与日常Nozeli原models/config逐项比对未变；没有导入旧会话、extensions、hooks、可执行凭据命令、OAuth或OMP runtime。已有目标源不覆盖，密钥不写源码、不输出到报告；没有安装或发布。

| 源 | 真实目录查询 | 原生Pi目录可见 | 实际任务结果 |
| --- | --- | --- | --- |
| paratera | 5模型 | 5模型，默认模型已认证可见 | `gpt-6.1-sol`完成真实前台文档修改、orchestrator分派、Worker代码/测试/冻结HTML报告，全部完成；独立验证通过 |
| paratera2 | 25模型 | 25模型 | `grok-4.7`实际调用返回上游502：`Upstream service temporarily unavailable`；保留失败，不记为可用或自动重试 |
| bingxing | 80模型 | 80模型 | `AWS-GPT-5.6-Sol`用原生read读取四个整数、write写answer.json，独立验证sum40/count4及原始文件不变；退出已确认 |
| easyfun | HTTP401 | 配置已保留，未获得模型目录 | 凭据认证未通过；没有伪造目录或声称任务可用，需有效凭据后再验 |

模型目录只证明服务返回这些ID，不保证目录中的图片/视频/多Agent模型都兼容编码任务。没有从名称推定reasoning/vision等能力；缺失上下文/价格元数据沿SDK默认，费用显示0不代表真实免费，账单/单价未知。

### 主源真实任务

- 前台显式使用 `nozeli_document_read`／`nozeli_document_apply`，把合成README唯一状态句替换，独立比较其余全部文字及换行完全不变。
- 后台读取真实 `orders.csv`，生成 `summarize.mjs` 和 `summarize.test.mjs`；要求金额为十进制安全整数分、负数/零、按客户升序聚合、格式/金额/溢出拒绝；CLI输出JSON，禁止第三方依赖。
- orchestrator真实派出一个Worker；Worker真实写文件、运行测试，最终调用 `nozeli_publish` 冻结静态HTML。三个job均completed，前台为provider-completed、路由和Worker为host-control；不是fixture模型回显或mock工具。
- 宿主另行执行生成的 `node --test summarize.test.mjs`：17/17通过；独立执行CLI得到totalCents1625，Alice1000/Bob625/Cara0；另行未给模型的边界探针验证负数聚合、错误表头、小数金额、单值与累计安全整数溢出、空客户拒绝，exit0。
- 候选保持review，未自动写入原项目；原README与orders保持预期。全部原生owner正常退出，localOnly冷重开保留同Work、thread与报告，job身份无新增、零模型重放；核查对应PID没有活动进程。
- 真实运行原件 `/var/tmp/nozeli-real-omp-source-task-MouHpp/result.json`，112秒（startedAt11:48:50.178Z→finishedAt11:50:42.566Z）；Work `1ca76f21-f9a4-4c96-b113-4b524eb56100`；候选目录为该原件中candidateDirectory，报告 `frozen-report.html`。报告及脱敏结果已固定至 `.test-output/pi-integration-evidence/{real-model-task.json,real-model-report.html,real-source-provider-tasks.json,real-source-import-redacted.json}`。

第一次真实场景把合成项目建在源码仓库 `.test-output` 内，被 `REPO_BOUNDARY` 在Worker prompt之前正确拒绝；前台已完成修改，Worker没有准入请求。失败原件 `.test-output/real-omp-source-task-6MWBJS/result.json`保留。随后使用全新的 `/var/tmp` 独立合成项目完成上述验证，不修改既有Work去自动重放，更未在用户业务项目运行。

本轮更新了此前“仅本地确定性Provider”的验收范围：以上两源为真实远程模型实际文件任务，grok上游失败和easyfun认证失败分别明确；真实账号OAuth登录、广义模型质量、Windows/macOS验收边界仍不变。退出与原文保护已观察，不自动启动新的GUI窗口，避免留下测试窗口。

## 输出语义配色（2026-10-30）

- 参考本机 ZCode 3.15.3 的打包源码 `resources/app.asar:out/renderer/assets/styles-Cg6LSa5A.css`：`--color-diff-added` 对应 green、`--color-diff-removed` 对应 red、`--color-git-modified` 对应 amber。仅参考语义划分，未复制其渲染组件或引入运行依赖。
- Nozeli 保留正文中性色，行内代码／工具名紫色，已识别文件链接／冻结文件路径蓝色；工具状态、角色身份、文件状态和增删统计独立配色。代码关键字继续复用 Shiki；新增 diff/patch 逐行语义配色及明暗／系统强制颜色支持，保留原始文字、正负号、源位置映射和复制内容。不对自然语言随机匹配关键词。
- `npm run build:renderer` 通过。真实 Electron 生产渲染组件、显式标为合成样例的配色 smoke 已验证明暗主题的语法／元数据／增删行区分、390px 无页面横向溢出、冻结文件导航、diff 复制文字不变、补丁内 script 保持惰性，以及 CDP forced-colors 下系统色和正负号保留。原真实模型测试窗口刷新后，已观察实际两个冻结文件路径为蓝色、A/+统计绿色、−统计红色；本轮没有新模型请求。
- 证据：`/var/tmp/nozeli-output-colors-{light,dark,narrow}.png`、`/var/tmp/nozeli-real-output-file-colors.png`。配色预览不是模型能力或完整后台验收；Windows/macOS 未验。
- `desktop-session-timeline.test.mjs` 增加 diff 原文／HTML 惰性及双主题区分回归；本轮整文件运行在既有第87行过程折叠点击处报 `Node is either not clickable or not an Element`，未执行到新增断言，不计通过。以上新增行为已在独立真实 Electron smoke 中逐项执行；不将本轮配色修改说成已修复折叠或报告空白。
- 另行运行 `node --test tests/tag-markdown.test.mjs tests/session-store.test.mjs`：13/13 通过。真实 Electron 工具状态样例确认 complete 绿色、failed 红色、running 琥珀色；临时配色 smoke 窗口已关闭，保留原真实任务测试窗口及截图。

## 严格功能对齐执行（2026-10-30，用户授权）

旧开发记录迁移明确排除；不删除旧资料。新 Pi 文件、草稿、Work、冻结报告仍要求保存、故障恢复、版本校验和不重复执行。本轮不安装、不提交、不发布，不改原版或用户项目。

### 冻结基线

- 冻结目录：`/var/tmp/nozeli-strict-parity-baseline-EOerDx`；每版包含产品源码、测试、工具、依赖锁、文档副本、工作树 binary diff、逐文件 SHA-256；不包含用户资料、凭据、node_modules 或运行 profile。
- 原版 HEAD `ac04c8502177129d584e6d076a28a0947d010f49`，952 个文件，manifest `23cdf381f3a3c72958238dabd04eb3a33d98e543f48e6735c1d457adc9fc6a20`。
- Pi HEAD `e2fad8899719abac919c71816cf7ac0d68d1276e`，1021 个文件，manifest `8511f1f6244ed5d40731cbb8cc74e178f64a0702bb95a1929b8ccf4eab1299be`。
- 冻结后的原版变化单列，不自动追入本轮；最终 Pi 候选另行冻结摘要，不拼接不同候选的通过结果。

### 能力映射与验收矩阵

| 能力 | 原版入口／事实 | Pi 对齐与可观察通过标准 | 本轮状态 |
| --- | --- | --- | --- |
| 宿主接管与工具取消 | 原生批次中宿主操作结束回合 | 混合原生／宿主批次接管后无新增模型请求、无后续工具效果；前中后取消逐工具计数，不重放未知效果 | 已实现；真实 Pi 原生工具、生命周期和最终确定性结果单列在下方，不用模型文案冒充副作用核对 |
| 原生结构化提问 | ask 与受管 askDialog | 真实工具产生结构化交互；提交、聊天、取消、后台作答、重复／过期响应绑定原调用 | 已接入原生 Pi 工具和宿主交互；最终 questions 回归单列 |
| 文件／选区／漂移讨论 | kind:file、小窗、可选重定位 | 冻结原材料，漂移不阻断讨论；修改仍 CAS／未保存保护；小窗不消费主草稿 | 已实现；沿独立材料与宿主 CAS 合同，不迁移旧开发记录 |
| 网页工作面与讨论 | 地球入口、原生网页、页面讨论 | 导航／浮动／回嵌／表单保护；每页讨论、显式快照、任务及草稿隔离 | 最终候选 X11／Wayland 原生网页导航和地址草稿通过；真实失败投影、快照脱敏与不自动重发通过；其余交互按末节证据限定，不混用旧候选结果 |
| Office 与剪贴板 | 干净基线检查、真实系统复制粘贴 | 未保存／冲突拒绝原文件剪贴板导出，干净 Office 可复制；真实系统文件管理器互通 | 最终候选三类干净 Office 文件复制、独立 GTK 读取的 14 条文本复制路径通过；PPT 旧源草稿恢复及新副本导出通过；原生文件对话框／文件管理器互通另列，不由 API 回显代签 |
| GUI 等价能力 | 终端干预和只读诊断 | 模型／思考、暂停／恢复、明确下一回合补充、手动压缩／reload、原始工具记录与只读诊断；不伪造 PTY | 最终候选真实设置、模型菜单与过期 owner 拒绝、精确当前任务中断、GUI reload／compact 通过；不恢复旧 OMP PTY 接管 |
| 任务交付与审核 | 三角色、报告、候选、接受／丢弃 | 真 Controller 队列／额度／并发；发布→续改→人工候选编辑→接受／丢弃，冻结对象及源文件正确 | 最终候选真实远程三角色任务、独立边界校验、冻结报告和冷恢复零重放通过；GUI 续改／人工编辑／确切版本决定按末节原件逐项记录 |
| 模型与账号 | 三 API、源设置、角色默认 | 实际请求／工具往返／错误恢复；忙时切换下一回合生效；OAuth 登录按账号授权单列 | 三 API 的真实 SDK 解析／工具文件／错误恢复与冷续接已验；最终候选两个真实远程源任务通过；真实账号 OAuth 登录未验，不导入旧 OAuth 或凭据命令 |
| 输出与报告 | 消息／工具／完整工件 | 展开可操作、报告正文真实可见，长内容完整取回／复制，失败不被隐藏 | 最终候选真实报告文件点击进入可编辑审核文档、绑定标题菜单、完整长记录与系统文本复制通过；后台失败保留原 job 与实际错误 |
| 格式与窗口 | 支持格式编辑、TeX、分屏及原生窗口 | 实际编辑保存重开与编译；脱离返回不丢焦点、选区、撤销、IME 和未保存缓冲 | 最终候选真实 Tectonic 编译／PDF 预览通过；实际 Electron CDP 编辑／撤销／重做及原生窗口往返 50 项通过；这不是原生键盘、系统 IME、物理多屏或像素精确滚动验收 |
| 新 Pi 持久化与退出 | 正常／强退／异常恢复 | 草稿／材料／新 Work／报告可恢复；进程额度在核验退出后释放，未知输入不自动重放 | 最终候选主草稿冷恢复、真实模型新 Work／报告冷恢复零重放和确认 owner 退出通过；故障与后代清理保留真实 Pi 生命周期回归 |
| 独立候选 | 解压包、自带 runtime | 无系统 OMP／原开发树仍可运行；同一候选全量回归、真实 Pi 与 Electron；Linux X11／Wayland分别记录 | 已冻结 Linux x64 独立候选和 SHA-256 压缩包，未安装／发布；同候选和解压重定位验收原件见下。未覆盖的外部门不能记作全功能签收 |

每条验收保留初始状态、动作、期望结果、禁止发生的事、原始证据、平台和候选摘要。当前矩阵是执行门，不代表已经通过。Linux 候选通过后才可申请安装；Windows/macOS 独立验收。


### 已退役候选及其历史实测边界（2026-10-31）

**此候选已因 PPT 冲突后的原文件剪贴板准入 P1 退役，不交付。** 运行输入 731 项（产品源码、生产 renderer、Pi 运行时源码及依赖锁）摘要：`becb644e1eebf90a9f8da67cdf349af72d5a798f13fe52cb46249dda61e00d2c`。清单 `/var/tmp/nozeli-strict-candidate-Phn8zN/source-manifest.json`；实际 ELF `/var/tmp/nozeli-strict-candidate-Phn8zN/installation/releases/strict-parity-linux-x64/nozeli`。下表仅记录此退役候选当时已通过的限定场景，不替代修复后候选的验收。

独立压缩包 `/var/tmp/nozeli-strict-candidate-Phn8zN/nozeli-pi-strict-linux-x64.tar.gz`，SHA-256 `7c1135e3ea8e933f76c18bdf03664a097394e7d5a05c44a8efa2dabbc3d7a3d7`；同目录 `SHA256SUMS`。仅私有候选，未激活安装、未发布、未提交或推送，不改日常版及用户项目。输入清单不是完整跨平台或第三方发布许可签收。

本轮修正：

- `host.documentStatus` 将 review 来源交还唯一审核权威，不再误查同路径项目文件；审核文档中的人工保存不伪报外部变化。
- PPTX 独立草稿按路径和来源摘要建索引，外部源变化后恢复自己的旧模型及校验过的原始字节；提供明确的当前磁盘版／保留来源版本选择，不把旧模型静默套在新源。
- PPTist 上游富文本有 300ms debounce；原先立即导出会漏最后一次输入。构建补丁为实时编辑器注册同步提交屏障，快照、保存、blur、导出先提交；组合输入未结束则阻止交接，卸载注销并取消 debounce。宿主同步订阅模型变化，保存检查不再落在 dirty 标记之前。
- 默认构建仍抓取固定 Git revision 并核对未压缩归档 SHA-256。一次网络 TLS fetch 失败保留；本轮最终构建以临时开发驱动读取同一未修改上游归档，仍执行固定 SHA 校验和原构建全部后续补丁／构建步骤，没有加入产品 fallback 或复用旧的编辑器产物。

| 最终候选场景 | 已观察结果 | 原件 |
| --- | --- | --- |
| review 来源与 PPT 草稿边界 | 32/32；同路径项目文件不被误查、外部 PPT 源字节保护、旧稿版本选择、并发保存及无关 digest 不隐式恢复 | `artifact://10489` |
| 真实远程三角色任务 | paratera 前台精确修改；paratera 主控分派 bingxing Worker；实际文件／测试／冻结报告；独立边界探针通过；冷重开原 Work、thread、report 零重放；临时静态凭据副本已移除 | `/var/tmp/nozeli-strict-real-model-XOe4mF/result.json` |
| 设置与会话 | 实际模型菜单、过期 owner 拒绝、原生 Pi 回复、确认退出、未发送主草稿冷恢复通过 | `/var/tmp/nozeli-pi-electron-QDSpw6/report.json` |
| 会话 GUI 管理 | 真实文档修改、原 owner GUI reload／compact、精确当前 job 中断通过 | `/var/tmp/parity-workflow-ujj5r8/report.json` |
| 报告入口与标题菜单 | 真实报告文件点击进入原审核文档并编辑；绑定报告标题菜单可丢弃，原文保护 | `/var/tmp/parity-workflow-ZliK7J/report.json` |
| 网页失败场景 | 实际受理 ID、原始错误投影、冻结正文不随页面改变、表单／密码／editable 脱敏、原输入仅恢复一次、新输入不被覆盖、轮询不自动重发 | `/var/tmp/nozeli-webfailure-AQuj2F/result.json` |
| 原生内容和干净 Office 文件复制 | X11 与 Wayland 分别真实网页导航、地址草稿不自动导航、TXT／DOCX／XLSX／PPTX 可见内容、三类干净 Office 文件复制和正常 exit 0 | `/var/tmp/nozeli-surface-portable-WLFRTv/result.json`；`/var/tmp/nozeli-surface-portable-d2SfFn/result.json` |
| 系统文本剪贴板 | 14 条路径逐项与独立 GTK 进程读取的实际 OS 文本一致，包括编辑器／Office／PDF／对话／代码复制按钮；不由 clipboard IPC 回显代签 | `/var/tmp/nozeli-strict-clipboard-evidence/system-text-clipboard-gE6gqx/result.json` |
| PPT 外部变化与冷恢复 | 外部原件字节保持；旧模型重开恢复，显式查看当前源和恢复旧来源版本均通过 | `/var/tmp/nozeli-office-edges-b0lGIf/ppt-strict-recovery.json` |
| PPT 最后一次输入立即导出 | 不 blur、不 sleep、不等待模型；实际 PPTist 生成 OOXML 包含新文字，源文件不变，exit 0 | `/var/tmp/nozeli-ppt-pending-37WRcR/result.json` |
| TeX 实际编译预览 | GUI 触发真实 Tectonic；新 PDF 摘要、实际正文与非零 canvas；明确“取消任务并退出”后 exit 0 | `/var/tmp/nozeli-strict-tex-gui-7cqgP1/result.json` |
| 编辑与原生窗口往返 | 实际 Electron CDP 输入、撤销／重做、多次脱离／返回、相同 DOM／选区／全文与精确落盘字节，共 50 项；不是原生键盘／系统 IME 证据 | `/var/tmp/parity-native-input-NcCcco/report.json` |

TeX 首次关闭等待失败原件 `/var/tmp/nozeli-strict-tex-gui-O2hjrH/result.json` 保留：编译已成功，但测试未回答实际可见的忙任务退出确认。观察诊断 `/var/tmp/nozeli-strict-tex-gui-XmG1nA/result.json` 记录该对话框；修正仅为测试点击真实“取消任务并退出”，未改产品或放宽保存／退出超时。

审核旧版本拒绝原件 `/var/tmp/parity-workflow-KMWe65/report.json` 保留：人工文档保存后，仍显示旧令牌的报告决定被 `REVIEW_TOKEN_CHANGED` 拒绝并刷新状态，原项目未合入；这不是可绕过的失败，必须核对新版本再明确确认。

窗口滚动边界：Markdown 返回后 viewport 高度 725→815，原 scrollTop 2922.67 已超出新最大值 2846，实际被限制为 2845.33；不称像素精确滚动通过。Monaco 的虚拟 DOM scrollTop=0 不能证明实际代码 viewport 保持。选区、内容、撤销与精确文件字节通过不代替这些声明。

两个独立限定复审（`PptRecoveryReview`、`PptCommitReview`）未发现所审草稿来源／提交屏障的剩余 P0/P1；不是全产品签收。系统中文 IME、原生硬件键盘、物理多屏、真实 OAuth 账号登录、Windows/macOS 未验；不能用 CDP、已安装 fcitx 引擎或 Linux 通过代替。原生 SaveDialog／文件管理器互通不得由受控路径回调或 API 结果代签。以上候选不构成安装授权。

### PPT 原文件剪贴板冲突准入补修（2026-10-31）

最终 Office 负向场景抓到 P1：PPT 编辑后原件被外部改变，保存将模型保留为独立旧源草稿并正确显示冲突，但 `__nozeliUpdateState` 只汇报 dirty／部分 held 状态；PPT 保存后 dirty 已清，既存 conflict／sourceChanged 被漏掉，因而原文件剪贴板复制错误放行。原件没有被覆盖、旧稿能恢复，仍不能把此准入错误记作通过。证据 `/var/tmp/nozeli-office-edges-cfumaR/clipboard-proof.json`，退役标记 `/var/tmp/nozeli-strict-candidate-Phn8zN/ACCEPTANCE.json`。

修复沿原准入通路，把未解决 `ui.conflict` 和 `ui.file.sourceChanged` 纳入 live blocked 状态，不清除冲突、不自动保存、不改原件、不放宽退出。永久实际 Electron 回归 `tests/desktop-ppt-pending-text-live.mjs` 增加外部原件变化→保存冲突→原文件 clipboard 拒绝→精确原件保护→冷恢复原模型；同时保留不等待 debounce 的真实 OOXML 导出检查。修复后源码实测 `/var/tmp/nozeli-ppt-pending-SrLx20/result.json` 全部通过、exit 0。

修复后重新冻结 731 项运行输入：`8ed4e1b8406ebeb855361389fb5c1c7eaa89934df8322fea430ecfcaab80bcf6`；清单 `/var/tmp/nozeli-strict-candidate-nSLmOx/source-manifest.json`，实际 ELF `/var/tmp/nozeli-strict-candidate-nSLmOx/installation/releases/strict-parity-linux-x64/nozeli`。未安装／发布。退役候选曾完成 470/470 unit、1424/1424 integration、32/32 Pi 专项及 2 组 smoke（`artifact://10491`），这些结果仅保留为修复前历史，不充作新候选结果。

### 修复后候选实测与交付物

独立压缩包 `/var/tmp/nozeli-strict-candidate-nSLmOx/nozeli-pi-strict-linux-x64.tar.gz`；SHA-256 `7fce44e7c95710d92be96c27aea0db4fc320213b176be8a18bd83a9984b4808d`，同目录 `SHA256SUMS`。解压到全新路径、清空 `NODE_PATH`、限制 `PATH=/usr/bin:/bin` 后，实际 ELF 启动、原生网页／Office 内容和正常退出均通过，原件 `/var/tmp/nozeli-surface-portable-ZiWS11/result.json` 与候选目录 `unpacked-proof.json`。测试驱动使用源码测试库／合成样本，不代表产品运行依赖开发树；真实模型 owner 已显式使用随包 Node／Pi runtime。

| 修复后同候选验收 | 观察结果 | 原件 |
| --- | --- | --- |
| Office 负向编辑／冲突 | XLSX dirty、XLSX conflict、PPT dirty、PPT conflict 四项原文件剪贴板均拒绝 `SOURCE_UNSAVED`；两类外部原件精确保护；XLSX 恢复 ZIP 含编辑、PPT 旧稿重载恢复 | `/var/tmp/nozeli-office-edges-gszIRM/clipboard-proof.json` |
| PPT 提交与旧源恢复 | 立即实际 OOXML 导出保留最后输入；外部源冲突后原文件剪贴板拒绝、原件不变、旧稿冷恢复，exit 0 | `/var/tmp/nozeli-ppt-pending-od75TE/result.json` |
| 真实远程模型 | paratera 前台／主控与 bingxing Worker 真实任务、独立边界、冻结报告、原 Work/thread 冷恢复零重放；临时凭据副本删除 | `/var/tmp/nozeli-strict-real-model-CmJLG3/result.json` |
| 三 API 随包运行时 | 使用随包 Node／Pi SDK，分别 openai-completions、openai-responses、anthropic-messages 的真实协议解析、工具文件、usage、已知错误后明确新输入恢复、同线程冷续接零重放 | `/var/tmp/nozeli-strict-protocols-LFZHqp/result.json` |
| 队列与额度 | 排队无 owner、排队取消不唤醒、两个真实并发 owner、补充只入下一轮、精确停止当前回合、同 Worker 续改、主草稿及原件保护 | `/var/tmp/nozeli-strict-queue-uhuGAp/result.json`（对应冻结源码与真实 Pi；不是 GUI mock） |
| 完整审核工作流 | 真实前台修改、mouse／Enter／Space 展开、三角色发布、同 Work/thread/directory 第 2 版续改、人工文档编辑后刷新并确认确切审核版本、精确合入原件、第二独立 Work 经真实标题菜单丢弃且原文不变，exit 0 | `/var/tmp/parity-workflow-75gZ4Z/report.json` |
| Pi GUI 设置与冷恢复 | 原生模型菜单、过期 owner 拒绝、实际 Pi 回复、未发送主草稿冷恢复零重放、确认 owner 退出 | `/var/tmp/nozeli-pi-electron-IgmGJH/report.json` |
| TeX 编译与真实预览 | 实际 GUI Tectonic 编译、新 PDF 摘要、实际正文及 canvas、明确取消任务后正常退出 | `/var/tmp/nozeli-strict-tex-gui-Whxf9I/result.json` |
| 网页失败投影 | 真实受理、原始 job 错误、冻结正文／脱敏、不自动重发、不覆盖新输入，全部限定检查通过 | `/var/tmp/nozeli-webfailure-icnr5X/result.json` |
| Linux 后端 | X11／Wayland 分别实际网页导航、地址草稿、原生 TXT／DOCX／XLSX／PPTX 内容、干净 Office 文件复制、exit 0 | `/var/tmp/nozeli-surface-portable-dAXsMr/result.json`；`/var/tmp/nozeli-surface-portable-g59b8f/result.json` |
| 系统文本剪贴板 | 14 条真实应用复制路径与独立 GTK 读取的系统文本一致 | `/var/tmp/nozeli-strict-clipboard-evidence/system-text-clipboard-N5tymH/result.json` |
| 编辑与窗口往返 | 50 项真实 Electron CDP 编辑／撤销／重做、同 DOM／选区／完整文本／精确文件字节；不声称系统 IME 或像素精确 scroll | `/var/tmp/parity-native-input-sgbLwW/report.json` |
| 网页承载与表单 | 实际 float/dock 后 guest target、document UUID、input／textarea 编辑值完全相同；真实 beforeunload 提示显示 | `/var/tmp/nozeli-finalwebui-gK3pNq/result.json` |

保留未通过或受限的原件：`/var/tmp/parity-workflow-V66a66/report.json` 的独立标题菜单脚本等待的是仍处于编辑器页签背后的报告标题；完整工作流另已实际操作当前报告菜单并丢弃。`/var/tmp/parity-workflow-d2YF1n/report.json` 的中断脚本使用 12 秒自动结束的合成响应，最终 job 已 completed，不以禁用按钮超时伪报“已中断”。这些失败不计通过，也不重写原始报告。

**完整原生交互签收仍未放行。** 两个独立 UI 验证都确认 `org.a11y.Bus` 广播 `/run/user/1000/at-spi/bus_0`，但该 socket 不存在；PID 限定的真实 AT-SPI helper 连接失败／SIGABRT。未修改全局辅助功能服务、输入设置或个人应用。原生 beforeunload 留页／离开结果、网页原生菜单进入讨论后的主草稿隔离、GTK SaveDialog 的真实保存确认及实际文件管理器粘贴仍未完成，分别见 `/var/tmp/nozeli-finalwebui-LNbc8h/result.json` 和 `/var/tmp/nozeli-office-edges-q5Qbul/result.json`。主草稿在自有已初始化合成 profile 重载完整保留且未发模型请求，不代替网页讨论隔离。系统 IME、物理多屏、OAuth 和 Windows/macOS 边界同样保留；机器可读门清单 `/var/tmp/nozeli-strict-candidate-nSLmOx/manual-gates.json`。未安装、未发布，不把工程候选当作完整签收。

中断时序诊断 `/var/tmp/parity-workflow-CuEEXi/report.json` 进一步定位：脚本在宿主 job 已标 running、Pi 尚处于 idle／prompt 准入准备时打开一次性诊断，故当时 `capabilities.interrupt=false`；稍后的真实原生请求已收到，权威 `session.options` 返回 `phase=prompt-inflight`、相同 jobId 和 `interrupt=true`，精确 job 停止得到 accepted。只读诊断不是自动刷新的实时终端；验收应等待实际请求准入再打开，不能把旧诊断快照当成当前能力。此诊断未改产品。

按真实请求准入而非 scheduler 的早期 running 状态校准的同候选 GUI 实测 `/var/tmp/parity-workflow-dEs1Bn/report.json`：前台真实文档修改、原 owner reload、足量历史 compact、原生请求实际挂起后打开对话框并显示确切 ownerId/jobId、点击真实“停止当前回合”得到同 job cancelled，全部通过；没有用清理 API 代替此 GUI 决定，也没有产品改动。所用脚本 `/var/tmp/parity-runtime-eligible.mjs`，原始早期快照失败／诊断仍保留。

### 修复后完整回归最终回执

对 `8ed4e1…` 相同冻结输入执行 `TMPDIR=/var/tmp NOZELI_TEST_CONCURRENCY=2 npm test`，随后运行 Pi 专项四文件及 `node tools/test-suites.mjs smoke`，整条命令 exit 0；1258.73s 为 integration 自身时长，1336.45s 为整条命令时长。原始合并输出 `artifact://10560`，不借用退役候选结果。

| 门 | 通过／总数 | 失败／跳过 | 固定原件 |
| --- | --- | --- | --- |
| unit | 470/470，55 文件 | 0/0 | 候选 `evidence/unit.tap` |
| integration | 1424/1424，139 文件 | 0/0 | 候选 `evidence/integration.tap` |
| Pi 原生／工具／结构化问答／生命周期专项 | 32/32 | 0/0 | 候选 `evidence/pi-live.tap` |
| 真应用 smoke | 2/2 脚本 | 0/0 | 候选 `evidence/smoke.log` |

末次 731 项源码／生产资产／运行依赖清单逐字节与冻结输入一致，`mismatches:[]`，见候选 `final-input-proof.json`。实际私有候选路径进程收尾核对为 0，见 `process-cleanup.json`。两个临时构建／关闭观察驱动已删除，真实回归与原始失败报告保留。`ACCEPTANCE.json` 汇总同候选每条可复查证据，`manual-gates.json` 保留准确缺失前提；**自动化和已执行场景通过不等于完整原生交互签收，也不授权安装**。独立包已产出并解压实测，交付为未安装工程候选，不用残缺的桌面输入／无障碍环境伪称全功能通过。

## 再同步 nozeli_git 工作树（2026-10-31，用户授权）

用户要求继续检查并把 `nozeli_git` 当前更新合入 `nozeli_pi`。上一轮自动回归已完成，但原生对话框／IME／物理多屏等未全部签收；本轮新增合并后重新验证，不把旧候选通过结果拼入新候选。

- 来源 HEAD `ac04c8502177129d584e6d076a28a0947d010f49`，包含当轮 24 个 tracked 工作树修改和 15 个未忽略新文件，不只合提交。
- 合并前只读快照 `/var/tmp/nozeli-source-refresh-9bdudwe1`：source 925 个范围内文件，摘要 `ecd795bb46c5238fa47b75bd98c0c3d9e5a07183d35b7c2610bf82d0d626303b`；target-before 1005 个文件，摘要 `b996e17dc46a4c9b3547b845cd20e3760dda3dd7bb847a27578bf4da20dbaeb2`。范围包括产品源码、测试、工具、依赖锁和文档，不含用户数据、账号、忽略的 `.runtime`、node_modules 或测试 profile。
- 源提交／工作树影响 67 个路径，其中 35 个在 Pi 中已逐字节一致；其余 32 个逐项语义核对，不把 Pi 运行时差异当成漏合。保持双方已有未提交工作，不执行 reset/restore，不提交、不安装、不发布。来源原件没有被编辑。

| 处理面 | 合入／保留决策 |
| --- | --- |
| 更新设置 | 合入复选框的 `auto-update-toggle` 与横向、顶部对齐、不收缩布局 |
| 网页材料显示 | 合入网页材料标题、URL、冻结引用和版本显示；保留 Pi 文件路径语义颜色 |
| 原生窗口与主进程 | 源端更新器、几何／CSS-to-DIP、系统剪贴板保护已具备；保留 Pi Node／SDK、初始化与来源身份，不恢复 OMP／PTY |
| PPT／审核 | 保留分来源草稿恢复、同步文字提交、冲突 clipboard 阻断及原审核文档直接编辑；不回退到源端简化草稿读写或冻结差异入口 |
| 来源提交 | 导入主草稿保留、同 key 去重、新要求独立受理、网页原始材料展示及身份碰撞拒绝的行为回归 |
| 更新器实测 | 合入新进程即时 `DevToolsActivePort`，用不同 browser endpoint 证明实际重启，不误连旧端点 |
| 系统文件复制实测 | 合入打开 DOCX/XLSX/PPTX、跨项目返回再复制到真实隔离 Dolphin、逐字节和原件保护 |
| 来源／许可证／文档 | 保留 Pi provenance 与精确锁，合入 tar 7.5.22／BlueOak 记录及更新、网页、测试边界说明；不重新加入 xterm/addon-fit、OMP 初始化、TUI 接管或旧 OMP live 产品命令 |

源端 `web-discussion.test.mjs` 的 capture 源码字符串断言没有导入：它锁实现文字，不证明隐私行为；现有实际冻结正文／表单脱敏及失败不重发场景继续保留。Pi 所有额外控制／PPT／问答／生命周期回归未被源清单覆盖删除。

实测暴露的测试边界另行修正：更新帮助进程的 terminal health journal 先于 finally 释放安装锁，真实包 smoke 应有界等待清理结果，而非把该瞬时竞争当成产品故障；未延长产品超时。私有 `dbus-run-session` 的 Dolphin 接收端改用短路径、0700 的独立 `XDG_RUNTIME_DIR` 和独立 XDG 数据／状态／缓存目录，避免私有辅助功能服务共用桌面 `/run/user/1000` 的 socket；收尾只清理自有目录。真实测试失败原件仍保留，不伪报通过。

### 同步后的并发审校补修

完整 UI 复核在 `/var/tmp/parity-workflow-LI6D1C/report.json` 捕获真实 `REVIEW_DRAFT_RECOVERY`：`reviewRead` 先读取旧正文记录，但保留了可原地更新的 active draft 元数据引用；并发 `reviewSave` 推进 revision 后，读取可能用新 revision 查旧 record，或返回不一致的审核令牌。不得把它当作输入丢失、吞错回退候选正文或仅延长超时。

永久回归 `managed-review-candidate.test.mjs` 增加并发读取／CAS 保存，逐项核对正文、摘要、draft revision 与 whole-review token 的对应关系；修复前真实失败 `REVIEW_DRAFT_RECOVERY`（`bg_841`），修复后与 merge-consent、review source／文档屏障、activation 边界共 83 项通过（`artifact://10688`）。`reviewRead` 通过既有 `workLocked` 进入私有完整读取函数，和保存／继续／接受共享 Work 串行边界；public API 与调用方不变。检查了直接调用者和接受前同步回调路径，未引入嵌套调用该读取锁。保留真正缺正文及过期版本拒绝，不模拟成功。

前一同步候选 `fe053ca5…` 已在其 `ACCEPTANCE.json` 撤回；修复后重新冻结 731 项运行输入 `a97813d5b53a171748af2801c44ef7ee6666faa0305576d9813ddfdc0bf87d9f`，ELF `/var/tmp/nozeli-strict-candidate-ZCiQ7T/installation/releases/strict-parity-linux-x64/nozeli`。不把此前候选的通过结果作为本次最终验收。

首次完整集记录仍保留：定向 149/149、unit 470/470，integration 1424/1425，其中 activation 固定 5 秒 polling 到时（`artifact://10632`，TAP 已固化到同步快照 `regression-before-wait-fix/`）。观察诊断在非同等并发压力下完成约 2 秒，不能据此抹掉原失败或断言产品耗时上界。该 activation 用例改为订阅实际 Controller state、等到原 review／全部 running 完成，维持原持久化 binding／initial job 断言，失败 job 立即报错，并沿现有慢 I/O 场景给测试本身 30 秒上界；未改产品超时。开始修改真实读取逻辑前取消了仍在运行的旧输入完整集（`bg_840`），不混合修复前后结果。

修复后的完整套件回执：同冻结输入 unit 470/470（55 文件），integration 1426/1426（139 文件），Pi 专项 32/32，应用 smoke 2/2，所有失败／跳过均为 0，原始 TAP/log 为 `/home/bfly/yunwei/nozeli_pi/apps/desktop/.test-output/ci/{unit.tap,integration.tap,smoke.log}` 及 `artifact://10683`。其中 activation 证据测试不再用不稳定固定 5 秒轮询；改订阅 Controller 状态并等待原 review／执行终结，保留失败即报错和原持久化绑定断言。前一次失败原件已保存在 source snapshot `regression-before-wait-fix/`，未覆盖或冒充通过。

最终修复候选 ID `a97813d5b53a171748af2801c44ef7ee6666faa0305576d9813ddfdc0bf87d9f`，ELF `/var/tmp/nozeli-strict-candidate-ZCiQ7T/installation/releases/strict-parity-linux-x64/nozeli`。独立归档 `/var/tmp/nozeli-strict-candidate-ZCiQ7T/Nozeli-Pi-source-refresh-linux-x64.tar.gz`，SHA-256 `d819a35a52d1b6d1bda8ae9697f9f6cbd87e9e9c5710603acf9e10d0622f2533`，同目录 `SHA256SUMS`。归档解压到新路径后 X11／Wayland 实际启动、原生网页导航／地址草稿／TXT、DOCX、XLSX、PPTX 内容均 exit 0；原件 `/var/tmp/nozeli-surface-portable-5fztva/result.json` 与 `/var/tmp/nozeli-surface-portable-eK3nRh/result.json`。

最终候选另验网页右键“讨论此网页”通过真实 owned AT-SPI 菜单项激活；网页草稿与主对话未发送草稿互不覆盖、无模型请求，`/var/tmp/nozeli-finalwebui-FUGRYj/result.json`。真实 Dolphin 系统文件管理器五项 Copy→Ctrl+V（中文特殊名文本、干净 DOCX／XLSX／PPTX、嵌套文件夹）逐字节通过；文件管理器使用短路径专属运行目录，桌面 AT-SPI socket inode `11690` 前后未变，`/var/tmp/nozeli-source-refresh-9bdudwe1/final-native-export/file-export-native-ipAXxO/result.json`。真实应用更新器回环下载／模态阻止／正常退出／安装回滚与 fresh DevTools 端点验证 `/home/bfly/yunwei/nozeli_pi/apps/desktop/.test-output/desktop-auto-update-xtRNH8/report.json`。新 PPT pending-text／原件冲突／草稿恢复回归及完整工作流均在最终候选重跑：`/var/tmp/nozeli-ppt-pending-SRIBpQ/result.json`、`/var/tmp/parity-workflow-UaX7DZ/report.json`。实际更新设置与网页材料标签／URL／引用／版本显示通过 `/var/tmp/nozeli-source-refresh-ui-GSYWKK/result.json`。

本轮经用户明确授权重启了既有用户级 AT-SPI service。Dolphin smoke 私用独立 D-Bus 运行目录，桌面 accessibility socket 没有再被移除。网页讨论、float/dock 和记忆草稿隔离现在有最终候选实测；**仍未能确认真实网页 beforeunload 对话框的“留在此页／离开”结果**：已显示真实原生 GTK 对话框，但窗口在 AT-SPI 无障碍树中没有按钮节点，PID 定向 Return 未关闭，定向动作失败不视为产品 Stay/Leave 失败。系统中文 IME／物理键盘、物理多屏、真实 OAuth 和 Windows/macOS 仍未验。

最终候选 Acceptance ledger `/var/tmp/nozeli-strict-candidate-ZCiQ7T/ACCEPTANCE.json`；准确未签收门 `/var/tmp/nozeli-strict-candidate-ZCiQ7T/manual-gates.json`。未安装、未发布、未提交；不把剩余原生对话框边界冒充完整验收。

## 账号／API／模型管理补全（2026-10-31，ModelManagementImplementer）

本节为新增实现记录；实现未运行测试／构建（按分工由 Main 统一验证）。

### 契约

- `settings.providers.save`：`{operation:create|update, provider, expectedRevision?, baseUrl, api, credential:{action:replace,value}|{action:keep,confirmNewOrigin?}, models:[{id,name?,reasoning?,contextWindow?}]}`。源ID不可改名；update 必须带修订号（`agentDir/nozeli-source-revisions.json`，0600），修订校验、密钥保留解析与修订递增同处串行临界区；`keep` 由可信 owner worker 在被替换记录上就地解析（bridge `providerUpsert` 读 store 记录复用密钥，密钥不过 IPC，omitted key 永不退化为 "unused" 占位）；origin 变化 + keep 需 `confirmNewOrigin`（host 与 bridge 双层拒绝）。返回 `{saved,revision,source,application}`：保存成功与会话刷新失败分离（failed 行可见，不回滚凭据、不鼓励重放）。
- `settings.providers.discover`：保存源 `{provider,expectedRevision}` 或草稿 `{baseUrl,api,credential:{action:replace,value}}`。真实列表请求：openai 兼容 `GET {baseUrl}/models`（Bearer）；anthropic `GET {baseUrl}/v1/models`（x-api-key + anthropic-version，`after` 游标翻页，同源）。有界：15s 超时、2MB、10 页、1000 模型；`redirect:'error'`（凭据绝不跨源跟随）；404/405→`unsupported(DISCOVERY_LISTING_UNSUPPORTED)`；401/403→`failed(DISCOVERY_UNAUTHORIZED)`；解析失败→`DISCOVERY_MALFORMED`。仅证明可列出，`entitlement:'unknown'`；绝不发对话/completion 探测。成功结果持久化于 `nozeli-source-discovery.json`（脱敏）；后续失败保留上次成功列表并标 `stale`；源编辑同样将其标过期。草稿密钥仅一次性写用。
- `settings.providers.status`：sources[]（含 `revision/credential{configured,kind}/models[{id,name?,reasoning,metadataSource:'configured'}]/discovery{status:none|succeeded|stale|unsupported|failed,...}`）；picker `models[]`（`credentialConfigured/catalogSource:native|configured/entitlement:'unknown'/thinking{supported,levels:null,source}`）。SDK `getAvailable` 是离线凭据状态（refreshOnCreate:false、allowNetwork:false），不再称"Pi 确认可用"；文案明确"凭据已配置或服务列出都不代表推理授权"。
- `settings.models.save`：`{role:{model:{mode:explicit|native-default,selector?},thinking:{mode,level?}}}` → `{saved,modelSync}`。`nozeli-role-defaults.json` schema 2（读取时从 schema 1 字符串迁移）。仅校验**发生变化**的选择；未变化且目录暂不可见的已存默认可原样保留保存。`modelSync:{applied,pending,failed[],sessions[{projectId,target,ownerId,sessionId,desired,effective,state,clamped?}]}`；渲染端统一读 `modelSync`（修复 save 路径 `result?.sync` 与后端字段名不一致）。当前不可用的已存默认以下拉 disabled 选项保留显示，不可重新选择（修复"不可用已存选项可被重新选中"缺陷）。
- 会话语义：`applyDefaultModel` 返回 `{state:applied|pending|unchanged, requested, effective, clamped, thinkingLevels}`；显式清除取消排队中的 pending 选择且不虚报 applied；`prompt()/sessionCommand()` finally 中的延后应用失败与已结算回合隔离（保留 modelError/modelSync 可见性，不再把成功回合变失败）；配置请求与 prompt 准入经 `configFlight` 串行；源保存/轮换后 `refreshProviderSource` 在安全空闲边界以同一选择器重解析（保留并发 pending 选择，只叠加 refresh），不新建会话、不重放。新会话播种角色思考默认（显式覆盖 > roles.json effort）；`managed.model.options` 去除硬编码六档列表，改回原生 `getAvailableThinkingLevels()`（旧 dist 无该接口时如实 `null`）；`managed.model.set` 返回 requested/effective/clamped。错误 DTO 白名单脱敏（不再透传原生错误文本）。
- 修复缺失的 `ProviderSettings.loginProviders()`（此前 `settings.login.providers` 必然 TypeError，登录源下拉永远失败）；bridge `authList` 增加显示名。

### 上游补丁与重建前置

`patches/0004-nozeli-model-management.patch`（在 0001–0003 之上）：custom-provider store 回传有界 `name/reasoning`（SDK ModelDefinitionSchema 原生支持，进入原生模型注册表，不是仅 UI 字段）；`SessionModelSelection.refresh` 强制会话侧 `modelRuntime.refresh({allowNetwork:false})` 后重解析（`requireSessionModel` 对已缓存选择器不刷新，见 vendor session-supervisor.ts:149–160）；supervisor/driver 暴露 `getSessionThinkingLevels()`。`upstream-manifest.json` 已更新 5 个文件哈希。**dist 未重建（按指令）**：Main 需先 `cd integrations/pi && npm run build`（重生成 dist bundle + runtime-manifest.json），旧 dist 下 `refreshProvider`/`thinkingLevels`/`reasoning` 元数据为 no-op/unknown（bridge 对缺失能力如实降级标注，不伪造）。

### 冒烟与回归命令（Main 执行）

```sh
cd integrations/pi && npm run build          # 前置：重建 Pi driver dist
cd ../apps/desktop
node --test tests/provider-settings.test.mjs
NOZELI_OZONE=x11 node tests/provider-settings-refresh-interaction.test.mjs
NOZELI_OZONE=x11 node tests/pi-model-management-live.mjs   # 新增：真实 Electron+Pi owner+回环 HTTP：多模型建源/留空轮换/修订冲突/origin 同意/真实 /models 发现/角色思考传播与 clamp 回报/轮换后同会话用新密钥（断言 Authorization）/零重放
NOZELI_OZONE=x11 node tests/desktop-pi-live.mjs            # 既有 live（载荷已迁新契约）
NOZELI_OZONE=x11 node tests/desktop-settings.test.mjs      # 真实设置 GUI（表单已迁 textarea/多模型）
```

边界：真实账号 OAuth 登录、付费模型质量、Windows/macOS 未验；发现仅证明列表可返回，entitlement 恒 unknown；anthropic baseUrl 语义与聊天客户端一致（根地址 + `/v1`，网关前缀保留，已含 `/v1` 的地址与聊天同样会重复拼接，属配置错误而非发现伪造）。

### 补修第二轮（评审跟进，2026-10-31）

- **P1 准入串行化**：`PiSession` 改为同步预约的共享准入队列（`beginAdmission`：调用时同步占位，prompt／sessionCommand／模型配置同界），取代此前"快照式 await"（两个等待者可同时恢复并发 `model` 请求）。回归：`tests/pi-session-admission.test.mjs`（同步占位次序、已结算回合不被延后配置失败污染、busy 排队、clear 取消排队、轮换保留并发 pending 选择）。
- **分页误报修复**：列表发现抽出可测的 `collectServiceModels`（bridge 导出）：以"是否耗尽"独立于游标判断——末页 `has_more:false` 属正常成功，仅页数上限仍有多页时报 `DISCOVERY_PAGINATION`。回归：`tests/pi-discovery-listing.test.mjs`（多页正常成功、页界报错、404/405 vs 401/403、畸形/网络/超尺寸、去重）。
- **读 DTO 泄漏**：「把服务返回的模型加入此源」显式构造写 DTO（`writeModel`：仅 id/name/reasoning===true），不再透传 `metadataSource`／`reasoning:null`。回归并入 `tests/provider-settings.test.mjs`（读 DTO 直接保存被拒、映射后通过、`reasoning:null` 被拒）。
- **P1 origin 同意绑定**：同意勾选绑定 `provider|旧origin|新origin`，切换源／改地址／每次提交后自动清零，fresh consent 每次编辑/目的地重新获得。
- **模型绑定思考档位端到端**：vendor `RuntimeModelRecord.thinkingLevels`（pi-ai `getSupportedThinkingLevels`，与 AgentSession 同一权威）→ bridge → host ModelDTO（缺失=未知，不再从 reasoning 布尔推导档位表）→ 渲染端思考选择只列所选模型的原生档位，未知时明确标注「档位未知」，`managed.model.options` 移除全局六档 `efforts`。manifest 已更新（runtime-supervisor.ts、session-driver/runtime-types.ts），patch 0004 附录已记录。
- 渲染端补挂修复：恢复丢失的 `list`/`loginArea` 容器与「账号与 API 源」标题（此前 bg902 ReferenceError）。

### 补修第三轮（评审生命周期跟进）

- `applyDefaultModel` 引入**期望代次**（`desiredGeneration`）：每次变更/清除在同步接受点自增；排队变更在获得准入后、发送原生请求前校验代次，被清除取代者返回 `{state:'cancelled',superseded:true}` 且不发送；已提交的原生变更仍如实报告 `applied`。回归新增于 `tests/pi-session-admission.test.mjs`（A 提交中→B 排队→清除→A 完成→B 取消、仅 A 到达原生运行时）。

### Main 独立验收与 reviewer 关闭（2026-10-31）

- reviewer 经多轮只读复审，最终确认所有已报告阻断关闭；同步预约准入与代际取消保护会话，普通刷新及失焦后的延迟模型选择均按实际显示模型更新 thinking 档位。
- 已重新构建 Pi driver（含 manifest 校验）及 renderer。真实 Electron＋Pi owner＋隔离 HTTP 模型源证明：多模型创建、修订冲突拒绝、跨来源保留密钥未经同意拒绝、编辑留空保留原密钥、真实 `/models` 请求、角色 thinking 保存与原生 clamp 回报、密钥轮换后同 owner/thread 发出新密钥请求；两个显式输入恰好两个请求，零重放，正常 exit0。证据 `/var/tmp/nozeli-pi-model-mgmt-E8utUC/report.json`、`model-management.png`，截图已查看。
- 真实 Pi GUI 输入／回复／冷启草稿恢复通过：`/var/tmp/nozeli-pi-electron-I0Kjye`；真实设置页28项通过：`/var/tmp/nozeli-settings-ui-Oh3kEl`；模型选择器慢刷新／失败／保留未发送选择通过：`/var/tmp/nozeli-provider-refresh-OtCrF8`。
- 最终原生工具／取消／投影故障／原线程恢复与新增准入、分页回归29/29通过；另 provider host 定向19项及模型档位DTO回归通过。默认完整套件另行记录，未把本节的定向通过当作全仓通过。真实OAuth登录、付费模型与Windows/macOS未验；不把服务列表等同推理授权。本轮修改尚未重新安装。


### 最终回归与源码迁入（2026-10-31）

默认完整套件 unit 480/480、integration 1434/1434，零失败／跳过；模型传播／隐私／分页／准入定向54/54通过。原生工具与生命周期29项通过；真实设置页28项及延迟选择器模型档位更新烟测通过，后者证据 `/var/tmp/nozeli-provider-refresh-YkTtAb`。修复 clear 路径异常逃逸、传播计数 finally 和原生错误 code 脱敏；未把故障转成成功。

按用户“全部通过后复制到 nozeli_git 并 commit，未来只基于 Pi 开发”授权，先保存目标工作树到 `/var/tmp/nozeli-git-pre-pi-management-20261031.tar.gz`，仅按1099项公开源码清单复制，不复制用户数据、依赖、构建产物或上下文文件，不删除目标原件。迁入后安装固定锁 Pi 开发依赖、重建 Pi driver／renderer，实际目标仓库 Electron 模型发现、轮换、模型适配 thinking、同线程零重放与正常退出烟测通过：`/var/tmp/nozeli-pi-model-mgmt-aE837D/report.json`。仓库非公开元数据检查 failures=0，六项分发审计仍 pending。

GitHub main 保护要求 PR＋CI gate；本轮没有 PR 授权，不绕过保护。以 `integration/pi-model-management` 保存并推送候选，尚不声称已进入 main。用户已明确选择“先完成代码，暂缓公开发布”，因此不创建 release 或新 tag；旧 alpha.3 归档不改变。真实OAuth登录、付费模型和Windows/macOS未验收。

