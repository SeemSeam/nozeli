## Beta3 安全依赖与Mac退出契约补修（2026-11-11，新的精确提交验收待CI）

- 推送候选3eaad19后发现16条Dependabot告警；用户明确选择“先修安全依赖再发布”。锁定image-size2.0.3、DOMPurify3.4.17、Pi undici8.12.2/minimatch11.0.1及开发工具Puppeteer25.17.0，保留SDK1.4.0与原Node版本；Pi重建刷新lock摘要。npm旧审计客户端的quick端点返回400不记作干净；npm11.6.2对桌面和Pi完整锁定树均报告0条已知告警。此结果不是完整vendor/二进制审计，更不代替六项人工分发签收。
- Monaco0.57.0内嵌DOMPurify3.4.15，单独npm覆盖不改变该代码；构建解析器现在将Monaco的内嵌导入映射到锁定3.4.17，并从实际esbuild输入记录其独立通告。其它Office vendor未检出DOMPurify标记；不因此宣称全部第三方二进制无漏洞。SDK原始源码/声明/map、Node头文件、Canvas、文档引擎与字体仍保留。
- 修前冻结包的16字节零长度ICNS输入在64MiB限堆的隔离子进程中SIGABRT；修后同输入exit0并被生产imageInfo拒绝，未把输入送给日常实例。image-host新增5秒强制回收/10秒外界限回归，正常图片材料、不可变截图与陈旧版本保护及报告资源消费者共65项通过。
- 旧候选Linux CI43028071493成功；Mac43028071361完成原生arm64打包、自检、报告恢复专项，失败在解压程序首次关窗后等待退出，日志实际值null而非exit0。新Mac契约是末窗关闭驻留，不回退产品行为；普通/Task/时间线/Office冷重启旅程改为通过真实主进程app.quit显式退出，保留原保存、exit0和零重放断言；Office使用Command-S，Darwin不传Linux Ozone。新Mac实机结果仍待新提交runner，不复用旧候选资格。
- 新独立安全候选 `/var/tmp/nozeli-beta3-candidate-UgrSJ3/releases/beta3` 包内Node/Pi/Git解析成功。普通保存/冷恢复 `.test-output/ci/smoke-IOMH8H/report.json`、Office `/var/tmp/nozeli-office-journey-7hq2IV/report.json`、平台窗口 `/var/tmp/nozeli-platform-chrome-OqeZxQ/report.json`、原生Pi时间线 `/var/tmp/nozeli-timeline-order-vJnIfq/report.json`、完整双Task/修改/过程/缩放/冷恢复 `/var/tmp/nozeli-task-workspace-sCswii/report.json` 均ok=true；仅本机Linux与回环Provider，不调用付费模型或操作用户项目。
- 实际安全候选Monaco `/var/tmp/nozeli-beta3-code-cbvj5D/monaco-editor.png` 验证精确JavaScript、真实键盘修改、源码保存及正常退出，无renderer错误。临时启动脚本的input-type继承导致SQLite worker拒绝、以及错误的Puppeteer组合键写法均已纠正于夹具，不改生产存储/键盘逻辑；失败临时目录保留，临时脚本验后删除。
- 安全升级后本机完整unit仍842通过；完整integration未签收：1200秒命令时限结束前已观察到遗留omp-bridge-endpoint测试强制/tmp部署时的-122写入配额失败，其余输出没有完整结束汇总。未将部分通过冒充全量、未删除该安全回归或改产品桥接逻辑绕过环境。新提交仍须由隔离runner完成完整CI与实际包验收。
- d62a148的Linux实际解压包五旅程、unit与Mac原生安全通过；Linuxintegration尚未运行就因azure.archive.ubuntu.com临时DNS失败、bubblewrap下载exit100而失败，不跳过隔离准备或测试来变绿。Mac43039028636的普通保存/冷恢复、完整Task、DOCX/XLSX通过，PPT在旧瞬时ElementHandle双击处报不可点击。改为查询当前CSS可见、非零尺寸且稳定的真实标题，由Locator完成原生滚动/物理双击；不写store、不用DOM click、不放宽PPT导出和原件不变断言。失败保留PPT截图/几何及会话日志；本机实际安全包Office旅程 `/var/tmp/nozeli-office-journey-aaSJZ1/report.json` 通过，最终Mac仍须新提交实际验收。
- 2263e22的Mac失败发生在更早的reading.txt导航，确切日志为旧page.click持有的节点已脱离文档，未到PPT步骤；不将其归因为PPT仍失败。项目/文件/浏览入口统一改为新鲜稳定Locator物理点击，不替换生产UI、不注入DOM点击，保留“pending保留期间仍接受更新的两次trusted点击”、保存和冷恢复断言。本机实际包 `.test-output/ci/smoke-EeUJox/report.json` 与Office `/var/tmp/nozeli-office-journey-vFKWfG/report.json` 均通过。Ubuntu隔离runner的apt镜像列表显式使用官方HTTPS archive/security源，保留GPG校验、bubblewrap与原隔离测试；只作用于临时CI机器，不更改用户机器或产品运行要求。

## Beta3 发布闭包瘦身（2026-11-11，Linux候选已验，双平台发行验收待CI）

- 本轮用户要求不减少当前功能，并明确要求Release同时包含Linux和Mac；再次披露六项人工分发审计pending后，明确选择授权公开beta.3预发行例外。不沿用beta.2授权，不标stable/latest，不替换日常安装。确切提交CI和两平台实际解压验收通过后才发布。
- 将已编译前端依赖归为构建期；在原版本显式保留Canvas生产依赖，保留全部CodeMirror后端、格式化/TS语言服务器、终端解析、Node/Pi/Git、文档引擎、字体及离线资源。共享Linux/Mac过滤器只剔除非目标PTY预编译和重复首页/小图标构建输入；保留目标平台fallback及spawn helper。Pi闭包、SDK源码/声明/map、Node头文件和Canvas原生变体不作清理。
- 前端构建依据全部esbuild输入生成BUNDLED-NPM-NOTICES.json及按包/版本隔离的npm-notices目录；实际候选保留68包69份通告，Monaco ThirdPartyNotices存在并与源通告逐字节一致。通告整理不等于六项审计签收。
- 独立候选 `/var/tmp/nozeli-beta3-candidate-RLWxlJ/releases/beta3` 经包内Node/Pi/Git解析及Git实际运行校验；表观989705994字节、实占1067257856字节，对比此前当前安装实占1320583168字节减少约241.6MiB。此为本机ext4候选实测，最终发行物另行统计；未改current/previous、启动器、用户配置或业务文件。
- 默认unit842/842；发布/窗口/会话定向114项在TMPDIR=/var/tmp通过。首次默认/tmp写入配额-122及SQLite I/O失败保留，不冒称通过或修改存储逻辑。无本机xvfb-run；无显示后端的Office点击失败及未传X授权失败保留。Office夹具此前误将XAUTHORITY视作模型凭据清理，现与其它真实GUI夹具一致仅保留图形授权路径，模型凭据仍清除；未绕过X权限、sandbox或业务断言。
- 实际候选Office `/var/tmp/nozeli-office-journey-DbPI04/report.json` ok=true：DOCX/XLSX真引擎修改保存并解包核对、PPT真编辑导出且原件不变、外部DOCX冲突保留及冷重开。实际普通保存/项目切换/关闭冷恢复 `.test-output/ci/smoke-rr7Ncb/report.json` ok=true。
- 实际主/独立内容/独立对话、主题/窄窗/设置及dock `/var/tmp/nozeli-platform-chrome-R7IoaJ/report.json` ok=true、exit0、模型请求0，截图已查看；实际包原生Pi/Git/回环脚本时间线 `/var/tmp/nozeli-timeline-order-2h0C5S/report.json` 四场景通过，补充不移位、新消息位于底部、冷重开零重放，12次回环请求、Provider错误0，最终截图已查看。不是付费模型或Mac原生按钮物理点击验收。
- CI发行分支新增从两平台实际解压产物运行Office、平台窗口及时间线旅程，并保留报告/截图；Mac只允许darwin arm64原生runner构建。此处不预填CI结果，Mac仍ad-hoc签名、未Developer ID签名/公证；原生红黄绿悬停/物理点击等未验证边界不扩大。

## 自动更新故障修复（2026-11-11，源码已修，未安装／发布）

- 日常 Linux 安装只读证据：`~/.local/opt/nozeli` 与 `releases` 为 0775，更新器安全拒绝后误标为 source/development；当前版本 alpha.6，历史状态有 HTTP403。历史响应头未保留，403 限流原因仅推断，不能当成已复现事实。真实匿名请求观察到共享 60 次/小时额度；Node 直连资产 CDN 实测 TLS ECONNRESET，Chromium 网络会话可下载。
- 修复：专用非持久更新网络会话与逐跳 allowlist，显式私有安装布局，真实安装安全条件失败明确报错、不改既有权限；限流只按响应头证据解释。无凭据、无未验证 fallback，tag／SHA256／闲时退出／健康回执与回退保持。
- 定向 `auto-update.test.mjs`＋`auto-update-network.test.mjs` 23/23；`auto-update-installation.test.mjs`＋`update-lifecycle.test.mjs` 12/12；`release-retention.test.mjs` 11/11。renderer 构建通过。`TMPDIR=/var/tmp node --test tests/auto-update-package-smoke.mjs` 四项通过：真实 Electron 受管／便携布局晋升、两布局新程序启动失败回退。初轮 /tmp 配额 -122、随后旧夹具缺少平台持久化模块导致失败，已改用磁盘临时根并补齐真实依赖，不改原回退断言。
- `node tests/desktop-auto-update-live.mjs` 真实 Nozeli 设置页五项通过：回环 GitHub-style 403 后保留安装并显示恢复时间，实际点击检查后下载校验、设置模态阻止重启、关闭后原程序正常退出、新程序健康确认、previous 与用户数据不变、全新调试端点及新程序正常关闭。原件 `apps/desktop/.test-output/desktop-auto-update-tgcrHO/report.json`，限流及等待空闲截图均已查看。打包前缺少锁定 Node 归档的下载失败保留；补齐归档并经既有 SHA256 验证后运行通过。
- Linux 实测限定；回环发行包不等于公网全量更新签收。不写用户项目／日常安装，不清理个人更新缓存，不移动已发布 tag。现有 0775 安装尚未收紧权限且运行旧代码，不能宣称用户日常更新已恢复。macOS／Windows 自动安装仍不支持。

# 测试套件与运行边界

本页定义仓库的确定性测试入口、各套件的分类边界与前置条件。命令均在 `apps/desktop` 下执行；套件清单的唯一来源是 [`apps/desktop/tools/test-suites.mjs`](../apps/desktop/tools/test-suites.mjs) 中的显式文件列表（无 shell 通配、无目录扫描），列出成员可用：

```bash
node tools/test-suites.mjs --list          # 默认套件（unit+integration）文件清单
node tools/test-suites.mjs smoke --list    # 任一套件的文件清单
```

## macOS 原生窗口与设计适配（2026-11-11，源码完成，待Mac实机验收）

