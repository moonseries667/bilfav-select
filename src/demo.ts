import type { BilibiliAdapter, Folder, FolderVideo, VideoMetadata } from './types';
import { gmGetValue, gmSetValue } from './lib/gm';
import { AppError } from './lib/errors';

// The local preview never contacts Bilibili or an AI provider.
const FIXTURES: VideoMetadata[] = [
  { aid: 1001, bvid: 'BVdemo1001', title: 'MMD 模型舞蹈展示', description: '使用 MMD 制作的模型演出成片', tags: ['MMD', '舞蹈'], tname: '动画', duration: 180, upper: { name: '模型工坊' } },
  { aid: 1002, bvid: 'BVdemo1002', title: '漫画人物绘画上色教程', description: '演示人物绘画、配色和上色技巧', tags: ['漫画', '绘画', '教程'], tname: '绘画', duration: 960, upper: { name: '绘画教室' } },
  { aid: 1003, title: '科普：为什么天空是蓝色的？', description: '解释光的散射及天空颜色的科学原理', tags: ['科普', '物理'], tname: '科学科普', duration: 480, upper: { name: '科学时间' } },
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
    const allowed = JSON.parse(user.split('allowedCategoryNames = ')[1].split('\n')[0]) as string[];
    const videos = JSON.parse(user.slice(user.indexOf('videos = ') + 'videos = '.length)) as VideoMetadata[];
    const output = videos.map(video => {
      const text = `${video.title} ${video.description}`;
      const category = /MMD/i.test(text) ? 'MMD' : /绘画/.test(text) ? '绘画' : /科普|科学原理/.test(text) ? '科普' : '不确定';
      return { aid: video.aid, category: allowed.includes(category) ? category : '不确定',
        confidence: 0.96, reason: '本地演示样例响应' };
    });
    return JSON.stringify(output);
  },
};
