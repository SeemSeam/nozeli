# Windows 冷恢复材料闭包：实现前的实际依赖核对

v56 已将 schema 2 配置读取记录接入原 stdout、冷 journal、完整归档和独立只读读取器，见[本批范围](windows-alpha6-settings-cold.md)。记录/blob FileID 与摘要同时校验；旧 schema、未绑定历史流、孤立/pending/未确认尾部明确保留未知。此更新不证明首次读取到 stdout 确认之间的完整生命周期 custody，也不授予 helper/home 释放。下文中的 v55 未接入描述保留为历史状态。

2026-11-14续作：metadata新增原生消费前字节／父目录／FileID记录和身份＋字节替换交接，由原始start及flush stdin/stdout head认证；私密解析cause不携带原文。角色SKILL.md新增schema2原始读取记录、发行路径各级身份与私有解析目录身份：SDK真实loader解析前先pin已发布副本，解析后同HANDLE及名称重新验证；read工具读取同一保留字节，restricted预算处理保留。证据目录句柄在owner生命周期内保管，stop最终flush后按逆序关闭；关闭不等于helper/home处置。

本VM源码Node／Electron角色专项各40/40，真实原owner metadata／角色start与cold解释专项各2/2；Node真实归档专项2/2，Electron独立归档与最终包仍另记。缺失/重复start、仅后续flush、旧schema、额外成员、未确认head不得构成完整消费权威。同字节替换解析文件、解析目录与根目录均按原身份拒绝。这只覆盖明确读取边界；SDK/import/node_modules完整实际加载、journal创建/append、图片/分支/压缩、业务pending协调、完整释放状态机和祖代已释放后的后继验证仍未完成，原helper与home继续保留。

2026-11-12。承接 v50 原 home 目录 custody 与 v51 归档；本文是后续实现规格，不是资源释放资格。固定 alpha.6＋已合并 PR27，SDK `@earendil-works/pi-coding-agent@1.4.0`。

## 已确认的读取链

| 材料 | 实际读取位置 | 当前证据与缺口 |
| --- | --- | --- |
| owner home / config / environment / temporary | `experimental-pi-owner-launch.mjs` 创建并保管原目录链；完整冷文件树由 `cold-evidence-archive.mjs` 复制 | 原 helper 保管 home 本体及父链，尚未在 owner 首次运行前保管 home 内以后产生的全部文件；冷快照不能倒推全生命周期 |
| 会话 metadata 与 JSONL | `PiSession.loadMetadata`、`OwnerRuntime.start`、`SessionManager.open`、`journal-io.mjs` | 原 stdout/start/flush 绑定 journal FileID 与摘要；原 metadata 没有同等全生命周期文件保管；未确认 tail 必须保留 UNKNOWN |
| models/auth/global settings | Pi driver 使用 `agentDir/models.json`、`auth.json`、`settings.json` | 位置在 home 下，可以被冷树复制；仍须绑定 owner 实际读取时的版本和外部文件行为，不能仅凭路径推断 |
| project settings | SDK SettingsManager 与 driver 读取 `<cwd>/.pi/settings.json` | 不在 home；角色资源过滤仍保留此处默认 provider/model/thinking 设置。源码真实合成 probe 已证实变化会改变新实例的模型配置 |
| 角色 SKILL.md 与 runtime | `PiSession.startOwner` 发送 rolePackageRoot/catalog；`trustedRoleResources` 从发行包读取 | home 外发行包依赖；目前只验证角色目录和 regular file，运行时 launch 仅长期 pin command、owner entry、native bridge。需要绑定完整实际 runtime/角色闭包 |
| 原始业务、对象与 pending | `cold-business-receipts.mjs`、`cold-tool-custody.mjs`、原生 supervisor stdio | 已有完整集合比较、对象摘要与原 handler receipt 核对；pending 未协调或 handler outcome 未确认不能变成业务 settlement |
| JSONL parentSession | SDK 会话 header 与 branch/fork | probe 中独立打开具有缺失 parentSession 的合成完整 session 成功且原字节不变。该字段本身不证明必须读取父文件；后续须对实际 fork/branch/recover 流程分别验证，不盲目递归遍历任意 header 路径 |
| 图片材料 | bridge normalizeImages 将路径图片读取为 base64 attachment 后交给 driver | 要证明真正恢复时依赖已内嵌的 journal 内容；尚不能把代码转换行为当所有消息/压缩/分支的资格 |

