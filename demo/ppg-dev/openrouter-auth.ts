/**
 * OpenRouter OAuth PKCE sign-in for the local demo.
 *
 * The user signs in on openrouter.ai and is redirected back with a one-time
 * `code`, which the browser exchanges for a user-controlled API key. No client
 * secret is involved: the PKCE verifier proves the redirect belongs to this tab.
 * See https://openrouter.ai/docs/use-cases/oauth-pkce
 */

const AUTH_URL = "https://openrouter.ai/auth";
const KEY_EXCHANGE_URL = "https://openrouter.ai/api/v1/auth/keys";
export const OPENROUTER_LOGIN_STORAGE_KEY = "studio-demo-ai:openrouter-login";

interface PendingOpenRouterLogin {
  verifier: string;
  state: string;
  remember: boolean;
  /** Studio hash route to restore after the redirect. */
  hash: string;
}

export interface CompletedOpenRouterLogin {
  key: string;
  remember: boolean;
  cleanUrl: string;
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function randomToken(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

async function createS256Challenge(verifier: string): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return base64Url(new Uint8Array(hash));
}

export async function startOpenRouterLogin(args: {
  currentUrl: string;
  navigate: (url: string) => void;
  remember: boolean;
}): Promise<void> {
  const current = new URL(args.currentUrl);
  const pending: PendingOpenRouterLogin = {
    verifier: randomToken(),
    state: randomToken(),
    remember: args.remember,
    hash: current.hash,
  };
  sessionStorage.setItem(OPENROUTER_LOGIN_STORAGE_KEY, JSON.stringify(pending));

  const target = new URL(AUTH_URL);
  target.searchParams.set("callback_url", current.origin + current.pathname);
  target.searchParams.set(
    "code_challenge",
    await createS256Challenge(pending.verifier),
  );
  target.searchParams.set("code_challenge_method", "S256");
  target.searchParams.set("state", pending.state);
  args.navigate(target.toString());
}

function readPendingLogin(): PendingOpenRouterLogin | null {
  try {
    const raw = sessionStorage.getItem(OPENROUTER_LOGIN_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as PendingOpenRouterLogin) : null;
  } catch {
    return null;
  }
}

/**
 * Finishes a sign-in when the current URL carries an OpenRouter `code`.
 * Returns null when there is nothing to complete.
 */
export async function completeOpenRouterLogin(args: {
  currentUrl: string;
  fetchImplementation?: typeof fetch;
}): Promise<CompletedOpenRouterLogin | null> {
  const url = new URL(args.currentUrl);
  const code = url.searchParams.get("code");

  if (!code) {
    return null;
  }

  const pending = readPendingLogin();
  sessionStorage.removeItem(OPENROUTER_LOGIN_STORAGE_KEY);

  if (!pending || url.searchParams.get("state") !== pending.state) {
    throw new Error(
      "OpenRouter sign-in could not be verified. Please try connecting again.",
    );
  }

  const response = await (args.fetchImplementation ?? fetch)(KEY_EXCHANGE_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code,
      code_verifier: pending.verifier,
      code_challenge_method: "S256",
    }),
  });
  const payload = (await response.json().catch(() => null)) as {
    key?: unknown;
  } | null;

  if (!response.ok || typeof payload?.key !== "string" || !payload.key) {
    throw new Error(
      `OpenRouter sign-in failed (${response.status}). Please try connecting again.`,
    );
  }

  return {
    key: payload.key,
    remember: pending.remember,
    cleanUrl: url.origin + url.pathname + (pending.hash || url.hash),
  };
}
