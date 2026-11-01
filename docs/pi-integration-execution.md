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


## Windows/macOS 第一阶段共享核心准备（2026-10-31）

当前实现落在 `nozeli_git` 的 Pi 主线工作树，未安装、提交或推送。本轮用户授权的是共享模块实现与整理，不是 Windows/macOS 原生功能、签名或发布验收。

- 提取真实 Linux 文件句柄/目录链、Git fd 捕获、write-parent 和依赖准备实现到 `src/platform/linux/filesystem.mjs`；业务通过 `platform/shared/filesystem.mjs` 与 `createFileStream` 依赖合同调用，保留读取预算、路径策略、并发身份及 CAS；准备依赖的根目录 `.` 语义保留。
- 进程 incarnation、整树归属/恢复、Linux bwrap 和恢复来源数据库核验归入 Linux 适配器。PiSession 使用注入进程服务；未知平台 ownerAlive 拒绝给出可释放的死亡结论，未确认后代退出不发确认回执。
- 普通私有元数据写入与目录同步走共享持久化边界；未实现平台在副作用前明确拒绝。发布后屏障失败保留 committed/uncertain；演示登记不回滚已发布请求并阻断后续效果；捕获丢弃先检查能力。
- Runtime 解析复用真实资产/架构/摘要/可执行检查；`implementationCoverage.complete` 仅表示声明覆盖，`platform-probe` 分开执行安全文件、持久化、owner、bwrap、Git 与 Pi 探针后才给机器 ready 结论。不依赖旧 OMP bundle 得到 Pi readiness。
- custom rename/link/move 保留原 Linux 每路径事务与恢复语义，入口预检平台能力，不新增断电完整性承诺。第二阶段逐平台逐事务资格是放行前提，不能一次目录同步代签。

验证：最终 `npm test` unit **489/489**、integration **1469/1469**，零失败/跳过；平台与邻接依赖测试27/27通过，进程/持久化/runtime/恢复定向通过，真实 Linux probe ready（开发树未打包Node如实not-run）。重定位 Git 测试首次漏复制新 runtime-assets 依赖导致2项失败；补齐真实安装目录闭包后最终完整套件全过，未改产品回退系统Git。真实 Electron＋Pi 回环模型实测发送/恢复未发送草稿/正常退出、原生候选编辑/差异/批注/冷启/同Worker续改及确切Git合入均通过（本机 `artifact://11152`）；完整回归原件 `artifact://11156` 与 `.test-output/ci/{unit,integration}.tap`。

独立 reviewer 已关闭范围内阻断，认可“有边界的第一阶段共享核心准备”，不等同全OS审计或Windows/macOS原生资格。消费点/剩余原生责任见 [机器清单](platform-phase1-inventory.json)，可执行步骤、合同和W0–W5/M0–M5放行门见 [第二阶段交接](platform-phase2-handoff.md)。两平台可据此独立开始native开发；当前未实现能力继续阻断，不翻绿矩阵、不静默降级。


## 普通项目终端（2026-10-31，未安装／提交／推送）

左侧“终端”显式打开 `project-terminal` 原生工作面，真实 node-pty＋xterm 用户 Shell，初始 cwd 为登记项目根目录。不是旧 Agent/OMP 终端接管。每项目一个进程，重复入口只激活原视图，分屏／脱离／回嵌／切项目不改绑 Shell；冷布局恢复保持 not-started，不能重放命令。IPC 绑定确切 project/view/instance，不接受 renderer 命令路径或 cwd。ANSI 输出、顺序输入和分页回放有界；窗口尺寸变化真实 resize。

关闭内容／项目／应用回收带唯一归属标签的进程树，含独立作业进程组；失败保留原实例并阻断新 Shell，不伪报退出。严格终端树收割使用启动前 incarnation 基线，无法检查的新进程只保留未知、不擅杀；内核会话／组来源例外仅限 strict 终端模式，不放宽 Pi 原标签检查。启动／关闭共用项目串行门，stopAll 覆盖尚未落入实例表的启动。

