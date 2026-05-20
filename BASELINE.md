# Baseline Declaration

This codebase represents the analyzed baseline state as described in:
- voice-platform-analysis.md

As of this baseline:
- Known bugs exist and are documented
- Known architectural gaps exist and are documented
- No behavior is assumed to be accidental unless explicitly stated

- Dependency versions are controlled via package-lock.json.
- Regenerating the lockfile without explicit instruction is forbidden.

Any change after this point must:
- Map to a specific phase in the execution plan
- Preserve baseline behavior unless explicitly declared otherwise

Do not alter wording.
