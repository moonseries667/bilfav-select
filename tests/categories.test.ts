import { describe, expect, it } from 'vitest';
import { normalizeCategoryTable, parseCategoryTable } from '../src/ai/categories';

describe('external category tables', () => {
  it('accepts external arrays and object wrappers and adds the reserved category exactly once', () => {
    const table = [{ name: ' MMD ', description: ' 模型演出 ' }];
    const parsed = parseCategoryTable('```json\n' + JSON.stringify({ categories: table }) + '\n```');
    expect(parsed[0]).toEqual({ name: 'MMD', description: '模型演出' });
    expect(parsed.map(category => category.name)).toEqual(['MMD', '不确定']);
    expect(normalizeCategoryTable(parsed)).toEqual(parsed);
  });

  it.each([
    { label: 'empty table', input: [] },
    { label: 'only reserved category', input: [{ name: '不确定', description: '保留' }] },
    { label: 'empty description', input: [{ name: '绘画', description: '' }] },
    { label: 'duplicate trimmed name', input: [{ name: '绘画', description: '一' }, { name: ' 绘画 ', description: '二' }] },
    { label: 'missing description', input: [{ name: '绘画' }] },
  ])('rejects $label', ({ input }) => {
    expect(() => normalizeCategoryTable(input)).toThrow();
  });
});
