import type { Executor } from "../../../data/executor";
import { asQuery } from "../../../data/query";
import { STUDIO_SQL_MARKER } from "./pg-activity";
import { SetupError } from "./setup-error";

export interface TableReplicaIdentity {
  schema: string;
  name: string;
  /** True when updates and deletes carry the whole previous row. */
  full: boolean;
}

function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/**
 * Tables whose history can include previous values: those with a primary
 * key (published with the default replica identity) and those already set
 * to REPLICA IDENTITY FULL.
 */
export async function listReplicaIdentities(
  executor: Executor,
): Promise<TableReplicaIdentity[]> {
  const [error, rows] = await executor.execute(
    asQuery<{ schema: string; name: string; full: boolean }>(
      `select ${STUDIO_SQL_MARKER} n.nspname as schema,
              c.relname as name,
              c.relreplident = 'f' as full
         from pg_class c
         join pg_namespace n on n.oid = c.relnamespace
        where c.relkind = 'r'
          and not c.relispartition
          and n.nspname not in ('pg_catalog', 'information_schema')
          and n.nspname not like 'pg\\_%'
          and (
            c.relreplident = 'f'
            or (c.relreplident = 'd' and exists (
              select 1 from pg_index i where i.indrelid = c.oid and i.indisprimary
            ))
          )
        order by 1, 2`,
    ),
  );

  if (error) throw error;

  return rows.map((row) => ({
    full: Boolean(row.full),
    name: row.name,
    schema: row.schema,
  }));
}

/**
 * Switches one table between REPLICA IDENTITY FULL (history keeps the
 * previous row of every update and delete, at the cost of a larger WAL) and
 * the default (only key columns). Only tables returned by
 * `listReplicaIdentities` can be changed.
 */
export async function setReplicaIdentity(
  executor: Executor,
  table: { schema: string; name: string },
  full: boolean,
): Promise<TableReplicaIdentity> {
  const known = (await listReplicaIdentities(executor)).find(
    (candidate) =>
      candidate.schema === table.schema && candidate.name === table.name,
  );

  if (!known) {
    throw new SetupError(
      "permission",
      `${table.schema}.${table.name} is not a table with a primary key in this database.`,
    );
  }

  const [error] = await executor.execute(
    asQuery(
      `alter ${STUDIO_SQL_MARKER} table ${quoteIdent(table.schema)}.${quoteIdent(
        table.name,
      )} replica identity ${full ? "full" : "default"}`,
    ),
  );

  if (error) {
    throw new SetupError(
      "permission",
      `Could not change ${table.schema}.${table.name}: ${error.message}`,
    );
  }

  return { ...known, full };
}
