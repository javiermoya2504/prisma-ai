---
"@prisma/studio-core": minor
---

Add an AI assistant to Studio. A floating AI button in the bottom-right corner opens a docked panel from any view where you can ask questions about your database in plain language (any language, synonyms welcome) and get SQL adapted to your real schema, with a short explanation of each clause, written into the editor without running it. The panel suggests starter questions built locally from your schema without calling AI, follows Studio's visual style, and stays open across reloads. Hosts can render their own provider settings inside it through the new optional `aiSettings` prop.