独立 reviewer 最终关闭所有所报阻断；定向宿主／workspace／进程143/143＋renderer2/2通过。完整默认套件unit520/520、integration1470/1470零失败／跳过（新renderer登记晚于本次完整集，另2项已独立通过）。真实 Linux Electron＋PTY 验收9场景：真实pwd、ANSI、键盘写实际文件、重复入口PID不变、跨项目/非终端输入拒绝、Ctrl-C、detach/dock同PID、关闭内容回收独立组background sleep、项目切换隔离、应用正常退出回收；冷恢复不启动Shell，按原退出确认“取消任务并退出”正常exit0。最终原件 `/var/tmp/nozeli-project-terminal-Ejn83y/report.json`、`project-terminal.png`（已查看实际guest画面）；此前Ctrl-C观察误只读首128帧，补齐分页后确认真实中断生效；未修改产品以隐藏该观察错误。完整日志 `artifact://11250`。

Windows/macOS缺少已验证终端进程所有权时明确拒绝，未作原生资格声明。真实系统剪贴板逐平台、IME/物理键盘和多屏未本轮验收；终端不是沙箱，用户命令在普通用户权限执行。未安装、未关闭用户窗口或修改用户项目。


## 当前全部修改本机安装（2026-10-31，用户授权）

从唯一源码树 `nozeli_git` 使用既有 install-local 构建、打包、校验并激活：current=`2026-10-31T11-17-44-818Z`，previous=`2026-10-31T03-33-41-686Z`；包含普通项目终端、模型适配 thinking／源编辑与发现、第一阶段平台共享核心及此前审核改版。生产 xterm/fit 依赖随包；Pi/Node/Git 校验沿既有安装门，未恢复 OMP 后端。按保留策略清理更早10-30安装，上一版可回退；未强关用户现有窗口，重开才加载新程序。

实际安装 ELF（非源码 Electron、非用户启动 wrapper）＋隔离profile／合成项目通过：终端真实pwd/ANSI/文件写入/Ctrl-C、重复入口同PID、跨项目ACL、detach/dock、关闭shell与独立进程组background sleep回收、切项目隔离、正常退出及冷恢复不自动启动；原件 `/var/tmp/nozeli-project-terminal-8qA4IV/report.json`。同安装版Pi模型多源修订／保留密钥／跨来源拒绝／真实列表发现／thinking实际clamp／原线程轮换密钥零重放通过，正常exit0：`/var/tmp/nozeli-pi-model-mgmt-PhYRJf/report.json`。均未读取个人凭据、调用付费模型或改动用户项目。未commit/push/发布；Windows/macOS仍未验收。


## OMP 源单向导入日常 Pi 与真实对话（2026-10-31，用户授权）

用户明确授权导入 OMP 源信息和真实模型管理／测试对话。仅读取现有系统 OMP 与旧 Nozeli 私有 OMP 的静态源定义及模型缓存，单向通过安装版设置接口写入日常 `~/.Nozeli/pi`，不复制会话、扩展、执行式密钥或OAuth登录态。已有Pi源保留；密钥只进入私有配置不回传/入库，先备份原Pi文件至本机受保护目录。两份原OMP models.yml SHA前后相同。

真实列表校正后：paratera 5模型、paratera2 25模型、bingxing 80模型（不把旧缓存多余ID继续列入）；三个源均revision2。easyfun真实列表请求返回DISCOVERY_UNAUTHORIZED，且无原配置模型ID；未伪造模型或宣称导入可用。需要有效凭据或明确真实模型定义后再验，不自动重试对话。

实际安装ELF＋独立验证profile共享日常Pi源，合成项目中通过真实GUI发送两轮非工具连接验收：`paratera/gpt-6.1-sol`完成并精确回复`NOZELI_REAL_CHAT_0`，原生effort=low；在线切换`bingxing/AWS-GPT-5.6-Sol`后完成并精确回复`NOZELI_REAL_CHAT_1`，原生effort=off。不按名称臆造模型能力；服务列表不代表全部模型均可推理。测试后角色默认恢复系统OMP已有`paratera/gpt-6.1-sol`，thinking沿用原生默认；真实窗口正常exit0，未在用户项目发任务或改正文。

脱敏原件 `/var/tmp/nozeli-real-source-import-qg38EH/report.json`、`reconciled.json`及设置截图；私有备份不提交。日常已运行进程须正常重开或刷新设置以重新读取更新源。本轮无源码功能变更、安装替换、commit/push/发布。


