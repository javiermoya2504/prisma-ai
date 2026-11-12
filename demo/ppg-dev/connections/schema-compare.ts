import type { AdapterIntrospectResult, Column } from "../../../data/adapter";

/**
 * Turns one schema of a Studio introspection (any database kind) into the
 * contract document `SchemaDiff` renders, so two live databases can be
 * compared with the same canvas the Migrations view uses.
 *
 * Models are named after their tables, without the schema, so the same
 * table in differently named schemas (MySQL databases, `public` vs `app`)
 * is matched across the two sides.
 */
export function introspectionToContract(
  introspection: Pick<AdapterIntrospectResult, "schemas">,
  schemaName: string,
): Record<string, unknown> {
  const schema = introspection.schemas[schemaName];
  const models: Record<string, unknown> = {};
  const enums: Record<string, unknown> = {};
  const tables: Record<string, unknown> = {};

  for (const table of Object.values(schema?.tables ?? {})) {
    const columns = Object.values(table.columns);
    const fields: Record<string, unknown> = {};
    const fieldColumns: Record<string, unknown> = {};
    const storageColumns: Record<string, unknown> = {};
    const relations: Record<string, unknown> = {};

    for (const column of columns) {
      const enumName = enumNameOf(column);

      if (enumName) {
        enums[enumName] = {
          members: column.datatype.options.map((name) => ({ name })),
        };
      }

      fields[column.name] = {
        nullable: column.nullable,
        type: { codecId: null },
        ...(enumName ? { valueSet: { entityName: enumName } } : {}),
      };
      fieldColumns[column.name] = { column: column.name };
      storageColumns[column.name] = {
        default:
          column.defaultValue == null
            ? null
            : { expression: column.defaultValue, kind: "function" },
        nativeType: nativeTypeOf(column),
        nullable: column.nullable,
      };

      // Only relations inside the compared schema can point at a model.
      if (column.fkTable && column.fkSchema === schemaName) {
        relations[column.name] = {
          cardinality: "N:1",
          to: { model: column.fkTable },
        };
      }
    }

    const primaryKey = columns
      .filter((column) => column.pkPosition != null)
      .sort((left, right) => left.pkPosition! - right.pkPosition!)
      .map((column) => column.name);

    models[table.name] = {
      fields,
      relations,
      storage: { fields: fieldColumns, table: table.name },
    };
    tables[table.name] = {
      columns: storageColumns,
      ...(primaryKey.length > 0 ? { primaryKey: { columns: primaryKey } } : {}),
    };
  }

  return {
    domain: { namespaces: { [schemaName]: { enum: enums, models } } },
    storage: {
      namespaces: { [schemaName]: { entries: { table: tables } } },
    },
  };
}

function enumNameOf(column: Column): string | null {
  return column.datatype.group === "enum" && column.datatype.options.length > 0
    ? column.datatype.name
    : null;
}

function nativeTypeOf(column: Column): string {
  const { isArray, name } = column.datatype;
  return isArray && !name.endsWith("[]") ? `${name}[]` : name;
}

/** The schema to preselect: the one named like the other side, else the first. */
export function defaultSchemaName(
  schemas: string[],
  preferred: string | null | undefined,
): string | null {
  if (preferred && schemas.includes(preferred)) return preferred;
  if (schemas.includes("public")) return "public";
  if (schemas.includes("main")) return "main";
  return schemas[0] ?? null;
}