实际 probe：`D:\nozeli-test\20261112-alpha6-git-admin\probe-recovery-dependencies.mjs`，输出同根 `recovery-dependency-probe\results.json`。只使用隔离合成设置与空会话，未读取用户配置、执行模型请求或变更产品运行时。该 probe 是依赖行为证据，不是 closure 验收。

## 下一实现的准入条件

1. 原 owner 首次 resume 前，由原发行包/host 建立完整、有限且不可由冷记录伪造的资源计划。明确区分固定发行资源、运行配置、后续生成日志及业务对象；引用计划须由原 native custody 或原 stdout 绑定，冷数据库同值不能自授权。
2. 对 home 外项目配置选择可核对的读取版本与字节快照。继续尊重 SDK 的项目模型设置权限和更新语义，不为简化闭包而忽略项目设置；捕获、发布和后续变更使用现有目录/文件身份与 CAS。
3. 固定资源须证明原进程实际使用的闭包，不能只 pin 顶层 owner.mjs 后默认所有 import/SDK/native/角色文件不变。包 manifest 不能只列存在文件而忽略实际动态读取；丢失或新增未解释资源拒绝。
4. 后续生成日志在原进程确认创建后立即绑定原实体、版本和最后确认前缀。metadata 原子替换与 journal append 需要各自的交接协议；不能用禁止所有正常写入的读锁冒充可用生命周期。
5. 在原 home/helper 尚存时，独立恢复读取器只读核对归档、完整外部依赖、所有原 operation receipt 和业务/pending revision。证实文件字节可读与可恢复；不启动旧 prompt，不重投工具，不允许未确认 tail 获得业务承认。
6. 资源释放需要单独的完整集合 CAS intent/ready/unknown 状态机：释放前检查、原生 helper 终止确认、原 home 残留与后继 host 冷检查分别设计。关闭结果未知时不重试、不删目录，不从进程列表缺失推断已完成。
7. 后继冷恢复须能在祖代 helper 确认释放后验证同一不可变归档链，同时拒绝归档替换、revision winner、缺代、复制实体和未确认处置。原 `readColdGenerationHistory` 当前要求每代 helper；未实现此替代前不能提前释放。

## 需要的真实验收

除了当前归档八场景，需要新增真实 owner 的项目配置版本变化、发行资源替换/缺失、journal 创建及 metadata 替换交接、图片/分支/压缩恢复、归档独立读取、释放前/后丢回复、部分 helper 停止、home 删除中断以及祖代已处置后二次 host 退出。每个场景保留当前 Worker 候选、未发送草稿、外部赢家和业务零重放。四种宿主和独立包分别核对，普通账户及完整 W0–W5 仍需单独验收。


## 2026-11-12：已同步 journal 字节的只读投影修正

真实 SDK 合成探针 `D:\nozeli-test\20261112-alpha6-git-admin\probe-recovery-session-context.mjs` 已验证实际分支文件在父文件不可用时仍重建相同上下文；带内嵌图片及 compaction 的原条目也可经 `SessionManager.inMemory` 重建。另复现 SDK `open()` 会跳过损坏 JSONL 行，并在读取 v2 会话时改写原文件。因此不能把该 API 当作归档只读验证器。

本次实现只修正 `OwnerRuntime.flush`：从同一次原生 flush/read 得到的有界完整字节，严格校验 UTF-8/JSON、v3 header/session、唯一 entry ID 与已存在 parent，之后构建 SDK 内存视图。entryCount、persistedEntryCount、leaf 和 SHA256 取自同一份字节，不再次按路径读取或迁移。损坏输入在任何本轮投影前拒绝；原字节保留。其他 start/reload/status/recover 的 SDK open 路径仍遵循各自既有行为，本次不授予它们只读资格。

源码 Node/Electron 各 parser 4/4、实际 Pi 原生启动/prompt/取消/退休/损坏快照 5/5 已通过。Pi 实际重建；新候选包及独立包结果见 `D:\nozeli-test\20261112-alpha6-journal-snapshot\development-status.json`。这些结果不证明完整恢复材料生命周期、资源释放或默认 ManagedProjects，正式 v50 基线保持。


