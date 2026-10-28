
# Nozeli

<p align="center">
  <img src="apps/desktop/assets/brand/nozeli-paired-tabs-logo.png" alt="Nozeli 标识" width="160">
</p>

**Agent 协作编辑工作台**

协调你与 Agent 的协作节奏，让你看懂结果、参与修改，持续掌握项目进展。

主要特点：
- 以对话为起点、以结果报告为中心，形成任务闭环。
- 通过立体文档交互与朱批锚定视觉位置，让 Agent 跟得上你的视线。
- 前台—调度—专家多 Agent 协作，流畅推进任务。
- 集成多种编辑器，有时自己动手比开口描述更快。

## 快速链接

[开始使用](#开始使用) · [开发说明](apps/desktop/README.md) · [项目计划](docs/plantree/README.md)

![Nozeli 工作面：在文档选区就地发起讨论](apps/desktop/assets/nozeli-workspace.png)

*文档、选区与讨论在同一工作面。上图展示 PPT 选区讨论入口。*

## 为什么使用 Nozeli

### Agent 效率高，你也要接得住

Agent 交付得快，不代表人已经理解。Nozeli 希望让你看清成果与依据，审核、提问、提出修改，再由 Agent 继续推进，而不是逐渐失去对项目的掌握。

任务会形成基于 HTML 和 Archify 结构图的报告。你可以把关输入、审核结果，并在审核通过后结束任务；在协作中持续承担自己的责任，也更清楚地掌握项目。

![乒乓球比喻：从追不上 Agent，到接住成果并持续迭代](apps/desktop/assets/65be651bec7f2690814611da95eebb62.png)

### Agent 长时执行任务，你也不必停

前台—中枢—专家多 Agent 模式中，前台快速响应与分流，后台专家各自推进整块任务，中枢负责派发与收尾。你可以继续阅读、编辑、交流并发布新任务；成果准备好后，再按自己的节奏审阅，不必守着进度条。

![等待体验对比与侧边多 Agent 分工示意](apps/desktop/assets/6dc889c5e2b608d3d29d3e51604e357d.png)

### 有时指挥不如动手

人能同时直接编辑、批注，Agent 也能协助修改。不必反复把原文贴进聊天框，再把回复搬回文档；围绕同一份材料查看修改、反馈并继续修订，并显示作者。

![人与 Agent 围绕文档共同编辑和修订](apps/desktop/assets/79cad55a437932fb4d2e6fdb0c3f4308.png)

### 从“这里”入手，解决人与 Agent 的视觉对齐

**Agent anywhere。** 与 Agent 在项目中立体交互，而非限制在一个侧边栏对话框。右键、框选和涂鸦都是对话锚点，对话会保存在对应位置。不必再反复解释“哪个文件、第几页、哪一段、图上哪里”。

![从描述位置，到使用选区、图片与画面锚点交流](apps/desktop/assets/aed6a7b4c01edefc5db4060870ef9bd9.png)

总之，让你游刃有余地掌控自己的项目，而不是跟着 Agent 跑。

## 开始使用

1. 打开本地项目目录和需要阅读、编辑的材料。
2. 在设置中配置 AI 源与角色默认模型；AI 使用随应用提供的私有 OMP。
3. 直接交流，或从选区发起讨论；普通文件操作与当前用户命令可直接执行，持续后台工作沿原任务交接。敏感／管理员执行从同项目待办明确授权，系统提权仍由真实 OS 认证完成；角色分工不会把已授权能力变成“没有权限”。
4. 从待办查看问题与成果，继续修改，或明确接受／丢弃并结束。

## 当前状态

- 面向 Windows、macOS、Linux；当前验证以 **Linux／Wayland** 为主，其他平台尚未通过。
- 已有阅读、批注、编辑、真实文件与后台协作工作流；具体格式、版本和能力边界见[实施状态](docs/plantree/plans/001-reader-product/implementation-status.md)。
- 公开分发前仍需补齐第三方许可证及对应源码义务；当前本机 Alpha 包不作公开发行。
- 2026-10-28：可信执行版本 `trusted-execution-2026-10-28T09-15-40-358Z` 已安装到本机桌面入口；729个产品文件冻结校验一致，上一版本 `native-document-review-20261028` 保留可回退。授权、待办、原生会话、生命周期、候选合入与安装保留规则最终303/303通过。捆绑Electron/私有OMP及真实 `paratera/gpt-6.1-sol` 在隔离项目/profile完成前台和Worker待办批准后原线程执行、各角色原生命令与管理员拒绝零执行，四项通过并正常退出0；证据 `~/.cache/nozeli-smokes/switch-tmp/nozeli-trusted-permissions-rdOI7I/report.json`。本轮未在个人机器实际执行root命令，Windows/macOS认证未实测；未重放用户项目输入，未提交。
- 审校/收尾修复已安装并重启为 `review-closure-repair-2026-10-28T10-33-02-889Z`：真实项目恢复 `ready=true`、无连接错误、无运行任务，jobs仍9条未重放；旧进程正常退出0。README保留当前正文与原候选，旧限制转为可操作策略待办，不静默合入后续已修改文件。候选Markdown协同六项、正式宿主策略到真实Git四项、审校/恢复105项及会话接手36项通过。重启原件 `~/.cache/nozeli-smokes/review-closure-repair-2026-10-28T10-33-02-889Z/restart.json`。

## 进一步了解

- [产品方向与路线](docs/plantree/plans/001-reader-product/README.md)
- [阅读与协作原则](docs/plantree/plans/001-reader-product/topics/reading-collaboration.md) · [材料交接规则](docs/plantree/plans/001-reader-product/topics/materials-and-handoff.md)
- [桌面开发与验证](apps/desktop/README.md) · [私有 OMP 集成](integrations/omp/README.md)
- [旧版开发与打包记录](docs/plantree/plans/001-reader-product/history/readme-before-product-introduction-2026-10-26.md)


## 开源许可

Nozeli 自有代码采用 **[AGPL-3.0-only](LICENSE)**。第三方组件保留原许可证，见[来源与许可](apps/desktop/SOURCES.md)。源码开放不代表全部第三方二进制分发义务已完成，Alpha 发行材料仍在完善。

## Thanks

感谢这些开源项目及其贡献者：

- 桌面与运行时：[Electron](https://github.com/electron/electron)、[Chromium](https://www.chromium.org/)、[oh-my-pi](https://github.com/can1357/oh-my-pi)、[Bun](https://github.com/oven-sh/bun)。
- 阅读与编辑：[PDF.js](https://github.com/mozilla/pdf.js)、[Monaco](https://github.com/microsoft/monaco-editor)、[CodeMirror](https://codemirror.net/)、[Lezer](https://lezer.codemirror.net/)、[Shiki](https://github.com/shikijs/shiki)、[KaTeX](https://github.com/KaTeX/KaTeX)。
- Office：[SuperDoc](https://github.com/superdoc-dev/superdoc)、[PPTist](https://github.com/pipipi-pikachu/PPTist)、[Fortune Sheet](https://github.com/ruilisi/fortune-sheet)、[ExcelJS](https://github.com/exceljs/exceljs)、[JSZip](https://github.com/Stuk/jszip)、[word-extractor](https://github.com/morungos/node-word-extractor)。
- 界面与终端：[React](https://github.com/facebook/react)、[xterm.js](https://github.com/xtermjs/xterm.js)、[node-pty](https://github.com/microsoft/node-pty)、[Lucide](https://github.com/lucide-icons/lucide)、[Feather](https://github.com/feathericons/feather)、[IconPark](https://github.com/bytedance/IconPark)、[Font Awesome](https://github.com/FortAwesome/Font-Awesome)。
- 文件与工具：[Git](https://git-scm.com/)、[dugite](https://github.com/desktop/dugite)、[dugite-native](https://github.com/desktop/dugite-native)、[Git LFS](https://github.com/git-lfs/git-lfs)、[Git Credential Manager](https://github.com/git-ecosystem/git-credential-manager)、[xmldom](https://github.com/xmldom/xmldom)、[image-size](https://github.com/image-size/image-size)、[YAML](https://github.com/eemeli/yaml)、[ws](https://github.com/websockets/ws)。
- 开发：[TypeScript](https://github.com/microsoft/TypeScript)、[TypeScript Language Server](https://github.com/typescript-language-server/typescript-language-server)、[VS Code Language Server Node](https://github.com/microsoft/vscode-languageserver-node)、[Prettier](https://github.com/prettier/prettier)、[esbuild](https://github.com/evanw/esbuild)、[electron/rebuild](https://github.com/electron/rebuild)、[Puppeteer](https://github.com/puppeteer/puppeteer)。
- 可选工具：[bubblewrap](https://github.com/containers/bubblewrap)、[TeX Live](https://tug.org/texlive/)、[latexmk](https://ctan.org/pkg/latexmk)、[Tectonic](https://github.com/tectonic-typesetting/tectonic)、[TexLab](https://github.com/latex-lsp/texlab)、[SyncTeX](https://github.com/jlaurens/synctex)。
