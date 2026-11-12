import { Loader2, Sparkles, X } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";

import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { useStudio } from "../../context";
import { buildWalHistoryPrompt } from "./wal-history-ai";

/**
 * "Ask AI" over the change history currently loaded in the `prisma-wal`
 * stream view. Rendered only when the host provides `llm`.
 */
export function WalHistoryAsk(props: {
  events: Array<{ body: unknown }>;
  scope: string | null;
}) {
  const { hasAiChangeHistory, requestLlm } = useStudio();
  const [question, setQuestion] = useState("");
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "loading" }
    | { kind: "answer"; text: string; eventCount: number }
    | { kind: "error"; message: string }
  >({ kind: "idle" });
  const requestIdRef = useRef(0);

  useEffect(
    () => () => {
      requestIdRef.current += 1;
    },
    [],
  );

  const submit = (event: FormEvent) => {
    event.preventDefault();

    if (!question.trim() || state.kind === "loading") return;

    const { includedEventCount, prompt } = buildWalHistoryPrompt({
      events: props.events,
      question,
      scope: props.scope,
    });
    const requestId = ++requestIdRef.current;

    setState({ kind: "loading" });
    requestLlm({ prompt, task: "change-history" })
      .then((text) => {
        if (requestId !== requestIdRef.current) return;
        setState({ eventCount: includedEventCount, kind: "answer", text });
      })
      .catch((error: unknown) => {
        if (requestId !== requestIdRef.current) return;
        setState({
          kind: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      });
  };

  if (!hasAiChangeHistory) return null;

  return (
    <div
      className="flex flex-col gap-2 border-b border-border px-4 py-2.5"
      data-testid="wal-history-ask"
    >
      <form className="flex items-center gap-2" onSubmit={submit}>
        <Input
          aria-label="Ask AI about these changes"
          className="h-8 text-sm"
          onChange={(event) => setQuestion(event.target.value)}
          placeholder="Ask about these changes, e.g. “What changed in students today?”"
          value={question}
        />
        <Button
          className="shadow-none"
          disabled={!question.trim() || state.kind === "loading"}
          size="sm"
          type="submit"
          variant="outline"
        >
          {state.kind === "loading" ? (
            <Loader2 className="animate-spin" data-icon="inline-start" />
          ) : (
            <Sparkles data-icon="inline-start" />
          )}
          Ask AI
        </Button>
      </form>

      {state.kind === "answer" || state.kind === "error" ? (
        <div className="relative rounded-md border border-border bg-muted/30 px-3 py-2 pr-9">
          <Button
            aria-label="Dismiss answer"
            className="absolute right-1 top-1 size-6"
            onClick={() => setState({ kind: "idle" })}
            size="icon"
            type="button"
            variant="ghost"
          >
            <X />
          </Button>
          {state.kind === "answer" ? (
            <>
              <p className="whitespace-pre-wrap text-sm text-foreground">
                {state.text}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Based on the {state.eventCount} most recent change
                {state.eventCount === 1 ? "" : "s"} loaded here.
              </p>
            </>
          ) : (
            <p role="alert" className="text-sm text-destructive">
              {state.message}
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}
