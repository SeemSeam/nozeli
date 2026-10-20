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
- 文件树右键“隐藏”只隐藏当前项目的显示，不删除文件、不修改.gitignore、不取消已打开编辑，也不阻止Agent访问。“…”→“显示已隐藏”可查看并恢复隐藏项。隐藏与查看偏好按项目持久化，大目录在遍历和可见数量预算前排除。
- 检查入口：`node --test tests/provider-settings.test.mjs tests/file-tree-ops.test.mjs`；可见Electron为`tests/desktop-settings.test.mjs`和`tests/desktop-tree-visibility.test.mjs`。真实OAuth和其他平台不据此视为通过。

外观偏好通过宿主`appearance.json`原子保存，不依赖每次启动可能变化的本地HTTP origin；实际安装版完整退出/重开验证主题和项目隐藏均保留，隐藏原文件字节不变。“显示已隐藏”与恢复可实际点击。Linux/Wayland验收，未调用真实模型或OAuth。

## 打包

在干净Git工作区、构建输入准备完毕后：

```sh
node tools/package-portable.mjs /absolute/new/output
```

生成Linux x64便携包、源码归档、说明和SHA-256。不修改current安装。`tools/install-local.mjs`为Linux本机用户级安装工具，`tools/release-retention.mjs --dry-run`预览旧版本保留策略；当前/回退/运行中版本受保护。

## 数据安全与可选能力

应用配置/会话位于`~/.Nozeli`，批注/版本事实位于各项目`.nozeli`。保存使用摘要校验与原子替换；冲突保留原件与草稿，不静默覆盖。普通文档保存不自动提交用户Git；仅显式接受Worker结果触发集成。

只保存本地备注不启动模型。AI需要账号、网络和可用bubblewrap隔离；缺失时拒绝受管启动，不影响基础阅读。TeX/TexLab/SyncTeX为外部可选工具，JS/TS语言服务需要系统Node。构建成功不代替跨平台或模型验收，不代表公开再分发许可已完成。
