# SQL AI Generation Architecture

This document is normative for natural-language SQL generation in Studio (`view=sql`).

The implementation MUST reuse the embedder-provided AI transport, write generated SQL into the editor without auto-running it, and hand focus back to the SQL editor so execution stays an explicit user action.

## Scope

This architecture governs:

- the optional SQL-view AI generation affordance
- prompt construction from live introspection metadata
- response validation and retry behavior
- how generated SQL is written into editor state and executed
- the Studio-wide AI assistant panel, its context awareness, its hand-off of queries to the SQL view, and its host-owned settings slot
- demo wiring for the local multi-provider (OpenAI, Anthropic, Gemini, OpenRouter) example, including OpenRouter sign-in and opt-in key persistence

## Canonical Components

- [`ui/studio/views/sql/SqlView.tsx`](../ui/studio/views/sql/SqlView.tsx)
- [`ui/studio/views/sql/sql-ai-generation.ts`](../ui/studio/views/sql/sql-ai-generation.ts)
- [`ui/studio/views/sql/sql-ai-suggestions.ts`](../ui/studio/views/sql/sql-ai-suggestions.ts)
- [`ui/studio/assistant/StudioAssistantPanel.tsx`](../ui/studio/assistant/StudioAssistantPanel.tsx)
- [`ui/studio/assistant/StudioAssistantLauncher.tsx`](../ui/studio/assistant/StudioAssistantLauncher.tsx)
- [`ui/studio/assistant/assistant-prompt.ts`](../ui/studio/assistant/assistant-prompt.ts)
- [`ui/studio/views/sql/ai-json-response.ts`](../ui/studio/views/sql/ai-json-response.ts)
- [`ui/studio/context.tsx`](../ui/studio/context.tsx)
- [`ui/studio/Studio.tsx`](../ui/studio/Studio.tsx)
- [`demo/ppg-dev/DemoShell.tsx`](../demo/ppg-dev/DemoShell.tsx)
- [`demo/ppg-dev/server.ts`](../demo/ppg-dev/server.ts)
- [`demo/ppg-dev/use-demo-ai.tsx`](../demo/ppg-dev/use-demo-ai.tsx)
- [`demo/ppg-dev/ai-handler.ts`](../demo/ppg-dev/ai-handler.ts)
- [`demo/ppg-dev/ai-provider.ts`](../demo/ppg-dev/ai-provider.ts)
- [`demo/ppg-dev/ai-settings.ts`](../demo/ppg-dev/ai-settings.ts)
- [`demo/ppg-dev/openrouter-auth.ts`](../demo/ppg-dev/openrouter-auth.ts)

## Frontend Contract

