export const WAL_HISTORY_AI_MAX_EVENTS = 300;
export const WAL_HISTORY_AI_MAX_CHARS = 60_000;
const MAX_EVENT_CHARS = 800;

/**
 * Builds the prompt for a question about the database's change history
 * (`prisma-wal`). Only the events Studio has already loaded are sent, newest
 * first, capped by count and size so the request stays small.
 */
export function buildWalHistoryPrompt(args: {
  question: string;
  events: Array<{ body: unknown }>;
  scope: string | null;
}): { prompt: string; includedEventCount: number } {
  const lines: string[] = [];
  let size = 0;

  for (const event of args.events.slice(0, WAL_HISTORY_AI_MAX_EVENTS)) {
    let line = JSON.stringify(event.body) ?? "null";

    if (line.length > MAX_EVENT_CHARS) {
      line = `${line.slice(0, MAX_EVENT_CHARS)}…(truncated)`;
    }

    if (size + line.length > WAL_HISTORY_AI_MAX_CHARS) break;

    lines.push(line);
    size += line.length + 1;
  }

  const prompt = [
    "You answer questions about a database's change history.",
    "Each line below is one committed change as JSON: `type` is the table (schema.table), `key` identifies the row, `headers.operation` is insert, update or delete, `headers.timestamp` is when it happened, `value` is the row after the change and `old_value` the row before it (null when the database did not record previous values).",
    "Events are listed newest first. They are only the most recent changes Studio loaded, not the full history.",
    args.scope ? `The user is looking at: ${args.scope}.` : null,
    "",
    "Rules:",
    "- Answer only from these events. If they don't contain the answer, say so and suggest what to look at (for example, a longer time range or turning on previous values for the table).",
    "- Mention the table, row key and time of the changes you rely on.",
    "- Be brief: a short answer, then a few bullet points if needed.",
    "- Answer in the same language as the question.",
    "",
    `Events (${lines.length}):`,
    ...lines,
    "",
    `Question: ${args.question.trim()}`,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  return { includedEventCount: lines.length, prompt };
}
