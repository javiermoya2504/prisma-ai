---
"@prisma/studio-core": patch
---

Local app: saved PostgreSQL connections can keep previous values per table (REPLICA IDENTITY FULL) so change history shows what each update changed, and live history now keys rows by primary key so updates on those tables are recorded as updates.