- AI SQL generation MUST remain optional. If `llm` is not provided, the SQL view MUST NOT render an empty AI affordance.
- The SQL view MUST expose a single inline prompt plus action button in the existing header controls, alongside the normal `Run query` flow.
- Submitted AI SQL requests MUST be persisted in Studio's local SQL-view TanStack collection so prompt history survives remounts.
- When the AI prompt input is focused and empty, `ArrowUp` / `ArrowDown` MUST cycle saved prompts as placeholder-only preview text rather than immediately mutating the input value.
- When a history preview is active, clicking into the input or pressing any non-history key MUST materialize that preview into the real input before normal editing continues.
- Submitting a prompt MUST replace the current editor contents with the generated SQL text.
- Submitting a prompt MUST focus the SQL editor and place the cursor at the end of the generated statement so `Cmd/Ctrl+Enter` or the existing run button can execute it immediately.
- AI-generation loading and error states MUST stay inline inside the SQL view and MUST NOT break the normal editor/result layout.
- Studio MAY expose an `AI assistant` chat panel (`StudioAssistantPanel`), rendered by the Studio shell beside the main pane in every view. Its only entry point is a floating round launcher (`StudioAssistantLauncher`) in the bottom-right corner of the shell. Opening the panel MUST NOT change the view. The launcher MUST hide while the panel is open and MUST sit above grid pagination footers. The panel MUST be docked inline (not a modal overlay), so the current view narrows and stays interactive. See `non-standard-ui.md`.
- The panel MUST be context aware. `useAssistantContext` derives the context from URL state only: Visualizer (`view=schema`) → the schema's ERD; `view=table` → the open table (columns, keys, defaults, enums, outgoing and incoming foreign keys); `view=sql` → the persisted editor draft; `view=stream` → the stream name; other views → their name. The context is shown as a chip above the composer and stamped on each user message; suggestions and the placeholder follow it.
- Each turn sends task `assistant` with `buildAssistantPrompt`: the context, the schema (tables, columns, PK/FK/default/enum flags, capped), the last eight messages, and the question. The model returns `{"answer","sql","shouldGenerateVisualization"}`; `parseAssistantReply` falls back to showing non-JSON text as the answer. Table rows are never sent; answers that need data MUST come back as a query.
- The panel MUST NOT navigate on its own. Only when the user chooses `Open in SQL editor` on a reply with a query does it write `SQL_AI_HANDOFF_STATE_KEY` (`{ id, request, sql, shouldGenerateVisualization }`) and switch to `view=sql`; inside the SQL view the button reads `Put in editor` and does not navigate. `SqlView` consumes the hand-off once, applies it through the same path as inline generation (editor content + pending AI execution metadata, so error correction and charts keep working), and MUST NOT execute it.
- The panel's open state MUST live in persistent shared UI state (`ASSISTANT_PANEL_STATE_KEY`) so the launcher and the panel agree and it stays open across reloads and the OpenRouter sign-in redirect. The conversation lives in shared (non-persistent) UI state and can be cleared from the header.
- The panel MUST follow Studio's visual language: a header matching `StudioHeader` height so borders align, `text-xs` body copy, monospace suggestions styled like navigation items, and queries in the same `pre` block style as Query Details.
- The panel MUST render when either `llm` or `aiSettings` is provided. Without `llm`, the generate action MUST stay disabled so a host can let users configure credentials first.

## Prompt Construction Contract

- Prompt construction MUST use current live introspection metadata rather than stale cached schema text.
- The prompt context MUST be bounded:
  - include the concrete database engine name and dialect
  - include adapter dialect
  - include current schema when available
  - include table names and column metadata needed to write valid SQL
  - exclude row data and query results
- The model contract MUST require strict JSON with:
  - `sql`: generated SQL text
  - `rationale`: short human-readable explanation
  - `shouldGenerateVisualization`: whether the resulting dataset is worth auto-charting
- The prompt MUST explicitly instruct the model to return SQL only inside the JSON payload, not markdown code fences.
- The prompt MUST ask the model to decide whether the expected result would produce an interesting chart, rather than auto-charting every AI-generated query.
- The prompt MUST tell the model that users may write in any language or use synonyms, plural variants, or translations of table and column names, and MUST ask it to map those words to the closest listed table or column instead of inventing names.
- The `rationale` MUST be written in the user's language, name the real tables/columns used when they differ from the user's words, and briefly explain the main SQL clauses so the panel teaches SQL rather than hiding it.

## Suggested Questions Contract

- The AI panel MAY show starter questions, and they MUST be built locally (from the context and live introspection, `buildAssistantSuggestions`, which reuses `buildSqlAiSuggestions` for schema-wide questions). Building suggestions MUST NOT call `llm`.
- Suggestions MUST use real table and column names (relationships via foreign keys, per-month counts via datetime columns, averages via numeric measure columns, and row previews) and are capped at five.
- Choosing a suggestion MUST only fill the question field; it MUST NOT generate or execute SQL.

## Validation and Retry Contract

- Studio MUST parse the AI response before updating editor state.
- When `sqlLint` is supported, Studio MUST validate generated SQL before writing it into the editor.
- If pre-display validation reports an error diagnostic, Studio MUST retry once with a correction prompt that includes the generated SQL and lint diagnostic, and MUST NOT show the invalid SQL or rationale while correction is pending.
- If the corrected SQL still fails pre-display validation, Studio MUST surface an inline generation error and MUST leave the current editor contents unchanged.
- JSON-response validation and correction retries SHOULD flow through the shared SQL-view AI JSON utility rather than bespoke per-feature retry loops.
- If the initial AI response is not valid JSON or does not satisfy the `{ sql, rationale, shouldGenerateVisualization }` contract, Studio MUST retry once with a correction prompt that includes the invalid raw response.
- Provider-level output-limit failures MUST surface as explicit retry issues instead of collapsing into a generic malformed-JSON error.
- If the retry still fails validation, Studio MUST surface an inline error and MUST leave the current editor contents unchanged.
- Successful responses MAY surface the rationale inline to explain what was generated.
- Successful responses MUST carry the visualization decision forward so the next manual execution of that same AI-generated SQL can auto-generate a chart for graph-worthy results.

