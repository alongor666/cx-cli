import { describe, it, expect } from 'vitest';
import { parseExtraParams } from '../commands/query.js';

describe('parseExtraParams', () => {
  it('解析 --key=value 形式', () => {
    expect(parseExtraParams(['--year=2026', '--org_level_3=分公司A']))
      .toEqual({ year: '2026', org_level_3: '分公司A' });
  });

  it('忽略不含 = 的参数', () => {
    expect(parseExtraParams(['--year=2026', '--debug'])).toEqual({ year: '2026' });
  });

  it('保留 = 之后的所有内容（含等号）', () => {
    expect(parseExtraParams(['--filter=a=b']))
      .toEqual({ filter: 'a=b' });
  });
});
