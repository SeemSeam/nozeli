# 对话区 Agent 状态与模型：交互 Demo 与实施方案

> 2026-11-06 用户追加授权提交与安装：UI提交 `a772582`（包含父提交 `e4dd289`），本机 current=`2026-11-06T06-50-32-215Z` 已激活，保留上一版回退；实际安装ELF验证及快照边界见[当前状态](status.md)。下文“未安装”保留当时设计／源码取证语境，不代表当前安装指针。未推送或发布。

## 源码实施状态（2026-11-06，未安装）

简洁方案已接入：Agent 状态为稳定紧凑行，会话正文与上下文／技术诊断分层，资源和默认模型用短表单行，故障页同层往返；本机恢复的技术 JSON 按需查看。薄 `management-presentation.mjs/.css` 已由状态、会话与设置等多个实际页面消费，不承接业务 store、额度、调度或审核决定。

Linux 隔离真实界面已检查双角色状态、展开态刷新保持、资源保存、三角色模型、会话诊断及空故障返回焦点；真实设置 smoke 30 项及定向回归通过。当前异常／未保存／待生效仍直显，不据健康空态签收全部动态状态。证据与限制见[实施记录](testing.md#2026-11-06-共用局部窗口与简洁管理页源码未安装)。本轮未安装、提交或发布；下节保留实施前设计复核及其历史安装截图边界。


## 简洁状态与管理页设计（2026-11-06，未实施）

本节是用户“Agent 状态页太丑太繁琐，并审查类似页面”的独立复核结果，优先于下方旧 Demo 的信息布局与命名。**设计完成不等于 UI 已优化或已安装。** 不改业务额度、权限、排队、会话恢复或审核保护；不将管理模态页接入非模态讨论的 `local-window`。下方旧实现和历史证据保留原边界。

### A. 证据与覆盖

父任务实际浏览安装版 `2026-11-06T00-54-32-789Z`，隔离合成 profile／项目、本机脚本源、真实空闲前台和主控；未发送问题或执行压缩／停止／恢复等动作。完整浏览记录 `/tmp/nozeli-status-design-FV7Dip/audit.md`，截图 `01-all-agents.png` 至 `10-local-recovery.png` 同目录。本轮 reviewer 完整读取记录、查看十图并核对当前源码，未另行运行安装程序。父任务报告最终 jobs=[]、正常 exit0，不把此转述扩为 reviewer 重新验证。用户原图路径 `local://pasted-image-30cf3c79114bd761.png` 在本会话不可读取，文件搜索亦未找到；执行中主控的反馈按用户／父任务事实保留，不声称看过原图像素。

| 页面／分支 | 证据范围 | 设计决定 |
| --- | --- | --- |
| P0 全部 Agent | 01 实际空闲双角色；`collaboration-status.mjs:58–92`、CSS:21–41 | 重做为紧凑列表；删除重复身份、空计时行、全宽模型按钮、全零汇总和常驻计时说明；全部角色仍完整可达 |
| P1 会话管理 | 03 实际空闲；`session-model-controls.mjs:49–95` | 普通状态／操作与诊断分层；JSON、日志按需；六按钮拆为明确入口，不改原命令 |
| P1 Agent 资源 | 08 实际两额度；`settings-agents.mjs:2–37` | 两个表单行、各自作用域和占用；精简原生进程／Work长说明，不改计数 |
| P1 默认模型 | 07 实际单模型；`provider-settings.mjs:40–50,86–100,136–170` | 三角色同一紧凑表单；统一角色名；待生效／失败直接呈现 |
| P2 单 Agent 模型 | 02 实际单模型；`collaboration-status.mjs:118–126` | 当前与下次分开、清楚标注继承；按条件出现撤销／恢复默认，保留搜索与来源区分 |
| P2 服务故障 | 05 实际空故障／叠模态；`managed-service-faults.mjs:17–59` | 空态去空选择器；同一层往返，非空原因与处理动作直显 |
| P2 设置框架／外观 | 06 实际；`settings-panel.mjs/.css`、`settings-appearance.mjs:60–70` | 保留分组，移除标题副解释与重复作用域说明；不靠缩小字体压缩 |
| 连接与历史 | 04 实际就绪空分支；`managed-agent-panel.mjs:166–253,333–365` | 保留轻量首屏；统一角色与故障入口，非空恢复／历史仍待真实浏览 |
| AI 连接与账号 | 09 实际单源；`provider-settings.mjs` | 保留源卡、凭据安全和模型披露；只统一短文案与错误层级，不重做成大卡 |
| 本机恢复 | 10 实际空分支；`app.mjs:1959–2014` | 空态维持；非空改项目／文件／保留状态列表，JSON按需，恢复动作不弱化确认 |
| 任务详情／保留进展 | 仅源码：`managed-work-overview.mjs:55–165`、`managed-work-progress.mjs:123–160`、panel:640–660 | 已有按需诊断应复用；合并重复标题／无报告解释，必需决定和未发送稿提示留首屏；不全盘推倒 |
| 项目修复／历史只读／过期／很多 Worker | 仅源码：status:22–50,77–110；panel:538–539 | 未解决异常不能藏入折叠；全量分页与稳定身份保持，旧快照明确标记；真实动态状态未验 |
| 审核讨论的状态／详情 | 本轮仅沿前轮已读 `managed-review.mjs:65–81,218–250` | 同样减少重复说明；当前暂停、意见保存失败、确切审核版本仍直接可见，不动原 Worker／采用结束语义 |

源码与已安装资源可能不同，不能用源码推定截图中的行为。例如服务故障 `syncChooser` 已有少于两项隐藏规则，但实际空态截图仍见空选择器；实施须核对初次 open／clear／refresh 的完整生命周期和实际构建，不能仅更换文案宣称修好。

### B. 统一语言与信息优先级

| 对象／事实 | 普通界面用语 | 不得误表达 |
| --- | --- | --- |
| frontdesk／orchestrator／worker | 前台／主控／工作助手；具体实例“工作助手 · 任务名”，重名时附稳定短编号 | 不显示“前台 · 前台”、Orchestrator／编排混用，不用 F/O/W 代替可读角色；内部角色值与历史署名原件不改 |
| active / idle / sleeping | 处理中／待命／休眠；真实工具活动可作简短副行 | 待命不等于休眠；无状态证据不等于空闲 |
| queued / capacity | 排队中；已知时“等待名额 · 另有 N 条排队” | 已接收不等于开始；没有可信队位不编造“第 N 位” |
| paused / review / closing / ended | 已暂停／待审阅／收尾中／已结束 | 暂停后续不伪装停止当前回合；收尾中不写“已结束” |
| stale / unknown | 状态待核实；“上次更新 HH:mm”作为紧邻副行 | 不保留醒目的绿色运行标记而只在 tooltip 告知过期 |
| failures | 连接失败／执行失败／保存受阻／模型切换失败，按真实类别 | 不把所有错误叫“连接失败”或“正在恢复” |
| effective / desired / recorded model | 当前模型／下次使用／上次使用；下次值有“待生效”或“切换失败” | 保存选择不冒充生效，休眠时不把上次模型叫当前模型 |
| project Work / global process quota | 项目开放任务上限／全局会话进程上限 | 不叫“同时运行任务数”；空闲进程和暂停／待审阅／收尾任务仍按原规则计入 |
| actions | 刷新、查看报告、查看进展、压缩上下文、重新加载资源、停止当前回合、保存、管理连接 | “停止当前回合”不能缩成“结束”；重读状态不是重试执行；凭据动作仍写明对象 |

“Agent 状态”“Agent 资源”保留作为可识别功能标题；列表内说可读角色。模型／来源名称、Pi 等产品专名在需要识别来源时保留，不把它们当普通页标题的实现说明。无法解析的未知业务值显示“状态待核实”，原值留诊断，不做关键词正则猜测。

层级固定为：①主体＋当前状态＋真实可执行动作；②有意义的模型／耗时／范围；③用户按需打开的原理、时间定义、原生 ID、日志与 JSON。异常、旧快照、排队、未保存、模型待生效／切换失败属于①／②，不因技术详情折叠而消失。具体执行失败原因用一句话且可完整展开，不截断掉否定词或风险。

零值原则不是全局隐藏数字：健康概览不显示“活跃0／排队0／待审0／异常0”；配额字段的 `0/上限`、真实零耗时、批次结果中的 0 仍可能有意义，应保留。未知时间不占独立行，技术详情可说明“未记录”；无模型事实显示“模型待核实”或“尚未选择”，不能用空白掩盖配置阻断。

### C. 两处宽窄低保真稿

以下四格是拟议布局，不是实测界面。样例模型 A/B 为占位名称，运行状态只用于设计。宽窗状态页上限约 760 CSS px，会话管理约 560；窄窗保持 12px 边距。实际字号继承全局设置，正文不低于现有界面字号，辅助文字不小于 12px；点击目标至少 32px，窄屏／触控至少 44px。宽列表一行健康状态，窄列表两行；异常允许增高，不硬截断。长任务名与模型换行，完整值可键盘展开，不依赖悬停。

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 960 670" fill="none">
<g stroke="var(--border)"><rect x="8" y="30" width="590" height="270" rx="8"/><rect x="620" y="30" width="330" height="270" rx="8"/><rect x="8" y="350" width="590" height="305" rx="8"/><rect x="620" y="350" width="330" height="305" rx="8"/><path d="M24 82H580M24 132H580M24 184H580M636 82H934M636 156H934M24 405H580M636 405H934"/></g>
<g fill="currentColor" font-family="sans-serif" font-size="14">
<text x="12" y="20">Agent 状态 · 宽</text><text x="624" y="20">Agent 状态 · 窄</text>
<text x="24" y="60" font-size="18">Agent 状态</text><text x="470" y="60">刷新　关闭</text>
<text x="24" y="112">前台　待命</text><text x="305" y="112">模型 A ▾</text><text x="510" y="112">详情</text>
<text x="24" y="164">主控　处理中 · 2分10秒</text><text x="305" y="164">模型 A ▾</text><text x="510" y="164">详情</text>
<text x="24" y="214">工作助手 · 核对引用　排队中</text><text x="24" y="245">等待名额</text><text x="305" y="214">模型 B ▾</text><text x="510" y="214">详情</text>
<text x="24" y="280">▸ 状态说明</text>
<text x="636" y="60" font-size="18">Agent 状态</text><text x="838" y="60">刷新　关闭</text>
<text x="636" y="108">前台　待命</text><text x="636" y="138">模型 A ▾</text><text x="890" y="138">详情</text>
<text x="636" y="184">主控　处理中 · 2分10秒</text><text x="636" y="214">模型 A ▾</text><text x="890" y="214">详情</text><text x="636" y="280">▸ 状态说明</text>
<text x="12" y="336">会话管理 · 宽</text><text x="624" y="336">会话管理 · 窄</text>
<text x="24" y="382" font-size="18">会话管理 · 前台</text><text x="470" y="382">刷新　关闭</text>
<text x="24" y="437">待命　　模型 A</text><text x="24" y="472">压缩上下文　　重新加载资源</text>
<text x="24" y="515">连接与历史 →</text><text x="24" y="550">▸ 上下文详情</text><text x="24" y="585">▸ 技术诊断</text>
<text x="636" y="382" font-size="18">会话管理 · 前台</text><text x="636" y="437">待命　模型 A</text>
<text x="636" y="478">压缩上下文</text><text x="788" y="478">重新加载资源</text>
<text x="636" y="520">连接与历史 →</text><text x="636" y="553">▸ 上下文详情</text><text x="636" y="586">▸ 技术诊断</text><text x="800" y="630">刷新　关闭</text>
</g></svg>
```

Agent 页：标题只出现一次。健康行不加独立圆角卡，行间细分隔；身份与状态同组，模型是紧凑文本按钮，不占全行。时间附在进行中的状态后，无有效计时就不渲染该节点。少量角色不留空搜索栏；超过 8 个提供“查找任务或助手”，默认仍显示全部，筛选明确显示“显示 X/Y”，不重新引入隐藏其他 Worker 的“…”限制。沿现有业务优先级，键盘聚焦期间不得因时钟更新不断重排。主对话底部仍保留全部角色；W1 标签替换为“工作助手 1”等可读名称，不改变 target。

异常行在本行下一行显示原因和真实入口，未解决项目修复在列表前用一条“有 N 项处理受阻　查看”加概要；无需再同时复制顶部计数和整套错误卡。主动展开可读原修复记录。仅健康／全零时隐藏修复汇总，但“状态说明”内保留“查看修复记录”入口；有历史修复时显示普通折叠入口。首次读取失败不能呈现健康空态。过期提示置标题下方，旧行同时标“上次状态”，敏感动作按原 capability 禁用。

会话页：首屏只显示当前会话状态和适用动作。空闲不显示禁用的“停止当前回合”；忙时显示“停止当前回合”，压缩／重新加载暂不可用且短说明“当前回合结束后可用”；未支持的能力不铺按钮，能力详情可查。读失败／只读／会话变化直接提示并保留刷新或连接入口，不把不可用操作静默消失成空白。技术诊断默认收起，展开后再展示只读 JSON／日志；上下文详情是独立入口，保留准备／捕获／服务端回执三层证据，不简化成“模型已读”。

压缩确认：“压缩当前上下文？原记录保留，未发送草稿不会提交。”重新加载确认：“重新加载此会话资源？不会重放任务或发送草稿。”停止确认保留完整短风险：“停止当前回合？已完成修改保留；排队输入不取消，任务不结束。”确认后再次校验原 owner／job／revision，刷新失败不重发命令。确认不是第二个永久管理层。

### D. 逐页字段、文案和默认展开策略

| 当前字段／表述 | 新首屏／动作 | 按需内容与默认状态 |
| --- | --- | --- |
| 前台 · 前台；Orchestrator · 主控 | 前台；主控 | 真实身份 ID 进“技术诊断”，默认收起 |
| 每角色“本轮未记录”独立行 | 无有效时间则不占位；有值“处理中 · 2分10秒” | “计时说明”：经过时间不是模型思考／CPU用时，沿原 timingDisplay，不重算时间 |
| 全零汇总、最近同步、长计时解释 | 健康不显示；过期显示“状态待核实 · 上次更新…” | 健康更新时间进状态说明，非零异常仍直接可见 |
| 全宽模型按钮／两份相同当前与下一回合 | 紧凑模型按钮；相同且无待切换时只显示当前 | 不同值、待生效或失败必须并列“当前 A／下次 B · 待生效”；失败原因就近 |
| 会话管理长免责声明＋JSON＋日志 | 当前状态＋适用操作 | 上下文详情／技术诊断各自收起；风险移到对应动作确认，不删除底层保护 |
| 全局存活总 Agent 数／当前项目 Worker 数 | 全局会话进程上限 [N]，项目开放任务上限 [N] | 每行一次作用域：“所有项目”“当前项目：名称”；细则默认收起 |
| 大段额度说明 | 第一行提示“空闲会话也占用”；第二行“暂停、待审阅、收尾中的任务仍占用” | 预留／退出确认／休眠机制进“如何计数”；占用明细默认收起，资源阻塞或退出未确认直接提示 |
| 原生终端未发送输入受保护 | 删除过时 Agent 原生终端说法 | Pi 会话／普通用户终端不同；只写现有可证安全边界，不承诺未核实恢复能力 |
| 前台·最快／编排·强模型／Worker·中等以上 | 前台／主控／工作助手 三行，各行模型＋适用的思考档位 | 不按角色暗示模型性能等级；选型建议移帮助，不作为标签 |
| 配置 Pi 源／保存三角色默认 | 管理连接／保存默认模型 | 首屏一句“所有项目；运行中的回合不变”，生效细则默认收起 |
| 目录、权限、生效长说明 | 模型名称＋来源；“可列出不代表可调用”一条就近提示 | 认证／目录来源细则进模型说明；未知档位显示“能力待核实”，不编造选项 |
| 原生默认 | 不覆盖会话选择 | 说明清除全局覆盖并取消对应待切换；不暗示固定某个模型，不改 clear 语义 |
| 默认模型保存结果长串 Agent→desired/effective | “已保存；N 个待生效／N 个失败”＋失败逐项原因 | 已成功明细收起；失败／pending 行可直接展开当前和目标，零值不机械堆叠 |
| 服务故障空选择器 | “暂无服务故障记录。”＋刷新／返回 | 不是“服务一切正常”；读取失败与无记录分开，多条才提供选择／列表 |
| 应用偏好与 Nozeli 私有 Pi | 删除副标题，仅“设置” | 设置导航保留通用／当前项目分组；页面内不重复相同分组标题 |
| 外观两段长影响范围 | “仅调整界面；正文与对话另设字号。” | “影响范围”默认收起，保留 PDF／扫描件／用户网页不改色等准确细则 |

资源保存保持两字段现有事务语义，不拆成两个可能部分成功的隐式自动保存；降低额度不得低于现占用，冲突就近报错并保留输入，不能为 UX 允许强杀。项目切换保留原项目未保存值并禁止写入新项目。模型表单同样保留原三角色保存接口、revision、编辑中不替换原生选择器、迟到回执与新输入保护。思考档位仅在能力支持时可选；旧值不可用仍可见保留，不悄悄清空。

单 Agent 模型页正常默认显示当前模型、搜索与列表、取消／保存；“撤销待切换”仅有待切换时出现，“使用角色默认”仅有覆盖时出现。休眠显示上次使用与下次选择；无可选项给出具体缺失原因和管理连接入口，不显示空列表成功态。模型来源可读名称保留；同名不同来源不能合并。大目录搜索保留原选择与焦点，不新增分页协议来掩盖遗漏。

连接与历史维持紧凑；服务故障入口改“服务故障与记录”。从连接页进入故障页关闭／暂停原模态显示，保存原页面局部状态，返回恢复原入口焦点，不再同时叠两层管理模态和两层遮罩。复用现有 dialog 生命周期与原生 WCV 遮挡路径，不能自行移除底层 inert。与恢复确认的短暂二次确认区分。

### E. 相似页面的代码审查结论（尚未真实场景补验）

- **任务详情**：已有任务标题、状态、成果入口、必需决定、诊断分层，保持 `requiredSection` 在首屏。减少“尚无成果报告”加同义解释两层；排队只说“排队中”，已知占位任务列表按需但“等待名额”直显；历史报告必须标实际版本关系，无法核实不当当前成果。`onReport` 与 `onProgress` 不同时高亮为主动作：有可用当前报告主动作查看报告，失败／未交付主动作查看进展。结束／取消仍独立危险动作，不藏到技术诊断。现行 `waitingOn.slice(0,8)` 不得呈现为完整清单；注明余项并提供完整既有入口或如实标局部。
- **未发送后台稿**：panel 目前把只读后台稿放入 technicalSections。首屏应显“有未发送内容　查看”，正文可按需，不把数据丢失风险藏进诊断；仍不得自动转给前台或发送。
- **保留进展**：保留“当前情况＋真实动作＋原文／报告＋诊断”结构，去外层和内部重复“保留的进展”标题、去重复返回按钮。补充失败、当前暂停／不可继续直接显示；报告／文件缺失直接说明。只合并含义相同的展示，不去改 next.notices 或历史正文，不新增泛化“恢复”按钮。
- **非空服务故障**：首行原因类别、影响项目／任务数量，下一行实际可用动作或禁用原因；不可用原因不能只在 title。故障原件／批次／原生 ID 折叠。当前 `paintDetails` 的 projectId 与批次行 ID 改为已有项目名，重名时附可展开身份；若 DTO 无名称用“项目名称未提供”，ID 按需，不擅自跨项目加载凭据。继续请求只称“已接收继续”，逐项显示等待／仍受阻，不冒充已恢复成功；批次结果完整可分页。
- **项目修复**：修复标题＋作用对象＋当前阻塞／可执行动作可见；binding JSON、Job、Work版本、尝试计数按需。同一对象的一项故障不复制成多份大卡；不同故障／代次不能按相似文本合并。retryMode=finalize 标“完成收尾”，repair 标“重试修复”；只依据宿主 capability，不因按钮省略就自动重试。
- **非空本机恢复**：列表显示项目／文件、保留时间（有则显示）、“仅本机保留／待核查”及查看／导出；无需每条都重说“不自动重放”。“本机保留不表示已写回项目”保留页首。原生 JSON 在技术详情，正文仍可读；完整导出入口不因大记录／格式未知而消失。恢复到项目独立有风险动作，保留停稳／保存／确切记录核验与确认。当前“查看并导出保留报告”有下载副作用，不可仅改叫“查看”；若只做信息改造保持明确动作名称，不偷换行为。
- **历史只读／断连／过期**：顶部一次明确只读／上次快照，原原因邻近受限操作；不处处重复“不发送”，但发送禁用和恢复准入仍由程序保障。状态从过期恢复时按权威回执更新，不用 UI 定时器推定恢复；历史模型不被当前设置覆盖。
- **很多工作助手**：全量身份保留，稳定顺序／列表滚动；搜索不改变发送目标。模型弹窗更新不得丢选择／焦点。主控和各任务不可汇成不可区分的“工作助手”一项；不建立新角色链或后端限额。
- **审核讨论**：当前暂停／发送不可用原因留一个近输入状态区，意见保存错误紧邻草稿；报告版本／采用与收尾仍在底部。历史过程／版本细节按需，不删除旧对话、不挪采用到聊天、不改变 token/CAS。

### F. 最小共用模式与迁移边界

新增薄展示模块 `management-presentation.mjs/.css`，不是新业务 store／GodDialog／通用表单框架。采用现有 DOM、原生 details、状态 token 和设置布局；只在两个以上调用方确有重复时提取，页面自行组合。拟议接口：

```js
statusLine({key, subject, state, secondary, notices, actions}) // {node, update, dispose}
fieldRow({label, control, scope, hint, error})                // 原 input/select 节点
disclosure({key, label, content, open: false})               // 按身份保留展开状态
emptyState({message, action})
actionNotice({kind, text, reason, action})
```

state 只接 `{label,tone,stale}` 等已投影事实，组件不据 busy／时间／文字计算业务状态；notices 数组是必须可见的阻塞／未保存／pending信息，不能放进默认折叠槽。actions 用原回调与 enabled/reason，组件不调用 IPC、不生成 requestKey、不决定自动重试。scope 仅一次可读提示，不建嵌套 scope 卡。disclosure 的内容节点不克隆，保持输入、选择、阅读位置；日志按需展示不是取消安全状态刷新。共用角色显示映射置同模块，API key、内部 role 值、消息 speaker 原件不改。

页面仍拥有 dialog 生命周期、当前项目／target／owner、查询与分页、pending、CAS、错误回执和未保存状态。技术诊断保留现有安全 DTO，不 stringify 新的 provider payload，不收集密钥。用 `textContent` 展示未知原因，不能将错误原文作为 HTML。ARIA status 只播关键变化，秒级计时不持续播报；Tab／Escape／返回焦点沿当前模态语义。

迁移顺序：
1. `collaboration-status.mjs/.css` 先迁移 rowNode／paint／paintClock／paintFreshness／paintRepairs，薄组件与两种宽度同时验证；删除旧纵向大卡 CSS、全零文案分支和重复 role 拼接，保留 timing／分页／model.set 全部保护。模型选择页同步采用术语但不改变选择状态机。
2. `session-model-controls.mjs` 与 `workspace-conversation-controls.css` 改普通操作区、技术披露和短风险；删除常驻 JSON／日志占位与大段 note，保留 renderContextDetails 的证据分层、same／serial／owner/job、确认及去重。管理诊断不是会话终端。
3. `settings-agents.mjs`、`provider-settings.mjs` 采用 fieldRow，删除重复 card／scope 标题、过时终端文字、角色性能分级文案；保留保存事务与能力守卫。`settings-panel.mjs/.css`、`settings-appearance.mjs` 与现有 `index.html` 设置标题只改展示，保留导航／身份／设置生效机制。
4. `managed-service-faults.mjs` 和 panel 连接入口完成单层导航、空态／错误分离及非空行；task overview/progress、app 本机恢复按 E 节定向收拢；AI 源、连接历史和恢复空态不重建。审核讨论仅改重复状态文案／披露，不碰上轮未实施拖动系统。
5. 同步所有相同管理入口的角色／动作词、可访问名称和用户文档，移除旧布局 CSS／重复组件和旧纯模板断言，不留“新精简版／旧详细版”并行开关。无业务数据库迁移、无旧消息清洗；必要展开偏好仅为 view state，以项目／对象身份隔离。

### G. 实际界面验收门

实施后先在隔离合成资料、真实 Electron 产品内容面验证；获当轮授权后再测实际安装程序，记录 binary/appRoot／资源摘要。禁止为截图调用付费模型、伪造工作状态或使用日常 profile。只读合成 DTO 可以验证边界版式，但必须标“组件证据”；动态业务签收需要真实宿主／队列／文件和隔离本机脚本 Provider 生成相应状态，不能注入假 busy 替代运行。

- 截图对照沿父记录十入口，深／浅主题、实际内容宽 320/390/800/桌面、短窗 480高、界面最大字号和 200% 缩放。健康双角色不再四行大卡，会话空闲无常驻 JSON／日志；相同数据同字号比较，不以缩字、裁掉内容或隐藏异常减少高度。窄窗无横向正文溢出，标题、关闭、错误和操作可达，按钮不压住模型名。
- 每页首屏明确主体／状态／模型（适用时）／动作；正常空态无零值墙／空选择器；加载、无记录、读取失败和旧快照四种状态分开。全量工作助手可达，长中文任务名、同名模型不同来源、长错误和缺失字段均不串身份。
- 真正动态矩阵：执行中、工具／压缩、排队、暂停后续、待审阅、收尾、连接失败、过期、未知效果、模型待生效→生效／失败、空目录／大目录、非空修复／故障批次、非空恢复、历史只读与重名任务。逐项标证据类型；未覆盖就保持未验，不把空闲十页扩为全部通过。
- 实际鼠标／键盘打开披露、刷新、选择、返回；focus-visible、读屏名称、Tab循环、Escape关闭当前层并恢复触发点。状态刷新不收起详情、不替换正编辑 input/select、不跳历史滚动；存储失败／晚到回执／切项目保留未保存值并阻止写错对象。模拟屏幕截图不代替交互。
- 浏览／展开／刷新前后核对模型请求数、job／Work／队列、草稿、线程不新增或重放。停止当前回合保留已完成效果和排队输入且 Work 不结束；压缩／重新加载只在真实 capability 允许时执行，确认绑定对象变化要拒绝。UI 缩短不取消确认和宿主检查。
- 资源边界确认全局空闲进程占用与项目暂停／待审／收尾计数不变；降额不足拒绝并保留输入。模型确认当前≠下次、目录≠推理授权、思考档位来自实际能力；默认保存部分应用／pending／失败可区分。恢复记录查看／导出不写项目，明确恢复仍经过原保护；审核采用绑定确切版本。

本轮只完成证据审阅、设计和文档修改。Linux 截图来自父任务既述安装版；Windows/macOS、窄屏／浅色动态矩阵、真实触控、付费服务与上述未浏览分支均未验。本节不是产品实现／安装验收记录。

Date: 2026-11-01
Status: 独立离线交互Demo与设计已落盘并通过实际浏览器测试，待用户审阅；生产接入状态另见§10–11。任务／自动修复协同设计及9场景伴随页见[协同合同](agent-task-repair-lifecycle-design.md)，不代表新生产维修策略已实施。

2026-11-04 用户纠正后的生产合同优先于下文旧 Demo：输入区下方直接列出前台、主控与全部工作 Agent，不再以四个为限、不使用“…”折叠其他 Worker；宿主分页完整读取后显示，窄窗自然换行。角色显示“前台／主控／W1…Wn”，每项使用实心彩色小方块＋可见状态文字：绿色正在处理、黄色排队／等待／待审查、红色失败、灰色待命／休眠／已结束；过期或未知显示灰色虚线及“待核实”，不以颜色单独传达含义。各 Agent 原模型入口、稳定身份、草稿与不唤醒约束保持；“状态详情”只承载计时／诊断／修复，不藏其他 Agent。当前源码已实现并以真实 Electron 组件验证，未安装，旧离线 Demo 不作为该版生产界面证据。

2026-11-04 后续用户确认：同一任务的主控安排→Worker真实多轮→主控收尾必须位于同一个外层block，内部保留各角色与版本，不能只把三种卡分别排序。归属只认稳定Work／原提交链，不按名称、时间相邻或正文猜测；未派工的原提交获得Work后保持同一block身份，普通前台问答保持独立。原生model_change／thinking_level_change／session_info是会话元数据，不是Worker执行回合；冷索引／旧记录尚未分类时也不得因target指向Work而捏造“第?轮”。元数据原件保留，真实未绑定消息／失败可按原件读取，不删除历史或把未知状态改为成功。收尾按整个任务的执行记录边界排列，而非Worker分组起点加小数；旧版本和分页不能附带后来的收尾。此为本轮修复合同，实施／实际验证另记，不构成安装或发布授权。

2026-11-04 用户再确认：后台交给Worker的任务说明署名“主控”，不能因为LLM原生协议使用user输入就展示为“你”。显示署名依据宿主生成的initial／supplement Worker job身份及精确目标，不能按正文中的“原始用户请求”猜测。原用户提交仍署名“你”，历史真实manual用户输入不改；原生speaker／原文／job账本不重写。引用交接消息同样显示“回复 主控”，不把该交接伪装成第二条用户后台提交。

## 1. 目标与边界

先确定读者在对话区需要看到什么，再映射当前 Nozeli／Pi GUI／Pi 的事实与已有接口；只有确认缺失的底层事实才补接口。保留统一工作面，不先扩建调度框架或新增后台模型轮询。

Demo：`apps/desktop/demos/agent-status/index.html`，同目录 `style.css`、`app.mjs`。可直接用浏览器打开 HTML；也可在仓库根运行 `python3 -m http.server 48763 --bind 127.0.0.1 --directory apps/desktop/demos/agent-status`，访问 `http://127.0.0.1:48763/`。Python只作开发预览服务，不是产品用户前置依赖。

任务／休眠／修复伴随页：同目录`task-repair.html`，首页已有入口。用户已授权主助手独立接管，取消未执行的Frontdesk排队任务。原Demo推进改为按场景、确切target独立回执，未决决定和成果审阅不被普通讨论或统一推进自动解除。两页实际操作及窄屏证据见[协同合同§6](agent-task-repair-lifecycle-design.md#6-验证边界与交接状态)。

此 Demo 不导入生产 preload／运行时，不请求模型，不读取论文、凭据或真实项目，不保存生产设置；模型名称、回复、项目和状态全部为合成示例。刷新页面重置本地演示。底部“场景”“推进演示一步”“展示12个Agent”是设计验收控制，不属于正式用户界面。

## 2. 对话区布局

### 顶部：项目协作条

- 项目层只显示“项目协作保持 / 等待处理 / 项目待命”，附进行中 Agent 数和待处理项数。这里“项目协作保持”表达项目仍可推进，不承诺所有角色进程都在线。
- 前台、主控与两个相关 Worker 用紧凑摘要展示：角色＋稳定标识、工作短标题、一个主要状态、模型按钮。不复制工具日志或报告正文。
- 超过四个 Agent 收入“全部 Agent”列表。每个 Worker 用自己的 Work 身份，不把不同 Worker 都折叠成一个“Worker”。正式接入后应优先显示当前交互／需处理／活跃 Worker，并使列表顺序稳定；具体排序待确认，不暗改执行优先级。
- 点击 Agent 仅定位讨论与明确发送目标，不启动进程、不发送消息。查看列表或技术详情同样不唤醒。

### 中部：连续对话

- 历史消息头显示发言者、Worker工作标题、发送时模型、时间。历史模型不可被当前设置或后续状态刷新覆盖；缺少历史模型证据时显示“未记录”，不得拿当前模型倒填。
- Agent当前活动使用短过程行，不持续制造系统气泡。需要用户动作的事实才展开对话卡：确认假设、处理连接、打开审核报告。
- 报告提供“打开审核报告 / 继续讨论”。查看不等于接受，不在这个Demo伪造合入、修改文件或审核通过。
- 未决问题允许“暂不决定”，保留工作与问题；不得以自动换Agent绕过授权或用户决定。

### 底部：一个输入区

- 显示明确目标和该Agent模型入口，继续讨论与提出修改共用输入区，不要求问答／任务模式切换。
- 运行中发送的新输入表达“排在当前回合之后”，不模拟打断。Demo发送只把用户文本安全显示为本地演示消息，不伪装真实入队。
- 模型选择、详情、Agent选择、主题和场景变化保留未发送草稿。切Agent不自动派发已有文字；正式目标变更是否共享或隔离草稿沿现有项目草稿合同实现，不在此另建第二套草稿策略。

## 3. 哪些状态对读者可见

| 用户可见状态 | 含义 | 主要动作／边界 |
| --- | --- | --- |
| 待命 | 当前没有业务回合，不代表已休眠 | 可明确发送；不展示“免费Agent” |
| 准备中 | 已有启动／准入过程，尚未开始普通输出 | 不暗示已执行工具 |
| 执行中（样例为“核对中”） | 当前任务正在推进 | 可附有事实依据的短活动描述，不让模型自填运行状态 |
| 使用工具 | 有原生／宿主工具执行事实 | 展开过程查看；不把消息结束当工具结束 |
| 等待运行名额 | 输入已接受，尚未取得执行容量 | 明示无需重复提交；不能伪装运行中 |
| 需要你决定 | 用户输入／权限／业务假设决定阻断 | 原对话内明确选项，动作绑定确切请求 |
| 结果待审阅 | 当前Work成果已准备 | 打开冻结报告，继续讨论；不自动接受／结束 |
| 整理上下文 | Pi压缩等受保护活动 | 保留当前工作与草稿，不启动第二owner |
| 连接重试中 | 原生已有重试事实 | 不由Nozeli再次重发prompt；可以显示有限重试说明 |
| 保存结果中 | 原生结束但宿主仍在落账／发布 | 不能提前显示完成、释放owner或消费草稿 |
| 已暂停 | 明确停止或业务阻塞，工作保留 | 显式续作与原版本准入，不偷偷重跑 |
| 休眠 · 按需恢复 | 无运行owner，保留工作／原线程 | 显式输入或已接受事件可申请恢复；浏览和选模型不唤醒 |
| 连接失败 | 已确认不可用 | 保留输入，提供连接／模型入口，不自动重发 |
| 状态待核实 | 原生／owner／宿主证据不足或冲突 | 不按idle、completed或安全重投处理 |

状态不是单一互斥业务枚举。显示时先保留具体阻塞和用户动作，再区分当前受保护活动与稳定Work状态；其余活动可在详情列出。例如待审阅Work可以同时是sleeping，卡片主状态“结果待审阅”，详情说明“会话按需恢复”。不得因为owner已退出把Work标为完成。

失败文案按来源区分：连接／模型失败、执行失败、结果保存受阻、状态未知；不能把所有错误统一叫“连接失败”。Demo“失败与未知”主要演示两者不可混淆，完整错误分类沿现有诊断合同接入。

项目层遇到未核实状态时继续保留协作与核查机会，不能因缺少busy事件误降为空闲休眠；Demo以“项目协作保持”加待处理项及警示色表达，不把owner术语搬进对话。

## 4. 不在主对话常驻展示的内部状态

ownerId／generation、PID与进程树、spawn reservation、exit confirmation、reclaiming、写者lease／heartbeat、session epoch、IPC seq、flush／nativeDrain、CAS、存储UNKNOWN、游标、digest等，不作为普通用户的Agent标签。

- 技术详情可只读查看必要事实，不拿内部JSON占满对话。
- 内部问题确实阻断用户操作时，转成“状态待核实”“结果保存受阻”等可理解提示，并提供核查入口；隐藏术语不等于隐藏故障。
- 正常owner回收不插系统消息，不把每次进程启动／停止写成对话噪声。
- 进程已退出、原生回合已settled、宿主事务已提交、Work已结束是四类不同事实。

## 5. 模型按钮的行为合同

作用域默认**当前Agent后续回合**，不同时修改项目默认或其他Agent。Worker绑定和原线程能力必须由宿主再确认；不可通过模型按钮创建新Worker来回避兼容问题。

| 当时情况 | 确认后的展示 | 生效规则 |
| --- | --- | --- |
| 空闲会话 | 发起切换，收到回执后更新当前模型 | 正式版必须等待实际effective确认；Demo即时模拟确认 |
| 正在执行／工具／压缩／重试／交互 | 当前模型保持，显示待切换 | 当前回合不受影响；保存期望，安全边界确认后更新effective |
| 休眠 | 显示“上次使用”与“下次启动使用” | 只保存期望，不启动进程，不把保存冒称实际生效 |
| 已知连接失败 | 保存期望模型，当前/历史模型不变 | 明确重新连接并收到确认后更新effective；不重发原输入或发送草稿 |
| 状态待核实 | 模型列表只读，禁止覆盖原会话 | 先核实owner／原请求；没有可靠事实不推断idle |
| 配置保存失败 | 当前与原待切换值不变，明确显示失败 | 允许显式重试，不静默换来源或新建线程 |
| 模型不可用 | 保留原选择／历史提示，条目禁用 | 来源名称＋模型ID区分，不把目录条目等同推理授权 |

选择器包含搜索、当前／已保存标识、取消、撤销未生效切换和Demo专用“模拟配置保存失败”。重选当前值不重复提交。取消／Escape不写入。运行中多次选择以最新明确选择为准，旧回执不能覆盖新期望；正式版需绑定projectId／target／owner generation／配置revision／operationId，并复用既有模型配置串行入口。

当前Demo只展示模型，不先加入thinking档位、源管理和认证表单，避免在对话区复制设置页。后续可从原生可用能力补充，不能按模型名字猜档位。

## 6. Demo验收场景

1. 并行工作：前台／主控待命，两个Worker分别使用工具与核对中；项目协作保持。
2. 等待运行名额：一个Worker执行，另一个排队；主控可休眠，项目仍保持。
3. 需要决定：在原对话确认研究假设或暂不决定，不发明授权。
4. 结果待审阅：报告入口与继续讨论，不在Demo伪造接受／合入。
5. 压缩与原生重试：受保护活动可见，与普通idle分开。
6. 准备与结果保存：启动准备和原生结束后的宿主保存分开；推进后仍不伪装整个Work完成。
7. 失败与未知：已知失败可先保存期望模型、明确重新连接；未知Agent只读，不允许直接覆盖配置或发送。
8. 项目待命：无执行任务，Worker休眠；普通推进不批量唤醒休眠Agent。
9. 运行中切模型、边界生效、撤销、保存失败、取消、不可用模型；历史消息与草稿保持。
10. 十二个Agent列表、390px窄屏、深浅主题、键盘焦点及无水平溢出。

## 7. 从Demo反推接口，不预先扩建底层

建议逻辑DTO（字段是设计合同，不代表已有同名生产API）：

- identity：projectId、role、target/workId、workRevision；owner／generation只用于后台校验。
- visible：displayName、workLabel、primaryState、activityText、blockReason、availableActions。
- model：recorded/lastEffective、effective、desired、syncState、configurationRevision；历史消息modelAtSend独立。
- lifecycle：projectKeepsRunning、protectedActivity、pendingAcceptedJobs、pendingDependencyEvents；不由UI根据一个busy推算。
- evidence：snapshotRevision、ownerGeneration、observedAt、sourceSequence、freshness。断线／缺失／代际变化明确unknown，不倒退覆盖新快照。

| Demo需要 | 当前材料／入口 | 下一步优先动作 |
| --- | --- | --- |
| 身份／工作／排队／审阅／暂停 | Nozeli Work、job、receipt、target及现有snapshot／disposition | 复用现有投影，不从Pi重复建立业务状态机 |
| 推理／工具／压缩／原生重试 | Pi原生事件、pi-gui订阅、`facts.mjs`转发 | 盘点事件接收、去重和role归属，归纳状态；仅确认缺失的事实才扩桥 |
| 原生交互与关闭 | 当前interaction及respond合同 | 复用确切请求身份，和原生业务问题／权限分层 |
| 正在保存／不可休眠 | Controller current/running、工具集合、nativeDrain／存储回执、owner退出证明 | 宿主组合；不能只看agent_end或Pi status=idle |
| 模型显示／切换 | snapshot里的model/effective/desiredModel/pendingModel/modelError，现有设置／默认模型串行应用逻辑 | 核实逐target/Worker的真实可切换能力和作用域；复用现有写入入口，缺target级合同再补 |
| 历史模型 | 原生历史／发送时模型事实 | 查证每条消息可否可靠归属；缺失标为未记录，禁止倒填 |
| 状态重新核对 | Pi GUI snapshot与Nozeli runtime status目前粒度不同 | 先补轻量可查询快照的现有事实汇总与seq／generation核对；不读取完整历史来判断busy |
| 项目整体保持／依赖唤醒 | 当前Controller、process budget、job队列、kick与owner gates | 用户先审阅Demo与项目保持语义；再review项目级聚合准入，不能因显示协作条提前启动所有Agent |

实施顺序：**用户审阅Demo → 核定可见状态及模型作用域 → 逐字段查当前接口 → 在Nozeli归纳已有事实 → 真正缺失的Pi/桥接事实再补 → 真实Pi逐场景验收**。生产接线前不得把示例状态、固定模型目录或本地“发送”当作已实现能力。

本轮不改生产状态、Pi SDK、模型设置和资源调度，不安装、不提交、不推送。独立设计结果不构成调度策略或冷恢复自动重放授权。

## 8. 本轮实际验证

真实Chromium已打开Demo并操作八类场景；实测运行中切换保持当前模型、模拟安全边界确认后生效、历史模型不回写、休眠只保存期望不唤醒、保存失败保留旧值、明确重试／撤销、未知只读、研究假设决定、连接恢复不重发、不清未发送草稿、十二Agent列表、Escape取消及技术详情。390px窄屏实测scrollWidth=390，无横向溢出；深浅主题与模型选择器截图已查看，浏览器记录的页面异常为空。直接file://打开HTML也实际渲染四个Agent，无页面异常。

截图原件：`/var/tmp/nozeli-agent-status-demo-01Ym2a/{desktop,model-pending,narrow-dark}.png`。该证据仅是离线UI／交互验证，不是Pi状态映射、真实模型切换、队列公平或跨平台桌面验收；本轮未跑无关生产测试套件。

## 9. Demo所需底层调用与缺口核对（2026-11-01，分析完成，未实施）

### 9.1 结论与真实观察

不用重写Pi状态系统，也不能直接把生产`managed.status`接到Demo后宣称完成。当前身份／Work／交互／在线模型切换已有入口；主要缺口是Nozeli轻量纯读投影、原生活动聚合和序号核对、持久逐target模型意图与撤销、历史模型透传。项目整体保持的业务准入与UI展示分开实施。

实际运行真实Pi owner＋回环合成Provider，报告`/var/tmp/nozeli-pi-real-wTDuV3/demo-state-gap.json`：执行中model change返回pending、当前模型不变，结束后切到第二模型；恢复原线程保留生效模型且总请求仍1，无自动重放。原生assistant message真实带`provider=local-fixture, model=scripted`。原生status返回busy/model/effective/seq等13个字段，但没有完整工具／交互／压缩／重试活动快照；送达Nozeli的native callback和entry callback都未携带seq。owner metadata只保存线程／文件／工具摘要，不保存pendingModel。上述是一个固定版本真实运行场景，不能外推其他版本或未运行边界。

### 9.2 调用链与按状态映射

当前链：Pi原生事件 → vendored pi-gui `onNativeSessionEvent` → `integrations/pi/src/facts.mjs` → owner JSONL → `PiSession.receive()` → Controller → `managed-state / managed-timeline` → renderer。业务身份和准入以Nozeli账本为权威，不让Pi创建第二套Work/queued状态。

| Demo事实 | 已有权威材料／入口 | 缺口与最小动作 | 是否需新增Pi底层事实 |
| --- | --- | --- | --- |
| 前台／主控／Worker身份、工作短标题 | Controller snapshot.target、works.id/name/revision，residents；`managed.status` | sleeping resident和never-started Worker不能仅从sessions枚举；按业务target补齐完整有界列表，区分未启动/休眠/未知 | 否 |
| 待命／准备 | starting/restarting、Pi phase、Controller current/running | 统一priority和reason，准备失败不可静默降idle | 否 |
| 执行／使用工具 | Pi agent_start、message事件、tool_execution_*；Host工具inFlightToolCalls | 当前native事件多数只进timeline，SessionIndex.event仅消费消息流/agent_end，不存工具/重试活动投影；Host工具集合不能覆盖Pi原生bash/read等工具。需按callId归纳有界活动集合 | 事件已有，先补Host消费 |
| 原生重试／压缩 | facts转发auto_retry_*、compactionStarted/Ended、runSettled；Pi busy | 区分agent_end.willRetry与最终agent_settled；重试不能创建新host job。压缩已有context预算失效逻辑，不把显示状态与预算代次处理混为一件事 | 事件已有；核对快照字段 |
| 等待名额 | pump容量门、processBudget、queued job；部分job.resourceBlocked | queued不总等于容量不足，还可能是同target占用、草稿、pendingIntake、coldJobs、deviation等。必须由准入判定返回准确reason，不由renderer猜 | 否 |
| 需要决定 | agents.interactions、attention、effect permission、problem/deviation记录 | 区分等用户、后台可核对和模型/配置阻断；复用现有owner/request/version绑定作答，不能所有interaction都标用户问题 | 否 |
| 结果待审阅／暂停／结束 | Work.status、receipt、disposition及review API | primaryState与execution/owner状态正交；ended仍可能closure未完成，review可同时sleeping | 否 |
| 保存结果中 | Pi flush/nativeDrain、Controller runJob及持久化/发布事务 | busy包含这些但不能具体归因；添加宿主执行阶段/待提交回执投影，出错转保存受阻或unknown，不提前完成 | 否，Host权威 |
| 连接失败／状态未知 | connectionErrors、modelError、storageBlocked、transport unknown、unconfirmed slot | 按target/请求限定范围；项目级失败不能把所有Worker误标失败。未知事实不能由一段时间无输出推断idle | 否；快照核对需扩桥 |
| sleeping／项目保持 | 无session、Work thread、processBudget与project/Controller门 | 无slot不代表安全sleep：未启动、退出未核实、残留注册要分开。新增project聚合，保留queued/protected/settlement/unknown核查机会；不改变现有no-replay | 否 |

源码锚点：`controller.mjs:114-159,398-405,1246-1284,1453-1459,1539-1572,3122-3133`；`managed-projects.mjs:119-170,216-257,358-370,432-454`；`pi-session.mjs:65-124,200-236,289-320`；`session-index.mjs:333-351`；`facts.mjs:88-117,119-265`。

### 9.3 一个不能直接复用的读入口

`managed.status → attentionState(connected=true) → controller.processBackstage()`不仅返回状态，还可能持久化backstage事件、创建orchestrator job并kick；`attention.observe`也持久化待办。未连接时status的projectionSource还会读完整managed业务状态／历史页。因此Demo“展开全部Agent／技术详情不会唤醒、不派工、轻量读取”不能简单通过高频轮询该入口实现。

最小修补：为对话协作条提供**纯读、有界的现有事实摘要**，与注意力事件生产／派工分开。先复用Controller内存与已有本地标量读能力；无Controller时返回unloaded/recorded事实，不为查询构造完整Controller，不读全会话正文。现有status兼容消费者不在第一步暗中改行为。

### 9.4 模型显示和切换的确切缺口

已有生产调用：`managed.model.options {projectId,target}`；`managed.model.set {projectId,target,ownerId,model,effort,requestKey}`；`managed.session.options`、`managed.session.command`；模型目录来自`ProviderSettings.models()`。不是从零写模型接口。

| Demo行为 | 生产现状 | 需补齐合同 |
| --- | --- | --- |
| 在线单Agent切换 | model.set已按target/owner校验，支持Worker；PiSession与prompt共享admission queue，忙时pending | 直接复用，但加读取时owner绑定/配置revision及确切回执，检查模型目录来源/可用性；菜单可用不等于已获推理额度 |
| 下一回合待切换 | pendingModel/desiredModel已在会话对象，desiredGeneration防过期queued配置覆盖 | **接受pending不等于持久保存**。增加本机逐target期望选择的CAS/operation receipt，明确accepted/persisted/applied/failed/unknown。重启不能丢掉已告诉用户“保存”的选择 |
| requestKey重试 | model.set检查requestKey格式，但该分支未使用requestKey建立幂等结果或碰撞检查 | 复用项目本机事务／回执约定，不以重复apply替代幂等；未知结果只核对，不盲重发 |
| 休眠/失败时保存 | model.options/set都要求live session，否则PI_OWNER_UNAVAILABLE；项目角色默认有持久设置，但影响整类角色 | 新增或扩展**逐target本机意图**入口，查目录不启动该Agent；不得拿settings.models.save替代Worker单独设置。失败可保存期望，effective需连回原线程核实 |
| 撤销未生效切换 | PiSession内部clear:true会清pending/desired，但model.set只接受model/effort，未对外暴露cancel | 绑定expected intent revision取消待应用项；已提交原生改变不可伪装“撤销成功”。回当前模型也是新配置动作，不是撤销未开始项 |
| 冷恢复与默认优先级 | makeSession恢复时会应用piSource.roleDefaultsFor(role)；原生线程也保留其模型 | 确认优先级：本Agent显式覆盖 > 角色默认 > 原生默认；明确“恢复继承”。不能已保存单Worker覆盖又被角色默认静默改回 |
| 配置失败及时显示 | modelError在snapshot；applyPendingModel捕获后emit model-error；observeSession监听model-changed/change等但未单独监听model-error | 把延迟配置失败接到统一状态revision通知，避免等别的事件才刷新；禁止用原有效模型显示掩盖失败 |
| 作用域及权限 | target／owner门已有；session/model查询仍可能被runtime/config初始化门阻断 | 纯目录／记录选择读取与真实运行门分离；变更仍经过项目生命周期、Work版本、兼容性、owner和高风险准入，不泛化豁免 |

关键源码：`managed-projects.mjs:642-645,740-754`；`pi-session.mjs:47-50,242-279`；`controller.mjs:1543-1558,1711-1731`；`main.cjs:788-795`。休眠选择需要的目录查询不应被“无live owner”阻断，也不应触发每次模型联网发现；用已有已授权目录，缺失明确提示。

### 9.5 历史模型：原始事实已有，当前UI DTO没透传

原生assistant message包含provider/model，真实烟测已确认。`SessionIndex.nativeDTO()`没有把这两个字段纳入对话DTO；超预算metadata allowlist、streaming DTO、portable message和renderer session-store的裁剪也需同一字段合同，不能只修普通小消息。

推荐按assistant消息/segment显示真实生成模型，不按当前会话模型回填整轮；原生重试/切模可能使一组消息不止一个模型。用户消息没有模型事实时不伪造；历史缺字段显示未记录。新消息只增只读派生字段，不改历史原始对象或哈希；为大消息生成有界元数据时提取，不为显示模型重读/解析超大原文。旧大记录如果无安全元数据入口，先显示未记录，不扫描完整JSONL制造OOM。

### 9.6 状态顺序／新鲜度：必须先补的桥接合同

现有facts.entryFrame有seq，但native/delivery没有统一seq；PiSession生成的onNativeEntry/onNativeEvent事实未传外层seq，真实运行两个callback均未见seq。runtime.status的seq来自facts当前条目序号，不是所有活动的水位，不能用它证明压缩/工具/交互事件没漏。Nozeli本地epoch与viewOwnerId已有，应继续用，不再制造替代身份。

补齐方案：在**Nozeli bridge**对活动更新和一致快照给同一owner generation下的单调activityRevision；只添加到Nozeli信封，不修改Pi原生entry。快照返回有限工具集合/计数、prompt-start、runActive、compaction、retry、pending interaction、configuration/command、可核验状态和水位；事件与快照在同一串行边界采样。Host转发并验证，旧代际/旧revision丢弃，缺口可主动读取一次纯状态快照，无输出或心跳超时只触发核查，不能自动判空闲或补发prompt。

不将当前best-effort OwnerRuntime.status直接当轻量一致快照：它还会SessionManager.open原生文件计算entryCount/leafId，且busy只看promptInFlight，未暴露完整活动。新摘要不读历史正文，不泄漏工具参数/文件内容/凭据；snapshot不是持久化完成证明，仍须宿主回执。

### 9.7 最小接入顺序与验收门

1. **只读投影P1**：定义有界Agent/project DTO与多维状态→可见标签纯函数；接已有Work/job/interaction/owner事实，暂不改回收。无owner返回明确unloaded/sleeping/unknown，列出blockedReason，分页稳定且动作能力由Host给出。打开Demo式状态UI不能创建job或启动Pi进程。
2. **原生活动P2**：接已有工具/压缩/重试/交互事件；补桥接activity快照和revision，转发owner/epoch/version；测试旧owner迟到、漏事件、并行工具和settlement空窗，信息不足仍unknown。优先补Nozeli桥，不改Pi SDK。
3. **逐Agent模型P3**：复用live model.set，补target意图持久化、CAS/幂等、睡眠只保存、撤销竞争和默认优先级。重启后只恢复期望，不重放旧输入；applied必须有原生回执。能力不足的历史线程显示不可改，不新建线程伪装成功。
4. **历史模型P4**：将已有原生模型事实贯穿普通/streaming/portable/超预算/分页DTO；未知不倒填，历史原件不改。
5. **项目保持P5**：用户“一个Agent运行保持项目整体运行态”的要求落成宿主聚合，Controller/依赖监听和已接受事件可继续推进；不是全角色常驻进程。只在无受保护运行、无待结算/合法待处理输入、无未知owner时评估休眠，queued/coldJobs/权限/deviation不绕过。资源回收策略另经review，不能让UI标签反向授权执行。

必验：每个Demo场景真实Pi/本地Provider，busy/工具/压缩/重试/交互不误idle；原生settled但flush失败不报完成；无live owner选模型不启动；pending保存失败/崩溃/撤销与生效竞争；多Worker独立模型、角色默认更新不覆盖显式选择；旧project/owner回执不串绑；cold queued和UNKNOWN不重放；大历史状态读取保持有界。UI继续使用Demo已验证的草稿保护、历史不回写和窄屏交互。

本次仅更新分析，不实施API或调度，不提交／安装／推送。下一步可按P1/P2先接真实只读状态，再做P3模型写入合同；不能仅替换Demo数据源就称为产品完成。

## 10. 生产源码完成（2026-11-02，Linux限定验收通过，未安装／提交／推送）

本节承接上节实施授权；第1–9节“离线Demo／未实施”是设计时记录，独立Demo本身仍然离线，不冒充真实功能。当前生产接线不引入第二个任务账本、DAG、轮询模型或新的全局资源调度器。

### 已落盘模块

- `managed/collaboration-status.mjs`：把当前Controller／job／Work／owner／模型事实归纳为有界协作摘要。执行状态、Work状态、配置状态和新鲜度分开；cold jobs不计作可自动执行输入。
- `main/storage-collaboration.mjs`与ProjectStorage：只提取本机缓存的Work标量与local thread/provider事实；分页保留未完成的ended closure，项目running/waiting聚合与页无关；指定target的owner核查不会被前缀截断漏掉。查询不构造Controller、不调用backstage、不启动项目Agent或加载正文。
- `integrations/pi/src/activity.mjs`、bridge／owner／PiSession：原生活动、工具、重试、压缩、交互、准备和保存阶段的有界快照及owner-local版本；保留entry原始内容，增加信封身份／版本。`agent_end`不等于`runSettled`；原生结束但宿主flush/nativeDrain未完成仍受保护。初次准备与结束后保存已分开。
- `managed/target-model-intent.mjs`及Controller：逐target本机CAS意图、请求键回执、保存／pending／submitted／applied／failed／unknown／cancelled；保存不等于生效。Model receipt额外绑定owner，旧owner迟到不能覆盖新owner。原生clamp事实保存，不能仅凭相同model确认effort-only变更成功。
- `session-index`与renderer session-store/timeline：assistant逐消息透传`provider/model/modelStatus`；流式、portable、裁剪和新超大条目的元数据路径一致。旧大记录无可靠元数据就显示未记录，不扫描完整历史倒填，不修改历史对象哈希。
- `renderer/collaboration-status.mjs/css`与原对话面板：生产项目协作条、Agent列表、逐Agent模型选择／继承／撤销。卡片与模型选项以身份复用DOM，状态更新不替换可点击节点；列表刷新保留已加载范围，无法取得一致页时保留旧节点并明确上次快照；打开的模型菜单重新核对事实，保留未提交选择与搜索。

### 查询与写入合同

`managed.collaboration.status {projectId, cursor?, limit?}`：每页最多50个Work及两个resident，输出编码预算64KiB；cursor绑定实例／来源／版本，失效明确报错。只读入口与`managed.status → attentionState → backstage`分离；不把旧消费者暗改成另一种执行语义。DTO含Agent身份、Work修订、可见状态、阻塞原因、当前／上次确认／期望模型、动作能力、新鲜度与项目保持事实；owner/generation只作校验，不在对话常驻展示。

`managed.model.options {projectId,target}`：无live owner也可读取记录与目录，不为目录／选择唤醒该Agent；返回配置revision、原生effective、recorded、desired、override、owner身份、Work修订与available。目录仍来自已有Pi设置路径；目录与凭据已配置不证明付费推理授权。

`managed.model.set {projectId,target,expectedRevision,requestKey,action,model?,effort?,ownerId?,workRevision?}`：action为set/inherit/cancel。live变更必须携带当前owner，Worker必须匹配当前Work修订；最终提交前重新核对owner／Work／lifecycle。历史只读、context recovery、未核实owner和存储UNKNOWN不绕过。相同请求不会重复原生效果；待执行保存可按原意图继续，但原请求／prompt从不重发。

显式target选择优先于角色默认，恢复原线程时应用；inherit取消target覆盖并沿既有角色／原生默认路径处理。cancel只取消尚未提交的选择；已提交／未知不声称撤销。恢复先前尚未生效偏好仍可在下次启动应用。成功applied以原生回执为准；未知结果只核对，不因相同模型名冒称effort生效。配置回执不修剪后假装可重试：达到1024条／4MiB预算明确拒绝后续保存，原配置与幂等证据保留。

### 项目保持与资源边界

任一受保护Agent、合法已接受队列、待结算／依赖事件、未完成宿主技术操作或未知owner，都保留项目推进／核查机会。复用现有Controller常驻、kick、capacity-released和已验证owner回收门；不因切项目卸载忙项目，也不因项目活跃启动所有角色。

硬上限仍有效：所有slot都busy/unknown时，不能同时保证不抢占、不越限且立即唤醒另一个角色。此时保持队列／监听并解释阻塞，等待合法释放或用户处理；本轮不宣称依赖死锁完全消除、不暗设控制角色预留名额、不自动终止busy owner。公平调度／预留配额仍需独立产品决定。

### 验证记录

真实Pi／本地Provider的Host烟测已观察纯读不启动、休眠保存、初次及原线程恢复的target优先级、忙时切换、历史生成模型、GUI草稿保持、两个真实Worker的独立选择与角色默认不覆盖、已验证回收和冷开不重放。初步证据：`/var/tmp/nozeli-pi-real-C73A2V/{production-state-model,worker-models}.json`。

独立review提出的owner CAS、目标分页、effort核对、取消恢复前一偏好、已加载列表焦点、菜单事实刷新、记录页全局聚合／未结束closure／provider前缀遗漏已修正并补回归。reviewer仅对其发现及所述修正作确认，不冒称最终源码已经独立全量复测。以下为整合后的实际运行结果；失败尝试不计通过。

集成回归曾发现Controller选项／IPC字段白名单迁移漏项：已恢复原进程额度、接受前草稿保护、成果归属记录与项目文本读取回调，并恢复`review.instruction.save`允许字段；原安全断言未删除。修正后相关53项通过，覆盖错误PID／未知额度阻断、活跃及损坏草稿保护、指令账本真实入口和只读协作查询。

真实Electron进一步发现模型已生效但后台刷新未结束时，弹窗退出点击被忽略：退出现在只关闭界面，不撤销已提交选择，不阻塞继续输入。新增延迟回执回归核对关闭后可继续编辑，晚到结果不重开菜单、不覆盖草稿；配置撤销仍只能使用独立的“撤销待切换”动作。

最终运行证据（隔离合成项目，真实Electron／Pi owners／本地HTTP Provider；未调用付费模型、未使用个人凭据）：

- Host原线程／模型烟测：`/var/tmp/nozeli-pi-real-fvtCuD`，10项检查通过；只读不创建Controller／owner、休眠保存不唤醒、忙时保持当前请求模型、历史显示实际生成模型、冷恢复原thread且不重放、原文件不变、自有进程全部结束。
- 真实生产对话：`/var/tmp/nozeli-pi-electron-0Nabbl/report.json`，10项通过；原文空白与引用分层、逐Agent模型选择不推理、过期owner拒绝、真实回复及历史模型、草稿／冷开不重放与正常退出；实际截图已检查。
- 真实模型管理：`/var/tmp/nozeli-pi-model-mgmt-KiV4TF/report.json`，9项通过；源配置CAS／密钥保留、真实目录发现、thinking原生clamp、同owner／thread换密钥后真实请求且零重放。退出遵循实际“取消任务并退出”确认，不绕过运行保护，exit code 0。
- 注册`npm run test:smoke`最终4脚本全过：真实文件宿主`apps/desktop/.test-output/ci/smoke-V8owZX`、PPT实际引擎导出`/var/tmp/nozeli-ppt-pending-fMpCF4`、投影合并及协作表面`/var/tmp/nozeli-collaboration-ui-FsSpmT`。组件还核对延迟回执下退出／继续编辑、62个Agent分页与后页焦点、菜单事实更新但保留选择／搜索、跨项目迟到隔离、390px无横向溢出。组件网关是确定性合成数据，不冒充该组已运行真实Pi。
- 完整`npm test`通过：unit 560/560（64文件）＋integration 1559/1559（150文件），合计2119项，0失败、0跳过；原始TAP为`apps/desktop/.test-output/ci/{unit,integration}.tap`。`npm run build:renderer`通过；Pi运行时使用实际构建产物完成上述原生链路，不以`PI_RUNTIME_UNAVAILABLE`跳过。

验收限Linux x64。Windows/macOS、真实账号OAuth／付费模型、公开发行与安装未验；硬资源上限下的公平性／死锁调度仍遵循前述边界，不因本次接入宣称全局调度问题已消除。

## 11. Agent动态自动管理（2026-11-02，源码完成，Linux限定验证通过，未安装／提交／推送）

上一阶段完整测试通过后，用户授权推进工作项目Agent常驻、空闲卸载和启动重加载。本节新增自动闲置回收；不将§10已完成的压力回收／按需恢复冒充自动回收已经存在。

### 运行合同

- **常驻的是项目推进能力，不是所有角色进程**：已连接项目保留Controller、队列、依赖监听及宿主结算；任一Agent运行不因切项目停止。其他角色安全空闲可单独卸载，不关闭项目、不释放Work业务配额，不要求所有角色常驻。
- **默认连续安全空闲5分钟再卸载**：复用原进程归属核验和`reclaimIdle`；有明确容量压力时沿原策略提前回收。用状态／原生活动事件及最近截止时间驱动单个定时器，不轮询模型、不扫描历史正文。状态查询本身不刷新“使用时间”或启动进程。
- **拒绝回收受保护或未知状态**：运行／排队输入、工具、重试、压缩、原生交互、配置提交、宿主保存／结算、UNKNOWN、未核实owner、原生草稿、终端租约、交接与恢复中的实例不当空闲。到期再次核对原Controller及owner；异步退出前有新输入则保留，退出已开始的输入等待原退出确认后正常恢复。
- **按需重加载而非重放**：新的显式用户输入、已获准队列和真实依赖事件按原session路径唤醒所需target，恢复同一thread及已保存模型选择；不预热全部角色、不因浏览状态／设置偏好启动，不自动重演coldJobs／coldQueued／未知效果。单target不得出现双owner。
- **释放以确认退出为准**：停止失败或进程树未确认保留provider与预算证据；自动管理不形成密集失败重试。项目不可用、关闭及应用退出清理定时器与候选；原草稿、历史、文件、模型偏好不删除。

### 验收门

自动截止到期且仍有空余额度时实际卸载；同项目busy peer继续；原生活动重置空闲期；旧owner截止不能作用于替换owner；回收中收到输入不丢失；原线程新输入／依赖事件正常唤醒且不重放旧输入；停止失败不释放名额；项目关闭后无延迟重启。以下记录真实Pi进程、本地Provider、真实文件及相关回归／Electron表面的运行证据。未授权安装、提交、推送或付费请求。

### 落盘模块与审查

- `managed/agent-idle-lifecycle.mjs`：单个unref截止定时器、单飞到期处理、单调时钟和精确Controller／session身份；状态批次核对与单target即时核对分开。未回收的安全竞态返回false只取消本次截止，下一段空闲仍可回收；真正退出失败按原session抑制自动重试，保留证据。
- `managed-projects.mjs`：接入连接、状态、原生活动及项目／应用关闭；不移除闲置项目Controller，不更改原`openController`草稿保护、归属记录、项目读取、模型意图与预算合同。
- `Controller`：原生已知空闲、宿主保存／publication／closure／交接／未知状态及合法排队保护；终端关闭后的异步空窗再次核对，退出确认后再清除本owner，最后解除回收栅栏并kick队列。原生eligibility事件先于32ms展示事件合并，短暂busy→idle也重置连续空闲期，不因展示合并丢失安全变化。
- 两位独立reviewer分别检查截止／清理与原生准入／恢复。截止审查提出的32ms合并丢失空闲重置问题已修复并复审无新增发现；review是源码判断，不代替以下运行结果。

### 已运行验证

- 定向生命周期／进程额度／Pi准入／协作投影：48/48通过，零跳过；覆盖替换owner、回收中输入、亚帧原生活动、原线程唤醒、冷输入不重放、已确认与未知退出、宿主事务保护。
- 完整`npm test`：unit 560/560（64文件）＋integration 1578/1578（151文件），合计2138项，0失败／0跳过；原始TAP为`apps/desktop/.test-output/ci/{unit,integration}.tap`。
- `npm run build:renderer`与注册Electron smoke 4脚本通过；真实文件宿主`apps/desktop/.test-output/ci/smoke-g60InC`、PPT实际导出`/var/tmp/nozeli-ppt-pending-jw4DeL`、协作表面`/var/tmp/nozeli-collaboration-ui-K7FDEr`。真实生产对话Pi链路`/var/tmp/nozeli-pi-electron-Mi6x19/report.json`10项通过，含正常退出及冷恢复不重放。
- 真实动态生命周期最终验收：`/var/tmp/nozeli-auto-idle-real-jWgwVK/report.json`，8项检查全部通过。用实际DesktopHost／ManagedProjects／原生Pi PID／隔离文件／回环HTTP Provider；仅通过构造器把闲置期缩至1200ms，默认5分钟由确定性时钟边界回归另验，不声称真实等待过完整5分钟。忙前台保留、闲主控PID实际退出；状态查询及休眠偏好不唤醒；主控／前台按原thread恢复且应用已保存模型；真实Worker运行时两个resident可卸载，随后发布冻结报告；Worker自己闲置卸载而Work配额仍占用，显式续作以相同thread、新PID推进原Work到revision 2，仅一次新请求且原生日志精确保存原文；最终全部自有进程确认退出，无延迟重启、无原文件修改。

真实验收前的失败驱动未计入通过：脚本曾把后台核对也当作intake调用管理工具，被产品真实准入拒绝；已修正确定性Provider按实际事件范围作答，未放宽产品权限。续作原文以原生日志核验，不把provider最后一个user片段的位置当成稳定协议。临时驱动在证据保留后移除。

限Linux x64及本地确定性Provider；真实账号／付费模型、Windows/macOS、全局公平性／死锁消除、安装与发行不据此验收。项目Controller和存储服务未做冷卸载，文件／网页／终端工作面也不受本轮Agent进程回收策略驱逐。
