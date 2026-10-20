# Nozeli desktop 0.1alpha

Electron桌面阅读、批注、编辑与受管OMP协作产品。平台、构建、Release和许可边界以[仓库README](../../README.md)为准。

## 构建

开发前提：Node 22+、npm、Git、Bun 1.3.14、Linux x64原生编译工具及Electron系统依赖。首次构建：

```sh
npm ci
npm run build:pptist
npm run build:omp
npm run build:renderer
```

`npm ci`为Electron重建node-pty，不使用全局node-gyp或系统OMP。上游构建输入固定版本/哈希，不需要旧仓库或本机绝对路径。依赖、构建、运行profile不进入Git。

## 开发与测试

`npm start`启动本地应用。`npm run test:host`、`npm run test:renderer`、`npm run test:electron`分别运行宿主、渲染逻辑与实际Electron回归。其他分组见package.json。tests/fixtures为合成或带来源说明的固定样本；普通测试不发起付费模型请求。live验收需显式启用和自有账号，不自动执行。

## 标签讨论

标签按轮保留问题与同一请求下的全部助手正文；流式输出只更新对应消息，不重建卡片、覆盖旧轮或重置正在阅读的滚动和原文分页。持久化仅保存请求/消息身份，正文来自统一会话索引；冷开可按请求查回历史消息。正文超出缓存预算时保留分段读取入口，不静默截断。各文档表面共用此行为。

标签讨论正文显示用户原问题，解释请求使用简短标题；文件、位置、引文和冻结版本放在默认收起的“选区来源”。模型首次收到自然语言组织的“问题、来源、原文、前后文与注意事项”，不再把schema/内部身份/整包JSON拼入正文。同一原生会话成功处理过且来源未变的续聊只给问题与简短来源；重启、换线程、观察到压缩、材料或备注变化时重新完整提供。每轮完整材料仍按摘要保存为只读原件，续聊显式提示上下文不足时按原件读取，不假定模型一定记住；后台派工始终带完整材料。用户自己输入的JSON或同名标题不被清理。旧日志不改写。

回归：`node --test tests/tag-session-identity.test.mjs tests/tag-input-presentation.test.mjs`；实际Electron消费：`node tests/desktop-tag-history.test.mjs`、`node tests/session-reading.test.mjs`。涵盖三轮、多段回复、流更新、滚动、长回复分页和重载；使用合成会话，不冒充真实Provider回复。

自然语言交付回归：`node --test tests/tag-material-delivery.test.mjs tests/tag-input-presentation.test.mjs`，包含真实Controller分派边界、首次/续聊、版本与会话变化、处理中压缩失效、完整材料读取、区域坐标与截图语义。不会为追求简短省略来源冲突或安全提示。

本轮host91/91、renderer79/79、标签/输入专项44/44、原生Collab70/70通过；可见Wayland完整Electron门（阅读/重启、配置与只读历史、三轮标签）及会话简洁问题/折叠来源消费通过。Word/PPT/图片/PDF实际回归通过。未重新调用真实付费Provider，不能据此声称新模型回复已实测；旧无界面启动超时保留，改用实际可见Wayland入口验证。历史和截图留在忽略的测试输出，不进入产品数据。

## 统一设置与项目文件隐藏

- 左下角“设置”统一管理私有OMP源、前台/主控/Worker默认模型、外观与通用选项。默认模型只影响新会话，已有会话不被静默切换；被默认配置或历史会话引用的源不能直接移除。密钥仅在宿主私有配置保存，不由读取API回传。
- 账号登录先从随包OMP的`auth-broker list --json`目录选择源，再显式启动`omp login <provider>`；不手填Provider ID、不先开启数字选择器。宿主重新校验所选源，未知/空源不启动登录进程。界面显示当前源及授权状态，验证码/回调输入和取消沿用官方流程；自定义API源保持单独入口。真实列表及选择启用已实测，完整远程OAuth授权需用户本人完成，不冒称已验。
- 界面主题支持浅色/深色/跟随系统；界面字体与12–20px字号不改变正文、对话、标签和终端独立排版。Zen快捷键为Ctrl/Cmd+Shift+F11，Escape优先关闭对话框再退出Zen。
- “切换终端”和“Zen专注模式”为设置导航最顶层的两个独立动作，直接点击执行，不在通用/外观内重复放置。底部预留从52px收为8px（保留系统安全区）。终端顶部可直接“返回阅读”，切换不取消任务、不清空草稿。窄屏文件栏开关置于左侧中部，避免遮住设置。
- 文件树右键“隐藏”只隐藏当前项目的显示，不删除文件、不修改.gitignore、不取消已打开编辑，也不阻止Agent访问。“…”→“显示已隐藏”可查看并恢复隐藏项。隐藏与查看偏好按项目持久化，大目录在遍历和可见数量预算前排除。
- 检查入口：`node --test tests/provider-settings.test.mjs tests/file-tree-ops.test.mjs`；可见Electron为`tests/desktop-settings.test.mjs`和`tests/desktop-tree-visibility.test.mjs`。真实OAuth和其他平台不据此视为通过。