## Z.AI（GLM Coding Plan / ZCode）登录与内置源密钥（2026-10-31，Linux 本地验收通过，真实 OAuth 未运行）

新增 Nozeli 私有 Pi 运行时的 Z.AI（GLM Coding Plan）浏览器登录：以 pi-gui builtin extension 在**每个** ModelRuntime（设置快照与真实会话）上调用 Pi 官方 `pi.registerProvider(Provider)` native 注册路径，把 OAuth 方法**增补**到原生 `zai` Provider——原生模型（glm-4.7 … glm-5.3-highspeed）、openai-completions 传输、baseUrl 与原生 API-key 登录全部保留，仅增加 `auth.oauth`。存储走 Pi 自有 `auth.json`（凭据 type `oauth`，`access` 为持久 `id.secret` 密钥），因此真实请求与模型目录都使用该凭据，不是只在 GUI 生效。

来源与许可：协议自固定 OMP 快照 `.build/omp/build-IodhZv/source` 移植并逐文件标注——`packages/ai/src/registry/oauth/zai.ts`（业务登录＋密钥铸造）、`packages/catalog/src/compat/rules/auth/zai-coding-plan.kdl`（client id/端点/`zcode://zai-auth/callback`/非标准 JSON token body/凭据路径）、`packages/ai/test/zai-oauth.test.ts`（线缆形状）。上游 MIT © Stencil Labs, Inc. 及 oh-my-pi 贡献者；无 OMP/Bun 运行时依赖，仅 Node + 已固定的 `@earendil-works/pi-ai`/`pi-coding-agent`。

与上游的差异（刻意保留）：不移植 OMP 的 native-scheme 接收器——Nozeli **从不注册或接管** `zcode://` 回调；用户在自己浏览器完成授权后手动粘贴最终重定向 URL 或 `code#state`，按事务 state 常量时间校验（scheme/host/path 精确匹配），裸 code 拒绝。授权前必须显式同意（select 默认项为取消，空输入即取消），说明会创建/复用名为 `nozeli` 的专用 API 密钥；只查找/创建 `nozeli` 条目，绝不改写 ZCode 自身 `zcode-api-key` 或 OMP `oh-my-pi`，secret 一律取 copy 端点。取消：worker `authLogin` 现以 AbortController 串接，`cancel`/`stop` 中止在途 HTTP 并让原交互落定（已完成的远端创建不承诺撤销）；每个副作用步骤与返回凭据前均检查取消。错误仅含操作与状态码，不携带响应体、URL、令牌或粘贴内容；凭据不回传宿主/渲染层。

支持矩阵（来自运行时 `authList`/SDK 1.4.0，非硬编码名单）：原生 Pi OAuth 入口为 anthropic、github-copilot、kimi-coding、meta、openai、openai-codex、openrouter、xai＋动态 radius（9 项，保留原生实现，不表示逐账号真实验收）；本轮新增 `zai`（GLM Coding Plan 浏览器登录）。OMP 其余 auth 条目（alibaba-coding-plan、cursor、google-antigravity、gitlab-duo、perplexity、snowflake、xiaomi、zhipu-coding-plan 等）未移植，不宣称支持；`zai-coding-cn` 不自动继承国际 ZCode 流程。设置页新增“内置源 API 密钥”表单，仅列出运行时声明支持密钥设置的 Provider，走原生 `authSetKey`；模型定义沿用 Pi，已有订阅登录不被密钥写入覆盖，无需手填模型。

界面：设置→账号登录复用既有最小登录流（下拉列 Z.AI、授权链接展示、粘贴输入、取消），同意提示与静态说明均写明 nozeli 专用密钥与不接管 `zcode://`；新增确定性测试 `apps/desktop/tests/pi-zai-coding-plan.test.mjs`（适配器线缆/同意/取消/脱敏/回调校验＋宿主内置密钥面）与 `apps/desktop/tests/pi-zai-coding-plan-live.mjs`（真实私有 Node worker 协议对 127.0.0.1 确定性授权端点全流程：authList 清单、consent→URL→粘贴→token→业务→nozeli 密钥→auth.json→模型目录 authed，及取消/单飞）。

