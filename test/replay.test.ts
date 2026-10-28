import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('real command evidence travels through separate hook/report/context CLI processes and survives restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'evolveflow real replay '));
  const cli = resolve('src/cli.ts');
  const run = (args: string[], input?: unknown) => {
    const r = spawnSync(process.execPath, [cli, ...args, '--project', dir], { input: input === undefined ? undefined : JSON.stringify(input), encoding: 'utf8', timeout: 15_000 });
    assert.equal(r.status, 0, r.stderr + r.stdout); return JSON.parse(r.stdout);
  };
  try {
    writeFileSync(join(dir, 'correct file.txt'), 'expected fixture content');
    const wrong = `require('node:fs').readFileSync('missing file.txt','utf8')`;
    const right = `console.log(require('node:fs').readFileSync('correct file.txt','utf8'))`;
    const execute = (code: string, id: string) => {
      const actual = spawnSync(process.execPath, ['-e', code], { cwd: dir, encoding: 'utf8' });
      return run(['hook'], { session_id: 'replay', turn_id: 'one', cwd: dir, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: id,
        tool_input: { command: code }, tool_response: { exit_code: actual.status, output: actual.stdout + actual.stderr } });
    };
    execute(wrong, 'failure'); execute(right, 'success');
    const status = run(['status', '--session', 'replay']);
    const evidence = status.events.find((e: { exitCode: number }) => e.exitCode === 0);
    const file = join(dir, 'report.json');
    writeFileSync(file, JSON.stringify({ sessionId: 'replay', problemKey: status.problems[0].id, title: 'file path correction', symptoms: ['ENOENT'],
      failedAttempts: [{ action: wrong, reason: 'wrong filename' }], solution: right,
      verification: { eventId: evidence.id, command: right, evidence: 'stdout equals expected fixture content' },
      environment: status.environment, triggerTerms: ['file path', '文件路径'], invalidWhen: ['file moved'], kind: 'memory', scope: 'session' }));
    const memory = run(['report', '--file', file]);
    assert.equal(memory.status, 'active');
    assert.ok(existsSync(join(dir, '.evolveflow/state/templates', memory.id + '.md')));
    const guarded = run(['hook'], { session_id: 'replay', turn_id: 'two', cwd: dir, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: wrong } });
    assert.equal(guarded.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(guarded.hookSpecificOutput.permissionDecisionReason, /correct file/);
    const context = run(['context', '--session', 'replay']);
    assert.match(context.context, /correct file/);
    execute(right, 'apply');
    assert.equal(run(['status', '--session', 'replay']).problems[0].state, 'applied');
    assert.equal(run(['worker', '--once']).modelCalls, 0);
    assert.doesNotMatch(readFileSync(join(dir, '.evolveflow/state/templates', memory.id + '.md'), 'utf8'), /missing fake secret/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('invalid hook input reports a coverage warning, never silent success', () => {
  const dir = mkdtempSync(join(tmpdir(), 'evolveflow invalid '));
  try {
    const r = spawnSync(process.execPath, [resolve('src/cli.ts'), 'hook', '--project', dir], { input: 'invalid json', encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.match(JSON.parse(r.stdout).systemMessage, /监控缺口/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
