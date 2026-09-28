import type { BilibiliAdapter, Folder, FolderVideo, VideoMetadata } from './types';
import { gmGetValue, gmSetValue } from './lib/gm';
import { AppError } from './lib/errors';

// The local preview never contacts Bilibili or an AI provider.
const FIXTURES: VideoMetadata[] = [
  { aid: 1001, bvid: 'BVdemo1001', title: '土耳其电影 · 完整作品', description: '剧情长片完整正片', tags: ['土耳其', '电影', '剧情'], tname: '影视', duration: 5400, upper: { name: '电影资料馆' } },
  { aid: 1002, bvid: 'BVdemo1002', title: '如何拍出电影感旅行视频', description: '摄影剪辑教程', tags: ['电影', '教程', '摄影'], tname: '知识', duration: 960, upper: { name: '影像教室' } },
  { aid: 1003, title: '钢琴现场 · 夜曲', description: '钢琴音乐会演出', tags: ['音乐', '钢琴', '现场'], tname: '音乐', duration: 480, upper: { name: '音乐现场' } },
  { aid: 1004, title: '失效视频', description: '', tags: [], unavailable: true },
];
type DemoState = { folders: Folder[]; contents: Record<string, number[]>; nextId: number };
const INITIAL: DemoState = {
  folders: [
    { id: 10, title: '默认收藏夹', mediaCount: 0, isDefault: true },
    { id: 11, title: '待看视频-旧', mediaCount: 3, isDefault: false },
    { id: 12, title: '影像与声音', mediaCount: 2, isDefault: false },
  ],
  contents: { '10': [], '11': [1001, 1002, 1004], '12': [1001, 1003] }, nextId: 20,
};
export class DemoBilibiliAdapter implements BilibiliAdapter {
  private state = gmGetValue<DemoState>('bilfav-select:demo-server', structuredClone(INITIAL));
  private save(): void { gmSetValue('bilfav-select:demo-server', this.state); }
  private folder(id: number): Folder {
    const folder = this.state.folders.find(item => item.id === id);
    if (!folder) throw new AppError(`收藏夹 ${id} 不存在`, 'api', -404);
    return folder;
  }
  private writable(id: number): Folder {
    const folder = this.folder(id);
    if (folder.isDefault) throw new AppError('默认收藏夹禁止写入', 'safety');
    return folder;
  }
  async getCurrentUser() { return { mid: 123456, name: '本地演示' }; }
  async listFolders() { return structuredClone(this.state.folders); }
  async renameFolder(id: number, title: string) { this.writable(id).title = title; this.save(); }
  async createFolder(title: string) {
    const folder = { id: this.state.nextId++, title, mediaCount: 0, isDefault: false };
    this.state.folders.push(folder); this.state.contents[folder.id] = []; this.save();
    return structuredClone(folder);
  }
  async deleteFolder(id: number) {
    this.writable(id); this.state.folders = this.state.folders.filter(item => item.id !== id);
    delete this.state.contents[id]; this.save();
  }
  async listFolderVideos(id: number): Promise<FolderVideo[]> {
    this.folder(id);
    return (this.state.contents[id] ?? []).map(aid => structuredClone(FIXTURES.find(item => item.aid === aid)!));
  }
  async getVideoMetadata(aid: number) {
    const video = FIXTURES.find(item => item.aid === aid);
    if (!video) throw new AppError('视频已失效', 'unavailable', -404);
    return structuredClone(video);
  }
  async copyVideos(sourceId: number, targetId: number, aids: number[]) {
    this.folder(sourceId); const target = this.writable(targetId);
    for (const aid of aids) {
      if (!this.state.contents[sourceId].includes(aid)) throw new AppError('源中不存在视频', 'api');
      if (!this.state.contents[targetId].includes(aid)) this.state.contents[targetId].push(aid);
    }
    target.mediaCount = this.state.contents[targetId].length; this.save();
  }
  async getFolderAidSet(id: number) { this.folder(id); return new Set(this.state.contents[id]); }
}
export const demoAI = {
  async complete(_system: string, user: string): Promise<string> {
    const output = FIXTURES.filter(video => user.includes(String(video.aid))).map(video => ({
      aid: video.aid, category: video.aid === 1001 ? '电影' : video.aid === 1002 ? '知识' : '音乐',
      confidence: 0.96, reason: '本地演示样例响应',
    }));
    return JSON.stringify(output);
  },
};
