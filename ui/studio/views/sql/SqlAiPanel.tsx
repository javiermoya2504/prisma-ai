import {
  ChevronRight,
  Code2,
  KeyRound,
  Lightbulb,
  Loader2,
  type LucideIcon,
  MessageSquare,
  Sparkles,
  X,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "../../../components/ui/alert";
import { Button } from "../../../components/ui/button";
import { Textarea } from "../../../components/ui/textarea";
import { cn } from "../../../lib/utils";

export const SQL_AI_PANEL_STATE_KEY = "sql:ai-panel:open";

/**
 * Docked AI side panel. It is rendered inline next to the SQL workspace (not
 * as a modal overlay), so opening it narrows the editor and results instead of
 * covering them, like the chat panes in AI-enabled editors.
 */
export function SqlAiPanel(props: {
  onClose: () => void;
  settings?: ReactNode;
  enabled: boolean;
  busy: boolean;
  schema: string;
  prompt: string;
  onPromptChange: (value: string) => void;
  suggestions: string[];
  onGenerate: () => void;
  error: string | null;
  sql?: string;
  rationale: string | null;
}) {
  return (
    <aside
      aria-label="AI assistant"
      className="flex w-[360px] max-w-[45%] shrink-0 flex-col overflow-hidden border-l border-border bg-card"
    >
      {/* Mirrors StudioHeader height so the header borders line up. */}
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border p-2 py-3 pl-4">
        <div className="flex min-w-0 items-center gap-1.5">
          <Sparkles size={16} className="shrink-0 text-muted-foreground/60" />
          <h2 className="truncate text-sm font-medium">AI assistant</h2>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Close AI assistant"
          onClick={props.onClose}
        >
          <X />
        </Button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {props.settings ? (
          <PanelSection
            icon={KeyRound}
            title="Provider"
            collapsible
            // Collapse once a provider is connected so the question is in view.
            collapsed={props.enabled}
            aside={
              props.enabled ? (
                <span className="text-xs text-muted-foreground">Connected</span>
              ) : null
            }
          >
            <fieldset disabled={props.busy} className="min-w-0">
              {props.settings}
            </fieldset>
          </PanelSection>
        ) : null}

        {props.suggestions.length > 0 ? (
          <PanelSection
            icon={Lightbulb}
            title="Try asking"
            aside={
              <span className="font-mono text-xs text-muted-foreground">
                {props.schema}
              </span>
            }
          >
            <div className="-mx-2 flex flex-col gap-px">
              {props.suggestions.map((suggestion) => (
                <Button
                  key={suggestion}
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-auto justify-start whitespace-normal px-2 py-1 text-left font-mono text-xs font-normal text-foreground/60 hover:text-foreground"
                  disabled={props.busy}
                  onClick={() => props.onPromptChange(suggestion)}
                >
                  {suggestion}
                </Button>
              ))}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Built from your schema. AI is only used when you generate a query.
            </p>
          </PanelSection>
        ) : null}

        <PanelSection icon={MessageSquare} title="Ask your database">
          <form
            className="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              props.onGenerate();
            }}
          >
            <Textarea
              id="studio-ai-question"
              aria-label="Your question"
              value={props.prompt}
              onChange={(event) => props.onPromptChange(event.target.value)}
              placeholder="e.g. Which customers placed the most orders?"
              rows={3}
              className="resize-none text-xs md:text-xs"
              disabled={props.busy}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  props.onGenerate();
                }
              }}
            />
            <Button
              type="submit"
              size="sm"
              disabled={!props.enabled || !props.prompt.trim() || props.busy}
            >
              {props.busy ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Sparkles className="size-4" />
              )}
              {props.busy ? "Generating SQL…" : "Generate query"}
            </Button>
            <p className="text-xs text-muted-foreground">
              {props.enabled
                ? "Any language works. Generating sends your question and schema, not table rows; drawing a chart of the results sends those result rows. ⌘/Ctrl+Enter to generate."
                : "Connect a provider above to start asking questions."}
            </p>
          </form>
          {props.error ? (
            <Alert variant="destructive" className="mt-3 text-xs">
              <AlertTitle className="text-xs">
                Could not generate SQL
              </AlertTitle>
              <AlertDescription className="text-xs">
                {props.error}
              </AlertDescription>
            </Alert>
          ) : null}
        </PanelSection>

        {props.sql && !props.busy ? (
          <PanelSection icon={Code2} title="Generated SQL">
            <pre
              id="studio-ai-sql-preview"
              className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/70 bg-muted/40 p-3 font-mono text-xs text-foreground"
            >
              <code>{props.sql}</code>
            </pre>
            {props.rationale ? (
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                {props.rationale}
              </p>
            ) : null}
            <Button
              variant="outline"
              size="sm"
              className="mt-3 w-full"
              onClick={props.onClose}
            >
              Review in SQL editor
            </Button>
            <p className="mt-2 text-xs text-muted-foreground">
              Nothing has been executed. Use Run SQL when you are ready.
            </p>
          </PanelSection>
        ) : null}
      </div>
    </aside>
  );
}

/** Section header styled like the navigation blocks (16px muted icon + text-sm title). */
function PanelSection(props: {
  icon: LucideIcon;
  title: string;
  aside?: ReactNode;
  /** When collapsible, the section follows `collapsed` until the user toggles it. */
  collapsible?: boolean;
  collapsed?: boolean;
  children: ReactNode;
}) {
  const Icon = props.icon;
  const [isOpen, setIsOpen] = useState(!props.collapsed);

  useEffect(() => {
    setIsOpen(!props.collapsed);
  }, [props.collapsed]);

  const open = !props.collapsible || isOpen;
  const heading = (
    <>
      <Icon size={16} className="shrink-0 text-muted-foreground/60" />
      <h3 className="text-sm font-medium">{props.title}</h3>
      {props.aside ? <div className="ml-auto">{props.aside}</div> : null}
    </>
  );

  return (
    <section className="border-b border-border/70 px-4 py-4 last:border-b-0">
      {props.collapsible ? (
        <button
          type="button"
          aria-expanded={open}
          className="flex w-full items-center gap-1.5 rounded-sm text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          onClick={() => setIsOpen((value) => !value)}
        >
          <ChevronRight
            size={14}
            className={cn(
              "-ml-1 shrink-0 text-muted-foreground/60 transition-transform",
              open && "rotate-90",
            )}
          />
          {heading}
        </button>
      ) : (
        <div className="flex items-center gap-1.5">{heading}</div>
      )}
      {open ? <div className="pt-3">{props.children}</div> : null}
    </section>
  );
}
