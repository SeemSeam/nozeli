# Nozeli Plan Tree

Date: 2026-11-08
Role: 当前源码项目的设计注册与维护入口

## 维护规则

后续 Nozeli 的产品设计、技术方案、已确认决定、实施路线与验收记录都在本项目目录内，通过本树登记和维护，不仅留在聊天、临时目录或协作工具中。用户当轮指令优先；设计不是安装、提交、模型费用、迁移或删除授权。

- 新工作先定位已有主题：相同职责修订原文档；独立目标再注册分支。不要每轮对话生成一份同内容的新方案。
- 每个主题保留一个主合同，分别关联实现状态、测试证据和历史研究；索引只导航，不复制正文或维护第二任务账本。
- 变更先更新主合同与决定，再同步接口、实施记录和验收边界；明确已确认／提议、已实现／未实现、源码／已安装及已测平台。
- 代码报告、真实文件、任务采用与执行事实仍以宿主记录为准；树文档不能把未测能力写成已验收，也不能靠Markdown替代Work状态机。
- 原有未注册文档逐步在对应主题工作时补登记，保留原路径；本次没有批量迁移、删除旧文档或改造产品中的运行时Plantree。

## 当前主题

| ID | 主题 | 主合同 | 实施与证据 | 下一步与边界 |
| --- | --- | --- | --- | --- |
| MEMORY-001 | Plantree统一报告与稳定结果记忆 | [整体合同](../plantree-result-memory-design.md) | [实现／真实项目验收](../result-memory-implementation.md) | 复用Pi原生上下文，不另建压缩/短期记忆；后续局部读一致性、统一目录、规模检索及可恢复整理按主合同验收 |
| CONTEXT-001 | Pi与Nozeli上下文交付边界 | [交付合同](../context-delivery-design.md) | [Pi整合记录](../pi-integration-execution.md)、[测试入口](../testing.md) | 只测试Nozeli来源/版本/输入接线；不复建Pi压缩、会话历史和恢复 |
| ORCH-001 | 任务管理与主控 | [主控／Plan Tree设计](../orchestrator-long-term-design.md) | [稳定结果多task证据](../result-memory-implementation.md)、[DeePoly 故障复盘与修复路线](../orchestrator-long-term-design.md#11-deepoly-普通后台请求缺少路由回执复盘与稳定性路线) | 先核对实际外发工具与路由结果，再改恢复准入和界面；保留原任务，不重放已送达输入 |
| TASK-CHAT-001 | 主对话与 Worker 对话的排队和故障接续 | [交互合同与源码验收](../task-workspace-design.md#主对话与-worker-对话下一回合与等候队列) | [可交互 Demo](../demos/task-conversation-queue/index.html)；Linux X11 原生双入口与审核流程已验 | 源码已接线，未安装；外部模型、其他平台及跨父窗像素未验 |
| ROLE-001 | 角色契约与技能 | [角色设计及前台技能实施](../role-memory-skills-design.md#2026-11-13-前台项目起点技能源码已实现2026-11-14-linux已安装) | strict可选参数及历史页限额语义已修；真实DeePoly源码分析、隔离账本首读与历史6页续读已观察 | Linux修复版已安装、保留回退；24请求上限内历史完整尾页／最终摘要仍未签收，未发布、不自动启用 |
| PROJECT-OPEN-001 | 简洁生命周期、自动恢复与项目初始化 | [重设计合同](../project-lifecycle-initialization-design.md) | [安装后异常验收](../project-lifecycle-initialization-design.md#9-用户授权安装后的异常验收2026-11-08)、[原现场根因](../project-open-failure-analysis.md) | 已授权本机安装；真实权限/SIGKILL/PTY/取消/并发/七格式窗口及Pi初始化故障验收通过，日常项目未重置，其他平台未验 |
| LOCAL-WINDOW-001 | 局部讨论外壳与来源页归属 | [窗口合同与Word勘误](../worker-review-chat-demo.md#word来源页定位勘误2026-11-12用户确认方向源码修复未安装) | [实际测试](../testing.md)、[用户指南](../user-guide.md) | Word页内标签随来源页，不将统一外壳泛化为屏幕固定；源码修复未安装，其他页适配器／平台分别验收 |
| IMAGE-VIEW-001 | 图片基础查看交互 | [查看合同](../principles.md#图片查看2026-11-12) | [实际测试](../testing.md)、[用户指南](../user-guide.md) | 可见缩放／适应／原始尺寸／平移，原图与区域坐标保持；不扩成原图编辑器，安装与平台资格单独记录 |
| OPT-001 | 安装占用与运行内存优化 | [闭包合同](../deep-optimization-goal.md)、[内存实施](../responsiveness-optimization.md) | 目标依赖裁剪、设置owner空闲回收及Monaco按需加载已验；安装与发行资格分别记录 | 不以压缩或销毁编辑现场冒充运行内存优化 |
| MARKET-001 | 全局助手与资源商店 | [商店使用与实测](../market-admin-demo.md#上下文继承与角色技能管理)、[管理助手合同](../market-admin-demo.md#2026-11-14-最小生产管理助手用户授权实施测试) | 管理助手独立接线；引擎／驱动、技能、角色模板独立分区已通过 Linux 实包验证，本机已激活 `store-sections-local-01` | 本地可选技能见 CONTEXT-TRANSFER-001；不接远程包下载、脚本或支付，不提升 OS 权限，不改日常项目 |
| LOCAL-SKILL-IMPORT-001 | 本地技能发现与移植 | [Pi 与商店合同](../market-admin-demo.md#本地技能发现与移植reviewer-设计待确认) | ParaCloud 作业版源码隔离验证，未安装或实连 | 移植保留目标角色已有工具；审核版接入作业操作，项目连接单独授权 |
| CONTEXT-TRANSFER-001 | 工作状态继承 Skill | [交接任务与验收](../market-admin-demo.md#ccb-工作交接走任务通道) | Linux 实包激活 `work-handoff-local-01`；真实 CCB 会话副本验证受限主控任务和采纳回读 | 支持可验证的同项目会话；项目记忆账本已接入，Plantree 主题与当前文件／Work 核验未接入 |
| WEBSITE-001 | 官网介绍、交互演示与下载导流 | [首版设计合同](../website-design.md) | [可点击原型](../demos/website/index.html)，桌面／手机截图与Chromium实测见主文 | 本地设计待审阅；预设AI、无上传／模型／后台，下载指向GitHub Beta.3；未购买域名／托管、未公网部署 |
| ICON-001 | 统一图标、双语动作清单与提示 | [界面契约](../user-guide.md#统一图标与操作提示2026-11-13源码已实现未安装) | 62动作生产单源，自有页面已迁移；Linux真实Electron多格式／全部设置分类／批注涂鸦／保存冷恢复及823单元、29审阅提示回归通过 | 未安装／发布；其他平台未验，真实TeX编译因本机缺工具链未通过，不扩大验收 |
| SEARCH-001 | 项目文件与内容搜索 | [主合同](../project-search-design.md) | [选型驱动](../../evaluation/project-search/engine-probe.mjs)、主源码本机安装验收见testing.md | 极简一行搜索＋原省略菜单，文件/内容同引擎；2026-11-14主树38回归/实包11项/保存冷恢复5项通过并本机安装，其他平台未验 |
| WINDOWS-001 | Windows x64 原生桌面与本地发行整合 | [跨平台合同与实施](../platform-phase2-handoff.md)、[资格清单](../windows-w0-w5-qualification.md) | [整合状态](../status.md#2026-11-18-windows-本地整合完成未发布)、[最终包验收](../testing.md#2026-11-18-windows-本地整合验证限定通过未公开发布) | 已本地合main、beta8对齐；最终95d14e5 Windows新编包GUI7项／业务安全14项通过，不推送／公开／替换日常安装；完整W0–W5、签名和物理设备资格未扩大 |

前期记忆候选研究：[研究记录](../long-term-memory-evaluation.md)；仅来源参考，不与MEMORY-001并列成为另一实施合同。

最新验收（2026-11-08）：安装版当前真实项目在原额度2下完成采用报告选源、同线程连续补充及busy排队、discard历史选源、正常重启无重放和待审结果不晋升记忆；[证据与用户现场](../result-memory-implementation.md#按当前项目状态调整的真实安装版深测2026-11-08)。保留A/旧测试待审与B排队，不自动决定成果；B未执行和模型对版本指纹的过度解释明确未通过/未验边界。

后续修复：版本指纹误解已在协议/角色规则中澄清，36项回归及真实模型样本核对通过；随后已安装`2026-11-08T01-38-35-481Z`并用真实项目实际工具复测。[分析](../result-memory-implementation.md#版本指纹被误读为维护动作分析与修复2026-11-08源码未安装)与[安装验收](../result-memory-implementation.md#版本语义澄清安装及实际工具复测2026-11-08)分别保留；不引入索引功能/遥测，不以单场景通过作全模型保证。

## 已确认决定：2026-11-08

1. Pi拥有原生消息/工具循环、上下文压缩和会话恢复；Nozeli复用这些能力，不建立第二摘要器、压缩队列、聊天历史或短期记忆数据库。
2. Nozeli管理项目/Work归属、用户原文与材料冻结、报告版本、采用事实、权限、生命周期和跨task稳定结果检索/交接。
3. Orchestrator用当前模型按需检索、读原文并选择依据；不新设选源Agent。错误区分检索覆盖、交付协议与模型判断，不能默认增加架构。
4. 压缩相关验收只关注Nozeli提供的版本引用、输入和恢复接口是否连续；不重做Pi自身完整测试或重复建设能力。
5. 后续所有设计通过本Plan Tree维护在Nozeli项目文件内。聊天确认应回写对应主合同，临时证据可留本机，但树内须记录摘要、来源、结果和未验项，不提交用户正文、账号或凭据。

6. 2026-11-08追加：固定模型工作流程优先Pi原生skill固化并按需读取，常驻提示最小化；事件事实不混入整份流程规则。初始化/项目地图、诊断/恢复方法按职责归并，避免每场景新增skill。宿主继续硬性负责身份、预算、停稳、删除和CAS；[技能合同](../role-memory-skills-design.md)与[生命周期实现证据](../project-lifecycle-initialization-design.md#8-源码实施与限定验收2026-11-08)同步维护。源码已接线，真实原生skill读取与受限工具验证通过，不等于模型理解质量或跨平台验收。
