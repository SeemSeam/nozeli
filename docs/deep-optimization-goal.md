# OPT-001 深度优化 Goal：代码闭包、安装占用与分发体积

Date: 2026-11-12
Role: 独立优化目标／实施主合同
Status: 两批G0–G3源码及Linux真实候选已实施；完整unit/integration通过，真实旧客户端升级与退出直接取证已补；G4仍未整体签收，未安装／提交／发布
Scope: 生产可达代码、运行依赖、平台资产、发布归档及自动更新兼容
Registry: [Plan Tree](plantree/README.md)

## 1. Goal

在**保持当前产品能力、离线独立运行、用户数据与恢复契约不退化**的前提下，按“证明并清除真实冗余 → 收紧安装闭包 → 优化分发压缩”的顺序，降低维护复杂度、安装占用和下载体积。结果必须是可构建、可独立运行、可更新／回退、来源可追溯的真实产品，而不是删文件清单或压缩实验。

核心交付：

1. 当前实现的生产入口／依赖／动态资源图，以及逐项删除和保留依据。
2. 完成有限、可回退的代码去冗余及运行闭包清理；删除被替代实现与全部调用者，不增加长期兼容壳。
3. 同提交双平台候选的归档字节、解压文件字节、磁盘实占、文件数、构建与解压成本和功能验收证据。
4. Linux新压缩格式的可行性决定及安全升级路线；若升级链不能闭环，保持现有默认格式，不把实验包当发行完成。
5. Mac在原生主机上取得独立结论；Windows维持现有能力，不因Linux／Mac优化引入破坏或虚构Windows安装包资格。

原研究轮仅授权分析和文档。2026-11-12用户本轮明确授权源码优化、创建独立优化分支／工作树、隔离构建及验证；未授权日常安装、提交、推送、发布、PR或付费模型调用。此前Beta3及图片修复的安装授权不延续到本Goal。

## 2. 优先级与非目标

优先级：正确性／数据安全 > 能力保持 > 六个月维护成本 > 安装占用 > 下载体积 > 构建速度。

- 不以全仓重写、统一框架或文件拆分量作为优化成果。
- 不更换Electron、Pi内核、文档引擎或编辑器来规避本Goal。
- 不恢复CCB运行依赖，不把系统Node／Git、Bash、WSL、Docker变成普通用户前提。
- 不裁中文字体、文档格式、Git认证／LFS、Provider／OAuth协议、终端、图像能力或离线资源以满足数字目标；改变能力需另行明确裁决。
- 不删除错误处理、CAS、保存屏障、进程归属核验、原生权限、UNKNOWN恢复、版本冲突或零重放保护。
- 不自动清理current／previous、缓存、恢复库、旧论文、历史对话或原生会话。
- 不把仓库大小、源码行数、node_modules路径大小或压缩率当作用户实际收益。
- 不为节省重复字节绕过安全解包的链接／权限规则；不删除许可证、通告或对应源码责任。

## 3. 基线和已知测量

### 3.1 固定比较口径

研究基线为Beta3提交 `49ea178d0a85871254a12c7bd33c5445a5938541`，不是未来实施分支的当然起点。用户另开分支时，先固定**实际基线SHA及所有在途功能**。涂鸦讨论／图片能力等未提交工作可能不在该SHA中，必须明确纳入或排除；不得用旧发布树覆盖新功能，也不混入未授权改动。

归档基线：

| 资产／指标 | 精确值 | 说明 |
| --- | ---: | --- |
| Linux x64 tar.gz | 384111951 B（366.32 MiB） | SHA256 `99379fef867532ccc736a44d88e100d8c679135b2744b47d3b9186379405d75e` |
| macOS arm64 ZIP | 382661554 B（364.93 MiB） | SHA256 `2699fdc4cf8b06c33f24667dc8c0176582c8cc18eb4c5a14da7289f12c17c127` |
| Linux解压文件夹磁盘实占 | 1068171264 B（1018.69 MiB） | 本机ext4测量，不是所有文件系统保证 |
| Linux解压目录apparent-size | 990462603 B | du apparent-size口径含目录／链接，不能与ZIP条目直接比较 |
| Mac ZIP条目展开字节总和 | 976049876 B（930.83 MiB） | 非Mac实机磁盘占用；符号链接条目、资源分叉与目录口径须单列 |

下载、解压文件字节、磁盘块实占是三个指标。程序目录、用户配置／会话、下载缓存、旧版回退目录分别报告；不得靠删除用户数据或previous减少“安装体积”。同文件系统比较磁盘实占，硬链接按inode去重，符号链接不跟随到包外。

### 3.2 已完成的压缩实验，不是可安装候选资格

| Linux实验 | 归档字节 | MiB | 条件 |
| --- | ---: | ---: | --- |
| gzip -9 | 382391259 | 364.68 | 全部原内容 |
| zstd -10 -T2 | 317590636 | 302.88 | 全部原内容 |
| zstd -19 -T2 | 287529703 | 274.21 | 全部原内容 |
| xz -6 -T2 | 274982728 | 262.24 | 全部原内容 |
| 平台过滤＋gzip -9 | 359779312 | 343.11 | 排除非目标OpenSSL架构头文件和Canvas musl变体 |
| 平台过滤＋xz -6 | 264300128 | 252.06 | 同上，尚未证明功能无退化 |

四个全内容实验解压所得tar均为1031741440字节，SHA256均为 `bbb6ed73b917f7f91e55a504703e7a6ac015b3d50774987f480805bb6f05a1c9`。这证明当轮内容等价，不证明压缩库、安装、自动更新或Mac资格。计时受并行实验和缓存影响，不作为性能SLA。

Linux gzip -6独立单项排除实测下载差额：非目标架构头文件8.72 MiB；musl Canvas12.99 MiB；全部map7.42 MiB；Git认证管理器及Skia库37.49 MiB（能力风险）；PPT全部WOFF2字体42.15 MiB（能力损失）。各项不能直接相加。

Mac最高Deflate等级逐条重压试算仅节省约1.15 MiB；非目标架构头文件当前占约9.44 MiB ZIP字节。没有Mac新容器／DMG原生实验，不填写其收益承诺。

## 4. 可衡量目标与成功判定

| 维度 | 本Goal要求 | 不能替代验收的指标 |
| --- | --- | --- |
| 代码简洁度 | 每个清理对象有可达性证据；被替代路径／参数／调用者完整删除；必要历史读取边界明确；减少一项明确的重复职责或生产冗余闭包 | 文件变少、改名、拆文件、强行减少行数 |
| 安装闭包 | 优先完成平台定向候选；研究基线下Linux约929 MiB实占为复现实验目标，实际新基线重新测量 | 把全部Node头文件、SDK、字体盲删 |
| 现格式下载 | 研究基线下Linux约343 MiB为平台过滤＋gzip候选参考目标 | 未跑功能就宣称达标 |
| 新格式下载 | 同内容xz约262 MiB，平台过滤组合约252 MiB；作为Linux工程目标区间250–275 MiB，不作硬性能力牺牲门 | 承诺200 MiB以下、将Linux结果外推Mac |
| 能力／可靠性 | 明确保护清单全部保持；修改路径真实应用与失败／恢复验收；零已知新引入P1/P2 | 单元全绿、启动一次、mock转发成功 |
| 跨平台 | Linux x64和Mac arm64分别记录已测／失败／未测，保留Windows源码契约 | Linux通过就签跨平台 |

若实际新基线增加功能导致目标变化，记录增长来源与同基线净收益，不偷偷删能力、不重设基线掩盖回归。零体积收益但有明确维护价值的清理可独立接受，必须标注原因，不能包装成瘦身成果。

## 5. 阶段与退出门

### G0 — 固定现场与构建基线

