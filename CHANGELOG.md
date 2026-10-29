# Changelog

## Unreleased

- 新增 macOS arm64 目标：固定 OMP 原生输入，构建目录/进程 N-API 桥，保留文件身份、并发冲突与进程归属核验。
- 新增 `.app` / dmg 装配、ad-hoc 签名、包内运行时校验、Terminal.app 接入及 macOS CI；本地验收范围为 macOS 26.4 arm64，不扩展已发布 Linux tag 的平台声明。
- 修复 PDF 备注提交时切页导致的归属与草稿问题，以及隐藏文档布局、原生窗口关闭失败后的重试问题。
- 补齐最终包六类文件、系统打开、本地脚本协作和指定候选 A→B→A 数据回退验证。显式隔离、提权、特殊项目恢复、正式签名/公证及公开分发资格仍不作支持承诺。

## 0.1.0-alpha.2

- Add explicit deterministic unit/integration test suites and a credential-free real Electron smoke entrypoint, with Linux CI and clean pinned builds.
- Add contribution/security policies, issue and PR templates, dependency alerts, a user guide and structured release compliance bookkeeping.
- Reconcile documentation with the public Alpha status; third-party source and redistribution review remains open rather than being treated as certified by publication.
- Fix external-file open queue validation to accept storage-v2 UUID project identities while retaining root/target identity checks; valid open claims no longer freeze as corrupt queue records.
- Redesign automatic teaching as an interface-first, six-section Markdown workflow: one review loop, replay-safe actions, readable timed explanations and compact bottom prompts; preserve old demo copies and user edits by template digest.
- Stream Worker input snapshots, Git blobs, immutable artifacts and acceptance writes instead of buffering whole files. Remove execution's 32 MiB per-file and 256 MiB/10,000-file snapshot gates while preserving worktree isolation, conflict checks and recovery. Keep bounded text previews separate from artifact delivery, and allow saving complete frozen report references without overwriting existing files.

## 0.1.0-alpha.1

### Reading and collaboration

- Compact report file lists with change status and separate added/deleted counts. Candidate text opens the existing workspace Diff; images and other supported materials use the native document workspace.
- Version-bound result review, persistent unsent feedback, and explicit accept or continue decisions. Problem reports can resume the original Worker without replacing its task, thread or worktree.
- Empty workspaces recommend annotations and selection discussion, the task delivery/review loop, split panes and detached windows. Project-empty panes provide concrete starting instructions.
- Updated small application icon across the titlebar, native windows and Linux desktop launcher; explicit Wayland desktop identity prevents blank taskbar icons.

### Reliability

- Preserve drafts and exact document identity across project navigation, window handoff and review operations.
- Prepare independent Worker dependency copies and pinned build resources without modifying the source dependency tree.
- Harden storage-worker unknown-result handling, lifecycle holds, permission decisions, conflict-safe integration and technical closure.
- Restore layout path/project identity validation so traversal paths and foreign or malformed document records cannot enter persisted workspace state; renames retain view identity and draft state.
- Improve cross-project file clipboard operations, quick-open navigation, model selection during refresh and attachment picker viewport behavior.

### Release scope

- Alpha qualification is Linux x64 / Wayland only. Windows and macOS are product targets, not verified release platforms.
- AI features require user-supplied provider configuration. No credentials, user project data or personal sessions belong in release artifacts.
- Published as a public Alpha prerelease at the repository owner's explicit request. Third-party corresponding-source and redistribution review remains incomplete; publication, a source archive or an upstream URL does not certify or discharge those obligations.
- See [release guidance](docs/release.md) for packaging, validation and publication boundaries.
