# macOS 适配实施与本地验收

对应[适配方案](macos-adaptation.md)，记录日期：2026-10-30。本轮交付 darwin-arm64 本地候选：完成平台实现、实际构建与打包，并从最终 dmg 提取的应用验证离线文档和确定性协作。完整平台资格、正式签名和公开分发仍有下述排除项。

## 环境与源码身份

- 源码起点 `5b0ebe8bb5d00e4f4e0b639a9cbda0bc6331e78d`，版本 `0.1.0-alpha.2`；验收包在提交前从工作区构建，精确输入见下文源码清单。已发布的同版本 Linux tag 不包含本轮改动。
- 本机 macOS 26.4（25E246）、Apple Silicon arm64、默认不区分大小写 APFS、Xcode Command Line Tools。另创建大小写敏感与不敏感 APFS 测试卷，验证后卸载。
- 构建 Node 22.22.0、Bun 1.3.14、Electron 44.4.5；包内 Electron Node 24.21.0 / ABI 149、Git 2.53.0、OMP 18.11.0。使用锁定输入，构建失败不回退旧本机产物。
- 本地验收阶段未提交、推送、公开发布或安装到 Applications；后续源码提交与 PR 状态以 Git 记录为准。仅启动隔离配置下的候选应用，未读写用户项目或真实模型账号，所有协作响应来自本机合成 HTTP 服务。
- Info.plist 的最低系统声明为 13.0；实际验收只有 26.4 arm64，不能据此声明 13.0 或 Intel 可用。

## 实现内容

| 边界 | 实现及约束 |
|---|---|
| OMP 输入与构建 | schema 2 锁按 linux-x64 / darwin-arm64 分别记录原生包与摘要；准备、构建、加载入口均校验目标、能力、来源与文件摘要，产物分目标目录保存。 |
| 安全文件操作 | 新增 N-API 8 桥，提供目录句柄相对的打开、遍历、身份检查、创建、枚举、交换、重命名和删除。持有目录链，拒绝链接与不安全类型；并发目标、清理归属不明时保留内容。 |
| 文件名与 Git | 按实际目标卷探测名称等价；受限目录别名、Unicode 等价、目标重叠在写入前拒绝。Git 继承有界 fd 批次进行流式捕获，保留源文件前后核验与 Git 对象摘要核验。仅大小写重命名当前明确拒绝并保留原件。 |
| 进程身份与停止 | 使用内核启动会话 UUID、启动秒与微秒形成 darwin stamp，复核 uid、pid、ppid、pgid 及归属。发信号前再次核验；查询拒绝、PID 变化和扫描不完整保持可见。 |
| Bun 归属查询 | Bun 会整理原始进程环境；严格完整环境模式仍可失败。受限查询只读取三项已知归属目录变量，并校验原始条目、截断、重复、UTF-8 与前后身份；不把它当作完整环境。直接子进程证明仅保存在实际 spawn 对象的 WeakMap，不从磁盘恢复。 |
| 系统与窗口 | Terminal.app 使用固定 AppleScript 与独立 argv，支持中文、空格及引号路径；Ozone 参数仅用于 Linux。关闭原生文档窗口先等内容销毁，再 detach、释放租约；失败保留注册记录供重试，避免提前关父窗口或丢失可重试对象。 |
| 文档交互 | 补齐 PDF 当前页备注；提交时冻结页/区域与版本，晚到的保存结果不清掉后来编辑的草稿。Monaco 在隐藏的零尺寸原生页不布局批注组件，显示后重新布局，销毁时释放监听。 |
| 应用装配 | 生成 `.app`、Info.plist、图标、文件关联和 dmg；检查所有 Mach-O 的 arm64 架构、动态依赖与 RPATH，移除不匹配的 PTY 预编译件；先签嵌套产物、重算 OMP 摘要，再签外层应用。 |

macOS 显式隔离、系统提权、特殊项目恢复保持不可用，请求直接拒绝。普通受管执行以当前用户身份运行，不宣称沙箱保护。Linux 路径及其回归保留，但本轮未在 Linux 主机重新执行。

