# Nozeli

**项目属于人，Agent 出现在需要它的地方。**

Nozeli 是一个开源的 AI 协作阅读与创作工作台。不是把整个项目交给一条聊天，再等它给出答案；而是让人始终留在材料、问题与决策之中，让 Agent 在身边推进工作。

> 不是 All in Agent，而是 Agent anywhere in your project。

## 人不应该成为等待的人

你在读论文、梳理想法或修改文件时，Agent 可以在后台开展工作。结果回到待阅读项，你选择什么时候接住它，而不必守着进度条。这里的“不等待”是让人的工作与后台执行并行，不是承诺模型零延迟或任务自动成功。

## 接住成果，而不只是接收答案

AI 做得越多，人越需要理解自己的项目。Nozeli把原文、选区讨论、执行过程和文件差异放在同一工作面。你可以回看依据、比较改动、提出追问，再决定采用还是丢弃。Agent 的输出应当成为下一步思考的起点，而不是一个只能点击确认的黑盒。

## 从一个词，到一项工作

介入不必只有“开始”和“批准”两种粒度。选中一句话问清概念，在段落旁留下判断，直接修改文件，或把明确的一部分交给后台；工作进行中也能补充、继续讨论和审阅结果。不必为了用 AI，先把自己的工作改造成它的流程。

## 前台保持交流，后台推进执行

- **前台**：围绕当前材料与你讨论，也能直接完成范围明确的内容修改。
- **编排**：组织后台任务、处理工作关系，不代替 Worker 写业务文件。
- **Worker**：在独立工作树里执行，提交可查看的结果与真实文件改动。

不同工作不必挤进一条会话。前台与后台各自承担职责，让人保持自己的阅读和创作节奏；最终判断仍由人作出。

## 一个连续的工作面

阅读 PDF 与图片，编辑 Markdown、TeX、代码及受支持的 Office 文件；在原文旁批注、提问、解释和续聊。材料绑定来源与版本，未发送草稿保留；采用成果前检查差异，异常后显式恢复，不自动重放失败任务，也不静默覆盖文件。没有模型账号，本地阅读、编辑与批注仍可使用。

## 开始使用

当前为 **0.1alpha**，仅 Linux x64 / Wayland 已实测；Windows、macOS尚未提供已验证版本。便携包解压后运行 `AppRun` 或 `nozeli`，无需用户安装Node/npm或系统OMP。AI需自行配置模型账号，Linux受管执行需要可用的bubblewrap。

开发构建需要Node.js 22.22.2+、npm、Git、Bun 1.3.14及原生编译工具：

```sh
cd apps/desktop
npm ci
npm run build:pptist
npm run build:omp
npm start
```

生成便携包（已提交源码的干净工作区，在`apps/desktop`执行）：

```sh
node tools/package-portable.mjs /绝对路径/全新输出目录
```

开发与测试见[桌面说明](apps/desktop/README.md)。配置和会话位于`~/.Nozeli`，项目批注位于项目内`.nozeli`；运行数据与账号不进入源码。TeX编译、TexLab、SyncTeX和JS/TS语言服务有各自的可选工具前提。

## 开源许可

Nozeli自有代码采用 **[AGPL-3.0-only](LICENSE)**。第三方组件保留原许可证，见[来源与许可](apps/desktop/SOURCES.md)。源码开放不代表全部第三方二进制分发义务已完成，Alpha发行材料仍在完善。

## Thanks

感谢这些开源项目及其贡献者：

- 桌面与运行时：[Electron](https://github.com/electron/electron)、[Chromium](https://www.chromium.org/)、[oh-my-pi](https://github.com/can1357/oh-my-pi)、[Bun](https://github.com/oven-sh/bun)。
- 阅读与编辑：[PDF.js](https://github.com/mozilla/pdf.js)、[Monaco](https://github.com/microsoft/monaco-editor)、[CodeMirror](https://codemirror.net/)、[Lezer](https://lezer.codemirror.net/)、[Shiki](https://github.com/shikijs/shiki)、[KaTeX](https://github.com/KaTeX/KaTeX)。
- Office：[SuperDoc](https://github.com/superdoc-dev/superdoc)、[PPTist](https://github.com/pipipi-pikachu/PPTist)、[Fortune Sheet](https://github.com/ruilisi/fortune-sheet)、[ExcelJS](https://github.com/exceljs/exceljs)、[JSZip](https://github.com/Stuk/jszip)、[word-extractor](https://github.com/morungos/node-word-extractor)。
- 界面与终端：[React](https://github.com/facebook/react)、[xterm.js](https://github.com/xtermjs/xterm.js)、[node-pty](https://github.com/microsoft/node-pty)、[Lucide](https://github.com/lucide-icons/lucide)、[Feather](https://github.com/feathericons/feather)、[IconPark](https://github.com/bytedance/IconPark)、[Font Awesome](https://github.com/FortAwesome/Font-Awesome)。
- 文件与工具：[Git](https://git-scm.com/)、[dugite](https://github.com/desktop/dugite)、[dugite-native](https://github.com/desktop/dugite-native)、[Git LFS](https://github.com/git-lfs/git-lfs)、[Git Credential Manager](https://github.com/git-ecosystem/git-credential-manager)、[xmldom](https://github.com/xmldom/xmldom)、[image-size](https://github.com/image-size/image-size)、[YAML](https://github.com/eemeli/yaml)、[ws](https://github.com/websockets/ws)。
- 开发：[TypeScript](https://github.com/microsoft/TypeScript)、[TypeScript Language Server](https://github.com/typescript-language-server/typescript-language-server)、[VS Code Language Server Node](https://github.com/microsoft/vscode-languageserver-node)、[Prettier](https://github.com/prettier/prettier)、[esbuild](https://github.com/evanw/esbuild)、[electron/rebuild](https://github.com/electron/rebuild)、[Puppeteer](https://github.com/puppeteer/puppeteer)。
- 可选工具：[bubblewrap](https://github.com/containers/bubblewrap)、[TeX Live](https://tug.org/texlive/)、[latexmk](https://ctan.org/pkg/latexmk)、[Tectonic](https://github.com/tectonic-typesetting/tectonic)、[TexLab](https://github.com/latex-lsp/texlab)、[SyncTeX](https://github.com/jlaurens/synctex)。
