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
      description: '按兴趣分类表重建收藏，支持模型获取与测试、重复分类和中断恢复。',
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
