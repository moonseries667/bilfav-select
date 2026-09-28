/**
 * Current-account Bilibili adapter. API shapes follow the documented web
 * endpoints and the adapter boundary follows the MIT-licensed
 * madoka-chann/Bilibili-AI-Favorites-Organizer project.
 */
import { AppError } from '../lib/errors';
import type {
  BilibiliAdapter,
  Folder,
  FolderId,
  FolderVideo,
  RuntimeHooks,
  Settings,
  VideoMetadata,
} from '../types';
import {
  BilibiliHttpClient,
  type BilibiliTransport,
  buildBilibiliForm,
  readBilibiliCsrf,
} from './bilibili-http';

type RawObject = Record<string, unknown>;
type CurrentUser = { mid: number; name: string };
type CreatedFoldersData = { count?: number; list?: RawObject[] | null };
type FolderInfo = RawObject & {
  id?: number;
  fid?: number;
  mid?: number;
  attr?: number;
  title?: string;
  intro?: string;
  cover?: string;
  media_count?: number;
};
type FolderResource = RawObject & {
  id?: number;
  type?: number;
  title?: string;
  intro?: string;
  duration?: number;
  attr?: number;
  bvid?: string;
  bv_id?: string;
  upper?: RawObject;
};
type ResourcePage = {
  info?: { media_count?: number };
  medias?: FolderResource[] | null;
  has_more?: boolean;
};
type ViewResponse = {
  aid?: number;
  bvid?: string;
  title?: string;
  desc?: string;
  tname?: string;
  tid?: number;
  tid_v2?: number;
  duration?: number;
  owner?: RawObject;
  state?: number;
};

const API = 'https://api.bilibili.com';
const FOLDER_CACHE_MS = 15_000;
const PAGE_SIZE = 20;
const MAX_RESOURCE_PAGES = 10_000;
// Video metadata routes report invisible, pending-review and owner-only
// manuscripts separately from deleted videos. All are ineligible for this run.
// https://github.com/bilibili-plugins/bilibili-api-collect/blob/master/docs/video/info.md
const UNAVAILABLE_VIDEO_CODES = new Set([62002, 62004, 62012]);

function asRecord(value: unknown): RawObject | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RawObject : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return undefined;
}

function requiredPositiveInteger(value: unknown, description: string): number {
  const number = asFiniteNumber(value);
  if (!Number.isSafeInteger(number) || Number(number) <= 0) {
    throw new AppError(`B 站返回的${description}无效`, 'invalid');
  }
  return Number(number);
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function ownFolderFromApi(raw: RawObject, ownerMid: number): Folder {
  const id = requiredPositiveInteger(raw.id, '收藏夹 ID');
  const owner = asFiniteNumber(raw.mid);
  if (owner !== undefined && owner !== ownerMid) {
    throw new AppError('B 站收藏夹列表包含其他用户的数据，已停止操作', 'safety');
  }

  const fid = asFiniteNumber(raw.fid);
  const attr = asFiniteNumber(raw.attr);
  const directMarker = typeof raw.is_default === 'boolean'
    ? raw.is_default
    : typeof raw.isDefault === 'boolean'
      ? raw.isDefault
      : typeof raw.default_folder === 'boolean' ? raw.default_folder : undefined;
  // The documented second attr bit is the stable default marker (0 = default,
  // 1 = user-created). fid alone is not treated as a default marker.
  const attrMarker = attr === undefined ? undefined : (Math.trunc(attr) & 2) === 0;
  if (directMarker !== undefined && attrMarker !== undefined && directMarker !== attrMarker) {
    throw new AppError('B 站收藏夹的默认身份标记互相矛盾，已停止操作', 'safety');
  }
  const isDefault = directMarker ?? attrMarker;
  if (isDefault === undefined) {
    throw new AppError('无法从 B 站接口确认收藏夹是否为系统默认夹，已停止操作', 'safety');
  }

  const mediaCount = asFiniteNumber(raw.media_count);
  if (mediaCount === undefined || mediaCount < 0) {
    throw new AppError('B 站收藏夹缺少有效内容数量，无法验证完整列表', 'invalid');
  }
  if (typeof raw.title !== 'string') throw new AppError('B 站收藏夹缺少标题', 'invalid');

  const privacy = asFiniteNumber(raw.privacy) ?? (attr === undefined ? undefined : Math.trunc(attr) & 1);
  return {
    id,
    ...(fid === undefined ? {} : { fid }),
    mid: ownerMid,
    title: raw.title,
    mediaCount,
    isDefault,
    ...(privacy === undefined ? {} : { privacy }),
  };
}

function makeApiUrl(path: string, params: Record<string, string | number>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) query.set(key, String(value));
  return `${API}${path}?${query.toString()}`;
}