边界与实测：真实账号 OAuth 未运行，未打开个人浏览器、未授权、未创建真实密钥、未读取个人凭据。父级最终构建通过；适配器与宿主边界16/16，真实 Pi OwnerRuntime＋回环 HTTP 授权协议3/3（含凭据落盘、目录认证态、取消、同源写入竞态）；真实 Electron 隔离配置设置验收30项通过，实际展示专用密钥同意文案并在同意前取消，未产生凭据或外部请求。截图与报告 `/var/tmp/nozeli-settings-ui-HOJ8q0/`；源码独立复审最终无剩余阻塞。验证环境仅 Linux，不代表 Windows/macOS 或真实远端账户验收。复现命令（仓库根）：

```bash
npm --prefix integrations/pi run build             # 重建 dist 与完整性清单
node --test apps/desktop/tests/pi-zai-coding-plan.test.mjs
NOZELI_TEST_LIVE=1 node --test apps/desktop/tests/pi-zai-coding-plan-live.mjs
node apps/desktop/tools/test-suites.mjs default      # 既有回归（含 provider-settings、pi-provider-runtime）
```

真实登录需用户参与：用户在自己的浏览器打开授权链接、完成 Z.AI 登录并粘贴 `zcode://zai-auth/callback?...` 或 `code#state`；同意步骤明确将创建/复用 `nozeli` 专用密钥。父级/系统不代开个人浏览器、不自动授权。

### 追加（同日，评审后冻结前）

端点安全与竞态收口：适配器端点改为固定常量——生产忽略一切环境覆盖值（继承 env 无法把凭据流量改指他处）；仅在显式测试实例（`NOZELI_TEST_INSTANCE`，宿主环境清洗规则不剥离该标记）内接受回环 http(s) 端点覆盖（`zcode:` 重定向仅保协议校验），门控下的非回环/带凭据/改协议覆盖直接报错而非静默回退。全部 HTTP 请求 `redirect:'error'`（凭据 POST 绝不跟重定向），响应读取设 1MiB 字节上限（流式截断），错误仍仅含操作与状态。登录进行中（含 worker 内 Provider 选择器未定）时，宿主序列化边界与 worker 边界双层拒绝同 Provider 的凭据变更——native key 写入、自定义源凭据保存、源移除（worker `PI_AUTH_IN_FLIGHT`；无跨 Provider 全局锁，无关源不受影响；错误不携带密钥）；登录完成后的存量 OAuth 凭据仍由存储类型判定，密钥写入不得静默覆盖。renderer select 渲染修复：可信 Z.AI 同意文案（“请确认”前缀）显示于选项前，编号显式为 1./2.（原 `index??position??lines.length` 在插入文案行后会错位），外来 Provider 的 select 文案一律不渲染。新增测试：端点门控/重定向拒绝/字节上限、宿主登录-变更竞态与同意投影（integration 套件）、worker 边界同 Provider 拒绝（live 套件，夹具以测试门指向 127.0.0.1）。按指示本轮未执行任何测试/构建，父级随整包运行；真实账号 OAuth 仍未运行。

父级最终修正并复验：恢复回调长度上限 `PASTED_INPUT_LIMIT=8192` 与 `authLogin` 的 native 通知闭包，避免回调解析/成功登录后的 ReferenceError；上述16＋3＋30项结果来自两处修正后的最终源码，不沿用中间失败结果。

最终默认回归门 `TMPDIR=/var/tmp NOZELI_TEST_CONCURRENCY=2 npm test` 通过：unit 522/522（60文件），integration 1486/1486（144文件），零失败/跳过。原件 `apps/desktop/.test-output/ci/{unit,integration}.tap`。本轮仅源码与验证，未安装替换、提交或发布。

## 前台 GLM 切换与旧 GPT 状态修复（2026-10-31，源码已验，未安装）

用户报告前台选择 GLM 后对话仍显示 GPT。只读核对安装版：角色默认已保存 `bingxing/GLM-5.3-Flash`，原生 Pi journal 也已记录该模型的 model_change；此前最后一条 assistant 来自 GPT，核对时未有切换后的新 assistant。项目 `managed:residents` 仍保留 GPT。故不能把旧回复或旧持久元数据当作当前远端请求的证明，也不能声称已在用户会话验证下一轮 GLM。未发送用户测试消息、未读凭据、未修改用户项目。

