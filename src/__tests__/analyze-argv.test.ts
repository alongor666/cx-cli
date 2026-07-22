import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';
import { CliUsageError } from '../exit-codes.js';
import { registerAnalyzeCommand } from '../program/analyze-command.js';

describe('cx analyze argv contract', () => {
  it('argv 的等号与空格参数都完整进入 handler', async () => {
    const handler = vi.fn(async () => undefined);
    const program = new Command().exitOverride();
    registerAnalyzeCommand(program, handler);

    await program.parseAsync([
      'node', 'cx', 'analyze', 'operating-trend',
      '--startDate', '2026-01-01',
      '--endDate=2026-01-31',
      '--targetBranch', 'SC',
      '--notAParam', 'x',
    ]);

    expect(handler).toHaveBeenCalledWith('operating-trend', expect.objectContaining({
      params: {
        startDate: '2026-01-01',
        endDate: '2026-01-31',
        targetBranch: 'SC',
        notAParam: 'x',
      },
    }));
  });

  it('裸参数在调用网络 handler 前以用法错误拒绝', async () => {
    const handler = vi.fn(async () => undefined);
    const program = new Command().exitOverride();
    registerAnalyzeCommand(program, handler);

    await expect(program.parseAsync([
      'node', 'cx', 'analyze', 'operating-trend', '--startDate',
    ])).rejects.toBeInstanceOf(CliUsageError);
    expect(handler).not.toHaveBeenCalled();
  });
});
