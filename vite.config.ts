import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import monkey from 'vite-plugin-monkey';
import { readFileSync } from 'node:fs';

const licenseNotice = readFileSync(new URL('./LICENSE', import.meta.url), 'utf8');
const { version: scriptVersion } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

export default defineConfig(({ command }) => ({
  plugins: [svelte(), command === 'build' && monkey({
    entry: 'src/main.ts',
    generate: ({ userscript, mode }) => mode === 'build' ? `${userscript}\n\n/*!\n${licenseNotice.trim()}\n*/` : userscript,
    server: { open: false },
    userscript: {
      name: 'Bilibili 收藏夹语义重建器',
      namespace: 'bilfav-select',
      version: scriptVersion,
      description: '按分类表重建收藏，支持完整与增量获取、有效模型选择、任务续传和诊断日志导出。',
      author: 'Bilfav Select contributors; based on madoka-chann',
      license: 'MIT',
      match: ['https://space.bilibili.com/*'],
      'run-at': 'document-idle',
      grant: ['GM_getValue', 'GM_setValue', 'GM_xmlhttpRequest', 'GM_addStyle'],
      connect: ['api.bilibili.com', '*'],
    },
    build: { fileName: 'bilfav-select.user.js' },
  })],
}));