- 用户自行创建独立分支；实施者不得reset、覆盖或自动合并其它工作树改动。
- 记录baseline SHA、工作树差异、Node／Electron／Pi／Git版本、锁文件摘要、OS／架构／文件系统和构建工具版本。
- 建立源码输入清单、发行物清单及保留能力清单；明确首次构建缺失供应归档与缓存，沿固定来源校验，不复用身份不明的产物。
- 运行基线真实应用旅程并登记既有失败；用户已报告的失败是事实，不为确认而重跑。后续只执行修复后或有明确新信息的验证。
- 输出基线归因：按组件的原始字节／压缩贡献／文件数及大文件重复inode情况。

退出门：同基线可构建，候选与原件隔离，输入／归档身份确定，既有失败与本轮范围可区分。

### G1 — 生产可达性与冗余审计，先证明再删除

候选落点：`apps/desktop/src/agents/managed-projects.mjs`、`src/agents/managed/`旧适配器、`src/main/main.cjs`接线、`src/renderer/app.mjs`及现有讨论／保存模块；均为调查入口，不是已证死代码名单。

每个对象登记：

| 字段 | 必填内容 |
| --- | --- |
| 对象 | 模块／导出／依赖／资源的准确路径与版本 |
| 入口 | 主进程、preload、renderer、Worker、Pi子进程、CLI、导出和更新助手的消费者 |
| 动态边界 | dynamic import、require、Worker URL、子进程entry、package exports、插件发现、CSS／字体URL和构建生成路径 |
| 判断 | 当前执行／只读历史／迁移恢复／开发测试／已不可达／待核实 |
| 依据 | 符号引用、入口图、包导出、真实运行路径；不能仅靠grep零命中 |
| 动作 | 删除、降为构建期、保留及原因，或需用户决策 |
| 验收 | 受影响用户旅程、历史样本、异常路径、撤销／恢复证据 |

旧后端拆成“现行执行”和“必要历史／遗留进程回收”。新执行一律Pi不意味着可以删历史解码、原会话身份或进程归属核验。不能以模块名含omp／legacy作为删除依据。

对重复发送／保存／回执状态机，只在语义相同处复用原模块；保留项目／版本、pending身份、IME、新输入、回执未知和晚到保护。不要新建万能调度层；共享化后删除旧实现，迁移所有调用者，不保留兼容别名。

Monaco和CodeMirror当前同时在用；先列各自编辑、Diff、语言、只读与格式化职责，不强行统一引擎。只拆大入口不计完成。

退出门：审计表闭合；本批删除和接口迁移完成；历史与恢复行为有证据；每批能单独回退。不以产出一个包装层结束。

### G2 — 收紧安装闭包，保持现有归档格式

优先清单：

1. `tools/local-release.mjs`与Mac打包共用的依赖／源过滤：检查只参与前端构建却随包的CodeMirror／Lezer等是否还有宿主消费者，确认后调整分类，保留编译产物与通告。
2. `tools/package-pi-runtime.mjs`：按OS＋架构＋libc处理原生变体，保持平台能力声明；不按arch一刀切忽略glibc/musl。Node/OpenSSL保留本机编译必需头文件，验证实际包含链和原生N-API编译；非目标交叉编译不默认为当前产品合同。
3. Pi SDK逐包核对exports、动态资源、供应商、OAuth、图片处理、内建工具和恢复入口。去掉无消费者的重复分发，而不是只留下默认模型依赖。先不删声明／map，证明用途后按白名单处理。
4. 保留原Node/Pi/Git私有运行，不要求用户自行安装。不能直接改成Electron run-as-node来省独立Node，除非另立架构决策并证明进程／ABI／工具／权限全契约，不属本Goal默认路径。
5. 自有网页PNG可无损转换；验证RGBA、透明度／颜色、资源引用及原生图标／Office导出消费者；不修改论文内容或随意重编码第三方原件。
6. Node符号分离仅操作新候选，保留动态符号、上游档案摘要、处理工具与输出摘要；新NODE-RUNTIME.json与实际二进制一致。Mac处理须在签名前并原生复验。

每项记录include／exclude准确规则、原因、平台条件、消费者及来源责任。不采用全局“删所有map／ts／docs／headers”规则。

退出门：干净新输出下构建；模块／资源加载、真实原生图像、Pi和Git通过；能力保持；完整归档测量。只在本机原包外做体积模拟不等于本阶段完成。

### G3 — 分发压缩与更新兼容（G2稳定后）

默认研究选择：Linux体积优先以xz -6为候选；zstd保留为速度／集成成本对照。gzip -9兼容现有协议但收益很小；若改变格式的成本不合理，明确保留gzip的决定。

必须一起核对：`tools/package-portable.mjs`、`src/main/auto-update.mjs`、`auto-update-files.mjs`、`auto-update-extract.mjs`、健康／回退助手、发行元数据／校验器、CI及用户说明。当前更新器查固定.tar.gz资产、验证gzip magic与portable-tar.gz字段，不能只改命名或只让新客户端通过。

先形成兼容矩阵：当前已发布客户端→新发行、过渡客户端→后续发行、便携／受管安装、下载中断、校验失败、不安全归档、候选启动失败、健康超时、用户忙碌／未保存／驻留网页。分别定义能够完成的升级路径，不能承诺已经损坏的旧更新器自动修好。

旧客户端兼容策略在实施阶段必须明确：必要时发行同时提供传统gzip与新格式，或先发布只升级解包能力的过渡版本。临时双资产只作为有退役条件的分发协议过渡，不是业务代码兼容壳；未经用户授权不实际发布过渡版本。若不能给出安全可达的路径，不切换默认格式。

解压库随应用交付或复用平台已验证机制；普通用户不得被要求安装xz/zstd或运行终端命令。校验压缩和解压大小上限、路径遍历、链接、权限、重复条目、并发变更与中断回收；原tag／SHA／闲时退出／健康确认／回退规则不放宽。

Mac默认保留ditto ZIP；可在原生Mac研究DMG/LZFSE等容器，但不能拿Linux tar结果推断Mac收益。保留应用bundle布局、可执行权限、符号链接／资源分叉、codesign deep/strict和实际Node／Pi／Git运行。ad-hoc仍不是Developer ID／公证。

退出门：全内容格式变更有还原清单一致性证明；过滤变更与压缩收益分开；旧客户端矩阵和故障回退真实通过。格式本身更小但不能安全升级时只能记实验结论。

### G4 — 最终集成与交付资格

- 基于最终SHA干净重建；不得将早期包重新标注为新提交。未提交候选先冻结输入摘要，不声称是已发布资格。
- 保留单项与组合对照，最终报告实际整包数字；压缩差额不相加，gzip与ZIP同一分类也不能直接当等效指标。
- 所有影响路径通过下节真实验收，未测平台单列；有新P1/P2不签完成。
- 更新用户指南、测试／状态、来源清单、锁文件和发布工具合同；保留历史原件，不回写旧tag／附件。
- 提交、推送、安装、发布分别需要当轮授权；本Goal完成可止于已验证独立候选，不自动创建PR或切换current。

## 6. 验收矩阵

