import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Companion } from '../src/companion.ts';
import { projectRoot, stateDirectory, migrateProject } from '../src/user.ts';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'evolveflow user '));
  const home = join(dir, 'codex home'); const project = join(dir, 'project one'); const other = join(dir, 'project two');
  for (const p of [home, project, other]) mkdirSync(p);
  return { dir, home, project, other, close() { rmSync(dir, { recursive: true, force: true }); } };
}
function install(home: string, action = 'install') {
  return spawnSync(process.execPath, [resolve('tools/install-user.mjs'), action, '--home', home], { encoding: 'utf8' });
}
test('user install preserves unrelated configuration and uninstalls only owned files', () => {
  const f = fixture(); try {
    const hooks = '{"description":"mine","hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo mine"}]}]}}';
    writeFileSync(join(f.home, 'hooks.json'), hooks);
    writeFileSync(join(f.home, 'config.toml'), '[features]\nhooks = true\n');
    const installed = install(f.home); assert.equal(installed.status, 0, installed.stderr);
    assert.equal(install(f.home).status, 0);
    const config = JSON.parse(readFileSync(join(f.home, 'hooks.json'), 'utf8'));
    assert.equal(config.hooks.Stop.length, 2);
    assert.ok(existsSync(join(f.home, 'skills/evolveflow-companion/SKILL.md')));
    assert.equal(existsSync(join(f.home, 'skills/evolveflow-development/SKILL.md')), false);
    assert.equal(readFileSync(join(f.home, 'config.toml'), 'utf8'), '[features]\nhooks = true\n');
    assert.equal(install(f.home, 'check').status, 0);
    mkdirSync(join(f.home, 'evolveflow/projects/saved'), { recursive: true }); writeFileSync(join(f.home, 'evolveflow/projects/saved/memory.txt'), 'retain');
    assert.equal(install(f.home, 'uninstall').status, 0);
    assert.equal(readFileSync(join(f.home, 'hooks.json'), 'utf8'), hooks);
    assert.ok(existsSync(join(f.home, 'evolveflow/projects/saved/memory.txt')));
  } finally { f.close(); }
});
test('user installer refuses changed managed files and never writes hook trust', () => {
  const f = fixture(); try {
    assert.equal(install(f.home).status, 0);
    assert.equal(existsSync(join(f.home, 'config.toml')), false);
    writeFileSync(join(f.home, 'skills/evolveflow-companion/SKILL.md'), 'user edit');
    assert.notEqual(install(f.home, 'update').status, 0);
    assert.notEqual(install(f.home, 'uninstall').status, 0);
    assert.equal(readFileSync(join(f.home, 'skills/evolveflow-companion/SKILL.md'), 'utf8'), 'user edit');
  } finally { f.close(); }
});
test('global routing keeps repositories and ordinary directories isolated without writing workspace state', () => {
  const f = fixture(); try {
    mkdirSync(join(f.project, '.git')); mkdirSync(join(f.project, 'sub'));
    assert.equal(projectRoot(join(f.project, 'sub')), f.project);
    assert.equal(projectRoot(f.other), f.other);
    assert.notEqual(stateDirectory(f.home, f.project), stateDirectory(f.home, f.other));
    const hook = (cwd: string, session: string, kind: string, extra: object = {}) => {
      const r = spawnSync(process.execPath, [resolve('src/user.ts'), 'hook', '--home', f.home], { encoding: 'utf8', input: JSON.stringify({ session_id: session, turn_id: 'turn', cwd, hook_event_name: kind, ...extra }) });
      assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout);
    };
    hook(f.project, 'one', 'UserPromptSubmit', { prompt: '普通讨论也需要自动复盘。' });
    const stop = hook(f.project, 'one', 'Stop', { last_assistant_message: '这次讨论已完成。' });
    assert.equal(stop.decision, 'block'); assert.match(stop.reason, /自动复盘/);
    assert.notEqual(hook(f.project, 'one', 'Stop', { stop_hook_active: true }).decision, 'block');
    hook(f.other, 'two', 'UserPromptSubmit', { prompt: '另一个项目' });
    const a = new Companion(stateDirectory(f.home, f.project), f.project);
    const b = new Companion(stateDirectory(f.home, f.other), f.other);
    assert.ok(a.status('one').events.length > 0); assert.equal(b.status('one').events.length, 0);
    a.close(); b.close();
    assert.equal(existsSync(join(f.other, '.evolveflow')), false);
  } finally { f.close(); }
});
test('installed user hook launcher works outside the source project', { skip: process.platform !== 'win32' }, () => {
  const f = fixture(); try {
    const r = install(f.home); assert.equal(r.status, 0, r.stderr);
    const hooks = JSON.parse(readFileSync(join(f.home, 'hooks.json'), 'utf8'));
    const command = hooks.hooks.SessionStart[0].hooks[0].commandWindows;
    const result = spawnSync('cmd.exe', ['/d', '/s', '/c', command], { cwd: f.other, encoding: 'utf8', input: JSON.stringify({ session_id: 'outside', cwd: f.other, hook_event_name: 'SessionStart' }), timeout: 15_000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(JSON.stringify(JSON.parse(result.stdout)), /自动复盘|automaticSummary/);
    assert.ok(existsSync(join(stateDirectory(f.home, f.other), 'evolveflow.sqlite')));
  } finally { f.close(); }
});
test('ordinary turn summary completes without creating fake memory or retiring tool failures', () => {
  const f = fixture(); const app = new Companion(join(f.home, 'state'), f.project, { automaticSummary: true });
  try {
    app.handle({ session_id: 's', turn_id: 't', cwd: f.project, hook_event_name: 'UserPromptSubmit', prompt: '讨论一下今天的安排' });
    app.handle({ session_id: 's', turn_id: 't', cwd: f.project, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'bad', tool_input: { command: 'bad' }, tool_response: { exit_code: 1 } });
    assert.equal(app.handle({ session_id: 's', turn_id: 't', cwd: f.project, hook_event_name: 'Stop' }).output.decision, 'block');
    app.completeSummary('s', 't', '已复盘，无通用经验，失败仍等待调查');
    assert.equal(app.memories().length, 0);
    assert.equal(app.status('s').problems[0].state, 'open');
    assert.ok(app.status('s').queue.some(q => q.reason === 'tool_failure' && q.state === 'pending'));
    assert.ok(app.status('s').queue.filter(q => q.reason === 'context_review').every(q => q.state === 'done'));
    assert.equal(app.summaryHistory('s').length, 1);
  } finally { app.close(); f.close(); }
});
test('administrative commands do not recursively create learning tasks', () => {
  const f = fixture(); const app = new Companion(join(f.home, 'state'), f.project, { automaticSummary: true });
  try {
    const cli = resolve('src/cli.ts');
    app.handle({ session_id: 's', turn_id: 't', cwd: f.project, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'admin',
      tool_input: { command: `node "${cli}" summary --session s --turn t --note "no new experience"` }, tool_response: { exit_code: 0 } });
    assert.equal(app.status('s').queue.length, 0);
    assert.equal(app.status('s').events.length, 0);
  } finally { app.close(); f.close(); }
});

test('missing host turn IDs still allow later turns to summarize once', () => {
  const f = fixture(); const app = new Companion(join(f.home, 'state'), f.project, { automaticSummary: true });
  try {
    app.handle({ session_id: 's', cwd: f.project, hook_event_name: 'UserPromptSubmit', prompt: '第一轮讨论' });
    const first = app.handle({ session_id: 's', cwd: f.project, hook_event_name: 'Stop', last_assistant_message: '第一轮回答' });
    assert.equal(first.output.decision, 'block');
    const turn = first.output.reason!.match(/turn=([^\]]+)/)![1];
    app.completeSummary('s', turn, '第一轮无新增经验');
    app.handle({ session_id: 's', cwd: f.project, hook_event_name: 'UserPromptSubmit', prompt: '第二轮讨论' });
    assert.equal(app.handle({ session_id: 's', cwd: f.project, hook_event_name: 'Stop', last_assistant_message: '第二轮回答' }).output.decision, 'block');
  } finally { app.close(); f.close(); }
});
test('stale or fabricated summary completion cannot retire a newer turn', () => {
  const f = fixture(); const app = new Companion(join(f.home, 'state'), f.project, { automaticSummary: true });
  try {
    app.handle({ session_id: 's', turn_id: 'first', cwd: f.project, hook_event_name: 'UserPromptSubmit', prompt: '第一轮' });
    app.handle({ session_id: 's', turn_id: 'first', cwd: f.project, hook_event_name: 'Stop' });
    const second = app.handle({ session_id: 's', turn_id: 'second', cwd: f.project, hook_event_name: 'UserPromptSubmit', prompt: '第二轮' });
    assert.throws(() => app.completeSummary('s', 'invented', '假回合'), /request|复盘/);
    app.completeSummary('s', 'first', '第一轮已审阅');
    assert.ok(app.status('s').queue.some(q => q.eventId === second.eventId && q.state === 'pending'));
  } finally { app.close(); f.close(); }
});
test('transcript ingestion also excludes administrative CLI activity', () => {
  const f = fixture(); const app = new Companion(join(f.home, 'state'), f.project, { automaticSummary: true });
  try {
    app.handle({ session_id: 's', turn_id: 't', cwd: f.project, hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'bad', tool_input: { command: 'bad' }, tool_response: { exit_code: 1 } });
    const command = `node "${resolve('src/cli.ts')}" summary --session s --turn t --note done`;
    const path = join(f.project, 'transcript.jsonl');
    writeFileSync(path, [
      { type: 'turn_context', payload: { cwd: f.project } },
      { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'admin', arguments: JSON.stringify({ cmd: command }) } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: 'admin', output: 'Process exited with code 0' } },
    ].map(x => JSON.stringify(x)).join('\n') + '\n');
    app.ingestTranscript('s', path);
    assert.equal(app.status('s').events.filter(e => e.action === command).length, 0);
    assert.equal(app.status('s').queue.filter(q => q.reason === 'success_needs_attribution').length, 0);
  } finally { app.close(); f.close(); }
});