### 文件保留与进程审计

文档交换、删除或清理中可能包含并发编辑的对象保留在同目录 `.nozeli/recovery`。执行副本结束前，恢复目录迁到运行目录的 `recovered-files/<workId>/<uuid>` 并写 manifest；包含嵌套及大小写别名目录。当前没有自动回收策略，磁盘占用会增长。

本机有无法读取的受保护进程，完整系统审计会返回 `complete: false` 和未核验原因；零个已匹配进程不代表系统已全部清理。候选回退演练使用新建合成目录，逐一核验本测试记录的 OMP 身份已退出、控制器正常停止，并等待宿主及 SQLite 工作进程退出后才复制数据。这是限定所有写入者的合成演练，不是对任意用户项目的全局停止证明。

## 最终应用与签名

本轮最终应用为候选 **B9**，所有以下路径均相对仓库，生成物处于忽略目录：

- dmg：`.build/macos-candidate-9/Nozeli-0.1.0-alpha.2-darwin-arm64-candidate.dmg`
- 从只读 dmg 提取、移动到新位置的应用：`.build/macos-acceptance-9/独立验证 app/Nozeli.app`
- 源码清单、说明和校验和：`.build/macos-candidate-9/{SOURCE-SNAPSHOT.json,使用说明.md,SHA256SUMS.txt}`
- dmg SHA-256：`4e0efd159c7bdb0e0c020dec4e68c8c46b739b3d508e7af2762914e21185b986`
- 源码清单 SHA-256：`990644687109926c313b53137a1af21378b15a9fb3b37d68c7157891ded3dda2`

`codesign --verify --deep --strict` 通过。`spctl --assess --type execute` 实际返回 **rejected**；本地生成应用没有 quarantine 属性，经 Launch Services 可以启动。未关闭 Gatekeeper、未改系统策略；这个结果不保证下载到其他机器后能打开，也不代表 Developer ID 或公证。

包内 340 个 `src` 文件与当前生产源码逐文件一致，记录在 `.build/macos-final-source-verification.json`。包生成后的修改仅涉及文档、测试和 CI，不改变运行时代码；源码快照仍准确表示打包时的工作区。

## 最终包的格式验收

入口为 `apps/desktop/tools/test-macos-package.mjs`。校验 SHA-256、只读挂载 dmg、提取到含中文与空格的新位置并卸载，再逐项启动该应用。应用环境 PATH 为空，使用独立合成项目和无模型配置。每项都检查 renderer 错误、原件内容或摘要，日志包含检查步骤与截图路径。

| 合成夹具与步骤 | 实际结果 | 证据 |
|---|---|---|
| txt / md / ts / tex / bib：阅读、Markdown 预览、选区备注、中文输入、撤销重做、显式保存、冷重启；外部改写后再次保存 | 五种文件均保留正确内容和原备注版本。冲突明确提示，外部源文件与未保存编辑均保留；本地备注未启动 Agent。 | `.build/macos-acceptance-9/text.log` |
| PDF：两页带大纲与可搜索文本，另有中文页；搜索、缩放、文本选区、区域和整页备注，提交前切页再冷重启 | 三种备注保持原版本和锚点；整页备注仍归原页，PDF 字节不变。 | `.build/macos-acceptance-9/pdf.log` |
| PNG / JPEG / WebP：缩放、区域备注、冷重启 | 区域锚点与原图一致，三种原件字节均不变。 | `.build/macos-acceptance-9/image.log` |
| DOCX：中文正文、表格、图片及页眉页脚/脚注；选区备注，正文和表格编辑、保存、重解析、冷重启 | 文本与作者标记正确、表格数量正确，夹具已有图片及 OOXML 部件保留；旧备注版本和锚点不被改写，编辑影响定位时显示待确认。 | `.build/macos-acceptance-9/word.log` |
| XLSX：两张表，图表、绘图和未知 custom XML；内容/公式编辑、保存、重开；尝试不支持的格式写入 | 单元格内容正确；图表、绘图和未知部件字节保留。不支持的写入明确失败，原件保留，撤销恢复编辑状态。 | `.build/macos-acceptance-9/sheet.log` |
| PPTX：三页文字和布局；内嵌编辑、独立草稿、冷重启、导出、重新解析副本；保存对话框目标由自动化指定 | 草稿、文字和布局恢复；原件摘要不变，导出副本可重开；原件目标和已存在副本均拒绝覆盖。 | `.build/macos-acceptance-9/ppt.log` |

