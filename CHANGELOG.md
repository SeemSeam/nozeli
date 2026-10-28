# Changelog

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
- The Linux portable build is a local validation artifact. Public redistribution of bundled third-party code remains gated on corresponding-source and license compliance; a source archive or upstream URL alone does not satisfy that gate.
- See [release guidance](docs/release.md) for packaging, validation and publication boundaries.
