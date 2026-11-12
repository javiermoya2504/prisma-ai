import { describe, expect, it } from "vitest";

import type { Column, Table } from "../../../data/adapter";
import { diffContracts } from "../../../ui/schema-diff/contract-diff";
import { defaultSchemaName, introspectionToContract } from "./schema-compare";

function column(
  schema: string,
  table: string,
  name: string,
  overrides: Partial<Column> & { type?: string } = {},
): Column {
  const { type = "int4", ...rest } = overrides;
  return {
    datatype: {
      group: "numeric",
      isArray: false,
      isNative: true,
      name: type,
      options: [],
      schema: "pg_catalog",
    },
    defaultValue: null,
    fkColumn: null,
    fkSchema: null,
    fkTable: null,
    isAutoincrement: false,
    isComputed: false,
    isRequired: false,
    name,
    nullable: true,
    pkPosition: null,
    schema,
    table,
    ...rest,
  } as Column;
}

function table(schema: string, name: string, columns: Column[]): Table {
  return {
    columns: Object.fromEntries(columns.map((item) => [item.name, item])),
    name,
    schema,
  };
}

function introspection(schema: string, tables: Table[]) {
  return {
    schemas: {
      [schema]: {
        name: schema,
        tables: Object.fromEntries(tables.map((item) => [item.name, item])),
      },
    },
  };
}

describe("introspectionToContract", () => {
  const dev = introspection("public", [
    table("public", "students", [
      column("public", "students", "id", { nullable: false, pkPosition: 1 }),
      column("public", "students", "name", { type: "text" }),
      column("public", "students", "email", { type: "text" }),
    ]),
    table("public", "grades", [
      column("public", "grades", "id", { nullable: false, pkPosition: 1 }),
      column("public", "grades", "student_id", {
        fkColumn: "id",
        fkSchema: "public",
        fkTable: "students",
      }),
      column("public", "grades", "status", {
        datatype: {
          group: "enum",
          isArray: false,
          isNative: false,
          name: "grade_status",
          options: ["draft", "final"],
          schema: "public",
        },
      }),
    ]),
  ]);
  // "Production": a MySQL-like schema with another name, an older shape.
  const prod = introspection("school_prod", [
    table("school_prod", "students", [
      column("school_prod", "students", "id", {
        nullable: false,
        pkPosition: 1,
      }),
      column("school_prod", "students", "name", {
        nullable: false,
        type: "varchar",
      }),
    ]),
    table("school_prod", "legacy_notes", [
      column("school_prod", "legacy_notes", "id", { pkPosition: 1 }),
    ]),
  ]);

  it("matches tables across differently named schemas and reports added, removed and changed columns", () => {
    const diff = diffContracts(
      introspectionToContract(prod, "school_prod"),
      introspectionToContract(dev, "public"),
    );
    const byName = new Map(diff.models.map((model) => [model.name, model]));

    expect(byName.get("grades")?.status).toBe("added");
    expect(byName.get("legacy_notes")?.status).toBe("removed");

    const students = byName.get("students");
    expect(students?.status).toBe("changed");
    const fields = new Map(
      students!.fields.map((field) => [field.name, field]),
    );
    expect(fields.get("id")?.status).toBe("unchanged");
    expect(fields.get("id")?.field.isPrimaryKey).toBe(true);
    expect(fields.get("email")?.status).toBe("added");
    expect(fields.get("name")?.details).toEqual([
      { after: "text", aspect: "type", before: "varchar" },
      { after: "optional", aspect: "nullable", before: "required" },
    ]);
  });

  it("keeps foreign keys as relations and enum columns as enums", () => {
    const diff = diffContracts(null, introspectionToContract(dev, "public"));
    const grades = diff.models.find((model) => model.name === "grades");

    expect(grades?.relations).toEqual([
      { cardinality: "N:1", name: "student_id", toModel: "students" },
    ]);
    expect(diff.enums).toEqual([
      expect.objectContaining({ name: "grade_status", status: "added" }),
    ]);
  });

  it("compares identical schemas as unchanged", () => {
    const contract = introspectionToContract(dev, "public");
    const diff = diffContracts(
      contract,
      introspectionToContract(dev, "public"),
    );
    expect(diff.models.every((model) => model.status === "unchanged")).toBe(
      true,
    );
  });
});

describe("defaultSchemaName", () => {
  it("prefers the other side's schema, then public/main, then the first", () => {
    expect(defaultSchemaName(["app", "public"], "app")).toBe("app");
    expect(defaultSchemaName(["app", "public"], "school")).toBe("public");
    expect(defaultSchemaName(["main"], null)).toBe("main");
    expect(defaultSchemaName(["grades_ai"], null)).toBe("grades_ai");
    expect(defaultSchemaName([], null)).toBeNull();
  });
});

describe("defaultCompareTarget", () => {
  it("prefers another saved connection of the same kind", async () => {
    const { defaultCompareTarget } = await import("./CompareSchemaDialog");
    const connections = [
      { id: "demo", kind: "postgres", source: "demo" },
      { id: "lite", kind: "sqlite", source: "saved" },
      { id: "prod", kind: "postgres", source: "saved" },
      { id: "dev", kind: "postgres", source: "saved" },
    ] as const;

    expect(defaultCompareTarget([...connections], "prod")).toBe("dev");
    expect(defaultCompareTarget([...connections], "lite")).toBe("demo");
    expect(defaultCompareTarget([connections[0]], "demo")).toBe("demo");
  });
});
