import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Companion } from '../src/companion.ts';
import type { Report } from '../src/types.ts';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'evolveflow-'));
  const app = new Companion(join(dir, 'state'), dir);
  return { app, dir, close() { app.close(); rmSync(dir, { recursive: true, force: true }); } };
}
function event(command: string, code?: number, session = 's1', toolId = command + ':' + code) {
  return { session_id: session, turn_id: 't1', hook_event_name: code === undefined ? 'PreToolUse' : 'PostToolUse',
    tool_use_id: toolId, tool_name: 'Bash', tool_input: { command },
    ...(code === undefined ? {} : { tool_response: { exit_code: code, output: code === 0 ? 'verified correct output' : 'path not found' } }) };
}
function learn(app: Companion, dir: string, scope: 'session' | 'project' = 'session', kind: Report['kind'] = 'memory') {
  const bad = app.handle({ ...event('read broken', 1), cwd: dir });
  const good = app.handle({ ...event('read fixed', 0), cwd: dir });
  return app.report({ sessionId: 's1', problemKey: bad.problemId!, title: '带空格的路径读取失败',
    symptoms: ['path not found'], failedAttempts: [{ action: 'read broken', reason: 'missing quotes' }],
    solution: 'read fixed', verification: { eventId: good.eventId!, command: 'read fixed' },
    triggerTerms: ['读取路径', 'read path'], invalidWhen: ['dependency changes'], scope, kind,
    environment: app.environment() });
}

