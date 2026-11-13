---
name: nozeli-github
description: Maintain Nozeli commits, pushes, versions, CI, release assets and recovery. Includes risk-tiered simple releases with targeted local verification, without bypassing required CI or artifact/audit gates. Never create a PR unless explicitly requested.
---

# Nozeli GitHub Maintainer

Default repository: `SeemSeam/nozeli`. This skill is standalone; it needs Python 3, git, and authenticated GitHub CLI, not another agent runtime. Nozeli is a private desktop application package: **never run npm publish**, add registry publication, or invent an automatic asset-upload workflow.

## 提交规则：不主动创建 PR

- 默认只执行用户授权范围内的提交、推送或发布，不自行创建 Pull Request。
- “帮我 commit”“推送 GitHub”“发布新版本”不等于授权提 PR；只有用户当轮明确要求提 PR 才能创建。
- 若分支保护要求必须经过 PR，保留已完成工作并报告阻塞；不得以完成提交／发布为由自行提 PR、修改保护规则或绕过检查。
- 不因仓库已有机器人／外部贡献 PR，或以往曾用 PR 发布，就沿用自动提 PR 的流程。

## Safety and completion contract

Perform commit/push/release actions only within the current user's authorization. Normal development does not imply permission to tag or publish. Never force-push tags, rewrite published history, bypass branch protection, use an admin merge override, suppress a failed check, or fabricate human signoffs. The checker is read-only: it does not fetch, commit, push, merge, dispatch, upload, publish, or poll.

Public redistribution obligations are independent of engineering checks. Preserve `pending` obligations and honest `node tools/check-repository.mjs --public` failure until actual named human review with dated evidence is available. An Alpha/Beta prerelease exception requires **current explicit owner authorization for this exact release after disclosing the still-open obligations**, plus disclosure in release notes, README and release documentation. Earlier release authorization is not reusable. A generic request to release, improve this skill or release quickly does not approve the audit exception. An exception is not compliance certification and does not make failed CI or public audit green. Do not publish a stable release under a prerelease exception.

Never create a pull request unless the user explicitly requests a PR in the current conversation. Authorization to commit, push, publish, or update the homepage does not authorize PR creation. GitHub's homepage renders README from the default branch, not a release tag. Inspect current branch protection: push directly only when authorized and permitted; if protection requires a PR, stop that delivery step and report the constraint. Do not create a PR as a workaround, change protection, or use an admin bypass. Existing external/bot PRs are not permission to open maintainer PRs.

## Install and invoke

From a repository checkout, after reviewing these two files, install an independent copy:

```sh
mkdir -p "$HOME/.omp/agent/skills/nozeli-github/scripts"
cp dev_tools/skills/nozeli-github/SKILL.md "$HOME/.omp/agent/skills/nozeli-github/SKILL.md"
cp dev_tools/skills/nozeli-github/scripts/check_release_state.py "$HOME/.omp/agent/skills/nozeli-github/scripts/check_release_state.py"
```

Run from anywhere inside the target git checkout, or supply `--root /path/to/checkout` (never infer the repository from the installed skill directory):

```sh
python3 "$HOME/.omp/agent/skills/nozeli-github/scripts/check_release_state.py" --phase prepare
python3 "$HOME/.omp/agent/skills/nozeli-github/scripts/check_release_state.py" --phase dev
python3 "$HOME/.omp/agent/skills/nozeli-github/scripts/check_release_state.py" --phase draft --assets-dir /path/to/release-output
python3 "$HOME/.omp/agent/skills/nozeli-github/scripts/check_release_state.py" --phase published --version 0.1.0-alpha.3 --assets-dir /path/to/release-output
```

`--repo` defaults to `SeemSeam/nozeli`; `--version` otherwise derives from `apps/desktop/package.json`. `--assets-dir` enables local SHA-256 and streaming portable `RELEASE.json` verification without extracting an archive. `prepare` allows dirty edits and performs local metadata checks. `dev` additionally requires clean, remotely pushed HEAD and successful `CI` at exactly HEAD. `published` additionally validates the selected tag/release/assets, exact tag CI, default-branch containment and README. It checks the selected prerelease directly, not GitHub's latest stable release. Exit 0 means these mechanical checks passed, not legal approval, manual smoke acceptance, or authorization to publish. `WARN AUDIT` is separate from technical `FAIL`.

