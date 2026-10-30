---
name: nozeli-github
description: Maintain Nozeli commits, pushes, versions, protected-main PRs and CI, GitHub homepage README, release tags/pages/assets, and interrupted release recovery. Use for development delivery, release preparation, publishing, or release-state audits.
---

# Nozeli GitHub Maintainer

Default repository: `SeemSeam/nozeli`. This skill is standalone; it needs Python 3, git, and authenticated GitHub CLI, not another agent runtime. Nozeli is a private desktop application package: **never run npm publish**, add registry publication, or invent an automatic asset-upload workflow.

## Safety and completion contract

Perform commit/push/release actions only within the current user's authorization. Normal development does not imply permission to tag or publish. Never force-push tags, rewrite published history, bypass branch protection, use an admin merge override, suppress a failed check, or fabricate human signoffs. The checker is read-only: it does not fetch, commit, push, merge, dispatch, upload, publish, or poll.

Public redistribution obligations are independent of engineering checks. Preserve `pending` obligations and honest `node tools/check-repository.mjs --public` failure until actual named human review with dated evidence is available. An Alpha exception requires **current explicit owner authorization for this release** and disclosure in release notes, README and release documentation; an earlier Alpha authorization is not reusable. An exception is not compliance certification and does not make a failed CI or public audit check green. If the public gate blocks a release candidate workflow, report that exact failure separately, not as a passing workflow. Do not publish a stable release under an Alpha exception.

