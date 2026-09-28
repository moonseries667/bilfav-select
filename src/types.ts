export type FolderId = number;
export const UNCERTAIN = '不确定';

export interface Folder {
  id: FolderId;
  fid?: number;
  mid?: number;
  title: string;
  mediaCount: number;
  isDefault: boolean;
  privacy?: number;
}
export interface SourceFolderSnapshot {
  id: FolderId;
  originalTitle: string;
  frozenTitle: string;
  mediaCount: number;
  renamed?: boolean;
}
export interface FolderVideo {
  aid: number;
  bvid?: string;
  title: string;
  description?: string;
  upper?: { mid?: number; name?: string };
  duration?: number;
  unavailable?: boolean;
}
export interface VideoMetadata {
  aid: number;
  bvid?: string;
  title: string;
  description: string;
  tags: string[];
  tname?: string;
  tid?: number;
  tidV2?: number;
  upper?: { mid?: number; name?: string };
  duration?: number;
  unavailable?: boolean;
}
export interface VideoRecord extends VideoMetadata {
  sourceFolderIds: FolderId[];
  primarySourceFolderId: FolderId;
  metadataFetchedAt: string;
}
export interface VideoDataset {
  version: number;
  updatedAt: string;
  sourceFolderIds: FolderId[];
  videos: VideoRecord[];
}
export interface CategoryDefinition { name: string; description: string }
export interface ClassificationResult {
  aid: number;
  bvid?: string;
  category: string;
  confidence: number;
  reason?: string;
}
export interface ClassificationManifest {
  version: number;
  runId: string;
  createdAt: string;
  datasetVersion: number;
  datasetUpdatedAt: string;
  categories: CategoryDefinition[];
  confidenceThreshold: number;
  promptVersion: number;
  prompt: string;
  results: ClassificationResult[];
  stats: Record<string, number>;
}
export type ExecutionPhase = 'idle' | 'preparing' | 'cleanup' | 'creating' | 'copying' | 'verifying' | 'paused' | 'failed' | 'completed';
export interface FailedItem { aid: number; category: string; error: string; attempts: number }
export interface VerifyCategory { expected: number; actual: number; missing: number[]; unexpected: number[] }
export interface VerificationReport {
  verifiedAt: string;
  total: number;
  copied: number;
  uncertain: number;
  unavailable: number;
  failed: number;
  perCategory: Record<string, VerifyCategory>;
  wrongCategory: { aid: number; expected: string; actual: string }[];
  sourceMissing: Record<string, number[]>;
  passed: boolean;
}
export interface ExecutionState {
  runId: string | null;
  manifestHash: string | null;
  phase: ExecutionPhase;
  resumePhase?: ExecutionPhase;
  targetFolderIds: Record<string, FolderId>;
  copiedAids: number[];
  pendingAids: number[];
  failedItems: FailedItem[];
  retryCount: number;
  sourceBefore: Record<string, number[]>;
  verification?: VerificationReport;
  error?: string;
}
export interface PersistentState {
  version: number;
  ownerMid?: number;
  sourceFrozen: boolean;
  freezePending?: boolean;
  frozenAt?: string;
  sourceFolderIds: FolderId[];
  sourceFoldersSnapshot: SourceFolderSnapshot[];
  generatedFolderIds: Record<string, FolderId>;
  execution: ExecutionState;
}
export interface AppData { state: PersistentState; dataset?: VideoDataset; manifest?: ClassificationManifest }
export interface AISettings {
  provider: 'openai-compatible' | 'deepseek' | 'ollama';
  baseUrl: string;
  apiKey: string;
  model: string;
}
export interface Settings extends AISettings {
  categories: CategoryDefinition[];
  confidenceThreshold: number;
  prompt: string;
  aiBatchSize: number;
  copyBatchSize: number;
  requestDelayMs: number;
  cooldownMs: number;
  maxRetries: number;
  verifyRetries: number;
  metadataCacheTtlMs: number;
}
export interface BilibiliAdapter {
  getCurrentUser(): Promise<{ mid: number; name: string }>;
  listFolders(): Promise<Folder[]>;
  renameFolder(id: FolderId, title: string): Promise<void>;
  createFolder(title: string): Promise<Folder>;
  deleteFolder(id: FolderId): Promise<void>;
  listFolderVideos(id: FolderId): Promise<FolderVideo[]>;
  getVideoMetadata(aid: number, bvid?: string): Promise<VideoMetadata>;
  copyVideos(sourceId: FolderId, targetId: FolderId, aids: number[]): Promise<void>;
  getFolderAidSet(id: FolderId): Promise<Set<number>>;
}
export interface Repository { load(): AppData; save(data: AppData): void }
export interface Progress { phase: string; completed: number; total: number; message: string }
export interface RuntimeHooks {
  checkpoint?: () => void;
  progress?: (progress: Progress) => void;
  log?: (message: string, level?: 'info' | 'warning' | 'error') => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
}
export interface CopyItem { aid: number; category: string; sourceId: FolderId; targetId: FolderId }
export interface BatchOptions {
  batchSize: number;
  maxRetries: number;
  delayMs: number;
  cooldownMs: number;
}