`draft` requires a still-unpublished prerelease, matching local/remote tag, exact-commit CI and complete checksum-bound assets; it does not require default-branch publication or authorize publishing. Required macOS assets are selected by the union of `release.platformsTargeted` and `platformsExercised`: targeting a platform must not silently skip its archive checks, and does not claim qualification. macOS arm64 uses `apps/desktop/tools/package-macos-release.mjs` on a real arm64 Mac, with ad-hoc signing and no notarization; local asset checks inspect its sealed in-zip `RELEASE.json`. See `docs/release.md` for combining both platforms' checksum manifests and separately exercising extracted applications.

If gh cannot find the desktop login under a tool's alternate configuration, explicitly use the user's normal home configuration:

```sh
GH_CONFIG_DIR="$HOME/.config/gh" gh auth status
GH_CONFIG_DIR="$HOME/.config/gh" python3 dev_tools/skills/nozeli-github/scripts/check_release_state.py --phase dev
```

Respect an intentionally configured account. Never read, print, copy or embed tokens or keyring secrets. Authentication failure is a blocker, not permission to extract credentials.

## Ordinary development

1. Read the repository instructions and classify the change. Tooling/docs-only work usually needs no new version or release. Runtime, dependency, packaging and user-facing changes need release consideration, not an automatic tag.
2. Update affected callers/docs and run risk-appropriate targeted tests; use `docs/testing.md` and `apps/desktop/package.json` for current commands. For skill-only changes, syntax/help and checker fixtures suffice; do not build the entire application unnecessarily.
3. Review the diff; commit and push only within current authorization. Do not open a PR by default. For default-branch/homepage delivery, use an authorized push only if protection permits; otherwise report the PR requirement and retain the work without creating a PR. If the user explicitly requests a PR, satisfy its required checks and allowed merge method. Check the actual delivered commit's CI, not an unrelated successful run.
4. Run `--phase dev` on the delivered checkout. In-progress/missing CI is incomplete; inspect again explicitly later, without checker polling. Do not create a release for development-only work.

## 简单发布：按风险分级，不重复无关本地全量测试

用户说“小更新／快速发布／简单发布”时，默认先评估下面的路径；不要直接重跑所有本地测试，也不要将“改动行少”当成低风险。此节是执行策略，不新增 `--simple` 或 `--skip-ci` 参数，不自动更改现有GitHub workflow／保护规则。

| 路径 | 适用范围 | 本地最低验证 | 升级条件 |
| --- | --- | --- | --- |
| 文档／维护工具 | 产品运行代码、依赖、构建及发行资源未变 | 内容／链接核对；改检查器则语法、help与已有fixture | 不制造无必要产品版本；若实际发包仍执行产物门 |
| 简单补丁发布 | 已知良好发行基线上的局部UI／逻辑修正，依赖／协议／持久化／权限／平台和打包均不变 | 受影响模块及直接消费者回归；bug修前失败／修后通过证据；真实最终包启动、改变路径、保存／正常退出／冷恢复 | 影响面不明、消费者失败、跨模块交互扩大时转风险专项 |
| 风险专项发布 | 进程生命周期、内存回收、认证、数据迁移、Git/文件写入与回滚、权限、更新器、依赖／原生库／打包、代码分包或跨平台变更 | 上述基础＋实际边界专项：并发／UNKNOWN／失败恢复／回滚／持久化；每个声明平台最终包验证 | 无法约束影响范围、共享核心广泛变化、基线过旧或回归暴露广泛问题时增加本地全量 |

**所有发布仍需最终提交的强制CI成功。** 若主支保护要求全套 `CI gate`，简单路径仅省去额外重复的本地全量运行，不省远端门禁。不删除／改名必需check、不制造成功status、不使用admin bypass、不为快发临时降低workflow覆盖或延长超时掩盖失败。未来若需真正的远端快速CI，应另获授权设计path-filter与始终存在的gate，并证明高风险变更无法漏测；本skill不假装该能力已存在。

### 简单发布操作卡

