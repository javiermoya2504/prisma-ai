import { describe, expect, it } from "vitest";

import type { Column, Table } from "../../../data/adapter";
import {
  buildAssistantPrompt,
  buildAssistantSuggestions,
  describeAssistantContext,
  parseAssistantReply,
} from "./assistant-prompt";

function column(table: string, name: string, extra: Partial<Column> = {}) {
  return {
    datatype: {
      group: "numeric",
      isArray: false,
      isNative: true,
      name: "int4",
      options: [],
      schema: "pg_catalog",
    },
    defaultValue: null,
    fkColumn: null,
    fkSchema: null,
    fkTable: null,
    isAutoincrement: false,
    isComputed: false,
    isRequired: true,
    name,
    nullable: false,
    pkPosition: null,
    schema: "public",
    table,
    ...extra,
  } as Column;
}

const students: Table = {
  columns: {
    id: column("students", "id", { pkPosition: 1 }),
    name: column("students", "name", {
      datatype: { ...column("s", "x").datatype, group: "string", name: "text" },
      nullable: true,
    }),
  },
  name: "students",
  schema: "public",
};
const grades: Table = {
  columns: {
    id: column("grades", "id", { pkPosition: 1 }),
    student_id: column("grades", "student_id", {
      fkColumn: "id",
      fkSchema: "public",
      fkTable: "students",
    }),
  },
  name: "grades",
  schema: "public",
};
const introspection = {
  schemas: { public: { name: "public", tables: { grades, students } } },
  timezone: "UTC",
};
const base = {
  activeSchema: "public",
  dialect: "postgresql" as const,
  history: [],
  introspection,
  now: new Date("2026-11-12T10:00:00Z"),
};

describe("buildAssistantPrompt", () => {
  it("tells the model the user is looking at the ERD in the Visualizer", () => {
    const prompt = buildAssistantPrompt({
      ...base,
      context: { kind: "visualizer", schema: "public" },
      question: "¿Cómo se relacionan estas tablas?",
    });

    expect(prompt).toContain("entity-relationship diagram (ERD)");
    expect(prompt).toContain("student_id: int4 [FK → public.students.id]");
    expect(prompt).toContain(
      "Questions about the structure or the diagram need no query.",
    );
    expect(prompt).toContain(
      "User question: ¿Cómo se relacionan estas tablas?",
    );
  });

  it("describes the open table with its columns and the tables that reference it", () => {
    const prompt = buildAssistantPrompt({
      ...base,
      context: { kind: "table", table: students },
      question: "¿Para qué sirve esta tabla?",
    });

    expect(prompt).toContain("The user has the table public.students open");
    expect(prompt).toContain("  - id: int4 [PK]");
    expect(prompt).toContain("  - name: text [nullable]");
    expect(prompt).toContain(
      "Referenced by: public.grades.student_id → students.id",
    );
  });

  it("includes the SQL editor content and the recent conversation", () => {
    const prompt = buildAssistantPrompt({
      ...base,
      context: {
        editorSql: "select * from students",
        kind: "sql",
        schema: "public",
      },
      history: [
        { content: "How many students?", role: "user" },
        {
          content: "Run this query.",
          role: "assistant",
          sql: "select count(*) from students",
        },
      ],
      question: "Explain this query",
    });

    expect(prompt).toContain("Current editor content");
    expect(prompt).toContain("select * from students");
    expect(prompt).toContain("User: How many students?");
    expect(prompt).toContain("SQL: select count(*) from students");
  });
});

describe("parseAssistantReply", () => {
  it("reads the JSON reply, also inside fences", () => {
    expect(
      parseAssistantReply(
        '```json\n{"answer":"Run it.","sql":"select 1","shouldGenerateVisualization":true}\n```',
      ),
    ).toEqual({
      answer: "Run it.",
      shouldGenerateVisualization: true,
      sql: "select 1",
    });
    expect(
      parseAssistantReply('{"answer":"grades points to students.","sql":null}'),
    ).toEqual({
      answer: "grades points to students.",
      shouldGenerateVisualization: false,
      sql: null,
    });
  });

  it("shows a plain-text reply as the answer instead of failing", () => {
    expect(parseAssistantReply("Students have many grades.")).toEqual({
      answer: "Students have many grades.",
      shouldGenerateVisualization: false,
      sql: null,
    });
  });
});

describe("context helpers", () => {
  it("labels the context and suggests questions that fit it", () => {
    expect(describeAssistantContext({ kind: "table", table: students })).toBe(
      "Table · public.students",
    );
    expect(
      buildAssistantSuggestions(
        { kind: "visualizer", schema: "public" },
        introspection,
      ),
    ).toContain("Which tables are connected to students, and how?");
    expect(
      buildAssistantSuggestions(
        { kind: "table", table: students },
        introspection,
      )[0],
    ).toContain("students");
  });
});
