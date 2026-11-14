# 项目文件与内容搜索

Date: 2026-11-14
ID: SEARCH-001
Status: 主源码已落盘；Linux最终包搜索与保存冷恢复通过，2026-11-14本机已安装并正常重启；未提交或公开发布，其他平台未验

## 目标与当前差距

左侧文件列表上方的输入框成为统一搜索入口：查文件名/路径，也能查项目文件正文；按VS Code式结果组织，但不复制另一套编辑器。搜索纯本地运行，不调用模型、不上传正文，不要求普通用户安装命令行工具或常驻服务。

实施前`apps/desktop/src/renderer/file-navigator.mjs`会将输入转到`quick-open`模态框，调用`project.search`；`src/main/host.mjs`的search仅匹配文件名/路径，最多扫描10000目录项并显式标为不完整，不是全文搜索引擎。新界面使用独立`project.search.start/poll/cancel/reveal`会话；原`project.search`保持旧消费者兼容，不将其预算包装成“全部文件已搜索”。

## 选型决定

采用随包分发的ripgrep进行磁盘文本扫描；文件名/路径搜索复用现有项目导航并改善匹配排序。首轮不增加全文索引、搜索数据库、向量库、后台Agent或常驻HTTP服务。文件名缓存可随现有项目监听失效，但不能为了维护正文索引额外遍历项目。

- ripgrep：按需子进程、流式结构化JSON、字面量/正则/Unicode/行号/忽略规则，Windows/macOS/Linux均有原生实现。使用目标平台依赖，不使用携带全部平台的universal包。正式引入时固定版本、锁文件、目标二进制SHA、来源与MIT/Unlicense通知；运行不联网下载。
- SQLite FTS5：适合后续提取文档的持久检索，但要管理索引版本、更新/删除与短词查询。trigram MATCH对少于三个Unicode字符不匹配，不能作为中文短词的唯一方案；unicode61也不是中文分词器。
- MiniSearch：小型JS内存索引、零外部依赖、模糊/前缀/排序；全项目正文会增加常驻索引和重建成本，不选作当前底座。
- FlexSearch：支持CJK、Worker和持久化，但增加索引与适配生命周期，当前不引入。

体积依据：调研时`@vscode/ripgrep-linux-x64@1.18.0`元数据unpackedSize=5729723字节（约5.46MiB）；不是本产品安装增量，也不是所有平台统一大小。wrapper与引擎版本分别记录，不将npm包版本当作rg版本。本机系统rg15.1.0只作选型实测，不能代替未来正式随包二进制验收。

## 唯一左栏交互合同

1. 原文件栏输入框成为固定搜索框；旁边紧凑切换“文件 / 内容”，不因输入自动打开模态窗。空查询恢复文件导航，搜索结果与树不同时占据整个左栏。切换不关闭原编辑视图或丢失树展开状态。
2. 文件模式：匹配文件名/相对路径，精确、前缀优先；键盘上下选择、Enter打开、Escape离开结果。Ctrl/Cmd+P保留快速打开，复用同一文件查询服务。
3. 内容模式：按文件折叠，展示匹配数量、行号、短片段和高亮，点击进入同一个原生内容面并定位。Ctrl/Cmd+Shift+F进入内容模式。大小写、整词、正则为小控件，包含/排除路径按需展开；默认字面量，不把用户输入自动当正则。
4. 输入防抖建议150ms；中文组合输入完成才提交。新输入、项目切换、关闭项目/退出立即取消旧请求，不仅丢弃旧UI结果。主进程为每个窗口/项目绑定请求代次，旧结果不跨项目填充。
5. 输入区/停止按钮固定，只有结果列表滚动；流式批次更新、虚拟列表，限制片段/IPC批大小，不能把全部匹配先读进renderer。达到用户结果预算明确显示截断、可缩小范围，不冒充完成；不能再设隐蔽文件数量门槛。

## 搜索一致性和安全边界

