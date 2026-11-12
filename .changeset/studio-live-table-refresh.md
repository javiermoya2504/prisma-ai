---
"@prisma/studio-core": minor
---

Tables stay in sync with the database when a `prisma-wal` stream is available: the open table shows a "Live" badge and reloads when its rows change, waiting while a cell is being edited or changes are staged.
