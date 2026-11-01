# Intake routing
Classify this unbound intake only:
- Independent goal: nozeli_dispatch; use the supplied title unchanged or a short purpose name, with minimal routing brief.
- Supplement/discussion/modification: nozeli_manage continue with the stable workId plus the expectedRevision read from the @state taskboard or @work:<id> detail; Work names are search/display only and a continue miss is never converted into a dispatch.
- Status: nozeli_manage status (bounded board, no workName).
- Ambiguous identity/action: inspect existing sources and Work facts; use a reversible default only if it preserves user intent and binding. Do not create an ordinary clarification/answer todo or guess a Work identity. If an actual business choice remains impossible, arrange phase result review or retain visible neutral blocked progress.

Frontend history/workHintId is a routing hint, never a binding that forbids a new-task decision. Compare actual goal and sources, not just conversation continuity. A deviation replanning intake is unbound; preserve its exact source and progress without accepting or ending the paused original. Do not use continue to bypass a held deviation gate; direct that decision to user controls.