function resourceKey(media: FolderResource): string {
  const raw = asRecord(media);
  return `${requiredPositiveInteger(raw?.id, '资源 ID')}:${requiredPositiveInteger(raw?.type, '资源类型')}`;
}

function isUnavailableResource(media: FolderResource): boolean {
  const attr = asFiniteNumber(media.attr);
  // Bit 0 marks unavailable resources (including attr 1 and 9). Other
  // attribute bits, such as interactive videos, do not imply deletion.
  return attr !== undefined && (Math.trunc(attr) & 1) !== 0;
}

function isUnavailableVideoError(error: unknown): error is AppError {
  return error instanceof AppError && (error.kind === 'unavailable' ||
    (error.kind === 'api' && error.code !== undefined && UNAVAILABLE_VIDEO_CODES.has(error.code)));
}

function isBatchEndpointUnavailable(error: unknown): boolean {
  return error instanceof AppError && (error.code === 404 || error.code === 405 || error.code === 501);
}

/**
 * Bilibili HTTP implementation used by the workflow. Deleting a folder is
 * intentionally exposed only as the interface operation; the workflow must
 * pass IDs from its persisted generatedFolderIds registry.
 */
export class HttpBilibiliAdapter implements BilibiliAdapter {
  private readonly http: BilibiliHttpClient;
  private folderCache?: { fetchedAt: number; ownerMid: number; folders: Folder[] };
  private readonly unavailableAids = new Set<number>();

  constructor(
    settings: Pick<Settings, 'requestDelayMs' | 'cooldownMs' | 'maxRetries'>,
    private readonly hooks: RuntimeHooks = {},
    transport?: BilibiliTransport,
  ) {
    // Keep the settings object itself: the UI mutates it as settings are saved.
    this.http = new BilibiliHttpClient(settings, hooks, transport);
  }

  async getCurrentUser(): Promise<CurrentUser> {
    const response = await this.http.getData<RawObject>(`${API}/x/web-interface/nav`);
    const mid = requiredPositiveInteger(response?.mid, '当前用户 mid');
    if (response?.isLogin === false || response?.isLogin === 0) {
      throw new AppError('请先登录 Bilibili 后再使用收藏夹操作', 'safety');
    }
    const name = asString(response?.uname, asString(response?.name));
    if (!name) throw new AppError('无法读取当前 Bilibili 用户名，请刷新登录页面后重试', 'invalid');
    return { mid, name };
  }

  async listFolders(): Promise<Folder[]> {
    const user = await this.getCurrentUser();
    const data = await this.http.getData<CreatedFoldersData>(makeApiUrl('/x/v3/fav/folder/created/list-all', { up_mid: user.mid }));
    if (!data || typeof data !== 'object') throw new AppError('B 站未返回当前用户的收藏夹列表', 'invalid');
    const rawList = data.list;
    if (rawList == null) {
      if (data.count === 0) {
        this.folderCache = { fetchedAt: Date.now(), ownerMid: user.mid, folders: [] };
        return [];
      }
      throw new AppError('B 站收藏夹列表不完整，已停止操作', 'invalid', undefined, true);
    }
    if (!Array.isArray(rawList)) throw new AppError('B 站收藏夹列表格式无效', 'invalid');
    if (data.count !== undefined && Number(data.count) !== rawList.length) {
      throw new AppError('B 站收藏夹列表被截断，已停止操作', 'invalid', undefined, true);
    }
    const folders = rawList.map(raw => ownFolderFromApi(raw, user.mid));
    this.folderCache = { fetchedAt: Date.now(), ownerMid: user.mid, folders };
    return folders;
  }

