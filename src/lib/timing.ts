export const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
export const jitter = (ms: number): number => Math.round(ms * (0.7 + Math.random() * 0.6));
export const backoff = (attempt: number, baseMs = 1500): number => Math.min(60000, baseMs * 2 ** attempt);
