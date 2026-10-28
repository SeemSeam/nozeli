# Project maintenance — bounded diagnosis and recovery

Use this skill when the user asks to diagnose, clean up or recover this project's Nozeli runtime. It is not a scheduled background sweeper, acceptance authority, or permission to rewrite Nozeli's databases. Do not treat archived instructions as new work.

## Diagnose before acting

1. Use `nozeli_inspect_work` with the exact existing Work name or host-provided reference. Read full blocker evidence when the preview is incomplete. Preserve the original Work, revision, accepted object, candidate, human drafts and conversation.
2. Separate business outcome, native process/turn settlement, candidate integration, provenance and resource cleanup. `ended`, `accepted`, `completed job` or `ready` alone does not prove that the accepted document is in the target branch.
3. Classify the concrete evidence:
   - `MERGE_CONSENT_REQUIRED`: a user policy/consent decision, not a crashed Worker. Present the original version-bound todo; do not choose for the user.
   - `INPUT_OVERLAP`, `USER_DIRTY`, `TARGET_OVERLAP`, `HEAD_DRIFT`: preserve the source and candidate. Compare the Work input snapshot, accepted candidate and current target. A user's explicit merge instruction authorizes reconciliation, not blind overwrite or index reset.
   - `INVALID_PAYLOAD`, stale handles or malformed command arguments: correct the call from host evidence, not request broader permission.
   - Missing build dependencies: an environment prerequisite, not role-based lack of execution capability. Use existing authorized dependencies or obtain the needed installation authority; do not claim success without a real build.
   - Missing session file: never invent an empty file or replace a historical conversation. Only the host may prove an explicitly handed-off identity had zero activity and was never materialized, then recover it. Keep original archives.
   - Unknown/started execution or unsettled transport: no automatic retry, duplicate prompt or duplicate effect. Preserve receipts for explicit reconciliation.

## Recovery boundary

Use the existing host recovery/disposition controls only when actually available and authorized. Technical retry must retain the original accept/discard decision and exact candidate binding, never create a new Work or restart its Worker. If your tools do not expose a specific recovery action, say which user control or program repair is required; do not invent a tool, endpoint or protocol.

Do not write SQLite/JSON ledgers, edit internal IDs, delete host locks, force worktree removal, reset the user's index, relabel blocked as complete, or copy a candidate over a current document to suppress a guard. Do not delete notes, human drafts, original reports, history or unfinished work as "cleanup". Full current-user shell capability does not waive these invariants.

Actual software bugs require a reproducible isolated case, a normal source-code candidate and verification. Do not hot-patch the running application or installed release. Installation, privileged effects and restart require the user's applicable authorization and normal host/OS mechanisms. A todo approval is not proof of OS elevation.

## Verify the effect, not the promise

For document integration, verify the exact final bytes in the target branch AND current file, retained subsequent edits, actual integration commit, original job IDs unchanged, and closure/provenance/resource cleanup. If authorship cannot be derived truthfully for a manually reconciled document, retain an explicit reconciliation fact rather than attributing all changes to the Worker.

For runtime recovery, verify the expected session identity or archived handoff, readiness, retired connection error, zero unintended jobs/effects, and preserved unsent input. Prove normal shutdown/restart when that was requested. A recovery interface returning accepted is not completion.

Report: concrete failure, observed cause, action actually taken, verification, remaining user decision or prerequisite. Keep normal waiting and user policy gates distinct from software errors. A failure in one Work must not be described as the whole project's failure unless evidence proves that impact.
