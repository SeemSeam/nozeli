# Sources and licenses


> **Distribution status (2026-10-29).** Nozeli `v0.1.0-alpha.1` is published as a public prerelease at https://github.com/SeemSeam/nozeli/releases/tag/v0.1.0-alpha.1 at the repository owner's explicit request. Third-party corresponding-source and binary redistribution review is still incomplete; publication is not a compliance certification, and no disclaimer or notice in the shipped archive discharges those obligations. Statements below that authorize only local installation/testing (for example the Product-managed Git section) remain accurate about what has actually been signed off. Machine-readable pinned versions, digests, evidence paths and per-obligation status live in [compliance-inventory.json](compliance-inventory.json), validated by `tools/check-repository.mjs` (default: metadata check; `--public`: fails while any obligation lacks a complete human sign-off record). Neither this file, the inventory nor that script is a legal audit.

## Pi session runtime cutover (2026-10-30, integration in progress)

The product session runtime is migrating from the bundled private OMP TUI to the Pi coding-agent runtime. `integrations/pi` vendors the minimal pi-gui runtime closure from the read-only upstream reference repository at commit `eddfb19367b3ec4e59314eddfa83ed5aa6989f03` (MIT; notice retained at `integrations/pi/vendor/pi-gui/LICENSE`), plus local compatibility files under the same tree. The SDK is pinned to `@earendil-works/pi-coding-agent` 1.4.0; no compatibility with the OMP wire API is presumed. Runtime ownership: a standalone Node owner process (default entry `integrations/pi/src/owner.mjs`) owns native Pi sessions, model calls and tool lifecycle under host admission; Nozeli keeps sole authority over Work, versions, reports, review, task queue, process budget and materials.

The product GUI no longer mounts an embedded OMP terminal. Durable Pi journal rows keep their original identities; streaming messages are transient projections. Model/thinking selection is a GUI control, not a simulated TUI. `@xterm/addon-fit` is removed and `@xterm/xterm` is development-only for historical adapter checks; `@xterm/headless` remains for retained legacy projections. Original historical sessions are not renamed or replayed as Pi sessions.

Status: isolated Linux integration candidate on `integration/pi-gui`; not installed or publicly distributed. `integrations/pi/upstream-manifest.json` records 46 original/patched file SHA-256 pairs, `patches/` records the three exact modifications, and `package-lock.json` pins the SDK dependency closure. Pi SDK's fixed v1.4.0 MIT notice is retained at `integrations/pi/licenses/pi-1.4.0.LICENSE` (source: https://raw.githubusercontent.com/earendil-works/pi/v1.4.0/LICENSE). The full transitive binary/notice/corresponding-source audit remains pending; these records are not redistribution signoff.

## Static HTML reports and offline diagrams (2026-10-23)

HTML/CSS/JavaScript syntax analysis uses the existing MIT Lezer parsers, now explicit production dependencies: `@lezer/html` 1.3.13, `@lezer/css` 1.3.8 and `@lezer/javascript` 1.5.5. Host SVG validation reuses `@xmldom/xmldom` 0.9.12 (MIT); raster bounds reuse `image-size` 2.0.2 (MIT). These parsers do not grant HTML any application or filesystem privileges.

The Nozeli-owned static diagram closure under `src/agents/managed/archify-vendor/` is derived from the inspected Archify 2.16.0-dev.0 skill distribution. Its `SOURCES.json` records exact inspected and shipped file hashes plus generator identity. The original MIT copyright holders, tt-a1i and Cocoon AI, are retained in the vendor LICENSE and exported SVG notices. The adaptation removes remote capture, process/filesystem CLI behavior and the interactive viewer runtime; it renders and validates architecture, workflow, sequence, dataflow and lifecycle diagrams offline. Built-in Simple Icons 16.28.0 paths retain CC0 notices; trademark rights are not granted. Runtime generation never loads a personal skill path, CCB, CDN or runtime npm package. This is a product-owned adapted closure, not an assertion of an unverified upstream repository URL.


## Product-managed Git (2026-10-18)

