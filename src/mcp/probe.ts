/**
 * 连通自检：像 Agent 一样拉起 `cx mcp`，走 initialize → tools/list，返回工具数。
 *
 * 只用换行分隔 JSON-RPC（MCP stdio 传输），不依赖 SDK 客户端实现。子进程环境**去掉 CX_PAT /
 * CX_BASE_URL**：写进 Agent 配置的条目不带 env，GUI Agent 也不继承 shell 环境——自检必须按
 * Agent 真实运行时的条件跑，否则「只 export 了 CX_PAT」会自检通过、Agent 里却 Missing PAT。
 * 子进程 stderr 仅在失败时回传，且先做令牌脱敏。
 */
import { spawn } from 'node:child_process';
import type { McpEntry } from './clients.js';

export interface ProbeResult {
  tools: string[];
}

export function redactPat(text: string): string {
  return text.replace(/cx_pat_[A-Za-z0-9._-]+/g, 'cx_pat_***');
}

/** Agent 运行时看到的环境：去掉只在当前 shell 有效的 cx 凭据变量 */
export function agentEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const { CX_PAT: _pat, CX_BASE_URL: _base, ...rest } = env;
  return rest;
}

export function probeServer(entry: McpEntry, timeoutMs = 60_000): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(entry.command, entry.args, { stdio: ['pipe', 'pipe', 'pipe'], env: agentEnv() });
    let stdoutBuf = '';
    let stderrBuf = '';
    let settled = false;
    const finish = (err: Error | null, result?: ProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      if (err) reject(err);
      else resolve(result!);
    };
    const failWithStderr = (reason: string) =>
      finish(new Error(`${reason}${stderrBuf.trim() ? `\n${redactPat(stderrBuf.trim()).slice(-800)}` : ''}`));
    const timer = setTimeout(() => failWithStderr(`cx mcp ${timeoutMs / 1000}s 内未就绪`), timeoutMs);
    const send = (msg: object) => child.stdin.write(`${JSON.stringify(msg)}\n`);

    child.on('error', (err) => finish(new Error(`无法启动 ${entry.command}: ${err.message}`)));
    child.on('exit', (code) => failWithStderr(`cx mcp 提前退出（退出码 ${code}）`));
    child.stderr.on('data', (d) => { stderrBuf += String(d); });
    child.stdout.on('data', (d) => {
      stdoutBuf += String(d);
      let nl: number;
      while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, nl).trim();
        stdoutBuf = stdoutBuf.slice(nl + 1);
        if (!line) continue;
        let msg: { id?: number; result?: { tools?: { name: string }[] }; error?: { message?: string } };
        try { msg = JSON.parse(line); } catch { return failWithStderr(`cx mcp 的 stdout 出现非 JSON-RPC 内容`); }
        if (msg.error) return failWithStderr(`cx mcp 返回错误：${redactPat(msg.error.message ?? 'unknown')}`);
        if (msg.id === 1) {
          send({ jsonrpc: '2.0', method: 'notifications/initialized' });
          send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
        } else if (msg.id === 2) {
          finish(null, { tools: (msg.result?.tools ?? []).map((t) => t.name) });
        }
      }
    });

    send({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'cx-mcp-probe', version: '1' } },
    });
  });
}
