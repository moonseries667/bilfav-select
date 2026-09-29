import type { AppData, Repository, Settings, ExecutionState, DiagnosticEvent } from '../types';
import { DEFAULT_SETTINGS } from '../defaults';
import { gmGetValue, gmSetValue } from './gm';
import { AppError } from './errors';
import legacyPrompt from '../prompts/classifier-legacy.txt?raw';
import formerDefaultPrompt from '../prompts/classifier-v1.txt?raw';

const DATA_KEY = 'bilfav-select:data:v1';
const SETTINGS_KEY = 'bilfav-select:settings:v1';
const DIAGNOSTICS_KEY = 'bilfav-select:diagnostics:v1';
export function loadDiagnostics(): { events: DiagnosticEvent[]; truncated: boolean } { return gmGetValue(DIAGNOSTICS_KEY, { events: [], truncated: false }); }
export function saveDiagnostics(events: DiagnosticEvent[], truncated = false): void { gmSetValue(DIAGNOSTICS_KEY, { events: events.slice(-5000), truncated }); }
export function emptyExecution(): ExecutionState {
  return { runId: null, manifestHash: null, phase: 'idle', targetFolderIds: {}, copiedAids: [],
    pendingAids: [], failedItems: [], retryCount: 0, sourceBefore: {} };
}
export function createInitialData(): AppData {
  return { state: { version: 1, sourceFrozen: false, sourceFolderIds: [], sourceFoldersSnapshot: [],
    generatedFolderIds: {}, execution: emptyExecution() } };
}
export class GMRepository implements Repository {
  load(): AppData {
    const data = gmGetValue<AppData>(DATA_KEY, createInitialData());
    if (!data?.state || data.state.version !== 1 || !Array.isArray(data.state.sourceFolderIds)) {
      throw new AppError('本地状态格式不兼容，请保留原状态并检查脚本版本', 'invalid');
    }
    return structuredClone(data);
  }
  save(data: AppData): void { gmSetValue(DATA_KEY, structuredClone(data)); }
}
export function loadSettings(): Settings {
  const result = { ...structuredClone(DEFAULT_SETTINGS), ...gmGetValue<Partial<Settings>>(SETTINGS_KEY, {}) };
  // Replace only the exact former built-in prompt; preserve all user-written prompts and tables.
  const normalizedPrompt = result.prompt.replace(/\r\n/g, '\n').trim();
  if ([legacyPrompt, formerDefaultPrompt].some(oldPrompt => normalizedPrompt === oldPrompt.replace(/\r\n/g, '\n').trim())) {
    result.prompt = DEFAULT_SETTINGS.prompt;
  }
  return result;
}
export function saveSettings(settings: Settings): void {
  // Settings are kept separately. The API key is never included in data, manifest or log exports.
  gmSetValue(SETTINGS_KEY, structuredClone(settings));
}
