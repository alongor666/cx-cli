import { describe, it, expect } from 'vitest';
import { validateConfigKey, validateConfigValue, maskToken } from '../commands/config-cmd.js';

describe('validateConfigKey', () => {
  it('baseUrl 合法', () => {
    expect(() => validateConfigKey('baseUrl')).not.toThrow();
  });
  it('token 拒绝（只能经 cx login 写入）', () => {
    expect(() => validateConfigKey('token')).toThrow(/login/);
  });
  it('未知 key 拒绝', () => {
    expect(() => validateConfigKey('foo')).toThrow(/可配置/);
  });
});

describe('validateConfigValue', () => {
  it('baseUrl 必须是 http(s) URL', () => {
    expect(() => validateConfigValue('baseUrl', 'https://chexian.cretvalu.com')).not.toThrow();
    expect(() => validateConfigValue('baseUrl', 'http://localhost:3000')).not.toThrow();
    expect(() => validateConfigValue('baseUrl', 'not-a-url')).toThrow(/URL/);
    expect(() => validateConfigValue('baseUrl', 'ftp://x.com')).toThrow(/URL/);
  });
});

describe('maskToken', () => {
  it('PAT 只保留前缀与 id 段', () => {
    expect(maskToken('cx_pat_abcd1234.secretsecretsecret')).toBe('cx_pat_abcd1234.***');
  });
  it('非 PAT 格式全打码', () => {
    expect(maskToken('whatever')).toBe('***');
  });
});
