export interface LogEntry { at: string; level: 'info' | 'warning' | 'error'; message: string }
import type { DiagnosticEvent } from '../types';
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
  diagnostics: DiagnosticEvent[] = [];
  truncated = false;
  private pendingDiagnostics = 0;
  constructor(private secrets: () => string[] = () => [], private persist?: (rows: DiagnosticEvent[], truncated: boolean) => void, initial: DiagnosticEvent[] = [], wasTruncated = false) { this.diagnostics = initial.slice(-5000); this.truncated = wasTruncated || initial.length > 5000; }
  add(message: string, level: LogEntry['level'] = 'info'): void {
    this.entries.push({ at: new Date().toISOString(), level, message: redact(message, this.secrets()) });
    if (this.entries.length > 1000) this.entries.shift();
  }
  export(): LogEntry[] { return sanitizeExport(this.entries, this.secrets()); }
  diagnostic(event: DiagnosticEvent): void {
    const safe = sanitizeExport({ ...event, at: event.at ?? new Date().toISOString() }, this.secrets());
    if (this.diagnostics.length >= 5000) { this.diagnostics.shift(); this.truncated = true; }
    this.diagnostics.push(safe);
    this.pendingDiagnostics++;
    if (this.pendingDiagnostics >= 25 || ['failed', 'paused', 'completed'].includes(String(event.outcome))) this.flush();
  }
  flush(): void { if (!this.pendingDiagnostics) return; this.persist?.(this.diagnostics, this.truncated); this.pendingDiagnostics = 0; }
  exportDetailed(): { truncated: boolean; events: DiagnosticEvent[] } { this.persist?.(this.diagnostics, this.truncated); this.pendingDiagnostics = 0; return sanitizeExport({ truncated: this.truncated, events: this.diagnostics }, this.secrets()); }
}