| 范围 | 真实验收与失败边界 |
| --- | --- |
| 独立启动 | 无系统Node／Git依赖，隔离profile，未配置AI仍可阅读；实际归档可执行文件而非仅源码模式 |
| 阅读／编辑 | 当前支持的PDF、文本／Markdown／TeX／BibTeX／代码、图片、DOCX、XLSX、PPTX及既有旧DOC导入子集；保存／撤销／冷恢复；字体／公式／图像和原件保持 |
| 材料／讨论 | 文件／选区／涂鸦带图与位置进入真实Pi协议请求；前台／后台／续问、排队／重复点击／晚到；未发送草稿不被清空；回环只证明送达，不冒称模型理解 |
| Pi能力 | 当前支持的协议／Provider、模型与thinking／图片能力配置、OAuth入口／凭据保持、工具调用、受限模式、取消、原生日志恢复、未知请求不重放；没有账号的真实OAuth单列未验 |
| Git | 包内Git真实init／worktree／diff／候选发布／并发冲突／采用／丢弃；认证助手和LFS不默删；无需用用户远端凭据试验 |
| 原生依赖 | 平台Canvas加载、PNG读写／合成、PDF／Office消费者；目标Node头文件实际编译并加载最小N-API模块；终端PTY输入／Ctrl-C／关闭回收 |
| 窗口与现场 | 原生分屏、独立窗往返、局部讨论、编辑器／草稿／选区／滚动与撤销保留；不靠重建空现场通过 |
| 旧数据 | 合成旧历史、只读档案与遗留进程回收样本；不连接旧执行后端，不改旧消息／身份，不删除旧恢复记录 |
| 更新／回退 | 真实包下载／校验／解压／闲时准入／正常退出／新实例健康／previous；失败／中断／恶意归档拒绝；旧客户端与不同安装布局分别验证 |
| 资源与性能 | 固定主机冷／暖启动、打开首文件、首个Pi调用、解压CPU／峰值内存／临时磁盘和失败清理；不得增加用户可感知停顿而不披露 |

复用已有测试入口：`tools/test-suites.mjs`、`desktop-ci-smoke.mjs`、`desktop-office-journey-live.mjs`、`desktop-task-workspace-live.mjs`、`desktop-platform-chrome-live.mjs`、`desktop-timeline-order-live.mjs`及当前材料／原生／更新专项。开始时从实际package scripts和docs/testing.md确认名称，不按旧路径猜测。构建／测试不是唯一证明，必须运行实际候选程序。

新增永久测试只覆盖消费者可见行为、边界、状态转换和真实失败；不测源字符串、转发回声或目录数。旧措辞／实现细节断言删除，不为了重构重新锁定措辞。基线旧测试失败查明阶段并如实记录，不能跳过业务断言或改产品以迁就旧夹具。

## 7. 交付物与证据格式

不建立第二套任务运行账本；沿本主合同按阶段附实际状态，宿主Work与执行事实仍是权威。

每批至少保留：

- baseline／candidate SHA或冻结输入摘要，准确平台与版本；源代码与打包过滤差异清单。
- `reachability`表：对象、入口、动态消费者、判定、证据、动作、保留能力。
- `inventory`清单：相对路径、文件种类、字节、SHA256、权限／链接关系、来源；不包含个人文件或凭据。
- `size`结果：归档精确字节、相同口径解压文件字节／磁盘实占、文件数、算法与参数、依赖版本、测量环境。
- 实际程序旅程报告／截图、协议端取材证明及故障／恢复结果；合成／回环／真实模型边界分列。
- 反向恢复说明：仅回退本批源码或候选目录，不重置个人业务状态；新格式不得让旧实例读取无法理解的新持久schema。

可直接开始的实施输入：用户实际新分支基线＋本Goal＋当前[测试入口](testing.md)／[能力边界](status.md)／[来源清单](../apps/desktop/SOURCES.md)／[发布合同](release.md)。

## 8. 停止与回退条件

遇到未确定的动态消费者、平台原生资格缺失、无法核实的旧身份、缺少来源／通告、不可回退的更新路径时，保留原实现，不靠fallback或静默功能削减继续。先完成不受阻范围，登记确切缺口；未达完整目标不能标“全部完成”。

若优化使当前能力依赖联网、外部系统工具或运行时下载，或者需要更换存储／会话协议，已超出默认Goal，必须先让用户决定。数字收益不能替代这个决策。

## 9. 当前状态与研究原件

- 本轮实施工作树 `/var/tmp/nozeli-opt-001-20261112`，分支 `opt/001-deep-optimization-20261112`；实际基线 `ad864bbfd0363fadcd2d0b2de0e23e4d34bdafdc`，不是研究基线49ea178。`d184c07`已提交全部涂鸦讨论／图片修复，`ad864bb`补记其安装验收；用户提及的图片工作树当前干净，无需自动合并未提交内容。原树及其分支保持原样。
- 登记入口原树 `integration/release-alpha5-linear-20261104` HEAD=`294f91f090db53ed8e0a1b43212878876813a533`，相对origin/main ahead 1/behind 22；原树在途仅Plan Tree登记、未跟踪本合同及两组evaluation。仅复制本合同与登记入口进入优化树，不纳入evaluation或旧集成分支代码。
- G0隔离基线已用原树 `packageRelease` 构建至 `/var/tmp/nozeli-opt001-evidence/baseline/releases/baseline`，未调用安装器、未切current/previous。供应来自干净图片树锁定实体依赖及既有构建物，后续候选重新构建；Node归档由打包器按固定摘要验证。
- 环境 Linux x64，内核7.0.0-38-generic、ext4；宿主Node v22.22.1/npm9.2.0、Git2.53.0、GCC15.2.0。desktop锁SHA256=`6879b599e94c33dab15989c43ebe119e173ddd782e1d4a77ea9ef0c83b73b26c`，Pi锁=`75df4c4bab553bed682bcdb9e7f6ef94eabd874117a9120059444af48b09d3f6`。Linux通过不代表Mac/Windows；尚未取得原生Mac/Windows主机资格。
- 研究测量原件：`/var/tmp/nozeli-compression-analysis-7jfqwdgx/` 的measure.py、ablate.py、second.py、measurements.json、final-measurements.json、roundtrip.json、mac-deflate.json。一次性压缩输出／strip副本已删除，测量与脚本保留。
- 核心测量、命令参数、判定与边界已内嵌本文，不依赖临时目录存在才能理解或开始实施。未来基线变化必须重新测量；本机绝对证据路径不是产品或测试运行依赖。
- 未为研究结果签署第三方分发审核；六项既有pending不能改为通过。新优化版本不继承旧公开例外授权。

## 10. G0–G4 本轮执行证据（2026-11-12，未提交候选）

### G0：已构建隔离基线

`packageRelease`在4.62秒内完成基线打包及私有Node/Pi/Git验证；该时间为本机暖缓存单次，不是SLA。基线实包 `desktop-ci-smoke.mjs` 通过未配置AI启动、原生阅读／编辑实际保存、保存屏障期间快速切项目、正常退出及冷恢复零重放，两个exit0、renderer错误0。报告：优化树 `apps/desktop/.test-output/ci/smoke-O8YqVY/report.json`。误以源码入口启动且尚未构建dist的一次烟测超时保留在 `smoke-lGqkgv`，不是实包基线失败。

基线安装清单 `/var/tmp/nozeli-opt001-evidence/baseline-inventory.json` 包含每个文件的SHA256、权限、链接和inode，链接不跟随到包外；本轮生成合成资料，无个人论文／账号。归档为未提交开发快照，不写发行资格；`baseline.tar.gz`=383654958字节，SHA256=`8d14fbfbeaa2b47c0724193ddb51242a16d762f386d5572393c1147121255be9`。真实文件字节990080524、文件23147、块实占1067769856（不含根目录本身块）；目录／链接计入块、不计文件字节。程序、配置、缓存、previous不混计；本轮不清理用户目录。

| 基线组件 | 文件字节 | 文件数 | ext4块字节 |
| --- | ---: | ---: | ---: |
| Electron及其余根文件 | 296717161 | 78 | 296927232 |
| 网页／图标assets | 9420948 | 30 | 9510912 |
| 编译renderer／Office／字体 | 90062479 | 432 | 91873280 |
| 独立Pi闭包 | 114311670 | 15231 | 165023744 |
| 宿主npm闭包／Git | 276950334 | 2178 | 284413952 |
| 私有Node／头文件 | 196453857 | 4751 | 212672512 |
| 产品src | 6164075 | 447 | 7348224 |

来源检查初次仅缺隔离树未跟踪的PPT上游归档，2项技术失败，六项人工分发审核仍pending；随后从已知干净图片树补入原始归档，按既有inventory摘要复核，不改通告或放宽检查。

### G3：默认保持gzip，不切换更新协议