1. **明确基线与范围**：核实最新远端main、上一发行tag、当前branch/worktrees及未提交差异。只收用户要求的产品修改，不夹带Demo、诊断脚手架、用户文件或其它在途任务。以已发布基线到候选的完整差异分级；落后版本的本地热修复不能直接冒充最新版。
2. **先给出短清单**：说明拟定版本、平台、风险级别、要跑的专项、复用证据及不重跑的无关本地套件。默认执行合理选择，不逐项请求确认；只有公开审计例外、平台缩减、PR授权等实质决定才询问。版本与平台不能因想快发而静默缩减。
3. **利用已有证据**：同一最终字节、相同依赖／编译工具链／平台与同场景的定向记录可复用；登记来源、digest、结果及未验边界。仅文档／版本元数据差异需核定不会改变运行资源。旧SHA或已安装旧包的通过不能代替最终提交CI、最终打包／解压验证。代码改动后，只重跑受影响检查，但失败原件不能抹掉。
4. **更新并校验元数据**：按下节原子更新所有版本入口，执行 `--phase prepare` 及仓库元数据／hash检查；公开审计单独真实执行，失败与所有者例外分别记录。不将运行源码目录视为发行产物。
5. **单一交付SHA**：提交→授权推送到workflow实际监听的分支→等待该SHA必需CI→按主支规则线性合入。先看 `.github/workflows/ci.yml` 的真实触发条件；不假定任意fix分支push会触发。workflow_dispatch通过但主支仍显示check expected时核对check suite/app/事件与保护，不盲目反复推送或绕过；若需PR而用户未授权，报告准确阻塞。
6. **一次干净构建，验证将上传的包**：从最终干净提交构建每个平台产物，解压并验真实可执行文件、改变路径、读写保存／冷恢复和更新／回退适用路径；明确未测场景。独立平台构建可并行；不能同时运行前后PSS测量导致共享页分摊改变比较。旧平台包不得改名挂到新版本。
7. **按原发布顺序收尾**：tag与产物RELEASE.json绑定同一SHA；规范资产名和完整校验和→draft→校验→授权publish→远端下载hash核验。声明Linux/macOS双平台时必须交付并核验两边；没有新平台原生代码也不能免最终平台产物验收。不要复用下方Linux-only“四资产”示例漏掉Mac包或Node symbols等本版本实际必需资产。
8. **简洁回执**：报告版本/tag/SHA、Release URL、实际附件、专项/CI/实包结果、复用和未跑项目、公开审计/签名边界。没有公开成功前只说候选／草稿，不说已发布。

### 失败处理与证据最小集

- 先读确切失败job/log，区分源码／消费者错误、fixture错误、runner／外部服务。仅明确网络或runner暂态故障可在同SHA有界重试；同一基础设施错误重复出现时停止盲目重试，定位镜像／依赖配置，必要修复后重新提交与验证。不得以另一成功workflow掩盖当前必需门禁失败。
- 保留一个精简发行记录：baseTag/baseSHA、version/headSHA、风险级别、影响文件／消费者、各平台与依赖/工具链绑定、验证命令/结果/原件、复用理由、跳过的无关本地检查、CI URL、最终资产hash及公开授权／审计边界。登记到既有 `docs/release.md`／`docs/testing.md`，不建立重复任务数据库。
- 示例：模型菜单排版通常可走简单补丁；设置Pi进程空闲退休＋Monaco分包＋原生运行时裁剪属于风险专项，需生命周期／凭据／编辑保存／包内原生模块验证，不因用户称“小更新”省略。

## Release preparation

Update together: `apps/desktop/package.json`, `apps/desktop/package-lock.json` top-level and `packages[""]` versions, newest concrete `CHANGELOG.md` section, current release link/prose in `README.md`, baselines in `docs/status.md` and `docs/release.md`, and `apps/desktop/compliance-inventory.json` productVersion/release tag/URL. Do not insert the future release commit into the commit that is meant to identify itself; nullable inventory commit is supported, whereas archive `RELEASE.json` must bind the actual final commit. Preserve accurate Linux-only validation and Windows/macOS limitations. Manually review current-release prose, capabilities, installation links, notices and disclosure; version-string matching alone cannot prove semantic accuracy.

Run repository metadata/hash checks and relevant deterministic tests/builds/smokes as documented. Run `--public` honestly and retain its outcome. Ordinary regression must not silently make paid model calls. Run `--phase prepare` before committing. The checker does not replace `tools/check-repository.mjs` evidence/signoff validation.

