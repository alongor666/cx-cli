/**
 * ux-baseline runner 约束回归测试（PR #1021 评审 P1：fail-open → fail-closed）。
 *
 * 守护两条硬约束：
 *   1) CX_UX_RUNNER 非法值必须抛错，禁止静默回退到编译产物（静默回退会让
 *      "以为在强制 tsx" 的基线重建/校验实际跑 dist/cx，重新引入 runner 漂移）；
 *   2) --check 时基线 runner 与当前 runner 不一致必须判失败，禁止提示后照过。
 *
 * ux-baseline.mjs 的主流程有 isCliEntry() 守卫，import 本身无副作用。
 */
import { describe, it, expect } from 'vitest';
// @ts-expect-error — 纯 JS 脚本无类型声明，tsconfig 已排除 *.test.ts 不参与 tsc
import { resolveRunner, checkRunnerConsistency } from '../../scripts/ux-baseline.mjs';

describe('resolveRunner（CX_UX_RUNNER 解析，fail-closed）', () => {
  it('非法值抛错，禁止静默回退', () => {
    expect(() => resolveRunner('invalid', true)).toThrow(/仅支持 tsx 或 bin/);
    expect(() => resolveRunner('TSX', true)).toThrow(/仅支持 tsx 或 bin/);
    expect(() => resolveRunner('compiled-bin', false)).toThrow(/仅支持 tsx 或 bin/);
  });

  it('tsx 强制生效，与编译产物是否存在无关', () => {
    expect(resolveRunner('tsx', true)).toBe('tsx');
    expect(resolveRunner('tsx', false)).toBe('tsx');
  });

  it('bin 强制：有产物 → compiled-bin；无产物抛错', () => {
    expect(resolveRunner('bin', true)).toBe('compiled-bin');
    expect(() => resolveRunner('bin', false)).toThrow(/编译产物不存在/);
  });

  it('未设置（undefined / 空串）走默认：有产物用编译产物，否则 tsx', () => {
    expect(resolveRunner(undefined, true)).toBe('compiled-bin');
    expect(resolveRunner(undefined, false)).toBe('tsx');
    expect(resolveRunner('', true)).toBe('compiled-bin');
    expect(resolveRunner('', false)).toBe('tsx');
  });
});

describe('checkRunnerConsistency（--check runner 闸，不一致必须失败）', () => {
  it('基线与当前 runner 不一致 → 返回错误说明（调用侧据此置 failed）', () => {
    const err = checkRunnerConsistency('tsx', 'compiled-bin');
    expect(err).toMatch(/跨 runner 快照对比无效/);
    expect(checkRunnerConsistency('compiled-bin', 'tsx')).toMatch(/CX_UX_RUNNER=bin/);
  });

  it('一致或旧基线缺 runner 字段 → 通过（null）', () => {
    expect(checkRunnerConsistency('tsx', 'tsx')).toBeNull();
    expect(checkRunnerConsistency(undefined, 'tsx')).toBeNull();
  });
});