代码事实：`auto-update.mjs`只选择确切`.tar.gz`名称；`auto-update-files.mjs`要求`portable-tar.gz`元数据及`1f8b08`magic；worker使用随包tar。便携打包器及CI／发布说明仍依此协议。Linux主机的xz命令不是用户可依赖的解包器；本轮未引入新压缩库，也没有已授权过渡发布，因此不切换默认格式。Mac保留原生ditto ZIP；不从Linux推断DMG资格。

| 客户端／布局 | 后续gzip发行路径 | 仅xz发行路径 | 本轮决定／边界 |
| --- | --- | --- | --- |
| 现有受支持Linux便携客户端 | 原名称＋SHA＋tag＋安全解包＋健康确认 | 找不到资产，不可升级 | 保留gzip；待本轮真实回退实测 |
| 现有受支持Linux受管客户端 | 同协议，current/previous原子晋升 | 找不到资产，不可升级 | 保留gzip；待本轮真实回退实测 |
| 旧版目录权限不符合所有权规则 | 明确拒绝，需所有者另行授权修复 | 同样不允许绕过 | 不自动chmod、不伪造支持 |
| alpha.3等没有检测器的旧实例 | 用户正常退出后手动完整安装 | 无自动路径 | 不承诺旧程序自动修复 |
| 假设过渡客户端 | 必须先实现随包解包器及全部故障门 | 尚无客户端／发布 | 不发布、不宣称已实现 |
| Mac／Windows | 保留现有仅检查／手动路径 | 未实现 | 原生资格未验 |

若未来另行授权新格式，应先在同内容清单上证明往返一致并通过中断／校验／恶意链接与权限／启动失败／健康超时／忙态／未保存／驻留网页矩阵，然后发布仍含gzip的过渡资产；退役旧资产必须有已验证可达迁移与独立裁决。本轮没有临时业务兼容壳，没有更改持久化schema，也不重写旧tag／附件。


### G1：本批可达性审计与有限清理

路径相对`apps/desktop/`。本批不把旧模块名当死代码依据，不删除历史身份或安全恢复实现。

| 对象 | 生产入口／动态消费者证据 | 判定与动作 | 验收／保护 |
| --- | --- | --- | --- |
| `managed-projects.mjs`的`ompSystemSource/ompAuthBroker/ompCommand/ompOptions` | main已只传Pi；`Controller.open`显式解构只接受Pi设置，从未接收这三项；回收只读持久record/runtimeRoot | 删除无效构造入参、对象分配和转发，迁移四个测试／探针；不是移除旧历史 | 历史／session index／归属专项；零schema改变 |
| 管理器重复dynamic import Workspace／pinSessionFileById | 同模块本已静态加载，非插件发现边界 | 复用既有导入，删除重复动态导入 | 冷待办读取不启动Agent、历史ID精确匹配 |
| Controller→PiSession | main动态import Pi runtime/source/auth；Controller默认两处创建PiSession | 现行执行，保留 | 实包Pi／工具／文件／Git旅程 |
| `omp-process-ownership`、通用`process-ownership` | manager/controller按持久kind分派；核对PID出生、home、命令和进程组 | 必要遗留进程回收，保留 | 错身份拒绝、UNKNOWN不释放名额 |
| `omp-tui-session/omp-terminal-bridge/omp-provider-home` | 显式sessionFactory开发测试；`compare-orchestrator-efficiency`及候选`desktop-workflow-continuation-live`动态加载；桥代码生成到provider home | 开发／旧协议仍有消费者，保留，不声称生产已全部不可达 | 不连接旧后端、不重放 |
| `omp-runtime` | privilege-broker动态导入resolver仍列为候选 | 保留源模块；不恢复原OMP产品执行 | 不静默删特权代理候选或绕过校验 |
| `omp-credentials/omp-system-source` | Pi直接用scrubProviderEnv；nozeli-config仍用来源／home及导入词汇 | 现行安全／配置消费者，保留 | 凭据隔离及显式导入 |
| `session-index/resident-history/worker-archive/restart-recovery` | timeline/archive IPC、原生日志ID、SHA、work/archive身份、有界只读及admission/leaf核验 | 当前／历史恢复保留 | 原消息身份、不可变字节、未知效果零重放 |
| roles.json、memory.md、skills | runtime fs读取及Pi按需动态加载 | 离线动态资源，全部保留 | 不删prompt／skill或要求联网 |
| CodeMirror state/merge/view/language、Lezer | host动态import state；tag-anchors用merge diff并传递加载view/language；isolated-preview/html-report用html/css/javascript | 确有宿主与动态消费者，保持生产分类 | 不以renderer已编译为由删宿主依赖 |
| Monaco／CodeMirror | Monaco负责代码及worker；CodeMirror负责文本／Markdown／TeX、Diff及宿主锚点映射 | 两套职责不同，不换引擎 | 编辑／只读／Diff／格式化原职责保留 |

定向7文件初轮81通过、1失败、2个未传候选的原生验收跳过；唯一失败是旧PTY测试额外断言“glibc也保留musl Canvas”。删除该过时断言、不重锁相反实现细节；新平台行为矩阵和真实原生探针另验。release-retention＋真实Electron更新／失败回退最终17/17；candidate原生专项6/6且零跳过。默认unit842/842。旧agent-resource-native OMP YAML／崩溃夹具及广义旧离线GUI仍有历史架构不匹配边界，不冒称它们已通过。

### G2：有限目标过滤与实际候选

- `dependencyIncluded/applicationDependencyIncluded`共用已知Canvas optional包边界过滤：OS＋arch不符可排除；Linux只有`process.report`证明glibc／musl才删另一libc，未知保留两种，未知未来变体保留。root及nested node_modules均覆盖，不匹配普通assets路径；JS loader、资源、声明和通告不动。现有PTY目标规则不放宽。
- `packagePiRuntime`先验证固定Node归档SHA，再仅在新候选内裁OpenSSL已知非目标arch目录。Linux x64保留linux-x86_64，Mac arm64设计保留darwin64-arm64-cc；目标asm／asm_avx2／no-asm链须先存在，否则删除前失败。未知平台／arch／目录保留。所有Node/V8/N-API公共头、目标OpenSSL、二进制、动态符号与上游许可保留；没有strip，NODE-RUNTIME.json继续记原归档及实际可执行摘要。
- 不调package／lock，不删SDK／Provider／OAuth／图片／恢复工具、map／声明、字体或Git认证／LFS，不改私有Node架构、不引入系统Node/Git前提。Mac现有打包器共用规则，但未取得原生验证资格。
- 全新候选`/var/tmp/nozeli-opt001-evidence/candidate/releases/candidate`于12.26秒完成打包／runtime验证；Pi driver及renderer本轮重建成功（2.32秒）。宿主Node22.22.1，包内Node22.23.4／Electron44.9.1／Pi1.4.0。真实候选最小N-API在默认与OPENSSL_NO_ASM下均用保留头编译并由包内Node加载；Canvas离线PNG编解码／合成验证RGBA及透明像素；包内Git在PATH空时init、commit、worktree、diff通过，原文件不变。
- 清单证明只删2272个文件、86378998字节：Canvas musl的4个文件33112890字节＋非目标OpenSSL的2268个文件53266108字节。607个保留字体／许可证／通告逐字节相同；更新模块逐字节相同。证据`removed-files.json`、`preservation.json`与两份inventory均在本轮evidence根。

| Linux x64实包指标 | 基线ad864bb快照 | 优化候选 | 实测差额 |
| --- | ---: | ---: | ---: |
| gzip默认tar归档字节 | 383654958 | 360915610 | -22739348 |
| 普通文件字节 | 990080524 | 903649300 | -86431224 |
| ext4块实占（不含根目录块） | 1067769856 | 973676544 | -94093312 |
| 普通文件数 | 23147 | 20875 | -2272 |

