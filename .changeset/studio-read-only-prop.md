---
"@prisma/studio-core": minor
---

Add an optional `readOnly` prop to `Studio` that disables cell editing and paste, hides Insert row and row deletion, and shows a "Read-only" badge on tables. The local app uses it for read-only connections and adds one-click backups that restore into a new database.