test('a verified solution is immediately usable and guards the known failed operation', () => {
  const f = fixture(); try {
    const memory = learn(f.app, f.dir);
    assert.equal(memory.status, 'active');
    const result = f.app.handle({ ...event('read broken'), cwd: f.dir });
    assert.equal(result.output.hookSpecificOutput?.permissionDecision, 'deny');
    assert.match(JSON.stringify(result.output), /read fixed/);
    assert.match(f.app.context('s1'), /read fixed/);
    assert.equal(f.app.status('s1').problems[0].state, 'verified');
  } finally { f.close(); }
});
test('report assertions without captured successful evidence never activate', () => {
  const f = fixture(); try {
    assert.throws(() => f.app.report({ sessionId: 's1', problemKey: 'x', title: 'x', solution: 'echo ok',
      verification: { eventId: 'invented', command: 'echo ok' }, triggerTerms: ['x'],
      failedAttempts: [], symptoms: [], invalidWhen: [], scope: 'session', kind: 'memory', environment: f.app.environment() }), /evidence|证据/i);
    assert.equal(f.app.memories().length, 0);
  } finally { f.close(); }
});
test('capture deduplicates tool events and identifies repeated failures without inventing a fix', () => {
  const f = fixture(); try {
    const e = { ...event('bad', 1, 's1', 'first'), cwd: f.dir };
    f.app.handle(e); f.app.handle(e);
    f.app.handle({ ...event('bad', 1, 's1', 'second'), cwd: f.dir });
    const status = f.app.status('s1');
    assert.equal(status.problems[0].attempts, 2);
    assert.equal(status.events.length, 2);
    assert.equal(f.app.memories().length, 0);
    assert.match(f.app.context('s1'), /bad/);
  } finally { f.close(); }
});
test('context matching can retrieve Chinese aliases without blocking unrelated commands', () => {
  const f = fixture(); try {
    learn(f.app, f.dir);
    assert.match(f.app.context('s1', '读取路径'), /read fixed/);
    const res = f.app.handle({ ...event('unrelated'), cwd: f.dir });
    assert.notEqual(res.output.hookSpecificOutput?.permissionDecision, 'deny');
  } finally { f.close(); }
});
test('session memories stay private and project memories cross sessions only within that project', () => {
  const f = fixture(); try {
    learn(f.app, f.dir);
    assert.doesNotMatch(f.app.context('other'), /read fixed/);
    const bad = f.app.status('s1').problems[0].id;
    const good = f.app.status('s1').events.find(e => e.exitCode === 0)!;
    f.app.report({ sessionId: 's1', problemKey: bad, title: 'project fix', solution: 'read fixed',
      symptoms: ['not found'], failedAttempts: [{ action: 'read broken', reason: 'quotes' }], triggerTerms: ['path'],
      invalidWhen: ['changes'], environment: f.app.environment(), verification: { eventId: good.id, command: 'read fixed' },
      scope: 'project', kind: 'memory', evaluation: { similarEventId: good.id, negativeEventId: good.id } });
    // One event cannot masquerade as the original, similar and negative tests.
    assert.doesNotMatch(f.app.context('other'), /read fixed/);
  } finally { f.close(); }
});
test('environment changes prevent a previously active command guard', () => {
  const f = fixture(); try {
    learn(f.app, f.dir);
    writeFileSync(join(f.dir, 'package.json'), '{"version":"changed"}');
    const result = f.app.handle({ ...event('read broken'), cwd: f.dir });
    assert.notEqual(result.output.hookSpecificOutput?.permissionDecision, 'deny');
    assert.match(f.app.context('s1'), /环境|environment/);
  } finally { f.close(); }
});
test('success applying a previously learned solution marks the problem applied', () => {
  const f = fixture(); try {
    learn(f.app, f.dir);
    f.app.handle({ ...event('read fixed', 0, 's1', 'apply-again'), cwd: f.dir });
    assert.equal(f.app.status('s1').problems[0].state, 'applied');
  } finally { f.close(); }
});
test('core rule changes require confirmation and failed evidence is rejected', () => {
  const f = fixture(); try {
    assert.equal(learn(f.app, f.dir, 'session', 'core').status, 'pending_confirmation');
    assert.doesNotMatch(f.app.context('s1'), /正确方法.*read fixed/);
  } finally { f.close(); }
});
test('pause stops capture, worker-origin events cannot recursively train, and resume works', () => {
  const f = fixture(); try {
    f.app.pause(true);
    f.app.handle({ ...event('bad', 1), cwd: f.dir });
    assert.equal(f.app.status('s1').events.length, 0);
    f.app.pause(false);
    f.app.handle({ ...event('bad', 1), cwd: f.dir, evolveflow_origin: 'worker' });
    assert.equal(f.app.status('s1').events.length, 0);
    f.app.handle({ ...event('bad', 1), cwd: f.dir });
    assert.equal(f.app.status('s1').events.length, 1);
  } finally { f.close(); }
});
test('Stop continuation requests actionable learning once and respects user interrupt', () => {
  const f = fixture(); try {
    f.app.handle({ ...event('bad', 1), cwd: f.dir });
    const stop = { session_id: 's1', turn_id: 't1', hook_event_name: 'Stop', cwd: f.dir };
    assert.equal(f.app.handle(stop).output.decision, 'block');
    assert.notEqual(f.app.handle({ ...stop, stop_hook_active: true }).output.decision, 'block');
    assert.notEqual(f.app.handle({ ...stop, hook_event_name: 'Interrupt' }).output.decision, 'block');
  } finally { f.close(); }
});
test('templates and problem state survive close/reopen and compaction', () => {
  const f = fixture(); try {
    learn(f.app, f.dir);
    f.app.handle({ session_id: 's1', turn_id: 't1', cwd: f.dir, hook_event_name: 'PreCompact' });
    f.app.close();
    const app = new Companion(join(f.dir, 'state'), f.dir);
    assert.match(app.handle({ session_id: 's1', cwd: f.dir, hook_event_name: 'PostCompact' }).output.hookSpecificOutput?.additionalContext ?? '', /read fixed/);
    app.close();
  } finally { f.close(); }
});
test('disabling and rollback restore the previous independently stored version', () => {
  const f = fixture(); try {
    const m = learn(f.app, f.dir);
    const good = f.app.status('s1').events.find(e => e.exitCode === 0)!;
    f.app.report({ sessionId: 's1', problemKey: m.problemKey, title: 'updated title', solution: 'read fixed',
      verification: { eventId: good.id, command: 'read fixed' }, environment: f.app.environment(),
      symptoms: ['path'], failedAttempts: [{ action: 'read broken', reason: 'quotes' }], triggerTerms: ['path'], invalidWhen: [], scope: 'session', kind: 'memory' });
    f.app.rollback(m.id);
    assert.equal(f.app.memories()[0].version, 1);
    f.app.disable(m.id);
    assert.notEqual(f.app.handle({ ...event('read broken'), cwd: f.dir }).output.hookSpecificOutput?.permissionDecision, 'deny');
  } finally { f.close(); }
});
test('incremental transcript capture handles partial lines, tool results and unknown formats honestly', () => {
  const f = fixture(); try {
    const p = join(f.dir, 'transcript.jsonl');
    const line = JSON.stringify({ type: 'event_msg', payload: { type: 'user_message', message: '你又重复了刚才的错误，请先用已验证的方法' } });
    writeFileSync(p, line.slice(0, 25));
    f.app.ingestTranscript('s1', p);
    assert.equal(f.app.status('s1').events.length, 0);
    appendFileSync(p, line.slice(25) + '\n' + JSON.stringify({ type: 'unknown_format', payload: {} }) + '\n');
    f.app.ingestTranscript('s1', p); f.app.ingestTranscript('s1', p);
    assert.equal(f.app.status('s1').events.length, 1);
    assert.ok(f.app.status('s1').coverage.some(c => c.reason.includes('unknown_format')));
    assert.ok(f.app.status('s1').queue.some(q => q.state === 'pending'));
  } finally { f.close(); }
});
test('intentional reproduction is a one-shot explicit exception, not a persistent bypass', () => {
  const f = fixture(); try {
    const m = learn(f.app, f.dir);
    f.app.allowReproduction('s1', m.id, 'user explicitly requested reproducing original failure');
    assert.notEqual(f.app.handle({ ...event('read broken'), cwd: f.dir }).output.hookSpecificOutput?.permissionDecision, 'deny');
    assert.equal(f.app.handle({ ...event('read broken'), cwd: f.dir }).output.hookSpecificOutput?.permissionDecision, 'deny');
  } finally { f.close(); }
});

