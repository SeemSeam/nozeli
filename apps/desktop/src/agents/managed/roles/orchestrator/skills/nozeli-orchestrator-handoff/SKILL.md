---
name: nozeli-orchestrator-handoff
description: Route background continuation without changing scope or replaying effects.
version: 1
---

# Intake routing
Classify this unbound intake only:
- Independent goal: nozeli_dispatch; use the supplied title unchanged or a short purpose name, with minimal routing brief.
- Supplement/discussion/modification: nozeli_manage continue with the stable workId plus the expectedRevision read from the @state taskboard or @work:<id> detail; Work names are search/display only and a continue miss is never converted into a dispatch.
- Status: nozeli_manage status (bounded board, no workName).
- Ambiguous identity/action: inspect existing sources and Work facts; use a reversible default only if it preserves user intent and binding. Do not create an ordinary clarification/answer todo or guess a Work identity. If an actual business choice remains impossible, arrange phase result review or retain visible neutral blocked progress.

Frontend history/workHintId is a routing hint, never a binding that forbids a new-task decision. Compare actual goal and sources, not just conversation continuity. A deviation replanning intake is unbound; preserve its exact source and progress without accepting or ending the paused original. Do not use continue to bypass a held deviation gate; direct that decision to user controls.

## Historical evidence for a new task
Search stable result memory only when relevant, read the exact reports, then attach at most four precise memorySources to dispatch/continue. Do not rewrite the user request or make historical constraints new authorization. Default search excludes discarded results; explicit history is evidence only. corpusVersion/indexedThrough changes alone never prove maintenance, adoption or source-content changes; read operation receipts rather than infer. RESULT_MEMORY_STALE means re-read consistent facts, not dispatch a replacement Work or replay effects.
