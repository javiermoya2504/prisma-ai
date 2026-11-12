import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { useUiState } from "../../hooks/use-ui-state";
import { StudioAssistantLauncher } from "./StudioAssistantLauncher";
import {
  ASSISTANT_MESSAGES_STATE_KEY,
  ASSISTANT_PANEL_STATE_KEY,
  SQL_AI_HANDOFF_STATE_KEY,
  type SqlAiHandoff,
  StudioAssistantPanel,
} from "./StudioAssistantPanel";

const requestLlm =
  vi.fn<(request: { prompt: string; task: string }) => Promise<string>>();
const setViewParam = vi.fn(() => Promise.resolve(new URLSearchParams()));
let navigation: Record<string, unknown> = {};

const students = {
  columns: {
    id: {
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
      name: "id",
      nullable: false,
      pkPosition: 1,
      schema: "public",
      table: "students",
    },
  },
  name: "students",
  schema: "public",
};

vi.mock("../context", () => ({
  useOptionalStudio: () => undefined,
  useStudio: () => ({
    adapter: {
      capabilities: { sqlDialect: "postgresql" },
      defaultSchema: "public",
    },
    aiSettings: undefined,
    hasAiSql: true,
    hasDatabase: true,
    requestLlm,
    sqlEditorStateCollection: {},
  }),
}));
vi.mock("../../hooks/use-navigation", () => ({
  useNavigation: () => navigation,
}));
vi.mock("../../hooks/use-introspection", () => ({
  useIntrospection: () => ({
    data: {
      schemas: { public: { name: "public", tables: { students } } },
      timezone: "UTC",
    },
  }),
}));
vi.mock("../views/sql/SqlView", () => ({
  readPersistedSqlDraft: () => "select * from students",
}));

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

let latestHandoff: SqlAiHandoff | null = null;

function State() {
  const [handoff] = useUiState<SqlAiHandoff | null>(
    SQL_AI_HANDOFF_STATE_KEY,
    null,
  );
  latestHandoff = handoff;
  return null;
}

function Reset() {
  const [, setOpen] = useUiState(ASSISTANT_PANEL_STATE_KEY, false, {
    persistent: true,
  });
  const [, setMessages] = useUiState(ASSISTANT_MESSAGES_STATE_KEY, []);
  const [, setHandoff] = useUiState<SqlAiHandoff | null>(
    SQL_AI_HANDOFF_STATE_KEY,
    null,
  );
  setOpen(false);
  setMessages([]);
  setHandoff(null);
  return null;
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
  });
}

function render() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(
      <>
        <StudioAssistantPanel />
        <StudioAssistantLauncher />
        <State />
      </>,
    );
  });
  return {
    container,
    cleanup() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

async function ask(container: HTMLElement, text: string) {
  const textarea = container.querySelector<HTMLTextAreaElement>(
    'textarea[aria-label="Ask the AI assistant"]',
  )!;
  act(() => {
    Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )!.set!.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    textarea.closest("form")!.requestSubmit();
  });
  await flush();
}

async function openPanel(container: HTMLElement) {
  await act(async () => {
    container
      .querySelector<HTMLButtonElement>(
        'button[aria-label="Open AI assistant"]',
      )!
      .click();
  });
  await flush();
}

describe("StudioAssistantPanel", () => {
  beforeEach(async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    act(() => root.render(<Reset />));
    await flush();
    act(() => root.unmount());
    latestHandoff = null;
  });

  afterEach(() => {
    requestLlm.mockReset();
    setViewParam.mockClear();
  });

  it("opens next to the Visualizer, answers about the diagram, and stays on that view", async () => {
    navigation = {
      metadata: { activeTable: undefined },
      schemaParam: "public",
      setViewParam,
      viewParam: "schema",
    };
    requestLlm.mockResolvedValue(
      JSON.stringify({ answer: "students is the central table.", sql: null }),
    );
    const { container, cleanup } = render();

    await openPanel(container);
    expect(setViewParam).not.toHaveBeenCalled();
    expect(
      container.querySelector('[data-testid="assistant-context"]')?.textContent,
    ).toBe("Visualizer · public");

    await ask(container, "Explain this diagram");

    expect(requestLlm).toHaveBeenCalledWith(
      expect.objectContaining({ task: "assistant" }),
    );
    expect(requestLlm.mock.calls[0]?.[0].prompt).toContain(
      "entity-relationship diagram (ERD)",
    );
    expect(container.textContent).toContain("students is the central table.");
    expect(container.textContent).not.toContain("Open in SQL editor");
    expect(setViewParam).not.toHaveBeenCalled();
    cleanup();
  });

  it("answers about the open table and only goes to the SQL view when the user opens the query", async () => {
    navigation = {
      metadata: { activeTable: students },
      schemaParam: "public",
      setViewParam,
      viewParam: "table",
    };
    requestLlm.mockResolvedValue(
      JSON.stringify({
        answer: "Run this to count them.",
        sql: "select count(*) from public.students",
        shouldGenerateVisualization: false,
      }),
    );
    const { container, cleanup } = render();
    await openPanel(container);

    expect(
      container.querySelector('[data-testid="assistant-context"]')?.textContent,
    ).toBe("Table · public.students");
    await ask(container, "¿Cuántas filas tiene esta tabla?");

    expect(requestLlm.mock.calls[0]?.[0].prompt).toContain(
      "The user has the table public.students open",
    );
    expect(setViewParam).not.toHaveBeenCalled();

    const open = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Open in SQL editor"),
    )!;
    await act(async () => open.click());
    await flush();

    expect(setViewParam).toHaveBeenCalledWith("sql");
    expect(latestHandoff).toMatchObject({
      request: "¿Cuántas filas tiene esta tabla?",
      sql: "select count(*) from public.students",
    });
    cleanup();
  });

  it("puts the query in the editor without navigating when already in the SQL view", async () => {
    navigation = {
      metadata: { activeTable: undefined },
      schemaParam: "public",
      setViewParam,
      viewParam: "sql",
    };
    requestLlm.mockResolvedValue(
      JSON.stringify({ answer: "Faster:", sql: "select id from students" }),
    );
    const { container, cleanup } = render();
    await openPanel(container);
    await ask(container, "Can this query be faster?");

    expect(requestLlm.mock.calls[0]?.[0].prompt).toContain(
      "select * from students",
    );
    const put = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("Put in editor"),
    )!;
    await act(async () => put.click());
    await flush();

    expect(setViewParam).not.toHaveBeenCalled();
    expect(latestHandoff?.sql).toBe("select id from students");
    cleanup();
  });
});