候选归档SHA256=`9af34141a19d376f04f1ef581a6fada76d8e58e864f58619391063ef2d50b137`。这是`packageRelease`开发快照tar，不伪装有RELEASE.json/AppRun的正式发行；现有发行工具要求干净已提交树，本轮未获commit授权，不绕过此门。

归因限制：安装总差额另含管理器源码368字节和renderer重建51858字节。后者来自基线旧dist保留`../../../nozeli-beta2-release/...`构建依赖路径，重建在实体node_modules下生成本地相对路径；不将其算成功能删除／闭包优化收益，也不把22.74MB归档差额拆开相加。确定闭包文件净减少86378998字节、块净减少94040064字节；完整归档差额受路径／时间元数据与重建漂移影响。当前包约344.20MiB下载／928.57MiB磁盘，数字不代替功能资格。


### G3实测与G4最终冻结

默认gzip决定已用真实流程验证：`release-retention + auto-update-package-smoke`17/17，包括真实Electron的受管／便携正常晋升、启动失败回退、旧目录保留。完整真实Nozeli更新`apps/desktop/.test-output/desktop-auto-update-C2uyRJ/report.json`通过实际回环下载／SHA／tag／解包、403失败保留旧安装、设置模态阻止重启、闲时正常退出、新实例健康、previous及合成用户数据保持、独立新调试端点与正常退出／锁回收。这里只用隔离安装布局，没有改变日常current/previous。真实旧已发布客户端跨版本、下载中断／恶意归档／健康超时的完整原生矩阵未一概签收；现有确定性安全回归与真实小应用回退分列，不冒充全产品故障矩阵。

最终重新打包`/var/tmp/nozeli-opt001-evidence/final/releases/final`，归档`final.tar.gz` **360838370字节**、SHA256=`dddf98e9a04fd5b971b7ae1272d81698e373bb17472b4749c4643b0612dd395a`；文件903650268字节、20875个，staging块973680640。相对基线归档少22816588字节，文件少86430256字节；最终SOURCES补记968字节，归档根名／时间元数据不同导致与前候选归档再差77240字节，不能把这部分当进一步优化。

冻结输入`source-inputs.json`（653个受管非测试产品／构建输入）SHA256=`8ba289bf374b73ef9e28618cd1e5555d4aa5e4b973c25a192fe54f548d2d06a8`；最终完整包清单`final-inventory.json` SHA256=`231dd20890d370141fc2e4d09d17b9b855292e5403326705c9d7af09efdf082c`，二者均在本轮evidence根。候选／最终包运行代码、renderer、Pi与Node/Git逐字节一致，仅INSTALLATION时间及SOURCES说明变化，证据`final-equivalence.json`。不是最终提交SHA，不标发布资格。

GNU tar gzip默认参数本机暖缓存构建28.07秒（user27.27/sys1.48秒、time报告峰值3280KiB），解压4.19秒（user2.88/sys1.26、峰值3324KiB）。该time最大RSS是工具报告口径，不是整棵解压进程并发RSS求和；系统有并发验收，不作为性能SLA。基线解压4.35秒（user3.01/sys1.42、峰值3176KiB）。临时解压磁盘按实际完整包另计，不删用户缓存／previous换数字。

`roundtrip.json`证明23678个条目路径／种类／文件字节／SHA／符号链接目标一致，`tar -xpzf`显式保留权限时mode也逐项一致。普通`tar -xzf`受当前严格umask影响72个条目的组／其他权限收紧，owner可执行位不变；该解压实包已实际启动／保存冷恢复。块分配staging973680640／普通解压973684736／显式权限解压973676544，不把文件系统目录块波动当产品差异。完整临时包仅保留本轮隔离目录，未侵入用户profile。

| 验收面 | Linux x64实测 | macOS arm64 | Windows |
| --- | --- | --- | --- |
| 未配置AI启动／原生保存／切项目屏障／冷恢复 | 最终解压ELF `smoke-LUuIrT`两次exit0，renderer错误0 | 未验 | 未验 |
| 阅读／批注／未保存正文恢复 | `nozeli-reading-native-GD57DA`通过真实Unicode选择、冻结原文／精确恢复字节；原备注保留 | 未验 | 未验 |
| 文本／Markdown公式／TeX／BibTeX／Monaco代码／PDF／PNG／旧DOC | 最终解压程序`nozeli-opt001-reader-klPPvP`九项通过；中文PDF画布／文本层、KaTeX、RGBA、DOC导入副本及原件逐字节保持，截图已查看；不声称TeX编译 | 未验 | 未验 |
| 图片／材料／前后台／续问／Git任务 | `nozeli-drawing-background-XWQ56u`全部检查通过，真实包内Pi＋回环HTTP＋真实worktree；归一化红笔像素／来源限制到达 | 未验 | 未验 |
| 原生Node／Canvas／Git | 目标OpenSSL头N-API asm/no-asm编译加载及PNG合成6/6；私有Git空PATH init/commit/worktree/diff通过 | 仅规则矩阵，不是原生资格 | 仅规则矩阵，不是原生资格 |
| PTY与窗口现场 | `nozeli-project-terminal-SsoSMV`真实输入／Ctrl-C／浮动回嵌／关闭进程回收／冷开不重放；`nozeli-platform-chrome-r8dHjP`通过 | 未验原生菜单／签名／Node/Pi/Git | 未验ConPTY |
| 历史／UNKNOWN／零重放 | 定向旧档案／session index／进程归属通过，未删原恢复代码 | 原生进程归属未验 | 原生进程归属未验 |
| 更新／回退 | 真实双布局Electron失败回退＋完整Nozeli健康更新通过，其他故障矩阵边界保留 | 自动安装本就未实现 | 自动安装本就未实现 |
| 账号／OAuth／Provider／受限工具 | 保留完整闭包；本地合成OpenAI兼容HTTP送达不是全Provider／OAuth实际登录资格 | 未验 | 未验 |

**失败原件与修正**：图片旅程初次`QIYWLh`两个并发Puppeteer pointer手势互相覆盖，未形成派工；只改为连续完整trusted clicks，唯一受理／图像／草稿断言不放宽，修后`XWQ56u`通过。阅读`Gd3M0K`截图实际已显示本地备注，旧断言要求卡片仍嵌在text-preview；现按当前浮动可见正文核对，精确锚点／冻结摘要／未保存恢复断言不变，修后`GD57DA`通过。一次性格式矩阵`7Lp6lj`未trim标题文本导致误判，修正文本比较后`klPPvP`通过；无产品fallback。

**回退**：源码仅回退本批管理器、打包过滤及相应测试／文档；不reset原树、不切用户安装、不回写持久记录。当前基线包与优化／最终包均为隔离目录，可停止并弃用本批候选而不触碰用户profile。G1无schema改变；G2只影响新输出；G3未变协议。若后续原生平台／动态消费者发现缺口，保留对应未证明资源，不以删功能或放宽门补数字。

**G4尚未整体签收**：无已配置SSH主机，现有文档只登记历史Mac本机／GitHub runner；本轮无提交／推送授权，不能靠上传源码触发原生Mac CI。Mac同输入新包及签名／资源叉／符号链接／Node/Pi/Git、Windows原生能力均为明确未验；真实账号OAuth、全部Provider协议／受限模式、冷启动／首文件／首Pi固定主机性能完整矩阵也未签收。已执行所有可达隔离范围，不把本机源码及Linux候选说成双平台交付完成，六项分发审计仍pending。


#### 原生资格门最终收紧

G4复核按第8节停止条件收紧：Mac虽然目标OpenSSL选择器可静态证明，但本轮没有原生编译／加载证据，**最终源码不启用Mac头文件裁剪**。`pruneNodeHeaders`仅对已真实验证的Linux x64生效，Mac/Windows／其他目标保留上游完整头闭包；回归明确验证Mac和Windows不删除。前文G2“Mac设计保留darwin64-arm64-cc”和最初6项结果是中间候选规则／历史执行记录，不是最终Mac裁剪资格。Canvas已知OS/arch选择与未知保留矩阵不变。Linux输出内容不受这个安全门改变，最终归档不重贴标签；冻结构建输入摘要将另记本次工具限定变化。

