# 扩展市场与 Nozeli 全局管理 Demo

Date: 2026-11-12
Status: 最小管理员生产功能已实施并完成Linux限定验证；2026-11-14按用户授权随全部工作树修改本机安装。市场／扩展仍为独立交互原型，不代表已接通生产能力。

## 2026-11-14 当前方向与主源码落盘

用户确认先独立管理员Agent，Store/资源库延期；管理员仍为交互Demo，不把模拟回复/登录当作已安装产品能力。主源码已保存[独立原型](demos/admin-agent/index.html)及[当前Nozeli外壳融合驱动](demos/admin-agent/integrated-demo.mjs)。空白主页“从管理员Agent开始”、设置第一项、独立管理员默认模型，以及API/登录引导回原管理草稿已在隔离Electron实例演示；模拟连接不读取或写入真实凭据。

融合驱动在当前Nozeli真实shell的临时config/profile中注入Demo视图，复用原设置与主题，返回保留原工作面；不是生产main/app接线，不向日常项目注入模拟Agent。源码执行`node docs/demos/admin-agent/integrated-demo.mjs`可重现。最新极简搜索栏为单行“搜索…”与原“…”菜单，所有模式/高级条件按需打开；搜索功能独立于管理员Demo，本次本机安装仅安装真实搜索及主树原有能力。历史市场原型在下文保留来源，不构成本期实现授权。

### 2026-11-14 最小生产管理助手（用户授权实施／测试）

本轮从Demo方向收敛为：独立应用级管理会话、两项原生按需skill（项目管理／Nozeli配置）、已登记项目列表与打开、脱敏配置查询、全局角色默认模型／effort变更方案与可信UI确认，以及敏感配置跳转原设置。管理员不是OS root，不提供通用IPC、Shell、项目文档／历史读取、删除／重置／清理、市场安装、更新或自我开发。

管理会话、原生历史、草稿、模型配置与skills绑定保存于应用用户目录独立命名空间，不登记虚拟项目，不写项目Controller／ProjectStorage状态。切换／关闭项目不切换管理上下文；用户明确选择的操作目标由宿主ID固定，不因当前项目变化改绑；项目消息、草稿、选区、附件、地图及历史不得自动注入管理Agent。开始页与设置共用同一管理会话，打开入口不推理、恢复不重放旧输入。模型选择不继承某个项目配置。

变更只准备全局frontdesk／orchestrator／worker默认，保留项目显式覆盖；展示before／after、作用域和生效状态，用户确认具体版本后才能执行。准备后配置被其他入口修改须CAS拒绝；重复确认不重放，未知效果保留unknown。密钥与OAuth交互只在原可信设置输入，不交给模型。配置目录模型／已配置凭据不是API资格保证。实际持久化／原生Pi／GUI隔离验收完成后在本节追加结果，不以Demo截图代替产品证据。本轮不授权安装、提交、推送或发布。

实施文件：独立 `apps/desktop/src/agents/admin-agent.mjs`、`src/agents/admin/roles/admin/` 的最小契约及两项skills；生产 `renderer/admin-agent.mjs`／CSS与开始页／设置入口；主进程 `admin-operations.mjs` 仅允许可信shell且不走项目payload改绑。复用PiSession，显式独立sessionDir为应用 `admin-agent/agents/admin/sessions`；共享Pi目录仅供既有账户配置，不复制密钥。native admin模式只允许五个管理host tools及精确skill原生read，不授予文件／shell／项目内容工具。全局进程预算以projectId=null、target=admin计数，不创建虚拟项目。

ProviderSettings默认模型保存增加串行队列内版本CAS及每次写入独立revision，避免预览后并发覆盖与同值ABA；确认前journal持久化executing，冷恢复改unknown不重放。默认配置保存回执与在线应用／等待／失败分开。退出与更新等待管理草稿串行保存及IME结束，管理mutation／推理计入lifecycleBusy；停稳失败保留进程占用。