Nozeli ships `dugite` 3.2.3 (MIT, https://github.com/desktop/dugite) as a production dependency, with its platform-specific Git archive unpacked inside the application. Git is a separate executable, not an in-process implementation. The Linux x64 archive is `dugite-native-v2.53.0-4098283-ubuntu-x64.tar.gz` from https://github.com/desktop/dugite-native/releases/tag/v2.53.0-4, SHA-256 `cca76aa31ad9e835e771ee7f55b73934777fbd8d16757a10d307ba06de860901`; the dependency installer verifies its pinned digest. Windows/macOS use the corresponding upstream platform archives, not this Linux binary.

Git 2.53.0 is GPL version 2; retain its COPYING notice in the application assets. Git source: https://github.com/git/git/tree/v2.53.0 ; native distribution build scripts/source provenance: https://github.com/desktop/dugite-native/tree/v2.53.0-4 . Dugite's MIT license is retained in the bundled dependency. This change authorizes local installation/testing, not a public redistribution; any future binary publication must supply complete corresponding sources and applicable notices for Git and the native distribution's included libraries, not assume a URL alone discharges redistribution obligations.

## Shared file icons and context menus (2026-10-09)

File icons reuse the VS Code Codicons font included in `monaco-editor` 0.57.0 (MIT, https://github.com/microsoft/monaco-editor and https://github.com/microsoft/vscode-codicons). No additional icon package or remote font is loaded. Bundled font SHA256: `77f902557231f95c4c71ae517d09a1a842753656f5f665086b3e5ad8095538da`; Monaco license SHA256: `33e4ff1a06ef62ba21788ea162564ee8165269a24a9ce6ef301837447eab0ac6`. The renderer build copies the license as `MONACO-CODICONS-LICENSE`. W/P/T badges are repository CSS; file color labels remain separate.

Fortune Sheet 1.0.4 history updaters memoize results when React replays the same input state, preventing duplicate native undo entries; undo/redo also recalculates derived formula values in the same transaction. These exact, version-guarded patches apply only to the generated renderer copy in `tools/build-renderer.mjs`; pinned vendor bytes remain unchanged. PPTist history initialization/pending snapshots and stale asynchronous clipboard checks are reproduced from source by `tools/build-pptist.mjs`; clipboard reads use the validated Electron host bridge.

Word menus extend SuperDoc 1.47.1 through its public `modules.contextMenu.menuProvider`; table/link panels and rich-text transactions remain native. Spreadsheet content menus use Fortune Sheet 1.0.4 public selection and content APIs, with native grid hit testing; unsupported structure/format actions remain unavailable. PPTist keeps native object/slide commands, with a local theme and keyboard/lifecycle bridge. No compressed vendor source is changed by this package.

This development build does not import `prototypes/`, `.ccb/`, or an absolute developer-machine path at runtime. Versions below match the file-engine prototype that already ran on Linux Electron, except esbuild, which is a local build tool only.

| Package | Version | Role | License |
| --- | --- | --- | --- |
| electron | 44.9.1 | desktop host, dev launch | MIT. The npm package is a shim; the downloaded Chromium binary has its own third-party notices. |
| pdfjs-dist | 6.4.299 | PDF rendering in the sandboxed renderer | Apache-2.0. Bundled cmaps, standard fonts, and wasm assets keep their own notices inside the package. |
| monaco-editor | 0.57.0 | production code-editor surface and E0 isolated comparison harness | MIT; DOMPurify/marked retain their package licenses |
| codemirror | 6.0.2 | text editing | MIT |
| @codemirror/autocomplete | 6.20.4 | offline completion UI and sources | MIT |
| @codemirror/lang-cpp | 6.0.3 | C/C++ highlighting | MIT |
| @codemirror/lang-css | 6.3.1 | CSS highlighting | MIT |
| @codemirror/lang-go | 6.0.1 | Go highlighting | MIT |
| @codemirror/lang-html | 6.4.12 | HTML highlighting | MIT |
| @codemirror/lang-java | 6.0.2 | Java highlighting | MIT |
| @codemirror/lang-javascript | 6.2.5 | JavaScript/JSX/TypeScript/TSX highlighting | MIT |
| @codemirror/lang-json | 6.0.2 | JSON highlighting | MIT |
| @codemirror/lang-markdown | 6.5.2 | markdown highlighting | MIT |
| @codemirror/lang-python | 6.2.1 | Python highlighting | MIT |
| @codemirror/lang-rust | 6.0.2 | Rust highlighting | MIT |
| @codemirror/lang-sql | 6.10.0 | SQL highlighting | MIT |
| @codemirror/merge | 6.12.3 | readonly file/history Diff views, aligned changes and observed external-change mapping | MIT |
| typescript-language-server | 6.0.2 | real TypeScript/JavaScript stdio LSP server; requires Node >=22.22.2 | Apache-2.0 |
| vscode-jsonrpc | 9.0.3 | main-process LSP JSON-RPC transport | MIT |
| typescript | 5.9.3 | TypeScript compiler/runtime used by the LSP server | Apache-2.0 |
| prettier | 3.6.2 | in-memory JavaScript/TypeScript/JSON/CSS/HTML/Markdown formatter | MIT |
| @lezer/python | 1.1.19 | Python parser runtime for CodeMirror | MIT |
| katex | 0.19.1 (lockfile) | safe inline and display math rendering in conversation Markdown | MIT |
| puppeteer-core | 25.11.0 | Linux integration test only | Apache-2.0 declared; this package is not shipped in the app. |
| esbuild | 0.25.10 | bundles the renderer during `npm start` / tests | MIT; not a runtime dependency of the window. |
| @xterm/xterm | 6.0.0 | former renderer PTY terminal UI; unmounted by the Pi session cutover (2026-10-30) and kept only until host-side legacy terminal paths are removed | MIT |
| @xterm/headless | 6.0.0 | bounded host-owned ANSI screen cache for read-only Worker previews; same PTY, no reply/input transport | MIT; upstream 6.0.0 LICENSE retained at src/agents/managed/xterm-headless.LICENSE (npm tarball omits license text) |
| @xterm/addon-fit | 0.11.0 | former terminal resize fitting; unused by the product renderer after the Pi session cutover | MIT |
| ws | 8.22.0 | local native CLI WebSocket transport and notification observation | MIT |
| node-pty | 1.1.0 | host PTY / ConPTY binding | MIT; rebuilt locally for Electron 44.9.1 ABI |
| tar | 7.5.22 | bounded, validated automatic-update archive inspection and worker extraction | BlueOak-1.0.0; bundled package license retained |

`src/domain/material-store.mjs` is the executor-owned immutable byte store. This package calls it and does not modify it. UI direction follows the Nozeli continuous reading surface. It does not copy DemoEngine, simulated replies, or the old dual-PDF toolbar overlap.

Local Office engines are pinned under `vendor/`, as documented below. JSZip 3.10.2 (MIT) is a direct dependency used to validate and patch document packages.


Legacy provider-launch adapters originated in an earlier isolated CLI prototype. The product is migrating its bundled private OMP session runtime to the Pi runtime (see the Pi session runtime cutover section); legacy Codex/Claude/OMP records are read-only. No prototype directory, CCB runtime, ask or tmux is a product dependency.
Windows and macOS binaries and dialogs are not tested here. The native directory dialog is not exercised when `NOZELI_TEST_PICK` is set.

The normal renderer mounts Monaco for supported code files; Markdown, TeX, and ordinary text use the CodeMirror/reading path, which also remains available for the isolated comparison harness and adapter coverage. Monaco dynamic stylesheets receive the application nonce at build time; the isolated harness permits inline style attributes required by Monaco, while retaining restricted script sources. Production CSP is unchanged. The earlier 0.55.1 cancellation workaround was removed after upgrading to 0.57.0, which includes the upstream fix.

## Word DOCX editor

SuperDoc 1.47.1, AGPL-3.0, pinned full browser distribution at vendor/superdoc-1.47.1. Source: https://github.com/superdoc-dev/superdoc; exact tarball/integrity and file hashes in vendor/superdoc-1.47.1/SOURCES.json. LICENSE retained. Local assets only; telemetry disabled. SuperDoc 2.20.0 was excluded because its separately loaded @superdoc/docx-engine is proprietary. jszip 3.10.2 validates DOCX package structure before reading/writing. No Document Server or external CDN is required by this driver.

## Local spreadsheet editor (2026-10-06 follow-up)

`vendor/sheet-1.0.4` pins Fortune Sheet React 1.0.4, React/ReactDOM 18.3.1, ExcelJS 4.4.0 and JSZip 3.10.2. Bundled LICENSE files and SOURCES.json retain origins/hashes. Fortune's `calculateSheetFromula` is patched to write into the requested sheet instead of the active sheet; its FormulaBar stops Enter/Escape propagation before a deferred state updater to prevent the grid handling the same commit twice and clearing a neighboring cell; exact original/replacement and upstream hash are recorded. ExcelJS is used only for parsing a derived copy; original OOXML is patched for content edits. Word anchor extraction uses `@xmldom/xmldom` 0.9.12 (MIT), recorded in package-lock. Assets run locally in an iframe with network disabled.

## PPTist 2.0.0 (2026-10-07)

Local PPTX engine at `vendor/pptist`, upstream commit `82ecf10040ca8da67832f173b58d3baf5da59887`, AGPL-3.0. Exact source archive, LICENSE and lockfile retained; reproducible adaptations in `tools/build-pptist.mjs`. `pptxtojson` 2.2.0 and `pptxgenjs` 3.12.0 MIT, `hfmath` 0.0.2 ISC; full transitive redistribution audit remains pending. See vendor README and isolated evaluation report for fidelity limits.

## Legacy DOC body import (2026-10-08)

`word-extractor` 1.0.4 (MIT), https://github.com/morungos/node-word-extractor, pinned in package-lock. Pure JavaScript OLE Word text extraction runs in a bounded worker thread; no WPS, LibreOffice, shell, or network dependency. This is an explicit body-only DOCX copy import, not native DOC rendering or lossless conversion: images, table structure and original styling are not retained. ZIP/DOCX content with a .doc suffix is validated and copied byte-for-byte. Source DOC is never overwritten. Synthetic upstream OLE fixture and MIT license are retained under `tests/fixtures/legacy-word/` with pinned commit provenance.


## TeX runtime adapters (2026-10-08)

No compiler source or binary is bundled in the desktop package by this change.
The host launches detected native `latexmk` (GPL-2.0) with a selected TeX Live engine, or separately selected Tectonic (component-specific licensing; wrapper MIT).
PDF display reuses the existing PDF.js 6.4.299 dependency.
Linux validation used the official TinyTeX-1 v2026.10 archive in the developer's user toolchain directory, latexmk 4.88 and TeX Live 2026, plus existing Tectonic 0.17.0. TeX Live packages/fonts have individual licenses; this test installation is not a redistributable app toolchain package or cross-platform installer acceptance.
Archive: https://github.com/rstudio/tinytex-releases/releases/download/v2026.10/TinyTeX-1-linux-x86_64-v2026.10.tar.xz
SHA256 (matches the official GitHub release asset digest): `4d519d6236ee6798e3ec0d8e2093d1fda01aeb267aa22c2a5586d76bcfce6566`.

## TeX editor intelligence (2026-10-08)

- `@shikijs/core`, `@shikijs/langs`, `@shikijs/themes`, `@shikijs/engine-javascript`, `@shikijs/monaco`: locked 4.5.0, MIT, https://github.com/shikijs/shiki. Only TeX/LaTeX/BibTeX grammars and Light+ theme are bundled; JavaScript regex engine needs no runtime network/WASM download. Retain package LICENSE and upstream grammar notices in distribution audits.
- TexLab 5.26.0: https://github.com/latex-lsp/texlab, GPL-3.0. External native process, not bundled in application. Linux evaluation binary downloaded from official release `texlab-x86_64-linux.tar.gz`, SHA256 `8697bd5e479d4584b14b7eed5c320c80ec4e1d91ebefbb6801e6bf38e9971300`. Windows/macOS native artifacts not tested. An eventual bundled distribution must include applicable license/source obligations.

## Image viewer (2026-10-08)

`image-size` 2.0.2 (MIT, https://github.com/image-size/image-size) validates raster dimensions and JPEG orientation in the host. Electron/Chromium's existing image decoders and Canvas/ImageBitmap APIs provide static rendering and pixel crops; no external executable or OS-specific viewer is required. PNG/JPEG/WebP have Linux desktop evidence; GIF/BMP/AVIF routes depend on the bundled Chromium decoder and are not claimed as individually validated formats. SVG remains a source-text document in this slice.

## Source/preview linking (2026-10-09)

Markdown linking reuses the installed CodeMirror/Lezer parser and mapped DOM geometry; no new dependency. TeX invokes the optional native TeX Live `synctex view/edit` utility against the displayed immutable PDF and SyncTeX artifact. No compiler or SyncTeX binary is bundled in the desktop package. Tool discovery supports existing native PATH and managed user toolchain directories, without shell or external viewer/editor commands.

SyncTeX is an optional external TeX tool, not bundled in the product or sourced from a local prototype directory. Its installation and licensing remain the user's toolchain responsibility; missing SyncTeX does not disable source editing or PDF reading.

## Managed three-role runtime (2026-10-10)

Nozeli-owned runtime adapted from the previously isolated prototype into src/agents/managed; product imports no prototype modules. Reuses installed ws/node-pty/xterm and the optional user-installed Codex CLI (tested 0.161.0). Provider configuration is read through native structured CLI RPC; no Python, shell, tmux or CCB transport dependency. Project runtime data lives outside the project tree. Linux/Wayland acceptance and unresolved protected-write/Git/platform boundaries are recorded in the Plan Tree.

Managed shell/Git Linux isolation (2026-10-12) invokes the external system `bwrap` binary (bubblewrap 0.11.1 tested) and Git 2.53.0. These executables are not bundled by the local snapshot installer. No CCB/tmux/ask runtime was introduced. The host validates a read-only mount boundary, external Worker copy and exact commit ownership; missing isolation support rejects managed startup without disabling basic reading. Windows/macOS isolation is not implemented or tested. Native first-frame integration reuses the same node-pty/xterm stack; no separate terminal runtime was added.

Application action icons now share `src/renderer/ui-icons.mjs`: existing Lucide SVGs plus a subset from `lucide-static` 0.468.0 (https://registry.npmjs.org/lucide-static/-/lucide-static-0.468.0.tgz; upstream https://github.com/lucide-icons/lucide). No runtime dependency or remote icon/font request was added. ISC/MIT notices remain in `workspace-conversation-controls.LICENSE`; the pinned additional subset's full license is retained in `ui-icons.LICENSE` and copied into the renderer build. File-type icons continue to use the bundled Monaco Codicons font.

Region drawing uses native SVG/Canvas. The pencil icon extends the existing Lucide 0.468.0 set (same retained ISC license). PPT clean slide capture reuses the pinned PPTist distribution’s existing MIT html-to-image dependency through `tools/build-pptist.mjs`, filtering editor controls and grid lines; no new runtime dependency or Office-original write path is introduced.

## Unified session work surface (2026-10-19)

Nozeli-owned local React root; no upstream App, iframe chat, ConnectScreen, AgentDrawer, GuestClient socket, capability, or wire schema is shipped. Source reference: OMP v18.11.0 source checkout, commit `c2cb79e4c227aa4b22c4ccb933ff72fd88bceba4`, https://github.com/can1357/oh-my-pi/tree/c2cb79e4c227aa4b22c4ccb933ff72fd88bceba4/packages/collab-web (MIT; full notice at `assets/licenses/collab-web.LICENSE`). This is an independently maintained adaptation, not a promise to retain upstream UI compatibility.

| Upstream source | SHA-256 of source | Nozeli adaptation |
| --- | --- | --- |
| `src/lib/client.ts` | `236f1e0818b8283f6a4206dbb1120b3eec501c5b7381930fbe7eb69084151467` | `src/renderer/session-store.mjs`: immutable external-store snapshots, identity reconciliation, animation-frame publication; transport removed, host projection only |
| `src/components/transcript/Transcript.tsx` | `1cdf20931810790b0c621ea943996b26e604ea793393574d2a0be3641f180cf0` | `session-store.mjs`/`session-timeline.mjs`: scroll tail lock, keyed transcript rows and lazy folded bodies; Nozeli Work/job/revision groups replace upstream session layout |
| `src/tool-render/ToolView.tsx` | `a601a88d06a307e5106349e278719d400b583f7fe7b17029f920aed49320bbf9` | `session-timeline.mjs`: stateful tool-card chrome and lazily mounted tool output, host-projected tool data only |

`react` and `react-dom` are exactly pinned to 19.2.0 (MIT), https://github.com/facebook/react/tree/v19.2.0; npm tarball integrity and transitive scheduler are retained by `package-lock.json`. Their installed LICENSE files are copied into renderer distribution alongside the Collab notice by `tools/build-renderer.mjs`. Existing safe `renderTagMarkdown`, KaTeX, code highlighting and file-icons remain the shared rendering implementation. Frozen diffs reuse installed CodeMirror MergeView, not prototype parsers or LCS. Browser source caches are projections only; native journal and host receipts remain authoritative.
