import { LogIn } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { isStudioLlmResponse, type StudioLlm } from "../../data/llm";
import { Badge } from "../../ui/components/ui/badge";
import { Button } from "../../ui/components/ui/button";
import { Checkbox } from "../../ui/components/ui/checkbox";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "../../ui/components/ui/field";
import { Input } from "../../ui/components/ui/input";
import {
  ToggleGroup,
  ToggleGroupItem,
} from "../../ui/components/ui/toggle-group";
import {
  AI_PROVIDERS,
  type AiProvider,
  type AiSettings,
  isAiProvider,
  isAiSettings,
} from "./ai-settings";
import {
  completeOpenRouterLogin,
  startOpenRouterLogin,
} from "./openrouter-auth";

export const AI_CREDENTIALS_STORAGE_KEY = "studio-demo-ai:credentials";

type Credentials = Partial<Record<AiProvider, AiSettings>>;

interface StoredCredentials {
  activeProvider: AiProvider | null;
  credentials: Credentials;
}

function readStoredCredentials(): StoredCredentials | null {
  try {
    const raw = localStorage.getItem(AI_CREDENTIALS_STORAGE_KEY);

    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as StoredCredentials;
    const credentials = Object.fromEntries(
      Object.entries(parsed.credentials ?? {}).filter(([, value]) =>
        isAiSettings(value),
      ),
    ) as Credentials;
    const activeProvider =
      isAiProvider(parsed.activeProvider) && credentials[parsed.activeProvider]
        ? parsed.activeProvider
        : null;

    return { activeProvider, credentials };
  } catch {
    return null;
  }
}

function writeStoredCredentials(value: StoredCredentials | null) {
  try {
    if (value) {
      localStorage.setItem(AI_CREDENTIALS_STORAGE_KEY, JSON.stringify(value));
    } else {
      localStorage.removeItem(AI_CREDENTIALS_STORAGE_KEY);
    }
  } catch {
    // Storage can be unavailable (private mode); keys then stay in memory.
  }
}

export function useDemoAi(args: {
  enabled: boolean;
  configurable: boolean;
  /** Overridable for tests; defaults to a full-page redirect. */
  navigate?: (url: string) => void;
}) {
  const [initialStored] = useState(readStoredCredentials);
  const [credentials, setCredentials] = useState<Credentials>(
    initialStored?.credentials ?? {},
  );
  const [activeProvider, setActiveProvider] = useState<AiProvider | null>(
    initialStored?.activeProvider ?? null,
  );
  const [remember, setRemember] = useState(initialStored != null);
  const [loginStatus, setLoginStatus] = useState<
    | { kind: "idle" }
    | { kind: "connecting" }
    | { kind: "error"; message: string }
  >({ kind: "idle" });
  const hasHandledCallbackRef = useRef(false);
  const settings = activeProvider ? credentials[activeProvider] : undefined;

  useEffect(() => {
    writeStoredCredentials(
      remember && activeProvider ? { activeProvider, credentials } : null,
    );
  }, [activeProvider, credentials, remember]);

  useEffect(() => {
    if (!args.configurable || hasHandledCallbackRef.current) {
      return;
    }

    hasHandledCallbackRef.current = true;

    if (!new URL(window.location.href).searchParams.has("code")) {
      return;
    }

    setLoginStatus({ kind: "connecting" });
    completeOpenRouterLogin({ currentUrl: window.location.href })
      .then((result) => {
        if (!result) {
          setLoginStatus({ kind: "idle" });
          return;
        }

        window.history.replaceState(null, "", result.cleanUrl);
        window.dispatchEvent(new HashChangeEvent("hashchange"));
        setCredentials((previous) => ({
          ...previous,
          openrouter: {
            provider: "openrouter",
            apiKey: result.key,
            model: previous.openrouter?.model ?? AI_PROVIDERS.openrouter.model,
          },
        }));
        setActiveProvider("openrouter");
        setRemember(result.remember);
        setLoginStatus({ kind: "idle" });
      })
      .catch((error: unknown) => {
        const url = new URL(window.location.href);
        url.searchParams.delete("code");
        url.searchParams.delete("state");
        window.history.replaceState(null, "", url.toString());
        setLoginStatus({
          kind: "error",
          message:
            error instanceof Error
              ? error.message
              : "OpenRouter sign-in failed. Please try again.",
        });
      });
  }, [args.configurable]);

  const llm = useCallback<StudioLlm>(
    async (request) => {
      try {
        const response = await fetch("/api/ai", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ...request,
            ...(settings ? { settings } : {}),
          }),
        });
        const payload: unknown = await response.json();
        return isStudioLlmResponse(payload)
          ? payload
          : {
              ok: false,
              code: "request-failed",
              message: "AI response did not match the Studio LLM contract.",
            };
      } catch {
        return {
          ok: false,
          code: "request-failed",
          message:
            "Could not reach the AI service. Check your connection and try again.",
        };
      }
    },
    [settings],
  );

  const navigate =
    args.navigate ?? ((url: string) => window.location.assign(url));

  return {
    llm: settings || args.enabled ? llm : undefined,
    aiSettings: args.configurable ? (
      <AiProviderSettings
        credentials={credentials}
        activeProvider={activeProvider}
        serverConfigured={args.enabled}
        remember={remember}
        loginStatus={loginStatus}
        onRememberChange={setRemember}
        onConnectOpenRouter={() => {
          setLoginStatus({ kind: "connecting" });
          void startOpenRouterLogin({
            currentUrl: window.location.href,
            navigate,
            remember,
          });
        }}
        onSave={(next) => {
          setCredentials((previous) => ({
            ...previous,
            [next.provider]: next,
          }));
          setActiveProvider(next.provider);
        }}
        onForget={() => {
          setCredentials({});
          setActiveProvider(null);
          setRemember(false);
        }}
      />
    ) : undefined,
  };
}

