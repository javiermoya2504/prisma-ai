import { describe, expect, it } from "vitest";

import {
  buildWalHistoryPrompt,
  WAL_HISTORY_AI_MAX_EVENTS,
} from "./wal-history-ai";

describe("buildWalHistoryPrompt", () => {
  it("includes the loaded events, the scope and the question", () => {
    const { includedEventCount, prompt } = buildWalHistoryPrompt({
      events: [
        {
          body: {
            headers: { operation: "update", timestamp: "2026-11-12T10:00:00Z" },
            key: "7",
            old_value: { grade: 8, id: 7 },
            type: "public.grades",
            value: { grade: 10, id: 7 },
          },
        },
      ],
      question: "¿Quién subió la nota 7?",
      scope: "table public.grades",
    });

    expect(includedEventCount).toBe(1);
    expect(prompt).toContain('"type":"public.grades"');
    expect(prompt).toContain("The user is looking at: table public.grades.");
    expect(prompt).toContain("Answer in the same language as the question.");
    expect(prompt.trimEnd().endsWith("Question: ¿Quién subió la nota 7?")).toBe(
      true,
    );
  });

  it("caps how many events and characters are sent", () => {
    const events = Array.from(
      { length: WAL_HISTORY_AI_MAX_EVENTS + 50 },
      (_, i) => ({
        body: { key: String(i), value: { text: "x".repeat(5_000) } },
      }),
    );

    const { includedEventCount, prompt } = buildWalHistoryPrompt({
      events,
      question: "What changed?",
      scope: null,
    });

    expect(includedEventCount).toBeLessThan(WAL_HISTORY_AI_MAX_EVENTS);
    expect(prompt).toContain("…(truncated)");
    expect(prompt.length).toBeLessThan(70_000);
  });
});
