# alpha.6 之后的远端 main 增量审查

2026-11-10 重新核对 GitHub：alpha.6 tag 仍为 `9a2466a847267620747b79f9c1b97fbac8f00280`，PR27 已合并于 `cb07c5180c85ca0e127ddc332089300498103cc5`，PR HEAD 仍为 `b72e744640e02a117ab2ef95211eebb3e363dce6`。main 已到 `6c893dfed7831abfe58afad78eacc164292f7b1b`，领先6提交，完整 compare 返回80文件（未触及API文件截断上限）。这80文件尚未合入本轮alpha.6交付。

最新更新时间靠前的PR为尚未合并的依赖升级，不视为已集成产品版本。main增量包含beta.1草案、Task/review修改、打包与CI修正。上游发行授权记录属于该文档上下文，不是本Windows任务的新发布授权。

当前先完成v47独立alpha.6冷接管交付；后续版本目标已向用户澄清，在回复前沿用明确的alpha.6目标。若切换最新main，按以下顺序整合并建立新的证据批次，v47包和收据保留为历史：

1. 固定上述精确main SHA，保存当前源码／新增文件摘要与未提交差异。用三方合并逐项保留Windows适配，不reset／stash覆盖当前现场，不更改已发布tag。
2. 重点人工审查Controller、managed-projects、session-index、main／host／workspace-native、renderer/app、test-suites和build-pptist的重叠。保留Windows原生scope、冷恢复门、UNKNOWN、草稿与并发赢家；共享Task状态机以新上游为准，避免保留已删除入口后仍被调用。
3. 检查上游删除project-initialization与review-conversation后的所有生产引用；Windows语义初始化拒绝应迁移到真实新入口并在副作用前生效。Task/review新权限、人工稿确认、跨Work身份边界、冷上下文清理需相关回归。
4. 显式处理package／lock的beta.1版本与打包注册表，核对依赖闭包；入口／依赖变化后实际构建Pi／renderer／相关原生组件与新包，禁止复用旧源码或二进制掩盖失败。
5. 运行新上游Task/review定向测试和Windows真实Worker／冷接管／桌面回归，独立解压后重跑。更新基线、消费点清单与W0–W5状态；不继承Linux/macOS通过为Windows证据。

## 六个提交

- `4ef2576f07e98a89970dedaddc7db8048f66bd7d`：Prepare dual-platform beta.1 draft and integrate Task review fixes
- `5b9f446079830fba0c5743f35849f99951c9b3ff`：Resolve lazy Electron binaries before macOS draft packaging
- `37dc8c8304ae81e58775db293c1b85779284003c`：Exercise visible native macOS windows in archive smoke
- `17209df5d62a13d958cd11396e1d39c17138f793`：Harden the CI Node executable before approval execution checks
- `bb963395b503df0ebfdfb566d2d88195387e6d33`：Record current owner authorization for Beta1 public prerelease
- `6c893dfed7831abfe58afad78eacc164292f7b1b`：Fix publication build registry and cold-context fixture teardown

## 完整文件与本地重叠

共80文件，其中14个路径在当前修改／新增清单中。重叠只表示需要三方审查，不代表冲突已解决。