function emptyDraft(provider: AiProvider): AiSettings {
  return { provider, model: AI_PROVIDERS[provider].model, apiKey: "" };
}

function AiProviderSettings(props: {
  credentials: Credentials;
  activeProvider: AiProvider | null;
  serverConfigured: boolean;
  remember: boolean;
  loginStatus:
    | { kind: "idle" }
    | { kind: "connecting" }
    | { kind: "error"; message: string };
  onRememberChange: (remember: boolean) => void;
  onConnectOpenRouter: () => void;
  onSave: (settings: AiSettings) => void;
  onForget: () => void;
}) {
  const [provider, setProvider] = useState<AiProvider>(
    props.activeProvider ?? "openai",
  );
  const [draft, setDraft] = useState<AiSettings>(
    props.credentials[provider] ?? emptyDraft(provider),
  );

  // Follow external activation (OpenRouter callback, restored credentials).
  const { activeProvider } = props;
  const activeCredential = activeProvider
    ? props.credentials[activeProvider]
    : undefined;
  useEffect(() => {
    if (activeProvider) {
      setProvider(activeProvider);
      setDraft(activeCredential ?? emptyDraft(activeProvider));
    }
  }, [activeProvider, activeCredential]);

  const label = AI_PROVIDERS[provider].label;
  const normalizedDraft = {
    ...draft,
    apiKey: draft.apiKey.trim(),
    model: draft.model.trim(),
  };
  const isActive =
    props.activeProvider === provider &&
    props.credentials[provider]?.apiKey === draft.apiKey &&
    props.credentials[provider]?.model === draft.model;

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (isAiSettings(normalizedDraft)) props.onSave(normalizedDraft);
      }}
    >
      <FieldGroup className="gap-4">
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          aria-label="AI provider"
          className="w-full"
          value={provider}
          onValueChange={(value) => {
            if (!isAiProvider(value)) return;
            setProvider(value);
            setDraft(props.credentials[value] ?? emptyDraft(value));
          }}
        >
          {Object.entries(AI_PROVIDERS).map(([id, option]) => (
            <ToggleGroupItem
              key={id}
              value={id}
              className="flex-1 text-xs font-normal"
            >
              {option.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>

        {provider === "openrouter" ? (
          <Field className="gap-2">
            <Button
              type="button"
              size="sm"
              disabled={props.loginStatus.kind === "connecting"}
              onClick={props.onConnectOpenRouter}
            >
              <LogIn data-icon="inline-start" />
              {props.loginStatus.kind === "connecting"
                ? "Connecting…"
                : "Connect with OpenRouter"}
            </Button>
            <FieldDescription className="text-xs">
              Sign in to OpenRouter to use GPT, Claude, Gemini and more with one
              account, without copying a key. Or paste a key below.
            </FieldDescription>
          </Field>
        ) : null}

        {props.loginStatus.kind === "error" ? (
          <p role="alert" className="text-xs text-destructive">
            {props.loginStatus.message}
          </p>
        ) : null}

        <Field className="gap-1.5">
          <FieldLabel htmlFor="studio-ai-model" className="text-xs">
            Model
          </FieldLabel>
          <Input
            id="studio-ai-model"
            autoComplete="off"
            spellCheck={false}
            className="h-8 font-mono text-xs md:text-xs"
            value={draft.model}
            onChange={(event) =>
              setDraft({ ...draft, model: event.target.value })
            }
          />
        </Field>
        <Field className="gap-1.5">
          <FieldLabel htmlFor="studio-ai-key" className="text-xs">
            {label} API key
          </FieldLabel>
          <Input
            id="studio-ai-key"
            type="password"
            autoComplete="off"
            spellCheck={false}
            className="h-8 font-mono text-xs md:text-xs"
            value={draft.apiKey}
            placeholder="Paste your API key"
            onChange={(event) =>
              setDraft({ ...draft, apiKey: event.target.value })
            }
          />
        </Field>
        <Field orientation="horizontal" className="items-center gap-2">
          <Checkbox
            id="studio-ai-remember"
            aria-label="Remember on this device"
            checked={props.remember}
            onCheckedChange={(checked) =>
              props.onRememberChange(checked === true)
            }
          />
          <FieldLabel
            htmlFor="studio-ai-remember"
            className="text-xs font-normal"
          >
            Remember on this device
          </FieldLabel>
        </Field>
        <FieldDescription className="text-xs">
          {props.remember
            ? "Keys are saved in this browser's local storage. Only use this on a device you trust."
            : "Keys stay in this tab's memory and are cleared on reload."}{" "}
          Requests go through this Studio server to your provider.
        </FieldDescription>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="submit"
            size="sm"
            variant="outline"
            disabled={!isAiSettings(normalizedDraft) || isActive}
          >
            Use {label}
          </Button>
          {isActive ? (
            <Badge variant="secondary" className="font-normal">
              {props.remember
                ? "Active · remembered"
                : "Active for this session"}
            </Badge>
          ) : null}
          {Object.keys(props.credentials).length ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="ml-auto text-muted-foreground"
              onClick={() => {
                props.onForget();
                setDraft(emptyDraft(provider));
              }}
            >
              Forget keys
            </Button>
          ) : null}
        </div>
        {props.serverConfigured && !props.activeProvider ? (
          <FieldDescription className="text-xs">
            Using the provider configured on the server until you activate your
            own key.
          </FieldDescription>
        ) : null}
      </FieldGroup>
    </form>
  );
}
