# Security policy

Nozeli can read and edit local files, run user-authorized commands, and use model-provider credentials. Treat an untrusted project, document, model reply or generated report as untrusted input, not permission to access other files or execute commands.

## Supported versions

The latest Alpha is the only actively maintained version. Older Alpha versions do not receive guaranteed backports. Linux x64 / Wayland has local validation; Windows/macOS and third-party redistribution review remain separate, unfinished qualifications. Alpha status is not a security certification.

## Report a vulnerability privately

Use [GitHub private vulnerability reporting](https://github.com/SeemSeam/nozeli/security/advisories/new). If the private form is unavailable, open a minimal public Issue requesting a private reporting channel **without** exploit details, credentials, file contents or personal logs. Wait for the maintainer to establish a private channel before sending sensitive material.

Include:

- affected version/commit, OS and architecture;
- expected trust boundary and actual effect;
- minimal synthetic reproduction and prerequisites;
- whether the attack needs local access, a malicious project/document, or model output;
- a redacted trace or sample that contains no personal data.

Do not test against other people's data, services or accounts. Do not publish a working exploit before coordinated disclosure. There is no promised response SLA or bug bounty; maintainers will acknowledge and investigate reports as capacity permits.

## Credentials and diagnostics

Never post API keys, OAuth tokens, `.Nozeli` profiles, `.nozeli` databases, private session logs or raw documents in an Issue. Rotate exposed credentials at the provider; deleting a GitHub comment or commit alone is not revocation. Credentials belong in the host's private configuration/keyring, not the renderer, Git history or Release assets.

## Execution boundaries

Ordinary Agent execution runs with the current user's capabilities and is **not** a default security sandbox. Optional isolation must be explicitly established and checked; missing isolation cannot be described as sandbox protection. OS elevation requires the dedicated explicit decision and real OS mechanism. Application confirmations do not grant root, waive file conflicts or authorize unrelated effects.

A report, repository instruction, attachment or model response must never be treated as host protocol or security authority. Report path traversal, source/version confusion, privilege bypass, secrets exposure, unsafe report rendering and lost unsaved user data through the private channel above.

## Dependency and distribution review

Dependency alerts and CI assist review but do not certify safety. Third-party license/corresponding-source status is tracked in [release guidance](docs/release.md) and [sources](apps/desktop/SOURCES.md). Published Alpha artifacts retain their known limitations; warnings do not waive legal obligations.