集中验证：`build:pi`、`build:renderer`及main／真实GUI脚本语法检查通过；`admin-agent`、`admin-agent-ui`、`admin-operations`、`provider-settings`、`pi-native-skills`、`pi-session-admission`、`update-lifecycle`、`settings-agents-ui`共97项通过。真实Electron＋原生Pi／本地确定性Provider验收由 `tests/desktop-admin-agent-live.mjs` 单独执行，结论待下文实际证据；不把97项当真实模型理解或跨平台通过。

真实Electron首轮已通过管理独立模型、跨项目草稿、两项原生skill读取、准备／确认默认配置及项目document面拒绝admin，但正常退出失败：WindowRecovery已等待shell flush回执，settle再次flush同一shell形成自等待。已恢复为只刷新其他项目surface，管理草稿由最初shell flush保存，不跳过管理保存屏障。第二轮首关exit0及冷恢复不重放通过；末尾在全局模型已配置后打开另一项目触发现有项目自动初始化和任务退出确认，测试未处理该独立业务，因此不能据此判管理员退出故障。后续将管理导航验证移到全局默认变更之前，明确隔离项目初始化与管理会话，保留实际项目切换与草稿验证，不隐藏／取消产品任务来冒称空闲退出。

最终真实Electron验收通过：`/tmp/nozeli-admin-electron-xodBb0/report.json`，8条场景、errors=[]、两次正常退出均code0。实际生产main／renderer、独立原生Pi、localhost确定性Provider执行：查看状态和保存管理员独立模型不推理；切换两个真实合成项目保留管理草稿，模型输入未包含项目正文／项目草稿／测试凭据；管理按钮按精确registry ID打开项目；两项skill真实原生read及管理host tools准备方案；确认前不写全局默认，用户点击确认后真实ProviderSettings保存Worker模型；真实项目document surface调用admin.status被拒；冷恢复原生历史／模型／草稿一致且无新增模型请求；390px实际无水平溢出、Escape返回不删上下文。已查看admin-narrow／admin-restored截图。

这些结果只证明Linux生产接线与限定隔离，不证明付费模型理解质量、所有可访问性／平台、项目内工作内容管理或市场安装。97项回归与GUI分别记录，不把固定脚本回复冒充通用模型能力。本轮未安装／提交／推送／发布，未修改日常账户、模型配置、项目文件或原会话。

### 2026-11-14 全部修改安装与提交授权

用户明确授权“当前所有修改安装commit”。`node tools/install-local.mjs`构建及安装校验成功，current为 `/home/bfly/.local/opt/nozeli/releases/2026-11-14T10-15-48-903Z`，previous保留 `compact-search-main-20261114-01`；桌面与命令行入口已切换。范围包含当前搜索、界面、管理员及此前工具修复，不仅管理员。待提交445个变更／新增文件中未发现凭据格式命中或私有数据库；记忆评测目录为合成／公开来源，原型图片保留各自来源声明。安装不改变日常模型／凭据，不自动重启正在使用的旧窗口；正常重开加载新版。不推送或公开发布，跨平台仍未验。

安装包追加实测：`NOZELI_TEST_BINARY=/home/bfly/.local/opt/nozeli/current/nozeli node tests/desktop-admin-agent-live.mjs`实际启动上述release的Electron／main／Pi资源，8场景通过、errors=[]、两次exit0；证据 `/tmp/nozeli-admin-electron-gXwJhn/report.json`。隔离profile与合成项目、localhost确定性Provider，不读取日常凭据，不宣称付费模型理解或搜索全路径本轮重验。








## 入口与范围

- [独立 Demo](demos/market-admin/index.html)，单文件、无外部依赖，可直接用浏览器打开。
- 本地预览：`http://127.0.0.1:18764/`（仅当前开发机运行服务时有效）。
- 参考当前面板的项目 rail／文件栏、中间连续工作面、右侧工作追踪，以及设置中的全局／项目分类。参考源码：当前涂鸦候选的 `apps/desktop/src/renderer/index.html`；不是重新实现生产编辑器。
- [市场桌面图](demos/market-admin/market-desktop.png)、[管理员桌面图](demos/market-admin/admin-desktop.png)、[管理员窄屏图](demos/market-admin/admin-narrow.png)。截图为浏览器实际渲染，资源名称、版本、占用和操作状态均为样例。

## 已实现的演示路径

