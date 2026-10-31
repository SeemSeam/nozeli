export interface CustomProviderModelInput {
  readonly id: string;
  readonly contextWindow?: number;
  /** Optional display name; Nozeli writes service-discovered names, never secrets. */
  readonly name?: string;
  /**
   * Optional user declaration that the model supports reasoning/thinking. The
   * native model registry honors this field from models.json, so it is real
   * capability metadata, not UI-only state.
   */
  readonly reasoning?: boolean;
}

export interface CustomProviderInput {
  readonly providerId: string;
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly api?: 'openai-completions' | 'openai-responses' | 'anthropic-messages';
  readonly models: readonly CustomProviderModelInput[];
}

export interface CustomProviderEntry {
  readonly providerId: string;
  readonly baseUrl: string;
  readonly apiKey?: string;
  readonly api?: 'openai-completions' | 'openai-responses' | 'anthropic-messages';
  readonly models: readonly CustomProviderModelInput[];
}

export const CUSTOM_PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
export const OPENAI_COMPLETIONS_API = "openai-completions";

export const CUSTOM_PROVIDER_PLACEHOLDER_API_KEY = "unused";
export const PI_GUI_CUSTOM_PROVIDER_MARKER = "piGuiCustomEndpoint";
export const BUILT_IN_PROVIDER_IDS: ReadonlySet<string> = new Set([
  "amazon-bedrock",
  "anthropic",
  "azure",
  "cerebras",
  "deepseek",
  "fireworks",
  "github-copilot",
  "google",
  "google-antigravity",
  "google-gemini-cli",
  "google-vertex",
  "groq",
  "huggingface",
  "kimi-coding",
  "minimax",
  "minimax-cn",
  "mistral",
  "openai",
  "openai-codex",
  "opencode",
  "opencode-go",
  "openrouter",
  "vercel-ai-gateway",
  "xai",
  "zai",
]);

export function isValidHttpBaseUrl(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return (url.protocol === "http:" || url.protocol === "https:") && url.host.length > 0;
  } catch {
    return false;
  }
}
