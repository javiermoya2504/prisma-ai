export const AI_PROVIDERS = {
  openai: { label: "OpenAI", model: "gpt-4.1-mini" },
  anthropic: { label: "Anthropic", model: "claude-haiku-4-5-20251001" },
  gemini: { label: "Gemini", model: "gemini-3.5-flash-lite" },
  openrouter: { label: "OpenRouter", model: "openai/gpt-4.1-mini" },
} as const;

export type AiProvider = keyof typeof AI_PROVIDERS;

export interface AiSettings {
  provider: AiProvider;
  model: string;
  apiKey: string;
}

export function isAiProvider(value: unknown): value is AiProvider {
  return typeof value === "string" && Object.hasOwn(AI_PROVIDERS, value);
}

export function isAiSettings(value: unknown): value is AiSettings {
  if (typeof value !== "object" || value === null) return false;
  const settings = value as Partial<AiSettings>;
  return (
    isAiProvider(settings.provider) &&
    typeof settings.apiKey === "string" &&
    settings.apiKey.trim().length > 0 &&
    settings.apiKey.length <= 4096 &&
    !/[\r\n]/.test(settings.apiKey) &&
    typeof settings.model === "string" &&
    // OpenRouter IDs are namespaced ("vendor/model", "~vendor/model:variant").
    (settings.provider === "openrouter"
      ? /^~?[\w.-]+\/[\w.:-]+$/
      : /^[\w.-]+$/
    ).test(settings.model) &&
    settings.model.length <= 128
  );
}