1. 开始页：未打开项目时进入市场或独立全局管理工作面；“打开合成项目”不访问真实目录。
2. 市场：引擎、Skills、Role Specs 三类，搜索与已安装筛选，详情、安装确认／取消、配置及定制副本。引擎定制仅创建适配声明，不加载二进制。
3. Skill：全局可多选 Frontdesk／Orchestrator／通用Worker。项目引入以全局默认作为初值，保存项目自己的目标范围；后续全局修改不覆盖已有绑定。
4. Role Spec：查看与定制角色说明、私有技能正文、公共技能引用；创建本地副本不覆盖原包。项目独立引入模板，不创建常驻进程。
5. 项目能力与成员：从已安装库分别引入角色与Skill，显示版本、项目Skill适用角色、缺失视频引擎及零运行实例；移除绑定不删除成果。
6. 管理助手：开始页与设置共用同一管理会话／草稿；独立作用域头、对话、变更方案确认及输入区。视频能力、研究审阅角色、功能开发三种本地固定回复，其他输入明确提示无通用理解能力。
7. 浅／深色、重置、窄屏适配、原生模态对话框与键盘焦点样式。

## 设计约束

- 安装、全局启用、项目引入和任务执行为独立动作。全局管理范围不等于默认读取所有项目或获得OS管理员权限。
- 管理助手只准备操作方案；功能开发须绑定源码工作区、准备候选和验证，再由用户明确激活，不能覆盖运行安装。
- 角色说明／Skill内容不是权限；保留宿主Work、候选、用户采用与生命周期边界。
- 所有数据仅保存在页内存；刷新或重置即清除。没有生产持久化、真实安装、联网下载、模型调用或真实派工。单一合成项目不证明跨项目隔离。
- 当前基础图片阅读、涂鸦等不迁到付费／附加组件；重型引擎市场是新增能力方向。

## 实测证据与边界

父会话实际使用Chromium点击与观察：

- 安装取消后仍可安装；显式模拟安装后显示已安装；安装角色后仍需项目引入，列表保持零运行实例。
- 全局Skill只选Orchestrator，项目引入默认正确且保存回显；之后将全局改为Frontdesk，已有项目仍为Orchestrator。
- 定制角色保存独立角色说明、私有技能正文及 `文献证据核对@2.1.0` 引用；详情回显三者。
- 内置研究审阅员创建副本、该自定义角色再次创建副本，公共技能选择均保持 `literature`；二次副本保存后详情仍为 `文献证据核对@2.1.0`。三个浏览器断言通过，错误记录为空。
- 管理助手“定制角色”返回方法审查／文献证据方案而非视频方案；确认仅记录模拟确认。
- 管理页填写草稿，经设置再次进入，草稿与已确认方案均保留。
- 1440×960桌面、390×844窄屏实际渲染；窄屏管理员页面文档宽度390，输入区底部844；没有横向页面溢出。窄屏市场深色实际观察。
- 对话框Tab移动到内部操作，Escape关闭；不宣称完整屏幕阅读器与所有纯键盘流程验收。
- 浏览器页面错误记录为空。没有跑生产构建／测试，不把Demo当真实CLI、引擎、Windows/macOS或生产产品验收。

## Reviewer

首轮独立Reviewer结论：`incorrect`，发现两项P2：项目Skill适用角色未保存、管理员角色快捷请求误路由视频方案。已修复，并由父会话实际点击验证；同时采纳独立角色字段建议。首轮Reviewer未能使用浏览器，只完成源码审核；浏览器实测证据来自父会话，不冒称Reviewer点击通过。

第二轮复审确认首轮两项已修复，另发现定制副本未初始化公共技能引用（P2）。已补齐原引用及内置审阅员引用的初始化；父会话完成内置→副本→再次副本的实际点击与保存回显验证。最终Reviewer verdict：`correct`，累计三项P2均关闭，无剩余已确认Demo阻断缺陷。Reviewer为只读源码复审；实际浏览器操作由父会话执行。结论仅适用于内存模拟Demo，不代表生产安装、引擎或模型接线验收。审核原件保留在本次会话的 `agent://MarketDemoReviewer`，不作为产品运行依赖。
