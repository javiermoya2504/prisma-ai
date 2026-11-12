import type {
  AdapterIntrospectResult,
  SqlEditorDialect,
  Table,
} from "../../../data/adapter";
import { normalizeAiJsonResponseText } from "../views/sql/ai-json-response";
import {
  formatPromptLocalDateTime,
  getDatabaseEngineName,
  getDialectSpecificPromptRules,
} from "../views/sql/sql-ai-generation";
import { buildSqlAiSuggestions } from "../views/sql/sql-ai-suggestions";

const MAX_SCHEMA_TABLES = 80;
const MAX_COLUMNS_PER_TABLE = 40;
const MAX_HISTORY_MESSAGES = 8;
const MAX_HISTORY_MESSAGE_CHARS = 1_500;
const MAX_EDITOR_SQL_CHARS = 4_000;

/** Where the user is in Studio when they ask. */
export type AssistantContext =
  | { kind: "visualizer"; schema: string }
  | { kind: "table"; table: Table }
  | { kind: "sql"; editorSql: string | null; schema: string }
  | { kind: "stream"; streamName: string }
  | { kind: "view"; viewName: string; schema: string };

export interface AssistantMessage {
  role: "user" | "assistant";
  content: string;
  sql?: string | null;
}

export interface AssistantReply {
  answer: string;
  sql: string | null;
  shouldGenerateVisualization: boolean;
}

/** Short label for the context chip in the panel header. */
export function describeAssistantContext(context: AssistantContext): string {
  switch (context.kind) {
    case "visualizer":
      return `Visualizer · ${context.schema}`;
    case "table":
      return `Table · ${context.table.schema}.${context.table.name}`;
    case "sql":
      return "SQL editor";
    case "stream":
      return `Stream · ${context.streamName}`;
    case "view":
      return context.viewName;
  }
}

function columnLine(table: Table, columnName: string): string {
  const column = table.columns[columnName]!;
  const flags = [
    column.pkPosition != null ? "PK" : null,
    column.nullable ? "nullable" : null,
    column.defaultValue ? `default ${column.defaultValue}` : null,
    column.fkTable
      ? `FK → ${column.fkSchema}.${column.fkTable}.${column.fkColumn}`
      : null,
    column.datatype.group === "enum" && column.datatype.options.length > 0
      ? `enum(${column.datatype.options.join(", ")})`
      : null,
  ].filter(Boolean);

  return `  - ${column.name}: ${column.datatype.name}${
    flags.length > 0 ? ` [${flags.join("; ")}]` : ""
  }`;
}

function schemaLines(
  introspection: Pick<AdapterIntrospectResult, "schemas">,
  activeSchema: string,
): string[] {
  const schemas = Object.values(introspection.schemas).sort((left, right) =>
    left.name === activeSchema ? -1 : right.name === activeSchema ? 1 : 0,
  );
  const lines: string[] = [];
  let tableCount = 0;

  for (const schema of schemas) {
    for (const table of Object.values(schema.tables)) {
      if (tableCount >= MAX_SCHEMA_TABLES) {
        lines.push("- (more tables omitted)");
        return lines;
      }

      lines.push(`- ${table.schema}.${table.name}`);
      lines.push(
        ...Object.keys(table.columns)
          .slice(0, MAX_COLUMNS_PER_TABLE)
          .map((name) => columnLine(table, name)),
      );
      tableCount += 1;
    }
  }

  return lines;
}

/** Tables whose foreign keys point at `table`. */
function referencingTables(
  introspection: Pick<AdapterIntrospectResult, "schemas">,
  table: Table,
): string[] {
  const references: string[] = [];

  for (const schema of Object.values(introspection.schemas)) {
    for (const candidate of Object.values(schema.tables)) {
      for (const column of Object.values(candidate.columns)) {
        if (column.fkTable === table.name && column.fkSchema === table.schema) {
          references.push(
            `${candidate.schema}.${candidate.name}.${column.name} → ${table.name}.${column.fkColumn}`,
          );
        }
      }
    }
  }

  return references;
}

function contextLines(
  context: AssistantContext,
  introspection: Pick<AdapterIntrospectResult, "schemas">,
): string[] {
  switch (context.kind) {
    case "visualizer":
      return [
        `The user is looking at the Visualizer: the entity-relationship diagram (ERD) of schema "${context.schema}", showing every table, its columns and the foreign-key relations between tables.`,
        'Questions about "the diagram", "the ERD", "these tables" or "the relations" refer to that diagram.',
      ];
    case "table": {
      const { table } = context;
      const references = referencingTables(introspection, table);
      return [
        `The user has the table ${table.schema}.${table.name} open in the data grid.`,
        'Questions about "this table", "these rows" or "esta tabla" refer to it.',
        "Its columns:",
        ...Object.keys(table.columns).map((name) => columnLine(table, name)),
        references.length > 0
          ? `Referenced by: ${references.join(", ")}`
          : "No other table references it.",
      ];
    }
    case "sql": {
      const sql = context.editorSql?.trim();
      return [
        "The user is in the SQL editor.",
        sql
          ? `Current editor content (questions about "this query" refer to it):\n${sql.slice(0, MAX_EDITOR_SQL_CHARS)}`
          : "The editor is empty.",
      ];
    }
    case "stream":
      return [
        `The user is browsing the event stream "${context.streamName}" (not a table). Stream events are not available to you; answer from general knowledge of the stream and the database schema.`,
      ];
    case "view":
      return [`The user is on Studio's ${context.viewName} view.`];
  }
}

