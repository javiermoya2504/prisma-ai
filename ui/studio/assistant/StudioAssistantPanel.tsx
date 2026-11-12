import {
  Code2,
  Copy,
  KeyRound,
  Loader2,
  Send,
  Settings2,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";

import { Alert, AlertDescription } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../components/ui/dialog";
import { Textarea } from "../../components/ui/textarea";
import { useIntrospection } from "../../hooks/use-introspection";
import { useNavigation } from "../../hooks/use-navigation";
import { useUiState } from "../../hooks/use-ui-state";
import { useStudio } from "../context";
import { readPersistedSqlDraft } from "../views/sql/SqlView";
import {
  type AssistantContext,
  type AssistantMessage,
  buildAssistantPrompt,
  buildAssistantSuggestions,
  describeAssistantContext,
  parseAssistantReply,
} from "./assistant-prompt";

/** Persistent open state, shared by the launcher and the panel. */
export const ASSISTANT_PANEL_STATE_KEY = "sql:ai-panel:open";
export const ASSISTANT_MESSAGES_STATE_KEY = "assistant:messages";

/**
 * A query the assistant hands to the SQL view. The SQL view applies it to
 * the editor (without running it) and clears it.
 */
export const SQL_AI_HANDOFF_STATE_KEY = "sql:ai-handoff";

export interface SqlAiHandoff {
  id: string;
  request: string;
  sql: string;
  shouldGenerateVisualization: boolean;
}

interface ChatMessage extends AssistantMessage {
  id: string;
  /** The user question that produced this answer (for SQL corrections). */
  request?: string;
  shouldGenerateVisualization?: boolean;
  context?: string;
  error?: boolean;
}

const VIEW_NAMES: Record<string, string> = {
  activity: "Activity",
  console: "Console",
  migrations: "Migrations",
  queries: "Queries",
};

function newId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** What the user is looking at, from the URL state. */
function useAssistantContext(): AssistantContext {
  const { adapter, sqlEditorStateCollection } = useStudio();
  const {
    metadata: { activeTable },
    schemaParam,
    streamParam,
    viewParam,
  } = useNavigation();
  const schema = schemaParam ?? adapter.defaultSchema ?? "public";

  if (viewParam === "schema") return { kind: "visualizer", schema };
  if (viewParam === "table" && activeTable) {
    return { kind: "table", table: activeTable };
  }
  if (viewParam === "sql") {
    return {
      editorSql: readPersistedSqlDraft({ sqlEditorStateCollection }),
      kind: "sql",
      schema,
    };
  }
  if (viewParam === "stream" && streamParam) {
    return { kind: "stream", streamName: streamParam };
  }

  return {
    kind: "view",
    schema,
    viewName: VIEW_NAMES[viewParam ?? ""] ?? "overview",
  };
}

/**
 * Studio-wide AI assistant, docked to the right of every view. It knows
 * where the user is (Visualizer, a table, the SQL editor…) and answers in
 * that context; it only switches to the SQL view when the user chooses to
 * open a query the assistant wrote.
 */
export function StudioAssistantPanel() {
  const { adapter, aiSettings, hasAiSql, hasDatabase, requestLlm } =
    useStudio();
  const { setViewParam, viewParam } = useNavigation();
  const { data: introspection } = useIntrospection();
  const [isOpen, setIsOpen] = useUiState(ASSISTANT_PANEL_STATE_KEY, false, {
    persistent: true,
  });
  const [messages, setMessages] = useUiState<ChatMessage[]>(
    ASSISTANT_MESSAGES_STATE_KEY,
    [],
  );
  const [, setHandoff] = useUiState<SqlAiHandoff | null>(
    SQL_AI_HANDOFF_STATE_KEY,
    null,
  );
  const [question, setQuestion] = useState("");
  const [isBusy, setIsBusy] = useState(false);
  const [isProviderDialogOpen, setIsProviderDialogOpen] = useState(false);
  const context = useAssistantContext();
  const contextLabel = describeAssistantContext(context);
  const suggestions = useMemo(
    () => buildAssistantSuggestions(context, introspection),
    // The context object is rebuilt each render; its label identifies it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [contextLabel, introspection],
  );
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const requestIdRef = useRef(0);
  const dialect = adapter.capabilities?.sqlDialect ?? "postgresql";
  const activeSchema =
    context.kind === "table"
      ? context.table.schema
      : context.kind === "stream"
        ? (adapter.defaultSchema ?? "public")
        : context.schema;

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, isBusy]);

  useEffect(
    () => () => {
      requestIdRef.current += 1;
    },
    [],
  );

  if (!isOpen || !hasDatabase || !(hasAiSql || aiSettings)) {
    return null;
  }

  const ask = (text: string) => {
    const trimmed = text.trim();

    if (!trimmed || isBusy || !hasAiSql) return;

    if (!introspection) {
      setMessages((current) => [
        ...current,
        {
          content:
            "The database schema is still loading. Try again in a moment.",
          error: true,
          id: newId(),
          role: "assistant",
        },
      ]);
      return;
    }

    const history = messages.filter((message) => !message.error);
    const userMessage: ChatMessage = {
      content: trimmed,
      context: contextLabel,
      id: newId(),
      role: "user",
    };
    const prompt = buildAssistantPrompt({
      activeSchema,
      context,
      dialect,
      history,
      introspection,
      question: trimmed,
    });
    const requestId = ++requestIdRef.current;

    setMessages((current) => [...current, userMessage]);
    setQuestion("");
    setIsBusy(true);

    requestLlm({ prompt, task: "assistant" })
      .then((responseText) => {
        if (requestId !== requestIdRef.current) return;
        const reply = parseAssistantReply(responseText);
        setMessages((current) => [
          ...current,
          {
            content: reply.answer,
            id: newId(),
            request: trimmed,
            role: "assistant",
            shouldGenerateVisualization: reply.shouldGenerateVisualization,
            sql: reply.sql,
          },
        ]);
      })
      .catch((error: unknown) => {
        if (requestId !== requestIdRef.current) return;
        setMessages((current) => [
          ...current,
          {
            content: error instanceof Error ? error.message : String(error),
            error: true,
            id: newId(),
            role: "assistant",
          },
        ]);
      })
      .finally(() => {
        if (requestId === requestIdRef.current) setIsBusy(false);
      });
  };

  const openInSqlEditor = (message: ChatMessage) => {
    if (!message.sql) return;

    setHandoff({
      id: message.id,
      request: message.request ?? message.content,
      shouldGenerateVisualization: message.shouldGenerateVisualization ?? false,
      sql: message.sql,
    });

    if (viewParam !== "sql") void setViewParam("sql");
  };

  return (
    <aside
      aria-label="AI assistant"
      className="flex w-[380px] max-w-[45%] shrink-0 flex-col overflow-hidden border-l border-border bg-card"
    >
      {/* Mirrors StudioHeader height so the header borders line up. */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border p-2 py-3 pl-4">
        <div className="flex min-w-0 items-center gap-1.5">
          <Sparkles size={16} className="shrink-0 text-muted-foreground/60" />
          <h2 className="truncate text-sm font-medium">AI assistant</h2>
        </div>
        <div className="flex items-center gap-1">
          {aiSettings ? (
            <Button
              variant="ghost"
              size="icon"
              aria-label="AI provider settings"
              title="AI provider settings"
              onClick={() => setIsProviderDialogOpen(true)}
            >
              <Settings2 />
            </Button>
          ) : null}
          {messages.length > 0 ? (
            <Button
              variant="ghost"
              size="icon"
              aria-label="Clear conversation"
              title="Clear conversation"
              disabled={isBusy}
              onClick={() => setMessages([])}
            >
              <Trash2 />
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="icon"
            aria-label="Close AI assistant"
            onClick={() => setIsOpen(false)}
          >
            <X />
          </Button>
        </div>
      </div>

      {aiSettings ? (
        <ProviderDialog
          open={isProviderDialogOpen}
          onOpenChange={setIsProviderDialogOpen}
          enabled={hasAiSql}
          busy={isBusy}
        >
          {aiSettings}
        </ProviderDialog>
      ) : null}

      <div
        ref={scrollRef}
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 py-4"
        data-testid="assistant-messages"
      >
        {!hasAiSql && aiSettings ? (
          <div
            className="flex flex-col items-start gap-2 rounded-lg border border-dashed border-border p-3"
            data-testid="assistant-connect-provider"
          >
            <p className="text-xs text-muted-foreground">
              Connect an AI provider to start asking questions.
            </p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setIsProviderDialogOpen(true)}
            >
              <KeyRound data-icon="inline-start" />
              Connect provider
            </Button>
          </div>
        ) : null}

        {messages.length === 0 ? (
          <div className="flex flex-col gap-3">
            <p className="text-xs text-muted-foreground">
              Ask about what you are looking at. Questions are answered from
              your schema; table rows are never sent. When an answer needs data,
              the assistant writes a query you can open in the SQL editor.
            </p>
            {hasAiSql ? (
              <div className="-mx-2 flex flex-col gap-px">
                {suggestions.map((suggestion) => (
                  <Button
                    key={suggestion}
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-auto justify-start whitespace-normal px-2 py-1 text-left font-mono text-xs font-normal text-foreground/60 hover:text-foreground"
                    disabled={isBusy || !hasAiSql}
                    onClick={() => ask(suggestion)}
                  >
                    {suggestion}
                  </Button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        {messages.map((message) =>
          message.role === "user" ? (
            <div key={message.id} className="flex flex-col items-end gap-1">
              <div className="max-w-[90%] whitespace-pre-wrap rounded-lg bg-muted px-3 py-2 text-xs text-foreground">
                {message.content}
              </div>
              {message.context ? (
                <span className="text-[10px] text-muted-foreground">
                  {message.context}
                </span>
              ) : null}
            </div>
          ) : message.error ? (
            <Alert key={message.id} variant="destructive" className="text-xs">
              <AlertDescription className="text-xs">
                {message.content}
              </AlertDescription>
            </Alert>
          ) : (
            <div
              key={message.id}
              className="flex flex-col gap-2"
              data-testid="assistant-reply"
            >
              <p className="whitespace-pre-wrap text-xs leading-relaxed text-foreground">
                {message.content}
              </p>
              {message.sql ? (
                <div className="flex flex-col gap-2">
                  <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/70 bg-muted/40 p-3 font-mono text-xs text-foreground">
                    <code>{message.sql}</code>
                  </pre>
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      className="flex-1"
                      onClick={() => openInSqlEditor(message)}
                    >
                      <Code2 data-icon="inline-start" />
                      {viewParam === "sql"
                        ? "Put in editor"
                        : "Open in SQL editor"}
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      aria-label="Copy query"
                      title="Copy query"
                      onClick={() =>
                        void navigator.clipboard?.writeText(message.sql ?? "")
                      }
                    >
                      <Copy />
                    </Button>
                  </div>
                </div>
              ) : null}
            </div>
          ),
        )}

        {isBusy ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Loader2 className="size-3 animate-spin" />
            Thinking…
          </p>
        ) : null}
      </div>

      <form
        className="flex shrink-0 flex-col gap-2 border-t border-border p-3"
        onSubmit={(event) => {
          event.preventDefault();
          ask(question);
        }}
      >
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
            Context
          </span>
          <Badge
            variant="outline"
            className="max-w-full truncate font-mono text-[10px] font-normal"
            data-testid="assistant-context"
          >
            {contextLabel}
          </Badge>
        </div>
        <div className="flex items-end gap-2">
          <Textarea
            aria-label="Ask the AI assistant"
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder={
              hasAiSql
                ? placeholderFor(context)
                : "Connect a provider to start."
            }
            rows={2}
            className="min-h-0 resize-none text-xs md:text-xs"
            disabled={!hasAiSql}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                ask(question);
              }
            }}
          />
          <Button
            type="submit"
            size="icon"
            aria-label="Send"
            disabled={!hasAiSql || !question.trim() || isBusy}
          >
            <Send />
          </Button>
        </div>
      </form>
    </aside>
  );
}

function placeholderFor(context: AssistantContext): string {
  switch (context.kind) {
    case "visualizer":
      return "Ask about this diagram…";
    case "table":
      return `Ask about ${context.table.name}…`;
    case "sql":
      return "Ask about your query or what to query…";
    default:
      return "Ask about your database…";
  }
}

/**
 * Provider settings rendered by the host (`aiSettings`), kept out of the chat
 * in a dialog opened from the header. Closes itself once a provider connects.
 */
function ProviderDialog(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  enabled: boolean;
  busy: boolean;
  children: ReactNode;
}) {
  const { enabled, onOpenChange, open } = props;
  const wasEnabledRef = useRef(enabled);

  useEffect(() => {
    if (enabled && !wasEnabledRef.current && open) onOpenChange(false);
    wasEnabledRef.current = enabled;
  }, [enabled, onOpenChange, open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md font-sans">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5 text-base">
            <KeyRound size={16} className="text-muted-foreground/60" />
            AI provider
          </DialogTitle>
          <DialogDescription className="text-xs">
            {enabled
              ? "Connected. Change the provider, model or key used by the AI assistant."
              : "Choose a provider and paste an API key to use the AI assistant."}
          </DialogDescription>
        </DialogHeader>
        <fieldset disabled={props.busy} className="min-w-0">
          {props.children}
        </fieldset>
      </DialogContent>
    </Dialog>
  );
}