- 项目宿主选择根目录，renderer只传项目身份与查询参数；`spawn`使用参数数组、shell:false、`--`分隔模式，禁止拼shell。强制`--no-config`，清除影响rg配置/外部预处理的环境；不接受renderer指定可执行文件、配置文件或预处理程序。
- 禁止`--follow`，不沿符号链接跨项目；打开结果必须重新经过现有路径/身份核验。搜索期间的路径替换也必须验证，不能仅信任结果里的字符串。内部`.nozeli/.git/.ccb`与凭据存储始终排除；用户隐藏项、.gitignore/显式包含排除与路径缓存语义统一、可说明。项目搜索不依赖项目本身有Git仓库。
- 已打开未保存文本：按项目/文件身份向持有编辑面取只读快照；在专用worker中执行同语义匹配，以缓冲结果替代同文件磁盘结果。纯文本未保存输入不能因搜索而保存、发送、覆盖原件。组合输入/读取不确定时标识该文件尚未覆盖，不能声称已经包含所有草稿。
- rg JSON的submatches为UTF-8字节范围；编辑器使用的UTF-16行列必须转换，覆盖中文、emoji、CRLF、同一行多个命中及超长行。不要直接把byte offset当character offset。
- 结果携带来源（磁盘/缓冲）、请求代次、文件版本/摘要与范围；点击时重验，已变化则重新定位或提示刷新，不悄悄选错文字。
- 未匹配exit1是正常结果，exit2为错误；权限错误、取消、结果截断分别显示，不统称“0结果”。进程结束回收监听器/pipe，退出不得留子进程。取消机制分别原生验证，不把POSIX信号当作Windows实现。

## 格式覆盖

磁盘扫描覆盖TeX/Markdown/代码/纯文本。PDF、Word、PPT必须通过原有提取器取得有来源/版本/页码的文本再搜索，不直接扫描二进制；若提取器无法提供可靠页面坐标就只承诺打开文件与可读命中位置，不伪造精确选区。扫描PDF/OCR独立扩展，未支持时在结果范围说明中明确。

同一“内容”入口应列明文本、已提取文档和未支持格式的实际覆盖；生产验收不能只测.txt而对外宣称所有论文文档全文可搜。任何分期缩减产品覆盖须明确记录并获用户确认。

## 实施与验收顺序

1. 固定目标平台引擎和打包闭包，新增宿主搜索会话（start/cancel/stream），保留现有project.search调用者语义，不让Agent或renderer自选路径/程序。
2. 接入左栏模式与结果定位，复用原编辑器，保留Ctrl/Cmd+P；统一未保存缓冲搜索、取消、版本边界及可访问键盘动作。
3. 连接可用的Office/PDF提取结果并声明真实格式覆盖，再验文件修改、重命名、删除、隐藏/忽略项、进程异常和跨项目迟到结果。
4. 最终应用真实点击：搜索中文两字、英文、符号/正则、空格与中文路径，打开结果并确认选区；未保存缓冲/撤销/切项目/退出/冷启动不丢。宽屏/320px/深浅主题检查固定输入和结果滚动。各声明平台分别运行最终包，不用Linux替代Mac/Windows。
5. 性能记录首次调用/重复调用、首批与全部结果、取消耗时、引擎增量RSS和实包体积；不清系统缓存称冷启动、不复述上游营销基准作产品承诺。

2026-11-14 用户追加“接入，文件内也接入”：按此合同实现左栏文件/内容搜索、随包ripgrep、宿主绑定编辑缓冲、PDF/DOCX/PPTX/XLSX提取与原编辑面定位。搜索不强制保存，不通过模型工具或LLM提取正文；格式不支持/解析失败/输入组合/草稿无法读时在覆盖提示中列出，不能当作零匹配。当前回合没有安装、提交或发布授权。

## 选型测试（不是生产能力）

可复现驱动：`evaluation/project-search/engine-probe.mjs`，显式指定rg绝对路径；隔离合成项目、真实rg，退出清理临时语料，报告保留至调用方指定的输出路径。验证两字中文、JSON行号/字节范围、中文/空格路径、忽略/二进制、正则/字面量、超过10000文件、取消和退出语义。本机结果在运行后登记，不能预填成功。

## 来源

