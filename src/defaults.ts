import categories from './categories.json';
import prompt from './prompts/classifier.txt?raw';
import type { Settings } from './types';

export const DEFAULT_SETTINGS: Settings = {
  provider: 'openai-compatible',
  baseUrl: '',
  apiKey: '',
  model: '',
  categories: categories.categories,
  confidenceThreshold: 0.7,
  prompt,
  aiBatchSize: 20,
  copyBatchSize: 10,
  requestDelayMs: 1000,
  cooldownMs: 30000,
  maxRetries: 2,
  verifyRetries: 2,
  metadataCacheTtlMs: 86400000,
};
