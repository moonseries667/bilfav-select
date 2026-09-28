import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import monkey from 'vite-plugin-monkey';
import { readFileSync } from 'node:fs';

const licenseNotice = readFileSync(new URL('./LICENSE', import.meta.url), 'utf8');

export default defineConfig(({ command }) => ({
  plugins: [svelte(), command === 'build' && monkey({
    entry: 'src/main.ts',
    generate: ({ userscript, mode }) => mode === 'build' ? `${userscript}\n\n/*!\n${licenseNotice.trim()}\n*/` : userscript,
    server: { open: false },
    userscript: {
      name: 'Bilibili 收藏夹语义重建器',
      namespace: 'bilfav-select',
      version: '0.1.1',
      description: '冻结源收藏夹，按内容性质分类，只复制并校验，可中断恢复。',
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