  async renameFolder(id: FolderId, title: string): Promise<void> {
    const user = await this.getCurrentUser();
    const folder = await this.assertOwnedFolder(id, user.mid, true);
    if (folder.isDefault) throw new AppError('系统默认收藏夹禁止改名', 'safety');
    if (typeof title !== 'string' || !title.trim()) throw new AppError('收藏夹名称不能为空', 'invalid');
    if (folder.title === title) return;

    const detail = await this.http.getData<FolderInfo>(makeApiUrl('/x/v3/fav/folder/info', { media_id: id }));
    this.assertDetailIdentity(detail, id, user.mid);
    const detailAttr = asFiniteNumber(detail.attr);
    if (detailAttr === undefined) throw new AppError('无法从收藏夹详情确认默认身份，已停止改名', 'safety');
    const defaultMarker = (Math.trunc(detailAttr) & 2) === 0;
    if (defaultMarker) throw new AppError('系统默认收藏夹禁止改名', 'safety');
    const privacy = detailAttr & 1;

    await this.http.postData(`${API}/x/v3/fav/folder/edit`, {
      media_id: id,
      title,
      intro: asString(detail.intro),
      privacy,
      cover: asString(detail.cover),
      csrf: readBilibiliCsrf(),
    });
    this.folderCache = undefined;
  }

  async createFolder(title: string): Promise<Folder> {
    if (typeof title !== 'string' || !title.trim()) throw new AppError('收藏夹名称不能为空', 'invalid');
    const user = await this.getCurrentUser();
    // A single create attempt avoids ambiguous network failures creating duplicates.
    const created = await this.http.postData<FolderInfo>(`${API}/x/v3/fav/folder/add`, {
      title,
      privacy: 1,
      csrf: readBilibiliCsrf(),
    }, { retryNetwork: false });
    this.assertDetailIdentity(created, undefined, user.mid);
    const folder = ownFolderFromApi(created, user.mid);
    if (folder.isDefault) throw new AppError('B 站返回的创建结果指向系统默认收藏夹，已停止', 'safety');
    if (folder.title !== title) throw new AppError('B 站创建结果与请求的收藏夹名称不一致', 'invalid');
    this.folderCache = undefined;
    return folder;
  }

  /** Call only with IDs currently registered in persisted generatedFolderIds. */
  async deleteFolder(id: FolderId): Promise<void> {
    const user = await this.getCurrentUser();
    const folder = await this.assertOwnedFolder(id, user.mid, true);
    if (folder.isDefault) throw new AppError('系统默认收藏夹禁止删除', 'safety');
    await this.http.postData(`${API}/x/v3/fav/folder/del`, {
      media_ids: id,
      csrf: readBilibiliCsrf(),
    }, { retryNetwork: false });
    this.folderCache = undefined;
  }