修复 `controller.mjs`：原生 model-changed 更新同线程 resident 模型/思考档位，事务内再次检查线程身份；休眠会话恢复后落实保存的模型/思考覆盖，已匹配时不重复切换；失败留在 modelSync，按失败时的选择判断是否真正恢复，避免 GPT 凭据刷新成功掩盖 GLM 切换失败。`provider-settings.mjs` 修复模型列表延后刷新的旧快照覆盖：失焦与保存后沿最新目录及实际保存选择刷新，不恢复过期选项。

Linux 最终真实 Electron＋Pi＋本地 HTTP 实测通过：执行中 GPT 保持当前回合、GLM 显示待切换；结束后同一原线程下一轮 HTTP model 精确为 `GLM-5.3-Flash`（两次请求依次 `gpt-6.1-sol`、`GLM-5.3-Flash`）。角色下拉、同步状态、会话管理结构化事实均显示 GLM；旧 GPT 回复只保留一次、不重写；未发送草稿与原文保留。冷重开仍 GLM、原 threadId、请求数仍2，零重放。截图与日志 `/var/tmp/nozeli-defaults-electron-5W69sM/`，已查看会话事实实际画面；设置页另30项通过 `/var/tmp/nozeli-settings-ui-Vj6Qzh/`。

宿主/源/准入相邻回归40/40；最终失败意图修正后的模型元数据回归8/8；模型列表交互回归通过。扩展实际 smoke 时清理旧假设：配置向导不自动开启、打开对话后才等待 Agent ready、held 回复不得先等完成、结构化事实读取 pre 而非诊断 textarea；中间失败不记通过。本轮未重跑全量默认套件，未调用真实远端 GLM，未安装/提交/发布，Windows/macOS 未验。

## 账号与 API 源页简化（2026-10-31，reviewer 设计与复审通过，未安装）

用户截图显示同一来源重复堆叠移除确认，要求 reviewer 重设计整页。reviewer 确定结构后由 UI 工程师实施：源名称、类型/凭据状态、模型数为摘要，地址与操作分行；模型列表按需展开、本地搜索、有界高度，原生源按运行时目录计数；服务发现与已配置/内置目录分开，不把列表返回冒充推理授权。添加 API、账号登录、内置源密钥收为折叠入口，说明按需查看。移除由全局唯一确认状态控制，跨源/重复点击不叠加；失败保留局部错误，取消不刷新。保留编辑草稿并在异步写入期间冻结输入，发现导入不得覆盖同源草稿。

修改范围：`provider-settings.mjs`、`settings-panel.css`，既有设置/目录交互 smoke 及独立 `desktop-provider-settings-live.mjs`。宿主 API、安全检查与凭据存储未改。reviewer 最终源码 verdict correct，无已证实阻断。

Linux 实测：构建通过；目录交互＋宿主21/21，既有真实设置30项通过；独立真实 Electron＋宿主5组行为通过（80模型搜索；重复/跨来源确认、真实默认引用拒绝与取消无刷新；390px暗色无横向溢出；延迟成功回执期间唯一确认；解除引用后实际移除及正常exit0）。985px简洁列表、模型展开/搜索与390px暗色确认截图原件 `/var/tmp/nozeli-provider-ui-CjkI7s/`，已查看实际画面。此前 GLM 真实本地请求/原线程/冷恢复 smoke 亦通过 `/var/tmp/nozeli-defaults-electron-vv81X8/`；设置原件 `/var/tmp/nozeli-settings-ui-WwqImb/`。

独立 smoke 从旧综合设置脚本提取，避开其无关标签前置失败；测试环境修正 XAUTHORITY 保留、已有截图门与精确 CSS viewport，失败拒绝不使用仅延迟成功回执的观察器。未修改产品以规避测试失败。本轮未重跑全量套件；未调用外部发现/推理、未改用户项目或日常凭据、未安装/提交/发布；Windows/macOS未验。

## 本地 HTML 默认网页视图（2026-10-31，已实现与实测，未安装）

用户要求 HTML 可在内置浏览器打开，而不只显示代码。`.html/.htm` 现在默认进入隔离网页视图，顶部统一为网页／源码／对照、刷新网页和默认关闭的自动刷新。源码与网页共用同一已挂载编辑缓冲，切换不替换正文、选区或撤销历史；源码模式释放 native 网页；对照模式按宽度左右／上下排列，编辑器按实际源码分区高度布局。刷新捕获当前缓冲，不代替文件保存；失败保留上一网页快照并提供源码入口。保存的 `fileView.webMode` 沿已有宿主白名单和布局导航持久化，冻结审核文档继续禁用读取工作目录的网页预览。

