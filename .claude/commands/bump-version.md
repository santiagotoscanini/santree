---
description: Bump package.json version (patch or minor) and refresh the lockfile
allowed-tools: Read, Edit, Bash(npm install)
argument-hint: "[patch|minor]"
---

Bump the version in `package.json` and refresh `package-lock.json`.

Argument: `$ARGUMENTS`

Bump level rules (interpret `$ARGUMENTS`, trimmed, case-insensitive):

- `patch` (or empty / unspecified): `MAJOR.MINOR.PATCH` → `MAJOR.MINOR.(PATCH+1)`. Example: `0.2.15` → `0.2.16`.
- `minor`: `MAJOR.MINOR.PATCH` → `MAJOR.(MINOR+1).0` (patch resets to 0). Example: `0.2.15` → `0.3.0`.
- Anything else: stop, report the invalid input, do NOT modify any files.

Steps:

1. Read `package.json`.
2. Parse `"version"` as semver `MAJOR.MINOR.PATCH`. If malformed, stop and report.
3. Compute the new version per the rules above.
4. Use Edit to change only the `"version"` line in `package.json`.
5. Run `npm install` so `package-lock.json` picks up the new version.
6. Report: `<old> → <new>` and which level (`patch` or `minor`) was applied.

Do NOT commit or push. Do NOT handle `major` — if asked, stop and ask the user to confirm they want a major bump explicitly.
