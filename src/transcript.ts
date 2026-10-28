import { openSync, closeSync, fstatSync, readSync } from 'node:fs';
import { hash } from './normalize.ts';
import type { HookInput } from './types.ts';

export type Cursor = { offset: number; partial: string; signature: string; calls: Record<string, { name: string; args: Record<string, unknown>; cwd?: string }>; turn: string; cwd?: string };
type Row = { type?: string; payload?: Record<string, unknown> };
/** Codex JSONL response_item/event_msg adapter; unknown shapes remain coverage gaps. */
export function readTranscript(path: string, previous?: Cursor): { cursor: Cursor; events: HookInput[]; gaps: string[] } {
  const fd = openSync(path, 'r');
  try {
    const stat = fstatSync(fd);
    const head = Buffer.alloc(Math.min(stat.size, 64)); readSync(fd, head, 0, head.length, 0);
    // Compare only the previously observed prefix, so appending to a short file is not a rotation.
    const oldSignature = previous?.signature?.split(':');
    const oldLength = Number(oldSignature?.[0] ?? 0);
    const check = Buffer.alloc(Math.min(oldLength, stat.size)); readSync(fd, check, 0, check.length, 0);
    const rotated = previous && (stat.size < previous.offset || (oldLength > 0 && hash(check.toString('hex')) !== oldSignature?.[1]));
    const cursor: Cursor = !previous || rotated ? { offset: 0, partial: '', signature: '', calls: {}, turn: '' } : structuredClone(previous);
    const gaps: string[] = rotated ? ['transcript rotated/truncated; rebuilding visible history'] : [];
    const events: HookInput[] = [];
    const emit = (event: HookInput) => events.push({ ...event, cwd: typeof event.tool_input?.workdir === 'string' ? event.tool_input.workdir : event.cwd ?? cursor.cwd });
    const remaining = stat.size - cursor.offset;
    if (remaining > 8 * 1024 * 1024) gaps.push('transcript backlog exceeds 8MiB; processing in chunks');
    const buffer = Buffer.alloc(Math.min(remaining, 8 * 1024 * 1024));
    readSync(fd, buffer, 0, buffer.length, cursor.offset);
    cursor.offset += buffer.length;
    // Preserve partial UTF-8 using a byte-equivalent latin1 carry until a full JSONL record exists.
    const lines = (cursor.partial + buffer.toString('latin1')).split('\n'); cursor.partial = lines.pop() ?? '';
    if (cursor.partial.length > 2 * 1024 * 1024) { gaps.push('oversized transcript record skipped'); cursor.partial = ''; }
    for (const bytes of lines) {
      let row: Row;
      try { row = JSON.parse(Buffer.from(bytes, 'latin1').toString('utf8')) as Row; }
      catch { gaps.push('malformed JSONL record'); continue; }
      const p = row.payload ?? {};
      if (row.type === 'turn_context') { cursor.turn = String(p.turn_id ?? cursor.turn); if (typeof p.cwd === 'string') cursor.cwd = p.cwd; continue; }
      if (row.type === 'session_meta') { if (typeof p.cwd === 'string') cursor.cwd = p.cwd; continue; }
      if (row.type === 'compacted') { emit({ hook_event_name: 'TranscriptCompact', turn_id: cursor.turn }); continue; }
      if (row.type === 'event_msg') {
        const t = String(p.type ?? '');
        if (['user_message', 'agent_message'].includes(t)) emit({ hook_event_name: t === 'user_message' ? 'TranscriptUser' : 'TranscriptAssistant', turn_id: cursor.turn, prompt: String(p.message ?? '') });
        else if (!['token_count', 'agent_reasoning', 'task_started', 'task_complete', 'turn_aborted'].includes(t)) gaps.push('unmapped event_msg:' + t);
        continue;
      }
      if (row.type === 'response_item') {
        const t = String(p.type ?? '');
        if (t === 'function_call') {
          let args: Record<string, unknown>;
          try { args = JSON.parse(String(p.arguments ?? '{}')) as Record<string, unknown>; } catch { gaps.push('invalid function_call arguments'); continue; }
          const call = { name: String(p.name ?? ''), args, cwd: cursor.cwd };
          cursor.calls[String(p.call_id)] = call;
          emit({ hook_event_name: 'TranscriptToolCall', tool_use_id: String(p.call_id), tool_name: call.name, tool_input: args, turn_id: cursor.turn });
        } else if (t === 'function_call_output') {
          const call = cursor.calls[String(p.call_id)];
          if (!call) { gaps.push('tool output without observed call:' + String(p.call_id)); continue; }
          emit({ hook_event_name: 'PostToolUse', tool_use_id: String(p.call_id), tool_name: call.name === 'exec_command' ? 'Bash' : call.name, tool_input: call.args, tool_response: p.output, turn_id: cursor.turn, cwd: call.cwd });
          delete cursor.calls[String(p.call_id)];
        } else if (t === 'message') {
          const content = Array.isArray(p.content) ? p.content as Record<string, unknown>[] : [];
          const text = content.map(c => String(c.text ?? '')).join('\n');
          emit({ hook_event_name: p.role === 'user' ? 'TranscriptUser' : 'TranscriptAssistant', turn_id: cursor.turn, prompt: text });
        } else if (!['reasoning', 'web_search_call'].includes(t)) gaps.push('unmapped response_item:' + t);
        continue;
      }
      gaps.push('unknown transcript type:' + String(row.type));
    }
    cursor.signature = head.length + ':' + hash(head.toString('hex'));
    return { cursor, events, gaps };
  } finally { closeSync(fd); }
}
