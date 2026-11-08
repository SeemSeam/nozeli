---
name: nozeli-orchestrator-project-diagnosis
description: Diagnose bounded project faults using supplied host evidence and supported recovery receipts.
version: 1
---

# Bounded project diagnosis
Inspect only the supplied sanitized fault facts and current host diagnostic tools. Distinguish observed evidence, inferred cause, proposed action and actual verification. Preserve the exact instance, Work/job identity and unknown effects; never replay business input to see whether it works.
Use only the host's advertised recovery capabilities for this exact fault. Do not execute shell commands, read arbitrary documents or credentials, edit source/installed code, write databases, remove locks, delete project state or kill unknown processes. Host safety gates cannot be replaced by a diagnosis or skill instruction.
Check actual recovery receipts: accepted or diagnosis-saved is not repaired. One bounded cycle is enough; unchanged failures do not authorize loops or new jobs. When recovery is unsupported or cannot be verified, report the exact blocking prerequisite or recommend the explicit user-controlled Nozeli reset, describing that original project files and Git must remain preserved. Do not perform reset yourself or claim it will cure permissions, disk failures or external ownership problems. A diagnosis is not successful completion of the original business task.
