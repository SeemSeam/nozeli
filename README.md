# Nozeli

**人与 Agent 并肩工作，不必守着进度等待。**

Nozeli 是一个开源的 AI 协作阅读与写作工作台。把材料、批注、对话和 Agent 工作放在同一工作面：你继续阅读、思考和创作，Agent 在后台推进；需要你参与时，再带着上下文回来。

## 为什么是 Nozeli

- **从材料出发，自然地协作。** 选中一段文字，留下备注、提出问题或发起修改，不必反复复制上下文、切换问答与任务模式。
- **让 Agent 的工作更容易理解。** 在同一处查看回答、执行过程、文件改动与版本差异；知道改了什么，再决定采用还是丢弃。
- **后台推进，不占住你的工作节奏。** 阅读与后台任务并行，结果进入待阅读项；你决定何时查看、补充或继续，而不是持续盯着聊天窗口。
- **把注意力留给内容。** 浮动标签、可收起的工作区和独立草稿，让你在长回答与原文之间保持自己的阅读位置。
- **过程可追溯，结果可取舍。** 材料与选区绑定版本，未发送草稿保留；异常后显式恢复，不自动重放任务，也不静默覆盖文件。

“无需等待”意味着人的工作不被后台任务阻塞，不代表模型零延迟、任务自动成功或无需人工判断。

## 能做什么

阅读 PDF 与图片，编辑 Markdown、TeX、代码及受支持的 Office 文件；在原文旁批注、讨论，交给随包私有 OMP 执行内容工作，并审阅真实文件结果。没有模型账号，也可以继续本地阅读、编辑与批注。

## 快速开始

当前为 **0.1alpha**，仅 Linux x64 / Wayland 已实测；Windows、macOS 尚未提供已验证版本。便携包解压后运行 `AppRun` 或 `nozeli`，无需安装 Node/npm 或系统 OMP。AI 需自行配置模型账号，Linux 受管执行需要可用的 bubblewrap。

从源码构建需要 Node.js 22.22.2+、npm、Git、Bun 1.3.14 及原生编译工具：

```sh
cd apps/desktop
npm ci
npm run build:pptist
npm run build:omp
npm start
```

生成便携包（已提交源码的干净工作区）：

```sh
node tools/package-portable.mjs /绝对路径/全新输出目录
```

开发和测试见[桌面说明](apps/desktop/README.md)。TeX 编译、TexLab、SyncTeX 与 JS/TS 语言服务有各自的可选工具前提。配置与会话位于 `~/.Nozeli`，项目批注位于项目内 `.nozeli`；账号、用户文件和运行数据不纳入源码。

## 开源许可

Nozeli 自有代码采用 **[AGPL-3.0-only](LICENSE)**，允许使用、研究、修改与商业使用；分发及适用的网络使用需遵守相应源码提供等条款。第三方组件保留各自许可证与版权声明，见[来源与许可](apps/desktop/SOURCES.md)。源码开放不等于全部第三方二进制分发义务已经完成，当前 Alpha 发行材料仍在完善。

## Thanks

感谢以下开源项目及其贡献者（含直接使用、内嵌组件和开发工具）：

- 桌面与AI运行时：[Electron](https://github.com/electron/electron)、[Chromium](https://www.chromium.org/)、[oh-my-pi](https://github.com/can1357/oh-my-pi)、[Bun](https://github.com/oven-sh/bun)。
- 阅读与编辑：[PDF.js](https://github.com/mozilla/pdf.js)、[Monaco Editor](https://github.com/microsoft/monaco-editor)、[CodeMirror](https://codemirror.net/)、[Lezer](https://lezer.codemirror.net/)、[Shiki](https://github.com/shikijs/shiki)、[KaTeX](https://github.com/KaTeX/KaTeX)。
- Office：[SuperDoc](https://github.com/superdoc-dev/superdoc)、[PPTist](https://github.com/pipipi-pikachu/PPTist)、[Fortune Sheet](https://github.com/ruilisi/fortune-sheet)、[ExcelJS](https://github.com/exceljs/exceljs)、[JSZip](https://github.com/Stuk/jszip)、[word-extractor](https://github.com/morungos/node-word-extractor)。
- 界面与终端：[React](https://github.com/facebook/react)、[xterm.js](https://github.com/xtermjs/xterm.js)、[node-pty](https://github.com/microsoft/node-pty)、[Lucide](https://github.com/lucide-icons/lucide)、[Feather](https://github.com/feathericons/feather)、[IconPark](https://github.com/bytedance/IconPark)、[Font Awesome](https://github.com/FortAwesome/Font-Awesome)。
- 文件与版本：[Git](https://git-scm.com/)、[dugite](https://github.com/desktop/dugite)、[dugite-native](https://github.com/desktop/dugite-native)、[Git LFS](https://github.com/git-lfs/git-lfs)、[Git Credential Manager](https://github.com/git-ecosystem/git-credential-manager)、[xmldom](https://github.com/xmldom/xmldom)、[image-size](https://github.com/image-size/image-size)、[YAML](https://github.com/eemeli/yaml)、[ws](https://github.com/websockets/ws)。
- 代码智能与开发工具：[TypeScript](https://github.com/microsoft/TypeScript)、[TypeScript Language Server](https://github.com/typescript-language-server/typescript-language-server)、[VS Code Language Server Node](https://github.com/microsoft/vscode-languageserver-node)、[Prettier](https://github.com/prettier/prettier)、[esbuild](https://github.com/evanw/esbuild)、[electron/rebuild](https://github.com/electron/rebuild)、[Puppeteer](https://github.com/puppeteer/puppeteer)。
- 可选系统工具：[bubblewrap](https://github.com/containers/bubblewrap)、[TeX Live](https://tug.org/texlive/)、[latexmk](https://ctan.org/pkg/latexmk)、[Tectonic](https://github.com/tectonic-typesetting/tectonic)、[TexLab](https://github.com/latex-lsp/texlab)、[SyncTeX](https://github.com/jlaurens/synctex)。

各第三方组件保留原许可证；本节为主要项目致谢，不替代其版权及许可声明。

