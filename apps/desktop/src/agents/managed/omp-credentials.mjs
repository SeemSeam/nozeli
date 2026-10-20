// Scrub ambient provider credentials and runtime selectors before supplying the
// explicit Nozeli-owned configuration root, role directory and broker grant.
export function scrubProviderEnv(env, { allow = [] } = {}) {
  const allowSet = new Set(allow);
  const CREDENTIAL_ENV = /^(?:[A-Z0-9_]*API_KEY|ANTHROPIC_[A-Z_]*|OPENAI_[A-Z_]*|GEMINI_API|GOOGLE_API|GOOGLE_CLOUD|AZURE_[A-Z_]*|AWS_[A-Z_]*|BEDROCK_[A-Z_]*|CODEX_HOME|CLAUDE_CONFIG_DIR|PI_CODING_AGENT_DIR|PI_CONFIG_DIR|PI_CONFIG_FILES|OMP_PROFILE|PI_PROFILE|XDG_(?:DATA|STATE|CACHE)_HOME|OMP_AUTH_BROKER_[A-Z_]*|GITHUB_TOKEN|GITLAB_TOKEN|HF_TOKEN)$/;
  const scrubbed = {}; const removed = [];
  for (const [key, value] of Object.entries(env ?? {})) {
    if (CREDENTIAL_ENV.test(key) && !allowSet.has(key)) { removed.push(key); continue; }
    if (!allowSet.has(key) && (/SECRET|TOKEN|PASSWORD|CREDENTIAL/i.test(key) || /^(?:NOZELI_(?:CONFIG_ROOT|AGENT_DIR|OMP_SOURCE_HOME)|BUN_OPTIONS|NODE_OPTIONS)$/.test(key))) { removed.push(key); continue; }
    scrubbed[key] = value;
  }
  return { env: scrubbed, removed };
}
