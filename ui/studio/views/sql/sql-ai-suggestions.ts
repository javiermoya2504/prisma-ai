import type { AdapterIntrospectResult, Column } from "@/data";

const DEFAULT_SUGGESTION_LIMIT = 5;

/**
 * Builds starter questions for the AI SQL panel from introspection metadata
 * only. This runs locally and never calls the LLM, so suggestions are free and
 * instant; the model is only used once the user submits a question.
 */
export function buildSqlAiSuggestions(args: {
  activeSchema: string;
  introspection: AdapterIntrospectResult;
  limit?: number;
}): string[] {
  const {
    activeSchema,
    introspection,
    limit = DEFAULT_SUGGESTION_LIMIT,
  } = args;
  const tables = Object.values(
    introspection.schemas[activeSchema]?.tables ?? {},
  );
  const relationships: string[] = [];
  const timeSeries: string[] = [];
  const averages: string[] = [];
  const previews: string[] = [];

  for (const table of tables) {
    const columns = Object.values(table.columns);

    for (const column of columns) {
      if (column.fkTable && column.fkTable !== table.name) {
        relationships.push(
          `Which ${column.fkTable} have the most ${table.name}?`,
        );
      }
    }

    const dateColumn = columns.find(
      (column) => column.datatype.group === "datetime",
    );

    if (dateColumn) {
      timeSeries.push(
        `How many ${table.name} were added per month (by ${dateColumn.name})?`,
      );
    }

    const measureColumn = columns.find(isMeasureColumn);

    if (measureColumn) {
      averages.push(
        `What is the average ${measureColumn.name} in ${table.name}?`,
      );
    }

    previews.push(`Show 10 rows from ${table.name}`);
  }

  return interleave([relationships, timeSeries, averages, previews]).slice(
    0,
    limit,
  );
}

function isMeasureColumn(column: Column): boolean {
  return (
    column.datatype.group === "numeric" &&
    column.pkPosition == null &&
    column.fkTable == null &&
    !/(^|_)id$/i.test(column.name)
  );
}

function interleave(groups: string[][]): string[] {
  const result: string[] = [];
  const longest = Math.max(0, ...groups.map((group) => group.length));

  for (let index = 0; index < longest; index++) {
    for (const group of groups) {
      const item = group[index];

      if (item !== undefined && !result.includes(item)) {
        result.push(item);
      }
    }
  }

  return result;
}
