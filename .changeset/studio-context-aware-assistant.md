---
"@prisma/studio-core": minor
---

The AI assistant is now a Studio-wide chat panel that opens next to the current view and answers in context (Visualizer ERD, the open table, or the SQL editor query). It no longer switches to the SQL view on open; queries it writes go to the SQL editor only when you choose "Open in SQL editor". Adds the `assistant` LLM task.

AI provider settings moved out of the chat into a dialog opened from the panel's settings button.