GitHub's homepage renders README from the default branch, not from the release tag. A feature-branch README update is not a completed homepage update. `main` is protected: use a PR, required reviews/checks and the repository's allowed merge method. Never push around that protection.

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
python3 "$HOME/.omp/agent/skills/nozeli-github/scripts/check_release_state.py" --phase published --version 0.1.0-alpha.3 --assets-dir /path/to/release-output
```

`--repo` defaults to `SeemSeam/nozeli`; `--version` otherwise derives from `apps/desktop/package.json`. `--assets-dir` enables local SHA-256 and streaming portable `RELEASE.json` verification without extracting an archive. `prepare` allows dirty edits and performs local metadata checks. `dev` additionally requires clean, remotely pushed HEAD and successful `CI` at exactly HEAD. `published` additionally validates the selected tag/release/assets, exact tag CI, default-branch containment and README. It checks the selected prerelease directly, not GitHub's latest stable release. Exit 0 means these mechanical checks passed, not legal approval, manual smoke acceptance, or authorization to publish. `WARN AUDIT` is separate from technical `FAIL`.

If gh cannot find the desktop login under a tool's alternate configuration, explicitly use the user's normal home configuration:

```sh
GH_CONFIG_DIR="$HOME/.config/gh" gh auth status
GH_CONFIG_DIR="$HOME/.config/gh" python3 dev_tools/skills/nozeli-github/scripts/check_release_state.py --phase dev
```

Respect an intentionally configured account. Never read, print, copy or embed tokens or keyring secrets. Authentication failure is a blocker, not permission to extract credentials.

## Ordinary development

1. Read the repository instructions and classify the change. Tooling/docs-only work usually needs no new version or release. Runtime, dependency, packaging and user-facing changes need release consideration, not an automatic tag.
2. Update affected callers/docs and run risk-appropriate targeted tests; use `docs/testing.md` and `apps/desktop/package.json` for current commands. For skill-only changes, syntax/help and checker fixtures suffice; do not build the entire application unnecessarily.
3. Review the diff, commit and push the working branch. Open a PR for default-branch/homepage changes, satisfy required CI and merge through protection. Check the actual merged commit's CI, not an unrelated successful run.
4. Run `--phase dev` on the delivered checkout. In-progress/missing CI is incomplete; inspect again explicitly later, without checker polling. Do not create a release for development-only work.

## Release preparation

Update together: `apps/desktop/package.json`, `apps/desktop/package-lock.json` top-level and `packages[""]` versions, newest concrete `CHANGELOG.md` section, current release link/prose in `README.md`, baselines in `docs/status.md` and `docs/release.md`, and `apps/desktop/compliance-inventory.json` productVersion/release tag/URL. Do not insert the future release commit into the commit that is meant to identify itself; nullable inventory commit is supported, whereas archive `RELEASE.json` must bind the actual final commit. Preserve accurate Linux-only validation and Windows/macOS limitations. Manually review current-release prose, capabilities, installation links, notices and disclosure; version-string matching alone cannot prove semantic accuracy.

Run repository metadata/hash checks and relevant deterministic tests/builds/smokes as documented. Run `--public` honestly and retain its outcome. Ordinary regression must not silently make paid model calls. Run `--phase prepare` before committing. The checker does not replace `tools/check-repository.mjs` evidence/signoff validation.

## Ordered publication

1. Finish release metadata and concrete notes; complete local release tests and repository checks. If audits remain pending, obtain current explicit Alpha authorization and record the still-open obligations without forging completion.
2. **Commit → push branch → PR → required CI/review → merge** to default `main`. Update the local checkout to the merged commit using ordinary fast-forward synchronization. Verify homepage README from GitHub and green `CI` for that exact merged SHA.
3. Confirm every release input is in this commit and the checkout is clean. **Create and push `vVERSION` at that merged commit**, only after checking no conflicting local/remote tag exists. Never force a tag. If using `Release candidate check`, inspect its workflow first: it validates an existing tag and does **not** upload assets. Its workflow-run `headSha` must match the intended tag commit; dispatch on the tag ref as well as passing the tag input. Preserve and disclose its public-audit failure when applicable; never mislabel it as a successful candidate check.
4. **Clean package** using `node apps/desktop/tools/package-portable.mjs <absolute-new-output-directory>` from repository root. Packaging refuses dirty source and an existing output directory. Use a fresh output outside source; do not recycle an old archive. Confirm `RELEASE.json` binds version and merged/tag commit.
5. **Unpack and smoke the actual portable Electron application**, not only source/dev mode: follow `docs/testing.md` and the archive's `使用说明.md`; use isolated synthetic project/profile data, the real bundled executable and normal sandbox policy. Record launch, rendering, reading/editing and relevant changed workflows. No root/`--no-sandbox` shortcuts, secret-bearing fixtures or automatic paid model calls. Do not claim Windows/macOS validation from Linux results.
6. **Verify checksums** for `Nozeli-VERSION-linux-x64.tar.gz`, `Nozeli-VERSION-source.tar.gz` and `使用说明.md` against `SHA256SUMS.txt`; inspect notices/source boundaries. The source tar is tracked Nozeli source, not automatic satisfaction of all third-party corresponding-source duties.
7. **Create a draft release → explicitly upload these four assets → inspect draft**. Use `gh release create vVERSION --draft --prerelease --verify-tag --repo SeemSeam/nozeli --notes-file <reviewed-notes>` for Alpha, then `gh release upload` with explicit paths. No workflow currently performs public upload. Avoid `--clobber` as a shortcut; investigate mismatches. Notes must describe real changes, validation and pending audits/current authorization.
8. **Publish** only after the preceding evidence and authorization are satisfied (`gh release edit vVERSION --draft=false --prerelease ...` for Alpha). Do not promote Alpha to latest stable merely to satisfy a checker.
9. **Remote verify**: run `--phase published --assets-dir <output>`; inspect release URL/body, exact-SHA CI, remote README, asset names/sizes, download hashes and the packaged binding. The checker downloads only the small remote checksum manifest; independently download the published payloads to a fresh directory and hash them to verify remote bytes. Report version, commit/tag, PR/merge, release URL, tests and unpacked smoke evidence, asset hashes, clean/pushed state, and all unresolved audit or CI failures.

## Interrupted recovery and stop conditions

Start with `prepare` plus `published` for release interruptions, or `dev` for ordinary work. Inspect existing commits, PR, tags, drafts and assets before any mutation. Resume at the first incomplete step; never blindly repeat tag creation or publication.

- Dirty or unpushed work: preserve it, complete the intended commit/push/PR; never reset unrelated user work.
- Missing/failed/pending exact-SHA CI: inspect the specific run and fix the cause via reviewed commits. No unrelated branch/manual run is substitute evidence. A new fix commit normally requires a new release version if the old tag is already published.
- Tag missing: establish the intended merged SHA before creating it. Tag SHA disagreement: stop; never overwrite it. Choose a new version through maintainer decision rather than force-moving a published tag.
- Wrong/stale package: rebuild from clean intended tag in a new output, repeat unpacked smoke and checksum checks. An archive built before merge cannot be relabelled as the merged commit.
- Missing draft/assets: create/resume the draft and upload explicitly after validation. Existing assets with different hashes require investigation, not silent replacement.
- Published but incomplete release: disclose the incomplete state; repair only with authorization and preserved provenance, then reverify remote bytes. Do not declare success because a release page exists.
- Homepage stale: merge docs through a protected PR and verify remote default README; do not move an old release tag for documentation maintenance.
- Audit pending without current Alpha authorization, or missing human review: stop publication, retain pending state and report the exact blocker. Never convert script output to a signoff.

No checker success can override any of these stop conditions.