最终安全门专项5/5零跳过，仍实际编译／加载Linux目标N-API并验证PNG。`source-inputs-gated.json` SHA256=`35a9b5a4e7818571bd38d5b5eed663f0492eb46eb5fd943b39773a801dfb571d`，相对前冻结653项仅`apps/desktop/tools/package-pi-runtime.mjs`变化，明确只禁用未验Mac头裁剪；产品src／dist／runtime未变。语言服务引用查询尝试返回“No language server found”，本轮以实际显式入口、动态消费者及运行证据核对，未将LSP缺失当成零引用证明。


#### 最终旅程补充与尚未解除的失败

- **Office实包九项全过**：`/var/tmp/nozeli-office-journey-q7T7Dd/report.json`，DOCX原生编辑保存后核对ZIP正文；XLSX慢初始化后原生保存值、格式变更拒绝且原件不变、撤销后可保存；窄PPT保持可用画布及两个原工具面板、编辑／导出副本、源PPT字节不变；外部DOCX冲突拒绝、恢复副本保留；冷开三格式内容保留，两个session均exit0。
- **最终解压程序时间线全过**：`/var/tmp/nozeli-timeline-order-JyPFbW/report.json`，真实Pi／文件／Git四场景；普通对话与两Task按提交次序、原Task补充不移位、新消息置底、冷开原身份及零模型重放／零源变化。
- **Task完整旅程不通过**：`/var/tmp/nozeli-task-workspace-TbEkHp/report.json`。真实双Task／普通讨论／同Worker续问／第二版发布、完整长工具原文读取、内联过程不新建view／window／模型、DOM／草稿保持、明暗1280/390/320及200%阶段已通过；最终`closeNormally`等待30秒实际退出值为null而非exit0，故不签冷恢复。Provider errors为空，日志无明确退出根因，不能无证据归因到环境或称既有缺陷。驱动已写完整失败报告后仍驻留，已终止本轮自建作业；未改产品退出／保存安全门，没有重复跑失败来确认。
- **集成首轮两项失败已闭合调用者**：完整integration执行中暴露另外两个Manager旧OMP配置夹具（`managed-projects.test`的modelFor及`managed-offline-report-export.test`的模拟启动失败），已全部改接当前piSource；删除只比较参数转发相等的旧回声断言，保留最新默认模型生效、历史精确字节／零重连／启动失败／原始数据保持断言。修后两文件50/50零跳过。首轮完整集成不改写为全绿；最终汇总以实际完整TAP为准。

Task退出失败属于尚未归因的真实限定场景，完整Goal继续阻断；不能用其他成功退出旅程覆盖这一失败。当前没有已证明由本批源码优化新引入的P1/P2结论，也不能在此基础上签“零新P1/P2”或全部完成。

完整integration首轮实际1953项：1947通过、2失败、4平台跳过、零cancel，耗时1429.55秒；完整原始TAP为优化树`apps/desktop/.test-output/ci/integration.tap`。两失败正是上述已迁移的旧Manager配置夹具，修后50/50是定向结果，不冒称再次跑过完整integration。新原生过滤测试在该轮启动后才登记，因此该轮180文件不含它；它的最终显式候选5/5另列，不累加伪造全套总数。Task退出另启动**原未优化ad864bb基线实包对照**以增加回归归因信息，而不是重跑优化失败来确认；对照结果待实际输出后追加。


#### 对照归因与最后交付快照

原未优化基线实包Task对照`/var/tmp/nozeli-task-workspace-UJYV6w/report.json`通过完整五阶段；结束完整integration及其他GUI并发后，**相同优化运行时的最终解压程序**串行旅程`/var/tmp/nozeli-task-workspace-EkpCRO/report.json`也完整通过：包括正常退出／冷恢复、原Task／job身份、草稿、源文件保持及零模型重放，Provider errors空。并发负载与是否完整归档解压是本次新增诊断条件，不延长超时或改变产品逻辑／业务断言。`TbEkHp`初轮失败仍保留，根因没有直接进程级证据，不能据单次串行通过断言“只是环境”或已修复并发退出缺陷；整体稳定性资格仍未签收。

完成Mac保留门及来源说明后再独立构建`/var/tmp/nozeli-opt001-evidence/gated/releases/gated`；最终交付归档为 **`gated.tar.gz`=360834065字节**，SHA256=`a45e80458fa73e273e1453650a8881deb0362e6bdd87f5b8f631d1d5eca8fcf6`。普通文件903650397字节、20875个、ext4块973680640；相对真实基线归档净少22820893字节、普通文件少86430127字节、块少94089216。与前final包运行代码／资源／Node/Pi/Git逐字节相同，差异仅INSTALLATION时间及SOURCES最终Linux限定说明，证据`delivery-equivalence.json`。不以新标签覆盖早期包，三个阶段包都分别留证。

`gated-inventory.json` SHA256=`74d03f5ba2b6e926bc2c6ef2225072a30d3f059876f3e66e20d543ffe59f9a14`；最后产品／构建输入`source-inputs-delivery.json` SHA256=`837d5bf04d865db6931f5a09ce06adf1e12e47f269ee9360e759f0df49a458a1`。最后`tar -xpzf`解压真实ELF`unpacked-gated/gated/nozeli`通过`smoke-sR20k1`原生保存／切项目屏障／冷恢复，两个exit0、renderer错误0。归档器GNU tar1.35、gzip1.14默认等级（-6）；用户运行无需tar/gzip命令，这些仅为开发测量工具。


基线组件独立gzip测量`component-compression.json`（GNU tar1.35／gzip1.14默认-6）：

| 组件 | 独立归档字节 | 本机压缩秒 |
| --- | ---: | ---: |
| Electron及根文件 | 123261017 | 8.279 |
| assets | 8403602 | 0.270 |
| renderer／Office／字体 | 60479292 | 1.862 |
| 私有Pi闭包 | 24981896 | 3.002 |
| 宿主npm／Git | 106170101 | 8.143 |
| 私有Node／头文件 | 57247213 | 4.610 |
| 产品src | 1705654 | 0.149 |

这些是同基线各组件单独压缩的归因量，不是可相加的整包边际贡献；字典边界、tar条目和压缩历史不同。临时组件归档测完删除，只保留脚本与JSON；原始inventory逐条含inode，磁盘统计按dev:inode去重，不跟随链接。本轮一次性原生／阅读探针已移除，真实报告、截图、测量JSON与可复核inventory／组件测量脚本保留，不作为产品依赖。

**本轮停止位置**：可达源码实施、Linux完整候选、实际程序／Pi／图像／文件／Git／PTY、旧数据及现gzip更新／失败回退、净收益与来源证据已落盘；没有进行安装、commit、push、PR、tag或附件修改。G4仍blocked而非done：原生Mac／Windows没有本轮可用执行通道；付费／账号OAuth不在授权内；全部Provider及性能矩阵未验；并发Task退出一次失败未获得直接根因，虽然原基线及无并发优化对照均完整通过。继续需要相应原生平台／账号授权与并发退出故障诊断证据，不得用Linux数字代签或恢复旧发布授权。


## 11. 用户要求继续推进（2026-11-12，第二批）

用户本轮要求“继续推进整体项目优化方案”。沿用同一隔离分支／工作树，不覆盖第一批改动、原工作树或图片修复；未扩展安装、commit、push、发布、PR、真实账号或付费模型授权。启动时HEAD仍ad864bb，第一批源码／测试／文档在途修改均完整保留。

本批实际执行范围：

