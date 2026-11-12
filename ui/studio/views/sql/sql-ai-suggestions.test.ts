import { describe, expect, it } from "vitest";

import type { AdapterIntrospectResult, Column, DataTypeGroup } from "@/data";

import { buildSqlAiSuggestions } from "./sql-ai-suggestions";

function column(args: {
  fkTable?: string;
  group: DataTypeGroup;
  name: string;
  pk?: boolean;
  table: string;
}): Column {
  return {
    datatype: {
      group: args.group,
      isArray: false,
      isNative: true,
      name: args.group,
      options: [],
      schema: "pg_catalog",
    },
    defaultValue: null,
    fkColumn: args.fkTable ? "id" : null,
    fkSchema: args.fkTable ? "public" : null,
    fkTable: args.fkTable ?? null,
    isAutoincrement: false,
    isComputed: false,
    isRequired: false,
    name: args.name,
    nullable: true,
    pkPosition: args.pk ? 1 : null,
    schema: "public",
    table: args.table,
  } as Column;
}

function introspection(
  tables: Record<string, Column[]>,
  schema = "public",
): AdapterIntrospectResult {
  return {
    filterOperators: [],
    query: { parameters: [], sql: "select 1" },
    timezone: "UTC",
    schemas: {
      [schema]: {
        name: schema,
        tables: Object.fromEntries(
          Object.entries(tables).map(([name, columns]) => [
            name,
            {
              columns: Object.fromEntries(columns.map((c) => [c.name, c])),
              name,
              schema,
            },
          ]),
        ),
      },
    },
  } as AdapterIntrospectResult;
}

describe("buildSqlAiSuggestions", () => {
  it("builds questions from real table and column names without calling AI", () => {
    const suggestions = buildSqlAiSuggestions({
      activeSchema: "public",
      introspection: introspection({
        students: [
          column({ group: "numeric", name: "id", pk: true, table: "students" }),
          column({ group: "string", name: "name", table: "students" }),
          column({ group: "datetime", name: "created_at", table: "students" }),
        ],
        enrollments: [
          column({
            group: "numeric",
            name: "id",
            pk: true,
            table: "enrollments",
          }),
          column({
            fkTable: "students",
            group: "numeric",
            name: "student_id",
            table: "enrollments",
          }),
          column({ group: "numeric", name: "grade", table: "enrollments" }),
        ],
      }),
    });

    expect(suggestions).toEqual([
      "Which students have the most enrollments?",
      "How many students were added per month (by created_at)?",
      "What is the average grade in enrollments?",
      "Show 10 rows from students",
      "Show 10 rows from enrollments",
    ]);
  });

  it("limits the number of suggestions", () => {
    const suggestions = buildSqlAiSuggestions({
      activeSchema: "public",
      introspection: introspection({
        a: [column({ group: "string", name: "x", table: "a" })],
        b: [column({ group: "string", name: "x", table: "b" })],
        c: [column({ group: "string", name: "x", table: "c" })],
      }),
      limit: 2,
    });

    expect(suggestions).toEqual(["Show 10 rows from a", "Show 10 rows from b"]);
  });

  it("returns no suggestions when the active schema has no tables", () => {
    expect(
      buildSqlAiSuggestions({
        activeSchema: "missing",
        introspection: introspection({}),
      }),
    ).toEqual([]);
  });
});