  async listFolderVideos(id: FolderId): Promise<FolderVideo[]> {
    const user = await this.getCurrentUser();
    const folder = await this.assertOwnedFolder(id, user.mid, true);
    if (folder.isDefault) throw new AppError('系统默认收藏夹禁止扫描', 'safety');

    const allRaw: FolderResource[] = [];
    let expectedCount = folder.mediaCount;
    let pageNumber = 1;
    const pageSignatures = new Set<string>();
    let hasMore = true;

    while (hasMore) {
      if (pageNumber > MAX_RESOURCE_PAGES) throw new AppError('收藏夹页数异常，已停止以防返回不完整结果', 'invalid');
      this.hooks.checkpoint?.();
      const page = await this.http.getData<ResourcePage>(makeApiUrl('/x/v3/fav/resource/list', {
        media_id: id,
        pn: pageNumber,
        ps: PAGE_SIZE,
        order: 'mtime',
        platform: 'web',
      }));
      if (!page || typeof page.has_more !== 'boolean') {
        throw new AppError(`收藏夹第 ${pageNumber} 页响应不完整，拒绝返回部分内容`, 'invalid', undefined, true);
      }
      const firstPageCount = pageNumber === 1 ? asFiniteNumber(page.info?.media_count) : undefined;
      if (pageNumber === 1 && page.info?.media_count !== undefined) {
        if (firstPageCount === undefined || firstPageCount < 0) throw new AppError('收藏夹总数无效，拒绝返回部分内容', 'invalid');
        expectedCount = firstPageCount;
      }
      let pageMedias: FolderResource[];
      if (Array.isArray(page.medias)) {
        pageMedias = page.medias;
      } else if (page.medias === null) {
        // A page can be empty when its entries are all hidden/unavailable.
        // A nonzero count is reconciled against the complete ID list below.
        pageMedias = [];
      } else {
        throw new AppError(`收藏夹第 ${pageNumber} 页内容缺失，拒绝返回部分结果`, 'invalid', undefined, true);
      }
      const pageIds = pageMedias.map(media => `${asFiniteNumber(media.id) ?? 'x'}:${asFiniteNumber(media.type) ?? 'x'}`);
      const signature = pageIds.join(',');
      if (pageSignatureSetHas(pageSignatures, signature)) {
        throw new AppError('B 站分页重复返回同一页，拒绝返回不完整内容', 'invalid', undefined, true);
      }
      if (signature) pageSignatures.add(signature);
      if (page.has_more && pageMedias.length === 0 && pageNumber >= Math.max(1, Math.ceil(expectedCount / PAGE_SIZE))) {
        throw new AppError('B 站分页超出收藏夹总数仍返回空页，拒绝返回部分内容', 'invalid', undefined, true);
      }
      allRaw.push(...pageMedias);
      hasMore = page.has_more;
      if (this.hooks.progress) {
        this.hooks.progress({
          phase: 'scanning',
          completed: allRaw.length,
          total: expectedCount ?? folder.mediaCount,
          message: `正在读取收藏夹第 ${pageNumber} 页`,
        });
      }
      pageNumber++;
    }

    if (allRaw.length !== expectedCount) {
      await this.reconcileFolderResources(id, allRaw, expectedCount);
    }

    const videos: FolderVideo[] = [];
    const seenAids = new Set<number>();
    for (const media of allRaw) {
      const type = asFiniteNumber(media.type);
      if (!Number.isSafeInteger(type) || Number(type) <= 0) throw new AppError('收藏内容缺少有效资源类型，拒绝静默丢弃视频', 'invalid');
      if (type !== 2) continue;
      if (isUnavailableResource(media)) {
        const aid = asFiniteNumber(media.id);
        if (aid !== undefined) this.unavailableAids.add(aid);
        continue;
      }
      const aid = requiredPositiveInteger(media.id, '视频 aid');
      if (this.unavailableAids.has(aid)) continue;
      if (seenAids.has(aid)) continue;
      seenAids.add(aid);
      const upper = asRecord(media.upper);
      const upperMid = asFiniteNumber(upper?.mid);
      videos.push({
        aid,
        ...((typeof media.bvid === 'string' && media.bvid) || (typeof media.bv_id === 'string' && media.bv_id)
          ? { bvid: String(media.bvid || media.bv_id) } : {}),
        title: asString(media.title),
        description: asString(media.intro),
        ...(upperMid === undefined && typeof upper?.name !== 'string' ? {} : {
          upper: {
            ...(upperMid === undefined ? {} : { mid: upperMid }),
            ...(typeof upper?.name === 'string' ? { name: upper.name } : {}),
          },
        }),
        ...(asFiniteNumber(media.duration) === undefined ? {} : { duration: asFiniteNumber(media.duration) }),
      });
    }
    return videos;
  }

