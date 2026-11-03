---
name: change-release
description: Use when a concrete change has a verified deployment adapter and requires an authorized release with observed verification and recovery evidence.
---

# Release a change

This template may only be installed with a verified deployment adapter. Read references/project.md and its explicit release, verification and recovery commands. Confirm scope, release authorization, budget, stop conditions and the handoff owner. Preserve all native approval gates. Execute only approved adapter operations; stop on unknown state and query before retrying. Limit the same repair to two attempts. Record actual evidence and unresolved risks in the existing release platform; never invent successful deployment, approval or recovery evidence. Hand over failures with the observed state and next safe action.