六项均通过，汇总见 `.build/macos-acceptance-9/format-results.json`。格式限制沿用[状态文档](status.md)，没有扩展任意 Office 保真、PDF 内容编辑或图片像素编辑能力。

## 其他验收与证据

| 入口 | 结果 | 证据 |
|---|---|---|
| npm ci、固定 PPTist、renderer、OMP、原生桥 | 实际构建完成；无旧本机输入回退 | `.build/macos-npm-ci.log`、`.build/macos-*-build.log` |
| unit | 462 通过，0 失败、0 跳过 | `.build/macos-unit-4.log` |
| integration | 1280 通过，0 失败、0 取消；19 项 Linux 专有用例跳过，122 个文件，497.462 秒 | `.build/macos-integration-7.log` |
| 最后窗口关闭与重试回归 | 87 通过，0 失败；独立复核确认 detach 失败后注册记录可重试 | `.build/macos-close-5.log` |
| 原生 OMP live | 17 通过、0 失败；2 项仅 Linux 显式隔离用例跳过 | `.build/macos-native-live-5.log` |
| B9 包内协作与本地成果处置 | 25 通过，0 失败/跳过；真实 OMP + 本地 HTTP，发送、项目切换、停止、崩溃后原线程恢复；实际 Git 候选审核、接受、丢弃、冲突保留、重试 | `.build/macos-package-native-9.log` |
| 大小写敏感/不敏感 APFS、跨卷 | 受限目录别名、Unicode 等价、目标碰撞拒绝、仅大小写改名拒绝且保留原件 | `.build/macos-volumes-2.log` |
| B9 原生运行时与包完整性 | 空 PATH 下实际启动 PTY shell、OMP 和 Git，加载平台桥；架构/依赖/摘要/签名通过 | `.build/macos-acceptance-9/runtime-validation.json` |
| B9 系统 open-file | Launch Services 冷启动多个中文文件、现有窗口追加文件、正常退出后重启恢复项目 | `.build/macos-open-file-9.log` |
| B9 Terminal.app | 两轮真实窗口附着、中文输入、一次性凭据消费、断开与重连，同一 PTY/thread 保持 | `.build/macos-system-terminal-9.log` |
| B9 Electron smoke | 欢迎页、项目浏览、实际输入保存、正常退出、冷重启通过 | `.build/macos-smoke-10.log` |
| 仓库元数据与差异格式 | 默认检查 0 失败；既有 5 项公开分发义务仍 pending；`git diff --check` 通过 | `.build/macos-repository-check-final.log` |

integration 的 19 项跳过分别是 Linux procfs 资源/进程记录 5 项、隔离 2 项、提权 7 项、特殊项目恢复 2 项、Linux release 进程核验 3 项。macOS 的真实目录竞争、孤儿后代、PID 变化、不完整审计、普通执行与不可用能力拒绝另有实际执行回归；不将这些 Linux 跳过计作 macOS 功能通过。

修正过的验收问题：原生页面启动时可先处于隐藏且尺寸为零；格式测试与 smoke 现在先等页面可见、取得焦点，再发键盘输入。集成第 6 轮一项实际崩溃恢复用例超过 30 秒被取消，未计为通过；该文件 5 项单独复跑全部通过（`.build/macos-post-install-7.log`），随后第 7 轮整组通过，该用例用时 2.777 秒。没有以删除断言或跳过该用例放行。

