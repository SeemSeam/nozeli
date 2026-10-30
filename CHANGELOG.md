# Changelog

## Unreleased

- Correct maintainer verification for GitHub's non-ASCII asset-name sanitization: publish generated instructions as `USAGE.zh-CN.md` and bind that name in the checksum manifest. Capture clipboard smoke evidence before its native document is hidden by the conversation. These maintenance-only fixes do not change the tagged application archives.

## 0.1.0-alpha.3

- Add a standalone `nozeli-github` OMP maintainer skill and read-only release checker covering protected PR delivery, exact-commit CI/tag/homepage alignment, portable archive binding, checksums and explicit Alpha audit limitations; the desktop package remains private and is not published to npm.
- Fix rapid project navigation to retain only the latest pending destination while preserving source saves and native ownership. Commit identity only after target state staging, require applied (not stale) viewport receipts, keep cold native guests outside shell input until ready validated pane admission, and avoid starting Agents merely to navigate; failures retain the source scene and surface a visible error.
- Repair system text copying across native document/conversation surfaces: route Copy/Cut to the actually focused owned WebContents and allow only sanitized writes from trusted app main frames, retaining clipboard-read and preview isolation. Linux launchers now prefer X11/XWayland when DISPLAY exists to avoid Electron's confirmed native-Wayland unpublished clipboard/cache defect (#54645). Keep clipboard test providers invisible and bounded by stdin closure and a watchdog.
- Paste external files and folders from the native system file clipboard into the project tree via its context menu or Ctrl/Cmd+V. Bind host-only clipboard tickets to the active project and sender, preserve external sources even for cut metadata, copy nested files without overwriting conflicts, and report partial results. Keep internal cross-project copy/cut behavior with explicit native clipboard ownership markers; protect registered drafts and concurrent source/destination changes.
- Make the review file list collapsible with a visible file count. Lists over eight files initially collapse; expanded lists scroll independently within a viewport-bounded height so review instructions and decisions remain reachable. Refresh preserves the user's expansion choice and unsent instructions.
- Keep unlocated Word/text/PDF/image/PPT tags actionable in one shared inline tray, including collapsed historical cards, with visible view/edit/delete or discussion-projection removal controls. Explicit same-kind selection relocation validates current source and annotation revisions (plus PPT draft identity), preserves frozen original materials and discussion history, and rejects stale or mismatched selections instead of silently attaching to nearby content.
- Add an explicit Force Quit action to the busy-exit dialog, including while normal cancellation is pending. It bypasses blocked flush/stop work with a bounded Electron exit, preserves durable recovery facts, and on Linux identity-checks owned native descendants before termination without pre-killing Electron's Chromium services. Warn that unsaved content and in-flight operations may be lost; cold start never replays the interrupted business input.
- Fix reconnect after additive native tool upgrades: prove historical definitions and live bridge registration, retain the original resident threads/history/drafts, and allow added tools or optional fields on closed object schemas. Preserve explicit recovery for incompatible contracts instead of masking it as internal maintenance; verified same-thread startup settles obsolete, never-admitted bootstrap repair events without replaying business input.
- Separate ordinary project file access from automatic snapshot selection: dot-directories such as `.ccb`, `.github` and `.config` are no longer rejected by name. Preserve tracked metadata without silently merging changes; explicitly declared safe ignored artifacts are frozen, reviewed and integrated with normal conflict protection.
- Add a persistent local bug ledger and automatic Orchestrator maintenance events for pre-prompt preparation, captured publication and technical closure failures. Host recovery is bounded and verified; it retains the original Work and does not replay started Worker commands, grant privileges or turn internal failures into user questions. Unsupported repairs retain progress as pending version fixes.
- Keep all native Agents in YOLO mode and remove ordinary host execution and unregistered-directory document access approvals. Cross-project reads/edits preserve bound handles, target CAS, local receipts and registered drafts without registering external directories or writing metadata there.
- Limit the user inbox and notifications to result review and concrete high-danger authorization. Ordinary questions and recovery facts move to source-bound Orchestrator processing; the same Work continues once when a reliable reversible default exists, otherwise it retains an explicit backstage blocked state. High-risk grants are exact-effect-bound, and refusals/revocations and unknown-effect replay protection remain effective.

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