- 梳理见[Mac桌面设计原则](principles.md#macos-桌面设计2026-11-11)，依据Apple HIG与Electron原生标题栏接口。原问题为主／独立窗口共同强制frame:false且renderer无条件创建右侧“− □ ×”。现在WorkspaceWindow在Darwin使用完整原生frame/default标题栏，由系统绘制左侧红黄绿与活动／失焦状态，content bounds自动排除标题栏；辅助审校utility及隔离预览不走此策略。preload只读platform与html data-platform驱动界面分支，Mac不创建HTML三键、不重复品牌大图标；Windows/Linux原样。⌘W与⌘S不被全局菜单抢走，⌘⇧W沿native close role关闭key window，⌘,进入既有设置界面。
- Mac普通最后关窗与真正退出分离：保存／忙碌门禁保持，闲置运行时可驻留；Dock、菜单与外部文件复用主窗恢复入口，创建前恢复关闭保存准入，退出中拒绝重建。新输入冻结仅在当前有效关闭清理完成后、最终关闭前生效，不用定时器擅自解锁；过期清理不会冻结保留窗口。重复Quit等待同一清理完成；无窗口但工作忙碌时恢复确认载体，不直接绕过原忙碌决定。实际关闭实现与WindowRecovery回归共用，未以复制状态机或构造选项拷贝作为行为签收。
- Linux定向7文件回归154/154（app-menu、desktop-quit-lifecycle、renderer-platform-chrome、close-flush-retention、lifecycle-flush-capability、main-startup-recovery、workspace-native）；最后补齐设置入口后对应3文件17/17复验，renderer构建通过。纯renderer平台模拟只证明无重复HTML按钮／真实快捷键格式，不证明Mac原生红绿灯。
- 实际Nozeli/Electron平台旅程 `/var/tmp/nozeli-platform-chrome-6IGMge/report.json` ok=true、exit0、renderer错误0、Provider请求0：真实1280/680窗口尺寸、浅深媒体外观、主／独立内容／独立聊天、菜单与dock、真实menu-action打开设置；截图已查看。此前夹具跨浏览器上下文process变量、未配置就连接对话、初始化前提错误原件保留，未放宽平台DOM/窗口交互断言。
- 额外实际Linux延迟保存关闭 `/var/tmp/nozeli-close-recovery-tJhXIA/report.json` 通过：阻塞renderer后，精确自有PID／启动身份／对话标题的原生“继续等待”取消选择沿原晚到保存回执自然exit0，原文件与已接收草稿不变。独立X显示的早轮失败来自探针取消步骤固定依赖当前KWin会话，临时Openbox不能替代该DBus所有者；失败原件DCPV36/dTVWfB保留，最终仅使用自有测试窗口，未操控日常实例。
- **未验／缺失前提**：当前Linux，SSH能力与已配置别名未提供Mac连接；没有Mac WindowServer或实际.app签收。新增 `npm run test:macos-window-chrome`（使用锁定Electron，非Mac／非Electron明确exit2拒绝签收，本机拒绝已实测）验证真原生frame、content bounds、关闭拦截、全屏与最小化；`desktop-platform-chrome-live.mjs`也可在真实Mac上运行，原生截图限自有测试窗口区域。真实红黄绿点击／悬停／失焦、Dock重开、Mac忙碌退出与完整.app仍须Mac实机；不把Linux或平台模拟当成通过。未提交、打包、安装或发布，前轮对话时序源码修改保留。

## 对话与 Task 首次提交时序（2026-11-11，源码修复，未安装）

- 用户报告新对话浮到顶部，要求Task整体位置以首次提交为准。修前确定性复现：未索引账本 `ordered()` 给older1/newer2，`legacyDTO` 却全0，导致renderer按UUID并列排序；共享legacySequence使分页、frame和原文read一致。另一复现：Task原请求seq10、普通对话seq20、Worker seq30，原请求离开当前页后原卡从10退到30，越过普通对话。现在从既有入账序号与intake lineage／Work身份派生 `firstSubmissionSequence`，贯穿普通／原生／超预算条目、历史业务delta及流式更新；不按最后更新时间排序，不新增第二账本，不重写历史原文。原始entry.sequence、游标和上下文清空边界不变；流式并列最大序号改为按起始顺序排列。
- `TMPDIR=/var/tmp node --test tests/session-store.test.mjs tests/session-index.test.mjs tests/session-execution-presentation.test.mjs` **91/91**，零失败／跳过；renderer构建通过。覆盖分页／200条视口逐出后首次Task锚不变、流转持久、补充／澄清／前台转后台、裁剪和旧业务delta只读补锚、双流式启动先后，以及旧历史原文和读版本边界。
- `DISPLAY=:1 TMPDIR=/var/tmp NOZELI_OZONE=x11 node tests/desktop-timeline-order-live.mjs`：真实Electron／原生Pi／回环脚本Provider／Git／持久会话四场景通过，原件 `/var/tmp/nozeli-timeline-order-yQ2Yyn/report.json`。普通对话A→Task1→普通B→前台输入后转后台的Task2→普通C；Task1真实补充并重新发布后两卡不移动，随后新对话D仍底部；正常关闭冷开后持久消息／Task身份顺序逐位相等，零模型重放、原Git和文件不变。短页完整记录的修前旅程排序本来正常，不把它当作对用户报告的反证；根因红证据为未索引DTO归零与首次请求缺页漂移。
- 最终截图旅程再次通过（`/var/tmp/nozeli-timeline-order-ObAkID/report.json`，4场景、12次回环Provider请求、零Provider错误）：主动滚动到列表末尾后，新普通对话D确实位于C之后最底部；冷恢复仍为相同持久身份顺序且零重放。`03-new-conversation-bottom.png`、`04-cold-restart.png`已查看；冷恢复原生正文按既有按需读取策略，不以未预加载的正文标记判定排序失败。
- 真实验收初轮额度默认1使Task2排队、脚本工具回执ID碰撞、冷恢复正文按需加载及前台原请求／handoff双记录的前提错误均保留失败原件；仅修正合成profile的并发2与唯一调用身份，冷开按稳定身份验证顺序而非强迫预加载正文；不删除或放宽时序／卡片位置／零重放断言。限定Linux独立X11与合成项目；未操作用户会话，不代表Windows/macOS、物理输入或当前安装版通过。未提交、未安装、未发布。

## 标签输入后无法移动／缩放（2026-11-11，源码修复，未安装）

- 真实 Electron＋合成 HTML 文档复现：CDP `Input.imeSetComposition` 输入中文后，第一次标题鼠标拖动先触发 pointerdown，随后失焦才 compositionend；原 `local-window.mjs` 在 pointerdown 被 composing 标志直接拦住，位移为零。原件 `/var/tmp/nozeli-label-windows-u0w3K7/report.json`。PPT 文件讨论／工作面涂鸦的未输入场景原13项通过，不拿该局部通过否定用户故障。
- 修复共用 geometry control 的事件顺序：合法标题／尺寸手柄在 composition 活跃时先聚焦，让浏览器正常结束组合，再检查 guard 并接续同一次捕获手势；如果仍在组合继续拒绝，不手动清标志、不合成结束事件、不发送或清草稿。按钮／链接／正文仍不启动移动。HTML 修后原件 `/var/tmp/nozeli-label-windows-SUKvyT/report.json`：首次移动 +80/+55、首次缩放 +50/+40、中文完整保留、历史与键盘操作正常，4项通过；截图已查看。中间 J0AMeh 因探针旧的未含中文草稿预期而整体 false，位移已修复，不抹去该原件。
- `TMPDIR=/var/tmp node --test tests/local-window.test.mjs tests/tag-session-identity.test.mjs tests/renderer-tag-draft.test.mjs tests/region-drawing.test.mjs tests/snapshot-card-view.test.mjs` 45/45；renderer 构建通过。初轮默认 /tmp 因配额耗尽出现 SQLite I/O 与 esbuild 写失败，改磁盘临时根后全过，不放宽断言。临时 HTML 定位探针已删除，正式多标签回归另列实际结果。
- 扩展实测暴露第二处 PPT 恢复缺陷：区域讨论位置／尺寸恢复一致，但未发送文字未显示；隔离数据库中 `text` 与 `draftText` 均完整为 `Unsent region draft`，不是存储丢失。`renderWordNotes` 把带 projection 的 PPT 记录也交给 `makeNoteTag`，讨论随后复用错误备注卡。改为与 Word 分支一致，备注渲染排除 projection。修前原件 `/var/tmp/nozeli-label-windows-CHxvxD/report.json` 保留；草稿、类型分流与重开几何验收不删除。
- 最终真实 PPT／区域涂鸦／工作面冻结涂鸦：`TMPDIR=/var/tmp node tests/desktop-label-windows-live.mjs` **33/33**，`ok:true`、renderer错误0、正常退出；`/var/tmp/nozeli-label-windows-cCBW3z/report.json`。包含真实框选→画笔→讨论、两轴拖动／放大／反向缩到下限／折叠展开、PPT 重开草稿与几何、返回笔迹／本地恢复、touch cancel、窄窗夹取恢复、IME后首次移动与缩放。原文哈希、区域锚／笔迹／素材记录精确不变，无模型jobs。两处PPT首次挂载和刷新统一沿排除projection的备注路径，修前失败的重开草稿断言修后通过；未删断言或重写原记录。
- 最终真实 Markdown／纯文本／HTML原生隔离预览／图片区域标签：`TMPDIR=/var/tmp NOZELI_OZONE=x11 node tests/desktop-tag-interactions-live.mjs` **60/60**，`ok:true`、正常退出、pageerror空；原件 `tag-interactions-live-f3eUET/result.json` 位于本轮隔离测试缓存。覆盖普通备注、选区讨论、文件讨论、位置讨论、图片区域涂鸦讨论：标题文字与空白拖动、右下柄放大和反向缩小、键盘／Shift／Home、收起恢复、文档切换与关闭重开、真实浏览器IME首拖／首缩、涂鸦编辑菜单打开同笔迹并取消。退出后重新读取真实存储，锚点、历史、完整中英文草稿、笔迹与素材摘要保持；四个原件逐字节不变，零模型jobs。关键PPT／输入法／图片重开截图已查看。初轮测试夹具缺材料、隐藏工具入口、跨上下文变量、其他浮层遮挡及自动定位合法夹取的失败原件保留；修正真实操作前提后未放宽位移、持久化或原数据断言。
- Linux X11／XWayland、真实 Electron＋可信 CDP 鼠标与浏览器合成输入；不等于物理输入法／触控硬件、纯 Wayland、Windows/macOS 验收。用户日常安装与原文未改；源码修复不等于运行中的旧版已生效。
- 用户授权“commit所有修改，安装复测”后，20文件整体提交 `df73bd2`，正式 install-local 激活 `2026-11-11T06-33-12-803Z`，previous 保留 `review-recovery-20261111-local-01`；仅收紧安装根与releases的组／其他写权限至0755，不写业务数据。安装实际ELF隔离profile更新烟测 `/var/tmp/nozeli-installed-update-uDRCWz/report.json`：supported=true、403确认限流提示、手动重查current、正常exit0，截图已查看。
- 安装实际ELF的主桌面早轮鼠标测试出现外来坐标与lostpointercapture，保留txM4Rf／7Sws7U／S2rJyQ失败原件；无产品主动释放调用。独立X11显示采用临时解包Xvfb（未系统安装／不需提权）及磁盘临时根，不与物理鼠标共用输入；原生切换后的辅助隔离操作改用可见关闭按钮，原独立Escape断言保留。最终安装程序标签 **60/60**（`tag-interactions-live-UIpHS6/result.json`）及PPT／涂鸦 **33/33**（`/var/tmp/nozeli-label-windows-HjhF7o/report.json`）通过。离屏X11为真实程序集成证据，不冒称用户物理桌面／所有输入硬件通过。随后追加涂鸦后台入口另行记录提交与安装，不将本次安装当作新增功能已生效。

## 涂鸦后讨论卡直接后台任务（2026-11-11）

- 双明确动作“发送讨论／提交后台任务”，来源详情折叠但视口／未核验风险直显，保留与返回操作独立分组。后台走真实 `managed.task`，不伪装前台回复；共用同冻结截图、笔迹和来源，后台请求键与前台轮次分离。同卡单飞、IME拒绝、失败保留、未确认意图同键重试、晚到新输入不被清空；接受只标已提交，不宣称执行完成。
- `workspace-snapshot-retention.test.mjs` 18场景通过（`/var/tmp/nozeli-snapshot-retention-QT5eUr/report.json`），含前台既有13场景及后台单飞／失败同键重试／晚到输入／混合前后台线程隔离；相关讨论／来源／持久化21项通过，renderer构建通过。新卡沿已有PPT／区域／工作面33项真实移动缩放旅程通过（`/var/tmp/nozeli-label-windows-0FHYCi/report.json`）。
- `DISPLAY=:1 TMPDIR=/var/tmp NOZELI_OZONE=x11 node tests/desktop-workspace-drawing-background-live.mjs` 12项通过（`/var/tmp/nozeli-drawing-background-VePD2m/report.json`）：真实Electron点击→唯一后台intake→原生Pi／回环脚本Provider→独立worktree写文件并发布，原项目不变，无前台回合；确切冻结图片digest和非空input.txt视口来源逐字相等。320／390浅深标题／输入／双动作真实命中可达，后写输入保持、exit0。截图已查看。不把脚本Provider当作真实模型理解质量或跨平台资格。
- 初轮测试遗漏输入、故意hold模式未重置、无关对话开窗干扰以及首次项目初始化被错误计成frontdesk失败均保留原件；用现有“既有项目”fixture隔离语义初始化，未改产品门禁或删后台/材料/唯一受理断言。实现及验收登记live，提交安装另记实际结果。
- 全部追加实现／测试／文档提交 `ad5c540`，正式安装激活 `2026-11-11T07-25-55-817Z`，previous=`2026-11-11T06-33-12-803Z`，正在运行的旧review-recovery版本额外保护保留；未推送、未发布、不移动beta.2 tag。最终实际安装ELF在独立X11显示隔离profile复测：涂鸦真实后台 **12/12**（`/var/tmp/nozeli-drawing-background-E2LOML/report.json`），各类文档标签 **60/60**（`tag-interactions-live-QERbb9/result.json`），PPT／区域及冻结涂鸦 **33/33**（`/var/tmp/nozeli-label-windows-excf21/report.json`），更新检测supported=true、403诊断→重查current与正常退出（`/var/tmp/nozeli-installed-update-POhUU7/report.json`）。最终窄屏浅深截图已查看。用户profile未启动／改写，未强退原日常进程；正常退出旧程序后从原快捷方式启动生效。



## alpha6 macOS 本机迁移与验收（2026-11-09）

- 固定上游 `v0.1.0-alpha.6`＝`9a2466a847267620747b79f9c1b97fbac8f00280`。旧基线 `9215afaf` 的未提交Mac修改先保存binary patch与19个新增文件，再三方合入独立工作树 `/Users/bfly/nozeli-macos-alpha6`（分支 `macos-alpha6`）。旧 `/Users/bfly/nozeli`、所有旧包、日常profile及用户项目不作为迁移／破坏性测试目标，不提交／推送。
- 解决alpha6报告来源／会话索引与Mac持久化import的冲突，保留新报告／任务合同。新增初始化流程适配：Darwin chain.opendir、openExclusive、sync；初始化使用固定文件流的有界前缀读取及固定目录句柄内临时文件、CAS、rename、F_FULLFSYNC。修复早停for-await流导致原始fd提前关闭的EBADF，范围流只接受start/end，不可覆盖fd／autoClose。永久重置文件屏障走platformPersistence，不退化为普通fsync。
- 依赖按alpha6锁安装，重新构建Pi驱动（manifest验证12项）、PPTist、Mac native helpers与renderer。包 `dist/Nozeli-0.1.0-alpha.6-macos-arm64-verified/Nozeli.app` 自带Node22.23.4／Git2.53.0／Pi，ad-hoc签名深校验通过，保留真实原生叠放修复与品牌ICNS／Dock图标；不公证、不自动替换用户运行实例。
- 完整默认 `TMPDIR=/private/tmp npm test`：unit799项／798通过／1跳过／0失败，integration1898项／1873通过／25跳过／0失败。跳过含Linux-only沙箱／proc／更新提升等，不计为Mac支持。新目录合同／初始化／永久重置／关闭保存专项29项全过；原生Pi／skill／生命周期32项中31通过、1项Linux隔离跳过。原始流与报告归档 `.test-output/alpha6-acceptance/`，旧alpha5结果不代替这轮证据。
- 确切最终包 `npm run test:macos-ui` 通过9轮物理搜索打开、分屏／独立窗／dock／正常关闭冷重启／真实权限失败下未保存稿，以及DOCX／XLSX编辑保存重开、PPTX副本导出与DOCX外部冲突恢复。Office导出目的地由单次native dialog选择覆写，第一阶段冲突冷启动可能SIGKILL，原始exit回执保留，不冒称全部正常退出。最终workspace退出码0／renderer错误0；原件 `nozeli-mac-quick-open-gGMqdE`、`nozeli-mac-workspace-Y0UTcl`、`nozeli-office-journey-JKf7eo` 均在canonical系统临时目录并归档。
- alpha6新功能实际包旅程：`desktop-project-initialization-live.mjs` 验证真实Pi受限skill渐进读取、inventory→read→map、403门控／明确解除、取消晚到不发布、SIGKILL后零静默重放及完成后冷开零请求（`nozeli-initialization-native-iCFps9`）；`desktop-project-reset-live.mjs` 验证真实PTY停稳、取消保留／显式永久清理、源文件和Git不变、另一项目／恢复稿保持（`nozeli-permanent-reset-Rv0wIR`）；`desktop-task-workspace-live.mjs` 验证双任务／普通对话交错、同Worker问答与第二次发布、只读任务过程分屏、原任务DOM／草稿／身份和冷开无重放（`nozeli-task-workspace-oegJzO`）。全部合成项目＋本地HTTP，无个人key或付费模型。任务UI浅深与320／390／1280、200%截图有证据，但不扩大为全应用缩放资格。
- 复跑入口：`NOZELI_TEST_BINARY=<app>/Contents/MacOS/Nozeli npm run test:macos-alpha6`（初始化→重置→任务），GUI必须串行。原生叠放通过真实Electron入口 `tests/native-view-stacking.entry.cjs`；HTML镜像新guest需要等待alpha6裁切布局收敛后判断，不以初始1440默认尺寸误报。
- **明确未通过**：完整九格式显示矩阵在alpha6运行时 `Page.captureScreenshot` 超时（`nozeli-display-matrix-Rfp4ND/report.json`），此前一次还停在PDF窄窗工具菜单等待；不能据零风险数组宣称矩阵通过。alpha6导航栏已移除重复域名标题，测试改核对实际地址栏；保留截图失败，不用旧矩阵代替。未验：Mac强退完整后代树（上游force-quit仍Linux-only残留）、沙箱、系统终端接管、自动更新、Developer ID／公证、任意OOXML保真、系统IME及真实磁盘故障／付费模型质量。


## 稳定结果记忆定向验证（2026-11-07）

源码首版与完整使用边界见[实现记录](result-memory-implementation.md)。`result-memory.test.mjs`为纯逻辑，`managed-result-memory-integration.test.mjs`与`managed-result-memory-binding.test.mjs`注册常规integration。额外运行`node tests/result-memory-live.mjs`以真实SQLite/对象验证100/1000报告分页、缓存及子进程SIGKILL恢复；可设`NOZELI_MEMORY_SMOKE_CACHE_BYTES=2097152`核对生产默认缓存预算。`node tests/desktop-result-memory-live.mjs`使用真实Electron/Pi与loopback确定性模型验证报告采用收尾、冷重启、主控查询、派发来源及Worker确切读取。它不使用个人凭据，不证明真实LLM选择/摘要质量；修改Pi桥后先在`integrations/pi`执行`npm run build`更新完整性清单。

复杂多task追加：`node --test tests/managed-memory-multitask.test.mjs tests/memory-source-manifest.test.mjs tests/result-memory-concurrency.test.mjs`覆盖六task/额度2、冲突与丢弃历史来源、忙/排队补充、替换/清空导航但保留输入依据、冷重启、目录版本续读及缓存并发计费，已注册unit/integration。`node tests/result-memory-concurrency-live.mjs`以200份约5MB正文、默认2MiB缓存、124项混合读/解析/提交及独立冷进程验证性能/快照重试/完整性；`node tests/desktop-memory-multitask-live.mjs`启动实际Electron/Pi与确定性loopback，验证四task/额度2、排队补充去重、两次冷开及用户放弃释放原排队任务。只计实际运行结果，详见实现记录“复杂多task交错与记忆深测”。


## 2026-11-06 状态与管理页信息设计复核（未实施）

父任务以实际安装版 `2026-11-06T00-54-32-789Z`、隔离合成 profile／项目和本机脚本源浏览十处：全部 Agent、单 Agent 模型、会话管理、连接与历史、服务故障、设置外观、默认模型、Agent 资源、AI 连接、本机恢复。原记录 `/tmp/nozeli-status-design-FV7Dip/audit.md` 与同目录 `01-all-agents.png` 至 `10-local-recovery.png`。浏览仅覆盖空闲双角色、单模型／单源、空故障／空恢复；父任务报告未发送问题、最终 jobs=[]、正常 exit0，不据此声明操作或动态分支通过。

Reviewer 本轮读取完整记录、查看十图并静态审查相关代码，更新[信息设计与验收契约](agent-conversation-status-demo.md#简洁状态与管理页设计2026-11-06未实施)，没有另行运行产品、修改实现或安装。用户原图的 local URI 在 reviewer 会话不可读，搜索未找到，执行中主控反馈保留为用户事实而非 reviewer 图像观察。任务详情、保留进展、非空故障／修复／恢复、历史只读、过期、很多 Worker／大目录均只有源码复核；浅色／窄窗、动态行为和其他平台待真实场景补验。文档设计稿不作生产 After 截图，静态组件或合成 DTO 不冒充真实会话行为。
## macOS 真实 Nozeli 项目全面验收（2026-11-06）

- 实际打开 `/Users/bfly/nozeli` 源码树，不是副本。原 README 与 `src/platform/platform-capabilities.mjs` 哈希保持不变；本轮可写材料单独创建于 `mac-acceptance-materials/`，结束后归档到忽略的 `.test-output/real-project-acceptance/materials/` 并删除原测试目录。
- 项目 profile 必须位于源码树外：本轮 `/private/tmp/nozeli-real-project-20261106/config`。将 profile 放入源码树会被 `runtime and content roots overlap` 拒绝；这条安全保护保留。
- 实测读取 Markdown／真实源码／图片／PDF／DOCX／XLSX／PPTX／HTML。Office 检查实际截图；HTML 正文由独立隔离预览页承载，不能用外层壳截图空白判为正文缺失。保存测试 UTF-8 文本逐字核对；Unicode 批注经生产 IPC 保存且原件不变；实际 PTY 执行 `pwd` 与 `uname -m`；实际对话输入框发送一次本地 Provider 请求并由真实 Pi job 完成。无付费服务或个人密钥。
- 自动化限制如实记录：深层快速打开的连续操作多次超时，后续多格式验收通过生产 `__workspaceGroups.open` 进入，并非把失败搜索路径算作通过；批注使用生产 IPC，不声称本轮物理框选已验收。原生内容面与主窗的输入／可见性分离，需要等待真实 contentReady，不能把错投到主窗的输入算产品失败或成功。
- 原始完整默认套件：unit 634 项／633通过／1跳过／0失败；integration 1765项／1717通过／21跳过／27失败。原件 `.test-output/ci/{unit,integration}.tap`。后续定向复验分别记录，不将原始完整套件失败改称全绿。Linux 更新器、旧 OMP 的 `/proc` 恢复测试不构成 Mac 能力。
- 已定位真实缺陷：Darwin `openExclusive` 句柄漏 `chmod` 导致成果合入异常；已改为原生 `fchmod(fd)`，补关闭后 EBADF 守卫，并移除 F_FULLFSYNC 的弱降级。合入／队列／报告导出专项99项全过；路径／权限失败恢复／网络传输事实专项18项全过。其余并发版本库与监听专项以最终复验记录为准。
- 证据目录：`apps/desktop/.test-output/real-project-acceptance/`，含 `real-project-report.json`（15项界面／宿主检查）、`real-project-agent.json`、`annotation-terminal.json`、各格式截图。实际验收实例正常退出码0。Chromium disk-cache 创建警告仍可见，不声明其根因已修复。
- 后续 CAS／影子版本库专项49项全过：首次初始化改为私有 staging 完整构建后原子 rename 仲裁，已有仓库只采纳、不替换；不使用基于年龄猜测崩溃的破锁机制。跨实例并发首检查点、相同 requestId 收敛、原有提交链及 GC 已实际复验。`project-git` 的测试竞态注入由 Linux-only `handle.sync` 改为平台共用写入边界，生产 CAS 保护未放松。
- 最终监听／TeX资源监听／CAS／并发版本专项42项全过。监听建立期与首投递保守归并为目录失效，不以固定毫秒窗口猜测历史边界，也不丢弃真实变更；测试用真实哨兵事件建立增量边界后验证非递归与项目隔离。
- 最终修复包：`dist/macos-verified-20261106/Nozeli.app`。重建原生模块／renderer／独立包，ad-hoc 签名深校验通过；最终包通过真实文件树打开源码项目 README，包内原生 helper 的 write→fchmod(0755)→F_FULLFSYNC→rename 与磁盘字节／权限复核通过，实例正常退出0。`final-package-smoke.json` 保存原件。修复后的专项不替代一次完整默认套件重跑：原完整失败仍保留，Linux 更新器6项与旧 OMP `/proc` 恢复1项未作 Mac 移植验收。
- 后续快速打开专项已关闭此前超时项：`tests/desktop-macos-quick-open-live.mjs` 通过9轮实际鼠标／键盘搜索、中文／深层路径、已有文档再激活与精确原文核对；合成项目与真实 `/Users/bfly/nozeli` 各跑一轮。原件 `nozeli-mac-quick-open-PXwX7P/report.json` 与 `nozeli-mac-quick-open-n4UuGe/report.json` 位于本机 canonical 系统临时目录。脚本验证重新打开时前次查询完整选中，直接输入替换；不再点击输入框破坏选择后依赖 CDP 的 Cmd+A 模拟，也等待已有文档激活完成后才核对弹窗关闭。无需改生产搜索逻辑。复跑命令：`NOZELI_TEST_BINARY=<app>/Contents/MacOS/Nozeli NOZELI_TEST_PROJECT=/Users/bfly/nozeli npm run test:macos-quick-open`；不传项目变量则使用自建隔离项目。
- 更新器平台边界专项：Mac 上验证 Linux 安装布局不触发下载／提升／退出，旧 OMP 恢复明确拒绝；相关22项中18通过、4项 Linux-only 提升／回滚明确跳过。跳过不算 Mac 自动更新能力已实现，Linux 上仍保留原完整提升与回滚断言。
- 后续窗口终验：`NOZELI_TEST_BINARY=<app>/Contents/MacOS/Nozeli npm run test:macos-workspace` 通过左右／上下双轴、只读 mirror 的 adapter+IPC 双层写拒绝、准确文本切换、独立原生窗／阅读位置差异、dock 移回、同 profile 正常重启布局和编辑恢复；用 b.txt 的真实0444权限阻断保存，关闭另一pane后草稿存储保持完整候选且磁盘原件未变。两次正常退出码0、renderer错误0。原件 canonical临时目录 `nozeli-mac-workspace-N05hPE/report.json`，含重启前截图。前半段允许自动保存，只签收“本地编辑未丢失”，不把已自动保存文本伪称未落盘草稿。
- 剩余功能终验完整默认重跑已完成：unit 634项／633通过／1跳过／0失败；integration 1769项／1744通过／25跳过／0失败。新增的4项跳过为 Linux-only 安装提升／回滚；其余Mac更新器用例改为验证 unsupported、不下载、不切换当前版本。证据已复制到 `.test-output/macos-final-acceptance/{unit,integration}.tap`；故障注入的 `guest rollback add fails` 日志是预期拒绝场景，测试计数无失败。
- Office实际旅程 `NOZELI_TEST_BINARY=<app或内层可执行> npm run test:macos-office` 已通过：DOCX真实引擎中英文输入、显式键盘保存、ZIP正文精确标记；XLSX文本／数字单元格编辑保存与ZIP值；PPTX追加标题文案并通过可见文档菜单导出新副本，原件逐字节不变；DOCX外部改写后保存拒绝且恢复包保留未保存稿；冷启动重开三种已存／导出内容，最后正常退出0。导出目的路径由单次saveDialog选择覆写，实际原生文件选择器交互不算通过；全部保存均走键盘，无synthetic-keydown回退。第一阶段冲突留存后冷启动采用SIGKILL（实际exit已记录），不伪称两次均正常退出。
- 三条GUI旅程串行运行（原生焦点共享）：`NOZELI_TEST_BINARY=<app>/Contents/MacOS/Nozeli npm run test:macos-ui`。报告、截图及Office每次启动日志归档在 `.test-output/macos-final-acceptance/{quick-open,workspace,office}/`。这些证据只签收明确路径，不等于任意OOXML保真、物理框选／涂鸦、真实账号OAuth／付费推理、管理员认证、TeX实际编译、沙箱或自动更新完成。
- 本轮最新交付包 `dist/macos-final-20261106/Nozeli.app` 已重建原生／renderer、独立打包并通过ad-hoc签名深校验；对该确切产物执行 `npm run test:macos-ui`，快速打开9轮、窗口8类检查、Office7类检查全部通过。最终证据为 `.test-output/macos-final-acceptance/summary.json` 与 `{final-quick-open,final-workspace,final-office}/`；Office最后正常退出0，第一阶段SIGKILL冷重启保留原始回执。此前 `macos-verified-20261106` 包和原失败证据保留，不覆盖历史结论。


## macOS 模型目录继承验收（2026-11-06）

- 被测产物：`dist/macos-development/Nozeli.app`，实际 Electron + Pi owner + 本地 HTTP Provider；`NOZELI_TEST_BINARY=<app>/Contents/MacOS/Nozeli node tests/pi-model-management-live.mjs` 通过，正常退出码 0。合成源的创建／修订号拒绝／留空保留密钥／跨源凭据确认、显式 `/models` 发现、三角色默认模型与原生思考档位修正、同 owner/thread 密钥轮换后继续对话、无旧输入重放均已实测；设置页加载完成后断言两个候选模型和三角色保存值，再截图。没有访问个人 OMP 配置或付费服务。
- 原件：`/private/var/folders/s8/703vpzcx7q7d17vkm45xr0r00000gn/T/nozeli-pi-model-mgmt-BJkyQw/report.json` 与同目录 `model-management.png`。Mac 夹具使用真实临时根，不传 Linux Ozone 标志。
- **完整 OMP 模型目录继承不通过**：旧集成固定 OMP 18.11.0；其公开 `@oh-my-pi/pi-catalog@18.11.0/src/models.json` 有 78 provider／5718 条目，当前 `@earendil-works/pi-ai@1.4.0/dist/models.generated.js` 的 `MODELS` 有 42 provider／1599 条目。按 `provider/modelId` 精确对照：共有1192，OMP独有4526，Pi独有407。这只是静态目录差集，不是服务端发现、推理授权或协议兼容结论；provider 重命名没有强行等同。完整差集保存在 `.test-output/macos-development/omp-model-catalog-comparison.json`。
- 当前生产路径是 `bridge.modelsList → ProviderSettings.models → 设置／managed.model.options`，使用私有 Pi 目录并过滤未配置凭据项，不读取 OMP 的个人配置。不能把“当前模型管理正常”描述成“已完整继承 OMP”；本轮未拼接缺失目录、未迁移登录机制或替换执行内核。
- 后续用户明确授权仅继承本机OMP API与key，已执行显式 `tools/import-omp-api.mjs --discover --apply --adopt-default`。只读源静态配置，成功源写入 Nozeli 私有Pi配置（0600），共同compat开关保留；403源跳过，命令型key／OAuth不迁移，原OMP配置不修改。实际 `macos-final-20261106/Nozeli.app` 正常profile的设置目录显示15项、三角色默认选择与OMP当前默认一致，内存对照API/key/compat完全一致且未输出key。仅调用模型列表接口，推理请求0；列出不证明推理授权。脱敏原件 `.test-output/omp-api-import/verification.json` 与 `imported-models.png`。合成安全回归 `node --test tests/omp-api-import.test.mjs` 通过，覆盖预览零落盘、0600、命令凭据不执行、源不变、同名冲突不覆盖和输出无密钥；本轮未重跑完整套件。

## 套件总览

| 套件 | 命令 | 内容 | 额外前置 |
| --- | --- | --- | --- |
| unit | `npm run test:unit` | 纯逻辑：导入源码模块与 npm 依赖验证行为；允许只读源码（如读 preload 源做 vm 沙箱验证），不写真实项目文件、不起被测子进程、不用 Git/Electron/原生运行时 | 无（Node ≥ 22 + `npm ci`） |
| integration | `npm run test:integration` | 真实临时文件／Git／存储与显式隔离安全回归；无GUI、无模型提供方 | 系统git；Linux需bubblewrap及可用user namespaces |
| smoke | `npm run test:smoke` | 轻量 CI 冒烟（`tests/desktop-ci-smoke.mjs`）：真实 Electron 无模型启动→空工作台→注册合成项目→浏览文件→原生编辑→正常关闭→冷重启留存 | 先 `npm run build:renderer`（Electron 随 `npm ci` 安装） |
| live（显式选择加入） | `NOZELI_TEST_LIVE=1 npm run test:live` | 私有Pi owner＋回环脚本HTTP、真实文件/Git；包含真实Electron维修展示／接受流程，无付费模型 | 先 `npm run build:pi` 与 `npm run build:renderer`；Git、统一预检所需bubblewrap、真实图形会话或Xvfb |
| toolchain（可选工具） | `npm run test:toolchain` | 实际TeX编译、SyncTeX正反向定位与TexLab | 系统latexmk/xelatex/pdftotext/synctex/texlab；缺失明确失败，不静默跳过 |
| default | `npm test` | unit + integration 顺序执行 | 同上两者 |

`npm test` 是安全默认：只运行不依赖预编译私有 Agent 运行时／PPTist、不依赖显示器的部分。

冷启动本地收尾回归：`node --test --test-name-pattern='normal startup repairs confirmed local closure' tests/managed-post-install-recovery.test.mjs` 使用真实项目/Git、子进程持有并释放的私有 index lock 和生产 `ManagedProjects.resumeUnfinishedProjects({hostOnly:true})` 启动入口。未配置 AI 或私有运行时不可用时，应用仍调度已确认接受／丢弃的宿主收尾；不初始化模型／进程资源，不启动居民或 Worker，不激活排队业务。状态与报告读取本身不触发恢复；原确认绑定、维修事件和提交去重仍由既有闭包流程核验。此确定性回归不替代实际安装二进制的正常退出／冷启动 GUI 验收。

## 分类边界

- **unit**：成员以 `tools/test-suites.mjs` 显式清单为准；按实际导入与行为划入——不起被测子进程、不写真实项目文件、不驱动 Git、不加载 Electron。个别文件只读源码，因此不宣称无任何 fs 访问。出现真实写入／子进程／Git 即归 integration；`update-lifecycle.test.mjs` 验证未保存编辑／排队任务阻止更新及冻结释放。
- **integration**：真实临时仓库、shadow版本、存储切换和宿主文件读写；成员清单以runner为准，Git身份由测试或产品层明确提供。TeX编译、语言服务和SyncTeX真实工具测试归入独立`toolchain`套件，不能因为开发机恰有工具就当作普通CI依赖；此前误将`tex-source-link.test.mjs`归入默认集，现已按实际外部依赖更正，测试本身完整保留。
- **smoke**：当前清单为 `desktop-ci-smoke.mjs`、`desktop-ppt-pending-text-live.mjs`、`renderer-projection-coalescing.test.mjs` 和 `desktop-collaboration-status.test.mjs`。第一项实际启动Electron，覆盖空工作台、合成项目浏览、键盘编辑、明确保存、正常退出与冷恢复，并固定SQLite保留屏障验证导航仍可交互。第二项使用真实PPTist验证最后输入导出／旧稿冲突保护。第三项以生产panel／navigator和合成IPC验证绘制、导航单飞与迟到保护。第四项以生产协作组件、62个合成Agent和真实Electron验证加载后页／焦点保持、模型菜单pending→applied事实更新而保留未提交选择／搜索、跨项目迟到隔离和390px布局；它使用可渲染的自有窗口以避免隐藏窗口关闭modal后截图无帧，不冒称真实Pi资格。各项使用隔离profile和即时端口；真实Pi／模型／宿主文件链另由原生专项覆盖，不能互相替代。
- **live**：Pi 分支由 `pi-native-tools-live.mjs`、`pi-lifecycle-live.mjs` 驱动实际独立 Node／Pi SDK owner；需准备固定私有 Pi 运行时，并用 `NOZELI_TEST_LIVE=1` 显式选择加入。使用回环合成 Provider，不读取真实账号。`pi-facts`、`pi-questions` 和真实付费模型任务分别记录；不恢复旧 OMP PTY 套件作为产品入口。

### 与 0.1.0-alpha.1 发布回归（“374 项”）的关系

发布时的“374 项”是当时按发布流程实际执行的 **24 个文件**的聚合结果，不是“本机全部测试”，也不是本页套件的某种拆分或子集；两者是不同入口，数目互不对应、互不折算。新套件的规模以各自 `node --test` 实际输出为准。

## 前置条件（含 CI）

- **Node ≥ 22**（`node:test`、`node:sqlite`）；开发机与 CI 一致使用 22.x。
- **`npm ci`**（在 `apps/desktop`）：安装依赖并经 postinstall `electron-rebuild -f -w node-pty` 重建原生模块。unit/integration **不需要**预构建私有 OMP（`build:omp`）或 PPTist（`build:pptist`）。
- **integration**：系统git，以及Linux上的bubblewrap与可用用户命名空间；此套件含真实隔离边界回归，缺少工具明确失败，不暗中略过该文件。
- **smoke**：先 `npm run build:renderer`（检查 `dist/renderer/app.js`）。发布级冒烟按发布流程再加 `build:pptist`、`build:omp` 后运行。
- **live**：`NOZELI_TEST_LIVE=1` 显式选择加入；`runtime/omp/omp` 存在（`npm run build:omp`）；`bwrap`（如 `apt install bubblewrap`）与 `git` 在 PATH。
- Ubuntu 24.04 + Node 22 的 CI 示例：
  - 常规任务：`cd apps/desktop && npm ci && npm test`（或分别 `npm run test:unit`、`npm run test:integration`）。
  - 构建+冒烟任务：`npm ci && npm run build:pptist && npm run build:pi && npm run build:renderer && xvfb-run -a npm run test:smoke`。
  - 可选 live：`NOZELI_TEST_LIVE=1 xvfb-run -a npm run test:live`（私有Pi构建完整；原生隔离专项仍按各自前置条件）。

GitHub Ubuntu临时runner限制无特权用户命名空间：workflow为隔离回归安装bubblewrap，并仅在临时runner放开AppArmor的userns限制；Electron烟测另配置root拥有的`chrome-sandbox`（4755），仍以普通runner用户运行。不加`--no-sandbox`，不改用户机器或发行包权限。环境清理保留`XAUTHORITY`这一Xvfb显示cookie路径以连接临时显示器，不保留模型/SSH/GitHub认证变量。

前置缺失时 runner 以退出码 2 给出 `PREREQUISITE MISSING` 说明并停止；任何套件都不会静默跳过文件或缩小集合，套件内列出的文件不存在同样视为错误；未知选项（如 `--unknown`）直接拒绝（退出码 2），已知选项仅 `--list`。

`node --test` 套件默认以 `--test-concurrency=2` 运行（可用 `NOZELI_TEST_CONCURRENCY` 覆盖），避免 CI 上百文件同时 fork 与 SQLite 争用；并发数本身不影响集合内容。

Runner 为每个套件创建独立 HOME/XDG 配置目录，禁用用户/系统 Git 配置和交互认证，并从子进程环境移除凭据、认证代理及模型工具配置变量。报告只上传 TAP、脱敏日志、合成截图与 smoke 摘要，不上传 profile、数据库或会话目录。此隔离不等于 OS 沙箱，专项脚本若绕过 runner 仍须遵循自身准入。

默认集若因临时文件系统配额出现 `EDQUOT`／系统错误 `-122` 或伴随的 SQLite I/O 错误，应保留失败日志，在仓库外有足够空间的专用临时目录设置 `TMPDIR` 后重新执行完整集合；不延长存储期限、删除测试或吞掉 I/O 错误。TeX 专项另须让已安装工具链可被 PATH 找到；离线 Tectonic 还需要其已有资源缓存，不能把缺工具／缺缓存算产品通过。

平台无关存储安全集 `storage-worker-safety.test.mjs` 覆盖原期限内已提交但主线程延迟消费回执、真正迟到／缺失回执、冲突、关闭与代际隔离；`tex-source-watcher.test.mjs` 覆盖剪枝、资源变化／新目录、链接替换和关闭期间初始化取消。两者进入默认 integration；不把 Linux 原生实测外推到 Windows/macOS。

有界恢复读取进入默认integration：`storage-recovery-bounded.test.mjs`以200–300MiB合成SQLite记录验证摘要条数／字节预算、连接／scope／版本游标、UTF-8原始字节分块、未知／损坏记录保留、settled receipt/message筛选、资源窄投影及原生导出的排他发布／失败不留半份。`session-index.test.mjs`补充超过8MiB解析预算的原件仍可确切导出；`tag-input-presentation.test.mjs`覆盖冷开大回复不丢失且大工具日志不混入回复；`file-clipboard.test.mjs`覆盖无关超大恢复记录不阻断导入／导出、相关未保存记录继续阻断。路径碰撞在SQLite中按完整相对路径筛选，不用128字符显示摘要作权限或覆盖判断。

真实恢复表面另运行 `node tests/desktop-managed-pending-recovery.test.mjs` 与 `node tests/desktop-office-recovery.test.mjs`（先构建renderer及已有Office/PPT依赖，配置显示器；Linux X11可设置`NOZELI_OZONE=x11`）。前者实际根目录失联、静态报告原字节导出与显式结算／冷开不重放；后者用真实Word/Sheet/PPT引擎失联编辑，按所选记录明确读取后导出候选包并校验编辑内容及原件不变。它们不代替超大库冷启动、原生另存对话框或真实账号／其他平台资格。

`desktop-reading-current.test.mjs`和`desktop-storage-lifecycle.test.mjs`已同步摘要／明确详情协议。后者的完整JSON导出仍走实际恢复按钮、可信IPC和磁盘写入；仅在隔离测试进程的main inspector中固定下一次系统另存为目标，随即恢复原chooser，不增加产品环境变量／renderer路径权限或常驻后门。系统对话框本身的点击／路径输入须另记验收，不能由该适配器推导通过。

Agent状态／模型默认回归：unit新增`pi-activity.test.mjs`、`target-model-intent.test.mjs`，覆盖原生活动归纳、身份／版本拒旧、未结算保护、配置CAS／幂等／撤销／继承、effort和clamp确认、旧owner回执隔离；integration新增`collaboration-status.test.mjs`，覆盖真实大缓存的标量分页、纯读不派工、项目全局保持与未完closure跨页、冷任务不重放、超出provider前缀的未知owner不能改模型。`session-index/session-store`回归覆盖真实历史模型在streaming／portable／裁剪／冷恢复下的忠实透传。真实生产对话模型操作由`desktop-pi-live.mjs`和`pi-model-management-live.mjs`使用Pi＋回环Provider验证；源改变后先在`integrations/pi`执行`npm run build`重建私有完整性清单，不能忽略`PI_RUNTIME_UNAVAILABLE`。

冻结附件交接回归（在 `apps/desktop` 下）：`node --test tests/file-attachments-host.test.mjs tests/managed-context-cutover.test.mjs`。前者覆盖登记附件的验证、发送时冻结、幂等与二进制／跨项目拒绝；后者覆盖前台→主控→Worker 初始／补充交接沿显式 `frontJobId`／`sourceJobId` 绑定读取同一冻结版本，不扫描无关任务或读取同名当前文件。初始交接存在 `sourceInputJobIds` 时严格使用该准入集合（包括空集合），只有旧记录缺少该字段时才回退 `work.sourceJob`。2026-11-09与`project-attention`、summary及managed-projects合计79项通过；真实附件选择／冻结／发送／后续不重附旅程`/tmp/nozeli-material-native-pick-KLPeN0/report.json`通过。模型请求按确切原生用户输入归属计数，项目初始化请求不冒充重复发送；原生追加的材料块也不冒充新的用户输入。此为Linux源码限定验证，未安装。

2026-11-09任务流向恢复：`session-store`、`task-timeline-scope`、`task-workspace-presentation`合计44项通过。`desktop-session-timeline.test.mjs`真实React/Electron消费者新增实际前向位移、回流、暂停恢复不重播、减少动态状态验证，`/tmp/nozeli-session-consumer-9rzvcV`通过。真实Electron/Pi/Git双任务、多轮、只读分屏及正常冷恢复旅程`/tmp/nozeli-task-workspace-wwKFXo/report.json`通过，截图已查看；不将源码或组件验收记为日常安装／其他平台验收。

Agent自动生命周期回归已注册integration：`node --test tests/agent-idle-lifecycle.test.mjs tests/agent-process-budget.test.mjs`。确定性时钟覆盖连续空闲截止、亚32毫秒原生活动经真实Controller/Manager事件路径重置期限、owner替换、回收中输入、正常按需唤醒、原线程、冷输入不重放、退出失败不捐赠预算、单个定时器及关闭清理。真实Pi验收另需观察实际PID退出、忙Worker保留、闲置角色卸载及原线程恢复；仅在构造器缩短测试闲置期限，不新增renderer／产品环境变量后门，也不将本地确定性Provider算作付费模型验证。执行结果见[动态管理§11](agent-conversation-status-demo.md)。

生产维修协同回归：`node --test tests/maintenance-runtime.test.mjs tests/maintenance-status-page.test.mjs tests/agent-idle-lifecycle.test.mjs tests/agent-process-budget.test.mjs tests/collaboration-status.test.mjs`。覆盖原事务精确绑定、仅结算未准入queued技术事件、已结束Work的原closure修复、效果已验证后的持久化失败与仅补结算（包括已用尽维修次数）、原Worker正常结束与延期发布并发、冷恢复不重放、不可写／UNKNOWN／用户决定保护、损坏账本／编码字符串／不安全整数／NULL live-flight的分页及全局计数。

`managed.maintenance.status {projectId,limit?,cursor?}` 为只读分页元数据，最多 50 行、编码上限 64 KiB；返回 `rows,total,nextCursor,summary`。worker 只提取标量。`managed.maintenance.retry` 携带页面原 `binding` 与 `expectedRetryMode`，宿主实时核对 capability 与模式；stale 拒绝不能升级为 repair。原生工具内部 `Controller.maintenanceStatus()` 仍读自身账本，不作为新 IPC 兼容格式。真实组件回归与真实 Pi 资格分别记录。

真实Pi事务专项：`node tests/pi-repair-lifecycle-live.mjs`，私有本地Provider，真实Git ref锁和文件；全局进程额度2，宿主先修复零推理、原Worker只运行一次、发布原事务两次有界恢复、维修元数据分页、review owner闲置回收不释放Work配额、正常退出无自有PID残留。完整UI链路另用下述`desktop-maintenance-live.mjs`，不以逻辑测试或原型页面代替。

### Agent 人工控制与动态自维护深测库

生产接入合同见[人工控制协同设计](manual-task-control-repair-design.md)。测试库复用真实 ProjectStorage／Controller／ManagedProjects，不导入 Demo；独立的可控屏障、时钟和本地 Provider 位于 `tests/agent-control.fixture.mjs`，只服务隔离合成项目。新测试不使用个人账号或付费模型，不添加产品测试环境后门。

- `tests/agent-control.test.mjs`：人工暂停／停止／恢复、版本与实例绑定、完整意图幂等、原生停止未确认、维修 repair/finalize 与人工门、held queued 下的闲置回收、limit=2 与完整收尾释放、100／1000任务及冷开不重放。已加入默认 integration。
- `tests/service-fault-control.test.mjs`：真实本地存储上的结构化分类、单退避唤醒、成员 CAS、来源隔离、非派工读、未知效果不重放、意图写入失败恢复、冻结 job 准入与混合版本；已加入默认 integration 及聚焦库。
- `tests/pi-session-admission.test.mjs`：传输准备屏障内提交暂停，真正 JSONL 写入前拒绝，明确恢复仍只发送原输入一次；属于无原生子进程的确定性回归，不替代真实 Pi。
- `tests/agent-control-pi-live.mjs`：真实私有 Pi owner／回环脚本 Provider／文件与退出证据；验证人工控制与动态回收、服务拒绝事实及恢复边界。
- `tests/agent-control-electron-live.mjs`：实际 Electron 根窗口任务目录／菜单／模态控制、顶部故障、影响与分类更新、390px 根渲染视口及原对话草稿保持；不是浏览器 Demo。两份新 live 驱动与既有真实维修／生命周期一起纳入显式 live，不进入普通无图形默认集。

聚焦入口（在 `apps/desktop` 下）：

```sh
npm run test:agent-control
npm run build:pi
npm run build:renderer
NOZELI_TEST_LIVE=1 NOZELI_OZONE=x11 npm run test:agent-control:live
```

`agent-control` 同时执行 executor 的 `agent-idle-lifecycle`、`agent-process-budget`、`maintenance-runtime`、`maintenance-status-page`、`collaboration-status` 回归；`agent-control-live` 继续执行既有真实维修与原生生命周期场景。不以新增按钮检查替代 executor 机制的再验收。两组与 default/live 重叠，次数不能相加。输出遵循既有 runner：`.test-output/ci/agent-control.tap`、`agent-control-live.tap`；各实际原生／Electron脚本另保存自身 report.json，成功以真实输出为准。

默认五分钟策略用确定性时钟核对边界；原生 smoke 仅通过构造器缩短 idle 期，核验真实 PID 与原 thread，不声称实际等待五分钟。最终 Linux 实测：聚焦库 **115/115（9 文件）**；既有消费方专项 **77/77（5 文件）**；`agent-control-live` **11/11（5 文件）**。后者含脚本文件级子测试与 `pi-lifecycle-live` 七项，不把脚本内部检查点再叠加计数。完整版本、Reviewer 修正、原件路径及未验边界见[设计与落地记录 §13](manual-task-control-repair-design.md#13-生产落地与本轮实测2026-11-02)。消费方原始组合日志为 `.test-output/ci/agent-control-and-consumers.log`。未安装、提交或发布；未使用用户业务项目、个人凭据或付费模型。

后续用户已明确授权安装，并要求按设计修改目标做系统测试：实际用户级 release 为 `2026-11-02T04-46-05-777Z`，previous 保留 `2026-11-01T04-39-18-355Z`。安装宿主重跑 115/115，124 个安装模块加载路径与 SHA 留痕；另完成六组真实安装流程，含文件保存／冷启动和真实 TCP 断线。§11 的 17 项设计目标按确定性宿主与真实原生／GUI 层分别映射，见[安装与系统测试记录 §14](manual-task-control-repair-design.md#14-用户授权安装与按设计目标系统测试)。总报告 `/tmp/nozeli-installed-system-a35a177a7e/system-report.json`。原日常进程未强退，正常退出旧版并重开后才加载新 current；测试未打开日常业务 profile 或使用个人账号。上段「未安装」仅指先前源码验收阶段。

Liuhuaiyu 实际模型联测发现旧发布契约同时暴露 `html`／`text`，实际模型会给 result 补上 `text:""`，导致严格校验拒绝。曾尝试同回合返回纠错：合成烟测通过，但真实模型仍反复生成相同空字段，已停止对应 QA owner 并撤回此方案，不能用合成通过代替真实账号通过。最终 `nozeli_publish` 只接受 **`{kind,content,files}`**：`content` 是唯一必填正文，result 为完整静态 HTML、problem 为 Markdown；旧 html/text 参数、额外字段及空正文均拒绝，不做自动参数重试或输入重放。Worker 指令及全部有效测试调用同步迁移，历史线程工具摘要保护保留。另修复任务菜单漏传 `'discard'` 的接线错误，真实 Electron 回归已覆盖菜单确认、持久决定、完整收尾后释放配额及不重放原 Worker。最终真实项目复测与安装版本以专项记录为准。

## Node 与 Electron 的 ABI 区分

postinstall 用 `electron-rebuild` 针对 Electron 重建 `node-pty`。该依赖基于 node-addon-api（N-API），二进制在 Node 与 Electron 间 ABI 稳定，因此纯 Node 的 live 测试仍可直接加载。runner 在 live 前实际探测 `node -e "require('node-pty')"`：一旦某次重建产出仅 Electron ABI 的二进制，立即给出明确前置说明（重装依赖），而不是让测试逐个崩溃或被裁剪。依赖 Electron GUI 的 `desktop-*` 测试不属于任何纯 Node 套件。

## 历史命令与探针（不在默认入口内）

- `package.json` 中仍有效的专项命令供定向调试；成员以实际文件和 `tools/test-suites.mjs` 为准。旧 Electron 长流程继续由各专项承载，不因未进入轻量 smoke 而声称已通过或已退役。Pi 分支不提供已移除的 OMP `test:collab`／TUI 接管命令；历史适配器单测不算 Pi 产品能力证明。
- `tests/*-live*.mjs` 中需要既有发布产物、prior report 或真实安装二进制的脚本（如 `desktop-*-live.mjs` 审计探针、`installed-handoff.test.mjs`、`c1-installed-open*.mjs` 的安装态部分、`post-install-startup-recovery-*.py`、`.probe-*.mjs`）是开发/发布期证据工具：均需显式手动运行并提供所需产物，绝不进入默认套件，也不随 CI 运行。其中部分脚本仍含本机绝对路径（历史证据语义），除已纳入维护套件的文件外不做批量改写，也未删除。
- `tests/desktop-worker-large-files-live.mjs`：显式真实 Electron＋原生 OMP＋回环脚本模型专项。独立合成项目含 88 MiB 归档、超过 256 MiB 输入和一万多个文件；Worker 修改小文件并生成 68 MiB 二进制，实际报告界面接受后核实合入、冻结摘要、原件保护与正常退出。运行 `NOZELI_TEST_EVIDENCE_ROOT=<测试输出根> node tests/desktop-worker-large-files-live.mjs`；安装态另传 `NOZELI_TEST_APP_ROOT=<release>/resources/app NOZELI_TEST_BINARY=<release>/nozeli`。保留样本、截图与 report.json，不接触用户项目或付费模型；冲突、回滚、准备恢复另由确定性回归覆盖，不将本专项冒充故障注入矩阵。
- `tests/desktop-maintenance-live.mjs`：已迁移为真实Electron＋私有Pi＋本地确定性Provider。合成项目保留已跟踪`.ccb`普通输入与被忽略`build/`产物；真实宿主读取／编辑和原生bash生成并执行脚本，以自有Git分支锁制造发布故障，模型经原生`nozeli_maintenance status/retry`核对后恢复原事务。核验原Work／线程／job、Worker命令与发布各一次；生产维修详情真实显示原绑定与次数、已修复无可重试动作、未发送草稿保留；实际报告界面显式确认后才合入冻结文本、被忽略脚本与验证JSON及可执行位，正常exit0。运行`NOZELI_OZONE=x11 node tests/desktop-maintenance-live.mjs`；使用独立私有profile和合成文件，不安装、不使用个人模型、不操作用户项目。临时main调试／包装已移除，不绕过生产IPC、文件校验或修复准入。
- `tests/desktop-yolo-live.mjs`：真实 Electron＋捆绑原生 OMP＋回环模型，前台宿主工具在未登记B目录实际列表／读取`.ccb`／编辑文档并执行普通用户命令，不产生授权或目标元数据；Worker普通问题交给Orchestrator，原Work/线程/候选续作一次后经真实报告界面接受；管理员请求在真实权限面明确拒绝，验证零执行／零系统认证。进程argv实际核实`--approval-mode yolo`，保存截图、JSON和正常退出证据。运行 `NOZELI_TEST_EVIDENCE_ROOT=<测试输出根> node tests/desktop-yolo-live.mjs`；本专项外部宿主操作实测前台，不把它冒充所有角色全部路径矩阵或危险命令安全沙箱。
- `tests/desktop-schema-upgrade-live.mjs`：真实旧安装版→当前源码／安装版的原生 OMP 升级专项。必须显式提供 `NOZELI_TEST_OLD_APP_ROOT=<旧版本>/resources/app`，可用 `NOZELI_TEST_OLD_BINARY` 指定旧二进制；当前版本和输出根沿用上述 `NOZELI_TEST_APP_ROOT`、`NOZELI_TEST_BINARY`、`NOZELI_TEST_EVIDENCE_ROOT`。在独立 HOME／profile 创建两个非空原生会话后正常退出，再启动新版并重复连接、冷重启，验证工具摘要确实变化、原线程／历史字节前缀／可见消息／未发送草稿保留、连接期间零模型请求及输入重放，最后仅显式新输入触发模型。旧版产物缺失或摘要未变化均失败，不以新建项目启动替代升级验收；不进入默认或 CI 套件。
- `tests/desktop-force-quit-live.mjs`：Linux 真实 Electron＋原生 OMP＋回环模型专项；两个独立合成场景分别直接强退、正常取消仍在等待时点强退。实际运行拒绝 TERM 的业务子进程，核对主进程有限时间退出、自有后代清理、无关哨兵存活、已持久化草稿／原 Work/job／项目基线保留；冷开重连零模型请求／任务重放，随后正常关闭。命令 `node tests/desktop-force-quit-live.mjs`，安装态使用上述 APP_ROOT／BINARY／EVIDENCE_ROOT 环境变量；不触碰用户资料，不以正常退出烟测替代强退验收。独立的 `force-quit*.test.mjs` 纳入 integration，覆盖挂死清理的真实进程退出上界、进程身份和无关进程保护；Windows/macOS 后代清理未验收。
- `tests/desktop-unlocated-tags-live.mjs`：真实 Electron 文档面专项；独立合成 Word／文本／PDF／图片／PPT 标签经源文件变更确实失位，核对折叠卡片操作可见、按钮不重叠，实际删除三类区域备注、移除讨论标签并保留原历史，真实 Word 选字及文本选区重新绑定，刷新留存及正常退出。命令 `node tests/desktop-unlocated-tags-live.mjs`；安装态沿用 APP_ROOT／BINARY／EVIDENCE_ROOT 环境变量。不读取用户文档、不启模型；Word与文本重定位走实际UI，图片／PDF／PPT其他锚点及PPT草稿并发校验由 `tag-stability.test.mjs` 覆盖，不将入口显示冒充所有格式的选区交互矩阵。
- `tests/desktop-external-paste-live.mjs`：Linux真实系统文件剪贴板专项，独立隐藏Electron原生ClipboardItem写入合成文件URI，Nozeli通过实际右键／Ctrl+V导入文件与嵌套文件夹；粘贴前核对清单仅含本测试来源，测试中文空格、二进制字节、外部cut只复制、系统新剪贴板优先、同名不覆盖／源不删除、正常退出。`node tests/desktop-external-paste-live.mjs`，有DISPLAY时默认X11，与当前启动入口一致；需真实图形会话，不能以headless进程内剪贴板代替系统剪贴板。安装态沿用APP_ROOT／BINARY／EVIDENCE_ROOT。测试写合成系统剪贴板，结束不读取／覆盖可能已被用户更新的内容；helper隐藏、stdin关闭与看门狗退出，父进程有界等待后确认终止，避免与其他剪贴板烟测并行。原生Wayland仍有Electron#54645边界；Windows／macOS原生格式有字节夹具但未相应实机验收。原内部跨项目复制／剪切由 `desktop-cross-project-clipboard-live.mjs` 另验。
- `tests/desktop-system-text-clipboard-live.mjs`：真实桌面文本复制专项；独立GTK3系统读者 `native-clipboard-oracle.fixture.py`（Linux Python3＋PyGObject／GTK3，需DISPLAY）比较合成内容，若存在KDE Klipper则另比较其系统结果，只输出相等与否，不输出用户剪贴板。覆盖默认开发启动器、原生快捷键、可信应用write-only权限、正文／代码／Markdown／Word／PDF／表格／PPT、已有合成对话及代码按钮、cut/undo；不会调用模型生成内容。安装态传 `NOZELI_OZONE=x11 NOZELI_TEST_APP_ROOT=<release>/resources/app NOZELI_TEST_BINARY=<release>/nozeli`。只接受ELF二进制，**不得传用户安装wrapper／AppRun**，这些启动器会清除测试隔离标志，真实OS home也不会因伪造HOME而改变。现有真实项目的交互验收需要用户当轮授权，保留源文件／草稿／输入任务指纹，不默认进入CI或改写用户数据。
- `node tests/desktop-dynamic-geometry-live.mjs`：真实原生窗口 resize/maximize/fullscreen/restore，Word/PDF/图片/Markdown/代码/XLSX/PPT 在主窗、独立窗及回嵌的自动尺寸跟随；按窗口管理器实际客户区核对，不调用手工 flushBounds 制造成功。检查内部画布／iframe、手动与适应缩放、格式化内容、逻辑选区、未保存代码与源文件字节，不启模型。
- `node tests/desktop-file-export-live.mjs`：Linux DISPLAY＋Dolphin＋dbus-run-session＋X11/Python3；从真实文件树 Copy 到隔离 Dolphin Ctrl+V，检查中文特殊字符文件、打开并跨项目恢复的干净 DOCX/XLSX/PPTX、嵌套二进制字节及原件不变。系统剪贴板场景串行运行，只操作专用合成目标，不关闭用户窗口。
- `node --test tests/auto-update-package-smoke.mjs`：真实 Electron 发布物、回环 feed/tag/归档、下载校验、帮助进程交接、两类布局晋升及启动失败回退。`node tests/desktop-auto-update-live.mjs` 另以真实 Nozeli 设置页验证模态阻止、闲时退出、重启健康与用户数据保留；新进程须发布不同的即时调试端点，不复用旧端口误连。仅显式隔离实例允许回环测试 feed；不修改用户安装，不开放 renderer 路径／发布源参数。先构建 renderer／随包 runtime，不上传生成包或数据库。
- 已纳入维护套件的测试不再含 `/home/...` 绝对输出路径：输出统一走 `os.tmpdir()`（隔离根）或仓库内 `.test-output/`（已被根 `.gitignore` 忽略）。测试源中出现的 `/home/example`、`/tmp/...` 字符串均为拒绝路径/脱敏断言的合成输入，不落盘。

## 测试素材来源（fixtures）

`apps/desktop/tests/fixtures/`：

- `legacy-word/test01.doc`：上游 [node-word-extractor](https://github.com/morungos/node-word-extractor)（commit `18ddff5`，MIT，随附 LICENSE/SOURCE.md）的合成测试文档。
- `pdf/nozeli-sample.zh.pdf`、`office/中文 文档.docx`、`office/中文 表格.xlsx`、`ppt/compatibility.pptx`、`tex/pipeline.png`：为本仓库测试合成的样例文档，无用户资料。
- `archify/*.json`、`reading-report.txt`、`controlled-tool.mjs`：合成数据与受控工具脚本。
- 会话/项目状态类 fixture 由各测试在隔离根内即时合成；不存在任何用户 profile、凭据或真实会话数据，套件 fixture 不共享用户 profile。

## 结果与覆盖表述

- 通过/失败数目一律以 `node --test`（或冒烟脚本 report.json + 退出码）实际输出为准。runner 会把子进程**原始输出**原样落盘为 CI 工件：`apps/desktop/.test-output/ci/{suite}.tap`（node --test 套件的真实 TAP 流）与 `apps/desktop/.test-output/ci/smoke.log`（冒烟脚本真实合并输出），runner 自身不汇总、不复述计数。

## HTML 成果效果与冻结前后对比（2026-11-03，Linux 源码）

本轮修正成果入口：报告、对话冻结文件行及历史成果列表的文件名打开文档内容；发布版 Diff 保留独立动作。HTML 工作面新增前后效果及基线／当前稿代码对比，复用既有隔离 WebContentsView 和实际编辑器，未安装／发布，未调用模型或接受用户成果。

| 验证 | 实际结果 | 证据／边界 |
| --- | --- | --- |
| `node --test tests/isolated-preview.test.mjs tests/review-document-source.test.mjs` | 60/60 | 精确 owner／Work／publication／entry／side 授权，真实对象存储中的 HTML、CSS import、JS module、图片及缺失／损坏／并发变化；基线不使用文档缓存或项目依赖代替 |
| `node --test tests/host-review.test.mjs tests/frozen-change-reader.test.mjs tests/workspace-layout-store.test.mjs` | 39/39 | 原审校版本、冻结 Diff、保留状态与布局隔离回归；没有运行全量默认套件 |
| `npm run build:renderer`＋真实 Electron 源码候选 | 构建及原生界面通过 | 合成独立 profile，不冒充 Worker 推理；文件名默认实际效果、两侧各自 CSS／module JS、同面切换、窄屏上下布局、新增／删除缺失侧均通过 |
| 真实编辑器人工稿 | 非空编辑器实例、正文、选区、undo／redo 保持；右侧效果和代码 Diff 使用真实人工编辑缓冲 | 使用生产编辑器事务进行隔离稿修改，确认“人工审核稿／含未保存编辑”标识；没有用 mock echo 或空 DOM 身份比较充当证明 |
| 原项目只读验收 | 第 9 版报告文件名实际打开 HTML；两侧摘要分别为已冻结输入 `2656af4485c1…` 与候选 `f3056414b7c7…`；同面代码 Diff 两侧只读 | 当前稿／审校 token 保持，最后业务 job 未增加，未接受合入；原用户应用经正常关闭后使用最终源码候选重开，安装版不变 |

合成原生用例将项目同名 HTML／CSS／JS 改为 `POISON_LIVE_*` 后再打开成果，仍实际渲染 BEFORE／AFTER 各自冻结内容；不是只比较转发参数。截图来自真实 guest WebContents，不据 shell 截图宣称整桌面合成像素或跨平台通过。切换默认不主动保存；原有编辑器自动保存与显式保存规则未被改变。

原件：`/tmp/nozeli-result-effects-1dn93T/report.json`、`human-report.json` 及宽窄／人工稿截图；原项目 `/tmp/nozeli-result-effects-real-g6eloe/report.json` 及两侧截图；最终状态 `/tmp/nozeli-result-effects-final-state-JjVDkq/report.json`。对话文件名实际进入同一审核文档，独立发布版 Diff 已读取为两个只读面；自动化连续导航期间曾遇到 `LAYOUT_STALE` 的可见保护对话框，失败保留在 `/tmp/nozeli-result-effects-timeline-OtSomb/report.json`，未改生产逻辑掩盖或计作通过。关闭保护框后读取已创建 Diff，关闭时返回其实际来源文档而非脚本预设的对话；该脚本错误预期保留于 `/tmp/nozeli-result-effects-finish-diff-STDNWQ/report.json`。最终原应用留在第 9 版前后效果，审校版本及前台草稿与宿主一致；不据本专项宣称全部并发导航、Windows/macOS 或付费模型推理已验。

最终完整 renderer 构建及正常重启后的原 profile 冷态复验：`/tmp/nozeli-result-effects-final-state-KBhedb/report.json`。当前可见文档保持“前后效果”，审校 token 仍为 `01ee5df86020…`，最后业务 job 仍是原第 9 轮，未出现新输入／接受；未打开的对话不为检查而唤醒，宿主持久化草稿保留。该冷态验证不要求不存在的 conversation WebContents，临时驱动已清理，JSON／截图证据保留。

## 审核操作区改版与授权安装（2026-11-03）

- 用户截图指出继续操作藏在折叠项、接受按钮孤立；要求独立 reviewer 审核，并明确授权替换安装用于真实测试。审核区现为版本／状态明确的独立卡片，继续讨论／修改与接受成组可见，文件及版本详情为次级。展开意见不发送；发送给原 Worker 明确可能修改候选且仍需确认。Reviewer 首次阻断历史意见可编辑，修正 readOnly／IME 后最终 ACCEPT；新增的返回正文 bounds-ack→focus 顺序亦经 reviewer ACCEPT。
- `node --test tests/native-review-renderer.test.mjs tests/managed-review-draft.test.mjs tests/managed-review-availability.test.mjs`：最终 **24/24**，覆盖历史／结束／不可用只读、IME 转换、原文保留、草稿 CAS、确切 token、取消／保存屏障和回执不冒充合入。此前新测试的多 fixture 全局 DOM teardown 错误已按独立子测试修正，失败不计为通过。
- 初包 `/tmp/nozeli-report-endmatter-2UIADg/report.json` 与 X11 `/tmp/nozeli-report-endmatter-k3DiTI/report.json` 复现窄窗返回正文焦点失败。修正为先等待既有 native bounds IPC 回执再发 focus，不延长超时、不自动重试、不放宽可见性。中间 X11 fixture 错误删除 XAUTHORITY，已保留桌面授权而继续清除模型凭据。
- 最终冻结包 `review-actions-20261103T073450Z` 的真实 Electron/X11 使用原有合成 fixture 续验，`/tmp/nozeli-review-focus-resume-cYHVKN/report.json` 前 **8 项**实际通过：正文阅读、唯一审核区、可见主操作、本地意见保存不派工、接受／继续的取消优先确认、654／390px、不溢出、返回正文实际恢复 native focus、零新模型 job／agent／报告字节改动。其后因驱动错误要求历史报告出现当前稿 textarea 而失败，**该整脚本不记全绿**。历史分支另按真实只读呈现续验，`/tmp/nozeli-review-focus-resume-mqDcAT/historical-report.json` exit0：无可用业务决定、原历史意见不变、正常退出。当前／历史 Work 身份分开，无重复 fixture 派工或模型请求。
- 安装使用 `env HOME=/home/bfly node tools/install-local.mjs --existing-release /home/bfly/.local/opt/nozeli/releases/review-actions-20261103T073450Z`，真实 current 激活且 previous 保留 `2026-11-03T03-11-11-684Z`；桌面及 `~/.local/bin/nozeli` 启动入口同步。没有公开发布、Git提交或改写候选来凑验收。
- 实际安装 ELF＋原 profile 启动：`/tmp/nozeli-review-installed-FXLTq3/report.json` exit0，窗口已保持可供用户测试。原用户第 9 版此时已为 `ended/accept`、closure `blocked`；安装与只读验证前后相同，capabilities 依法禁止再次继续／接受，未重试技术合入。不要将该只读原项目检查冒充真实用户业务决定提交验收；可操作路径由上述隔离待审报告提供。

截图已目视检查：`endmatter-390.png` 双操作上下排列、意见／后果明确，桌面 `prominent-review-at-end.png` 双操作并排；来自实际宿主／guest WebContents，不声明整桌面原生合成矩阵或 Windows/macOS 通过。临时部署／续验驱动清理，原 JSON／截图保留。

## 审核固定布局、持久状态与重启续执行（2026-11-03，源码）

此修订不把前一节已安装快照当作新行为验收。当前源码把审核区作为独立不伸缩底部区域，HTML 原生 guest 是唯一正文滚动者；意见、文件及版本详情用按需 dialog，textarea 保持同一节点。短 pane 按实际宽高与字号切换紧凑模式，保留版本／状态、决定或收尾恢复入口，不增加 footer 内滚动。

### 已运行证据

| 范围 | 命令／实际结果 | 证据与限制 |
| --- | --- | --- |
| 生命周期、处置、真实冻结文件／Git、任务板、启动选择 | 八文件 `node --test` 定向集合 **106/106** | `managed-review-lifecycle`、`managed-workspace-disposition`、`managed-review-candidate`、`managed-local-disposition`、`managed-work-outcomes`、`managed-acceptance-frozen-bytes`、`managed-taskboard`、`task-restart-summary`；不是全量默认套件 |
| 最终恢复 owner／用户 entry／准入与启动边界 | `node --test tests/session-index.test.mjs tests/managed-review-lifecycle.test.mjs tests/pi-session-admission.test.mjs tests/task-restart-summary.test.mjs` **75/75** | 最后修正生产晋升、midturn entry 原子绑定及恢复 epoch 后执行；与上一行有重叠，不相加为唯一用例数 |
| 审核草稿、投影、对话框生命周期 | renderer 四文件定向 **29/29** | 原最小 DOM fixture 缺新 dialog/observer 原语导致失败，补齐后通过；实际视觉由下一行提供，不能由 stub 证明 |
| 真实 Electron 单滚动与固定底部 | `node tests/desktop-report-endmatter-live.mjs` exit0，3 组验收 | `/tmp/nozeli-report-endmatter-2c7hMx/report.json`；实际 native 正文 wheel、底部不位移不覆盖、意见重开／取消决定／历史只读；654×1150、390×844、390×480 和字号18。截图来自宿主／guest WebContents，未声称完整 OS 合成或190px全矩阵 |
| 真实审核→阻断→冷启动→原技术重试→结束 | 原生界面／真实 Git fixture，3 组通过 | `/tmp/nozeli-closing-resume-X4sBM6/closing-report.json`：真实目标冲突保留用户字节；确认后 closing、无 endedAt；冷启动保留原 binding／审核 token；移除仅由 fixture 创建的冲突后点击原重试，冻结内容只合入一次、完整 closure 后 ended，零 Worker 重放 |
| 原生 continuation | `node --test tests/pi-recovery-live.mjs` **5/5**（实现者实际运行） | 真实私有 Pi＋loopback，Worker／Orchestrator 的 ONE 副作用、同 thread／单 user entry、stale leaf／重复恢复／缺工具结果阻断、completed 零 dispatch、再次崩溃 durable fence；不是真实远程模型推理证明 |
| 生产 startup／localOnly 晋升联调 | `node tests/managed-production-restart-live.mjs` exit0，**3 组通过** | `/tmp/nozeli-managed-restart-live-rdiNcC/report.json`，8 次 loopback请求、diagnostics空；Orchestrator 未创建 Work 前及 Worker 实际写入后的原任务续执行，未准入队列一次、人工 pause／discard／前台草稿跨重启保持 |

### 状态与权限边界

- 已证实旧缺陷：`Workspace.end()` 先写 ended、取消结果事项；旧 restore cutover 能将 closing 直接转 ended 并补 endedBy=user；普通冷启动把所有 queued/running 输入改 interrupted。前两处已改为审核决定 closing、完整持久收尾后 ended；后者按原输入准入事实分类恢复，不将 host interruption 冒充用户暂停。
- 迁移只处理可证明的原决定和收尾事实：未完成的旧 ended 决定可归 closing；真实完成历史不重开；缺原授权／结果证据的异常保留并标 needsReconciliation，不按文字猜授权，不自动合入或删除。未审核 review 不因启动／闲置／读取而决定或结束。
- 技术重试有独立操作 requestKey／持久回执，保留原审核 authorizationRequestKey 与确切 binding；相同操作回执不再执行 Git。权限、冲突、未知提交仍保留原栅栏。
- Native recovery 绑定原 session/request/job/userEntry/current-branch/leaf；恢复前持久排他 intent，并给 SDK 准备修改后的 leaf fencing。待确认工具效果或恢复 dispatch 已发生而未确认时先核查，不无限自动重发。Controller 仅在原 job/session/entry 与恢复 attempt/owner epoch/settlement 全匹配后结算；原 attempt epoch 不改写。
- SessionIndex 同一次 `mutateNative` 绑定已验证 user entry，避免等待完整回合返回才有恢复身份；新 owner 事实只通过持久 recovery admission 的精确匹配，不给任意 epoch 开后门。生产 connect 将 localOnly Controller 通过 single-flight restore 后才调度，不能仅直接 Controller.open fixture 通过就宣称生产启动恢复。
- SDK continuation vendor patch 明确绑定固定 Pi SDK 1.4.0 私有生命周期；升级需复审并重跑真实 native 测试。原失败／aborted journal 保留，只有模型投影省略 aborted 尾部；不是删除历史。

两个独立 reviewer 对最终 pinned layout／retry 与 restart/lifecycle deltas 分别给出源码范围 ACCEPT；评审不替代上述运行结果。`npm run build:renderer` 及私有 runtime manifest 完整性解析通过。新回归分别登记 unit／integration／显式 live；没有运行 full/default、Windows/macOS、付费模型或改动用户安装／原项目来制造结果。临时 smoke／续验驱动清理，JSON／截图原件保留。

## 最新系统安装与 Liuhuaiyu 原项目复测（2026-11-03）

按用户明确授权，最终冻结安装 `durable-review-20261103T091200Z`，previous 为 `durable-review-20261103T090135Z`。使用现有 package-candidate → install-local --existing-release，不从源码目录冒充安装；`~/.local/bin/nozeli` 实际启动 ELF 及 current realpath 已核实。应用保持打开以供用户测试；没有提交、推送或公开发布。

- 原安装基线 `/tmp/nozeli-liuhuaiyu-before-durable-install-20261103T090135Z.json` 保存任务／job标量及源文件摘要。原第9版是 accept／ended／blocked，升级按可证明原审核绑定恢复 closing／blocked，清除虚假的最终 endedAt；六项真正完成历史仍 ended，无重开。
- 初装与正常重启原件：`/tmp/nozeli-liuhuaiyu-installed-durable-iHWMnP/report.json`、`/tmp/nozeli-liuhuaiyu-installed-durable-wiAuVY/report.json`。原始38条job的ID／状态及原审核 requestKey、binding、reviewVersion保持。审校未被再次接受，未新增或重放业务输入。
- 原项目实测补获展示残留：当前 closing 报告被旧 cancelled 提醒标为“事项已取消／历史报告”。修正展示优先级，不更改待办事实或审核授权；新增状态分类边界回归，`node --test tests/managed-work-records.test.mjs tests/review-only-inbox.test.mjs` **19/19**。重新冻结最终安装后，页顶与底部均表达原决定保留、收尾未完成，不再声称取消／历史。
- 最终实际安装与同版本正常重启：`/tmp/nozeli-liuhuaiyu-installed-durable-Y7eAdq/report.json`、`/tmp/nozeli-liuhuaiyu-installed-durable-e5nbHI/report.json`，均 exit0。启动自动核对期间可短暂 integrating，稳定后见后者 `settled-state.json`：closing／blocked、revision9、endedAt null、38条job；原确切审核绑定与版本保持。正文 wheel 后 scrollY>0，宿主 reader 与 managed-doc 均不可滚动，正文／底部不重叠且底部位置不变。
- 稳定阻断原因为“Worker修改了含用户输入覆盖的文件，需用户核对：binary-stars.html”；已显示原技术收尾与安全恢复入口，没有为了测试点击重试或强制覆盖。`data-preservation.json` 比较安装前后业务源文件（HTML、渲染器、视频、预览等）摘要和完整38条job标量，均一致。原项目没有新建合成业务来冒充 Worker 续执行；Worker／Orchestrator 的实际续执行依据前节生产 Manager＋loopback专项。

本轮是原系统入口／原 profile／真实文件与UI检查，不是浏览器模拟任务执行。截图来自实际宿主及 native guest WebContents，宿主截图本身不包含 guest 的合成像素；两者证据分别保留。无新模型请求授权操作、接受／丢弃或人工合并重试；未覆盖Windows/macOS、全部格式或所有并发用户操作。临时部署／复测脚本删除，报告和截图保留。

## 已审核未提交输入与Git锁恢复（2026-11-03，源码）

本节为上一轮实施证据；用户随后明确撤回其中的手动 Git 锁处理／技术重试产品流程。冻结输入与作者记录修复继续有效，技术故障改由后台记 bug 并维修；当前实际修复记录见后续章节，不把本节只读原项目边界当作本轮结果。

- 根因：整合和 adoption provenance 都误用旧 Git 提交作为修改前基线；任务真实输入可能是尚未提交或未跟踪文件。修正为读取冻结 input（候选父提交），精确摘要／权限仍须匹配当前磁盘，同文件索引仍须匹配原提交；回滚恢复真实用户输入，不删除原未跟踪文件。原 typed authorization、草稿屏障、并发冲突和无关暂存保护保持。
- `git-lock-recovery.test.mjs` 已加入 integration：真实 Git／文件备份、独占 hardlink、快照变化、符号链接、原事务 token、活跃 Git／持锁子进程、未知 FD 权限拒绝、持久回执和幂等。文件隔离成功协议由进程内受控 quiescence verifier 验证，RPC 不接受该选项；不把这部分冒充实际全局占用证明。执行者最终专项 14/14、零跳过。
- 父级串行聚合最初达到 68 个顶层通过、随后发现完成后的 merge consent 重放被 closing-only 门阻断，并于 300 秒超时；不记全套通过。修正为只回读已存在的、绑定匹配的原同意回执，不能对 ended 工作创建新批准。第二轮四文件 120 项中 119 通过、1 失败；失败原因是旧 tamper 用例对不同操作复用同一 requestKey，现按独立操作身份迁移，不能要求幂等重放重新执行。最终 adoption 全文件及 tamperedauth 专项 8/8、零跳过，覆盖未跟踪／修改过的输入完整 `ended/complete`、Worker→人工双段作者记录、磁盘不重写及无重复 commit。其他既有通过项没有反复重跑来制造总数。
- renderer 构建通过。真实 Electron/X11 使用独立 profile、合成已完成 Worker 历史和实际 Git／文件：原报告点击锁检查会打开可见的具体诊断；当前宿主 `/proc/1425/fd/0` 返回 EACCES，因此明确拒绝且保留锁、索引、用户输入、原审核决定。仅测试驱动把其自行创建的 fixture 锁移到备份后，原报告重试实际合入；首次实测还暴露 provenance 基线错误，修正后正常重启同一隔离应用，再从原报告重试完成 provenance 与清理，最终 `ended/complete`、UI“全部收尾已完成”。第二次只补收尾，commit 与首次合入相同。Worker job、未发送草稿和无关文件未变，provider 为零；前一轮真实故障产生一条 queued maintenance 审计事件，未执行，不声称整个 job 列表零变化。
- 原件：`/tmp/nozeli-reviewed-input-lock-Sks8oZ/report.json`、`pre-provenance-fix.json`、`actual-lock-refusal.png`、`complete-after-original-retry.png`。renderer 复用 review DOM 时的旧对象闭包已修正，锁拒绝消息留在原详情 dialog，完成后的只读报告摘要同步清除旧“受阻”状态。shell 截图不代表隔离 guest 或整桌面原生合成像素验收。
- 原 Liuhuaiyu 仅只读核对：当前 HTML blob 与冻结输入同为 `d10aac1542e40a12638c844bcbe3679a1e3d0900`；没有删除其锁、接受／重试原工作、改动用户文件、调用模型或替换安装。未知占用权限是本机锁自动处理的真实缺失前提，不通过关闭安全门、提升权限或假占用证明绕过。Windows/macOS 未验。


## 用户只决定结束，后台负责故障修复（2026-11-03）

- 用户明确纠正上一轮产品方向：结束决定之后的 Git／归档／退出／清理均由后台负责。删除普通报告、会话进度、任务目录菜单和任务概览中的技术重试、Git 锁处理入口及专用 RPC/helper；保留确切用户审核、真实危险权限和明确合入约束，不把技术维修重新交给用户。
- closure 的 `GIT_LOCKED` 和技术文件系统失败进入既有 maintenance ledger/event，自动进行有界宿主原事务恢复；不新增业务 Work，不重发 Worker/model 输入、不换授权。成功结清匹配 bug 与尚未准入的维修事件，保留 started/unknown 效果边界。持久 mutate 失败可能恢复 state 快照，本轮修复由此产生的陈旧 Work 引用：故障状态 mutation 内重新 `store.find(id)`，RPC 返回当前持久状态，避免实际仍为 report 却以旧对象宣称 blocked。
- 真实 Node/Git 专项首次 48 项为 46 通过、2 失败；两处分别是旧人工重试假设和真实陈旧引用 bug。修正后两项定向回归 2/2，通过自动修复、持久 blocked、原决定不可变、故障 repaired/event completed。初轮其余 46 个通过项包含原提交后故障不重复合入、持续锁第二次维修、自动丢弃、冻结输入作者记录与未保存冲突保护；不将初轮描述为全绿。
- 当前真实问题已解决：先通过原安装正常关闭并保留未发送草稿；只使用生产 DesktopHost／ManagedProjects local-only Controller 和原确认绑定，不启动 Provider。两项原故障持久记录后，原空 index.lock 保留逐字节副本及原 inode 备份，仅在本次用户明确授权的工程维修中移开；未对产品注入虚假全局占用证明，也未扩大为任意未知锁自动删除。已观察无运行 Git／可见持锁进程，但部分同用户进程 FD 权限未知仍如实记入维修证据。
- 原第 2 版 `8592cc76-f7bc-42d8-8d27-1f7b69e1171f` 完成原已准备提交 `6dcdd7c3c1d8997819a10f37a730c980de44a3ce`；原第 9 版 `c9a69447-37ca-4e2d-bfa1-c2edcab46c36` 合入为 `dbbde9e22973fa8c1300566e27db4fc70a8b08d9`。两者均 `ended/complete`、provenance complete，原 requestKey／binding／reviewedVersion／revision／threadId 保持，Worker job 与草稿逐项不变，零模型会话。
- 当前两项 bug：`bug:07fc0a4227af0440b2325cbf96c43c44a766416e7998ae0daf7ee0299dcef611`（GIT_LOCKED）、`bug:de436610640b474417e7957cedce26d8f6d0c9f4fabd4bff3f7676885156b183`（INPUT_OVERLAP）均 `repaired`；各自维修事件 `completed`。保留完整事实，不静默删除故障史。
- 实际原安装 `durable-review-20261103T091200Z` 正常重开、进入 Liuhuaiyu 后再次读取，两项仍 ended/complete，零 provider／运行 job；应用保持打开供用户使用，未替换安装文件、未发布。证据 `/tmp/nozeli-current-closure-repair-1793708067/` 的 `before.json`、`report.json`、`after-normal-reopen.json`、`lock-repair-intent.json`、`lock-repair-complete.json`、`installed-after-repair.png`。历史锁备份仍位于该目录 `historical-index.lock` 及原 `.git/index.lock.nozeli-repair-1793708067.backup`；不改写索引来规避冲突。

- 最终定向验证：`managed-local-disposition.test.mjs` **17/17**，包含退役 Git 锁 RPC 在任何控制器／仓库／维修账本写入前拒绝，外部锁字节不变；renderer 构建通过。真实 Electron `desktop-managed-work-directory.test.mjs` **10 checks**、`desktop-report-review.test.mjs` **14 checks、errors=[]**，验证报告／历史可读、草稿及版本身份保护、技术恢复入口不存在且不派发 Worker。目录首次仍含旧 retry 菜单断言，已按新合同迁移后才复测；不把首轮失败计为通过。原件分别为 `apps/desktop/.test-output/work-directory-nCMWAY` 与 `/tmp/nozeli-report-review-Y5EY20`。本轮未运行完整默认套件或跨平台验证。


## 安装后复杂真实任务与故障验收（2026-11-03）

- 用户授权安装和复杂复测。首装 `2026-11-03T12-41-53-640Z`；实际二进制发现冷恢复遗漏后修正并重装，最终 current `2026-11-03T12-56-26-197Z`、previous 保留首装包。均由既有 install-local 冻结、验证随包 Pi／Git 和激活，不使用源码运行冒充安装验收，未公开发布。
- **真实模型复杂任务**：首装包生产 ManagedProjects＋独立 native Pi 调用真实 `bingxing/GLM-5.3`，实现多模块 Node 标准库书目／批注证据审计 CLI，交付 12 个文件；第二轮增加 summary 与 strict 模式。独立 oracle（不是模型自测陈述）核验 Unicode、重复 ID、缺失引用、孤立批注、稳定排序、物理行号来源、Markdown 转义、异常 JSON/schema、禁止覆盖与 strict 无输出。并发人工保存只有一个 CAS 胜者、旧接受 token 被拒绝；冷开保留原 Work／native thread／草稿；最终人工稿精确采用。仅一个 Work、第 2 版、两次发布，三个业务 job 完成；Git 只有 baseline＋一次接受提交，原输入及原用户认证配置摘要不变。原件 `/tmp/nozeli-complex-real-model-Ro01eo/report.json`、`final-model-report.html`、oracle-round1／round2／adopted-output。
- 模型验收驱动最初读取被 agent 覆盖的 HOME，模型调用前失败；真实运行后驱动误以 HTML history 返回 inline body，改用生产 isolated `reportSource().read()` 完成同一持久 Work，未重派业务。这两次驱动错误不算产品故障，原失败与修正保留。真实模型两轮执行属于首装包；首装与最终包的 src 摘要差异严格只有 `src/main/main.cjs` 和 `src/agents/managed-projects.mjs` 的启动恢复修正，不将旧包模型调用声称为最终包重新推理。
- **最终包真实 GUI**：最终安装 ELF 打开上述真实模型项目、历史和原生隔离 guest，实际渲染第二版报告正文，显示“已接受／全部收尾已完成”，12 文件可见，原三个业务 job 及 Worker thread 不变、零 provider。宿主审核区截图与 guest 分开取证；通用 screenshot helper 对 guest 超时后通过 CDP `Page.captureScreenshot(fromSurface:false)` 取得并目视检查实际正文，不把宿主空白 guest 区域当作渲染成功。原件 `final-installed-state.json`、`final-installed-report-ui.png`、`final-installed-native-guest.png`。
- **最终包复杂故障矩阵 6/6**：真实 Git／磁盘／持锁子进程，包内生产 API，合成交付明确不冒充 LLM。包含两轮发布＋人工审校、未提交 tracked/untracked 输入、新增／删除／执行位／binary 与无关 staged/dirty 文件。用例为瞬时私有 index lock、真实 EISDIR、提交后 adoption 回调故障、持续锁＋冷开、并发用户正文、并发 staging。技术故障自动维修，bug repaired/event completed；提交后故障只一次 commit，不重放 Worker。后两类真实用户变化保持 blocked、零覆盖／零新提交，不误判为可自动越权修复的 bug。原件 `/tmp/nozeli-installed-faultmatrix-AsI9ZD/evidence.json`；首装矩阵 `/tmp/nozeli-installed-faultmatrix-JXBXYc/evidence.json` 仅证明调用生产 prepareOnline 能恢复，不能替代 GUI 自动启动。
- **复杂 GUI 确实发现并修复产品 bug**：首装二进制的独立 profile 无 AI 初始化，用户只接受一次五文件审核候选（含人工稿、未提交输入、binary、删除）后遇测试子进程持有的真实锁，自动记 bug／保留源文件且没有技术重试按钮。原持锁者释放后正常关闭重启，首装仍 closing/blocked；根因 main 以 AI 配置 gate 跳过全部恢复。修正为启动始终调用既有 resumeUnfinishedProjects，未配置／runtime 不可用时 hostOnly，只续有原确认的 closing，不初始化模型、不激活排队业务。确定性真实 manager/Git 回归 1/1。
- **同一持久 GUI 故障在最终包修后通过**：未改审核、故障或项目状态，只换最终 ELF 正常冷启动；尚未打开项目或调用任何技术恢复动作时，Work 已 ended/complete、provenance complete、原 bug repaired、维修事件 completed、ready=false／provider 0。独立逐字节核验人工稿、JSON、binary、增加／删除结果、无关 staged/dirty/untracked 材料及草稿保留；Git 恰 baseline＋一次合入，原 Worker job 一个，retryRequests 不存在。证据 `/tmp/nozeli-installed-complex-ui-UKgTU3/identity.json`、`blocked.json`、`blocked-without-user-recovery.png`、`final-installed-report.json`。测试锁由可证归属的子进程释放，没有偷删历史用户锁。
- 本轮未运行完整默认套件或 Windows/macOS。真实模型配置只复制到 mode-0700 私有验收目录，不记录密钥或 endpoint，不上传 private subtree；原 Liuhuaiyu 不用于制造故障。临时驱动清理，报告／真实交付项目／Git／截图保留供核对。

- 最后用真实系统入口 `~/.local/bin/nozeli` 和原用户 profile 启动，观察 `/proc/<pid>/exe` 确为最终 `2026-11-03T12-56-26-197Z/nozeli`；进入 Liuhuaiyu，两项原工作仍 ended/complete，provider／运行 job 均为零，应用保持打开供用户测试。汇总原件 `/tmp/nozeli-final-complex-install-verification.json`。未把独立模型测试 profile 设为普通用户配置，也未将验收源码写入用户项目。


## 执行状态、重复输入与大文档停止（2026-11-03，源码修正）

- 用户截图显示“执行过程 · 4 条记录／模型未记录／本轮尚无正文回复”，随后同一句“继续”两个用户气泡且其一标“输出中”。只读核对原安装真实 Pi journal：原 job `7a46f139-b6a3-4727-9dbf-2fdb7ebbedfc` 先列目录，随后 document_read 的完整响应 99,449 字节大于 run 剩余 62,350 字节；native tool result `a01fb4be` 为 HOST_CONTEXT_BUDGET_EXHAUSTED/hostControl，宿主记 completed/host-control，没有结论或新 Worker。不能据“4 条执行记录”声称优化已执行。后续用户主动“继续”只有一个 admitted job 和一个 native user entry；其原生 read/bash/write 有真实检查活动，但这不倒推上一请求已经执行。
- 重复显示根因在 `SessionIndex.event`：已验证 job 的 native user message_start/update 被存成 streaming 用户行，而 durable nativeDTO 又会隐藏同一个已绑定 user。旧短暂双气泡在落盘后自行消失；不是据此断言用户重复提交。现在用户原始 host input 为唯一显示权威，native journal/确认事实仍保留，native 用户 live echo 不发布。renderer 另按 job／session／request／native entry 证明合并，不按正文去重；不同 job 的两次“继续”仍分别显示。用户头部没有输出徽标。
- 消息状态复用实际 job／agent／tool facts；无模型事件时已有排队／启动只读状态行，第一条真实消息沿同一 turn key 接替，不制造正文或模型记录。折叠过程显示待完成工具；旧回合不继承新 owner busy，unknown 不冒充 completed。工具失败后确有最终回答可正常结算；真正 host read error/预算阻断显示受阻，合法 dispatch/publish 的 host-control 不一律误标受阻。历史模型从同回合 assistant 获取，缺事实仍未知，不借 tool/user 或当前设置回填。
- 文档读取修正见[上下文接口](context-delivery-design.md#15-已实现的交付接口与验证范围)。真实 Pi owner＋生产 DesktopHost／frontdesk document executor＋无凭据 loopback Provider 冒烟 `/tmp/nozeli-pi-real-65Zz4N/bounded-read-smoke.json`：72,200 字符来源交付 5 页／43,758 字符后累计读取额度耗尽，原 native 回合仍收到明确未读范围的最终正文；7 次 provider 请求为同一 user entry 的工具循环，不是 7 次用户发送。只有一个 frontdesk job、一次原生 user admission，provider-completed，文件未修改、版本／句柄一致。此证明不是远端真实模型理解质量，也不声称全文已读。
- 首轮 5 文件聚合 60 项为59通过、1失败：旧用例还要求读取限额直接 hostControl。迁移该消费合同后，拒绝效果与同回合冻结分页／最终回答定向2/2。输入索引的新回归覆盖 live→durable 不重复、相同正文不同 job 保留及 assistant streaming 不受影响。最终执行状态回归6/6、renderer构建通过；新两份 unit 文件加入既有 suite。没有通过提升预算、重复 prompt 或删除历史记录修复。
- 真实 React/Electron 可见窗口消费烟测通过，`/tmp/nozeli-session-consumer-uU6NTh/` 保留执行前排队、工具运行／受阻、等待、390px暗色及宽屏截图；已目视检查状态徽标、过程摘要及无用户输出状态。验证还覆盖折叠／键盘、历史模型、失效 owner、失败、长原文和选区。中间 GUI 用例以旧折叠标题字符串查节点失败，已删除措辞耦合，改为验证实际 disclosure 行为；状态用例曾误计额外只读状态行为用户气泡，改为核对用户身份集合，而非固定总 DOM 行数。
- 未替换当前安装，未停止／重启用户会话、重发原问题或代为派工，未写用户轨道文件；只读诊断 `/tmp/nozeli-execution-display-diagnosis-20261103.json` 保留精确关联。Windows/macOS、远端模型及原用户任务最终执行结果未据此声称通过。


## 主对话直接提交后台入口恢复（2026-11-03，源码）

- 用户指出输入区缺少直接提交后台按钮。核对发现 `__agentSend({background:true})` → `managed.send(...background)` → `managed.task` 的提交链仍存在，但输入区只有普通发送；消息内转任务、引用提交和标签小窗不代替主输入的显式直接交接。现恢复发送旁常驻“提交后台”，type=button 不触发表单普通发送，复用原输入／材料校验、草稿持久化屏障、项目／目标身份及确切请求去重，不另建派工协议。
- 会话未就绪、归属核对中、历史只读时禁用；提交中禁用同一按钮并显示等待接收，宿主接收后才按原快照清除，失败和后来输入保留。普通发送仍进 frontdesk，直接后台进入 orchestrator intake，不先发前台消息。
- 真实指针测试发现材料错误 toast 覆盖按钮，后续点击未进入元素。`#toast` 是仅文本的 role=status，现保持可见但不截获指针；新的有效提交只撤掉本输入区上一条已过时的失败提示，不隐藏其他通知或当前校验失败。没有以 DOM .click 或直接调用 __agentSend 冒充鼠标通过。
- 先前尝试把旧多项目回归的隐藏程序化提交直接改成鼠标操作，多次未准入；保留失败原件 `/tmp/nozeli-frontdesk-only-V7aGSr`、`O6q6Gw`、`7yeeRq`、`1fLqAL`。旧测试已恢复原来的程序化边界，不宣称整套通过。新增独立 `desktop-direct-background-live.mjs` 并加入显式 opt-in live：真实 Electron、独立 native Pi、真实文件/Git、无凭据 localhost scripted Provider；不读取个人账号或改用户项目。初版驱动项目 scope 尚未生效、以及未启用截图作用域的 resize 均明确失败，修正等待原绑定及使用既有测试 opt-in 后才验收，不作为产品故障吞掉。
- 最终 `/tmp/nozeli-direct-background-HrzOKw/report.json` 为 ok=true：材料失败后草稿／材料逐项保留，零 job／模型调用；连续两次可信原生指针点击后恰一个 orchestrator intake、一个 Work 和一个 initial Worker job，frontdesk job 为零；真实 Worker 在隔离 worktree 写 result.txt 并发布，原项目文件未变，待审而非自动接受。确认接收后原输入清空、过时失败通知不保留。宽屏及590px原生窗口的“提交后台／发送”均在可见边界，正常退出0；`button-before.png`、`button-after.png`、`button-narrow.png` 已保留并目视检查。
- renderer构建通过。当前为源码修正，未替换安装、未操作用户原任务；完整默认回归、远端真实模型和Windows/macOS未在此轮重验。


## 主控内部失败归系统处理（2026-11-03，源码）

- 原截图对应 intake `d59ad276-1b04-48c7-b88d-57b714dee4ed`，用户目标“开始落盘”。只读核对原 native journal：主控第一次调用 `nozeli_inspect_work({workName:'@state',cursor:''})`，宿主拒绝无效游标，native tool result `483d31cd` 为 INVALID_CURSOR/isError，整个回合随之失败，job 被标 diagnosticOnly 且没有 maintenanceBugId；尚未创建 Worker 或发生写入。不是用户需要决定的业务问题。原件关联 `/tmp/nozeli-internal-intake-diagnosis-20261103.json`，未重发原任务或修改原安装状态。
- 可纠正的只读游标／参数协议错误现在进入原回合结构化 `{ok:false,continueTurn:true}` 返回并持久记入 tool-protocol bug；明确要求同回合按工具协议纠正，不新增用户 prompt，不静默构造游标，不扩大读取／写入权限。同 job 的同读取工具实际成功后，宿主才把关联故障结清。未纠正仍留诊断事实，不以模型口述宣称 repaired。
- 真正 host 异常跨 PiSession→native tool bridge→OwnerRuntime→owner JSONL→PiSession 保留严格枚举 failureOrigin 及受限 hostToolCode，不能只因包装码以 PI_ 开头就当 Provider 失败。内部异常进入既有维护账本，关联 maintenanceBugId/maintenanceFault 并保持原输入和已发生效果；无原安全动作时不重建或重放 admitted/unknown prompt。真实 provider 拒绝／账号／网络仍沿现有服务事实处理，不制造额外付费诊断回合；权限、陈旧版本、退出未确认与未知效果既不越权自动维修，也不误记为 Provider 故障。
- 请求目录用原 userGoal／原消息身份展示短名称，不显示宿主协议包装文本。未派 Work 的内部故障打开只读请求概览，保留真实 failed/blocked 事实，默认只显示系统处理状态与原请求保留；原异常及事件放在折叠诊断。无普通 intake.retry、执行控制或重新核对调用。真实 Work 的暂停／停止／结束、报告与明确权限决定未移除。native host-control 已结算但仍有 internal maintenance 的请求也投影为系统受阻，不能冒充业务完成或永远等待派工；native job 原始 completed 事实不改写。
- 默认对话通知只说明系统已接管、原内容保留、无需重复提交，不附长 bug hash 或原始异常；日志仍可凭 job 绑定关联。没有通过隐藏持久故障、删历史或假装任务成功减轻界面负担。
- 确定性回归：taskboard 10/10；maintenance-runtime＋pi-session-admission 52/52；最终 domain/directory 21/21，补充 host 边界及非技术通知定向2/2。覆盖精确游标、分页失效、无新 Worker／无原 prompt 重放、Provider 无额外扇出、历史明确 host 证据接管和未知效果无伪造 action。
- 真实私有 native Pi＋生产宿主工具、无凭据本地 scripted Provider 冒烟：`/tmp/nozeli-pi-real-wxFWGd/cursor-recovery-smoke.json`，原输入一次准入，三个请求是同回合“无效参数→纠正读取→一次派工”，只有一个 Work，bug 实际 repaired，无额外 maintenance/backstage 模型回合。`/tmp/nozeli-pi-real-DrqbPQ/host-fault-origin-smoke.json` 注入真正 host 异常，跨原生边界保留 origin/原工具机器码，一次模型调用后持久 bug 和维修事件，无 Worker／业务重放／用户维修 todo；不是任意源码缺陷已自动修复的证明。
- Pi runtime 和 renderer 构建通过。真实 Electron 请求／目录消费者分别5项和10项通过，最终 `.test-output/work-intake-FNCCO1/`、`.test-output/work-directory-Uw7RjG/`；已目视检查 internal-request-readonly.png，无截图中的技术维修按钮，宽／窄分类仍显示故障。旧 intake fixture 曾在不拥有 conversation 的 shell 调 __agentSend，按设计未创建任务并超时；现按持久宿主状态消费契约验证 GUI，不将注入状态测试冒充实际模型修复，native 链路由前述独立冒烟证明。
- 本轮未替换安装、未改用户任务／文件／认证，未运行完整默认套件或跨平台验证。临时 native 驱动清理，原始诊断与实测 JSON／截图保留。


## 对话分区宽度自适应（2026-11-03，源码）

- 用户截图显示宽窗口中的消息、执行状态和输入框仍居中于固定窄列。根因是共享 `--chat-column:48rem` 同时约束 timeline、compose form、输入归属说明及协作条。现将会话专属共享列改为容器相对100%，导航及状态条 fallback 同步；不改文档阅读宽度、模态对话框上限，不新增窗口宽度猜测或 resize 重建逻辑。滚动条保留原稳定占位，消息列按滚动区实际内容宽度展开。
- 真实 Electron/X11 验收扩展既有 `desktop-direct-background-live.mjs`：先经实际 native Pi／隔离文件交付形成真实会话，再验证1440→980→590→1440窗口变化、实际指针按住 divider 拖动、同一 WebContents 脱离1120/680独立窗口及 dock 返回。每次检查消息、执行状态及输入框接近其当前容器可用宽度，无横向溢出；真实拖动前后原生对话视口565→665，非只检查外层可见。
- 最终 `/tmp/nozeli-direct-background-swP1jq/report.json` ok=true：主窗宽状态输入约1105px、窄状态约473px，独立窗口约1087px→658px；消息随滚动区同比变化，不再停在48rem。composer/timeline保持原DOM节点，未发送草稿、输入选区6–18与消息实际选中文字跨 resize／drag／detach／dock 全部保持。job身份和三次原生 scripted provider 请求不变，布局不发送草稿或重放任务；正常退出0。该验收使用本地脚本模型而非付费远端，用户数据未操作。
- renderer构建通过，宽／窄及独立窗口截图已目视检查：`fluid-window-1440.png`、`fluid-window-590.png`、`fluid-detached-1120.png`、`fluid-detached-680.png`。首版驱动误把窗口目标宽度与内容视口宽度比较、遗漏布局操作requestKey/revision，以及从不允许的 detached chrome 发测试 resize，均明确失败并保留原件；修正为实际窗口基线、宿主版本绑定、已授权内容 surface 测试入口后才通过，没有放宽生产IPC权限。
- 当前仍为源码修正，未替换安装，未运行完整默认或Windows/macOS验收。


## 新项目真实模型与安装版系统验收（2026-11-04，Linux）

- 用户授权安装并新开项目测试。最终安装为 `2026-11-03T17-14-57-747Z`，上一版 `16-55-59-996Z` 保留；未提交或推送 Nozeli 源码。使用正式安装二进制、独立私有 profile 和复制的既有模型设置，不修改日常项目。原 `models.json`、`auth.json`、`models-store.json`、`nozeli-role-defaults.json` 四项 SHA-256 与启动前一致。
- 实际项目 `/home/bfly/workspace/nozeli-system-test-20261103-0e4e24fe`：前台 `bingxing/GLM-5.3-Flash` 对 90,023 字节只读需求文档实际执行两次有界读取，给出中文正文并明确未读全文；原输入仅一次准入。显式“提交后台”经 `paratera/gpt-6.1-sol` 主控派给 `bingxing/GLM-5.3`，交付多模块 Node CLI，不是模拟报告或由验收者代写。
- 首轮独立数值 oracle 59/59，但追加四项实际边界检查失败：动量抵消、大数质心、中间乘积溢出、合法 JSON 转义键。原件保留；没有直接接受。通过真实报告“继续讨论 / 修改”及绑定确认交回原 Worker，同一 Work 进入第2版，仅增加一个 manual job，并加入 `--max-energy-drift` 的严格阈值需求。
- 第二版独立验收 69/69＋原四项边界4/4；实际接受并合入后，直接在上述项目根目录再次69/69＋4/4。八个实现模块摘要与已审查候选一致，七项原始种子文件摘要保留，复验前后26个项目内容文件未变。原件 `/tmp/nozeli-trajectory-postaccept-summary-20261103T173223161155Z.json` 及其 freeze/evidence、两处原始产物目录；不把模型自述作为验收。
- 实测修复：有效派工可使先前拒绝的只读查询不再必要，依据原 intake 的持久路由和原 Work 来源结清 `tool-protocol` 诊断，不重放查询、prompt 或写入；冷打开补记同样只结算凭据，未知 transport 保持保护。原任务未重新发送。
- 实测修复：真实报告已交付却被先前已纠正的工具错误误标整轮失败。只在 job 已完成且冻结结果精确匹配 work/job/revision/objectId 时确认交付；续作后的旧轮还校验冻结报告摘要，显示“已交付”，当前待审轮显示“已交付 · 待审核”。失败、中断、未知结算和真实 host-control 拒绝不能被成果覆盖。
- 实测修复：宿主报告摘要没有逐消息模型字段时，使用其精确绑定的已完成原生回合 `effective.provider/modelId`，而非当前设置。实际冷打开的两版 Worker 报告均显示 `bingxing / GLM-5.3`；原逐消息记录优先，来源／目标／版本不匹配或未完成的回合仍保持未记录，不改写原历史。
- 实际安装版1440→980→590→1440缩放：输入宽度约1105→851→473→1105px，无横向溢出，同一输入DOM、未发送草稿和4–15输入选区保持；跨重启草稿保留。布局不准入新业务。前轮真实 native 文件/Git 的 divider、detach/dock 验收仍见上一节，不冒充本轮重新跑过。
- 第2版经可见确认接受确切审核版本 `4454842a0004a93cddab5a22be321385a8770a0b34efcaf209ace3fca1e27c7d`。自有子进程独占真实 `master.lock` 时保留 `closing/blocked` 和原确认，不移除未知锁；锁持有期间实际发生一次绑定该 closure bug 的维护诊断，不是原业务重发。正常退出0后，持锁进程核对 inode 并释放自己的锁、退出0；最终安装版冷启动完成同一 requestKey 的原事务，`ended/complete`，目标 master Git计数1→2，合入 `b61634803a9a1754c6dfce388ad667dbf5dee502`。四个原业务 job 身份保留，未重新提交业务。
- 最终安装包 native 故障矩阵6/6：真实 Pi、生产宿主、真实文件/Git、localhost scripted Provider，涵盖纠正读取／无需重读直接派工、累计预算、读取前／读取后／副作用后 fatal host 异常及无AI配置 hostOnly 冷收尾。原件 `/tmp/nozeli-installed-native-faultmatrix-171457-l8Tvwn/evidence.json`；三个 fatal 保留真实失败和 needs-version-fix，各允许一次绑定维护诊断，零业务重放、额外 Worker 或 Provider diagnostic。此矩阵不是远端真实模型推理证明，真实模型证据来自上述独立项目。
- 定向回归53/53（taskboard、maintenance、预算、展示），模型历史与展示32/32（包含前述7项展示回归，不累计为独立85项）；renderer构建及可见 X11 React/Electron consumer 通过，后者 `/tmp/nozeli-session-consumer-WRzFPr`。先前隐藏窗口运行两次180秒超时，未计通过；使用可见 X11 窗口后才通过。
- 实际 native 窗口像素 `/home/bfly/.cache/nozeli-system-acceptance-V6wWD4/final-native-accepted-window.png` 经目视确认：第2版已接受、全部收尾完成、报告正文实际显示、待办0。该目录同时保留身份、布局、原确认／冷恢复 JSON 与截图。报告包含独立原生子视图，单一 WebContents 截图的留白不能当作整个应用的空白或成功证据；最终像素按本次 Electron PID 精确定位 X11 窗口捕获，没有截取个人桌面。
- 仅 Linux/X11 验证；未运行完整默认套件、Windows/macOS、真实 OAuth 或整个 IEEE-754 输入域的穷尽检查。数值 CLI 是系统验收项目，不成为 Nozeli 产品运行依赖。


## 不同类型真实任务：离线会议室预约 Web 应用（2026-11-04）

- 用户要求再次独立出题并换任务类型。专用 reviewer 子进程因未配置模型启动失败，工具也拒绝显式 model override；已告知用户，未把失败当出题成功。改由独立 task-worker 承担出题／外部判卷职责，主代理只负责安装版真实提交、人工浏览器操作和接受；不代写候选。题目、两轮要求、隐藏判卷器分别为 `/home/bfly/workspace/nozeli-reviewer-task-77695d0046/README.md`、`/tmp/nozeli-different-task-plan.json`、`/tmp/nozeli-booking-browser-oracle.mjs`，后两者未交给解题 Worker。
- 在既有安装包 `2026-11-03T17-14-57-747Z`、全新私有 profile 中，通过真实“提交后台”按钮交接。`paratera/gpt-6.1-sol` 主控创建一个 Work，`bingxing/GLM-5.3` Worker 完成 HTML/CSS/JS＋Node 标准库静态服务器；无依赖安装或 CDN。第二轮通过第一版报告的“继续讨论 / 修改”与确切确认交回原 Worker，仅新增一个 manual job；两轮共一个 intake、一个 initial、一个 manual，均完成。
- 第一轮独立真实浏览器47项通过：文件选择器、真实下载、ASCII排序、同文件重选、日期与半开区间冲突、完整导入事务、编辑／取消／删除、无变化提交、30步撤销、100条数据、显式保存／刷新和配额／读取故障保护。判卷器首次预期数据有引用别名错误，仅修改外部 oracle 的克隆方式后重跑；原失败 `/tmp/nozeli-booking-verdict-0RP9ip` 保留，不归为候选失败。最终第一轮 `/tmp/nozeli-booking-verdict-7ifn88/report.json`。
- 第二轮增加多选预约整体时间平移，按最终整体状态校验，成功整批一次 undo。独立70项通过，包含第一轮完整回归、未选／非法分钟／跨日／冲突整批拒绝、23:59边界及批次保存故障；最终 `/tmp/nozeli-booking-verdict-vKho3w/report.json`。主代理另在可见 Chrome 实际导入、保存、编辑、撤销，两条相接预约＋30分钟成功，一次撤销恢复，单独平移 alpha 时冲突明确报错且仍为 saved；截图在 `/home/bfly/.cache/nozeli-different-task-IRjRuZ/`，没有调用候选内部状态代替交互。
- 可见 Nozeli 确认接受第二版审核令牌 `142080e9c876cde76fdf2ef495281c0dbd8938af8f6dde21a2c3011dd5b80488`，最终 `ended/complete`，目标合入 `171a50d2b0f2f6b12062262d8a26c2104b63453c`。随后直接在实际原项目启动并再次独立70项通过：`/tmp/nozeli-booking-verdict-jegKeA/report.json`；七个交付文件和 `.gitignore` 与审查候选摘要一致，两个输入原 SHA-256 保留，`user-input/personal.json` 在原项目仍未跟踪。隔离 execution 中的跟踪来自 Nozeli input baseline，未误判为 Worker 擅自 git add。冻结证据 `/tmp/nozeli-booking-accepted-1793749594036125614-evidence.json`。
- 真实测试发现 Nozeli 历史报告元数据混用：读取第一版对象，`revision` 却为当前工作2，`merge` 和 `mergeConsent` 指向第二版，续作取整个工作最后一项。精确接受实际绑定第二版，未发生错版本合入；保留原 API 证据。源码修复 review.read 的 revision 为原发布 revision，另给 workRevision；合入／许可和续作按发布对象隔离。旧报告主条和 compact 状态显示历史只读，旧报告不显示新版本的收尾区或接受结果；未改原报告正文或接受权限。
- 新增实际 A→续作→B→接受B 回归，在修复前失败，最终候选／原生展示／报告投影59项通过。renderer构建通过；`/tmp/nozeli-historical-review-smoke-FtysDY/report.json` 使用真实生产 Controller、真实文件/Git 的两版 DTO，挂载生产 review 组件到可见 Electron，实际显示“第1版 · 历史只读（当前工作第2版）”和“第2版 · 已合入 main”，旧版接受按钮禁用，截图已检查；先前冒烟 kXmFoU 原件保留。该消费者冒烟不是远端模型验收，真实模型／完整安装版链路为前述预约任务。
- 本轮没有安装授权，历史状态补修仅在源码，未替换安装版、未提交或推送源码；用户原账号／角色四文件摘要与本轮启动基线一致。观察脚本曾受 Puppeteer 默认180秒 protocolTimeout 影响，修正观察协议期限后继续等待同一原任务，没有重发业务；不将观察器失败算作模型或产品任务失败。仅 Linux/X11＋当前 Chrome，未跑完整默认套件或 Windows/macOS。


## 日常对话连接：已接手空线程被旧历史误阻断（2026-11-04，已授权安装并实窗验证）

- 对用户当前日常安装进程做原生窗口检查，实际提示为“原会话需要确认接手，请在连接与历史中处理”，对应 `AGENT_HANDOFF_REQUIRED`／`PI_TOOLS_DIGEST_MISMATCH`，不是本轮已证实的网络或认证故障。旧 DevToolsActivePort 已失效，未拿隔离测试窗口充当当前窗口恢复证据。
- 只读检查业务／UI SQLite 和原生日志的类型与身份，不输出用户正文或凭据：当前前台、主控均 `zeroActivity=true`、handoff=ready，日志只有 session/model_change/thinking_level_change/session_info；既有任务和消息绑定此前已归档的线程。原实现却把同角色所有旧任务／消息都当作当前活动，并无条件禁止带 handoff 的空线程迁移，因此工具定义更新后反复要求确认接手。
- 修复 Controller 的空协议升级准入：先证明 ready handoff 与归档标识一致；只有已终结、且所有原生绑定均属于旧归档线程的任务，以及可精确回溯这些任务／线程的消息，才不计作当前活动。队列／执行中任务、当前准入、无归属或混合绑定、当前消息均继续阻断。日志仍要求普通文件、非符号链接、有界、只含允许的初始化类型；已接手线程还须存在匹配当前线程的 session 头。未手工覆盖用户 toolsDigest、数据库、原生日志或任务状态。
- 新增回归在修复前真实抛 `PI_TOOLS_DIGEST_MISMATCH`；完整居民恢复40项通过，最终新增八项再次通过，覆盖空线程成功及当前准入、无绑定、当前消息、错误日志身份、原生消息、混合绑定、未完成 handoff 的拒绝，历史／草稿／任务／归档均保留。八项与完整40项重叠，不累计为48项。
- 真实生产宿主＋原生 Pi 冒烟 `/tmp/nozeli-empty-resident-native-LAiaGd/report.json`：仅最初构造旧历史时调用一次 localhost scripted Provider；支持的确认接手产生空线程，再模拟原生／宿主协议摘要漂移。修复后启动成功，恢复阶段 Provider 请求为0，原业务 job仍1、归档仍1，旧历史字节、当前初始化日志前缀与未发送草稿均保留，未新增消息或任务。原生适配器可以保留空线程ID，因此验证不强制换ID；首次驱动错误假设必须换ID的失败原件 g7jceq 保留，不计为产品失败或通过。
- 用户明确授权安装并正常重启。准备正常关闭时原日常进程已自行退出，未发送关闭／强退信号；安装 `2026-11-04T00-46-19-337Z`，保留上一版 `2026-11-03T17-14-57-747Z`。沿原 HOME、配置与日常 profile 重开，原 `nozeli_test` 连接 ready=true、前台／主控idle、无connectionError/handoff；没有删除原会话、改凭据或重发旧任务。
- 用户随后指出仍异常及“执行结束没有回复”。继续检查发现另一个项目 Liuhuaiyu 的非空旧线程仍需要真正的协议接手，不能套空线程放行。再次展示差别并获用户明确授权后，通过生产 `managed.resident.handoff` 精确token先后确认前台和主控，旧归档保留；最终ready=true，输入可用，异常0，无新增业务job。历史消息一次状态投影分页减少一个条目，但对应业务SQLite原件仍存在，未误报删除或无条件宣称数组相等。
- 缺回复还须逐请求区分：旧 Liuhuaiyu job `04317eeb-cd90-447a-bd65-5541735ebdbe` 以 host-control 结束，原生读取99,449字节超过63,488剩余额度后返回 `HOST_CONTEXT_BUDGET_EXHAUSTED`，无最终正文、未取得编辑基线；未重做旧任务。用户新发 nozeli_test“当前模型”的 job `ed374f83-b993-4d23-8d5b-fef8c41cfdcc` 则 provider-completed，原生assistant `843240ac` 有最终正文；已核对生产DOM及整个native窗口实际可见，前台标识 `bingxing / GLM-5.3`、异常0、可继续输入。模型正文自称不知道型号与程序掌握的实际模型事实不同，未篡改生成正文。
- `/home/bfly/.cache/nozeli-connection-repair-BpmNT0/verified.json`、before/after摘要和 `current-reply-visible.png` 保留实际证据。原nozeli_test五个job、八条消息摘要逐项不变，旧归档／两份历史日志和1.md摘要不变；新增一个job和两条消息来自用户本次新输入，不是恢复重放。仅Linux验证，无全套或跨平台宣称。


## 沉浸对话：输入框下方 F/O/W 紧凑模型状态栏（2026-11-04，源码待安装）

- 用户明确要求移除截图中占据顶部的大块执行概览，仅保留角色关键字与状态色，并直接切换模型。`collaboration-status` 现在挂在 compose-form 后，默认最多四个短控件 F/O/W1/W2 与 `…`；不再常驻执行标题、计数、最近同步、闲置说明或展开卡片。点击角色复用原 `model.options/model.set` 的 owner、generation、Work revision 和请求去重；更多列表、计时、刷新、完整诊断／维修约束仍在原生 dialog 按需可达，不删除故障事实。
- 状态色采用对话主题语义色；执行为绿色实点，排队／等待／待审等为琥珀菱形，失败为红色，休眠／未连接为弱化色；未知、陈旧或读取失败为虚线空心，辅助文本包含确切状态，不单靠颜色表达。Worker短编号在同项目内稳定；项目切换清理旧角色，晚到响应不替换当前项目。
- 输入框去掉独占一行的常驻状态占位，缩小内边距和输入高度，默认提示改“聊一聊…”，快捷键／@引用／图片粘贴说明放title。材料归属仍可见，原校验、提交后台和唯一发送链不改。原生布局已允许320×240边界，本轮不新增窗口API或放宽生产session.resize测试入口。
- 状态／时间定向25项通过；真实可见 Electron 生产组件消费者 `/tmp/nozeli-collaboration-ui-LALy5E/report.json` 通过：角色键盘打开模型、分页后焦点、模型pending→applied保留搜索／选择、保存中可关闭且草稿不变、晚到项目响应、320px单行及未知形状、修复权限与错误可达。其gateway为合成数据，不冒充真实模型调用。
- 生产源应用＋真实native Pi／文件/Git＋localhost scripted Provider 的完整往返 `/tmp/nozeli-direct-background-KsDEJn/report.json` ok=true、正常退出0：实际指针双击后台只准入一次，Worker真实写文件并发布；1440/980/590窗口、divider拖动、1120/680脱离及dock均保持同一composer/timeline、未发送草稿、输入选区6–18与消息选择。没有新增模型请求或业务job，消息区顶部无原大块状态栏。
- 小窗独立可见 Electron 消费者 `/tmp/nozeli-compact-compose-lceKR3/report.json`：使用生产输入HTML、消息React组件、状态组件与CSS，原生BrowserWindow分别680×500、360×360、320×300，浅／深主题全部通过。角色栏32px高；320×300仍保留约117px可滚动消息区、输入／发送／后台按钮均在视口内，无横向溢出；草稿、原输入DOM与选区2–7保持，角色点击实际打开模型选择。截图 `light-320.png`、`dark-680.png` 已目视检查。此小窗gateway为合成状态，不声称完整原生模型链在320×300又重跑。
- Renderer构建通过。外部扩展驱动尝试CDP Browser.getWindowForTarget时Electron不支持、X11尺寸定位丢失目标以及初始同尺寸resize竞争、主进程inspector选择窗口失败，原件 NpGCa3/eG1rQL/w6Pegm/eebzZp 保留且不计通过；改用已有完整原生布局验收和直接生产消费者小窗分别证明，不放宽断言假报整套。临时消费者初版缺导航portal，修正后才验证实际消息DOM和截图，旧Dydgwm/1KZxOn不能作为消息渲染证明。
- 本轮未安装、未提交／推送、未触碰用户项目或凭据，未运行付费模型或完整默认套件；仅Linux/X11限定。原安装版在用户授权部署前保持不变。


## alpha.5 发布准备（2026-11-04）

- 用户明确授权提交全部修改、推送并发布 alpha.5；再次明示六项分发审计未签收后，用户选择“发布 alpha.5 预发行”。此为本次公开 Alpha 例外，不构成许可证签收、稳定版认证或后续发行授权；`--public` 如实失败六项，普通 `--verify-hashes` 通过。
- 版本元数据统一为0.1.0-alpha.5；Pi/PPTist/renderer构建通过。首轮完整unit632项通过；随后将遗漏的collaboration-timing与managed-work-directory行为回归登记默认unit，最终数量以本轮完整结果为准，不相加旧专项计数。
- 完整smoke初次在renderer-projection-coalescing的旧“主输入切换orchestrator”断言失败，和当前前台唯一主对话契约冲突。删除已废弃目标切换断言及内部paint次数接线断言，保留实际导航并发／过时响应不污染当前文件的行为检查；该真实Electron消费者单独通过。没有为测试恢复任意Agent主输入能力。
- 候选检查workflow改用现有build:pi和Node22.22.2，保留公开审计失败门；便携包说明改为真实Pi会话运行时和当前Alpha授权／未签收义务，不再将本版描述为运行依赖系统OMP。审核内原Worker只读连续问答仍仅为设计，未加入本次实现声明。

- 最终登记后的unit **643/643**、smoke **5/5脚本**通过。完整integration早期与远端合并重叠的运行含临时冲突标记，不计通过；干净合并后的1705项中9项失败均保留。修正旧恢复夹具：never-admitted排队恢复恰一次、admitted-unknown保留原生续作、缺原执行证据保持needs-reconciliation；未将旧“全部interrupted”契约恢复到产品。补齐直接构造Controller读工具测试的真实jobs账本，资源摘要明确验证unknown工作pendingVerification；相关聚焦30、10、21、7、10、1项分别通过，集合有重叠不累计。
- opt-in原生资格库初跑暴露两处过时UI路径，不计整体通过：discard完的Work已离开进行中列表，测试改走真实“历史”分类再打开原概览；紧凑栏维修入口已在“…”模态窗口内，测试改为实际点击该入口后展开。两脚本修后各一次通过：`nozeli-agent-control-ui-a7XLXW/report.json`（真实Pi/文件副作用、9个检查、7次回环请求、exit0）与`/tmp/nozeli-pi-maintenance-ui-gJOB3l/report.json`（真实Git锁、同Work维修及4个检查、exit0），未改产品行为、删除用例或使用真实模型账号。最终完整integration与精确提交CI及便携包验证结果以GitHub该版本发布记录为准，不预先宣称成功。
- 随后本机最终完整integration **1705/1705**、opt-in agent-control-live **13/13（5文件）**通过，失败／跳过／取消均0，原始TAP保留于`.test-output/ci/`。精确提交1f2918a的GitHub run41769773826，unit与clean-build/smoke成功，但integration作业25m19s后conclusion=cancelled，CI gate失败，未用本机通过覆盖它。仅把CI tests作业时限25→45分钟，保留156文件全集合、相同断言／concurrency=2及失败传播；不改产品保存或原生准入超时，等待新精确提交的完整门禁。

## 普通引用文件发送修复（2026-11-04，未安装／未发布）

- 用户引用HTML后点击“提交后台”，出现“仅支持显式发送涂鸦PNG”。以真实Electron文件列表选中约28KiB合成`binary-stars.html`，旧renderer复现相同错误，0 jobs／0模型请求，草稿及附件保留：`/home/bfly/.cache/nozeli-file-handoff-60odIx/report.json`与`surface.png`。
- 修复普通文本附件独立`fileAttachments`通道：renderer仅传登记身份；宿主复用ProjectAttachments验证项目／实例／摘要及冻结副本，按登记文件名验证UTF-8/NUL与声明二进制格式，最多20项、单项8MiB、总24MiB；涂鸦图片仍经原通道核验。通过原`context.materials`和版本对象进入native请求，不改写用户原文。Worker初始交接／补充输入以及前台交接按绑定来源job重建材料，已发文件保留在历史消息并可打开冻结只读副本。
- `npm run build:renderer`通过。实际Electron＋随包私有Pi＋localhost scripted Provider跑通：文件列表真实冻结HTML→修改磁盘源→点击提交后台→恰好1个主控intake→真实Worker写入隔离worktree并发布报告；HTTP请求核对主控和Worker均包含完整冻结HTML（不只是文件名／简述），不含突变后的正文。普通前台发送也通过，回执后清草稿／待发材料，已发HTML从历史只读打开正常，应用exit0。原件：`/home/bfly/.cache/nozeli-file-handoff-yIyRZA/report.json`、`surface.png`；已查看修前／修后截图。无真实模型账号／付费调用，不修改用户项目或安装版，不声明Windows/macOS通过。
- 定向回归分批结果：原5文件（context cutover／session index／drawing image／tag delivery／task flow）76/76通过；新增`file-attachments-host.test.mjs`6/6通过并登记到integration。初轮总82项中，唯一失败为测试把`sourceManifest`对象误断言成字符串，修为校验`digest`与`byteLength`后宿主6项通过；保留初轮失败，不冒充初轮全绿。宿主测试覆盖多文件冻结正文、send/task唯一准入、损坏／跨项目／伪造／二进制拒绝、涂鸦隔离和20项／24MiB边界。
- 真实原生选择入口脚本`desktop-material-native-pick-live.mjs --app-root ...`最终15项检查通过，2次明确发送→2个模型请求、3份选中冻结原文送达、后续普通发送只新增一份用户输入并保留原生历史、exit0：`/tmp/nozeli-material-native-pick-VBpEhk/report.json`。首轮X11启动因测试清除`XAUTHORITY`失败，已只保留显示服务器认证；第二轮把整份HTTP原生历史误当新附件重发，改核对最新用户entry不重复附件后通过，未修改产品历史保留。OS文件选择窗口由dialog fixture应答，只实测真实入口／IPC／宿主冻结，不声称OS窗口本体通过。
- 补跑旧`desktop-composer-materials.test.mjs`停在旧启动夹具等待`#configuration-setup[open]`超时，未到达发送断言，不计通过；本轮不迁移整份旧嵌入式工作面夹具。普通文件收发、失败保留由上面的宿主／Controller回归、原生选择脚本及实际HTML后台／前台运行验证覆盖。普通`node tools/check-repository.mjs --verify-hashes`0失败，六项既有分发审计仍pending；未提交／安装／发布。

## 已发送消息区分前台／后台（2026-11-04，未安装／未发布）

- 用户指出明确“提交后台”后，气泡仍只有“你”和“转为后台任务”，看不出实际归属。复用宿主已持久化`taskRequestId`／后台目标，在发送者旁展示“后台任务”；普通前台输入展示“前台对话”。已后台消息不再给“转为后台任务”，引用／复制保留；前台消息仍可明确转交，原气泡按真实绑定更新，不改原文。标识是提交归属，不表示已执行或完成；不引入发送协议、改调度或迁移历史正文。
- `boundedDTO`和renderer缓存裁剪保留`taskRequestId`，避免长消息／固定历史被误判前台。新增直接后台、前台转交后重开持久库、原前台消息不串归属、超长消息／pinned历史保留绑定回归；`node --test --test-concurrency=2 tests/session-index.test.mjs tests/session-store.test.mjs tests/session-execution-presentation.test.mjs` **44/44**通过；`npm run build:renderer`通过。
- 真实Electron＋native Pi＋回环Provider验收：点击直接后台立即出现后台标识、无重复转换入口，真实Worker在隔离worktree完成报告；普通前台保留前台标识及转换入口；实际点击转换后原消息ID／正文不变，后台工作排队时已经正确标识后台；刷新会话三种消息归属保持且0新jobs。实际489px暗色内容面各标识可读、无横向溢出，应用exit0。原件`/home/bfly/.cache/nozeli-input-route-gxzWHH/report.json`、`routes-dark-narrow.png`、`background-dark-narrow.png`，已看截图。初跑曾误等第二个Work立刻执行，实际第一个待审报告占用名额、第二个合法排队；仅纠正验收预期，未放宽产品名额或伪造执行状态。
- 限于Linux源码真实窗口、私有Pi和localhost scripted Provider；无个人数据／真实模型账号，不声明Windows/macOS通过。未提交、未安装、未重新发布。
- 更新已登记live套件中的`desktop-direct-background-live.mjs`，实际点击后台后检查气泡“后台任务”及无重复转换入口。完整脚本通过5项检查，覆盖失败草稿保留、重复点击唯一准入、真实Worker隔离发布，以及1440/980/590窗口、divider拖动、独立窗口往返保留输入／选区／同一DOM，exit0；原件`/tmp/nozeli-direct-background-gaShhb/report.json`。本轮未改执行调度或后台名额。

## 主控处理与 Worker 交接流程可见（2026-11-04，未安装／未发布）

- 用户指出对话只有Worker、没有主控处理过程。根因为`groupSession`直接过滤正常orchestrator记录；现在按已接受输入／当前页原生记录的精确intake job身份显示主控卡，保留原用户气泡及后台标识，默认不灌入无关backstage／maintenance。主控卡给出处理状态、真实操作详情及宿主路由回执；Worker显示在相应主控交接之后，包含迟到原生日志及原工作补充输入的父子排序。只在同页主控卡已表达同一回执时去重work-created／routing事实，不注入历史页未出现的当前作业。
- 交接只认`job.routing`，模型散文不算派工。主控成功、失败与Worker当前状态分开：已交接但尚无名额仍显示排队；Work缺失显示未知；澄清问题按已加载记录给出待补充／已处理／未加载，不假称用户已经回答。正文／工具原件通过既有折叠和分页读取；未生成思维过程、未改变调度、名额、原生历史或发送协议。提交回执同步指向对话中的处理／交接进展，不再只提示右侧；删除旧脚本对此文案逐字匹配的偶然断言，未删除唯一准入和真实派工检查。
- `npm run build:renderer`通过。`session-store`、`session-execution-presentation`、`session-index`三文件定向回归 **55/55**，失败／跳过／取消0；覆盖接收后无原生输出的主控卡、原输入保留、准确父子顺序、分页不回填、已确认交接、排队不冒充执行、失败与交接并存、缺失澄清状态不冒充已解决。
- 真实Electron＋私有Pi＋localhost Provider分阶段验收 **8项通过**：门控第一条模型回复前已显示主控处理中且无Worker；真实`nozeli_inspect_work`操作在派工前可展开；真实dispatch回执显示在实际Worker轮之前，Worker写隔离文件并发布HTML报告；第二Work排队而无伪造Worker执行轮；真实clarify回执及问题可见；注入Provider400后主控失败可见且无交接／新Work；刷新保留4个业务主控卡及事实、0新增jobs，489px暗色无横向溢出；通过真实退出确认取消合成测试工作后exit0。原件`/home/bfly/.cache/nozeli-orchestrator-flow-C6rVGy/report.json`及三张截图，已查看pending／inspect／交接截图。首轮已通过所有展示场景，但夹具未应答后台核对并漏处理退出确认，导致退出断言失败；只补回环Provider的真实blocked工具响应及正常退出选择后全程通过，未绕过产品退出保护。
- 已登记`desktop-direct-background-live.mjs`增加主控真实回执、工作名称与主控先于Worker的实际DOM顺序核验。最终 **6项检查通过**，保留原失败草稿／重复点击唯一准入／真实隔离发布／分屏及独立窗口往返的草稿、选区和DOM保护，exit0：`/tmp/nozeli-direct-background-lm5OaY/report.json`。
- Linux源码真实窗口／native Pi实测，不含真实模型推理能力或Windows/macOS签收；未提交、未安装、未重新发布。已有未发布的普通引用文件发送和前后台气泡标识修复均保留。

## 本地安装对话与主控流程修复（2026-11-04）

- 用户明确授权“安装”。以现有`package-candidate.mjs`冻结`conversation-flow-20261104-local-01`，不修改正在运行的旧目录；通过`install-local.mjs --existing-release`激活，current／previous实链分别核实为该包和`2026-11-04T00-46-19-337Z`，桌面／CLI入口同步。安装器按既有保留策略清理更早非活跃版本，保留原current可回退；用户配置和项目未被安装器覆盖。
- 安装前用该候选的真实`nozeli` ELF、捆绑私有Pi和Git、独立合成profile运行5项综合验收：约28KiB本地HTML引用冻结后改源，后台原消息带正确标识且主控在Worker之前可见；主控与Worker的实际HTTP请求包含完整原冻结HTML、不含后来修改；Worker在隔离worktree写文件并发布报告；普通前台发送、历史附件只读打开、刷新0重复jobs；暗色489px内容面不横向溢出，exit0。756个src/dist输入文件SHA-256均与最终源码／构建一致，原件`/home/bfly/.cache/nozeli-conversation-installed-kDkPv2/report.json`、`frozen-inputs.json`、`frozen-installed-flow.png`，已查看实际截图。回环scripted Provider，不冒充真实模型推理。
- 最初旧日常进程1263023仍在运行，未对其发消息、强退或取消任务；遗留DevTools端口19773已拒绝连接，未尝试绕过。激活后旧进程已不再运行；通过清除测试／调试profile覆盖的正常`~/.local/bin/nozeli`入口打开新版。主进程1794288真实exe指向新release，启动日志`NOZELI_DESKTOP_READY http://127.0.0.1:33087/ hidden=false debugPort=none`，服务`nozeli-conversation-installed-20261104`保留窗口供用户使用。此为正常日常profile启动，不是代操作业务项目的验收，未代发用户消息、接受／丢弃成果或取消用户任务。
- 本次仅本机Linux安装，未Git提交／推送／打tag／改GitHub附件；六项分发审计状态不因本地安装改变，Windows/macOS未验证。前面三节“未安装”均为安装授权前的历史证据。

## 协作栏全部 Agent 与彩色状态（2026-11-04，未安装）

- 用户要求去掉“…”、直接列出所有工作Agent，并修正空心状态圆与字母O混淆。源码去掉4项截断与手动Agent分页，沿原只读status接口自动读完同revision分页（重复cursor拒绝，失败保留前一完整快照）；保留每Worker稳定编号与模型入口。角色用“前台／主控／Wn”，彩色实心方块＋可见状态文字，执行绿、排队／等待黄、失败红、待命／休眠灰，过期虚线及“待核实”；暗色使用较亮语义色。列表自然换行而非隐藏，状态详情只承载原计时／修复功能，不启动Agent或改变输入目标。
- 生产组件真实Electron脚本`desktop-collaboration-status.test.mjs`通过7组检查：3页62个Agent全部直接出现、后页模型控件焦点保持、不同状态实际计算色互异及状态文字正确、模型保存时草稿保留、旧项目晚到回执隔离、320px全部按钮在宽度内自然换行、过期／读取错误保留可核查入口。原件`/tmp/nozeli-collaboration-ui-SrMQw3/report.json`、`all-agents-light.png`、`all-agents-dark-320.png`，已查看截图。此为真实组件＋合成gateway，不冒充62个真实Pi进程。
- 维修consumer脚本通过9项检查，390px无溢出，原精确绑定／次数／只读／未知／晚到项目回执保护保持：`/tmp/nozeli-repair-consumer-uvh4r2/report.json`。两个维修入口调用方同步改为明确“状态详情”，不保留旧ellipsis别名。renderer构建通过；不改当前安装或项目数据，不声明Windows/macOS验收。
- 真实源码Electron＋私有Pi＋回环Provider完整后台脚本通过6项检查，单次主控→Worker隔离发布、后台气泡／交接顺序、原草稿失败保留、宽窄窗口／divider拖动／独立窗口返回均保持，exit0：`/tmp/nozeli-direct-background-l8IrQN/report.json`。仅状态栏呈现和只读分页调整，未改变模型发送、任务生命周期或运行用户项目。

## 对话内工作收尾进度（2026-11-04，未安装）

- 用户指出Worker“已交付”和冻结文件后不再显示收尾。新增同工作／当前版本的“工作收尾”区，待审查与已接受／已丢弃分开，列出原决定入账、Worker退出确认、冻结报告归档、本地合入或候选丢弃、资源清理、最终归档；只有`status=ended`与`phase=complete`及原确切审核绑定验证通过才表达收尾完成。旧版／未知决定保持待核实，旧报告不附新版本收尾；当前页多个同版本回合只在最后一轮展示一次。尚未启动Worker的revision0丢弃可绑定当前页原intake展示，不注入未加载历史。
- Controller仅在既有收尾阶段持久化成功后发送原state事件，补足stopping／report／integrating／cleanup中间阶段的可见更新；未改变停止、归档、合入、名额、超时、维修或准入协议。受阻原因按需展开；对话不新增接受／丢弃／重试按钮，不代用户决策、不自动覆盖冲突。
- 构建通过；`node --test --test-concurrency=2 tests/session-store.test.mjs tests/session-execution-presentation.test.mjs tests/managed-review-lifecycle.test.mjs` **38/38**，零失败／跳过／取消。回归覆盖待审不自动结束、逐阶段事实、blocked不标complete、最终归档前不释放、discard不声称合入、binding失配、历史版本与分页隔离、同版多回合去重、revision0及持久阶段通知。
- 已登记真实Electron＋native Pi＋Git后台脚本增加实际discard IPC决定→同Work退出／归档／清理完成→对话收尾全确认→刷新保持0模型重放及草稿不丢，合成项目源目录不产生被丢弃文件。最终7项检查通过、exit0，账本`ended/complete`：`/tmp/nozeli-direct-background-FZVoqG/report.json`及`discard-closeout-conversation.png`。截图采用真实鼠标滚动确保收尾卡实际在内容视口，不将DOM存在冒充可见；已查看。
- 另以真实合成接受流程创建并发人工文件，实际accept记录决定后进入closing/blocked；对话正确显示“已接受 · 收尾受阻”，停止／报告完成，合入受阻，最终归档待处理；原人工字节保留，刷新状态与原jobs保持。只移除夹具自己创建的冲突后，使用原binding明确调用现有retry IPC，原候选合入一次、无Worker模型重放，真实账本ended/complete。初验原件`/tmp/nozeli-direct-background-3Sstzm/report.json`、`accepted-blocked-closeout.png`，受阻截图已查看；这不是用户业务成果接受或模型推理质量验收。
- Linux源码实际窗口，回环scripted Provider／隔离合成数据；未安装、未公开发布、未处理用户截图中的真实工作，Windows/macOS未验。上一轮全部Agent彩色状态条改动保持。
- 最终接受路径再以实际滚轮将完成卡滚入489px暗色视口，卡片六阶段均已确认且原Work账本`ended/complete`，exit0：`/tmp/nozeli-direct-background-6FFsIA/report.json`、`accepted-blocked-closeout.png`、`accepted-complete-closeout.png`，已查看最终完成截图；3次业务HTTP（主控1、Worker2）前后不增。初轮只凭`scrollIntoView`截到上方旧阅读位置，没有拿那张图冒充完成卡视觉证据；修正仅限验收滚动。临时接受驱动已清理，持久回归留在已登记后台脚本及上述Node测试。
- 用户进一步确认“收尾是orchestrator”。已将收尾从Worker卡内部移出，作为其交付之后独立的`data-role=orchestrator`记录，标题“主控 · 工作收尾”，绑定工作名称／当前版本；原阶段清单和受阻原因保留。注明“主控协调 · 程序执行并核验合入、归档与清理”，不伪造主控新模型回合。31/31分组／呈现回归、renderer构建通过；真实Electron/Pi/Git脚本明确核验收尾为timeline直接子article、不位于Worker内，真实丢弃结束／刷新／草稿保护与7项验收通过、exit0，模型请求仍主控1＋Worker2：`/tmp/nozeli-direct-background-I3HuYd/report.json`及`discard-closeout-conversation.png`。此次覆盖前述“挂在Worker下”的初始设计；未安装。

## 全部Agent与主控收尾安装测试（2026-11-04）

- 用户明确授权“安装测试”。构建后以既有package-candidate冻结`orchestrator-closeout-20261104-local-02`；756个src/dist文件SHA-256全部与最终源码／构建一致，保存`frozen-files.json`。所有包级流程启动该候选的真实ELF、包内host及私有Pi/Git，非源码Electron入口；只使用独立合成项目／profile和回环Provider，无真实账号调用。
- 真实包discard路径8项检查通过、exit0：接单前材料失败保留、恰好1个intake及1个Worker、实际3角色全部可见无ellipsis／角色名不混淆、真实隔离文件和报告、主控交接先于Worker、分屏／拖动／独立窗往返的输入和选区保持、独立`主控 · 工作收尾`卡不嵌在Worker内、真正discard后ended/complete及刷新0模型重放。原件`/tmp/nozeli-direct-background-S5kB9S/report.json`、`frozen-files.json`、`discard-closeout-conversation.png`。
- 同一实际包accept路径8项检查通过、exit0（与前条重复项不累计）：夹具创建并发人工文件，真实接受决定后closing/blocked，主控收尾卡保留原接受决定、显示受阻且人工字节不变；刷新jobs及blocked保持。仅移除夹具自己的冲突文件、明确调用原binding retry后，原候选合入一次，主控独立卡ended/complete、六阶段确认，Worker不重跑、业务HTTP仍主控1＋Worker2。暗色489px真实滚轮把完整主控卡置于内容视口；原件`/tmp/nozeli-direct-background-haTNV9/report.json`、`installed-accepted-blocked.png`、`installed-accepted-complete.png`。已查看实际包丢弃／接受完成截图。
- 包内renderer原组件用真实Electron和合成只读gateway补验62个Agent跨3页完整直接呈现、不同状态颜色与文字、320px换行、模型／草稿／后页焦点保持及过期／失败／旧项目回执隔离，7组检查通过：`/tmp/nozeli-collaboration-ui-VqpXKA/report.json`。这条是包内组件，不声称62个真实Pi进程或真实Provider推理。
- 日常旧主进程743984通过原生WM_DELETE_WINDOW正常退出，pidfd确认退出，未强杀或选择取消任务。install-local --existing-release按验证包切换current，previous保留`conversation-flow-20261104-local-01`，桌面／CLI入口同步。标准`~/.local/bin/nozeli`正常启动新进程1360530，实际exe为新release，日志`NOZELI_DESKTOP_READY http://127.0.0.1:37971/ hidden=false debugPort=none`，原生窗口存在；服务`nozeli-orchestrator-closeout-installed`持久保留供用户使用。
- 用户真实项目／成果未被接受、丢弃、重置或代发模型消息。Linux本地安装限定，未Git提交／推送／tag／改GitHub附件，Windows/macOS未验。前两节“未安装”仅描述授权安装前的阶段；临时安装驱动清理，证据保留。

## 额外 Worker 根因修复与统一任务 block（2026-11-04，未安装）

- 用户确认不是隐藏尾部卡片，而是修复“为何主控收尾后出现Worker”。实际Liuhuaiyu“混沌演示优化分析”Work `3466a5db-1adb-4645-b0ea-1038c7b0e66a`只有一个initial job／revision1／一次原生提交，已ended/complete。原安装版冷frame把未分类model_change、thinking_level_change、session_info投影成无job/revision的system/not-loaded，再按sessionId误建Worker卡；收尾又按真实Worker组起点672加0.125插入，错误排到元数据675–677前。修前只读实证`/home/bfly/.cache/nozeli-phantom-worker-investigation-kaiKCe/report.json`。
- 原生索引新增entryType/recordKind附加证据；新记录入账即分类，旧记录在既有有界hydrate／重放时补分类，不改原生对象字节、ID、顺序和版本。会话配置及正常原生system指令是metadata，不是执行；未知种类明确unclassified、可读／导出原件，不能凭target构造Worker；真实未绑定消息／系统错误继续可核查，真实已绑定消息不因revision缺失被删除。绑定用户echo在未水合时同样按身份抑制。无写接口的只读投影不发写请求；有写接口的分类持久化失败按原错误传播，不吞STORAGE_RESULT_UNKNOWN。
- groupSession保留低层行接口，groupSessionWorkflows用canonical intakeLineage及Work/sourceJob/sourceInputJobIds/显式boundWorkId组合外层任务block。主控安排→Worker真实多轮／补充主控→主控收尾共用稳定原intake身份；澄清／retry／pendingIntake派工前后不换DOM。普通前台气泡留在外面；不按工作名或相邻位置猜归属。closeout在同任务全部已绑定Worker与主控记录之后，旧报告／分页不附带新版本收尾；真实Worker输入留在原回合，原用户输入不复制。
- 最终83/83定向回归通过（session-index、session-store、session-execution-presentation、tag-input-presentation、managed-review-lifecycle），零失败／跳过／取消；另managed-projects宿主接线24/24通过，renderer构建通过。新增覆盖索引冷开／缓存清除、元数据原始分页读取／字节导出、旧分类补填及只读重放、真实错误可见／用户echo唯一、失败持久化不吞、同任务多轮／同名异任务／源链／历史隔离。
- 真实用户旧记录以readOnly SQLite adapter＋不可变日志复放，未initialize／mutate／启动owner或调用Provider：同一数据原安装代码出现1张假Worker，新代码0张，真实Worker仍1轮；同一block内顺序为orchestrator/worker/closeout，原job ID／completed／revision1／attempt1不变。原件`/home/bfly/.cache/nozeli-root-fix-replay-aPyfUa/report.json`。没有删除旧记录或重跑用户任务。
- 真实React/Electron生产组件消费合成多轮数据通过：同一block含主控→Worker1→补充主控→Worker2→主控收尾，派工前后原block节点保持，配置记录不生成第3Worker，独立前台问答不进block；390px明暗主题无横向溢出，原件`/tmp/nozeli-session-consumer-mGhhZM/unified-workflow-{light,dark}.png`与日志，完整截图已查看。这条是生产组件，不冒充合成两轮数据为真实模型执行。
- 已登记native后台脚本完成8项真实Pi／文件／Git验收：唯一intake/Worker、同block角色顺序、实际丢弃归档收尾、草稿及分屏／独立窗口保护；正常退出后重新启动整个Electron主进程，再开原项目，仍为同一任务block／一条真实Worker／收尾complete，job IDs不变，模型HTTP仍主控1＋Worker2，两个正常退出均exit0。原件`/tmp/nozeli-direct-background-PqP9Xs/report.json`、`cold-workflow-block.png`、`discard-closeout-conversation.png`，已查看。最初`B3De2q`脚本在收尾可见位置断言失败，保留失败：发现原生正常system指令也应归metadata，补语义分类同时保留显式system错误，再用真实滚轮解除旧阅读位置保护并居中验证，不放宽产品或伪造窗口可见性。
- Linux源码／回环Provider验收，不包含真实模型推理或Windows/macOS通过；未Git提交、未安装、未改公开附件，日常版本仍为`orchestrator-closeout-20261104-local-02`。临时只读复放驱动清理，原件保留。

## 主控到 Worker 的交接消息署名（2026-11-04，未安装）

- 用户指出Worker区域的“原始用户请求／主控任务说明”消息被显示为“你”。原因为渲染直接采用LLM协议speaker=user，没有区分宿主生成的Worker initial／supplement交接输入。新增纯呈现messageRole，只有source=host、jobId可核实、job.target与消息目标精确一致且job.type为initial／supplement时署名主控；原用户提交intake／前台输入、真实manual历史输入、缺失／错位／native来源不改写为主控。不修改持久speaker、原文或原生prompt，不改执行流程。
- 主控交接不再附“后台任务”人类提交徽标；引用携带orchestrator署名，compose引用预览、持久草稿恢复与显式文本材料标题均为“回复 主控”，而原用户输入仍显示“你”。未把所有Worker区域消息一律换角色，未按正文猜测来源。
- message presentation＋session store回归40/40通过，renderer构建通过。已登记真实Electron＋native Pi＋回环Provider脚本9项检查通过：实际主控派工生成的Worker输入显示主控，点击引用后预览／材料标题均为回复主控；原用户气泡仍为你、原文保持；原后台唯一准入、同任务block、实际丢弃收尾、完整主进程冷启动、job IDs／草稿／模型请求次数保护保持，两个正常退出均exit0。原件`/tmp/nozeli-direct-background-VBdV70/report.json`、`button-after.png`（已查看署名实际截图）。
- 只在合成项目操作引用与工作流程，未改用户业务数据或原生历史；Linux源码限定，不冒充真实模型推理或Windows/macOS验收。未安装、未提交、未重新发布。

## 审批接入原 Worker 对话（2026-11-05，源码未安装）

- 入口：待办→主工作区报告与版本，同时打开标签样式非模态审批对话；不开放普通主输入／Agent状态点击接Worker。
- 命令：`npm run build:renderer`、`node tests/desktop-review-discussion-live.mjs`。脚本已注册显式live集合；新增`managed-review-discussion.test.mjs`注册integration，`native-review-renderer.test.mjs`因打包真实CSS/Renderer到临时目录改归integration，不冒充纯unit。
- 最终真实运行：`/tmp/nozeli-approval-discussion-Pmf9ld/report.json`，7场景、9次回环脚本Provider调用，真实Electron／私有Pi owners／Git worktree，最终`ended`与`closure.complete`，原候选文件按确切接受结果合入，正常退出，Renderer错误0。场景覆盖原线程纯问答不重发布、运行中FIFO排队无原生重叠、实际write＋publish新报告、主工作区显式换版、草稿收起保留、取消／确认接受、不发送未提交草稿，以及654×1150／390×844／390×480实际窗口底部操作。
- 原生报告guest和DOM审批窗分别截图取证；DOM截图不包含原生child view不能据此声称报告空白。已实际查看`REVIEW_REPORT_V2.png`、`approval-updated.png`及短窗截图。
- 定向9文件首轮192/196暴露4处问题，已修：过时按发布清空草稿断言、同步throw断言使用方式、FIFO测试未推进真实状态、Renderer导入CSS须采用既有bundle测试惯例。修后相关3文件56/56；最终身份投影＋Renderer两文件31/31。重复覆盖不累计总数。
- 实际GUI进一步暴露并修复：原生回复只存在portableMessages而非state.messages；running临时stale误当历史禁止排队；显式最新导航在发送／保存屏障中丢失。讨论仅投影durable确认原生身份，拒绝按正文去重；丢回执保留原请求信封重试。
- 跨文档保存、IME组合、人工稿CAS、发送／接受竞态、未发布全树漂移、结束门和普通Worker聊天拒绝有回归覆盖。不把本地脚本Provider当成真实模型自主判断质量；Windows/macOS、用户profile／论文和物理多屏未验。无安装／提交／发布。

- 默认`npm test`完整通过：unit 673/673、integration 1734/1734（0失败／取消／跳过）；原件`.test-output/ci/unit.tap`与`integration.tap`。运行时注册表加载在`native-review-renderer`归类调整前，故该次日志仍将其计入unit；最终注册改归integration只调整边界，不改变default成员。构建与最终7场景Electron/Pi实测另列，不与定向重复用例合计。

## 阅读优先UX首批（2026-11-05，待使用者审查，未安装）

- 审查页：`/home/bfly/.local/state/nozeli-runtime-tests/ux-review-20261105-batch1/gallery.html`，原件与操作记录随页保存。源码规划及未完成清单见外部Plan的`topics/user-experience-optimization.md`§9。
- 优化前阅读／任务／实际外部冲突：`ux-before-AtjYfo`；优化后最终：`ux-after-e7QU3k`；真实Pi审批前后：`/tmp/nozeli-approval-discussion-VibPCP`、`/tmp/nozeli-approval-discussion-79sVFb`。全部合成材料；真实Pi使用本地脚本Provider，不追加既有真实模型六次输入授权。无安装、提交、发布。
- 实测草木深色表头1.088→7.854:1，浅色10.640:1；外部修改提示条深色7.854:1。1440×900／800×650、浅／深实际截图，磁盘改动与人工输入分别保持。中断／排队使用明确标注的持久快照，只证明保守状态呈现和精确占位导航，不是实际崩溃恢复实测。
- 实际审批前后均真实Pi原线程、串行补充、write/publish与确切接受后真实合入ended；后批新增单文件直接原生打开且返回无遗留modal的行为检查。完整hash退出主确认文案但仍留版本详情与API token；冲突/IME/CAS保护不变。
- `npm run build:renderer`通过；最终定向`managed-work-records`、`managed-work-directory`、`native-review-renderer`55/55。`npm run test:unit`660/660在最后slot-holder细修前，细修由最终定向覆盖。未重跑integration全集合，不借此前审批全套数量冒充本批全量。
- 早期合成overview漏传technicalOpen使实际页面无法打开，已恢复参数并补有界原生Renderer行为回归；错误文案钉死测试删除而非重新固定句子。两次截图驱动截止原件保留，不计成功。R01/R02、完整合入冲突解决、离线对话首用、短备注/PPT布局、岩蓝主题矩阵与真实模型内容质量仍待后批。


## M1/M2/M4/M5复审迭代及首批授权安装（2026-11-05）

- 用户直接“安装一下”已按原package-candidate→install-local --existing-release激活`approval-ux-batch1-20261105-local-01`，previous=`orchestrator-closeout-20261104-local-02`。756个冻结src/dist摘要及激活记录`~/.local/state/nozeli-runtime-tests/approval-ux-batch1-install-20261105/`；实际包ELF审批8场景通过`/tmp/nozeli-approval-discussion-LFjxmw`。未强退日常应用、未代发用户业务；后续第二轮源码没有再次安装。
- 真实中文／人工采用脚本：`node tests/desktop-review-human-adoption-live.mjs`，要求DISPLAY、X11/XWayland与ImageMagick import，只读取自有BaseWindow原生handle窗口像素（含HTML child views），不截根桌面／用户其他窗口，不改生产运行时。主进程Inspector仅测试观察窗口身份，不注入业务或假状态；确认用真实UI动作，人工输入经原生编辑器保存。
- 最终前：`/tmp/nozeli-ux-batch2-zh-fHE7u5`为确切已安装首批ELF，显式`NOZELI_REVIEW_VISUAL_ONLY=1`只取消确认、未声称人工采用成功。后：`/tmp/nozeli-ux-batch2-zh-JMIl3P`为源码全流程。前后各6次本地脚本Provider，不产生付费模型调用。后版真实人工候选Ctrl+S→项目文件仍不存在→返回／取消确认保留未发意见→明确采用→项目字节逐字等于人工稿、原材料不变、原Work／线程不变、无未发意见job、ended/complete、exit0；原生日志／截图／JSON保留。脚本不默认加入无X11的live集合。
- 同帧中文报告＋讨论截图800×650、1440×900，收起正文恢复、展开草稿保留；采用确认列实际路径、人工稿和不发给AI说明。M2默认任务／AI助手／任务安排，原始协议与发布ID留版本详情；M4前后目录与取消按钮在`ux-after-e7QU3k`→`ux-after-nYmZSq`，后者不改名额，快照仅显示资格。
- 构建通过；候选／Renderer／目录63/63；最终状态／Renderer58/58；unit661/661（重叠不累计）。未重跑integration全集合／其他live脚本，不用此轮替代全主题、Windows/macOS或真实模型理解验收。
- 统一复审页`~/.local/state/nozeli-runtime-tests/ux-review-20261105-batch2/gallery.html`与REVIEW.md。M3/R01/R02/同文件合入冲突实际恢复仍未完成，不增加无效继续按钮或自动重放。初次主进程截图观察器误用BrowserWindow导致零业务失败，随后改用实际BaseWindow；原生绘制帧未稳定的早期截图不作为最终视觉证据。

## 第二轮授权安装与本地提交（2026-11-05）

用户明确“安装和commit”。冻结包`approval-ux-batch2-20261105-local-01`的实际ELF经`NOZELI_TEST_BINARY=<release>/nozeli node tests/desktop-review-human-adoption-live.mjs`通过完整中文／人工采用链，6次本地回环响应，原Work／线程保持，采用文件逐字等于人工稿，未发送意见零job，真实ended/complete，exit0；原件`/tmp/nozeli-ux-batch2-zh-G7r6ZE/report.json`及9张实际X11窗口截图。随后`HOME=/home/bfly node tools/install-local.mjs --existing-release ...`激活，previous为首批`approval-ux-batch1-20261105-local-01`。原日常窗口不强退，配置／项目不由安装器覆盖。prepare元数据检查0技术失败，分发审计警告仍未签收，不据此发布。

本地commit按相关文件与hunk选择，保留文件附件、会话投影／角色气泡、Agent栏等其他在途修改；安装快照按已实测完整工作树冻结，因此不宣称安装物等于纯净单一commit。未push／release。此前“未安装”是当时状态，本节为新授权后的事实。

另从Git暂存索引独立导出完整源码树（不带未暂存的附件／会话／Agent栏改动），独立构建Renderer并跑真实中文人工采用旅程通过，原件`/tmp/nozeli-ux-batch2-zh-JEMdnA/report.json`，确认本次选择性提交不依赖那些在途改动。导出树只复用既有npm/vendor/Pi构建依赖，不替换被测源码；首次缺少私有Pi dist的环境前置失败保留为零业务调用，不算产品故障。独立源码构建与安装快照分别取证，不将其摘要混称一致。

## 第三轮 U2-01/U2-02/U2-03 与 M3（2026-11-05，源码候选未安装）

- 版本统一按同类发布账本的确切 objectId 推导序号，不把同修订的多次发布都写为 V1；当前／旧版（历史只读）／人工稿分别标识。Work revision、冻结正文及原审批屏障不改。当前入口和人工稿返回的实际窗口为 V2，工作修订仍为1；同修订旧发布与原生历史读取／禁止发送由行为回归覆盖。
- 默认并读不缩小报告字号：1440×900左右、800×650上下，报告独立滚动；显式“自由摆放”保留移动、收起展开和恢复并读。合成中文真实 Pi／Git／Electron 全程 `/tmp/nozeli-ux-batch2-zh-tAe563/report.json`：6次本地脚本响应，人工 Ctrl+S 后项目原件未改，返回／取消保留未发意见，明确采用后项目字节逐字等于人工稿，原 Work／线程、ended/complete 与 exit0 均成立。
- U2-03勘误：第二轮原 after/04与03、after/06-800与05分别相同，已撤回“展开／返回”标签，原PNG/JSON不改。第三轮截图同时核实 DOM、原生可见内容面与实际窗口几何，并以自有X11窗口的无损FFV1短记录提取原帧；不截根桌面、不拼接guest。后版800的03→04差136704像素、05→06差261329像素，实际查看了展开与人工稿返回画面。脚本保留像素差异门，拒绝同图冒充切换。
- 前版为确切已安装第二轮ELF的视觉取消确认运行 `/tmp/nozeli-ux-batch2-zh-lvnpTz`，不冒充人工采用通过。只将实测800×650／1440×900的01图用于前后比较；该次前版03／04／00虽文件名含800，采集JSON实为最大化1707×928，已在复审页明确排除其窄窗证明资格。
- M3：`node tests/desktop-retained-progress-live.mjs` 原件 `/tmp/nozeli-retained-progress-feAxYE/report.json`。真实 Pi `nozeli_history_read`失效readRef＋offset=0造成补充failed，原请求、冻结报告／候选、原线程保持。等待既有维护回合结算后，目录单击“保留进展”→复制原文→打开冻结报告／文件，没有新增Provider请求、job或重放，原项目仍无候选文件。只读入口没有无依据的继续／恢复／重试执行按钮，不声明READ_REF_EXPIRED根因或自动恢复已修复。
- 构建通过。定向六文件首次其余164项通过、进展测试因CSS直导入失败；改用既有bundle模式并修正漏失报告区声明／冻结引用后，`managed-work-progress.test.mjs`最终12/12；新增历史只读授权边界定向1/1（与前164重叠，不累加）。删去模板拷贝、mock转发与提交摘要长度的偶然断言。未重跑unit/integration全集合；真实UI烟测不是由这些测试数量替代。
- 失败尝试保留：HA8RRT为fixture HTML缺head，UFWcji为fixture漏必需offset导致原生工具校验循环，tQ3HIK为维护回合尚未稳定就统计模型次数；均不计通过。截图首轮420色度编码不支持奇数原生窗口高度，改为保留完整尺寸／像素的FFV1，不裁切／缩放以迎合编码器。
- 统一入口：`~/.local/state/nozeli-runtime-tests/ux-review-20261105-batch3/gallery.html`及`REVIEW.md`；13张展示图片在真实Chromium加载通过。仅Linux/X11、合成项目与本地脚本Provider；付费模型质量、Windows/macOS、R01/R02、未知效果恢复及同文件合入冲突解决未据此验收。本轮未安装／提交／推送／发布；current经readlink仍为`approval-ux-batch2-20261105-local-01`，此前本地commit为93265f6。

## U3-01／U3-02 小批收尾（2026-11-05，源码未安装）

- U3-01先用已有能力，不改布局／字号：`/tmp/nozeli-ux-batch2-zh-iDdfW2/report.json`，同份V1在800×650、zoom1默认上下并读中，将结论短段与完整助手解释同屏，真实输入意见、收起／展开。实际滚动2次、额外布局调整0次、再锚定0次；草稿保留，原文scrollY=140，对话scrollTop 308.67→316，完整解释仍可见。不将约7.33px偏移说成精确位置保持；另一次新版待审提醒条的更拥挤路径讨论框64.63px不足整气泡70.67px，失败原件fmEjYa保留，不外推该路径通过。旧第三轮01/02同图勘误已补，PNG／JSON不变。
- U3-02真实失败原件`/tmp/nozeli-retained-progress-oLXeOZ/report.json`：首屏说明补充未完成、报告文件保留、当前暂不能继续且不会自动恢复，并就近查看／复制／返回阅读；技术原文、传输与时间默认折叠，实际展开滚到完整诊断可见处。打开原报告显示当前暂停、发送／采用不可用，历史系统消息不改写。原维护回合稳定后的复制、查看、返回、冻结文件打开无新增请求／job／重放／项目写入。全场景5次本地响应，不冒称全程零模型。
- 两条命令：`node tests/desktop-review-human-adoption-live.mjs`、`node tests/desktop-retained-progress-live.mjs`。自有X11窗口无损FFV1帧取证；U3-01沙箱内JS帧回调的初次证据脚本失败改为等宿主帧，不放宽报告沙箱。构建及定向回归辅助通过，未重跑全集合。复制模板／摘要长度／mock转发及文案钉死断言删除，不为新措辞重新固定。
- 本批入口`~/.local/state/nozeli-runtime-tests/ux-review-20261105-batch4/gallery.html`与REVIEW.md，只展示两项前后画面及操作。历史完整导航、根因、自动恢复、R01/R02、未知效果恢复、跨平台及真实模型质量仍未验。全部隔离合成项目／本地脚本Provider，不追加付费模型。候选标识`0.1.0-alpha.5-source-ux-batch4`；本轮未安装／提交／推送／发布，HEAD实查93265f6，current第二轮、previous首批不变。

## 第四轮用户授权本机安装（2026-11-05）

本轮仅授权“安装一下我要测试”，未授权提交／推送／发布。经既有build-renderer、package-candidate冻结为`approval-ux-batch4-20261105-local-01`，405源码与354构建文件SHA-256一致，记录`~/.local/state/nozeli-runtime-tests/approval-ux-batch4-install-20261105/integrity.json`；这是完整开发工作树快照，非纯净提交发行物。实际冻结ELF、包内Pi/Git运行审批问答／排队／真实候选发布／明确采用至ended与退出通过（`/tmp/nozeli-approval-discussion-wbiUV8/report.json`），真实失效引用后的平实首屏／展开诊断／暂停报告／查看复制不新增执行亦通过（`/tmp/nozeli-retained-progress-XMnOmp/report.json`）；分别9、5次本地脚本响应，零付费模型。

固定800人工采用脚本两次取证AjKFkY、DUEEE7均因窗口过程中变为最大化而失败，不计通过，不将气泡外框／尺寸断言直接等同于读者看不到正文，也没有为此改产品布局；此安装不新增完整窄窗、历史或恢复签收。随后既有install-local --existing-release成功激活current第四轮、previous第二轮，原首批由既有受管保留策略清理；不强退运行窗口、不操作用户业务。安装原件为同目录installed.json，用户正常退出旧窗口后重开桌面入口测试。

## 报告审核工作面重做（2026-11-05）

用户实际安装反馈推翻当前浮窗呈现，Reviewer先设计复核再看实际窗口；以26b39d6加聊天前的报告展示职责为基线恢复，不整体回滚业务链。新默认无讨论，底部唯一“审核讨论”显式开可直接移动的标签窗；文件/独立交付物Diff/采用在报告底部。真实Work/job/request/原修订分组，原请求与主控原文/过程折叠，发布是事件；旧历史及消息ID不改，发送和采用仍走原屏障。

- `desktop-review-human-adoption-live.mjs`最终36EMxf（`/tmp/nozeli-ux-batch2-zh-36EMxf/report.json`）：实际主对话同Work两条native ID/正文逐条相等且同一AI组，完整当前解释三行在真实讨论视口内；一轮真实滚动建立原文120、标题直接移动(-100,-70)，讨论236.67、草稿及选区收展保持。人工编辑保存前原项目无候选，返回报告/取消确认保留意见，最终明确采用后项目字节等于人工稿，原线程、ended/complete、exit0；6次本地脚本Provider。原生确认画面相对返回报告差1369120像素，拒绝同图冒充。
- 原生报告：旧Vk3Roh 02/03虽然DOM reportBox不变，实际HTML viewport被最大无挡矩形缩窄而重排成竖列，原件不计通过。现为原生View父容器裁切/子WebContentsView保持完整viewport，截图捕获递归并裁切可见区域，迁移/回滚/隐藏/关闭一并迁移资源所有权。最终原生打开前后667×413，问答结束后拖动前/后/关闭667×453；原文scrollY120与标题/正文行Rect逐项保持，不能概括为全程高度不变。3CPcPc为Reviewer独立复核原件，认为限定场景不再有竖列重排阻断。
- `desktop-review-html-preview-live.mjs`最终c3kf7o：从待办/底部清单实际打开冻结HTML/JS并点击计算，源码＋效果读取人工作业缓冲；删除文本可看输入基线，HTML/删除文本/二进制逐文件进入冻结Diff。原项目四份文件字节/PNG摘要、jobs与Work状态不改，0模型。该删除PNG保持冻结基线绑定并明确提示非可编辑文本，二进制Diff只提供版本/不支持文本说明，未宣称图像预览或所有格式可浏览；返回报告走实际“已打开”控制，等待真实native surface可见，而非对后台DOM操作后宣称画面通过。
- `desktop-review-discussion-live.mjs`最终fnjcN2：原线程问答/持久FIFO/无重叠/在途阻止采用、真实新报告与候选、原生文件返回、未发稿保留、取消后明确采用至ended/complete；9次本地响应。窄/短内容面实际几何单列，requested654×1150受工作区限制，真实内容面553×843；390×480对应内容面289×395，不能以requested冒充实际尺寸。
- `desktop-retained-progress-live.mjs`最终y7ZEdE：真实READ_REF_EXPIRED事实在并行开发的读取纠正包装后以durable fault.code确认（4次拒绝，最终failed），不钉最终错误句子/不声称本批修复根因。当前暂停首屏、就近复制/打开原报告和文件、诊断折叠、聊天关闭后报告当前暂停且发送/采用不可用、原历史身份/正文/说话人/发布绑定不变；已有维护回合稳定后无新增请求/job/重放/项目写入。8次本地响应包含原任务及读纠正，不称全场景零模型。
- 构建通过；共享标签/回合定向46项、native裁切/捕获/迁移定向131项通过（含可见切片捕获与冻结provenance、原生迁移失败逐项恢复与父窗保护）。另有旧业务讨论/导出定向检查通过，未重跑全量CI，不用数量代替使用者签收。旧模式/自动show调用及假文案/模板断言清理；真实UI输入与嵌套native绘制就绪/焦点、原生完整窗口差异门分别验证，不注入业务状态或放宽静态报告沙箱。

统一图集：`~/.local/state/nozeli-runtime-tests/report-review-restoration-20261105-flj7xh/gallery.html`，包括用户原图、最终After、自有窗口无损记录和原JSON。所有失败尝试保留不计通过，旧重复确认帧/旧竖列图不进入After；不以几何框失败直接推断文字不可读。**剩余限制：浮窗仍会遮挡/裁切原生报告且范围可能大于窗体；不宣称打开后同时完整无遮挡阅读，关闭恢复。** 复杂历史导航、恢复/冲突、模型内容可靠性、真实多屏及跨平台仍未验。

本轮仅源码/隔离合成材料/真实Electron、私有Pi、Git与文件、本地脚本Provider；零付费模型，不操作用户项目。未执行本轮安装/提交/推送。末次观察current已另行切为`2026-11-05T10-28-25-750Z`、previous第四轮；407源码和354构建静态匹配，原件`installation-observed.json`在同图集目录。这不等于本轮运行过已安装ELF，也不沿用旧安装授权。

## 2026-11-05 对话收起、窄窗正文与按需操作（源码，未安装）

- `node tests/desktop-conversation-collapse-live.mjs`（已登记 live）：真实 Electron／私有 Pi／本地脚本 Provider，在隔离合成项目由真实发送按钮提交两轮中文输入；深浅主题与三档原生窗口宽度检查正文边界，再实际点击收起／底部入口恢复三次，验证历史原文、未发草稿和滚动位置保留，打开“更多 → 会话管理”可达，期间没有新增请求、job 或原文文件写入。清理诊断探针后的通过原件：`/tmp/nozeli-conversation-collapse-1Z6ijN/report.json`，截图同目录。脚本 Provider 不代表商业模型可靠性验收。
- 修前真实复现：草稿 action 缺少专用分支，发送前落入终端处理并报 `TERMINAL_STALE`；恢复本地草稿分支后，两轮原生输入均完成。随后复现滚动返回错误：收起前实际 `scrollTop=0`，重建 guest 却恢复旧值约390.67；仅保存 recovery 不会进入该次布局事务的 `pendingViewState`。保留阶段捕获当前阅读／材料状态，并沿既有 `writeView` 提交转移屏障后，原生重建恢复0；失败原件 `/tmp/nozeli-conversation-collapse-jyK8B5`、`TWMXhG` 与通过原件 `/tmp/nozeli-conversation-collapse-KWUmt2` 保留用于定位，不放宽保存失败准入。
- 消息菜单与投影回归：`node --test tests/desktop-session-timeline.test.mjs tests/renderer-projection-coalescing.test.mjs`。消费测试设置明确 viewport；有 DISPLAY 时默认 X11，使用可绘制窗口检查真实键盘／指针操作、Escape、复制状态及引用。纯 Ozone headless 未验收，不把隐藏窗口截图超时当成产品通过。
- 删除未登记、无文档入口的 `desktop-empty-workspace.test.mjs` 旧 Demo 脚本：它依赖已废弃的内嵌 launcher、compact-composer、四方向停靠及 OMP/Claude 模拟报告，不能验证现行原生工作面。空工作台／真实文件／冷启动由已登记 `desktop-ci-smoke.mjs` 覆盖，布局／保存失败／窗口归属由现有 workspace-layout/native 回归覆盖，真实对话收起由新增 live 脚本覆盖；不为旧脚本恢复兼容 DOM 或模拟 Agent。
- 最终支持路径回归：`node --no-warnings --test tests/desktop-session-timeline.test.mjs tests/renderer-projection-coalescing.test.mjs tests/workspace-layout.test.mjs tests/workspace-native.test.mjs`，110/110通过。`NOZELI_OZONE=x11 node tests/desktop-ci-smoke.mjs` 的五项真实启动／文件／项目切换／退出／冷恢复检查通过、两次正常退出code0、无pageerror；原件 `apps/desktop/.test-output/ci/smoke-j7w9zF/report.json`。`node tools/test-suites.mjs live --list` 确认新增对话回归已登记。
- 本轮只在 Linux X11／XWayland 验证；Windows/macOS、纯原生 Wayland、物理多屏和实际商业模型未验。未安装、提交、推送或发布，未操作用户论文或日常 profile。

## 2026-11-06 成果页重做候选与未通过的像素门

未激活日常安装的真实ELF：`/tmp/nozeli-review-redesign-ARiK9h/candidate-home/.local/opt/nozeli/releases/review-page-redesign-r4-20261106/nozeli`。原生讨论不再靠裁掉报告避让；标签local-window继续独占CSS几何，原生仅一次单位转换。独立reviewer已按源码及原件逐项复核，不冒称reviewer亲自执行GUI。

- `NOZELI_TEST_BINARY=<r4>/nozeli NOZELI_QA_LIFECYCLE_ONLY=1 node tests/desktop-review-page-acceptance-live.mjs`：采纳原件 `/tmp/nozeli-independent-review-pFV7Bs/report.json`；加`NOZELI_QA_DECISION=discard`的放弃原件 `/tmp/nozeli-independent-review-mgT5dM/report.json`。两者ok:true、自然exit0；保存拒绝零决定、显式业务retry同revision、同DOM草稿、detach/dock、确认取消与实际bytes、原Work完整结束及意见只读保持均核对。应用CompositionEvent只测应用屏障，不代表真实OS IME。
- r3尺寸及普通文件标签同操作、zoom原件 `/tmp/nozeli-independent-review-gYlXgI/report.json` 的五条observations通过；整体该报告因后续定位fixture失败仍ok:false，不改写历史。数据支持420×460→470×500→400×450、36CSS收展及偏好恢复，非多屏／多DPI／OS硬件／像素完全一致签收。
- r4性能原件 `/tmp/nozeli-independent-review-mgT5dM/performance-report.json`：opened及拖后各60个样本均child可见／应用持焦，79次trusted-CDP拖动30.284s；静置讨论bounds／displayView.write增量0，CPU中位增量0。workspace.bounds打开段11次；未实测input→pixel p95、逐帧pending与所有硬件组合。旧mixed-hidden性能原件保留，不能混用。
- HTML成果／删除基线／真实HTMLJS与Diff旅程原件 `/tmp/nozeli-review-html-ibD2ow/report.json` 通过9项；当时fixture未给当前报告归档changeSet，附录保守标未核实正确，后续fixture已改真实retainCandidate归档、具体类型完整GUI复测仍需覆盖。
- 最终r4包重跑 `desktop-review-html-preview-live.mjs`：`/tmp/nozeli-review-html-ku6RXc/report.json` 已验证当前精确归档的added/modified/removed类型、HTMLJS和未保存预览，随后旧“删除图片不可编辑文本”文案断言过时超时（实际已进入冻结图片reader）。删除该措辞断言、改测真实图片与基线摘要后，`/tmp/nozeli-review-html-lbxQsN/report.json` 又在整窗像素变化门失败；已读取的删除文本及source身份正确，但不能据此宣布完整GUI通过。未降低像素门或把无变化截图改记成功。
- **未通过：真实父子同帧像素。** Spectacle activewindow捕不到child；正常区域UI的确切PID验证／选区自动化未产图，最后probe原件`/tmp/nozeli-review-redesign-ARiK9h/composite-owned-final.capture-failure.json`。没有绕过截图权限或拼接父子图。现有DOM／native bounds／child单窗截图不等于窗外正文无黑块；整页不能宣称reviewer验收通过。

## 2026-11-06 用户授权合并安装验证

代码提交 `a772582` 的父提交为 `e4dd289`，无需重复 cherry-pick；实际本机安装 current=`2026-11-06T06-50-32-215Z`，previous=`2026-11-06T03-38-28-248Z`。415个src、354个dist文件与冻结工作树逐字节一致；安装包括保留的其他既有后端工作树修改，不声称安装包只来自干净commit。记录 `/tmp/nozeli-unified-install-88KARQ/installed.json`。

- 从已验证的标签／涂鸦live脚本创建临时驱动，明确改用 `/home/bfly/.local/opt/nozeli/current/nozeli` ELF 和安装目录 `DesktopHost`；隔离合成PPT/profile，不运行源码main。实际拖动／键盘、touch cancel、800px夹取恢复、关闭重开、返回笔迹、本地保存恢复13项通过，exit0、原PPT与笔迹保持、无新增job；原件 `/tmp/nozeli-label-windows-cUP4Yb/report.json`。首轮仅驱动puppeteer导入路径错误，修正后再验，不算产品失败或通过。临时驱动已删除。
- `HOME=/home/bfly node tests/installed-recorded-bug-fixed-live.mjs`：`/tmp/nozeli-installed-recorded-bug-fixed-HgjW12/report.json`，真实安装ELF／捆绑Pi和Node、受控本地Provider、同中文输入及空cursor×3、空brief正常派工，唯一原请求／Work／Worker，HTML实际生成并发布待审，零维护job和持久新Bug；真实工件模拟／暂停／调参通过，正常exit0，安装字节未变，不自动采用／合入。
- 安装器首次受开发工具隔离HOME影响只更新了工具自身沙盒安装；已显式 `HOME=/home/bfly` 在真实用户目录重新打包／激活，以上两项均验证真实用户current，不能拿沙盒激活冒充用户安装成功。不强退用户旧窗口、不读取日常项目／凭据、不推送／发布；Linux限定。

## 2026-11-06 共用局部窗口与简洁管理页（源码，未安装）

- **回归**：`npm run build:renderer` 通过；集中 `node --no-warnings --test --test-concurrency=2 --test-reporter=spec` 运行 `local-window`、`management-presentation`、`managed-progress`、`session-controls`、`web-discussion-panel`、`settings-agents-ui`、`provider-settings`、`managed-work-progress`、`native-review-renderer`、`snapshot-card-view`、`web-window-clip`、`online-browser`、`online-browser-clip`、`workspace-native` 对应的 `.test.mjs`：188/188，零失败／跳过。覆盖展示 CAS／实例及 surface 归属、迁移、队列／审核保护、输入保留与原生裁剪；测试清单已登记。
- **标签与冻结涂鸦**：`node tests/desktop-label-windows-live.mjs` 在真实 PPT 上检查直接标题拖动、键盘、touch cancel、800px 临时夹取及恢复、原生关闭重开、返回笔迹、本地保存后 fork 恢复；不改原 PPT／笔迹／锚点、不新增 job。收紧同角色不同原生窗口的展示身份后，最终浅色 `/tmp/nozeli-label-windows-HFItSs/report.json` 通过；`NOZELI_LABEL_THEME=dark` 深色 `/tmp/nozeli-label-windows-bi1FYe/report.json` 通过，各13项、正常退出。跨 fork 的窗口身份由记录内 `card.windowOwnerId` 传递，独立涂鸦不按相同背景图片合并。
- **审核讨论与真实采用**：`node tests/desktop-review-human-adoption-live.mjs` 通过，原件 `/tmp/nozeli-ux-batch2-zh-0PI0O7/report.json`。真实私有 Pi／本地确定性 Provider、原生 HTML／文件、6次本地模型请求，核对同 Work 原文、真实讨论回复、标题拖动、不重排正文／不抢原阅读位置、未发送意见／选区保留、人工编辑保存及确切版本采用到项目，正常退出。不是远端模型理解能力签收。
- **管理界面**：真实双角色 Agent 对话窗、展开详情后刷新仍复用节点、两额度及保存回执、三角色模型及空目录、会话上下文／技术诊断初始折叠、空故障无空选择器及 Escape 返回原连接页并恢复焦点，见 `/tmp/nozeli-unified-ui-live-2wQRxL/report.json` 与同目录 `agent-status.webp`、`resource-settings.webp`。`NOZELI_OZONE=x11 NOZELI_TEST_VISIBLE=1 node tests/desktop-settings.test.mjs` 30项通过，原件目录 `/tmp/nozeli-settings-ui-de9J0W`。脚本默认隐藏 headless 的首次尝试在 ready 等待超时，未算通过；本轮签收是可见 X11。
- **真实原生网页**：修前已直接测到浮窗使 guest `innerWidth` 871→519、段落宽840→488并重排，拖动出现意外 lostpointercapture。修后父 View 裁剪，guest 实际保持871×725，段落840×653.33、滚动与表单值不变；真实标题位移−240/+70，继续移动−170使裁剪区域换边，OS窗口仍在原位，关闭／恢复同输入和选区。导航到新 URL 不继承旧草稿，返回确切原 URL 恢复旧草稿及位置。实际 native tree 为裁剪容器422×725、guest负偏移且仍871×725，原件及原生合成图 `final-native-web.png` 均在上述 unified-ui 目录。网页仍无 `window.nozeli/require/process`。右键确实触发 native menu，但菜单选择用原菜单回调 fixture；不声称物理菜单点击通过。
- **生命周期及限制**：隔离 Markdown 文件摘要未变，无意外 job，三个自有运行阶段均正常 exit0，临时观察器与取证脚本已清理。只签 Linux X11／XWayland、上述格式和场景；不等于当前安装版、所有 Word／PDF／表格锚点、所有异常模型状态、IME／输入硬件／DPI／物理多屏矩阵或 Windows/macOS 全通过。深浅主题仅上述标签／涂鸦专项，不泛化全应用矩阵；最大无挡矩形仍可能裁掉窗体外页面。没有安装、提交、推送或发布，不操作用户论文／日常 profile。

## 2026-11-06 全部局部讨论拖动：设计复核，未实施／未运行验收

用户当前报告标签讨论都无法拖动，并明确包括审查／审核讨论。下方 2026-11-05 标签／涂鸦专项、审核 `36EMxf` 等均仅保留其原构建与场景边界，不能否定反馈，也不证明所有调用方、实际安装程序及输入硬件通过。本轮只核对源码和调整权威设计，没有复验旧 smoke、启动日常 profile 或安装程序。

已记录[共用窗口契约及验收矩阵](worker-review-chat-demo.md#统一局部窗口契约2026-11-06设计未实施)：覆盖本地备注、文件、选区／位置、真正未定位、冻结位置、审核及网页局部讨论；分别取实际标题 hit target、可信 pointer／capture、真实局部位移、原生 WCV bounds／clip、OS 窗口不动及业务身份／输入保持的证据。dispatchEvent、直接改 style／调用移动函数、body 非空或单独几何断言均不能签收拖动。当前根因未证实，平台／触控／DPI／多屏矩阵尚未执行；此处不增加任何通过声明。

## 2026-11-05 标签系统收拢：文件讨论漂移与涂鸦小窗无法移动（源码，未安装）

设计约束收拢于[标签与局部讨论](principles.md#标签与局部讨论)：共用可拖标题、键盘移动及保留输入规则，区分来源锚点与窗口展示位置。文件讨论不冒充未定位标签；冻结画面的视口来源不冒充精确文件选区。

- **修前复现**：`/tmp/nozeli-label-windows-3cWUgg/report.json`。真实合成 PPT 上文件卡宽1082／内容视口1139，拖动坐标完全不变；冻结涂鸦卡同样无法拖动。文件卡被 `renderUnlocatedTags` 强制 inline/no-op move；snapshot 卡则只有自然定位、没有拖动手势。
- **文件标签**：`app.mjs` 的独立非布局层复用 `note-tag.mjs` 的移动、尺寸、折叠和草稿回调，以annotation ID保留输入节点；不挤压 PPT iframe。真正未定位的目录保留原引用、共享菜单删除与显式重定位。新增视口层标记使无有效源标记的小窗不再随目录滚出视口而隐藏；普通带锚点的标签仍沿原源标记可见性规则。Word重定位后的实测曾抓到隐藏窗口的点击落在目录上，修复后共享菜单及删除通过；临时命中探针已清理。
- **涂鸦标签**：`workspace-snapshot.mjs` 沿现有 `target.card.offset` 保存显示偏移；`rect`仍仅表示笔迹区域。3px阈值、pointer capture、取消恢复、标题方向键10px／Home回到笔迹旁；窗口变化只重新夹取显示范围，旧记录无offset时沿原自动定位。来源、笔迹、图片和发送身份不随移动改变，不增加模式或模型调用。
- **真实端到端**：`node tests/desktop-label-windows-live.mjs`（已登记live），13项通过。浅色原件 `/tmp/nozeli-label-windows-18nCiW/`；深色命令 `NOZELI_LABEL_THEME=dark node tests/desktop-label-windows-live.mjs`，原件 `/tmp/nozeli-label-windows-3zU9OM/`。覆盖实际标题拖动／方向键、原生PPT guest关闭重建、未发草稿及历史问题、取消触控拖动、窄窗标题可达、恢复窗口大小、返回笔迹再完成、仅保存本地再恢复；逐项核对原PPT SHA、笔迹向量、笔迹区域和job列表不变，正常退出code0，无pageerror。触控由CDP受信输入验证，不代表触控硬件或其他平台实测。
- **失效锚点回归**：清理探针后的 `NOZELI_OZONE=x11 node tests/desktop-unlocated-tags-live.mjs` 通过；覆盖 Word/text/PDF/image/PPT 真实窗口、共享菜单删除持久化，以及Word/text明确重定位后原引用／备注／历史不被改写。原件 `unlocated-tags-live-q0qhvv` 在隔离测试缓存目录，先前通过原件 `unlocated-tags-live-lPdDrD` 保留定位过程。
- **最终确定性回归**：`node --no-warnings --test tests/workspace-capture-store.test.mjs tests/desktop-workspace-capture-session.test.mjs tests/region-drawing.test.mjs tests/tag-stability.test.mjs tests/tag-session-identity.test.mjs tests/renderer-tag-draft.test.mjs tests/discussion-thread-transcript.test.mjs`，90/90通过。
- 边界：仅Linux X11／XWayland及合成材料；未操作用户论文／日常profile，无Provider配置或模型调用。Windows/macOS、纯原生Wayland、物理多屏和触控硬件未验；未安装、提交、推送或发布。

## 2026-11-05 退出卡住与原生强制退出（源码修复与本机安装验收）

设计约束见[退出与工作区恢复](principles.md#退出与工作区恢复)。原次用户退出没有留下具体保存错误日志，不能从泛化截图唯一认定是哪份材料／输入失败；以下区分源码因果、实际运行与测试夹具。

### 已修复的确定链路

- 旧 `WindowRecovery` 超时先清空 `pending`，使“继续等待”之后原保存回执也无法继续关闭。现保留请求ID／页面代次，原生选择未决时暂存晚到结果；继续等待后仍执行真正的Host结算，不把晚到页面确认直接当作全部保存完成。旧确认不能关闭新页面。
- 准备涂鸦关闭、`app.before-quit` 的独立前置flush，以及stop／重载结算曾可能在恢复监督之外等待。应用退出现在统一进入受监督准备→flush→结算→清理；重载结算也受监督。真实失败显示原error.message，不再丢成“工作区未确认保存”。单独关闭非最后窗口仍沿既有多窗口保留流程，不将其普通收窗改成全应用退出。
- 页面先排干已启动的自动保存，再捕获保留快照，避免摘要／dirty状态在保留过程中被另一保存翻转。未自动保存的项目文本同时经既有 `file.retain` 保存到正常重开读取的草稿权威，不改磁盘源、不绕过读取基线验证；此前0ms退出虽已有恢复记录，正常重开编辑器却未恢复该缓冲。IME仍真实拒收，不吞掉失败。
- preload必须保持自包含：Electron生产窗口是sandbox:true，不能require新增本地CommonJS文件。flush聚合保留在原preload内部，VM测试执行真实preload并只允许electron require；缺少返回值具名为NO_FLUSH_RESULT，回执失败最多补报一次，避免拒收细节消失或无限回执。
- 恢复框有宿主原生“强制退出…”及默认取消的二次确认；确认后复用原 `createForceQuit`，不等保存／正常stop。Linux只按已捕获的进程出生身份／uid清理当前实例后代，不按进程名或进程组扫杀。

### 实际运行证据

- `node tests/desktop-close-retention-live.mjs`／`npm run test:close-retention`：真实native文本编辑器物理键盘输入，0/600/705/715/730/750/770/1200ms八个时点正常退出，逐轮冷重开核对上轮新增文字，最后再冷重开一次。9次exit均code0；原件 `/tmp/nozeli-close-retention-Lr0eRI/report.json`。无模型、无用户文件。
- `node tests/desktop-close-recovery-live.mjs`／`npm run test:close-recovery-native`：Linux KDE KWin＋X11/XWayland＋Python dbus/gi及ImageMagick的显式专用smoke，不混入普通live套件。真实renderer阻塞12s后，原生取消/继续等待能自然退出；永久阻塞renderer、注入保存错误、stop挂起、prepare挂起、重载结算挂起共6场景均退出code0，确认取消保持实例存活，源文件和已确认草稿保持。最终原件 `/tmp/nozeli-close-recovery-iatLpc/report.json`，原生恢复/确认截图按场景分目录；强退分支观察约396–459ms完成（包括驱动开销），独立进程测试另验2500ms清理deadline。
- **原生UI边界**：对话框确由Electron真实显示，截图只捕获匹配自有PID＋出生时间＋XID的窗口，取消由窗口管理器真实执行。当前桌面的键盘／AT-SPI自动驱动未可靠命中按钮，失败尝试不记作通过。非取消选择通过隔离Inspector夹具控制原生返回值后继续真实控制器与app.exit，report中逐项标注 `explicit-fixture-return-after-native-dismissal`；不能据此声称已自动完成强退按钮的物理点击。没有替换业务保存、进程清理或任务结果。
- 正常PPT＋工作面涂鸦收尾复验：`node tests/desktop-label-windows-live.mjs`，13项通过且正常退出；原件 `/tmp/nozeli-label-windows-fO1uHk/report.json`。
- 最终聚焦回归：`node --test tests/main-startup-recovery.test.mjs tests/close-flush-retention.test.mjs tests/force-quit.test.mjs tests/force-quit-process.test.mjs`，60/60通过，含迟到回执、导航／销毁、原生确认取消／幂等、reload挂起、真实自有后代与无关sentinel隔离。删除只固定按钮文案的断言，保留行为和默认取消保护。

上轮源码验证时未执行安装、提交、推送或发布；下节记录本次明确授权后的安装验收。先前current指针由其他操作更新，不作为冻结候选验收。Windows/macOS、纯原生Wayland、系统级主进程冻结与全部历史退出故障未验，不宣称所有I/O失败都可无损退出。

### 本轮明确授权后的安装验收与提交范围

- 用户授权顺序为“修正后安装测试，通过再commit”；未授权推送或发布。以此前current `2026-11-05T14-41-14-131Z` 为安装基线，核对408个运行源码、354个构建文件：安装基线与工作树的运行源码差异仅 `main/window-recovery.cjs`，构建文件无差异，package差异仅本轮新增测试脚本。由既有package-candidate/install-local冻结并激活 `exit-recovery-20261105-verified-01`，previous保留原current，不热替换／强杀旧实例。
- 冻结候选的408源码＋354构建与交付输入逐字节摘要一致，零差异；清单 `/home/bfly/.cache/nozeli-smokes/exit-delivery-krYqzo/candidate-inputs.json`。安装继承原基线已有功能，不将其他未提交工作夹带入本轮commit，也不把该局部commit宣称为整棵安装快照的全部来源。
- 实际程序：`/home/bfly/.local/opt/nozeli/releases/exit-recovery-20261105-verified-01/nozeli`，实际app root为同目录 `resources/app`；通过 `NOZELI_TEST_BINARY` 与 `NOZELI_TEST_APP_ROOT` 交给真实测试，非源码Electron替代。
- 安装版恢复测试：`desktop-close-recovery-live.mjs` 六场景全部exit0，原件 `/tmp/nozeli-close-recovery-v3AWQr/report.json`；强退响应分支约404–433ms结束。保留本节前述原生UI边界：非取消返回由夹具明确控制，不声称物理点击通过。
- 安装版正常退出：`desktop-close-retention-live.mjs` 八个自动保存时点、冷重开验证、PPT涂鸦讨论打开时退出，共10次exit0。原件 `/tmp/nozeli-close-retention-CTWCnz/report.json`（含实际binary/appRoot）与同目录 `ppt-drawing-before-exit.png`；保存问题/笔迹完整且原PPT字节不变。只使用隔离合成资料，无模型请求，不打开用户论文或日常profile。
- 交付元数据prepare检查为0技术失败；六项公共再分发审计仍pending，本机安装/本地commit不构成公开发布许可或审计签收。

## 项目右键重置为新项目（2026-11-06，源码已验，未安装）

- 定向命令：`HOME=/home/bfly TMPDIR=/var/tmp NODE_NO_WARNINGS=1 node --test tests/project-lifecycle-reset.test.mjs tests/project-lifecycle.test.mjs tests/project-lifecycle-admission.test.mjs tests/project-lifecycle-stale-remove-hold.test.mjs tests/project-storage-initialization.test.mjs tests/lifecycle-flush-capability.test.mjs`，63/63 通过、0 failed/skipped/cancelled。新增 reset 用例已注册 integration；本轮未重跑全仓默认套件。
- 真实文件／SQLite／Git 验证新 projectId 与 instanceId、旧元数据备份与原位实例／worktree、其他项目隔离、符号链接／身份变更／未知停止拒绝、同操作残留不覆盖、失败阶段事实不回写、catalog 提交前后中断与跨冷启动根目录围栏。中断后旧未保存稿仍可读；无已提交新登记时不暗中新建，有已提交登记时仅显式核验后允许重新打开。
- renderer 构建通过。隔离真实 Electron＋X11＋合成项目经生产右键菜单执行取消和确认，保留旧稿后加载新身份；实际源文件和 Git 逐字节未变，新项目无旧批注／未保存稿，旧稿经正式恢复 API 完整分页可读，其他项目仍可用，正常退出后冷启动不复活旧状态。最终原件 `/var/tmp/nozeli-project-reset-gui-mu4EPW/attempt-ahR70s/report.json`、`main.log`；`reset-confirmation.png`／`new-project-loaded.png`／`cold-new-project.png` 从核验 PID 的原生 X11 窗口截取并检查，不用主 shell 截图中的空白替代原生文档画面。
- 中间失败保留：初次 smoke 的 `tag.put` 缺少合法 projection；随后截图按 DOM 标题查 WM 标题未匹配，已改为 class＋PID；恢复列表首屏可能为空但仍有 nextCursor，驱动改为消费全部分页。回归首轮发现退役提交后内存缓存仍指旧状态，已在每次 catalog 提交后同步对应缓存；再次覆盖新登记后初始化中断，确保同根旧 hold 仍阻断冷注册。未关闭原有保存／属主保护来通过验证。
- 本轮不安装、不提交、不调用付费模型、不操作日常项目；Windows/macOS 未运行，不外推通过。一次性 GUI 驱动验收后删除，证据保留。

### 项目重置安装版验收（同轮用户追加授权）

- `HOME=/home/bfly node tools/install-local.mjs` 构建、校验并激活 current=`2026-11-06T00-54-32-789Z`，previous=`2026-11-06T00-00-59-494Z` 保留可回退。
- 使用实际安装 ELF（不是源码 Electron 或 wrapper）与隔离 profile／合成项目，核验 `/proc/<pid>/exe` 与已安装 binary 一致；真实项目右键“重置为新项目”→确认→新身份自动加载，旧元数据副本身份正确、原文未变、新项目实际打开并显示原文、旧项目不再出现在入口，正常 exit0。X11 截图按 class＋PID 归属捕获并检查，原件 `/var/tmp/nozeli-reset-installed-68kJNB/report.json`、`main.log`、`installed-reset.png`。
- 无付费调用、不修改日常项目、不强关原有窗口。本机安装冻结当前工作树；本轮提交只选项目重置代码、回归与文档，不包含其他既有改动。未推送／发布，不外推 Windows/macOS。一次性安装验收驱动已移除。

## Debug 临时运行时续行（2026-11-06，源码与重新安装验收）

- 定向：`HOME=/home/bfly TMPDIR=/var/tmp NODE_NO_WARNINGS=1 node --test tests/managed-debug-protocol.test.mjs tests/session-execution-presentation.test.mjs tests/managed-work-records.test.mjs tests/maintenance-status-page.test.mjs tests/maintenance-runtime.test.mjs tests/pi-session-admission.test.mjs`，128/128 通过、零失败／跳过。覆盖原 guard 拒绝与真实首次派工、原请求／sourceJob 不变、并发重复与冷恢复只读回执、报告未完成／错 scope／attempt／原 revision、权限与停止／取消、未知提交与回滚失败、双投影失败的 `projectionPending`，以及真实维护事件和新旧 Work 状态投影。纯状态夹具采用真实 Controller 与 Workspace.submitState，禁止无关存储 I/O，不以未执行的 stub 假装生产成功；真实持久化／CLI 链路由下面独立 live 证明。
- 原生：`HOME=/home/bfly TMPDIR=/var/tmp NODE_NO_WARNINGS=1 node tests/pi-debug-runtime-continuation-live.mjs`。同原文、同空参数序列触发真实失败；真实私有 Pi Orchestrator 主动 Debug／inspect／report／continue，重复 continue 回同 Work；一个 Worker 原生 write 真实生成 HTML，Git 冻结一份候选并发布，原项目／HEAD 不变，资源释放。原件 `/var/tmp/nozeli-debug-runtime-live-6XeZDf/report.json`。
- 安装：`HOME=/home/bfly node tools/install-local.mjs` 激活 `2026-11-06T02-14-18-377Z`，保留上一版 `2026-11-06T00-54-32-789Z`。运行 `HOME=/home/bfly TMPDIR=/var/tmp DISPLAY=:0 XAUTHORITY=/run/user/1000/xauth_yFzhYe NODE_NO_WARNINGS=1 node tests/installed-debug-runtime-continuation-live.mjs`：实际安装 ELF／main／私有 Pi／捆绑 Git、隔离新项目，同一请求真实失败后续行并交付待审核；对话真实徽标 `continued`，无 `debugging`，不把原故障当作已修复或最终任务完成。安装字节不变、正常 exit0，无额外模型请求。原件 `/var/tmp/nozeli-installed-debug-runtime-continuation-0CrFqx/report.json`、`electron.log`、原生主窗口与实际 HTML 工件截图均已查看。
- 工件 HTML 由真实 Worker 写入，额外自有沙箱 Electron 窗口只加载这份实际字节，验证模拟推进、暂停冻结和调参重置，不代替真实产品／CLI 验收。首轮安装链路已成功至交付与 UI，但工件查看的 `Target.createTarget` 为 Electron 不支持而停止；修正驱动使用自有 BrowserWindow 后整轮通过，失败报告 `/var/tmp/nozeli-installed-debug-runtime-continuation-xHdHXy/report.json` 保留，不计通过。
- `debug-runtime-continuation.fixture.mjs` 仅脚本化本机 provider 的输出，不篡改 host、无故障 monkeypatch／内部数据库注入。未调用日常账号或付费远端模型，不证明具体 GLM/GPT 的自主工具选择质量；Linux 限定、未重跑全仓默认套件。未重放用户现有失败任务、未自动接受候选、未提交／推送。

## 根据 Bug 台账修复参数合同并在安装后复测（2026-11-06）

- 对照前轮安装台账 `INVALID_CURSOR`×3、`DISPATCH_BRIEF_EMPTY`×1，修复源码默认参数合同而不是继续制造已修复错误再调用 Debug。首次 cursor 省略／null／空白均为真实首页；坏非空 token 仍拒绝。brief 缺省／null／空白使用冻结原请求，非空原样保留，其他类型可纠正零写入；有效意图归一化后幂等。历史已捕获拒绝证据与恢复回执保留，但新派工不再写旧拒绝记录。
- 命令：`HOME=/home/bfly TMPDIR=/var/tmp NODE_NO_WARNINGS=1 node --test tests/managed-debug-protocol.test.mjs tests/managed-taskboard.test.mjs tests/session-execution-presentation.test.mjs tests/managed-work-records.test.mjs tests/maintenance-status-page.test.mjs tests/maintenance-runtime.test.mjs tests/pi-session-admission.test.mjs`。最终144/144通过，零失败／跳过；默认等价参数、分页与损坏token、错误brief类型／零写入、意图冲突、历史恢复／未知效果／权限／停止均覆盖。初轮唯一失败为新测试错误假定附件同摘要重名选择，已移除无关转发细节断言，生产附件代码未改。
- `node tests/pi-recorded-bug-fixed-live.mjs`：实际 Manager／Controller／私有 Pi／文件／Git，保留同原文和 `cursor:""` 三次→status→dispatch `brief:""` 参数序列，正常首页读取与派工，唯一原请求／Work／Worker，真实 native write HTML 后冻结发布；无维护事件／新 Bug／临时恢复。原件 `/var/tmp/nozeli-recorded-bug-fixed-live-zjg5Df/report.json`。
- `node tests/pi-debug-activation-live.mjs` 与 `node tests/pi-read-protocol-correction-live.mjs` 均通过。前者是明确标注的宿主边界故障注入回归，后者保留坏 token 的原回合纠错（测试坏 token 改为非空 `not-a-cursor`，不再将合法空 cursor 当错误）；原件分别 `/var/tmp/nozeli-pi-debug-activation-live-Dvd3qE/report.json`、`/var/tmp/nozeli-pi-read-correction-live-qZFSIg/report.json`。原生产保护未放宽。
- 用户明确要求安装后复测。`HOME=/home/bfly node tools/install-local.mjs` 激活 `2026-11-06T03-38-28-248Z`，previous=`2026-11-06T02-14-18-377Z`。随后 `HOME=/home/bfly TMPDIR=/var/tmp DISPLAY=:0 XAUTHORITY=/run/user/1000/xauth_yFzhYe NODE_NO_WARNINGS=1 node tests/installed-recorded-bug-fixed-live.mjs`：实际安装 ELF/main／私有 Pi／捆绑 Git／隔离新项目复演相同输入和原空参数，最终唯一 Work 为 review，原 intake／Worker 已 completed，真实对话仅正常完成／交付徽标；生产维护查询 total=0，正常 exit0 后原始持久 SQLite Bug 数仍0；源文件／Git和安装字节未变。Worker 实际产出的 HTML 在自有沙箱窗口验证模拟、暂停／继续和调参，未自动接受。最终 `/var/tmp/nozeli-installed-recorded-bug-fixed-LlZZ5D/report.json`、`electron.log`、`source-fixed-delivered.png`、`actual-worker-chaos-demo.png` 已检查。
- 中间驱动报告保留：`/var/tmp/nozeli-installed-recorded-bug-fixed-ThftRn/report.json` 外部读活跃 SQLite 遇到锁，改为程序运行时走生产只读 API、退出后读库；`...-EGJO91/report.json` 采样早于完整 Work／Worker 结算，最终门已收紧，不据此提前签收。迁移旧场景导出／文件／live注册，无兼容别名；旧命令仅作前轮历史证据，当前入口为 recorded-bug-fixed。
- 未调用日常远端账号，provider 仅本地脚本化模型输出；不篡改宿主、无内部状态注入，核心行为是实际程序／CLI／文件／Git。Linux 限定、不声称全仓默认套件或 Windows/macOS 通过。未改日常项目／旧 Bug 台账，未重发旧请求、未自动合入、未提交／推送。

### 本轮用户授权 commit 后的独立暂存快照检查

- 用户确认提交后，按差异块分离本轮参数修复、历史 Debug 恢复／状态投影的直接依赖、对应测试及证据文档；未混入账号、报告审核、窗口布局、原生会话升级等其他既有改动，未推送。
- 导出暂存树在 `/var/tmp/nozeli-source-fix-index-zjul4y15` 独立检查，发现 Debug 状态投影依赖的 `storage-maintenance.mjs` 三个 SQLite 字段（debugState／debugEventJobId／debugAttemptId）未纳入，已补入精确的一行查询差异，不改其他存储逻辑。
- 补齐后的独立树 `/var/tmp/nozeli-source-fix-index-final-c4nd28u9` 采用串行文件检查且不放宽程序期限：77项中76通过，包含全部新增参数、历史 Debug 续行及状态展示测试；`large cold ledger is worker-paged metadata with global counts and no starts` 仍以 `STORAGE_RESULT_UNKNOWN` 超时失败。该压力项原因未在本轮定位，不将这轮快照检查计作全绿，也未通过延长生产超时或吞掉异常伪造通过。
- 上述额外失败不回写为此前工作树144/144或实际安装版同场景失败；两组既有运行结果及其输入、安装版本和证据仍分别保留。当前确认范围仅是已复现的空游标／空 brief 参数缺陷修复，不代表全仓或所有负载边界无问题。

## 项目临时不可用后移除／重新添加恢复（2026-11-06，源码修复，未安装）

- 日常 `nozeli_test` 调查确认：磁盘 root／metadata 实体、清单与数据库身份一致，无持久 lifecycle hold，登记在一次已完成 remove 后为 removed。安装版隔离复制可冷重加；原现场缺少具体失败返回，不能将下面复现直接等同日常现场确证。未修改日常目录、登记库或业务请求。
- 使用 `2026-11-06T06-50-32-215Z` 实际安装代码复现：临时移走原 `.nozeli`→真实 Host.open 报 `PROJECT_METADATA_MISSING`→原目录恢复→同一 Host 移除并重新 pick，仍报 `STORAGE_RESULT_UNKNOWN`；新 Host 可成功。原因是 requireOnline 使数据库隔离并缓存 unavailable，register 在重新添加时未走同身份核查恢复。原件 `/var/tmp/nozeli-readd-cache-SzNvwp/report.json` 与同一烟测驱动的安装版失败 `/var/tmp/nozeli-readd-fixed-x3v7ZH/report.json`。
- 修复 `ProjectStorage.initialize` 的显式重新添加分支：仅限已移除登记和同 metadata 实体，先确认旧连接退出，拒绝任何待核查 operationIds，再经独立 probe 验证 root／metadata／manifest＋DB 身份，调用现有 recover，复核生命周期及实体后清旧缓存、恢复原登记。`retry` 增加 settledOnly 模式，在异步身份探测后再次拒绝未知操作；普通显式存储核查语义保持。目录替换／符号链接／格式不符、未知写入与持久生命周期围栏不被添加操作绕过。
- 修复前新增回归 root／metadata 恢复两项均失败（STORAGE_RESULT_UNKNOWN）；修复后 `HOME=/home/bfly TMPDIR=/var/tmp NODE_NO_WARNINGS=1 node --test tests/project-storage-initialization.test.mjs tests/project-lifecycle.test.mjs tests/project-lifecycle-reset.test.mjs tests/project-lifecycle-admission.test.mjs tests/project-lifecycle-stale-remove-hold.test.mjs` 最终64/64通过，0失败／跳过。验证原project／instance、批注／草稿／恢复正文保留，以及未知操作／锁和同UUID替换实体拒绝。
- 真实生产源码 DesktopHost 烟测 `/var/tmp/nozeli-readd-fixed-NOavNF/report.json`：同进程 pick→metadata loss→open失败→恢复→remove→pick→open→recent可用，原projectId／instanceId不变，原文件、批注、未发送草稿和恢复文本逐项核对，唯一登记，无模型／任务启动。一次性驱动已删除，隔离证据保留。
- 此轮未构建／验收 Electron UI、未安装／提交／推送；日常现场未执行恢复操作，不冒称用户项目已恢复。旧安装仍包含原缺陷；Linux限定，Windows/macOS未验。

### 用户追加安装复测（2026-11-06，已完成）

- `HOME=/home/bfly node tools/install-local.mjs` 构建／校验／激活 `2026-11-06T08-40-52-916Z`，previous=`2026-11-06T06-50-32-215Z` 保留回退。未热改旧进程、未强关日常窗口；正常重启才加载修复。
- 使用安装内 Node 与实际安装 DesktopHost，在隔离目录同进程真实 pick→metadata loss→open拒绝→原metadata恢复→remove→pick→open。原project／instance不变、唯一登记，批注／未发送草稿／恢复正文／源文件逐项保留，报告 `/var/tmp/nozeli-installed-readd-host-y7YIqM/report.json`，ok=true。
- 实际安装ELF/main＋隔离profile：读取原文后正常关闭项目，临时移走metadata，真实 project.open 返回 PROJECT_METADATA_MISSING，恢复metadata后沿生产 remove 生命周期、添加按钮重新添加，同一live main复用原ID并打开原生文档显示实际原文。只通过隔离子进程测试配置提供目录选择结果，未修改业务状态／安装字节／内部ledger。原manifest／源字节／Git HEAD及唯一available入口均验证，provider零推理、无业务重放、正常exit0。原件 `/var/tmp/nozeli-installed-project-readd-restored-BWTEBB/report.json`、`electron.log`、`readded-original-project.png`，截图已查看。
- 首轮扩大到有活跃文档页面时丢metadata，恢复后移除被真实保存屏障拒绝 `PROJECT_FLUSH_FAILED`，报告 `/var/tmp/nozeli-installed-project-readd-restored-JIveSu/report.json`。没有绕过保存保护；最终明确验证已安全关闭／可正常移除的重加路径，不宣称该活跃保存失败分支已修复。
- 一次性安装驱动已删除、证据保留。未改日常项目、未证明日常原窗口的确切错误与本复现相同；未清锁／重置／重发旧任务、未提交／推送，不外推Windows/macOS。源码64/64结果与上述安装证据分别记录，不混称全仓验收。

## 永久清除项目状态与确认待办数字（2026-11-07，源码修复，未安装）

- 定向：在`apps/desktop`运行`node --test tests/project-lifecycle-reset.test.mjs tests/project-lifecycle-admission.test.mjs tests/project-lifecycle.test.mjs tests/project-attention.test.mjs tests/project-attention-summary.test.mjs tests/workspace-native.test.mjs`；本轮128/128通过。
- 真实GUI：先`npm run build:renderer`，再依次运行`node tests/desktop-project-reset-live.mjs`和`node tests/desktop-project-attention-live.mjs`。两者只创建隔离临时项目/profile，无远程模型；前者会永久清除它自己创建的多代fixture数据，不得改成日常项目路径。后者包含真实65秒空闲等待以验证到期刷新，不能用瞬时DOM检查替代。
- reset实测4组：`/tmp/nozeli-permanent-reset-yiq2HD/report.json`；真实PTY停稳、current/retired实例与恢复区/归档清除、新id打开、原文件/Git/其他项目保留、正常退出。徽章实测6组：`/tmp/nozeli-project-attention-rCTiR8/report.json`；未知/0隐藏、正数红圈、四主题、320/390与200%原生zoom、空闲到期刷新、原业务不变。
- 以上不验证日常项目已清除，不代表Windows/macOS或完整辅助技术签收；本轮未安装、提交或推送。行为合同和证据详见[§13](agent-conversation-status-demo.md#13-永久清除项目状态与确认数字徽章2026-11-07源码修复未安装未提交)。


## 退役项目启动恢复污染新身份存储（2026-11-07，已安装复测）

- 故障：旧归档reset保留enabled退役登记；startup恢复对旧ID调用managedExecutionSummary，requireOnline旧实体校验失败后按共享metadataRoot/project.sqlite隔离连接，新ID随后STORAGE_RESULT_UNKNOWN。旧安装隔离storage复现`/tmp/nozeli-old-id-block-MoRvaP`；实际旧ELF冷启动fixture`/tmp/nozeli-retired-startup-z3zzpZ/report.json`失败，未改日常数据。
- 修复：requireOnline在任何metadata/DB访问前PROJECT_RETIRED拒绝removed，异步校验后再次确认登记，在catch不得隔离其他有效owner。真实活跃身份损坏与unknown提交仍隔离，不自动recover。显式重新添加先核验原实体/manifest/DB，再发布active登记，失败回退。startup/config扫描跳过removed业务恢复；旧provider inventory继续核验未知所有权，未直接释放名额。
- `node --test tests/project-retired-isolation.test.mjs tests/project-storage-initialization.test.mjs tests/managed-projects.test.mjs tests/project-lifecycle-reset.test.mjs`64/64通过，renderer构建通过。新isolation测试加入integration名册。
- `node tests/desktop-retired-startup-live.mjs`源码通过`/tmp/nozeli-retired-startup-stXTIs/report.json`；冻结ELF`/tmp/nozeli-retired-startup-lXGOxV/report.json`、激活后的current/nozeli`/tmp/nozeli-retired-startup-nXsMIa/report.json`均通过。每次运行含两次实际冷启动，3个enabled退役身份共享新metadata路径仍不使当前项目不可用；原project/instance、paper/annotation/前台草稿/退役恢复稿保持，未生成退役连接错误提醒，无模型请求，正常exit0。
- 用户授权安装已激活`/home/bfly/.local/opt/nozeli/releases/retired-storage-isolation-20261107`，previous=`project-attention-badges-r2-20261107`。该包同时包含此前已测永久清除及确认数字徽章；current/nozeli徽章6组再次通过`/tmp/nozeli-project-attention-AsFCgh/report.json`。
- 对实际nozeli_test用冻结包requireOnline＋严格readOnly DB适配器核验：当前7d9ed862-bbdc-4c7c-946d-a63b368fba6e available，5个retired均PROJECT_RETIRED且未invalidate。此为实际磁盘事实+新代码只读核验，不是日常live进程的UI验收；未强关旧进程、未修改原catalog、未重置或清除用户数据，需正常退出重开才能消除旧内存隔离并加载新版本。未提交／推送，Linux限定。

## 任务标签、限定历史与只读原生分屏（2026-11-08，Linux源码限定通过）

- 默认unit已登记 `task-workspace-presentation.test.mjs`，integration已登记 `task-timeline-scope.test.mjs`。集中实测：`npm run build:renderer`、`npm run test:unit`（797项）、`node --test tests/task-timeline-scope.test.mjs`（13项）、`node tests/desktop-session-timeline.test.mjs` 均通过。消费者覆盖真实React／Electron DOM与受控读取边界，不冒称真实调度或模型执行。
- 原生workspace既有生命周期回归另行运行 `node --test tests/workspace-native.test.mjs`，78/78通过；未将它冒称全仓integration套件。
- `managed.timeline.page` 接受可选 `workId` / `sourceJobId`，两者同时出现必须指向同一明确关系。Work 查询覆盖全部历史轮次、原始/续作主控和确切原输入；仅 source 查询覆盖同一 intake lineage。复用 domain `intakeLineage`，未知/歧义/不一致拒绝 `TIMELINE_SCOPE`，不按文本或当前任务猜归属。
- 保留 `{version,entries,deltas,hasMore,nextCursor}`；cursor 绑定项目与完整 scope 参数，跨 scope、跨项目及全项目 cursor 混用拒绝 `TIMELINE_PAGE`。按 index metadata 过滤后只 hydrate 所选页，沿用现有正文/字节预算。限定历史不受前台清空边界裁剪，也不修改 Work/消息当前状态；`timeline.read` 原有不可变版本/UTF-8 字节协议不变。
- 离线/无配置读取沿用 `projectionSource`，不 connect 或启动 Provider。固定 guided-demo 的限定查询明确报 `DEMO_SCOPE_UNAVAILABLE`，不将项目全量演示记录冒充任务过程。
- `workspace.control/task-workspace` 在可信同项目shell／conversation／task-process之间做明确导航；process/overview打开固定scope、readOnly原生 `task-process` 分屏，不再向右侧状态栏投递过程；locate只导航已有conversation，不创建可发送替代会话或connect/send。task-process的原文、scope cursor、冻结材料、导出和阅读态保存均受固定范围校验；其他任务、项目文件写入、send和approve拒绝。大原始记录超过显式解析预算时，仍沿原可信dialog导出路径校验record ID、objectId/version、生命周期和最终SHA，不经普通managed invoke伪转发。
- 真实Electron／私有Pi／回环确定性HTTP／Git与文件流程：`node tests/desktop-task-workspace-live.mjs`，最终 `/tmp/nozeli-task-workspace-q4xrmr/report.json` ok=true；真实持久100事项及右栏几何：`node tests/desktop-project-attention-live.mjs`，最终 `/tmp/nozeli-project-attention-Zm7Aww/report.json` ok=true。模式切换的host bootstrap消费、旧页不混未来成果、原选区和草稿、分屏复用／关闭、冷重启不重放、浅深窄窗与缩放已核验。图片逐原生面读取，不拼接冒充OS合成截图；系统IME候选窗、Windows/macOS和付费模型未验。保存／导出／权限夹具与真实native流程的边界见 `docs/task-workspace-design.md`。


### 本机安装与追加验收（2026-11-08）

- `task-workspace-20261108-local-01` 的实际ELF＋包内Pi／Git在独立profile／合成项目重走任务工作区主旅程，`/tmp/nozeli-task-workspace-JivxfM/report.json` ok=true、providerErrors=[]；786项src/dist输入一致，未触及日常项目、未发起付费模型请求。
- 额外 `node tests/desktop-direct-background-live.mjs` 未通过：`/tmp/nozeli-direct-background-iEx83c/report.json` 首次在1440px尺寸等待超时；显式关闭新增分区后 `/tmp/nozeli-direct-background-xbIH3i/report.json` 在590px原生conversation resize等待超时；将新增过程旅程从该旧宽度旅程分离后，`/tmp/nozeli-direct-background-Jzun6V/report.json` 仍在590px同处超时。已观察直接提交／重复点击去重／真实Worker发布及任务标记通过，不能外推该脚本后续拖动、脱离、丢弃及冷恢复通过。独立完整任务分屏的实际安装主旅程通过不掩盖此失败；未因此修改产品或放宽宽度断言。

## 任务框内含对话与动态宽度（2026-11-08，源码限定通过，未安装）

- `node --test tests/session-store.test.mjs tests/session-execution-presentation.test.mjs tests/task-workspace-presentation.test.mjs`：51/51。覆盖派工前后身份不变、原输入与续聊仅归原任务、两个同名／并行任务不串联、原生回显去重、转换输入、明确绑定的诊断及未关联诊断、旧页不制造页外原输入。
- `npm run build:renderer` 与 `node tests/desktop-session-timeline.test.mjs` 通过。最终消费者 `/tmp/nozeli-session-consumer-XgoGAn` 包含框内原输入／补充／Worker答复、框外仅普通前台消息、初始及补充内部交接不冒充重复输入、引用原文及1200／480／320浅深自适应边界；同时保留原文分页、历史、IME／选区与阅读位置消费者检查。该宽度检查是组件Electron表面，不冒称独立原生窗格生命周期或CLI验证。
- `node tests/desktop-task-workspace-live.mjs`：最终真实Electron＋私有Pi＋回环确定性HTTP＋实际Git／文件，`/tmp/nozeli-task-workspace-HCp6is/report.json` ok=true、providerErrors=[]。原输入、原Worker问答和续改各一次呈现在确切原task框内，普通前台讨论留在框外；不同任务不串绑，原卡DOM／身份色／草稿、原只读过程、旧报告、长工具原文、正常退出与冷恢复零重放通过。未操作日常业务、未发起付费模型、未安装本次源码；Windows/macOS及系统IME候选窗未验。此前额外直接提交旧resize脚本的590px等待超时记录仍保留，本次不宣称修复该独立限制。

### 用户授权的安装、日常重启与实际安装程序测试

- 功能提交 `9c28387`；本机current=`task-contained-20261108-local-01`，previous=`task-workspace-20261108-local-01`。安装器验证并原子激活，786项源码／构建输入逐字节一致。实际安装ELF＋包内Pi／Git的独立双任务、多轮问答／续改、任务框归组、只读过程、原文、草稿、正常退出与冷恢复 `/tmp/nozeli-task-workspace-nFjRUN/report.json` ok=true、providerErrors=[]，截图已查看。
- 日常旧PID1320393通过 `_NET_CLOSE_WINDOW` 正常退出，不发送kill／force，不选择取消任务；原入口／profile启动验收PID1788993，激活既有conversation view而非新建会话，验证4个本页任务框宽760px、零框外后台输入与零初始化错误。两个项目job／Work／消息身份不变，5个源文件摘要不变；243条原项目记录中242条不变，唯一重写为collectionOrder，另有正常host-opened审计。此差异先核实为排序／生命周期记录再限定通过，未抹去差异或修改产品兜底。
- 验收进程再次正常退出后，使用相同系统入口和原项目目录参数重开，最终PID1899563运行本次ELF、`NOZELI_DESKTOP_READY ... debugPort=none`；无测试实例／profile覆盖，普通系统窗口保持打开。收据及隐私受限本地截图位于 `/tmp/nozeli-contained-install-HdAA4R`，不加入仓库。程序重启后再次核对两项目job与消息身份保持。此前590px旧resize等待超时仍单列，不外推本次全部旧脚本通过；其他平台、系统IME与付费模型质量未验。
## HTML 只读镜像与多格式显示验收（2026-11-06）

拆分出的 HTML 只读镜像（split-x 阅读副本）此前永远打不开隔离离线预览：镜像端 web workspace 先发起编辑缓冲 publish，而主进程对无租约只读面固定 `EDIT_LEASE_DENIED`（workspace-native.mjs `workspace.document.publish`），renderer 捕获后镜像 pane 只剩空占位与错误状态，第二个原生 guest 从不创建。修复为只读面跳过该 publish，快照走既有 `syncDocument(captureBuffer)` → owner `publishDocumentBuffer` → `workspace.buffers`，捕获优先缓冲字节而非磁盘，writer 未保存编辑不丢失（isolated-surfaces.mjs / isolated-preview.mjs capturePreview）。

| 验证 | 实际结果 | 证据／边界 |
| --- | --- | --- |
| `NOZELI_TEST_BINARY=<Nozeli.app>/Contents/MacOS/Nozeli node tests/desktop-native-html-mirror-preview-live.mjs`（darwin 实际包） | 旧构建精确失败于镜像 `EDIT_LEASE_DENIED`；修复包 owner guest 与 mirror guest 均可见，双侧564×747、中文正文与占位尺寸匹配，正常退出0 | 修复包 `dist/macos-display-fixed-20261106/Nozeli.app`；实际原件 `nozeli-mac-html-mirror-0JqlDg/report.json`，截图 `mirror-body.png` |
| 自有隔离实例串行矩阵（未入库脚本） | 激活切换 A↔B、设置对话框、窄抽屉、模式 source/web/split 往返、窗口缩放：guest 隐藏/恢复与占位尺寸全部一致 | surface 页因 `backgroundThrottling:false` 不能作 visibility 证据，以 guest 页 visibilityState 为准；split 镜像为唯一确认缺陷，未复现其它几何/z-order bug |

未放宽 CSP、隔离或授权边界。修复包已实际构建、ad-hoc签名深验证；定向隔离预览／在线网页／原生工作区回归117项全过，本轮未重跑完整默认套件；Windows/Linux打包行为未验证。

- 新增永久显示矩阵 `tests/desktop-display-matrix-live.mjs`：在1180×820与660×520两种实际原生窗口下，逐项验证Markdown中文／表格／滚动、长代码着色／滚动、PNG天然尺寸／四色像素、双页PDF文字层／canvas／真实翻页、DOCX长文／滚动、XLSX单元格／canvas、PPTX三页引擎／中文、本地HTML网页／源码／对照、回环在线网页实际guest正文／图片／滚动及resize。修复包完整矩阵9类全部通过，检测风险0；原件 `nozeli-display-matrix-ifDuTt/report.json`，归档见 `.test-output/display-review/final/`。合成样本通过不等于所有网页或任意Office文件保真通过。
- 截图界限：HTML与在线网页截真实guest，外壳截图不含原生guest像素，只能作布局参照；系统桌面screencapture接口当前不可用，未声称完成系统级合成截屏验证。窄窗HTML对照按产品响应式设计上下堆叠，二维无重叠，不能用单纯x轴相交误报。
- 复跑：`NOZELI_TEST_BINARY=<app>/Contents/MacOS/Nozeli npm run test:macos-display`。普通切换、设置遮挡／恢复、尺寸跟随未复现其它z-order问题；用户特定网页／文件仍需对照其原件，不能将本矩阵当作已修复所有显示差异。

## 桌面残留测试实例与退出排查（2026-11-06）

- 用户报告错误窗口且不能关闭。现场PID40186使用旧 `macos-final-20261106` 包，打开的SQLite／Chromium文件全部指向本轮临时 `nozeli-probe2-yMXhVm/.Nozeli`，不是用户正常profile；其父进程已退出。原临时探针被timeout终止且未处理SIGTERM，finally未执行，遗留应用子进程。主线程采样停在 `NSAlert.runModal`；辅助访问读取被系统拒绝、调试端口不响应，因此错误弹窗正文未观测，不能声称其具体异常已修复。
- 先归档自有测试目录与主线程采样，再发送普通SIGTERM；主进程和已知Chromium子进程全部退出，未使用SIGKILL，不删除用户项目或正常配置。七个废弃临时探针已从原可运行位置移除并归档；永久回归保留。清理后进程快照未发现其它Nozeli实例。
- 对 `macos-display-fixed-20261106/Nozeli.app` 重新执行快速打开和窗口恢复永久旅程：9轮文件打开、双轴分屏／只读拒绝／独立窗移回／重启恢复／权限失败下未保存稿均通过，renderer错误0、最终正常退出 `{code:0,signal:null}`。事故事实与报告归档 `.test-output/desktop-hang-20261106/`。此复验不等于同步错误弹窗根因已修复，也未新增通用强退或异常抑制逻辑。

## 当前用户窗口的网页实屏白屏（2026-11-07）

- 用户确认Bing与index.html实屏白屏；此前guest截图／DOM显示正常不能证明窗口合成正确。经同日常profile正常重开、主进程诊断，原生children顺序为chrome→guest→不透明wrapper，实际覆盖正文；仅将guest放到wrapper后，用户明确确认“必应显示出来了”。不是网络或CSP问题。此前仅靠guest像素与visibilityState的显示通过结论对此不充分。
- 根因在 `workspace-window.cjs` 的 addChildView包装：传undefined index并反复重插siblings导致原生顺序倒置。改为显式append index与仅将chrome保持底部。真实Electron回归 `node_modules/electron/dist/Electron.app/Contents/MacOS/Electron tests/native-view-stacking.entry.cjs` 通过，覆盖wrapper→guest、新面加入、guest重新挂载与显式索引。
- 新包 `dist/macos-native-stacking-fixed-20261107/Nozeli.app` 已实际构建及签名验证，在用户日常profile重开原项目后，index与Bing自动形成chrome→wrapper→guest，无现场shim；原index文件内容不变。本轮未重跑完整默认套件，未将软件内截图冒称系统合成截图。
- 排查副作用：用隔离profile注册真实用户项目触发既有身份迁移，造成旧日常入口身份失配。已停稳两实例、归档迁移前后元数据、还原原project.sqlite/project.json及原catalog元数据目录身份；原项目ID、日常会话绑定与入口恢复，index哈希不变。双份备份与诊断在 `.test-output/current-blank-review/`。后续真实用户原件排查不得以独立profile注册同一目录；应使用原profile或项目外只读副本。

## macOS 应用图标修复（2026-11-08）

旧包复制Electron.app而未替换 `CFBundleIconFile=electron.icns`。打包改用现有Nozeli paired-tabs品牌PNG经sips生成完整iconset，再由iconutil输出Nozeli.icns；Dock启动图标也显式设置为同一品牌资源。`dist/macos-icon-fixed-20261108/Nozeli.app` 已实际构建／签名验证／启动；通过NSRunningApplication读取系统识别的运行图标并转PNG，视觉确认为红框黑色N。证据 `.test-output/icon-check/{verification.json,system-running-icon.png}`。不清空系统图标缓存、不覆盖旧包、不强退用户实例；本轮仅图标专项，不重跑完整默认套件。

## PR #27 主线整合安全复核（2026-11-09）

在独立干净worktree检出原PR `5fbc482`（base `9a2466a`），未改变日常安装或原开发目录的在途修改。内置reviewer分别审查文件／持久化与进程／打包两域，识别并关闭五项新增缺陷：最终发布async间隙覆盖同宿主修正、FIFO最终打开阻塞、长requestId临时文件名超限、Darwin进程表ENOMEM重试耗尽冒充空表、PID查询错误冒充gone。最终发布恢复平台内同步pin操作，明确不宣称跨进程原子CAS；Darwin错误均传播非零退出，不能授权回收锁或进程槽。两名reviewer复审确认对应发现关闭，不代替原生运行。

本地验证：锁定npm依赖重新安装并重建node-pty、Pi、PPTist、renderer；元数据检查0 failures、六项第三方义务仍pending。原PR Linux定向239项中236通过／3个Darwin专用跳过；修正后的五文件安全回归50项中47通过／3个Darwin跳过。对原PR解压包运行新增测试，200字符请求ID确实ENAMETOOLONG，map/index并发修正均被覆盖，两个FIFO目标均达到子进程期限；修正后相同永久回归通过。不能把Darwin跳过算本机Mac通过。

原PR已从全新依赖构建Linux便携包、独立解压运行：X11 `/tmp/nozeli-pr27-acceptance-PU98Ky/unpacked-smoke/smoke-olHJSm/report.json`、Wayland `.../smoke-w5M5ok/report.json` 均ok=true，真实文件编辑／保存、挂起切项目保留及正常退出／冷恢复通过。只读HTML镜像真实双guest及几何 `/tmp/nozeli-mac-html-mirror-WhkPYB/report.json` ok=true、exit0；原生View叠放入口通过。guest截图只证明guest像素，不冒充OS合成截图。初次临时驱动因Puppeteer模块路径不符停止，修正驱动导入后通过，未修改产品兜底。

`.github/workflows/ci.yml` 增加macOS native safety：真实Darwin编译／selfcheck、生产helper syscall注入的错误／确认消失／重试成功及JS adapter传播回归、平台文件／持久化／初始化／版本回归；纳入原CI gate，不能用Linux替代Mac原生修正验证。`darwin-procinfo-native.test.mjs`已注册integration，Linux明确跳过。合并仍须当前head全部CI通过、更新后便携包／真实流程验收；此记录不是提前宣称已合并或最终CI全绿。Mac现有用户验收与Linux本轮证据分开，保留截图矩阵、OS IME、完整强退后代树、自动更新、公证及发行审计等未测边界。

首轮macOS arm64 CI `42576568859`：fs_anchor/fullsync/procinfo真实编译和selfcheck成功，新增helper故障注入四组全部通过；总计64通过／4跳过／2失败。两项文件系统测试在Git仓库准备阶段受runner宿主配置触发 `FILTER_UNSUPPORTED`，不是跳过或降低产品拒绝规则；后续CI给原生测试显式独立HOME，避免继承runner全局Git过滤器。此初轮失败保留，最终须重跑完整合并门，不能把局部native通过说成整个job通过。

## Beta1 双平台私有草稿准备（2026-11-10）

本轮用户只授权准备 Linux x64／macOS arm64 草稿，不公开发布；历史 alpha.6 例外不复用。Linux整合工作树从 `/tmp/nozeli-beta1-integration` 迁到 `/var/tmp/nozeli-beta1-integration`：首轮完整集成在 `/tmp` 遭 errno -122（EDQUOT）、SQLite I/O及最终日志写入失败，后续烟测截图也写入失败，均不计通过。首轮原件保留 `/var/tmp/nozeli-beta1-first-attempt-evidence`，不删除用户文件或把失败改为跳过。

Linux 已观察结果：unit816通过／零失败；Pi与生产renderer构建成功；迁移磁盘后PPTist完整构建及upstream来源归档成功；完整Electron smoke六脚本通过，包含真实合成项目阅读／编辑／原文件保存、挂起切项目保留、正常退出与冷恢复、PPT待提交文字和28项真实审核消费者。烟测原件 `.test-output/ci/smoke.log`、`smoke-Y7biLY/report.json`（ok=true，两个正常exit0，renderer errors为空）；已查看实际编辑截图。完整integration与最终发行包资格分别记录，不能用这些源码烟测提前替代。

新增草稿检查器七个离线黑盒场景通过：历史Linux-only Alpha、双平台本地资产、mac包错误提交拒绝、完整草稿、缺mac资产拒绝、已公开版本拒绝及历史Alpha草稿。首跑确实暴露缺失tarfile导入与夹具USAGE校验和漏项，已修正后全过；不是只做语法检查。两份工作流YAML已实际解析；mac版本映射已执行验证，CFBundleVersion保持三段数字，完整预发行身份独立保留。

mac候选须由macos-15 arm64工作流在精确提交真实构建并解压运行，旧Mac证据不是本版本通过；Linux解压发行程序也须单独验收。六项审计仍pending，元数据检查0 failures，`--public`仍因六项未签收阻断；CI、草稿与技术验收均不替代公证或法律签收。

首个干净候选 `4ef2576` 的Linux实际解压包通过基础保存／冷恢复（`.test-output/ci/smoke-yQAY4y/report.json`），以及随包Pi多Task／同线程问答和第二次发布／43890字节原文／草稿与冷启动零重放／浅深320、390、1280和200%缩放真实旅程（`/var/tmp/nozeli-task-workspace-OUWUaT/report.json`，ok=true，providerErrors为空）。独立运行时复核未发现范围内P1/P2；发行复核发现Ubuntu解压包sandbox需单独配置root所有者及4755，CI已沿用既有正常sandbox策略补齐，不改分发归档或使用no-sandbox。

mac首轮工作流 `42721116462` 的darwin arm64确认、锁定依赖、PPTist与Pi构建均成功，打包预检因Electron惰性下载尚未生成Electron.app而失败，尚未运行mac解压烟测。修正为调用锁定Electron包官方resolver准备二进制，开发者与发行打包共用该安装语义；不能把此首轮局部构建成功说成mac包通过，须以修正提交重新构建和运行。

迁移后的完整Linux integration最终1889通过／4跳过／零失败（175文件，`.test-output/ci/integration.tap`）。候选 `5b9f446` Linux新包再次完成保存／正常退出／冷恢复（`smoke-yj9IQ8/report.json`），随包Pi真实Task旅程再次ok=true且无Provider错误（`/var/tmp/nozeli-task-workspace-IO52Zb/report.json`）；已查看最终深色320px截图。

mac修正提交的工作流 `42721602963` 已通过原生构建、组装／ad-hoc签名、zip解压后的codesign／架构／包内Node和Git／plist／RELEASE绑定自检；未通过交互烟测：只完成首页截图，首次点击期间CDP调用超时，主日志明确 `hidden=true`。烟测误将无DISPLAY的darwin当作Linux headless，现将该判定限定为Linux，让Mac运行真实可见窗口；不延长超时、不跳过点击或宣称Mac交互已通过。失败截图／report／main.log保留 `/var/tmp/nozeli-beta1-mac-failure-5b9f446`，最终资格仍须修正后的mac工作流实测。

候选 `37dc8c8` 的mac工作流 `42722979684` 已全过：实际可见.app阅读／Command-S保存／挂起切项目／正常关闭／冷恢复，以及随包Pi多Task、多轮、长原文、卡内过程／草稿、浅深320／390／1280与200%／冷重开零重放均ok=true、Provider错误为空。已查看Mac实际截图，归档及报告下载到 `/var/tmp/nozeli-beta1-mac-artifacts-37dc8c8`、`/var/tmp/nozeli-beta1-mac-evidence-37dc8c8`。两平台源码tar逐字节一致、五payload统一SHA及两包RELEASE绑定检查0技术失败；未创建tag或草稿。

同提交完整CI `42722979666` 的Linux构建／实际包旅程、unit和Mac native safety通过，但integration为1884通过／5失败／4跳过，故总门失败。三项privilege-broker真实普通用户执行返回failed，另两项task-permissions真实授权执行亦失败；不是取消，不能用本地1889通过替代。权限助手明确拒绝组／其他可写命令二进制，runner的setup-node解释器权限是待核实环境差异。CI现在在冻结批准前记录解释器实际mode与属主、去掉组／其他写位，并先执行一次完整冻结／摘要／真实UID／stdout验证；失败打印完整代理结果以定位，原产品拒绝规则、五项测试及完整套件均不放宽或跳过。须以新提交runner输出与完整CI结果确认该修正。

## Beta1 公开授权与发布前维护（2026-11-10）

用户在获知六项义务仍未签收后追加明确要求“发布”，授权本版Beta公开预发行，不标稳定版／latest，不沿用旧Alpha许可。后续维护只更新授权披露及构建／测试基础设施；产品tag、源码归档与六附件继续绑定`17209df`，不修改或重上传已验程序。原产品main CI `42739206219`全绿，双平台实包及远端字节资格保持。

首轮授权文档CI `42747241832`：unit与Mac native safety通过，Linux构建因上游锁定依赖 `registry.npmmirror.com/yargs-parser/-/yargs-parser-21.1.1.tgz` 返回HTTP504而失败；integration为1888通过／1个hookFailed／4跳过，唯一失败为冷重开夹具清理 `storage-v2/recovery` 时ENOTEMPTY。该夹具注册根目录删除早于重开控制器的停止，并把storage worker留到文件级after才关闭，存在真实清理竞态；不重试删除来掩盖。

修正：冷重开控制器在try/finally内还原故障注入、停止并关闭自身store；统一夹具先停止controller、关闭store与storage数据库线程，再删除自有目录。整个 `managed-context-cutover.test.mjs` 24项通过／零失败，原业务断言保留。PPTist只在一次性构建树把v2锁文件两套resolved记录的npmmirror地址映射到官方npm，同时固定本次npm ci的registry；版本与integrity不变，raw上游tar仍先经原SHA验证、原样保留。完整真实构建成功：464包、1933模块、Vite 5.4.21、`index-BzK7tRF9.js`。首个本机Git传输曾因GnuTLS/early EOF失败；随后仅该构建调用以临时HTTP/1.1配置完成，未改全局Git/npm配置或增加产品重试策略。

元数据与来源检查、完整修正提交CI及公开后匿名字节核验分别记录；六项pending与`--public`失败保持，不把当前发布授权记为法律审计签收。

## 图示校验错误与原Work自恢复（2026-11-10）

用户报告HOST_MAINTENANCE；只读原生日志确认末尾`nozeli_diagram`因布局校验失败被无code异常升级为HOST_TOOL_ERROR／PI_HOST_TOOL_FAILED，Work维护暂停，并非全机维护窗口。原始参数在纯离线渲染器中复现；没有重放原任务或写入用户材料。修复将已知作者输入／schema／布局错误类型化为DIAGRAM_INPUT_INVALID，在原Worker回合返回校验详情和修正建议；未知内部异常继续失败。

维修账本保留白名单工具名／callId／阶段／效果确定性／机器码及有界规则，正文、参数、凭据不进入诊断。图示故障诊断可按摘要读取固定允许的渲染／恢复源码；没有安全续行能力时，debug.report以持久host-control回执直接终结，不再额外耗一次模型回合。已知遗留故障由不可变最终单一工具调用／失败结果、精确job／Work／revision／线程及纯渲染类型化拒绝证明安全；唯一恢复回执与同线程补充原子入账，未知传输／并行调用／人工暂停／权限／版本漂移继续拒绝，冷开只补账。独立复核发现并修正排队后版本漂移和中断后回执过滤两项问题，复核无剩余P1/P2。

验证：绘图／控制器／恢复／诊断／维修五文件86项全过；补充真实宿主终态unknown区分与执行准入围栏后，控制器／恢复21项全过。真实私有Pi／本地确定性HTTP诊断旅程 `/var/tmp/nozeli-pi-debug-activation-live-nmK6ms/report.json` ok=true，诊断报告以host-control终结，原Worker与业务请求不重放、原文件／Git不变。初次旅程因过时夹具试图跨bug调用被正确限制，已将正常旅程改为绑定本bug，跨范围拒绝仍由确定性回归覆盖，未放松产品保护。

冻结本机候选`diagram-recovery-20261110-local-01`的五个核心修复文件与已验源码摘要一致，实际ELF＋包内Pi／Git多Task／多轮／长工具原文／草稿／浅深窄屏与200%／正常关闭冷恢复旅程 `/var/tmp/nozeli-task-workspace-kFuMvP/report.json` ok=true、Provider错误为空。旧日常宿主正常窗口关闭退出，原账本私有备份后激活候选，previous保留`compact-inline-task-20261109-local-01`；未提交或发布本轮修改，跨平台未验。

用户授权的Liuhuaiyu恢复使用原profile及现有项目入口，未独立profile重新注册用户目录。新宿主按原生最终工具档案及纯渲染复验证明只有输入校验失败，保持同一个Work／revision1／原线程，原失败job历史不改，仅排入一个持久回执绑定的纠错补充；未直接清理数据库或新建替代任务。真实后续交付以私有本机证据目录`/var/tmp/nozeli-liuhuaiyu-recovery-proof-DHAZu0`记录，不向仓库提交用户内容。

真实续作越过图示故障后，首个恢复补充因报告HTML的MismatchedCloseTag被原发布路径终止，不能记为任务通过。追加纯HTML语法预检在artifact捕获前返回可纠正结果，保留严格解析策略；控制器／HTML回归67项全过。激活`diagram-recovery-20261110-local-03`，previous保留`diagram-recovery-20261110-local-01`，此前宿主exit0正常关闭。用户已授权在原项目继续，沿原Work追加一次明确HTML纠错说明，不重发原始业务请求；这是用户授权的后续补充，可能按既有Work合同进入新revision，不冒称仍为最初revision1。任务实际交付与问题／成果回执分别核验，不以Worker已启动代替完成。

最终真实原Work恢复完成：同Work与原线程保留，用户授权的HTML纠错回合completed，Work进入revision2／review并发布result冻结回执；旧revision1问题及失败历史保留，不清除或伪改。已通过实际Task“查看成果”打开原生报告表面，确认正文可见、6706字符、1个SVG及实际截图，未点击接受／丢弃，未自动合入。最终技术原件`final-result.json`与隐私报告截图留在上述私有目录，不入仓库。日常程序保持运行，current为`diagram-recovery-20261110-local-03`；本轮只声称运行／交付链已恢复，不以此证明用户报告的医学结论正确性。

## 已交付成果仍无法审核讨论（2026-11-11）

Liuhuaiyu真实界面显示当前成果第2版已review，讨论输入却只读，原因RECOVERY_REQUIRED。只读账本确认第1版HTML_REPORT_INVALID／MismatchedCloseTag的恢复事项仍open，审核代码按同Work任意open recovery阻断；不是429限流，也不是历史报告绑定错误。此前成果交付验收遗漏恢复事项结算及讨论准入，本次保留该事实。

新增宿主报告恢复结算：只核对旧失败job／todo／Work修订、已确认的同线程原生最终单一nozeli_publish调用和错误结果，纯重验原HTML确实语法拒绝；只有更新修订的成功result回执、快照、来源job与原线程均匹配才精确resolve旧事项，并持久绑定原失败与新成果及日志摘要。未知传输／其他工具／并行调用／无结果回执／不同线程／新结果被替代继续拒绝；不按版本旧就批量清空，不改变旧失败job和用户草稿，不发送模型或接受成果。新发布及项目启动各自调用，修复已有账本也防止复发。

本地恢复／控制器／诊断回归39项通过，恢复与既有审核讨论回归21项通过；来源调用边界与冷恢复为纯只读核验＋确定性持久结算，不以生成新任务替代原Work。安装候选为review-recovery-20261111-local-01，真实界面与安装后结果另行记录；跨平台／全量回归不作已验声明。

已安装review-recovery-20261111-local-01，previous保留diagram-recovery-20261110-local-03。冻结实包Electron／随包Pi／合成文件多Task、讨论、长原文、草稿、冷恢复旅程 `/var/tmp/nozeli-task-workspace-PsArKg/report.json` ok=true。日常旧程序正常关闭exit0；新宿主沿原profile打开Liuhuaiyu后，宿主自动把唯一旧恢复事项结清为report-syntax-corrected，绑定原失败job、新成果来源job及冻结报告／日志摘要。原Work／revision2／result对象不变、jobs仍9条、无活动或新模型回合。

实际打开当前成果的审核讨论：textarea从readonly变为可编辑，输入临时文字后发送按钮实际启用；未点击发送，已还原原本空草稿并观测“本地草稿已保存·未发送”。截图已查看；私有证据 `/var/tmp/nozeli-review-recovery-proof-Cee7zD/{discussion.png,result.json}`。随后程序正常exit0，再次只读SQLite确认旧事项resolved已持久、任务仍review、jobs9条，无接受／丢弃／合入或任务重放。未重新打开用户已关闭的窗口；本轮未提交／发布。

## Beta2 双平台发行候选整合（2026-11-11）

用户明确授权提交当前产品修改并发布0.1.0-beta.2 Linux x64／macOS arm64预发行；六项再分发义务仍pending，--public诚实保留六项失败，不设stable／latest。原本机修改294f91f整合到最新main6c893df，保留主线Mac原生安全／耐久性／打包支持，不纳入未跟踪实验原件目录。

独立整合树Linux单元820通过、恢复／诊断／审核专项109通过、真实Electron smoke六脚本通过（`.test-output/ci/smoke.log`）；真实Pi诊断旅程`/var/tmp/nozeli-pi-debug-activation-live-cU2X5I/report.json` ok=true。首候选e683fb7 Mac工作流42943350011实际darwin arm64编译／组装／签名深校验／zip解压自检已过；新增专项72通过／11失败、零跳过，失败全部为managed-review-discussion夹具初始化受runner全局Git过滤配置影响而FILTER_UNSUPPORTED，未运行后续实包交互。该失败保留，不宣称Mac包验收通过。修正仅为此测试步骤独立HOME／GIT_CONFIG_GLOBAL及GIT_CONFIG_NOSYSTEM，沿用主线Mac原生安全测试隔离惯例，不更改产品过滤器拒绝语义、不断言通过或跳过测试，须以新提交完整CI与实包旅程为最终资格。

候选1e8e1bb Mac工作流42944224985全过：原生包自检、新恢复／审核专项、真实解压.app阅读／保存／正常关闭冷恢复与随包Pi多Task旅程成功，Provider错误为空。独立本地完整Linux集成为1923通过／1失败／4跳过，失败是`html-candidate-transaction`注入原事务提交拒绝后，onTool新增故障证据的后续mutate碰到已封存存储，返回PROJECT_UNAVAILABLE覆盖原INJECTED_PROJECT_COMMIT。已修正为原异常携带安全证据后，仅在存储可写时尽力持久诊断投影；投影失败记录有界诊断、绝不替换原异常，不抑制或重试原事务，原回滚／未知效果围栏不变。原事务／控制器／恢复／维修四文件46项通过，新增精确原异常对象不被覆盖与commitUnknown零追加写入回归；最终需新提交双平台完整CI及包验收，不复用此候选归档。
