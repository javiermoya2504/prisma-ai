import { describe, expect, it, vi } from "vitest";

import type { AdapterIntrospectResult } from "@/data";

import {
  buildAiSqlGenerationContext,
  buildAiSqlGenerationPrompt,
  resolveAiSqlGeneration,
} from "./sql-ai-generation";

function createIntrospectionFixture(): AdapterIntrospectResult {
  return {
    filterOperators: [],
    query: { parameters: [], sql: "select 1" },
    timezone: "UTC",
    schemas: {
      public: {
        name: "public",
        tables: {
          organizations: {
            columns: {
              id: {
                datatype: {
                  group: "string",
                  isArray: false,
                  isNative: true,
                  name: "uuid",
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
                name: "id",
                nullable: false,
                pkPosition: 1,
                schema: "public",
                table: "organizations",
              },
              name: {
                datatype: {
                  group: "string",
                  isArray: false,
                  isNative: true,
                  name: "text",
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
                name: "name",
                nullable: true,
                pkPosition: null,
                schema: "public",
                table: "organizations",
              },
            },
            name: "organizations",
            schema: "public",
          },
          incidents: {
            columns: {},
            name: "incidents",
            schema: "public",
          },
        },
      },
    },
  };
}

describe("sql-ai-generation", () => {
  it("bounds SQL generation schema context before prompting the model", () => {
    const context = buildAiSqlGenerationContext({
      activeSchema: "public",
      dialect: "postgresql",
      introspection: createIntrospectionFixture(),
      maxColumnsPerTable: 1,
      maxTables: 1,
    });

    expect(context.tables).toHaveLength(1);
    expect(context.tables[0]?.columns).toHaveLength(1);
  });

  it("includes the concrete database engine in the SQL generation prompt", () => {
    const prompt = buildAiSqlGenerationPrompt({
      context: buildAiSqlGenerationContext({
        activeSchema: "public",
        dialect: "postgresql",
        introspection: createIntrospectionFixture(),
      }),
      now: new Date("2026-03-18T00:00:00.000Z"),
      request: "show me organizations",
    });

    expect(prompt).toContain("Database engine: PostgreSQL");
    expect(prompt).toContain(
      "Use only functions, operators, and casts supported by PostgreSQL.",
    );
    expect(prompt).toContain('"shouldGenerateVisualization":true');
    expect(prompt).toContain(
      "Decide whether the resulting dataset would make an interesting chart.",
    );
  });

  it("asks the model to map synonyms and other languages to real table names", () => {
    const prompt = buildAiSqlGenerationPrompt({
      context: buildAiSqlGenerationContext({
        activeSchema: "public",
        dialect: "postgresql",
        introspection: createIntrospectionFixture(),
      }),
      request: "dame la tabla organizaciones",
    });

    expect(prompt).toContain(
      'The user may write in any language or use synonyms, singular/plural variants, or translations of table and column names. Map those words to the closest listed table or column (for example, "estudiantes" or "student" should map to a listed "students" table).',
    );
    expect(prompt).toContain(
      "Write the rationale in the same language as the user request.",
    );
  });

  it("asks for a rationale that teaches how the SQL works", () => {
    const prompt = buildAiSqlGenerationPrompt({
      context: buildAiSqlGenerationContext({
        activeSchema: "public",
        dialect: "postgresql",
        introspection: createIntrospectionFixture(),
      }),
      request: "show me organizations",
    });

    expect(prompt).toContain(
      "In the rationale, say which real tables and columns you used when they differ from the user's words, then briefly explain what each main clause does (FROM, JOIN, WHERE, GROUP BY, ORDER BY, LIMIT) so the user learns SQL. Keep it under 80 words.",
    );
  });

  it("includes failed SQL and database errors when correcting generated SQL", async () => {
    const aiGenerateSql = vi
      .fn<(prompt: string) => Promise<string>>()
      .mockResolvedValue(
        JSON.stringify({
          rationale: "Uses the correct grouped expression.",
          sql: "select o.name, skill, count(*) from public.organizations o left join public.team_members tm on o.id = tm.organization_id cross join lateral unnest(tm.skills) as skill group by o.id, o.name, skill;",
          shouldGenerateVisualization: true,
        }),
      );

    await resolveAiSqlGeneration({
      activeSchema: "public",
      requestAiSqlGeneration: aiGenerateSql,
      dialect: "postgresql",
      introspection: createIntrospectionFixture(),
      previousSql:
        "select tm.skills, count(*) from public.team_members tm group by skill;",
      queryErrorMessage:
        'column "tm.skills" must appear in the GROUP BY clause or be used in an aggregate function',
      request: "show team members by skill",
    });

    expect(aiGenerateSql).toHaveBeenCalledTimes(1);
    expect(aiGenerateSql.mock.calls[0]?.[0]).toContain(
      "Correct the previous SQL so it runs successfully",
    );
    expect(aiGenerateSql.mock.calls[0]?.[0]).toContain(
      "Previous SQL statement: select tm.skills, count(*) from public.team_members tm group by skill;",
    );
    expect(aiGenerateSql.mock.calls[0]?.[0]).toContain(
      'Database error from that SQL: column "tm.skills" must appear in the GROUP BY clause or be used in an aggregate function',
    );
  });

  it("retries once when the AI response is not valid JSON and then returns parsed SQL", async () => {
    const aiGenerateSql = vi
      .fn<(prompt: string) => Promise<string>>()
      .mockResolvedValueOnce("select * from public.organizations;")
      .mockResolvedValueOnce(
        JSON.stringify({
          rationale: "Matched the organizations table.",
          sql: "select * from public.organizations limit 5;",
          shouldGenerateVisualization: true,
        }),
      );

    const result = await resolveAiSqlGeneration({
      activeSchema: "public",
      requestAiSqlGeneration: aiGenerateSql,
      dialect: "postgresql",
      introspection: createIntrospectionFixture(),
      request: "show me organizations",
    });

    expect(aiGenerateSql).toHaveBeenCalledTimes(2);
    expect(result.didRetry).toBe(true);
    expect(result.sql).toBe("select * from public.organizations limit 5;");
    expect(result.rationale).toBe("Matched the organizations table.");
    expect(result.shouldGenerateVisualization).toBe(true);
  });

  it("accepts JSON wrapped in markdown fences without requiring a retry", async () => {
    const aiGenerateSql = vi
      .fn<(prompt: string) => Promise<string>>()
      .mockResolvedValue(
        [
          "```json",
          JSON.stringify({
            rationale: "Matched the organizations table.",
            sql: "select * from public.organizations limit 5;",
            shouldGenerateVisualization: false,
          }),
          "```",
        ].join("\n"),
      );

    const result = await resolveAiSqlGeneration({
      activeSchema: "public",
      requestAiSqlGeneration: aiGenerateSql,
      dialect: "postgresql",
      introspection: createIntrospectionFixture(),
      request: "show me organizations",
    });

    expect(aiGenerateSql).toHaveBeenCalledTimes(1);
    expect(result.didRetry).toBe(false);
    expect(result.sql).toBe("select * from public.organizations limit 5;");
    expect(result.rationale).toBe("Matched the organizations table.");
    expect(result.shouldGenerateVisualization).toBe(false);
  });

  it("returns visualization intent with the generated SQL without executing it", async () => {
    const aiGenerateSql = vi
      .fn<(prompt: string) => Promise<string>>()
      .mockResolvedValue(
        JSON.stringify({
          rationale: "Counts by organization chart well.",
          sql: "select id, name from public.organizations limit 5;",
          shouldGenerateVisualization: true,
        }),
      );

    const result = await resolveAiSqlGeneration({
      activeSchema: "public",
      requestAiSqlGeneration: aiGenerateSql,
      dialect: "postgresql",
      introspection: createIntrospectionFixture(),
      request: "show me organizations",
    });

    expect(aiGenerateSql).toHaveBeenCalledTimes(1);
    expect(result.sql).toBe(
      "select id, name from public.organizations limit 5;",
    );
    expect(result.rationale).toBe("Counts by organization chart well.");
    expect(result.shouldGenerateVisualization).toBe(true);
  });
});
