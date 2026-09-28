import type { CategoryDefinition } from '../types';
import { UNCERTAIN } from '../types';
import { AppError } from '../lib/errors';
import { validateCategories } from './classifier';
import { extractJsonValue } from './json';

export const RESERVED_CATEGORY: CategoryDefinition = {
  name: UNCERTAIN, description: '信息不足、类别边界无法可靠区分或分类表无法覆盖',
};

/** Accept external arrays or {categories: [...]} without changing user category boundaries. */
export function normalizeCategoryTable(input: unknown): CategoryDefinition[] {
  const rows = Array.isArray(input) ? input : input && typeof input === 'object'
    ? (input as Record<string, unknown>).categories : undefined;
  if (!Array.isArray(rows) || rows.length === 0) throw new AppError('分类表必须包含至少一个普通类别，每类填写 name 和 description', 'invalid');
  const hasReserved = rows.some(row => row && typeof row === 'object' &&
    typeof row.name === 'string' && row.name.trim() === UNCERTAIN);
  const categories = validateCategories(hasReserved ? rows : [...rows, RESERVED_CATEGORY]);
  if (categories.every(category => category.name === UNCERTAIN)) throw new AppError('请至少填写一个普通类别', 'invalid');
  return categories;
}

export function parseCategoryTable(text: string): CategoryDefinition[] {
  let input: unknown;
  try { input = extractJsonValue(text); }
  catch { throw new AppError('分类表 JSON 格式无效，请粘贴数组或包含 categories 数组的对象', 'invalid'); }
  return normalizeCategoryTable(input);
}
