import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { resolve, join } from 'node:path';
import type { Environment, Event, HookInput } from './types.ts';

export const hash = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex').slice(0, 24);
export function redact(value: string): string {
  return value.replace(/\bsk-[A-Za-z0-9_-]{12,}/g, '[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{8,}/gi, 'Bearer [REDACTED]')
    .replace(/((?:--|\b)(?:password|api[-_]?key|access[-_]?token|secret)(?:["']?\s*[:=]\s*["']?|\s+))[^\s"',}]+/gi, '$1[REDACTED]');
}
export function environment(cwd: string): Environment {
  const absolute = existsSync(cwd) ? realpathSync(cwd) : resolve(cwd);
  const files = ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'requirements.txt', 'pyproject.toml', 'Cargo.lock'];
  const parts = files.filter(f => existsSync(join(absolute, f))).map(f => [f, hash(readFileSync(join(absolute, f), 'utf8'))]);
  return { cwd: absolute, platform: process.platform, version: process.version, fingerprint: hash(parts) };
}
export function sameEnvironment(a: Environment, b: Environment) {
  return a.cwd === b.cwd && a.platform === b.platform && a.version === b.version && a.fingerprint === b.fingerprint;
}
export function exitCode(response: unknown): number | undefined {
  if (typeof response === 'object' && response !== null) {
    const r = response as Record<string, unknown>;
    for (const key of ['exit_code', 'exitCode', 'code']) if (typeof r[key] === 'number') return r[key] as number;
    if (typeof r.output === 'string') return exitCode(r.output);
    if (typeof r.isError === 'boolean' && r.isError) return 1;
  }
  if (typeof response === 'string') {
    try { const v: unknown = JSON.parse(response); if (typeof v === 'object' && v !== null) return exitCode(v); } catch { /* tool text */ }
    const match = /(?:Process exited with code|exit[_ ]code\s*[:=]|Exit code:)\s*(-?\d+)/i.exec(response);
    if (match) return Number(match[1]);
  }
  return undefined;
}
export function normalize(input: HookInput, env: Environment): Event {
  const kind = String(input.hook_event_name ?? 'Unknown');
  const action = input.tool_input && (typeof input.tool_input.command === 'string' ? input.tool_input.command : typeof input.tool_input.cmd === 'string' ? input.tool_input.cmd : undefined);
  const text = redact(input.prompt ?? input.last_assistant_message ?? (typeof input.tool_response === 'string' ? input.tool_response : input.tool_response === undefined ? '' : JSON.stringify(input.tool_response)));
  const base = { sessionId: String(input.session_id ?? 'unknown'), turnId: String(input.turn_id ?? ''), kind,
    toolId: input.tool_use_id, action: action === undefined ? undefined : redact(action.trim()), tool: input.tool_name === 'exec_command' ? 'Bash' : input.tool_name,
    shell: typeof input.tool_input?.shell === 'string' ? input.tool_input.shell : undefined,
    historical: input.evolveflow_historical === true,
    exitCode: exitCode(input.tool_response), text: text.slice(0, 32_000), environment: env };
  return { ...base, id: hash(base), at: new Date().toISOString() };
}