复用既有 `IsolatedPreviewManager`／独立 WebContentsView，不将本地文件放进共享在线网站 session。可读取项目内有界 CSS、图片、JS、模块、JSON 与捕获的本地 HTML 链接，支持中文／空格文件名。外链、远端脚本／样式等继续由 CSP、member gate 和 dead proxy 阻断，但不再导致整页捕获失败；`srcset` 按 URL／descriptor 状态扫描，保留 URL 中逗号并支持无空格候选分隔。项目外逃逸、越权文件、弹窗、worker、WebRTC、App IPC 与 Node 能力仍拒绝。仍为离线本地网页，不宣称可运行任意联网应用。

实现：renderer `isolated-surfaces.mjs/.css`、`app.mjs`；main `isolated-preview.mjs`、`host.mjs` 的 `.htm` 与视图字段、`workspace-layout-store.mjs` 的导航字段。独立 reviewer 关闭两项 srcset 边界与窄屏分区审查，最终源码 verdict correct。

Linux 验证：最终宿主/预览/布局回归50/50，构建通过。真实 Electron＋真实本地文件完整 smoke15组通过：默认网页、源码／对照、CSS／SVG／classic JS／ES modules／JSON、本地链接往返、外链阻断、多个编辑器缓冲捕获、未保存刷新／撤销、安全 realm／STUN零外发、冻结报告浅深色与390/900px布局/对比度、冻结字节导出、真实历史报告入口与主题跟随；原件 `.test-output/html-surfaces-vySTYl/`。末次窄屏源码尺寸修正重建后，focused真实HTML10组再通过，新增断言编辑器不超出源码分区；原件 `.test-output/html-surfaces-tlvps9/`，已查看 native 网页内容与源码控制面截图。报告打印因本机无 CUPS 默认打印机未验成功，仅打印媒体布局验证通过。

smoke 修正实际项目激活与最终提交 generation 的 target 选择，防止对过期 native target 发安全探测；删除旧固定 RGB 默认色断言，保留主题传播、实测对比度和无溢出；恶意发布负例使用独立项目避免占用原报告 fixture 配额，不放宽产品准入。未重跑全量默认套件；GUI冷启／物理多屏／跨窗 HTML 往返及 Windows/macOS 未本轮实测。不操作用户论文、凭据或会话；未安装／提交／发布。

## 克制上下文交付与三角色记忆／skill 设计（2026-11-01，未安装）

用户明确授权将[克制上下文方案](context-delivery-design.md)落地并测试，同时协同设计三角色记忆／skill。运行源码现在保留 user 原文，把显式文件／标签／回复引用／涂鸦问题冻结为独立材料数据；取消“未见前台消息”、普通输入包装、全项目状态预装与逐轮 Worker 原任务副本。当前 Work 控制数据走单槽 native context 投影，不写入原生 journal，自动／手动／overflow 压缩摘要请求不携带该投影。材料持久一次与隐式同版本可见性缓存分开；显式重附总是完整发送，已记录后失败不会被视为未发送，unknown 不自动重投。准入、entry 精确核验、请求 tuple 与原文 digest、provider 结果分别记录，不混称“模型已理解”。

宿主预算覆盖材料／交接与只读宿主工具文本；主要 document read／list／search 不能绕过。必要控制超限阻断整请求，效果执行前持久化计数并先写 durable intent，保留拒绝与重复效果门。原任务／批准原文按当前 Work 重新登记版本化来源，超过单 run 的长文可明确暂停，再用稳定 readRef 与返回 endOffset 在下一显式 run 续读；分页按完整 JSON 响应选取 Unicode 边界，转义与来源 metadata 也计入，不在被拒页推进游标。

provider／预算／无能力技术故障只本地分类与去重，不产生 maintenance／backstage 模型扇出；宿主生成的缺失报告诊断保留可读记录但不再作为业务问题自动派模型。真实 Worker problem、原生问题与用户明确业务交接仍保留，权限／CAS／未知效果门未放宽。连接失败不销毁原对话内容面；原文、草稿与会话管理上下文详情仍可读，发送继续受连接与准入限制。详情不发模型请求，不将 hook 次数当成完整最终请求捕获。