function historyLines(history: AssistantMessage[]): string[] {
  return history.slice(-MAX_HISTORY_MESSAGES).map((message) => {
    const text = [message.content, message.sql ? `SQL: ${message.sql}` : null]
      .filter(Boolean)
      .join("\n")
      .slice(0, MAX_HISTORY_MESSAGE_CHARS);
    return `${message.role === "user" ? "User" : "Assistant"}: ${text}`;
  });
}

/** Builds the prompt for one assistant turn. */
export function buildAssistantPrompt(args: {
  context: AssistantContext;
  introspection: Pick<AdapterIntrospectResult, "schemas" | "timezone">;
  activeSchema: string;
  dialect: SqlEditorDialect;
  history: AssistantMessage[];
  question: string;
  now?: Date;
}): string {
  const now = args.now ?? new Date();
  const timeZone =
    args.introspection.timezone ||
    Intl.DateTimeFormat().resolvedOptions().timeZone ||
    "UTC";
  const engine = getDatabaseEngineName(args.dialect);
  const history = historyLines(args.history);

  return [
    "You are the AI assistant inside Prisma Studio, a tool to browse and edit a database. You help the user understand their database and get answers from it, like a colleague who knows the schema well.",
    `Database engine: ${engine}`,
    `Active schema: ${args.activeSchema}`,
    `Current local date and time: ${formatPromptLocalDateTime(now, timeZone)} (timezone: ${timeZone})`,
    "",
    "Where the user is right now:",
    ...contextLines(args.context, args.introspection),
    "",
    "Database schema (tables, columns, keys and relations):",
    ...schemaLines(args.introspection, args.activeSchema),
    "",
    history.length > 0 ? "Conversation so far:" : null,
    ...history,
    history.length > 0 ? "" : null,
    "Return JSON only, without markdown fences:",
    '{"answer":"...","sql":null,"shouldGenerateVisualization":false}',
    "Rules:",
    "- Stay in the user's current context: answer about what they are looking at unless they clearly ask about something else.",
    "- Explain structure (tables, columns, keys, relations, cardinality) only from the schema above. Never invent tables or columns.",
    '- You cannot see table rows. Never state specific data values. When answering needs data (counts, lists, totals, “who/which/how many”), write a query in "sql" and say in the answer that running it gives the result.',
    '- Put a query in "sql" only when it is needed for data or the user asks for, fixes, or changes a query. Otherwise "sql" is null. Questions about the structure or the diagram need no query.',
    `- A query is exactly one ${engine} statement using only listed tables and columns. Prefer a read-only SELECT unless the user explicitly asks to change data or schema. Add LIMIT 100 or less to row listings.`,
    ...getDialectSpecificPromptRules(args.dialect).map((rule) => `- ${rule}`),
    '- Set "shouldGenerateVisualization" to true only when the query result would make a simple chart (bar, line, pie, time series).',
    "- The user may use other languages, synonyms or singular/plural forms of table and column names; map them to the listed names.",
    '- Answer in the same language as the user\'s question. Be concise (under 150 words). Plain text; short lines starting with "- " are fine; no headings or code fences in the answer (the query goes only in "sql").',
    "",
    `User question: ${args.question.trim()}`,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

/**
 * Parses the model's reply. Replies that are not the requested JSON are
 * shown as plain answers so the conversation never breaks.
 */
export function parseAssistantReply(responseText: string): AssistantReply {
  const normalized = normalizeAiJsonResponseText(responseText);

  try {
    const parsed = JSON.parse(normalized) as Record<string, unknown>;

    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.answer === "string"
    ) {
      const sql =
        typeof parsed.sql === "string" && parsed.sql.trim().length > 0
          ? parsed.sql.trim()
          : null;

      return {
        answer: parsed.answer.trim(),
        shouldGenerateVisualization:
          sql != null && parsed.shouldGenerateVisualization === true,
        sql,
      };
    }
  } catch {
    // Not JSON: fall through to a plain answer.
  }

  return {
    answer: normalized,
    shouldGenerateVisualization: false,
    sql: null,
  };
}

/** Starter questions that fit where the user is. */
export function buildAssistantSuggestions(
  context: AssistantContext,
  introspection: Pick<AdapterIntrospectResult, "schemas"> | undefined,
): string[] {
  switch (context.kind) {
    case "visualizer": {
      const tables = Object.values(
        introspection?.schemas[context.schema]?.tables ?? {},
      );
      const central = [...tables].sort(
        (left, right) =>
          countReferences(introspection, right) -
          countReferences(introspection, left),
      )[0];
      return [
        "Explain this diagram: what are the main tables and how are they related?",
        central
          ? `Which tables are connected to ${central.name}, and how?`
          : null,
        "Are there tables without a primary key or without relations?",
      ].filter((item): item is string => item !== null);
    }
    case "table":
      return [
        `What is the ${context.table.name} table for, and how does it relate to other tables?`,
        `Show the 10 most recent rows of ${context.table.name}`,
        `How many rows does ${context.table.name} have?`,
      ];
    case "sql":
      return context.editorSql?.trim()
        ? [
            "Explain this query step by step",
            "Can this query be faster?",
            "Is there a mistake in this query?",
          ]
        : ["Write a query that joins the main tables of this schema"];
    case "stream":
      return ["What is this stream for?"];
    case "view":
      return [
        "What can I find in this database?",
        ...(introspection
          ? buildSqlAiSuggestions({
              activeSchema: context.schema,
              introspection: introspection as AdapterIntrospectResult,
            }).slice(0, 3)
          : []),
      ];
  }
}

function countReferences(
  introspection: Pick<AdapterIntrospectResult, "schemas"> | undefined,
  table: Table,
): number {
  return introspection ? referencingTables(introspection, table).length : 0;
}