1. 优先追踪Task并发退出失败的真实链路。原失败事实不重跑来确认；新增诊断须采集真实退出准入、保存／进程停稳阶段或可控交错，不能靠延长超时、强退、吞错误或清草稿换通过。
2. 私有Node符号分离：readelf已证Linux x64原二进制含非allocated `.debug_*`、`.symtab/.strtab`及allocated `.dynsym/.dynstr`。只在隔离副本验证收益、动态符号／ABI／N-API／Pi／诊断能力，再选择保守处理；上游归档摘要、原／处理后可执行摘要及工具来源必须保留。Mac/Windows仍不启用未经原生验证的裁剪。
3. 统一干净输出重建与完整回归，补同主机实包首次profile／保留profile启动、首文件交互及首个本地Pi调用的测量。首次profile不冒充清过OS页缓存的冷启动，回环Provider耗时不冒充真实服务性能。真实GUI旅程串行执行，故意并发仅用于明确命名的故障诊断。
4. 沿本合同登记单项／组合净收益与未验边界，不重标早期产物、不改归档协议，不以新增Linux证据替代原生Mac/Windows资格。


第二批前基线使用上一批真实解压`unpacked-gated/gated/nozeli`，`desktop-ci-smoke`新增仅报告耗时、不加通过阈值、不改产品行为。`apps/desktop/.test-output/ci/smoke-wqqRqG/report.json`通过原生保存／切项目保护／正常冷恢复、两个exit0、renderer错误0：首次profile就绪1690.172ms，首文件可交互595.173ms，保留profile重启就绪1493.268ms。这是同主机单次暖页缓存环境，尚非多样本分布或清OS缓存的“冷启动”；后续候选按同入口比较，不以计时单次波动宣称性能提升。


### 11.1 符号处理的保守选择与维护约束

隔离实验原件在`/var/tmp/nozeli-opt001-evidence/node-symbols/experiment.json`：原Node124902584字节；GNU `strip --strip-debug`后121116104字节（减少3786480）；`--strip-unneeded`虽降至107187040字节，却丢失defined native symbols，故拒绝。采用输出的allocated ELF节、动态符号全输出、defined原生符号、N-API、Inspector及JS堆栈实测保持。原调试节保存在外部16625608字节`node.debug`，不混入用户安装体积；原锁定归档始终可恢复完整二进制。此处是孤立二进制证据，新实包资格仍需统一验收。

集成时删除了最初实现的自定义ELF解析器和反复调用readelf/nm的构建逻辑；不把维护者本机GNU Binutils2.46硬编码为所有Linux CI的前提。最终打包只接受原二进制SHA256 `94efd062ed066c1a0b332e18249859c905e920eeada5df55d24c99b919629a90`，执行GNU objcopy/strip后还必须得到已实测的精确输出SHA256 `754e3447ef3af852665c877f97579c210a92168079174d4cfa6aa5a1da37532e`；未知输出在替换候选前明确拒绝。工具版本/参数仍记录，不猜不同工具输出具有相同能力。这既保留正向资格证明，也避免新增一套ELF维护器。Mac/Windows及其他架构不处理。

外部调试证据位于开发构建cache的`symbols/<originalSHA>/`，含`node.debug`、provenance和完整NODE-RUNTIME.json；程序内metadata的sha256Executable从实际处理后二进制重算，归档hash仍为原上游hash。未来分发必须单独保留对应debug artifact，不把cache当用户运行前提或声称六项分发审计已通过。

### 11.2 新的直接证据入口

- Task驱动改为等待正常关闭IPC受理回执，之后仍独立要求原30秒exit0；不再用未观察的renderer timer投递关闭。opt-in阶段观察器在Inspector断开后继续记录WindowRecovery、Pi stop、窗口／quit事件；失败回收仅核对本次ChildProcess后代的PID出生标识和exe，不读environ、不按进程名扫杀。没有证实原生产根因，故暂不改生产退出逻辑。
- 更新驱动支持显式提供不同旧／新真实包目录，仅复制到独占测试布局后修改合成feed所需版本元数据，原件不写。记录两侧main／更新器／Node原字节SHA及原RELEASE身份，避免再次用“同源码换版本”冒充旧客户端兼容。已定位真实Beta3 49ea178解压原件；后续将其更新至本轮新候选，不触碰原tag／附件或用户安装。


### 11.3 新候选的实际构建、收益与恢复代价

统一Pi／renderer重建及来源哈希检查通过（0技术失败、六项人工分发审计仍pending）。全新`/var/tmp/nozeli-opt001-continuation-20261112/candidate/releases/opt001-symbols`构建7991.559ms；实包N-API默认／no-asm编译加载、Canvas、真实Inspector／JS栈／Pi错误协议及身份回收首先8/8，补符号侧包损坏拒绝后9/9，均零跳过。归档已实际解压至`unpacked/opt001-symbols`，未以源码Electron替代。

| Linux程序指标 | 上一批gated | 本批symbols | 本批净减少 |
| --- | ---: | ---: | ---: |
| gzip归档字节 | 360834065 | 360128891 | 705174 |
| 普通文件字节 | 903650397 | 899865814 | 3784583 |
| ext4块实占 | 973680640 | 969895936 | 3784704 |
| 普通文件数 | 20875 | 20875 | 0 |

本批运行归档SHA256=`a5a3c46c49ada93d1fe091e3e6f702f2a7508fe0b89dcb9fe3035f64dd30fd48`。与上一批逐项比较只有INSTALLATION时间、SOURCES说明、NODE-RUNTIME.json和私有Node二进制变化；产品src／renderer／Pi／Git未变，607个字体／许可证／通告逐字节相同，`preservation.json`留证。Node原始节省3786480字节，被metadata新增815及SOURCES新增1082字节抵消一部分；不将原始节省当整包下载收益。

恢复代价单列：外部debug文件16625608字节；实际导出的`Nozeli-0.1.0-beta.3-linux-x64-node-debug.tar.gz`4192134字节，SHA256=`c1e8cf8ab637d121aa7eaccb9d4d460ac7b70c0cd020d1c65e14be25b727c0bb`，含node.debug、provenance.json及完整NODE-RUNTIME.json。普通用户／自动更新只下载程序包，减少705174字节；若维护者同时保存程序包和调试侧包，总归档存储反而比上一批程序包增加3486960字节，不包装成总存储缩减。源码优先保留原生函数名，未为追求更大数字采用strip-unneeded。

Linux正式portable构建现在必须导出侧包并纳入SHA256SUMS，已有CI整目录artifact留存覆盖它；缺失／篡改debug或不匹配provenance会在创建归档前拒绝。当前未获commit授权，正式portable入口仍因在途源码而受干净树门约束；本轮只直接执行同一导出实现并实际读取侧包，不冒称正式发行命令／远端CI已通过。

gzip构建27.74秒（user27.27/sys1.07，time工具RSS3272KiB），解压3.93秒（user2.78/sys1.14，RSS3328KiB）。与上一批同gzip默认参数；有并发integration负载，计时不是跨主机SLA，RSS不冒充整个并发进程树总峰值。


### 11.4 完整回归、真实旧客户端更新与退出直接证据

完整unit：842/842，零失败／零跳过，原始`apps/desktop/.test-output/ci/unit.tap`；完整integration：1962项、1955通过、0失败、7明确跳过，182文件，1479.998秒，原始`integration.tap`。新增损坏调试证据拒绝用例实际进入本轮完整TAP；7跳过为4个Darwin原生资格前提＋3个未传候选路径的包级原生检查，不算通过。显式新候选原生／符号／身份／损坏拒绝定向9/9零跳过已独立实测，不与全套数字重复累计。