外观偏好通过宿主`appearance.json`原子保存，不依赖每次启动可能变化的本地HTTP origin；实际安装版完整退出/重开验证主题和项目隐藏均保留，隐藏原文件字节不变。“显示已隐藏”与恢复可实际点击。Linux/Wayland验收，未调用真实模型或OAuth。

Linux原生Wayland的项目/引用目录框使用不绑定父窗口的Electron重载，避免父窗口xdg-foreign导出阻塞；X11/Windows/macOS保留父窗口关联。已在未设置`NOZELI_TEST_PICK`的真实原生选择中打开`nozeli_git`项目；系统选择动作非自动化，取消路径未取得独立原生UI签收，不以预设路径测试冒充。24项设置检查、双尺寸终端进入/返回、Zen按钮/快捷键、8px底部与草稿保留通过；旧沉浸套件仍在字号菜单等待失败，不作全套通过声明。

选区工具条不因编辑器内部input/textarea的原生滚动而关闭；正文视口滚动、Esc、文件/布局切换仍收起。真实Monaco左键拖选→内部输入滚动→讨论点击保留精确offset/quote回归通过；安装候选真实拖选→“解释”点击→私有OMP回复、单job、原文不变通过（本机`~/.local/state/nozeli-selection-live-1nPD2S/`）。Markdown Unicode选区及完整进程重启回归通过。两次解释烟测在未形成选区前失败，原件保留，不计模型成功或修改产品以放宽空选区。

## 当前安装的真实 Agent 工作流验收

2026-10-20，`settings-hidden-restart-fixed`实际Electron与私有OMP/GPT6.1完整66项通过：前台真实CAS保存与选区解释、主控派工、两个独立Worker工作树、GUI/原生终端原线程续作、冻结Diff、接受/丢弃、冷开零请求/零任务重放；真实180秒计时文件任务、renderer/native/main进程终止及显式原线程恢复均检查。原始项目暂存/未暂存文件、草稿、配置元数据保持，正常退出，自有账号副本清理。50次真实HTTP准入，观察input/output115754（非账单）。本机证据`~/.local/state/nozeli-agent-workflow-settings-b/result.json`；Linux/Wayland单轮，不外推其他Provider/OAuth/跨平台。

首轮A前台两条真实调用成功，但后台输入前焦点落入设置登录输入框而超时，整轮保留fail；没有证明生产派工失败或确定其触发根因。验收脚本增加输入前真实composer焦点与输入后精确文本断言，未改变生产代码或弱化任务结果检查；全新工程B完整通过。原始A证据保留，不自动重放原输入。

## 打包

在干净Git工作区、构建输入准备完毕后：

```sh
node tools/package-portable.mjs /absolute/new/output
```

生成Linux x64便携包、源码归档、说明和SHA-256。不修改current安装。`tools/install-local.mjs`为Linux本机用户级安装工具，`tools/release-retention.mjs --dry-run`预览旧版本保留策略；当前/回退/运行中版本受保护。

## 数据安全与可选能力

应用配置/会话位于`~/.Nozeli`，批注/版本事实位于各项目`.nozeli`。保存使用摘要校验与原子替换；冲突保留原件与草稿，不静默覆盖。普通文档保存不自动提交用户Git；仅显式接受Worker结果触发集成。

只保存本地备注不启动模型。AI需要账号、网络和可用bubblewrap隔离；缺失时拒绝受管启动，不影响基础阅读。TeX/TexLab/SyncTeX为外部可选工具，JS/TS语言服务需要系统Node。构建成功不代替跨平台或模型验收，不代表公开再分发许可已完成。