100轮压力暴露本地存储写放大：每次 full-state pending 重复写入，历史变长后触发 SQLite IO／自动 rollback 边界。修正不变业务快照与 local/cache 重写、collection delta replace 保持最终值／revision／重复ID／CAS等价；预算 epoch 本地持久化，legacy settings 可读；保留8秒 deadline、COMMIT 后 ACK、quarantine／unknown。二次 ROLLBACK 不再覆盖原始故障。独立 storage reviewer 未发现补丁引入的 P1/P2；未声称已验证断电或所有自动 rollback 故障注入。

逐项父级实测：固定 Pi 全 live 门34/34（5文件，本地 scripted HTTP、真实 Node／Pi／journal），包括模型工具循环、两材料共享 exact entry、provider 拒绝后的持久确认、journal fault unknown fence、冷恢复、自动／手动／overflow 压缩、图片与进程清收；原件 `.test-output/ci/live.tap`。宿主 context cutover＋问题决定27/27（含100轮原文、五次拒绝零扇出、故障回执、跨 run 长文完整并集、真实 producer、重附、主控／Worker 正常绑定、效果预算与去重），对应 `tests/managed-context-cutover.test.mjs` 与 `tests/managed-problem-decisions.test.mjs`。主工作面生命周期72/72，旧契约迁移41/41、分页／材料／只读详情等定向门分别通过，不将不同轮次数字重复相加。

最终真实 Electron＋Pi11组通过 `/var/tmp/nozeli-pi-electron-EUr9tT/`：原文前后空白／换行精确保留；原生回复的真实“引用”按钮只生成一个独立材料，不晋升 system；生产 composer 中完整长引用和涂鸦问题快照分离，检查 snapshot／JSON冷草稿边界不改变用户正文或宿主持久草稿、零推理；合成图片描述只作快照验证，未发送未注册图片，不冒充真实截图交付。HTTP400后仍是原 Page，详情无额外模型调用／凭据，390／190px深色无溢出；正常exit0，冷重开保留未发送草稿且零重放。已查看实际详情截图。

[三角色记忆／skill设计](role-memory-skills-design.md)已落盘并独立审阅通过：四层来源（角色契约、用户批准项目知识、Work证据、瞬态Pi会话）、各角色职责／实际十技能目录、渐进披露、版本／冲突／撤销及原生资源白名单／reload／预算消费门。该整套知识与原生 skill 迁移仍是设计，不自动学习或导入私人资源；本轮只对现有角色说明作与上下文切换一致的收敛。

本轮无个人账号／远端付费调用、无安装／提交／发布、无 Liuhuaiyu 会话或用户文件改写；不承诺消除其上游 content_policy 拒绝。仅 Linux x64／X11 实测，Windows/macOS、真实远端理解质量与完整跨屏矩阵未验。中间失败原件保留；旧 source-rewrite composer 脚本的自动向导／单根 editor 假设不作为本轮验收，相关新增快照检查已移到真实当前 conversation smoke，未改产品去迁就旧脚本。

最终冻结源码默认门 `TMPDIR=/var/tmp NOZELI_TEST_CONCURRENCY=2 npm test`：unit **539/539**（62文件），integration **1519/1519**（146文件），零失败／跳过／取消；原件 `apps/desktop/.test-output/ci/{unit,integration}.tap`，本机完整输出 `artifact://12078`。独立 live 门 **34/34**（5文件）零失败／跳过，原件 `apps/desktop/.test-output/ci/live.tap`。最后两处旧断言已分别修正为来源类型真实保留及通过 Worker 实际读取批准原文／版本，不重新钉死已删除的 task-anchor 文案。最终真实 Electron11组、100轮压力、跨 run 原文完整并集与问题决定的27项均已通过；本段结果不沿用中间失败或未执行状态。

## 实际项目卡顿与切换保留修复（2026-11-01，源码验证，未安装／推送）