- **真实旧Beta3→新候选通过**：`apps/desktop/.test-output/desktop-auto-update-1AMNeu/report.json`，oldInput原RELEASE提交为49ea178；newInput为本批真实解压包，记录双方原main／更新器／Node SHA。只在隔离副本上使用合成版本与回环tag/feed，不改原件或公开发行元数据。实际403失败保留、下载／SHA／解包、设置模态阻止重启、正常退出、current晋升／previous保留、新实例健康及合成用户资料保持均通过。新Node输出SHA由实际旧客户端升级链成功消费；此结果不是已发布新版本或用户安装。
- **图片／Pi／Git真实旅程通过**：`/var/tmp/nozeli-drawing-background-igU0u1/report.json`，前台／续问／后台均携冻结PNG及归一化笔迹位置，重复点击唯一受理、真实Worker工作树写入／发布、原文件保持、窄短窗输入可达。回环证明材料送达，不冒称模型理解或真实账号OAuth。
- **Office、PTY、时间线通过**：本轮实际解压程序`nozeli-office-journey-HjnnQv`完整九项／两次exit0；原生项目终端和时间线报告路径在串行作业原始输出`artifact://303`，需按对应持久报告记录，不以浏览器替身代替文件／Git／真实shell。全部保留原保存／撤销／冲突／冷恢复／进程回收断言。
- **正常Task直接取证通过**：`/var/tmp/nozeli-task-workspace-3m1xk1/report.json`完整五阶段及两个正常退出／冷恢复通过，且有并发integration负载。`shutdown-events.jsonl`记录首次4个Pi owner正常停止各约1121–1124ms，flush→quit1431ms；冷开后2个owner各296–298ms，flush→quit356ms。两轮均无stop-failed或save-unconfirmed，原身份／草稿／原文／零重放保持，`shutdown-summary.json`汇总；不据此证明原TbEkHp已修复。
- **诊断器自身一次失败保留**：`nozeli-task-workspace-Gl4gdU`在发关闭前因Inspector表达式缺少dynamic import callback失败，不是产品退出失败。改为测试侧`vm.compileFunction`使用主上下文默认loader后实际取证可用；未修改产品Loader或安全门。该Node实验性API只在opt-in测试观察器中使用。

为检验诊断分支而非盲重跑原失败，另一次性在测试观察器中将一个真实Pi stop延迟9000ms。`/var/tmp/nozeli-task-workspace-xjJtEo/report.json`按标准Task的exit0要求**预期失败**；直接trace在延迟后8227ms进入stop-failed并保留恢复提示，晚到Pi在9496ms完成也没有偷偷关闭窗口，forced=false、原始source文件保持。测试最终只回收已捕获且身份仍匹配的自有后代，全部remaining=false，`held-stop-boundary.json`留证。这是停止监督／晚到完成的真实安全边界，不是原TbEkHp根因证据，也不计为一条成功Task旅程；没有改超时、清草稿或以强退放行产品验收。


### 11.5 性能口径、最后快照与未签收边界

每输入3次、交替前后包且中间一对反转顺序，所有程序每次均实际保存／正常退出／冷恢复通过。先记录并发integration环境，再在没有刻意后台构建／测试作业时重测；均是暖OS页缓存＋合成隔离profile，不冒称重启主机／清缓存意义的冷启动。完整原件`startup-series.json`、`quiet-startup-series.json`、`quiet-pi-series.json`及`performance-summary.json`在本批evidence目录。

| 安静主机指标（每输入n=3，中位数ms） | 第一批gated | 第二批symbols |
| --- | ---: | ---: |
| 首次profile就绪 | 1390.161 | 1318.620 |
| 首文件可交互 | 612.917 | 589.848 |
| 保留profile重启就绪 | 1276.138 | 1390.513 |
| 包内Node/Pi owner首次就绪 | 384.522 | 392.959 |
| 首本地Pi请求含真实native写文件 | 87.267 | 80.982 |
| 正常Pi停止 | 153.883 | 144.075 |
| 原生日志恢复 | 373.366 | 368.871 |

观察而非营销结论：首文件／首次profile未见可复现停顿增长，但保留profile中位数本批高114.375ms；并发integration时首文件中位数也从779.163升至907.530ms。样本仅3次，主机调度／缓存变化明显，产品src／renderer逐字节相同；**不能声称性能变快或已证明无回归**，原始较慢样本不删。Pi前后全部明确以空PATH启动确切包内Node，真实native文件写入、settled原生日志及同thread恢复零重放通过，不把本地确定性HTTP耗时外推付费Provider。

补完调试侧包输出／来源说明后再干净新目录构建，最后交付为`/var/tmp/nozeli-opt001-continuation-20261112/final-candidate.tar.gz` **360128649字节**、SHA256=`22079d77fedcbcc417de90cc22d0ca672719135275bd4fa4075f9d136c8486d4`；普通文件899866225字节、20875个、ext4块969895936。相对第一批gated下载少705416字节、普通文件少3784172字节、磁盘块少3784704字节；相对原ad864bb基线下载少23526309字节、普通文件少90214299字节、块少97873920字节。此前中间包不重标，来源说明增加411字节及tar根名／时间差额不算额外优化。

最终外部调试侧包`final-node-debug.tar.gz`4192130字节、SHA256=`ce6eee0691f49094797a0d84baa299636ff08c5e77e9007bd35c2127eec828f5`；最终inventory SHA256=`de891655f435a871d2e1d26bc82b370d2717495117d2713a602c5b4b391718e9`。最终与已测中间symbols运行代码／renderer／Pi／Node／Git相同，只有INSTALLATION和SOURCES说明不同，`final-equivalence.json`证明。最后解压ELF`final-unpacked/opt001-final-2/nozeli`通过`smoke-KIfI25`，两个exit0、renderer错误0。新测试／打包源码冻结清单含1324项，具体最终摘要在证据目录source-inputs.json；不冒称最终提交SHA。

退出驱动审查进一步保证原30秒上限覆盖“等待IPC受理＋实际退出”总和，而不是先无限等受理再额外给30秒；相关真实Task及双布局回退复验另记实际结果。产品退出／保存安全门仍无修改。原TbEkHp没有直接阶段记录、Mac／Windows无本轮原生执行通道、真实OAuth／全Provider协议及严格冷缓存性能矩阵仍未验，G4不签整体完成。默认gzip、未安装／commit／push／PR／发布、六项人工分发pending不变。


最终30秒受理＋退出总门真实复验`/var/tmp/nozeli-task-workspace-OzDYGO/report.json`完整五阶段及两个exit0通过；真实Electron受管／便携正常晋升和启动失败回退4/4再次通过。Office `/var/tmp/nozeli-office-journey-HjnnQv/report.json`、PTY `/var/tmp/nozeli-project-terminal-m4QjSz/report.json`、时间线 `/var/tmp/nozeli-timeline-order-lLhDB1/report.json`均实际ok=true；图像讨论／Word冲突保留截图已查看。最后来源`check-repository --verify-hashes`仍0技术失败／6人工pending，portable入口语法检查通过，正式脏树发布门未绕过。

最终源码／构建／测试／CI输入快照`source-inputs-final.json`1324项，SHA256=`cb98836e81012c6695274f414295170fbb5e47ee418757e4cba0e3cd0b888273`；与首次1324项冻结的差别包含关闭驱动总超时门收紧，未重贴旧候选身份。`SHA256SUMS.txt`实际覆盖最终程序归档和debug侧包。一次性Pi性能、交替启动、故障交错脚本已删除；原始报告／日志／截图、性能JSON、窗口阶段JSONL、符号实验／debug以及源输入／runtime inventory完整保留，不作为产品运行依赖。

本批实际完成：Linux保守Node符号优化、恢复侧包强制留存、旧Beta3真实更新兼容、完整源码回归、真实候选Pi／图像／Office／文件／Git／PTY／Task／恢复、有限性能对照及直接退出取证。**仍不能签G4全部完成**：原TbEkHp缺少当时阶段证据，新增正常及故障注入证明当前边界但不伪造历史根因；Mac／Windows原生本轮未验；真实OAuth／全Provider／严格冷缓存性能资格未验。没有进行安装、提交、推送、PR、发布、旧tag／附件修改或付费调用；原工作树、第一批候选和用户数据保留。