  async getVideoMetadata(aid: number, bvid?: string): Promise<VideoMetadata> {
    const validAid = requiredPositiveInteger(aid, '视频 aid');
    const unavailable = (reason?: string): VideoMetadata => {
      if (!this.unavailableAids.has(validAid)) {
        this.hooks.log?.(`已跳过不可用视频 aid ${validAid}${reason ? `（${reason}）` : ''}，不再获取标签或参与分类、复制`, 'info');
      }
      this.unavailableAids.add(validAid);
      return { aid: validAid, ...(bvid ? { bvid } : {}), title: '当前不可用视频', description: '', tags: [], unavailable: true };
    };
    if (this.unavailableAids.has(validAid)) return unavailable();
    const viewUrl = makeApiUrl('/x/web-interface/view', bvid ? { bvid } : { aid: validAid });
    let view: ViewResponse;
    try {
      view = await this.http.getData<ViewResponse>(viewUrl);
    } catch (error) {
      if (isUnavailableVideoError(error)) {
        return unavailable(error.code === undefined ? undefined : `code ${error.code}`);
      }
      throw error;
    }
    const actualAid = asFiniteNumber(view?.aid);
    if (actualAid !== validAid || typeof view?.title !== 'string') {
      throw new AppError('B 站视频详情与请求的 aid 不一致或缺少标题', 'invalid');
    }
    const state = asFiniteNumber(view.state);
    if (state !== undefined && state < 0) {
      return unavailable(`state ${state}`);
    }
    let tagData: unknown;
    try {
      tagData = await this.http.getData<unknown>(makeApiUrl('/x/web-interface/view/detail/tag', { aid: validAid }));
    } catch (error) {
      // The video may cease to be accessible between the view and tag reads.
      if (isUnavailableVideoError(error)) {
        return unavailable(error.code === undefined ? undefined : `code ${error.code}`);
      }
      throw error;
    }
    if (tagData !== null && !Array.isArray(tagData)) throw new AppError('B 站视频标签响应格式无效，拒绝保存不完整标签', 'invalid');
    const tags = (Array.isArray(tagData) ? tagData : []).map((tag: unknown) => {
      const name = asRecord(tag)?.tag_name;
      if (typeof name !== 'string' || !name.trim()) throw new AppError('B 站标签条目缺少名称，拒绝保存部分标签', 'invalid');
      return name;
    });
    const owner = asRecord(view.owner);
    const ownerMid = asFiniteNumber(owner?.mid);
    const duration = asFiniteNumber(view.duration);
    const tid = asFiniteNumber(view.tid);
    const tidV2 = asFiniteNumber(view.tid_v2);
    return {
      aid: validAid,
      ...((typeof view.bvid === 'string' && view.bvid) || bvid ? { bvid: String(view.bvid || bvid) } : {}),
      title: view.title,
      description: asString(view.desc),
      tags,
      ...(typeof view.tname === 'string' ? { tname: view.tname } : {}),
      ...(tid === undefined ? {} : { tid }),
      ...(tidV2 === undefined ? {} : { tidV2 }),
      ...(ownerMid === undefined && typeof owner?.name !== 'string' ? {} : {
        upper: {
          ...(ownerMid === undefined ? {} : { mid: ownerMid }),
          ...(typeof owner?.name === 'string' ? { name: owner.name } : {}),
        },
      }),
      ...(duration === undefined ? {} : { duration }),
    };
  }

  async copyVideos(sourceId: FolderId, targetId: FolderId, aids: number[]): Promise<void> {
    if (!aids.length) return;
    const validAids = [...new Set(aids.map(aid => requiredPositiveInteger(aid, '视频 aid')))]
      .filter(aid => !this.unavailableAids.has(aid));
    if (!validAids.length) return;
    if (sourceId === targetId) throw new AppError('源收藏夹与目标收藏夹不能相同', 'safety');
    const user = await this.getCurrentUser();
    const source = await this.assertOwnedFolder(sourceId, user.mid, false);
    const target = await this.assertOwnedFolder(targetId, user.mid, false);
    if (source.isDefault || target.isDefault) throw new AppError('复制操作不能读取或写入系统默认收藏夹', 'safety');
    const csrf = readBilibiliCsrf();

    try {
      await this.http.postData(`${API}/x/v3/fav/resource/copy`, {
        src_media_id: sourceId,
        tar_media_id: targetId,
        mid: user.mid,
        resources: validAids.map(aid => `${aid}:2`).join(','),
        platform: 'web',
        csrf,
      }, { retryNetwork: false });
    } catch (error) {
      if (!isBatchEndpointUnavailable(error)) throw error;
      this.hooks.log?.('当前批量复制接口不可用，改用逐条添加到目标收藏夹', 'warning');
      for (const aid of validAids) {
        this.hooks.checkpoint?.();
        await this.http.postData(`${API}/x/v3/fav/resource/deal`, {
          rid: aid,
          type: 2,
          add_media_ids: targetId,
          del_media_ids: '',
          platform: 'web',
          csrf,
        }, { retryNetwork: false, acceptedCodes: [11201] });
      }
    }
  }

  async getFolderAidSet(id: FolderId): Promise<Set<number>> {
    const videos = await this.listFolderVideos(id);
    return new Set(videos.map(video => video.aid));
  }

  isVideoUnavailable(aid: number): boolean {
    return this.unavailableAids.has(aid);
  }

