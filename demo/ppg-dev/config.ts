export interface DemoConfig {
  ai: {
    enabled: boolean;
    configurable: boolean;
  };
  bootId: string;
  database: {
    enabled: boolean;
  };
  queries: {
    enabled: boolean;
  };
  seededAt?: string;
  streams?: {
    url: string;
  };
}

const TRUE_ENV_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSE_ENV_VALUES = new Set(["0", "false", "no", "off"]);

function parseOptionalBooleanEnv(
  value: string | undefined,
): boolean | undefined {
  const normalized = value?.trim().toLowerCase();

  if (!normalized) {
    return undefined;
  }

  if (TRUE_ENV_VALUES.has(normalized)) {
    return true;
  }

  if (FALSE_ENV_VALUES.has(normalized)) {
    return false;
  }

  return undefined;
}

export function resolveDemoAiConfigurable(envValue?: string): boolean {
  return parseOptionalBooleanEnv(envValue) ?? true;
}

export function resolveDemoAiEnabled(args: {
  anthropicApiKey: string;
  envValue?: string;
}): boolean {
  if (args.anthropicApiKey.trim().length === 0) {
    return false;
  }

  return parseOptionalBooleanEnv(args.envValue) ?? true;
}

export function buildDemoConfig(args: {
  aiEnabled: boolean;
  aiConfigurable?: boolean;
  bootId: string;
  databaseEnabled: boolean;
  queryInsightsEnabled?: boolean;
  seededAt?: string | null;
  streamsUrl?: string;
}): DemoConfig {
  const {
    aiEnabled,
    bootId,
    databaseEnabled,
    queryInsightsEnabled = databaseEnabled,
    seededAt,
    streamsUrl,
  } = args;

  return {
    ai: {
      enabled: aiEnabled,
      configurable: args.aiConfigurable ?? true,
    },
    bootId,
    database: {
      enabled: databaseEnabled,
    },
    queries: {
      enabled: queryInsightsEnabled,
    },
    ...(seededAt
      ? {
          seededAt,
        }
      : {}),
    ...(streamsUrl
      ? {
          streams: {
            url: streamsUrl,
          },
        }
      : {}),
  };
}