## Ordered publication
1. Finish release metadata and concrete notes; complete the risk-tiered local verification above and repository checks. If audits remain pending, obtain current explicit Alpha/Beta prerelease exception authorization and record the still-open obligations without forging completion.
2. **Commit → authorized push → required CI**. Deliver to default `main` only through a route allowed by current protection and current authorization. Never infer PR permission from a release request: if `main` requires a PR and none was explicitly requested, report the blocker rather than opening one or weakening protection. If explicitly authorized to create a PR, use required checks/reviews and the allowed merge method. Synchronize the delivered default-branch commit normally; verify its homepage README and exact-SHA green `CI` before tagging.
3. Confirm every release input is in this commit and the checkout is clean. Create and push `vVERSION` only at the delivered default-branch commit after checking local/remote tag conflicts. Never force a tag. Inspect any candidate workflow before dispatch; bind both its ref and tag input to this commit. Preserve public-audit failure separately from technical CI.
4. **Clean package per declared platform**. On Linux use `node apps/desktop/tools/package-portable.mjs <absolute-new-output-directory>` from repository root; on a real arm64 Mac use `apps/desktop/tools/package-macos-release.mjs` with its inspected current arguments. Packaging must use the final clean commit and a fresh output; never recycle or relabel an old archive. Confirm every `RELEASE.json` binds the same version and delivered commit. Preserve ad-hoc/not-notarized disclosure where applicable.
5. **Unpack and smoke the actual final applications**, not source/dev mode or an older local install. On each declared platform exercise launch, rendering, changed paths, file save, normal close/quit and cold recovery; run the applicable lifecycle/authentication/native-package/update/rollback boundary checks from the risk classification. Use isolated synthetic data and normal sandbox policy, no paid requests by default. Never infer Mac/Windows success from Linux.
6. **Normalize public filenames and verify checksums**. Publish the builder's Chinese instructions as byte-identical `USAGE.zh-CN.md`, avoiding GitHub's `default.md` rename. Generate `SHA256SUMS.txt` from the actual final artifact set: Linux archive, source archive, usage, each declared platform archive and any required Node-symbol archive from the current packaging contract. Do not omit Mac or diagnostic artifacts to match a historical Linux-only list. This changes external metadata, not archive bytes or commit binding. Inspect notices and corresponding-source boundaries separately.
7. **Create a draft release → explicitly upload the exact asset set → inspect draft**. Use `gh release create vVERSION --draft --prerelease --verify-tag --repo SeemSeam/nozeli --notes-file <reviewed-notes>` for Alpha/Beta, then upload explicit paths. Inspect current workflows before assuming any automatic uploads; draft artifact availability is not public publication. Avoid `--clobber`; investigate mismatches. Run the checker's `--phase draft --assets-dir <output>` when supported. Notes describe exercised changes/verification and audit exception boundaries.
8. **Publish** only after all preceding evidence and authorization hold (`gh release edit vVERSION --draft=false --prerelease --latest=false ...` for Alpha/Beta). Never promote an experimental prerelease to stable/latest merely to satisfy a checker.
9. **Remote verify**: run `--phase published --assets-dir <output>`; inspect release URL/body, exact-SHA CI, remote README, asset names/sizes, download hashes and the packaged binding. The checker downloads only the small remote checksum manifest; independently download the published payloads to a fresh directory and hash them to verify remote bytes. Report version, commit/tag, PR/merge, release URL, tests and unpacked smoke evidence, asset hashes, clean/pushed state, and all unresolved audit or CI failures.

## Interrupted recovery and stop conditions

Start with `prepare` plus `published` for release interruptions, or `dev` for ordinary work. Inspect existing commits, PR, tags, drafts and assets before any mutation. Resume at the first incomplete step; never blindly repeat tag creation or publication.

- Dirty or unpushed work: preserve it; complete only authorized commit/push actions. Never reset unrelated work or automatically create a PR to finish delivery.
- Missing/failed/pending exact-SHA CI: inspect the specific run and fix the cause via reviewed commits. No unrelated branch/manual run is substitute evidence. A new fix commit normally requires a new release version if the old tag is already published.
- Tag missing: establish the intended merged SHA before creating it. Tag SHA disagreement: stop; never overwrite it. A maintainer-skill-only correction after tagging may merge separately without moving the product tag: keep product archives bound to the original commit and run the installed corrected checker from a clean pushed checkout containing that tag. Other product changes require a new version/maintainer decision.
- Wrong/stale package: rebuild from clean intended tag in a new output, repeat unpacked smoke and checksum checks. An archive built before merge cannot be relabelled as the merged commit.
- Missing draft/assets: create/resume the draft and upload explicitly after validation. Existing assets with different hashes require investigation, not silent replacement.
- Published but incomplete release: disclose the incomplete state; repair only with authorization and preserved provenance, then reverify remote bytes. Do not declare success because a release page exists.
- Homepage stale: update the default branch only through an authorized and permitted route, then verify remote README. If protection requires a PR without explicit PR authorization, report the blocker; do not create one or move an old release tag.
- Audit pending without current version-specific prerelease exception authorization, or missing human review: stop publication, retain pending state and report the exact blocker. Never convert script output to a signoff.

No checker success can override any of these stop conditions.