test('an unapproved replacement preserves the already active solution and versions remain immutable after rollback', () => {
  const f = fixture(); try {
    const m = learn(f.app, f.dir);
    const pending = learn(f.app, f.dir, 'session', 'core');
    assert.equal(pending.status, 'pending_confirmation');
    assert.equal(f.app.memories()[0].status, 'active');
    assert.equal(f.app.memories()[0].version, 1);
    const third = learn(f.app, f.dir);
    assert.equal(third.version, 3);
    f.app.rollback(m.id);
    assert.equal(f.app.memories()[0].version, 1);
    assert.equal(learn(f.app, f.dir).version, 4);
    assert.equal(f.app.store.get<{ status: string }>('versions', m.id + ':2')?.status, 'pending_confirmation');
  } finally { f.close(); }
});

test('disabling a published skill removes discoverable instructions', () => {
  const f = fixture(); try {
    const original = learn(f.app, f.dir);
    const source = f.app.memories()[0];
    const similar = f.app.handle({ ...event('similar fixed', 0, 's1', 'similar'), cwd: f.dir });
    const negative = f.app.handle({ ...event('unrelated successful', 0, 's1', 'negative'), cwd: f.dir });
    const skill = f.app.report({ ...source, kind: 'skill', evaluation: { similarEventId: similar.eventId!, negativeEventId: negative.eventId! } });
    assert.equal(skill.status, 'active');
    const path = join(f.dir, '.agents', 'skills', 'evolveflow-learned-' + original.id, 'SKILL.md');
    assert.ok(existsSync(path));
    f.app.disable(original.id);
    assert.equal(existsSync(path), false);
  } finally { f.close(); }
});

test('guards do not cross tool or shell boundaries or block the verified command itself', () => {
  const f = fixture(); try {
    learn(f.app, f.dir);
    assert.notEqual(f.app.handle({ ...event('read broken'), cwd: f.dir, tool_name: 'different-tool' }).output.hookSpecificOutput?.permissionDecision, 'deny');
    assert.notEqual(f.app.handle({ ...event('read broken'), cwd: f.dir, tool_input: { command: 'read broken', shell: 'bash' } }).output.hookSpecificOutput?.permissionDecision, 'deny');
    const failure = f.app.handle({ ...event('npm test', 1, 's1', 'test-fail'), cwd: f.dir });
    const success = f.app.handle({ ...event('npm test', 0, 's1', 'test-pass'), cwd: f.dir });
    f.app.report({ sessionId: 's1', problemKey: failure.problemId!, title: 'fixed source then tests pass',
      solution: 'fix type mismatch, rerun npm test', verification: { eventId: success.eventId!, command: 'npm test' },
      failedAttempts: [{ action: 'npm test', reason: 'source bug now fixed' }], symptoms: ['type error'], triggerTerms: ['tests'],
      environment: f.app.environment(), invalidWhen: [], kind: 'memory', scope: 'session' });
    assert.notEqual(f.app.handle({ ...event('npm test'), cwd: f.dir }).output.hookSpecificOutput?.permissionDecision, 'deny');
  } finally { f.close(); }
});

