export type ErrorKind = 'api' | 'network' | 'rate-limit' | 'invalid' | 'unavailable' | 'safety' | 'paused';
export class AppError extends Error {
  constructor(message: string, public kind: ErrorKind = 'api', public code?: number, public retryable = false) {
    super(message);
    this.name = 'AppError';
  }
}
export class PauseError extends AppError {
  constructor() { super('操作已暂停，可从当前进度继续', 'paused'); }
}
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '请求失败，请检查连接后重试';
}