## Database Error Correction Contract

- If the user manually executes SQL that was generated by AI and the database returns an execution error, Studio MUST feed the original natural-language request, the failed SQL, and the database error message back through the same `sql-generation` LLM transport.
- The correction request MUST preserve the original explicit-execution contract: corrected SQL replaces the editor contents, updates the rationale and visualization decision, and focuses the editor, but Studio MUST NOT auto-run the corrected SQL.
- Database-error correction MUST only run for editor contents that still match the pending AI-generated SQL. Manually edited SQL errors MUST stay as normal inline query errors and MUST NOT trigger hidden AI calls.
- If database-error correction fails, Studio MUST keep the database error visible and surface the AI correction failure inline without discarding the user's current SQL.

## Embedder and Demo Contract

- Embedders own the actual provider call through one shared `llm({ task, prompt })` hook. This remains the only AI transport; Studio MUST NOT call providers directly.
- Embedders MAY pass `aiSettings`, an opaque `ReactNode` that Studio renders inside the AI panel (disabled while a request is running). Studio MUST NOT read, store, or transmit anything from it; credential handling is entirely host-owned.
- The local demo implements `llm` by posting to `/api/ai`, which proxies to OpenAI, Anthropic, Gemini, or OpenRouter. A user-supplied provider/model/key from the panel is sent per request and kept in tab memory by default; only when the user opts into `Remember on this device` is it written to `localStorage` (`studio-demo-ai:credentials`), and `Forget keys` removes it. Otherwise the server falls back to `ANTHROPIC_API_KEY` when configured.
- The demo MAY obtain an OpenRouter key through OpenRouter's OAuth PKCE flow (`openrouter-auth.ts`): an S256 challenge plus a `state` value are stored in `sessionStorage`, the browser is redirected to `openrouter.ai/auth` with the Studio origin as callback, and on return the one-time `code` is exchanged for a key in the browser, the `state` is verified, and the `code` is stripped from the URL. Consumer ChatGPT/Claude subscriptions MUST NOT be used as a credential source.
- The demo `/api/ai` endpoint MUST reject cross-origin requests, validate settings before forwarding, follow the same logging guardrails as AI filtering, and MUST NOT log provider keys or raw prompts.
- Demo config MAY disable the shared `llm` hook at embed time, even when the provider credentials exist.

## Testing Requirements

Changes to AI SQL generation MUST include tests covering:

- prompt context bounding and JSON-contract enforcement
- synonym/language mapping and teaching-rationale prompt rules
- schema-derived suggested questions, including that choosing one never calls `llm` or executes SQL
- correction retry behavior for malformed AI responses
- SQL-view integration showing controls only when configured
- the AI assistant: launcher opens it without changing the view, prompts reflect the Visualizer / table / SQL context, replies without a query never navigate, `Open in SQL editor` hands the query off and switches view, `Put in editor` stays in the SQL view, and the SQL view applies a hand-off without executing it
- local prompt-history persistence plus placeholder-preview navigation with `ArrowUp` / `ArrowDown`
- filling the editor without auto-executing the generated query
- validating generated SQL before filling the editor and correcting invalid SQL without exposing the invalid draft
- leaving the editor unchanged when generated SQL still fails validation after correction
- focusing the editor and moving the cursor to the end of the generated SQL
- preserving the visualization decision until the user manually runs the generated SQL
- surfacing the visualization decision from the AI response
- inline error rendering for failed AI generation
- feeding execution errors from AI-generated SQL back into the model without auto-running the corrected SQL
- leaving manually written SQL execution errors as normal inline query errors without invoking AI correction