test('migration preserves existing project memory state and never overwrites newer user state', async () => {
  const f = fixture(); try {
    const local = new Companion(join(f.project, '.evolveflow/state'), f.project);
    local.handle({ session_id: 'old', turn_id: 'old', cwd: f.project, hook_event_name: 'UserPromptSubmit', prompt: '保留原有项目经验' });
    local.close();
    const result = await migrateProject(f.home, f.project);
    assert.equal(result.migrated, true);
    const global = new Companion(stateDirectory(f.home, f.project), f.project);
    assert.equal(global.status('old').events.length, 1); global.close();
    assert.equal((await migrateProject(f.home, f.project)).migrated, false);
    assert.ok(existsSync(join(f.project, '.evolveflow/state/evolveflow.sqlite')));
  } finally { f.close(); }
});

test('mixed turn-ID coverage uses the current explicit prompt turn for missing Stop IDs', () => {
  const f = fixture(); const app = new Companion(join(f.home, 'state'), f.project, { automaticSummary: true });
  try {
    for (const turn of ['host-one', 'host-two']) {
      app.handle({ session_id: 's', turn_id: turn, cwd: f.project, hook_event_name: 'UserPromptSubmit', prompt: turn });
      const stop = app.handle({ session_id: 's', cwd: f.project, hook_event_name: 'Stop', last_assistant_message: turn });
      assert.equal(stop.output.decision, 'block'); assert.match(stop.output.reason ?? '', new RegExp('turn=' + turn));
      app.completeSummary('s', turn, '无新经验');
    }
  } finally { app.close(); f.close(); }
});
test('migration rejects a destination junction before writing state outside the profile', async () => {
  const f = fixture(); try {
    const app = new Companion(join(f.project, '.evolveflow/state'), f.project); app.close();
    const destination = stateDirectory(f.home, f.project);
    const outside = join(f.dir, 'outside'); mkdirSync(outside);
    mkdirSync(dirname(dirname(destination)), { recursive: true });
    symlinkSync(outside, dirname(destination), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(migrateProject(f.home, f.project), /symlink|junction/i);
    assert.equal(existsSync(join(outside, 'state/evolveflow.sqlite')), false);
  } finally { f.close(); }
});
