---
"@prisma/studio-core": patch
---

Local app: saved PostgreSQL connections can turn on live change history, streaming every committed insert, update, and delete into a per-connection `prisma-wal` stream so Studio's table and row history works on your own databases.