test('historical success from a different workdir cannot certify the current project', () => {
  const f = fixture(); try {
    const p = join(f.dir, 'scope.jsonl');
    writeFileSync(p, [
      { type: 'turn_context', payload: { cwd: join(f.dir, 'other') } },
      { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'other', arguments: JSON.stringify({ cmd: 'echo ok', workdir: join(f.dir, 'other') }) } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'other', output: 'Process exited with code 0\nok' } },
    ].map(x => JSON.stringify(x)).join('\n') + '\n');
    f.app.ingestTranscript('s1', p);
    const evidence = f.app.status('s1').events.find(e => e.exitCode === 0)!;
    assert.equal(evidence.environment.cwd, join(f.dir, 'other'));
    assert.ok(f.app.status('s1').coverage.some(c => /historical|历史/.test(c.reason)));
    assert.throws(() => f.app.report({ sessionId: 's1', problemKey: 'p', title: 'wrong scope', solution: 'echo ok',
      verification: { eventId: evidence.id, command: 'echo ok' }, environment: f.app.environment(), failedAttempts: [],
      symptoms: [], triggerTerms: ['ok'], invalidWhen: [], kind: 'memory', scope: 'session' }), /environment|历史/);
  } finally { f.close(); }
});

test('correction evidence is exposed and can be explicitly reviewed without an endless continuation', () => {
  const f = fixture(); try {
    const e = f.app.handle({ session_id: 's1', turn_id: 'correction', cwd: f.dir,
      hook_event_name: 'UserPromptSubmit', prompt: '纠正：不要重新选择框架，沿用已经确认的设计。' });
    assert.match(f.app.context('s1'), /沿用已经确认的设计/);
    f.app.review('s1', e.eventId!, 'reviewed', '已核对并继续采用确认的设计');
    const stopped = f.app.handle({ session_id: 's1', turn_id: 'next', cwd: f.dir, hook_event_name: 'Stop' });
    assert.notEqual(stopped.output.decision, 'block');
  } finally { f.close(); }
});

test('application evidence must use the original verification tool and shell', () => {
  const f = fixture(); try {
    learn(f.app, f.dir);
    f.app.handle({ ...event('read fixed', 0, 's1', 'other-tool'), cwd: f.dir, tool_name: 'different-tool', tool_input: { command: 'read fixed', shell: 'bash' } });
    assert.equal(f.app.status('s1').problems[0].state, 'verified');
  } finally { f.close(); }
});

test('explicit user corrections can become session memories without fabricated shell evidence', () => {
  const f = fixture(); try {
    const correction = f.app.handle({ session_id: 's1', turn_id: 'user-correction', cwd: f.dir,
      hook_event_name: 'UserPromptSubmit', prompt: '纠正：日常聊天请直接说人话，不要每轮输出计划。' });
    const m = f.app.report({ sessionId: 's1', problemKey: 'daily-tone', title: '沟通偏好纠正', symptoms: ['不必要的计划'],
      failedAttempts: [], solution: '日常聊天直接回应，不套用开发计划。', triggerTerms: ['日常聊天'], invalidWhen: ['用户要求计划'],
      verification: { kind: 'user_correction', eventId: correction.eventId!, command: '' }, environment: f.app.environment(), kind: 'memory', scope: 'session', reviewedEventIds: [correction.eventId!] });
    assert.equal(m.status, 'active');
    assert.match(f.app.context('s1'), /不套用开发计划/);
    assert.ok(f.app.status('s1').queue.every(q => q.state === 'done'));
  } finally { f.close(); }
});

