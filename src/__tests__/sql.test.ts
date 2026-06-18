import { describe, it, expect } from 'vitest';
import { Readable } from 'stream';
import { readSqlInput } from '../commands/sql.js';

describe('readSqlInput', () => {
  it('参数为普通 SQL 时原样返回', async () => {
    expect(await readSqlInput('SELECT 1', null)).toBe('SELECT 1');
  });

  it('参数为 - 时从 stdin 读并 trim', async () => {
    const stdin = Readable.from(['SELECT ', '2\n']);
    expect(await readSqlInput('-', stdin)).toBe('SELECT 2');
  });

  it('参数为 - 但 stdin 为空时抛错', async () => {
    const stdin = Readable.from(['  \n']);
    await expect(readSqlInput('-', stdin)).rejects.toThrow(/stdin/);
  });

  it('参数为 - 且 stdin 不可用时抛错', async () => {
    await expect(readSqlInput('-', null)).rejects.toThrow(/stdin/);
  });
});