  private async reconcileFolderResources(id: FolderId, resources: FolderResource[], expectedCount: number): Promise<void> {
    // media_count may include hidden unavailable entries. Do not use a count
    // mismatch alone to guess which videos are unavailable or accept lost pages.
    const ids = await this.http.getData<FolderResource[]>(makeApiUrl('/x/v3/fav/resource/ids', {
      media_id: id, platform: 'web',
    }));
    if (!Array.isArray(ids)) throw new AppError('收藏夹完整 ID 列表缺失，拒绝返回部分内容', 'invalid', undefined, true);
    const byKey = new Map(ids.map(media => [resourceKey(media), media]));
    const returnedKeys = new Set(resources.map(resourceKey));
    if (byKey.size !== ids.length || returnedKeys.size !== resources.length ||
        [...returnedKeys].some(key => !byKey.has(key))) {
      throw new AppError('收藏夹分页与完整 ID 列表不一致，请重试扫描', 'invalid', undefined, true);
    }
    for (const [key, media] of byKey) {
      if (returnedKeys.has(key) || asFiniteNumber(media.type) !== 2) continue;
      const aid = requiredPositiveInteger(media.id, '视频 aid');
      if (this.unavailableAids.has(aid)) continue;
      const bvid = asString(media.bvid, asString(media.bv_id));
      const metadata = await this.getVideoMetadata(aid, bvid || undefined);
      if (!metadata.unavailable) {
        // An available ID missing from pagination is a genuinely partial scan.
        throw new AppError(`收藏夹漏读了有效视频 ${aid}，请重试扫描`, 'invalid', undefined, true);
      }
    }
    this.hooks.log?.(`收藏夹 ${id} 返回 ${resources.length}/${expectedCount} 项，已核对完整 ID 列表；失效视频跳过，可用视频继续处理`, 'info');
  }

  private async assertOwnedFolder(id: FolderId, ownerMid: number, refresh: boolean): Promise<Folder> {
    const validId = requiredPositiveInteger(id, '收藏夹 ID');
    let folders: Folder[] | undefined;
    const cache = this.folderCache;
    if (!refresh && cache && cache.ownerMid === ownerMid && Date.now() - cache.fetchedAt < FOLDER_CACHE_MS) folders = cache.folders;
    if (!folders) {
      if (refresh) folders = await this.fetchFoldersForUser(ownerMid);
      else folders = await this.listFolders();
    }
    const folder = folders.find(item => item.id === validId);
    if (!folder) throw new AppError('目标收藏夹已不存在或不属于当前用户，未执行操作', 'safety');
    return folder;
  }

  private async fetchFoldersForUser(ownerMid: number): Promise<Folder[]> {
    const data = await this.http.getData<CreatedFoldersData>(makeApiUrl('/x/v3/fav/folder/created/list-all', { up_mid: ownerMid }));
    if (!data || typeof data !== 'object') throw new AppError('B 站未返回当前用户的收藏夹列表', 'invalid');
    const rawList = data.list;
    if (rawList == null) {
      if (data.count === 0) return [];
      throw new AppError('B 站收藏夹列表不完整，已停止操作', 'invalid', undefined, true);
    }
    if (!Array.isArray(rawList)) throw new AppError('B 站收藏夹列表格式无效', 'invalid');
    if (data.count !== undefined && Number(data.count) !== rawList.length) {
      throw new AppError('B 站收藏夹列表被截断，已停止操作', 'invalid', undefined, true);
    }
    const folders = rawList.map(raw => ownFolderFromApi(raw, ownerMid));
    this.folderCache = { fetchedAt: Date.now(), ownerMid, folders };
    return folders;
  }

  private assertDetailIdentity(detail: FolderInfo, expectedId: number | undefined, ownerMid: number): void {
    if (!detail || typeof detail !== 'object') throw new AppError('B 站没有返回收藏夹详情', 'invalid');
    if (expectedId !== undefined && asFiniteNumber(detail.id) !== expectedId) {
      throw new AppError('B 站收藏夹详情 ID 与请求不一致', 'safety');
    }
    const actualOwner = asFiniteNumber(detail.mid);
    if (actualOwner !== undefined && actualOwner !== ownerMid) {
      throw new AppError('B 站收藏夹详情不属于当前用户，已停止操作', 'safety');
    }
  }
}

function pageSignatureSetHas(signatures: Set<string>, signature: string): boolean {
  return signature.length > 0 && signatures.has(signature);
}

export { buildBilibiliForm };
