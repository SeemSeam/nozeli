# 三角色记忆与技能：来源治理、渐进披露和宿主边界

Date: 2026-11-01
Status: **角色固定流程原生skill迁移已实施并按用户后续授权安装，Linux限定接线验收；通用知识批准／自动提炼系统仍未实施。**
Scope: 保留 frontdesk／orchestrator／Worker；角色最小强制契约与原生按需技能分离。项目初始化及有界诊断实施范围见[生命周期证据](project-lifecycle-initialization-design.md#8-源码实施与限定验收2026-11-08)，不扩大为整套知识管理系统。

2026-11-07最新产品边界见[Plantree统一报告与稳定结果记忆](plantree-result-memory-design.md)：长期层默认只编目稳定文档版本和完整task结束结果，引用Plantree中的规范报告，不连续抽取聊天，不要求成果再做一次知识批准；报告作者主张不提升为系统真值或指令。原始研究见[评测报告](long-term-memory-evaluation.md)。本页通用批准知识/语义整理扩展暂缓，角色契约、来源/版本与权限分离、原生Pi历史边界继续成立；不因此授权技能迁移或生产实施。

固化边界与实施路线以该主合同§15—§18为准；`fe24f1c`已提交同项目稳定报告查询、确切来源交接及多输入证据保留，尚未安装。每输入至多4个选择，早期输入来源经版本目录保留；报告主张不授予指令或skill能力。本文通用知识批准、自动提炼及原生skill扩展继续暂缓，不把首版接线误读为这些方向已实施。


## 2026-11-13 前台项目起点技能（源码已实现，2026-11-14 Linux已安装）

用户确认将项目起点方法内置frontdesk，并按Reviewer要求补齐程序能力；不是仅新增提示词。新增 `nozeli-frontdesk-project-analysis`（当前结构／运行方式／内容问题）、`nozeli-frontdesk-project-progress`（当前进展／任务／未决决定）、`nozeli-frontdesk-history-handoff`（历史来源／决定／接续材料）。材料读取与保存复用 `read-material`，持续后台剩余工作复用 `handoff`；不复制第二加载器／历史账本／初始化地图。

- 前台分析报告通过真实文档创建／保存回执交付，不冒充Worker发布、用户采用或稳定记忆；“检查运行方式”默认不执行命令，“问题检查”不混同Nozeli宿主维修。
- 进展工具复用宿主任务板，提供有版本边界的只读分页与详情；不授予调度、采纳、删除或修改状态权限，未读范围明确。
- 历史搜索经宿主限定的本地格式适配和确切项目cwd关联；优先核实Codex、Claude Code、Pi会话JSONL。模型不提供历史根路径或内部身份；未知格式、无权限、损坏、预算耗尽与无命中分别说明。同名目录／正文提及路径不是关联证明，读取游标绑定项目、源及版本。历史内容不成为权限、事实保证或自动重放依据。
- 新默认技能与已有绑定启用分开；保留用户自选及原线程历史，在空闲边界应用，不在运行中热换技能或重放请求。旧默认迁移需要可辨识依据及归档记录。
- 测试先合成多格式历史、隔离本地Provider与真实Pi原生skill读取，再在隔离项目中核对真实项目的只读文件来源。原工作树、用户私人历史和凭据不写入测试日志；付费模型质量验收与确定性接线分开，不将固定脚本回复冒称真实理解。无安装、提交或发布授权。

### 实际接线与生效范围

- `managed/runtime.mjs` 注册完整五项frontdesk目录；正文仍由Pi原生read按需读取，不进入常驻role prompt。新增文件位于 `roles/frontdesk/skills/nozeli-frontdesk-{project-analysis,project-progress,history-handoff}/SKILL.md`。
- `nozeli_project_progress({action:'list'|'detail',cursor?,limit?,workId?})` 复用宿主任务板／未决todo账本；Work与todo同时有界续页，job／状态／决定变化触发重同步。详情仅本项目。只读权限在消费者再次检查，不因伪造工具名获得主控操作。
- `nozeli_provider_history_search({query?,provider?,cursor?,limit?})` 和 `nozeli_provider_history_read({source,cursor?,maxBytes?})` 经 `provider-history.mjs` 读取Codex、Claude Code、Pi支持的JSONL。source与cursor为reader/项目绑定的有期票据；参数与输出纳入当前回合预算，prepared-page缓存支持未投递结果重试，不因预算持久化失败跳页。
- 默认路径为用户home下 `.codex/sessions`、`.claude/projects`、`.pi/agent/sessions`；这里只读各客户端历史，不包含Nozeli全部内部会话、所有归档目录或未知客户端版本。精确canonical cwd关联，不从项目名或正文猜归属；worktree／别名／移动路径尚无可证明关联时不纳入。目录被替换使来源失效。
- 报告引用 `descriptor` 的provider相对sourcePath、sourceVersion及versionKind，配合sessionId、JSONL字节起点／行号／recordIndex和解码后正文UTF-16区间。stat版本不是内容digest；随机票据不是永久证据。源追加／轮转／删除需重新搜索，早期错误／超大／未知记录的“不完整”标记贯穿末页，不因EOF恢复成完整覆盖。
- `provider-history-file.mjs` 以全部祖先、打开前entry与实开descriptor的bigint身份复核保护实际读取，读取前后和关闭均验证；身份无法可靠取得、硬链接或路径替换拒绝。无/proc或shell依赖，但本轮仅Linux实测。
- 新默认标记 `skillSelection:'default',defaultVersion:2`。无来源标记的旧两项绑定不猜作默认；有确切default标记才升级并归档。设置→Agent资源→前台项目技能提供显式增量启用，只合并新增三项，不恢复用户关闭的其他技能；忙时拒绝，在原线程空闲更新，不重放输入。

### 已执行验证与失败边界

| 验证 | 实际结果 | 证据／范围 |
| --- | --- | --- |
| 技能／历史／设置定向基础检查 | 35项通过 | 原生目录发现、角色隔离、三格式、来源变化、票据与设置保护；后续修订另有下列回归 |
| 修订后的进展／历史消费者回归 | 38项通过 | 93个Work及全部180项未决事项真实续页、权限、状态变化、预算拒绝和持久化失败重试、祖先／entry替换、未知格式与累计不完整、稳定引用 |
| 全单元集 | 831/831通过 | 85个文件，新增skill及设置消费者回归已注册 |
| 真实Pi原生skill接线 | 1项集成通过 | `/tmp/nozeli-pi-real-WmR6Yo/frontdesk-skill-evidence.json`；本地确定性Provider，按需read三技能后搜索／读取Nozeli真实源码的隔离副本，核对版本与readHandle，原件未变；不是模型理解质量 |
| 既有项目真实Electron启用 | 通过，exit0，errors=[] | `/tmp/nozeli-pi-real-Nkjm49/skills-ui-report.json`；增量启用保留关闭项及原thread，无模型prompt，390px卡片滚动可读 |
| 原生read测试前置范围拦截 | 本地probe通过 | `/tmp/nozeli-pi-real-N4x6sp/native-read-probe.json`；真实PiSession在工具执行前拒绝snapshot外路径与符号链接，允许snapshot和exact skill；测试侧SDK门，不是OS沙箱 |
| 当前默认真实模型理解评测 | **服务拒绝，不通过** | `/tmp/nozeli-frontdesk-real-evaluation-oaqaI2/report.json`；GLM-5.3-Flash/off，1次真实completion HTTP401后立即停止，未观察到skill读取／分析／报告回执，进展和历史两例未运行；SDK零usage占位不等于零费用，实际费用未知 |

独立审核提出的祖先目录竞态、分页末页完整性误报、已关联未知记录静默丢弃已修复并增加回归。真实模型脚本 `tests/frontdesk-skills-real-evaluation.mjs` 仅显式 `--run-real-frontdesk` 启动，不进默认测试；最多3输入／24 completion／每输入120秒／每次输出2500 tokens，不自动重试或换源。实际服务401不归因为skill通过；下一次真实调用需要先确认认证可用及新的测试授权。本轮不改账号配置、不继续发送私人历史或原工作树。

追加独立复核：descriptor身份复核和已关联未知格式两项确认闭合；发现超长无换行尾记录恰在缓冲清空边界结束时未记incomplete。已改为首次丢弃即累计标记并单次记录诊断；新增401字节无换行尾记录回归，最终历史适配34/34通过，不把EOF误称完整覆盖。该末项为定向复验，不复用此前全单元数字冒称最新全量运行。

2026-11-14用户授权切换模型后复测并提交：项目级前台覆盖已应用 `zai/glm-5.3`，不以仍未改变的全局默认代替实际选择。人工评测脚本支持显式 `--model`／`--effort`，以隔离配置和限额执行，不修改原模型设置；复测结果按新证据另记，保留上次401记录，不将本地接线通过覆盖真实理解结果。

复测原件：`/tmp/nozeli-frontdesk-real-evaluation-PS1NaO/report.json`，原生正文补充核对 `native-review.json`。显式 `zai/glm-5.3`，20次completion全部HTTP200，3个输入均completed；请求off但SDK实际应用low，不能称off模式通过。analysis/history实际按需读对应skill，progress未观察到skill读取。`ANALYSIS.md` 有真实document_create回执与文件，分析区分裁剪快照／声明／未知，但未核实全部复制的实现源码。

进展仅offset0/todoOffset0，历史三格式均只读首页、都有hasMore，无cursor续读，目标后页阻塞未取到，故整体内容深测仍未通过；原生答复有声明未读／额度限制，并正确区分export-pending与历史export-ready。历史答复另把搜索覆盖中的unconfirmed计数误归给已匹配来源，不能据此判关联理解正确。合成93个Work在Controller.start后被调度而产生额外待办（实报179及HOST_MAINTENANCE），87这个种子数不是运行后真值，计数差异不能全归模型。原始脚本final误取旧state.messages，修复后从原生timeline采集；旧报告不改写、不据补充核对再次发模型请求。

SDK报告 input45129、output5739、cacheRead400064、totalTokens450932；SDK费用估算0.19244884（单位沿SDK），实际账单未知。未主动尝试越界读，不能把“无违规尝试”冒称本次拒绝路径验证；另有前述localhost拒绝probe。原件digest未变、临时凭据副本已删除，未重试或换源。本轮按用户授权提交实现及真实失败记录，未安装／发布。

### 2026-11-14 本机安装与既有项目启用

用户授权后执行 `node tools/install-local.mjs`，安装版为 `/home/bfly/.local/opt/nozeli/releases/2026-11-13T23-42-26-021Z`，current已切换；旧版 `all-fixes-tex-icons-20261113-local-02` 保留回退。安装包含当前工作树已有界面修正，不将其他未提交修改纳入技能提交。未推送／发布，也不据Linux安装声称跨平台通过。

真实日常Electron中正常关闭旧窗口、启动安装版，重新打开既有 `deeploy` 项目。在“设置→Agent资源”显式增量启用三项技能，原有read-material／handoff仍保留；宿主managed.status返回五项已选技能、busyTargets=[]、Work=0。未向该日常项目发送测试问题、未改项目文件。截图已人工查看：`/tmp/nozeli-installed-skills-ui-20261114/installed-skills-after-enable.png`，结构化证据同目录 `skills-ui-report.json`。首次连接使用自动化默认视口时，项目切换报工作面视口持续变化；后改用原生窗口尺寸连接并完成绑定与启用。期间一次安装版主进程exit0，原因未确认，不将其归因为产品崩溃或稳定性通过。最终保留日常窗口打开。

安装包真实源码评测（非GUI发送输入，使用已安装Controller／PiSession／owner）：`/tmp/nozeli-installed-real-project-GYB8PR/report.json` 及 `native-review.md`。真实contentRoot为Nozeli源码项目，profile／runtime隔离，测试侧禁止原项目写入、命令、派工；只读门不是OS沙箱。最初脚本缺少显式安装版owner入口，在Controller.start阶段失败、HTTP=0，原件保留 `/tmp/nozeli-installed-real-project-l5Or88`；修正夹具路径后按明确授权单次重跑，不归因于产品故障。

实际应用 `zai/glm-5.3 / low`，三个输入均completed，24次completion全部HTTP200，无模型重试或换源。三次均有原生读取对应skill的记录。analysis实际读README、package.json、runtime.mjs及project-progress.mjs，区分源码／声明／未知；progress正确报告隔离账本0 Work／0待办，并区分真实规划未完项和未读范围。报告为测试侧保存的原生答复，不冒称宿主document_create或项目内写入。

history使用前两输入的真实Pi会话冻结副本，不读私人provider／CCB历史；12页成功续读，末次HOST_CONTEXT_BUDGET_EXHAUSTED，仍hasMore，不能称完整接续或跨Codex／Claude覆盖。答复误报“8页成功”、缺逐条完整location引用，且把前两回合的当前文件核对说成本回合已核对，质量仍未全部通过。生产预算保持run65536／epoch262144 bytes，各输入不同runId，不复用前次records12夹具。1791个纳入检查的原文件SHA-256前后一致，临时凭据副本已删，初末Work均0，无命令／写入／派工尝试。SDK合计input36732、output3687、cacheRead539264、totalTokens579683，实际结算金额未知。Linux限定，不据completed或HTTP200推进整体内容质量签收。

2026-11-14用户要求改用真实大项目deeploy继续测试。根目录 `/home/bfly/workspace/computeforcfd/deeploy` 保持完整，未裁剪；只统计路径与大小时，排除常见虚拟环境、点目录元数据和缓存后仍有121154个文件、14491602651 bytes，此数包含实验产物，不代表唯一有效源码量。人工只读确认DeePoly_git主代码、DeePoly_git_jianhua_fitting简化分支及早期实验／论文并存，主分支pyproject声明deepoly=src.cli:main，当前复杂边界计划顶部为2026-09-18的0221审阅，不能用旧README或较早handoff替代当前状态。

安装版Controller／PiSession已绑定真实大项目及隔离状态，显式 `zai/glm-5.3 / low`；三场景限24completion／每输入120秒／输出2500tokens，禁止项目写入、训练、编译、命令、派工及私人历史读取。首次请求即HTTP429，服务code1308说明五小时用量耗尽，原文给出reset `2026-11-14 14:03:25`（未注明时区）；立即停止，无重试／换源。技能read和模型工具调用均0，analysis失败、progress／history未发，不构成大项目能力或性能验收。证据 `/tmp/nozeli-deeploy-real-project-d3y2sW/report.json`、`http.json`；临时认证副本已清除，纳入摘要检查的安装模块／技能原件未变，不能把该摘要范围冒称整个14.5GB项目内容核验。用户项目内容未被模型读取，没有项目写入尝试。真实大项目三场景仍待服务恢复后另次执行。

用户追加授权换模型重测，明确选择 `paratera/gpt-6.1-sol`；安装版会话实际应用该selector／low（catalog支持low），只改变隔离测试配置，不改全局或日常项目模型。证据 `/tmp/nozeli-deeploy-model-retest-OsxoHj/report.json`、`http.json` 和三项native-timeline／native-answer文件。24次HTTP均200，无服务429；三项对应skill均原生read成功，但整体验收未通过。

- analysis：约10.5秒后失败，根目录nozeli_project_list带projectPath时返回CAPABILITY_UNAVAILABLE／“文件路径解析未接入”，未完成源码分析。此安装模块直连夹具没有配齐路径解析能力的可能性必须保留，不将其当作真实GUI同路径故障证据。
- progress：约107.1秒completed，读到Plantree、当前状态、路线图、0221决策及0220／0221审阅记录，区分旧handoff与09-18当前状态，给出两项非执行下一步。但9次账本list均传workId空串并被INVALID_PAYLOAD拒绝，document_read带readRef空串也被拒绝；另一次原生read项目文件被测试门拦截，随后source_read成功。答复如实声明无法核对账本，不能把completed当进度工具通过；答复“schema要求workId”仅为模型自述，未独立验证其根因。
- history：约53.6秒失败，7次搜索都传cursor空串，宿主返回invalid_cursor，items为空，没有history_read、正文或后页证据。达到24请求上限后终态为PI_PROVIDER_FAILED／Connection error；HTTP账本本身全部200、refused=false，不把最后错误冒称服务端拒绝或完整历史质量结论。重复无效调用是本轮观察，不据此擅自增加调用额度或自动换源。

纳入摘要核对的17个原件（10个安装模块／技能、7个项目文档）均前后一致，未检查整个大项目的全部内容；初末Work均0，临时认证副本已删，无命令、写入或派工工具尝试。SDK合计input28872、output3290、cacheRead332844、totalTokens365006，实际账单未知。后续修正重点为测试路径解析接线及空可选字段与宿主schema的兼容；本轮仅测试和记录，未改产品、未重装、未自动重试。另日常安装版进程收到exit0通知，退出原因未确认，本轮不宣称其持续打开。

### 2026-11-14 strict可选参数修复与大项目推进

修复范围限定为strict-provider可选参数与宿主协议的一致性，以及真实大项目验收夹具缺失的生产路径解析接线。新增显式手动入口 `tests/frontdesk-large-project-real-evaluation.mjs`，从current安装包加载实际模块，接入已安装 `ManagedProjects.resolveRegisteredProject` 并在付费前实际执行根目录解析／列表预检；项目文本原生read与宿主read均受相同只读范围约束，按需摘要核验。入口必须显式指定项目、模型和effort，不进入自动套件，不再依赖已删除的临时脚本。回归、重装与模型复验结果按后续实际输出追加，不预记通过；路径解析和参数协议缺陷不以增加调用额度、隐藏错误或提示词重试代替。

根因核实：固定Pi 1.4.0的 `makeStrictJsonSchema` 将所有属性加入required，同时为optional字段增加null分支；不是必须填写非空字符串。产品在具体消费者边界将nullable optional及空选择器占位按省略处理（progress workId／cursor、history cursor及optional provider、document readRef／路径／access），不全局清理用户文本。list仍拒绝非空workId，detail需精确本项目Work；非空非法cursor、外国readRef、混合续读路径、未知字段及私密文件仍拒绝。无需修改Pi adapter／vendor／manifest，无提示词循环重试或权限fallback。

定向回归分阶段执行：`frontdesk-documents`、`managed-document-reader`、`provider-history`共69项通过；`managed-frontdesk-progress`前7项通过，最后strict文档消费者回归单项1/1通过。初跑strict测试使用createRequire解析ESM-only导出失败，改为固定依赖真实ESM模块；文档回归最初双storage重复注册产生身份冲突，改为真实DesktopHost和Controller共用单storage后单项通过，不修改产品身份校验。新增回归走实际Pi strict schema转换／参数验证／reverse-RPC及真实临时文件，覆盖首读、续页、原版本快照、非法票据／未知字段／私密内容拒绝。正式manual脚本node --check通过；这些分阶段数字不冒称最新全量集运行。

本机安装已完成：current为 `/home/bfly/.local/opt/nozeli/releases/2026-11-14T05-35-59-922Z`，previous保留 `2026-11-13T23-42-26-021Z`。本轮真实模型验证沿用 `paratera/gpt-6.1-sol / low`，不改日常默认或项目配置；未提交／推送／公开发布。

修复安装版三场景实测证据 `/tmp/nozeli-large-project-evaluation-4ntpQD/report.json`：实际paratera/gpt-6.1-sol／low，16次HTTP全部200，三个输入均completed，无原参数错误循环。analysis列根目录成功，读取主包pyproject、CLI、函数拟合solver与简化分支README，给出版本口径、调用链及未验范围；progress的null workId／cursor首读返回0 Work／0待办，且明确只代表隔离账本。history的null cursor搜索与正文首读成功，引用稳定location，不再invalid_cursor。17个纳入核对原件未变，临时凭据已删，初末Work为0；不是全项目内容摘要核验，也不是GUI输入端到端验收。

未全部通过：progress在一次300项目录列表被HOST_CONTEXT_BUDGET_EXHAUSTED拒绝后停止，未独立读取0220／0221证据正文，只按已读当前状态给出有限结论。history仅读一页，将coverage.budgetExhausted误称整轮额度耗尽；实际宿主run只使用14638／65536 bytes、epoch92172／262144 bytes，仍可续读。该字段原本描述页级截断，命名误导；继续改为coverage.pageLimitReached及明确limitScope，删除旧budgetExhausted字段，history skill升v2解释下一页与宿主HOST_CONTEXT_BUDGET_EXHAUSTED区别。确定性回归验证有宿主余量时原样cursor取得连续正文，不增加预算或静默重试。后续只使用本轮24上限剩余最多8次请求，显式冻结前两输入原生副本做历史单项复验；不重发分析／进展、不增加总额度。

页限额追加修复后，provider-history回归35/35及strict历史消费者续读单项1/1通过，脚本语法检查通过。最终安装current为 `/home/bfly/.local/opt/nozeli/releases/2026-11-14T05-42-56-758Z`，previous为05-35-59版；旧版23-42-26也由安装器保留。删除旧budgetExhausted输出及其断言，所有源码消费者改为pageLimitReached；无兼容别名，宿主预算不变。

历史定向复验证据 `/tmp/nozeli-large-project-evaluation-1NFPWW/report.json`：同模型／low，明确使用前次 `4ntpQD/authentic-history/pi/frontdesk-first-two-inputs.jsonl` 冻结原件，不接入私人历史。新增8次HTTP均200，搜索1页成功，正文6页均status=ok并原样cursor推进，lineOrdinal／UTF-16 textStart/End连续，不再因页限额停在首页。达到显式max-completions=8后测试门记stopReason=EVAL_HTTP_LIMIT，终态failed／Connection error，没有最终摘要；仍有后页，不据此宣称完整接续通过。本轮两次合计16+8=24请求，无额外扩额／自动重试。宿主run用量48589／65536 bytes，剩余读取额度不代表测试请求额度也未耗尽。

定向复验纳入核对的安装原件和输入冻结副本未变，凭据副本已清除，无业务写入或派工。当前已证实：真实大项目列目录与指定源码分析可执行，nullable首读账本／历史请求不再拒绝循环，分页语义修正后实际续读6页。未签收：历史完整尾页及最终摘要、当前计划决策证据全链、真实日常账本与私人跨provider历史、GUI输入全链及跨平台。未提交／推送／发布，日常模型配置不变。
2026-11-15用户要求安装并用真实DeepPoly定位、修复。自修复版安装成功，current `/home/bfly/.local/opt/nozeli/releases/2026-11-15T00-51-16-784Z`，安装包自修复原生Electron检测13场景、两次exit0、errors=[]（`/tmp/nozeli-admin-electron-yfgInT/report.json`）。

实际DeepPoly诊断使用安装版 `AdminMaintenance` 只读适配器，根 `/home/bfly/workspace/computeforcfd/deeploy`、注册ID `7e737751-e7e8-431b-a2c8-5cbb7823c34d`、注册instance `37ef816b-8d8c-4dfb-b610-2ea153e39f85`。诊断未创建Controller、未启动项目模型、未读项目正文、未改源码、未执行维修；返回真实阻断 `PROJECT_IDENTITY_CONFLICT: 项目目录实体已变化`。登记metadata identity为dev66308/ino23632804，当前 `.nozeli` identity为dev66308/ino24173899；当前manifest projectId为 `fba5cd43-46a0-476a-879f-ca446cd74721`，与登记ID及历史lineage冲突；maintenance总数0，故障没有可安全签发的repair source，不能执行修复。

用户明确选择“恢复原项目身份”。可访问的临时评测备份只保存派生身份（例如projectId `3a882e03-f53e-477c-9e1a-c6613efb9071`、lineage为原登记ID），不是完整原始7e身份；不能将派生副本冒充原元数据，也不能直接覆盖当前 `.nozeli`。已保存当前冲突现场快照 `/home/bfly/.cache/nozeli/deeploy-recovery/20261115T010715Z/current-nozeli`，并保存可用派生清单为同目录 `available-derived-project.json`；DeepPoly原目录未再修改。恢复因此安全阻断，等待真正原始元数据备份或用户明确选择按新身份重新登记；不自动重置、不合并、不删除评测状态、不重放任务。实际结论是“定位完成，修复不可安全执行”，不是DeepPoly已修复。
2026-11-15真实安装版全局助手DeepPoly自检查：脚本 `/tmp/nozeli-admin-real-deepoly-KwCwfm/report.json` 使用安装版 `2026-11-15T00-51-16-784Z`、真实 `zai/glm-5.3/low`，单次用户输入，实际原生read了 `nozeli-admin-nozeli-maintenance` skill，调用 `nozeli_admin_registry`，随后两次调用 `nozeli_admin_diagnostics`（首次空占位被宿主纠正，第二次 `limit:24`），没有调用prepare/confirm/任何修复工具。助手正确报告registry目标deeploy身份匹配但available=false，diagnostics返回supported=false、reason=maintenance-page-stale、rows为空；明确无法判断具体故障／没有retry source，不重置身份、不改项目、不连接项目模型、不重放任务，并指出缺少宿主维修元数据／分页状态。模型原生答复不是固定脚本，工具输入与答复保存在隔离管理会话。

实际副作用核对：DeepPoly `.nozeli`及纳入快照未变，诊断阶段未创建项目Controller；报告 `metadataUnchanged:true`，请求1 completed，临时凭据副本删除。当前可证实能力是“真实助手自检查并安全阻断”，不是“已修复DeepPoly”。此前发现的真实根因仍为登记metadata identity `dev66308/ino23632804` 与当前磁盘 `dev66308/ino24173899` 不一致，当前manifest `fba5cd43-46a0-476a-879f-ca446cd74721`与登记ID冲突；原始7e身份备份缺失，不能安全恢复。











尚未签收：真实模型进展／历史后页覆盖与完整内容质量、用户私人历史的格式覆盖、Windows/macOS行为；不开启全局个人skill发现、不恢复外部Agent会话、不复制第二历史账本。空页／空对话开场入口仍为独立Demo，本次交付是技能、工具及显式启用路径，不宣称Demo已接入生产。Linux已安装，未发布。


## 1. 决策与不做什么

以 [context-delivery-design.md](context-delivery-design.md) 为交付合同：Pi 独占原生历史、工具循环、压缩与恢复；Nozeli 管材料版本、Work、CAS、效果与准入。`memory.md` 是现有角色契约文件名，不是会话学习结果。三个角色不拥有各自不断增长的长期聊天记忆。知识是用户批准的项目来源，不是模型自行形成的权限或事实。

不新增记忆引擎、向量库、总结 Agent、第二历史账本；不自动提炼／学习 Work 报告，不导入私人笔记、全局个人技能或其他项目知识，不为索引、检索、详情、冲突检测、reload 发模型请求。Pi 原有 compaction 可能调用模型，必须独立标明，不能称为本设计的零调用操作。无安装、提交、推送、个人账号验证或用户会话改写。

## 2. 源码基线与明确差距

以下为本轮阅读的实现事实，后续并行 context cutover 可能修改；不是拟议能力的上线声明。

- `apps/desktop/src/agents/managed/roles.json`：frontdesk、orchestrator 为 resident，worker 为 dynamic；包位于 `roles/<role>`。不改变角色数量、模型或 effort 设置。
- `managed/runtime.mjs`：`rolePrompt` 读取 `memory.md`；frontdesk 默认全部技能，orchestrator 固定 `project-maintenance.md`，Worker 固定 report/task-boundary 并加载所选非 material 技能。`eventSkill` 为 intake 选择 handoff/followup/clarification；`readRoleSkill` 校验文件名／授予列表，返回正文 SHA-256。
- `managed/controller.mjs`：角色绑定含 skills、instructions、instructionDigest；resident 设置重启同线程，Worker 设置默认作用于新 Worker，既有 Work 保留绑定。当前 `nozeli_skill_read` 只向 Worker 注册，frontdesk/orchestrator 调用会被拒绝。设计不能声称三个角色今天已可调用此工具。
- 三份 `roles/*/memory.md` 同时包含稳定职责、详细工具纠错、旧 OMP 措辞及错误后台路由政策；需要分层，不可直接复制成新的全量 system prompt。Worker 候选／发布／用户采用门和 frontdesk 原工作树直接保存必须保留区别。
- `managed/memory-version.mjs`：`MemoryVersion.snapshot()` 读取 `index.md` 及其直接链接的 `topics/<name>.md`，校验普通文件、stat 身份及内容摘要；它不是任意目录知识扫描，也不提供用户批准或不可变历史归档。
- `managed/context-reader.mjs`：ContextReader 是每宿主 turn 的临时 readRef；文本分页约 10,000 JS 字符，记录版本和区间。`memoryContext` 是本地词项匹配，返回最多四个匹配、历史入口等；当前 preview、recent、allReadRef 不等于用户批准知识，也不证明全文已读。不得将字符上限冒称字节／token 预算。
- `apps/desktop/src/agents/runtime.mjs` 是旧两角色档案只读器，不是本方案执行入口；不复活旧 runtime。
- Pi 固定依据：`integrations/pi/upstream-manifest.json` 所记录版本及本地 `@earendil-works/pi-coding-agent@1.4.0` 的 `docs/skills.md`、`dist/core/skills.js`、`resource-loader.{js,d.ts}`。适配层当前通过 `integrations/pi/src/bridge.mjs` 的 resourceLoaderOptions 加 system extension；不能据 SDK 支持资源加载推断 Nozeli 已隔离并接入原生技能目录。

## 3. 四种来源，四种生命周期

| 类别 | 权威与写入者 | 默认启动内容 | 变更与用途 |
| --- | --- | --- | --- |
| 不可变角色契约 | 发布包／宿主维护者；每一版本不可变 | 当前角色短职责、强制边界、真实工具合同 | 新版本可替换后续绑定；旧版本留审计，不由项目知识覆盖 |
| 用户批准的项目知识 | 用户明确批准某个范围、正文和版本 | **零正文，零自动项目知识目录** | 任务相关时显式查询；来源仍是数据，不升级 system authority |
| Work 证据 | 宿主冻结的原请求、批准扩展、材料、候选、报告及效果回执 | 仅当前 Work 必需控制身份／范围版本／未决效果投影 | 首次交接提供必要原文；其余按版本查询；报告完成不自动晋升知识 |
| 瞬态会话信息 | Pi 原生消息、压缩、当前用户输入；宿主短期读引用 | Pi 自己恢复；Nozeli 不再补发 | readRef 随 turn 失效；可重签来源引用，不能伪造会话持久知识 |

知识版本批准不等于批准执行命令；接受 Worker 结果不等于批准项目知识；批准知识也不扩大 Work 原任务范围。用户当前约束优先适用于当前任务，历史约束不能自动带到无关新任务。命令、路径、角色或技能标签本身不新设权限；保持现有当前用户工具策略，高风险效果仍走宿主授权与实际 OS 身份校验。

## 4. 每个角色的最小启动与具体工作方式

共同启动只有：角色契约版本、实际授予的工具定义、可用技能短目录（名称、用途、版本、适用事件）。目录是发布包静态元数据，不是项目记忆内容；不扫描全项目任务表。frontdesk 普通闲聊的**可变自动投影为零**。其他角色只有当前绑定必要控制事实，按 context 合同一个有界槽位；不会另建一份 Worker system 锚点和持久 user 锚点。

### Frontdesk

职责：直接解答、查阅、编辑并保存用户当前原工作树；真正需要后台持续执行时交接具体剩余动作及真实已完成／未知效果。直接保存不要求 Worker 报告或采用仪式。

最小契约：原文一次、材料为数据；CAS／草稿保护；不虚构成功；交接不扩大范围；技术诊断不自动派后台模型。详细替换错误教程留在 read-material 技能，不在每轮重复。

目录来自实际文件：`read-material.md`（证据、文档读取／编辑和版本）、`handoff.md`（后台继续、取消与高风险效果边界）。按任务读取而不是默认拼全文。例：“把这一段改短”→读目标版本→CAS 保存→报告真实结果；不读历史报告或项目记忆。“后台继续核对剩余章节”→handoff→只交接未完成章节与已保存回执；不抄前台聊天历史。

### Orchestrator

职责：分类、路由、排程、查真实绑定和缺失路由事实；不是内容作者、知识策展人或自动诊断 Agent。不发明任务、测试或验收要求；保留当前政策允许的小型直接操作，而不是新增角色权限禁令。

最小契约：宿主 owns ID／队列／配额／revision；绑定讨论 continue，明确独立目标 dispatch，状态查询 status；路由不是范围批准，结束／采用／放弃只能由用户控制。宿主先验证事件绑定，再选适用规则；事件正文仍是一次源数据，不能把整份 event skill 拼到 user 原文。

实际目录：`handoff.md`（无绑定 intake）、`followup.md`（显式绑定 Work）、`clarification.md`（确有业务缺信息的绑定澄清）、`project-maintenance.md`（用户明确诊断与已声明确定性恢复能力）。现有 maintenance 文件“always injected／自动排队诊断”的文字必须随 context 政策更新，不可原样当长期契约。

例：用户明确在 Work A 补充一条要求→绑定规则→continue 同一 A；新目标超范围由 Worker／宿主 deviation 流处理，不由主控替用户批准。“连接失败”UI 通知→本地诊断记录，**不触发** clarification 或 maintenance 技能模型回合。用户明确要求分析某失败→一次受范围限制的诊断输入，查原回执，不重放未知效果。

### Worker

职责：专属 worktree 内内容工作、与用户同 Work 讨论、冻结证据并发布结果；候选不冒充原项目已采用。仅用户采用／放弃，宿主整合／关闭；无文件分析同样需真实最终发布。

最小契约包括不可选关闭的任务范围比较、deviation 停止、发布义务与候选身份、效果不重放、CAS 和宿主门。`report.md`／`task-boundary.md` 的详细程序可渐进读取，**强制义务不依赖模型是否读取技能**。宿主只能程序化验证可证明的绑定、审批、文件和状态，不声称完全自动理解任意自然语言范围；语义偏离仍须模型报告和用户决策。

实际目录：`material.md`（冻结材料与当前源区别）、`question.md`（业务缺事实／保留进度）、`report.md`（静态 HTML、真实来源、发布停止）、`task-boundary.md`（原任务＋明确批准扩展）。当前 Worker 已有 `nozeli_skill_read({name:"material.md"})`；未来原生技能迁移之前仍沿该真实工具，不给 frontdesk 虚构同名能力。

例：核对长文→按冻结版本分页→记录区间并集→发布引用与未读限制；不能最后一页 complete 就声称通读。“顺便加一个独立产品”→报告 deviation 并停止→用户明确批准后更新范围版本；不因加载一个技能变成获准执行。

## 5. 技能形式：原生 Pi 渐进披露，而不是第二加载器

迁移已采用Pi目录式`SKILL.md`（name、description、相对引用资源），上节既有技能逐一转为角色命名空间，例如`nozeli-frontdesk-read-material`、`nozeli-orchestrator-followup`、`nozeli-worker-report`；新增初始化及诊断方法沿同一机制。技能清单、正文路径与授权按角色过滤，真实原生read按需读取，不保留相同正文经rolePrompt、eventSkill、native skill三路加载。历史非Pi绑定只读保留，Pi绑定迁移前归档。

2026-11-08用户明确固定流程优先skill、尽量少提示词注入：项目初始化/地图维护与项目诊断方法已沿Pi原生skill按需接线，见[生命周期合同](project-lifecycle-initialization-design.md)。角色常驻只留最小职责/强制边界/工具及短目录，事件只传事实/身份/引用，不复制流程正文；同一规则禁止多路注入。身份/预算/停稳/删除/CAS仍由宿主执行，不能转成skill软保证。真实Electron/Pi初始化证明skill发现、read及受限工具顺序；不证明付费模型理解质量，尚未日常安装。

兼容性已从固定版本源码／文档确认的部分：

1. Pi 目录只展示名称／description／path；匹配任务后模型读完整文件。`formatSkillsForPrompt` 过滤 `disableModelInvocation`。
2. `disable-model-invocation: true` 只隐藏自动模型目录，不是安全撤销；显式 `/skill:name` 仍可使用。`enableSkillCommands` 控制交互发现，不保证禁止手工命令。`allowed-tools` 是实验元数据，不是 Nozeli 能力授予。
3. `/skill:name` 将指令及参数展开为输入，不适合偷偷替代用户普通消息。Nozeli UI 如提供“使用技能”须展示独立明确操作和实际交付；普通 user 文本保持逐字原样，不把事件处理伪装成用户发出的 skill command。
4. `DefaultResourceLoader` 有 noSkills、additionalSkillPaths、skillsOverride、noContextFiles、agentsFilesOverride 和 reload；**noSkills 不等于绝对不加载**：显式 additional／CLI 路径仍可进入，extensions 也可 extendResources。只设置 noSkills 不是可证明的来源 allowlist。
5. 原生默认搜索 user/project／祖先 `.agents/skills` 及包资源；名称冲突首个获胜并警告。Nozeli 必须对明确授权的角色包做精确资源选择、碰撞拒绝和来源登记，不继承任意个人目录。角色命名空间不能替代来源验证。
6. 当前 `bridge.reload` 拒绝 promptInFlight 并走 driver.reloadSession；SDK reload 可重新解析设置、包、扩展，不只是换技能文本。应用层必须将“技能刷新”限定为已批准本地资源集，不触发安装、网络导入、模型调用或非技能配置变更。

尚需以后实施验证：managed bridge 的最终 catalog／原生 read 可达性／scope 过滤、禁用后显式命令拒绝、extension 资源再过滤、固定版本的 reload 生命周期和同名诊断。未通过前沿现有 readRoleSkill 合同，不能宣布原生迁移完成。

禁用分两类：隐藏自动建议（可选用户偏好）与撤销授予（宿主 catalog、读取／命令入口均拒绝未来加载）。两者 UI 必须分开。已入 Pi 历史的技能文本不会因禁用被偷偷删除；宿主即时工具准入使用最新撤销事实。技能不能实现对当前用户文件权限的沙箱；本方案限制自动资源交付，不谎称禁止用户工具读取已可访问文件。

绑定与 reload：保留当前 resident 同线程、Worker 新默认／旧 Work 固定绑定的语义。显示生效范围；用户主动迁移现有 Work 时，在空闲边界记录旧／新契约与技能版本，下一 run 使用新资源集。prompt 进行时不能热换文本；紧急撤销先在宿主工具门生效，停止后续自动动作，再于安全边界刷新。resume 保留原生历史，按当前有效授权重建目录，不回灌历史技能正文。

## 6. 用户批准项目知识的生命周期

复用项目文件／对象版本、现有来源冻结与 CAS，不建立另一套知识数据库。提议在既有项目元数据中记录最小来源描述：project、source identity、冻结版本／digest、批准正文区间、适用范围、批准者／明确动作证据、状态、替代关系和冲突引用。这里是逻辑合同，**不是声称现有 MemoryVersion 已有这些字段或 UI**。

生命周期：未批准来源 → 用户明确选择和预览 → 冻结候选 → 用户批准具体版本 → 可查询；新修改产生新候选，不自动继承批准。候选可驳回；已批准版本可明确 supersede／revoke／archive。创建候选也不自动启动模型整理；用户要求整理才由 frontdesk 或既有 Worker 做内容任务，结果仍需独立知识批准。

- 来源引用稳定到项目＋对象／文件版本＋digest＋区间；readRef 只是本回合读取票据。过期重新以版本来源签发，绝不悄悄改读当前磁盘。
- 批准知识仅表示用户希望按该版本检索，不保证内容永真。冻结字节不可得时返回 unavailable，不能用 MemoryVersion 当前文件摘要伪称旧版本归档。
- CAS：用户预览 V1 后文件变成 V2，批准必须失败并重新展示；不是“批准最新”。多来源快照需验证来源集合和各版本，不能仅相信 index 的修改时间。
- 冲突：新旧说法／不同来源显式关联；既不以最新时间、角色地位、搜索排名也不以“已批准”自动裁定事实真伪。读者同时得到相关冲突版本和适用范围；确需决定时让用户在具体任务中选择或保留不确定。
- 撤销：立即停止新自动推荐／读取授予，旧回执留审计。历史 Pi 消息已见正文不能“撤回模型记忆”；UI 如实说明，提供用户显式新会话／原生压缩选择，不保证遗忘。删除本地副本按现有数据保留政策，不能顺带删 Work 证据。
- 源删除／改名不等于删除冻结来源；冻结版本存在则显示原来源已变更，缺失则如实阻断需要该证据的结论。跨项目复用必须明确选择版本与范围，不能由于磁盘可读自动带入。

历史 Plan Tree 和 Work 汇总默认标为历史证据，不自动批准整个根索引或 topics。迁移不得重写历史为“用户已认可”。普通文件编辑保存也不自动进入批准知识集合。

## 7. 检索、交付与预算接口

采用现有显式查询路线：controller 的 `nozeli_inspect_work` 记忆查询分支／当前只读来源工具定位版本，ContextReader 分页；后续 context cutover 可收敛入口，但不能借 `nozeli_handoff(reason="@read …")` 启动后台模型。返回仅任务匹配的有界元数据，用户／模型选择正文区间；不预装 recent、全部索引或全项目任务表。检索可继续使用现有本地词项算法，不需要模型 embedding 或新引擎。零命中不等于项目没有历史。

宿主到 Pi 逻辑合同：固定角色契约＋工具声明属于可信规则；技能 catalog 独立计量；项目知识／材料／Work 来源是有标签数据；当前 Work 控制是单个 ephemeral context 投影。读取返回 source/version/range/total/continuation/完整性和冲突状态；工具返回之后仍由 Pi 维护原生 tool result，不手动裁剪配对。生产者新增任何资源／事件字段必须同时更新 native 消费入口、准入校验和详情证据；未知类型拒绝，不静默丢弃。

沿 context 设计的 allow/deny：普通 user 原文一次，明确选择的材料一次事务，原任务首次交接；已有 Pi 同线程历史、UI 错误、未发送批注、其他角色讨论和长期知识不自动加入。事件技能的可信规则只能固定配置或已核验事件规则通道，不能以长 user 前缀交付；同事件不得同时走 native `/skill` 展开和宿主拼接。

预算以 context 设计为唯一合同：4 KiB 请求投影、64 KiB run、256 KiB 原生压缩代次是待校准建议，不是本文新增容量保证。知识正文／技能按需正文如由宿主交付，应进入共享持久内容账；固定契约和目录独立计量，不能通过技能包装绕开累计额度。原生 read／skill command 路线若不能观察并限制宿主来源字节，就不能宣称已实现同一共享额度；迁移验收必须覆盖该消费路径。附图独立限额；字节不是 token。

优先省略可选推荐／知识片段，保留来源状态、撤销、范围和未知效果。必要控制无法完整容纳则阻断整个模型请求；显式材料超额可见分页／暂停，不静默摘要。分页完整性由已读区间并集确定；readRef complete=false 只是本页状态。新 job 名或换技能不能刷新 run／代次额度；Pi 压缩失败不靠重新调用模型骗取额度。

详情 UI（本地、零模型调用）显示：固定契约／技能目录版本、按需加载正文来源、知识批准／冲突／撤销状态、准备内容与 native hook 观测的区别、未交付区间与省略原因。仅在有原生 entry 证据时标记已记录，回答成功不等于交付或当前可见；compaction 后旧 receipt 不能证明正文仍在上下文。默认日志不复制正文、私人路径或密钥。

## 8. 强制边界不能依赖技能

宿主每个相关工具调用重新验证项目／Work／owner／revision、暂停／撤销／deviation gate、审批作用域、CAS、候选发布及效果去重。报告技能被禁用、模型未读 task-boundary、旧压缩摘要含错误批准，都不能绕过这些门。知识材料里的“忽略限制”只是数据。宿主不得把未知已启动效果当未执行并重试；确定性程序恢复与用户请求诊断区别于自动 maintenance 模型调用。

可由程序保证的事实与只能辅助的语义清楚分开：宿主能拒绝旧 revision、未授权高风险效果、错误文件基线及 held Work；不能仅凭短任务摘要宣称自动识别所有越界内容。保留 Worker 语义偏离报告和明确用户决策，不新造“知识批准即执行许可”捷径。

## 9. 迁移顺序与责任边界

1. **当前 context cutover 范围**：host/controller owner 删除 event skill 的 user 拼接、历史补发、重复 Worker 锚点和错误诊断扇出；runtime/Pi owner 实现单槽投影及 native 证据；UI owner 展示真实来源。本文不直接编辑这些文件。角色长文里与切换相冲突的自动维修／无限读取描述须由集成方同步更新，不能让旧 prompt 抵消新合同。
2. **单独批准后的角色瘦身**：将 memory.md 明确标为版本化角色契约；抽出重复详细教程到上述现有技能；保留强制职责和工具门。所有角色先有可读取的目录入口，再停止正文预装；不能只删技能却让 frontdesk/orchestrator 没有消费者。
3. **单独批准后的原生技能迁移**：固定 SDK 能力验证、精确 resource allowlist、隔离角色资源、命名碰撞／撤销／reload 验证；一次切换所有生产者和消费者，删除旧 role skill 正文注入／重复 loader，不保留双轨默认。
4. **单独批准后的知识控制**：在现有来源／版本／CAS 上提供预览、明确批准、冲突、替代、撤销、可见分页检索；旧资料先保持未批准历史身份，用户逐项选择，绝不批量隐式导入。
5. **用户迁移控制**：显示旧 Work 固定绑定与新默认差异，用户决定是否迁移旧 Work；旧 native journal、报告、材料、未发送草稿不改写。无私人源导入、模型设置改写或真实个人会话测试。

本设计不要求在本轮实现步骤 2–4。父集成代理负责本轮最终 context 验证；本文作者只做文档／源码审阅，不运行 build、tests、formatter 或模型请求。

## 10. 设计验收与后续实施门

下表是可执行验收要求，**未在本文工作中运行**；context 原设计第 13 节全部继续成立，不能用本表替代／缩减。

| 场景 | 必须满足 |
| --- | --- |
| 三角色冷启动／普通闲聊 | 角色不变；固定契约和短技能目录可量化；零项目知识正文、零前台可变投影；原用户文本逐字一次 |
| 实际十份技能逐一调用 | catalog 与真实包／版本一致；角色授予过滤；无虚构工具；正文按需且无 event/user 双份 |
| Worker 禁用可选技能 | 发布／范围／撤销等宿主门不失效；不因缺技能伪装任务成功 |
| hide 与 revoke | 隐藏仅影响建议；撤销后命令／读取均不能新加载，历史不伪删；用户明确知道两者差别 |
| scope 与 reload | 用户／祖先／其他角色包不自动导入；collision 可见拒绝；busy 不热换；空闲刷新无安装／网络／模型副作用 |
| 现有 Work 与新默认 | 老绑定不悄悄更新；显式迁移记录版本；撤销即时门控，resume 不复活旧授权 |
| 知识批准 V1，磁盘变 V2 | CAS 拒绝旧预览批准；读冻结 V1 或明确不可得，不回退 V2 |
| Work 报告／Plan Tree | 接受结果不自动批准知识；历史不变新规则；无自动总结／学习／私人导入 |
| 知识冲突、撤销、删除 | 双方来源与范围可查；不自动选赢家；新检索按有效状态；历史暴露不可逆如实说明 |
| 长知识、多技能、多页材料 | 共享预算覆盖所有宿主正文路线；范围并集证明通读；必要控制超额整请求阻断；不改 Pi tool 配对 |
| 查看目录／来源／详情 | 零新增模型调用；准备、native 观测、entry 与 provider 证据不混称 |
| 合成 prompt injection／过期批准 | 知识／技能元数据不扩权；每次效果准入核验实际绑定；无已完成／未知效果重放 |

设计接受条件：同意四层来源、三个最小契约、实际技能目录、用户明确知识批准和原生兼容性门；保持实现授权分离。未完成的实现验证不是设计宣称成功的依据。冻结后的 combined context patch 需独立检查生产者／消费者、budget 和 journal 证据后才可给运行正确性结论。

独立 reviewer 已核对现有角色／十份技能目录、固定 Pi resource／skills 源码和上下文合同，设计 verdict 为通过：无阻断接受提案的源码矛盾或职责边界问题。重点保留最终资源过滤、真实撤销入口、原生 skill 正文共享预算与受控刷新作为未来迁移门；此结论不覆盖正在实施的 context cutover combined patch，不代表记忆或 skill 系统已经上线。