新快照包内 Node/Electron parser 各4/4、实际 Pi 定向各5/5、两种真实 Worker 布局各2/2通过；源码 Node 完整 Pi52/52通过。运行后核对43632包内文件、1733冻结文件及36项native输入/输出一致，包SHA256 `3adbfb85c0a940da2c409440beb805dd35cda9d7a1ca2c0fd3a08f6dd1782ce0`。首次完整性脚本将新增Pi路径错误地相对desktop解析而退出，修正根映射后通过；原失败日志保留，未改包字节。源码Electron完整Pi及四宿主ready丢回复的最终结果继续写入本批status，不提前计通过。


本批最终定向结果：源码 Node/Electron 完整 Pi 各52/52；四宿主 parser 各4/4、实际 Pi 定向各5/5、ready提交丢回复冷归档各1/1；独立包 Node/Electron Worker 两布局各2/2。原v51包另完成四宿主完整归档各8/8，不能替代新v52全矩阵。新包全量文件和冻结输入核对通过，结果/首次脚本失败及修正日志均保留。共享Pi改动没有在Linux/macOS执行；其他SDK.open路径及完整恢复闭包、helper释放、pending/default入口、历史共享失败与W0–W5剩余产品/发行门继续未完成。

## 配置管理层提前加载项目扩展：实际新发现

2026-11-12，v53验证结束后的下一批调查。`RuntimeSupervisor.ensureContext`直接创建默认SettingsManager、DefaultPackageManager、DefaultResourceLoader，未使用角色会话的资源过滤。`OwnerRuntime.start`在建立sessionConfig前调用applyProviderConfig；其他provider/model设置入口同样能进入该层，因此仅过滤native session的resourceLoader不能覆盖完整实际读取链。

真实Windows隔离探针 `D:\nozeli-test\20261112-alpha6-resource-closure-audit\probe-supervisor-resource-js.mjs` 只调用OwnerRuntime.ensureInitialized及driver.runtimeSupervisor.getRuntimeSnapshot，项目含合成 `.pi/extensions/synthetic.js`；扩展被执行并在该审计目录写入固定标记，输出extensionExecuted=true、error=null、modelRequests=0。没有访问个人配置或运行模型。先前`.mjs`探针未执行，原因是该SDK自动发现仅支持.ts/.js；两份原始结果都保留，不能把首次未执行当过滤有效。

下一实现需让Nozeli owner的配置管理层和角色会话共享明确的资源加载边界，在package/extension/context discovery前过滤非发行包指令；项目provider/model/thinking及正常设置更新权限继续保留。通过driver可选工厂/资源选项保持上游默认行为，不猴补全局SDK，不用删除项目配置或冻结错误设置简化闭包。实际回归必须覆盖有效JS扩展零执行、缺失/损坏设置、项目模型优先与reload、受信发行角色资源、设置调用及真实Worker。此问题尚未修复，v53候选不含后续修正；完整恢复闭包与资源释放继续拒绝。



## v54：配置管理层提前执行路径已修复，闭包仍待绑定

OwnerRuntime向driver提供可选createRuntimeResources策略，配置管理层和角色会话均在扩展执行前过滤非发行来源；项目模型设置权限和写入/reload保留，随包登录扩展保留命名内联身份。SYSTEM/APPEND显式空输入避免SDK先读后覆盖。真实源码专项及owner回合通过，最终包验证以v54状态为准，见[本批记录](windows-alpha6-runtime-resource-boundary.md)。此前JS探针所示路径已修复。

SDK内部PackageManager仍可能枚举自动发现目录，不能据noExtensions或最终空inventory推断零外部读取。本批没有引入运行配置版本custody或原资源释放；完整import/node_modules/角色与设置的生命周期闭包仍须绑定。

## v55：项目与全局 settings 实际读取记录

SDK SettingsManager.fromStorage 接入 Windows 原生读取；同一份读取字节和项目/父目录/文件身份先进入 owner 私有证据流，再交给 SDK。驱动直接模型查询和登录 deviceId manager 创建覆盖同一入口。SDK 保留优先级、迁移、dirty field 合并及 reload；更新同时比较 FileID 和字节后原子提交，外部赢家、同字节复制实体及 UNKNOWN 均保留。flush 的原 stdout 绑定每 owner 独立 stream head。

这推进了配置实际读取版本边界，但不等于全生命周期 custody：host 原生保管、冷归档完整集合比较和独立只读恢复验证仍须实现；models/auth/import/角色/metadata/journal 的读取与写入交接尚未闭合。原 helper/home 不得据此释放。实现与当前真实验证见 [settings read boundary](windows-alpha6-settings-read-boundary.md)。
