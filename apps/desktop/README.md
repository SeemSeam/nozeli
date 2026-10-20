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

## 统一设置与项目文件隐藏

- 左下角“设置”统一管理私有OMP源、前台/主控/Worker默认模型、外观与通用选项。默认模型只影响新会话，已有会话不被静默切换；被默认配置或历史会话引用的源不能直接移除。密钥仅在宿主私有配置保存，不由读取API回传。
- 界面主题支持浅色/深色/跟随系统；界面字体与12–20px字号不改变正文、对话、标签和终端独立排版。Zen快捷键为Ctrl/Cmd+Shift+F11，Escape优先关闭对话框再退出Zen。
- “切换终端”和“Zen专注模式”为设置导航最顶层的两个独立动作，直接点击执行，不在通用/外观内重复放置。底部预留从52px收为8px（保留系统安全区）。终端顶部可直接“返回阅读”，切换不取消任务、不清空草稿。窄屏文件栏开关置于左侧中部，避免遮住设置。
- 文件树右键“隐藏”只隐藏当前项目的显示，不删除文件、不修改.gitignore、不取消已打开编辑，也不阻止Agent访问。“…”→“显示已隐藏”可查看并恢复隐藏项。隐藏与查看偏好按项目持久化，大目录在遍历和可见数量预算前排除。
- 检查入口：`node --test tests/provider-settings.test.mjs tests/file-tree-ops.test.mjs`；可见Electron为`tests/desktop-settings.test.mjs`和`tests/desktop-tree-visibility.test.mjs`。真实OAuth和其他平台不据此视为通过。

外观偏好通过宿主`appearance.json`原子保存，不依赖每次启动可能变化的本地HTTP origin；实际安装版完整退出/重开验证主题和项目隐藏均保留，隐藏原文件字节不变。“显示已隐藏”与恢复可实际点击。Linux/Wayland验收，未调用真实模型或OAuth。

Linux原生Wayland的项目/引用目录框使用不绑定父窗口的Electron重载，避免父窗口xdg-foreign导出阻塞；X11/Windows/macOS保留父窗口关联。已在未设置`NOZELI_TEST_PICK`的真实原生选择中打开`nozeli_git`项目；系统选择动作非自动化，取消路径未取得独立原生UI签收，不以预设路径测试冒充。24项设置检查、双尺寸终端进入/返回、Zen按钮/快捷键、8px底部与草稿保留通过；旧沉浸套件仍在字号菜单等待失败，不作全套通过声明。

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
