---
"@prisma/studio-core": minor
---

Add an optional database Activity view. Adapters can expose `activity` (sessions snapshot and statement cancel), and the Studio BFF client supports it with `activity: true`. Studio then shows who is connected, what each session is running, and lets users cancel a runaway statement after confirming.
