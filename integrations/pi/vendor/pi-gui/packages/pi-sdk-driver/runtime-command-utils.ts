export function normalizeRuntimeCommandName(value: string): string {
  return value.trim().replace(/^\/+/, "");
}

export function skillCommandName(name: string): string {
  return `skill:${normalizeRuntimeCommandName(name)}`;
}

export function skillSlashCommand(name: string): string {
  return `/${skillCommandName(name)}`;
}
