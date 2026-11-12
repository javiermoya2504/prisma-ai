# SQL AI Generation Architecture

This document is normative for natural-language SQL generation in Studio (`view=sql`).

The implementation MUST reuse the embedder-provided AI transport, write generated SQL into the editor without auto-running it, and hand focus back to the SQL editor so execution stays an explicit user action.

## Scope

This architecture governs:

- the optional SQL-view AI generation affordance
- prompt construction from live introspection metadata
- response validation and retry behavior
- how generated SQL is written into editor state and executed
- the SQL AI assistant side panel and its host-owned settings slot
- demo wiring for the local multi-provider (OpenAI, Anthropic, Gemini, OpenRouter) example, including OpenRouter sign-in and opt-in key persistence

## Canonical Components

- [`ui/studio/views/sql/SqlView.tsx`](../ui/studio/views/sql/SqlView.tsx)
- [`ui/studio/views/sql/sql-ai-generation.ts`](../ui/studio/views/sql/sql-ai-generation.ts)
- [`ui/studio/views/sql/sql-ai-suggestions.ts`](../ui/studio/views/sql/sql-ai-suggestions.ts)
- [`ui/studio/views/sql/SqlAiPanel.tsx`](../ui/studio/views/sql/SqlAiPanel.tsx)
- [`ui/studio/views/sql/SqlAiLauncher.tsx`](../ui/studio/views/sql/SqlAiLauncher.tsx)
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
- The SQL view MAY also expose an `AI assistant` panel (`SqlAiPanel`). Its only entry point is a floating round launcher (`SqlAiLauncher`) in the bottom-right corner of the Studio shell, visible from every view; clicking it opens the panel and switches to the SQL view when needed. The launcher MUST hide while the panel is open and MUST sit above grid pagination footers. The panel MUST be docked inline beside the SQL workspace, not a modal overlay: opening it narrows the editor and results, which stay visible and interactive. It reuses the same generation flow, previews the generated SQL read-only, and MUST NOT execute it; closing the panel hands focus back to the editor. See `non-standard-ui.md`.
- The panel's open state MUST live in persistent shared UI state (`SQL_AI_PANEL_STATE_KEY`) so the launcher and the panel agree, and the panel stays open across reloads and the OpenRouter sign-in redirect.
- The panel MUST follow Studio's visual language: a header matching `StudioHeader` height so borders align, sections titled like navigation blocks (16px muted icon + `text-sm font-medium`), `text-xs` body copy, monospace suggestions styled like navigation items, and the generated SQL in the same `pre` block style as Query Details.
- The provider settings section MUST collapse automatically once a provider is connected so the question field stays in view, and MUST remain expandable.
- While the panel is open, generation MUST NOT steal focus into the editor; focus moves to the editor when the user closes the panel or chooses `Review in SQL editor`.
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

- The AI panel MAY show starter questions, and they MUST be built locally from live introspection metadata for the active schema by `buildSqlAiSuggestions`. Building suggestions MUST NOT call `llm`.
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
- the AI panel: floating launcher entry point, docked inline without a modal overlay, provider section auto-collapse, settings-only mode with generation disabled, and generating from the panel without executing SQL
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