- [ripgrep原生平台、忽略与Unicode/编码/许可](https://github.com/BurntSushi/ripgrep)
- [VS Code封装、目标包与离线分发](https://github.com/microsoft/vscode-ripgrep)
- [Linux x64目标包元数据](https://registry.npmjs.org/@vscode/ripgrep-linux-x64/latest)
- [VS Code文件内/跨文件搜索交互](https://code.visualstudio.com/docs/editing/codebasics#_search-across-files)
- [SQLite FTS5与trigram限制](https://sqlite.org/fts5.html#the_trigram_tokenizer)
- [MiniSearch内存与分词接口](https://github.com/lucaong/minisearch)
- [FlexSearch索引与CJK能力](https://github.com/nextapps-de/flexsearch)

## 2026-11-14 Linux实测结果

命令（仓库根目录）：`node evaluation/project-search/engine-probe.mjs /usr/bin/rg /home/bfly/.cache/nozeli-smokes/project-search-20261114/engine-report.json`。

Linux x64、Node v22.22.1、系统ripgrep 15.1.0，实际二进制5216360字节。七组行为检查全部通过：两字中文/中文空格路径/CRLF/UTF-8范围及对应UTF-16前缀长度、字面量与正则区别、忽略/隐藏/二进制排除、exit1与exit2区分、不默认跟随项目外目录symlink、超过10000文件仍命中末尾资源、活跃流搜索取消并收到close。

| 合成规模/轮次 | 首批输出 | 子进程启动至退出 |
| --- | ---: | ---: |
| 10505文件 / 43028480字节，第1次 | 3.73ms | 15.61ms |
| 同一语料第2次 | 3.93ms | 16.24ms |
| 同一语料第3次 | 4.29ms | 16.27ms |
| 同一语料第4次 | 3.83ms | 16.05ms |

流式stdin已有实际输出后发送SIGTERM，至close为0.85ms；这证明本机引擎进程可取消，不代表产品IPC取消/Windows终止已经实现。测试合成文件刚写入，系统页缓存很可能温热，不能称为冷磁盘成绩。语料在finally清理，报告路径保留；不读取用户论文或调用模型。

未测：随包目标rg、实际产品左栏/跳转/未保存缓冲叠加、PDF/Office提取、扫描期间目录并发替换、超大单文件、增量RSS、Windows/macOS。当前只有选型与合同落盘，没有新增生产搜索依赖、修改安装版或发布。这些结果支持采用ripgrep，不等于SEARCH-001端到端验收通过。

## 生产接线（2026-11-14）

- 随包目标`@vscode/ripgrep@1.18.0`（当前Linux引擎15.0.0），不依赖系统rg；文本／文件名查询均使用相同Rust匹配语义。宿主服务`project-search.mjs`及`project-search-sessions.mjs`负责start/poll/cancel/reveal、当前shell/project/request归属和取消，旧`project.search`消费者保持原协议。
- `project-search-view.mjs`与file-navigator接成左栏“文件／内容”模式，固定输入／状态、按文件details折叠、匹配数／高亮／路径过滤、分批结果及停止。Ctrl/Cmd+P复用同服务，Ctrl/Cmd+Shift+F从原生文档路由回shell；立即Enter保留该查询的打开意图，新输入/项目切换清除，不执行过期查询。
- `search-surface.mjs`与`office-search-snapshot.mjs`读取现有编辑缓冲／Office模型，不导出或触发保存。无法安全读取的组合输入、恢复草稿和Office进行中的编辑明确列入覆盖问题。文本UTF-16选区及Word引文、PDF页、PPT页、XLSX单元格通过原编辑器定位；异步提取后及执行前再次复验项目、文件与摘要。
- `search-document-process.mjs`/worker复用随包独立Node，以授权冻结字节提取PDF/DOCX/PPTX/XLSX；解析不在Electron主进程执行，不传用户路径给子进程；异常/取消/60秒超时等待子进程close后结算。PDF.js原先只用于renderer构建，现因宿主提取移入生产依赖，生产包包含其模块与许可证；不能把整个新增运行闭包误报为仅ripgrep二进制5.46MiB。
- 结果预算1000条，分批50条及首条返回；单文本8MiB、文档输入32MiB、ZIP展开128MiB、提取页数2000等限制均显式报覆盖问题，不再按项目文件数10000硬截断。没有OCR、旧Office转换器、向量库或常驻全文索引。

测试与最终包原件在完成后登记于`docs/testing.md`。之前“选型测试”章节为历史选型状态，不代表当前生产实现尚不存在；各阶段实测边界分别保留。

## 实施验收结果

定向回归：引擎11项、文档提取/独立进程16项、会话身份/取消4项、编辑面版本/选区3项，共34项独立检查通过；重复运行不叠加计数。最终独立包`/var/tmp/nozeli-search-package-rZxwGe/releases/search-candidate`复用随包Node与当前平台rg，真实Electron旅程11项通过、errors为空、正常exit0，原件`/tmp/nozeli-project-search-live-vXjh47/report.json`及宽屏/320px截图。包含文件名、中文与emoji精确选区、原生快捷键、输入后立即Enter、编辑缓冲替代旧磁盘、PDF/DOCX/XLSX/PPTX命中打开定位、ignore与无效正则区分、窄屏与Escape。最终320px截图确认只保留搜索结果滚动，不与文件树叠加。

四个既有快速打开消费者迁入统一结果选择器及新预算语义，保留ABA立即Enter契约，没有用等待结果削弱该行为；本轮不声称这四个长旅程全部重跑或Mac通过。生产文本内容及文档提取验证与选型裸rg性能数据分开；没有测量产品全量性能/增量RSS。当前实现完成不等于安装，日常current未切换，无本轮提交/推送/发布。

### 搜索栏精简（2026-11-14 用户截图反馈）

取消常驻的文件/内容按钮、Aa/全词/正则行及包含/排除行，搜索栏仅保留原输入框与原省略菜单。点击原“…”→“搜索选项…”后在按需浮层中设置全部搜索条件；模式按钮保留选中态，选择模式后收起。不另增第二个省略按钮。用户进一步要求尽量简化：输入框统一短提示“搜索…”，当前模式由悬停提示和无障碍名称说明，不再显示易截断的长placeholder。复用原文件操作菜单，文件树右键菜单不额外堆搜索控件。快捷键/内容结果/取消/版本核验不变。

真实Electron生产host/renderer搜索旅程11项再次通过，另断言搜索选项初始不占布局，所有模式/正则操作均经真实省略菜单打开；原件`/tmp/nozeli-project-search-live-H9hJac/report.json`、compact-search-idle.png/text-search-wide.png/search-320.png。当前隔离融合管理员Demo已刷新展示同一生产精简样式，日常安装未替换。

最终简化版已落盘：常态仅“一行搜索…＋原省略菜单”，模式信息移至悬停提示/无障碍名称；沿既有菜单按需设置，不增加常驻标签。最终真实Electron11项旅程通过、errors=[]、exit0，原件`/tmp/nozeli-project-search-live-UvzWRo/report.json`及compact-search-idle.png/search-320.png。融合管理员隔离Demo已刷新展示；源码与文档保存在集成树`/var/tmp/nozeli-all-local-20261112`，未提交、未发布、未替换日常安装。

## 主源码落盘与本机安装（2026-11-14）

用户明确要求落到Nozeli并安装测试后，已定向同步至实际主源码`/home/bfly/yunwei/nozeli_git`，保留该树最新frontdesk/native-tooltip等能力；历史集成树证据仍保留来源，不将其路径当成唯一产品源码。主树38项搜索/tooltip回归、实际最终包11项搜索旅程及5项保存冷恢复通过。激活本机`compact-search-main-20261114-01`，previous为`2026-11-14T05-42-56-758Z`；旧窗正常关、新PID432169从新包启动，无强杀。详细回执见docs/testing.md“极简搜索主源码落盘与本机安装”。前文“未安装”为早期阶段状态；当前Linux本机已安装，未提交/发布，其他平台仍未验。管理员模拟Demo不作为正式Agent安装。