## 指定候选 A → B → A

没有已发布 macOS 前版，本轮使用两个真实 macOS 候选，不使用 Linux 包充当前版：

| 候选 | 源码身份 | dmg SHA-256 | SOURCE-SNAPSHOT SHA-256 |
|---|---|---|---|
| A5 | 上述 commit + 较早的未提交适配快照，已完成基础包/文档验证 | `2b831deeb9b08bb7c55adc2f4618afe578d61eeb176729bd00e9d93f42f56973` | `8cc6cbe25929d71ed5405a4d9a65284992fc6e098d9eeab3b64a32d4b2db80e9` |
| B9 | 上述 commit + 最终运行时适配快照 | `4e0efd159c7bdb0e0c020dec4e68c8c46b739b3d508e7af2762914e21185b986` | `990644687109926c313b53137a1af21378b15a9fb3b37d68c7157891ded3dda2` |

两包版本字符串相同，因此以源码清单和包摘要区分。演练入口：

```sh
cd apps/desktop
TMPDIR=/private/tmp node tests/macos-upgrade-data.mjs \
  /absolute/A/Nozeli.app /absolute/B/Nozeli.app \
  /absolute/package-A /absolute/package-B
```

该脚本只新建合成数据，不接受用户现有数据目录。各阶段通过所选包的 Electron Node、OMP、Git 和宿主代码执行，PATH 为空。A 建立项目、旧版本批注、历史对象、会话、待审核候选/报告、未保存编辑和对话草稿；B 读取后实际新增保存、批注和会话；A 再读 B 数据并继续保存。三阶段通过，原线程与历史归属不变，B 新数据仍可找回。

每次切换先停本测试所有写入者，然后备份整棵合成配置/登记库/项目 `.nozeli`/原件/会话/草稿/候选，逐文件比较摘要和权限，并核验备份期间源目录未变化。另验证活动写入者、注入空间不足、备份不完整、切换中断和未知兼容版本的拒绝分支，保留原数据与两份完整备份。这些拒绝门是演练中的切换规则，不是已交付通用自动更新器。

- 完整记录：`.build/macos-upgrade-4.log`，其中包含报告、实际数据与备份目录。
- 报告、各阶段日志及两份完整备份另保留在 `.build/macos-upgrade-evidence-9/`，复制后逐文件重验摘要和权限；`retention.json` 记录原路径与保留位置，备份未注册为新的活动项目。
- 恢复点：升级 B 前与返回 A 前的完整备份；最终回到 A 并继续读写耗时 **22.312 秒**。
- 结论仅为 **A5/B9 这对候选在合成数据上的原地兼容**。不承诺任意降级、跨平台迁移、自动反向合并或未知版本的恢复。未知版本不能直接打开现用 B 数据；依赖特殊项目恢复的副本路线仍不可用。

## CI 与未验收边界

新增 `.github/workflows/macos.yml`：固定 macOS 26 arm64 并输出实际主机信息，锁定 Node/Bun/actions，执行干净构建、unit/integration、APFS 卷、显式本地脚本响应 live、Electron smoke、打包、最终 dmg 六格式、包内协作及系统文件打开。只上传 TAP、报告、日志和合成截图，不上传 profile、数据库、备份或应用二进制。

工作流已接入，**本地验收结束时尚无远端 CI 运行记录**；后续状态以对应提交的 GitHub 检查为准，本机结果不能冒充远端绿色。Terminal.app 自动化和指定候选数据回退在本机单独验收；远端图形会话/自动化授权的可用性尚未验证。

本轮未进行真实模型效果、手动输入法候选窗、通知、全套原生对话框/权限取消、任意分屏/独立窗口组合、特殊项目恢复、提权、macOS 显式隔离、Intel/universal、其他 macOS 版本、Developer ID、公证或公开发行审计。M0/M1/M2 的本机适配与 M3 的本地候选验证已具备上述证据；不声明 M4 完整平台验收，也不把未运行的远端 CI 划为通过。