| 路径 | 上游动作 | 增／删 | 本地有改动 |
| --- | --- | --- | --- |
| `.github/workflows/ci.yml` | modified | +58 / -4 | 否 |
| `.github/workflows/macos-release-draft.yml` | added | +112 / -0 | 否 |
| `.github/workflows/release-check.yml` | modified | +3 / -3 | 否 |
| `CHANGELOG.md` | modified | +4 / -1 | 是 |
| `README.md` | modified | +5 / -5 | 否 |
| `apps/desktop/compliance-inventory.json` | modified | +8 / -7 | 否 |
| `apps/desktop/package-lock.json` | modified | +2 / -2 | 否 |
| `apps/desktop/package.json` | modified | +1 / -1 | 是 |
| `apps/desktop/src/agents/managed-projects.mjs` | modified | +56 / -8 | 是 |
| `apps/desktop/src/agents/managed/controller.mjs` | modified | +84 / -129 | 是 |
| `apps/desktop/src/agents/managed/session-index.mjs` | modified | +26 / -2 | 是 |
| `apps/desktop/src/domain/managed-work-records.mjs` | modified | +1 / -0 | 否 |
| `apps/desktop/src/domain/review-conversation.mjs` | removed | +0 / -77 | 否 |
| `apps/desktop/src/domain/workspace-layout.mjs` | modified | +7 / -1 | 否 |
| `apps/desktop/src/main/host.mjs` | modified | +2 / -4 | 是 |
| `apps/desktop/src/main/main.cjs` | modified | +2 / -2 | 是 |
| `apps/desktop/src/main/native-review-discussion.mjs` | modified | +105 / -5 | 否 |
| `apps/desktop/src/main/review-documents.mjs` | modified | +3 / -2 | 否 |
| `apps/desktop/src/main/workspace-native.mjs` | modified | +50 / -13 | 是 |
| `apps/desktop/src/preload/review-discussion.cjs` | modified | +7 / -1 | 否 |
| `apps/desktop/src/renderer/app.mjs` | modified | +0 / -2 | 是 |
| `apps/desktop/src/renderer/composer-materials.mjs` | modified | +2 / -39 | 否 |
| `apps/desktop/src/renderer/frozen-material-viewer.mjs` | added | +23 / -0 | 否 |
| `apps/desktop/src/renderer/managed-agent-panel.mjs` | modified | +5 / -3 | 否 |
| `apps/desktop/src/renderer/managed-review.css` | modified | +19 / -6 | 否 |
| `apps/desktop/src/renderer/managed-review.mjs` | modified | +76 / -57 | 否 |
| `apps/desktop/src/renderer/project-attention.css` | modified | +0 / -1 | 否 |
| `apps/desktop/src/renderer/project-attention.mjs` | modified | +77 / -32 | 否 |
| `apps/desktop/src/renderer/project-initialization.css` | removed | +0 / -3 | 否 |
| `apps/desktop/src/renderer/project-initialization.mjs` | removed | +0 / -31 | 是 |
| `apps/desktop/src/renderer/review-discussion.css` | modified | +1 / -1 | 否 |
| `apps/desktop/src/renderer/review-discussion.mjs` | modified | +6 / -1 | 否 |
| `apps/desktop/src/renderer/session-timeline.css` | modified | +35 / -1 | 否 |
| `apps/desktop/src/renderer/session-timeline.mjs` | modified | +115 / -41 | 否 |
| `apps/desktop/src/renderer/task-presentation.mjs` | modified | +6 / -4 | 否 |
| `apps/desktop/src/renderer/task-workspace.mjs` | modified | +12 / -2 | 否 |
| `apps/desktop/tests/desktop-ci-smoke.mjs` | modified | +4 / -4 | 否 |
| `apps/desktop/tests/desktop-composer-materials.test.mjs` | modified | +43 / -33 | 否 |
| `apps/desktop/tests/desktop-frozen-workflow.test.mjs` | modified | +4 / -2 | 否 |
| `apps/desktop/tests/desktop-material-native-pick-live.mjs` | modified | +53 / -35 | 否 |
| `apps/desktop/tests/desktop-project-attention-live.mjs` | modified | +13 / -5 | 否 |
| `apps/desktop/tests/desktop-project-initialization-live.mjs` | modified | +0 / -4 | 否 |
| `apps/desktop/tests/desktop-report-review.test.mjs` | modified | +1 / -1 | 否 |
| `apps/desktop/tests/desktop-retained-progress-live.mjs` | modified | +12 / -8 | 否 |
| `apps/desktop/tests/desktop-review-discussion-live.mjs` | modified | +29 / -3 | 否 |
| `apps/desktop/tests/desktop-review-human-adoption-live.mjs` | modified | +9 / -8 | 否 |
| `apps/desktop/tests/desktop-session-timeline.test.mjs` | modified | +161 / -9 | 否 |
| `apps/desktop/tests/desktop-task-workspace-live.mjs` | modified | +32 / -20 | 否 |
| `apps/desktop/tests/file-attachments-host.test.mjs` | added | +234 / -0 | 否 |
| `apps/desktop/tests/managed-context-cutover.test.mjs` | modified | +67 / -14 | 否 |
| `apps/desktop/tests/managed-projects.test.mjs` | modified | +7 / -1 | 否 |
| `apps/desktop/tests/managed-review-discussion.test.mjs` | modified | +61 / -72 | 否 |
| `apps/desktop/tests/managed-review-lifecycle.test.mjs` | modified | +7 / -1 | 否 |
| `apps/desktop/tests/managed-work-records.test.mjs` | modified | +6 / -1 | 否 |
| `apps/desktop/tests/native-review-discussion.test.mjs` | modified | +157 / -2 | 否 |
| `apps/desktop/tests/native-review-dom.fixture.mjs` | added | +58 / -0 | 否 |
| `apps/desktop/tests/native-review-renderer.test.mjs` | modified | +82 / -21 | 否 |
| `apps/desktop/tests/post-install-git-main-crash.mjs` | modified | +2 / -3 | 否 |
| `apps/desktop/tests/post-install-recovery-host-gui.mjs` | modified | +2 / -3 | 否 |
| `apps/desktop/tests/project-attention.test.mjs` | modified | +208 / -13 | 否 |
| `apps/desktop/tests/review-conversation.test.mjs` | modified | +97 / -204 | 否 |
| `apps/desktop/tests/session-index.test.mjs` | modified | +40 / -0 | 否 |
| `apps/desktop/tests/task-timeline-scope.test.mjs` | modified | +75 / -0 | 否 |
| `apps/desktop/tools/build-pptist.mjs` | modified | +15 / -1 | 是 |
| `apps/desktop/tools/package-macos-release.mjs` | added | +161 / -0 | 否 |
| `apps/desktop/tools/package-macos.mjs` | modified | +118 / -88 | 否 |
| `apps/desktop/tools/package-portable.mjs` | modified | +3 / -3 | 否 |
| `apps/desktop/tools/test-suites.mjs` | modified | +3 / -2 | 是 |
| `dev_tools/skills/nozeli-github/SKILL.md` | modified | +3 / -0 | 否 |
| `dev_tools/skills/nozeli-github/scripts/check_release_state.py` | modified | +73 / -21 | 否 |
| `dev_tools/skills/nozeli-github/scripts/fixtures/gh_stub.py` | added | +30 / -0 | 否 |
| `dev_tools/skills/nozeli-github/scripts/fixtures/run_fixtures.py` | added | +281 / -0 | 否 |
| `docs/agent-conversation-status-demo.md` | modified | +20 / -0 | 否 |
| `docs/principles.md` | modified | +6 / -4 | 否 |
| `docs/release.md` | modified | +14 / -2 | 否 |
| `docs/status.md` | modified | +3 / -3 | 是 |
| `docs/task-workspace-design.md` | modified | +70 / -2 | 否 |
| `docs/testing.md` | modified | +81 / -0 | 是 |
| `docs/user-guide.md` | modified | +10 / -4 | 否 |
| `docs/worker-review-chat-demo.md` | modified | +148 / -0 | 否 |

原始API、完整patch与审查JSON：`C:\nozeli-test\20261110-alpha6-cold-handoff\upstream-*.json`。本审查没有把新main写成已合并、已构建或已验证。
