# Roadmap and acceptance boundaries

This is a qualification roadmap, not a claim that an unchecked platform or feature works. Current user-visible capability and limitations are in [status](status.md); contributions follow [CONTRIBUTING](../CONTRIBUTING.md).

## Current engineering baseline

- Deterministic default tests, an explicit native-runtime suite, and credential-free actual-Electron smoke.
- Linux clean-build CI for pinned Office/private-OMP/renderer inputs, with readable failure evidence.
- Version-bound file/review operations, privacy-preserving synthetic fixtures and a single workspace Diff.
- Private vulnerability reports, dependency alerts, and a public-release metadata gate that blocks unsigned distribution obligations.

## Release qualification still open

1. Resolve [dependency security triage](https://github.com/SeemSeam/nozeli/issues/4) with reachability analysis, patched dependencies, native rebuilds and actual report/rendering/exit regressions. Alerts are not silently suppressed.
2. Complete the evidence and corresponding-source delivery listed in [release guidance](release.md) and the [compliance inventory](../apps/desktop/compliance-inventory.json). A green CI check is not a legal audit.
3. Validate packaging and upgrades on additional Linux distributions and X11, including sandbox prerequisites, optional tools, backup/recovery and desktop integration.
4. Add Windows and macOS build/runtime paths, then run native dialogs, file handling, permissions, process shutdown, split/detached windows and restore scenarios **on those platforms**. Linux test success alone cannot close this item.
5. Extend release provenance from the locked npm dependency inventory to the full bundled native/vendor closure, then document the verification and source-delivery procedure with each release.

## Contribution scope

Prefer reproducible bugs, user-work preservation, conflict/permission boundaries, format fidelity and accessibility improvements over new orchestration layers. For larger features, start with an Issue explaining the workflow and acceptance criteria. No fixed dates or unsupported platform badges are promised here.
