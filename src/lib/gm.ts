/** Adapted from madoka-chann/Bilibili-AI-Favorites-Organizer src/utils/gm.ts (MIT). */
import { AppError } from './errors';

declare function GM_getValue<T>(key: string, fallback: T): T;
declare function GM_setValue(key: string, value: unknown): void;
declare function GM_addStyle(css: string): void;
declare function GM_xmlhttpRequest(details: GMXMLHttpRequestDetails): { abort?: () => void } | void;

export interface GMXMLHttpResponse {
  status: number;
  statusText: string;
  responseText: string;
  response: unknown;
  responseHeaders: string;
  finalUrl: string;
}
export interface GMXMLHttpRequestDetails {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  data?: string;
  timeout?: number;
  anonymous?: boolean;
  onload?: (response: GMXMLHttpResponse) => void;
  onerror?: (response: GMXMLHttpResponse) => void;
  ontimeout?: () => void;
  onabort?: () => void;
}
export const isUserscript = (): boolean => typeof GM_getValue === 'function';
export function gmGetValue<T>(key: string, fallback: T): T {
  if (isUserscript()) return GM_getValue(key, fallback);
  const raw = localStorage.getItem(key);
  return raw === null ? fallback : JSON.parse(raw) as T;
}
export function gmSetValue(key: string, value: unknown): void {
  if (isUserscript()) GM_setValue(key, value);
  else localStorage.setItem(key, JSON.stringify(value));
}
export function gmAddStyle(css: string): void {
  if (typeof GM_addStyle === 'function') GM_addStyle(css);
  else { const style = document.createElement('style'); style.textContent = css; document.head.append(style); }
}
export function gmFetch(url: string, options: {
  method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string;
  timeout?: number; anonymous?: boolean;
} = {}): Promise<GMXMLHttpResponse> {
  if (typeof GM_xmlhttpRequest !== 'function') {
    return Promise.reject(new AppError('网络请求仅在已安装的用户脚本中可用', 'network'));
  }
  const timeout = Number.isFinite(options.timeout) && Number(options.timeout) > 0 ? Number(options.timeout) : 30000;
  return new Promise((resolve, reject) => {
    let settled = false;
    let request: { abort?: () => void } | void;
    const finish = (error?: AppError, response?: GMXMLHttpResponse) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(response!);
    };
    const timeoutError = () => new AppError(`请求超时（${Math.round(timeout / 1000)} 秒）`, 'network', 408, true);
    // Some managers fail to deliver ontimeout. Keep an independent deadline
    // and ignore late callbacks so a stalled request cannot hold the workflow.
    const timer = setTimeout(() => {
      finish(timeoutError());
      try { request?.abort?.(); } catch { /* The promise is already rejected. */ }
    }, timeout);
    try {
      request = GM_xmlhttpRequest({
        method: options.method ?? 'GET', url, headers: options.headers, data: options.body,
        timeout, anonymous: options.anonymous ?? false,
        onload: response => finish(undefined, response),
        onerror: () => finish(new AppError('网络连接失败', 'network', undefined, true)),
        ontimeout: () => finish(timeoutError()),
        onabort: () => finish(new AppError('网络请求已中止', 'network', undefined, true)),
      });
    } catch {
      finish(new AppError('无法发起网络请求', 'network', undefined, true));
    }
  });
}