真实安装版与日常配置调查确认：首次进入项目 TeX 设置约7.95秒，同仓库原生 `fs.watch(root,{recursive:true})` 初始化7.39秒、10毫秒计时器零次执行；回调过滤依赖目录无法减少注册时的同步遍历。改为复用非递归 ProjectWatcher 的 TexSourceWatcher，异步枚举并在订阅前剪枝，保留嵌套资源／新目录变化、200毫秒合并、链接和关闭／并发检查守卫。同一真实源码仓库准备25.27毫秒，67个合格目录，隐藏／依赖／dist／vendor目录零订阅，计时器正常推进。

存储独立实际文件复现证明：主线程在发送请求后阻塞8.5秒，原实现可能先执行deadline计时器，再消费已经排队的成功回执，导致事务及操作回执实际均已提交却误入UNKNOWN。现使用专用响应MessagePort，deadline触发时同步读取已排队的可信回执，并以Worker在操作／COMMIT完成后生成的跨线程单调时间戳校验原请求期限。原8秒期限不变；真正迟到／缺失、崩溃、关闭及代际不确定仍隔离，无自动重放。原日常实例第一次隔离的最初原因未由旧IPC回执暴露，不能追溯性声称该次事件必由TeX触发。

深度真实项目验证另发现切换保留向shell发送普通lifecycle-hold，整个app.inert期间会丢掉导航输入；修前一轮20次快速输入仅17次到达项目按钮，其余命中BODY。项目切换hold现明确reason，只保留近期项目导航可交互，内容／项目操作仍保持原输入保护；关闭项目、升级等全局hold语义不变。返回失败与抛错统一显示原因，失败停止目标队列，不将被替代的选择当成故障，也不绕过源状态保留。

定向存储／监听／项目切换75/75、原生进程与真实隔离9/9通过，renderer构建通过。TeX专项先遇工具／离线缓存不可见；使用本机已有TinyTeX工具PATH与Tectonic缓存后6/6通过，包含实际XeLaTeX／pdfLaTeX／Tectonic、取消、并发变更与历史PDF。原`/tmp`隔离夹具及源码字符串断言已替换／移除，改验真实私有目录可写与未挂载兄弟文件不可读，未放宽安全策略。

真实Electron合成fixture烟测5项通过、正常退出和冷开exit0：以目标SQLite真实排他锁固定保留阶段，验证导航新可信选择仍送达、内容区仍受保护、编辑与冷恢复保持；原件 `apps/desktop/.test-output/ci/smoke-ka3lK7/report.json`。真实五项目（nozeli_git／nozeli／eos-plastic／agent_项目／Liuhuaiyu）源码Electron烟测原件 `/var/tmp/nozeli-lag-fixed-fngbww4v/report.json` ok=true、exit0：15次普通切换、20次快速可信点击全部到达并以末次选择收尾；TeX设置93毫秒；README阅读／编辑4次、滚动及真实文件搜索通过。实际Electron主进程故意阻塞8.5秒后，按时提交的真实SQLite写入仍返回revision1、持久回执一致、无误隔离；故意终止本轮复制UI库的Worker时切换保留原项目并显示真实错误，显式核查后才恢复。五个实际源文件SHA256前后相同，截图已查看。

真实项目烟测使用只复制白名单view/layout/catalog的隔离本机状态，沿原项目实体身份读取现有目录，不重新登记或改写项目身份，不复制账号／provider／进程登记，不发送模型、不改论文正文／采用成果。旧日常隔离实例与高CPU旧headless验收进程均未强杀／强制重载；本轮不安装、不推送、不发布，不宣称Windows/macOS已验。完整默认回归结果另在本节后续补记，不能把以上定向集相加冒称全仓通过。

完整当前混合工作树的磁盘临时目录回归：unit541/541、integration1534/1535，零跳过；唯一失败为并发未提交Orchestrator P0的`managed-work-todo-lifecycle.test.mjs`，按旧名称clarify后缺少Work归属，与本轮卡顿修复分开记录，不删除有效测试或混入P0代码。首轮`/tmp`曾报配额`-122`／SQLite I/O失败，日志保留于本机证据目录；修复候选需以“已提交基线＋仅本轮变更”独立运行完整集合后才提交，不能把混合工作树称为全绿。候选renderer构建及真实Electron5项（正常退出／冷重开均exit0）已通过：`/var/tmp/nozeli-lag-commit-check-20261101/apps/desktop/.test-output/ci/smoke-cqkizQ/report.json`。

