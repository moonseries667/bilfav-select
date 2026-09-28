export interface LogEntry { at: string; level: 'info' | 'warning' | 'error'; message: string }
export function redact(text: string, secrets: string[] = []): string {
  let result = text.replace(/(?:bili_jct|csrf|SESSDATA|Cookie|Authorization|api[_ -]?key)\s*[:=]\s*[^\s,;]+/gi, '[已隐藏凭据]');
  for (const secret of secrets.filter(Boolean)) result = result.split(secret).join('[已隐藏凭据]');
  return result;
}
export function sanitizeExport<T>(value: T, secrets: string[]): T {
  function walk(item: unknown): unknown {
    if (typeof item === 'string') return redact(item, secrets);
    if (Array.isArray(item)) return item.map(walk);
    if (item && typeof item === 'object') {
      return Object.fromEntries(Object.entries(item).filter(([key]) => !/^(apiKey|cookie|csrf|SESSDATA|bili_jct|authorization)$/i.test(key)).map(([key, val]) => [key, walk(val)]));
    }
    return item;
  }
  return walk(value) as T;
}
export class Logger {
  entries: LogEntry[] = [];
  constructor(private secrets: () => string[] = () => []) {}
  add(message: string, level: LogEntry['level'] = 'info'): void {
    this.entries.push({ at: new Date().toISOString(), level, message: redact(message, this.secrets()) });
    if (this.entries.length > 1000) this.entries.shift();
  }
  export(): LogEntry[] { return sanitizeExport(this.entries, this.secrets()); }
}