test('a live operation in a project subdirectory retains usable scoped evidence', () => {
  const f = fixture(); try {
    const child = join(f.dir, 'module'); mkdirSync(child);
    const good = f.app.handle({ ...event('verify module', 0), cwd: f.dir, tool_input: { command: 'verify module', workdir: child } });
    const evidence = f.app.status('s1').events.find(e => e.id === good.eventId)!;
    const m = f.app.report({ sessionId: 's1', problemKey: 'module', title: 'module method', symptoms: [], failedAttempts: [],
      solution: 'verify module', triggerTerms: ['module'], invalidWhen: [], environment: evidence.environment,
      verification: { eventId: good.eventId!, command: 'verify module' }, scope: 'session', kind: 'memory' });
    assert.equal(m.status, 'active');
    assert.match(f.app.context('s1'), /module method/);
  } finally { f.close(); }
});

test('metrics report observed recurrence and adoption without inventing a misuse rate', () => {
  const f = fixture(); try {
    learn(f.app, f.dir);
    f.app.handle({ ...event('read broken'), cwd: f.dir });
    f.app.handle({ ...event('read fixed', 0, 's1', 'application'), cwd: f.dir });
    const metrics = f.app.metrics('s1');
    assert.equal(metrics.blockedKnownFailures, 1);
    assert.equal(metrics.verifiedApplications, 1);
    assert.equal(metrics.misuseRate, null);
    assert.equal(metrics.modelCalls, 0);
    f.app.pause(true);
    assert.equal(f.app.workerOnce().processed, 0);
  } finally { f.close(); }
});

test('a preference correction cannot certify or retire an executable failure', () => {
  const f = fixture(); try {
    const failed = f.app.handle({ ...event('npm test', 1), cwd: f.dir });
    const correction = f.app.handle({ session_id: 's1', turn_id: 'correction', cwd: f.dir, hook_event_name: 'UserPromptSubmit', prompt: '纠正：请用短段落回应。' });
    assert.throws(() => f.app.report({ sessionId: 's1', problemKey: failed.problemId!, title: 'paragraph preference', solution: '使用短段落',
      verification: { kind: 'user_correction', eventId: correction.eventId!, command: '' }, symptoms: [], failedAttempts: [],
      triggerTerms: ['paragraph'], invalidWhen: [], environment: f.app.environment(), scope: 'session', kind: 'memory', reviewedEventIds: [failed.eventId!] }), /non-executable/);
    f.app.report({ sessionId: 's1', problemKey: failed.problemId!, title: 'paragraph preference', solution: '使用短段落',
      verification: { kind: 'user_correction', eventId: correction.eventId!, command: '' }, symptoms: [], failedAttempts: [],
      triggerTerms: ['paragraph'], invalidWhen: [], environment: f.app.environment(), scope: 'session', kind: 'memory' });
    assert.equal(f.app.status('s1').problems[0].state, 'open');
    assert.ok(f.app.status('s1').queue.some(q => q.eventId === failed.eventId && q.state === 'pending'));
  } finally { f.close(); }
});

test('missing conversation transcript and unknown host events are explicit coverage gaps', () => {
  const f = fixture(); try {
    f.app.handle({ session_id: 's1', cwd: f.dir, hook_event_name: 'SessionStart' });
    assert.ok(f.app.status('s1').coverage.some(c => c.reason.includes('transcript_path')));
    assert.match(f.app.handle({ session_id: 's1', cwd: f.dir, hook_event_name: 'FutureUnsupportedEvent' }).output.systemMessage ?? '', /监控缺口/);
  } finally { f.close(); }
});

test('an unrelated successful operation cannot silently close a failed problem', () => {
  const f = fixture(); try {
    const failed = f.app.handle({ ...event('npm test', 1), cwd: f.dir });
    const unrelated = f.app.handle({ ...event('echo unrelated', 0), cwd: f.dir });
    f.app.report({ sessionId: 's1', problemKey: failed.problemId!, title: 'unrelated command reference', symptoms: [],
      solution: 'echo unrelated', failedAttempts: [], verification: { eventId: unrelated.eventId!, command: 'echo unrelated' },
      triggerTerms: ['echo'], invalidWhen: [], environment: f.app.environment(), scope: 'session', kind: 'memory' });
    assert.equal(f.app.status('s1').problems[0].state, 'open');
  } finally { f.close(); }
});
