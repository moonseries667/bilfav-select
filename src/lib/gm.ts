/** Adapted from madoka-chann/Bilibili-AI-Favorites-Organizer src/utils/gm.ts (MIT). */
import { AppError } from './errors';

declare function GM_getValue<T>(key: string, fallback: T): T;
declare function GM_setValue(key: string, value: unknown): void;
declare function GM_addStyle(css: string): void;
declare function GM_xmlhttpRequest(details: GMXMLHttpRequestDetails): void;

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
  return new Promise((resolve, reject) => GM_xmlhttpRequest({
    method: options.method ?? 'GET', url, headers: options.headers, data: options.body,
    timeout: options.timeout ?? 30000, anonymous: options.anonymous ?? false,
    onload: resolve,
    onerror: () => reject(new AppError('网络连接失败', 'network', undefined, true)),
    ontimeout: () => reject(new AppError('请求超时', 'network', undefined, true)),
  }));
}
