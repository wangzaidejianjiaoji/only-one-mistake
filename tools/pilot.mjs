#!/usr/bin/env node
import { mkdirSync, cpSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

// A deterministic fault-injection pilot based on a defect found in this project's review.
// It runs actual code/tests, but never represents itself as a native Codex hook test.
const source = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outFlag = process.argv.indexOf('--out');
const out = resolve(outFlag >= 0 ? process.argv[outFlag + 1] : join(source, '.evolveflow', 'pilot'));
const project = join(out, 'project');
if (existsSync(join(out, 'result.json'))) throw Error('Pilot output already exists; choose a fresh --out directory.');
mkdirSync(join(project, 'test'), { recursive: true });
cpSync(join(source, 'src'), join(project, 'src'), { recursive: true });
cpSync(join(source, 'test/core.test.ts'), join(project, 'test/core.test.ts'));
writeFileSync(join(project, 'package.json'), '{"type":"module"}\n');
const original = readFileSync(join(project, 'src/companion.ts'), 'utf8');
const safe = "if (memory.status === 'active' || previous?.status !== 'active') this.store.put('memories', id, memory);";
if (!original.includes(safe)) throw Error('Regression patch no longer matches current code; update the pilot explicitly.');
const broken = original.replace(safe, "this.store.put('memories', id, memory); // deliberate historical regression");
const session = 'code-review-pilot';
const cli = join(project, 'src/cli.ts');
// Node's parent test runner marks descendants; carrying this flag would silently
// skip the nested regression suite and incorrectly return exit 0.
const childEnvironment = { ...process.env }; delete childEnvironment.NODE_TEST_CONTEXT;
function invoke(args, input) {
  const r = spawnSync(process.execPath, [cli, ...args, '--project', project], { encoding: 'utf8', input: input ? JSON.stringify(input) : undefined, timeout: 15_000 });
  if (r.status !== 0) throw Error(r.stderr + r.stdout);
  return JSON.parse(r.stdout);
}
const testArgs = ['--test', '--test-name-pattern=an unapproved replacement', 'test/core.test.ts'];
const command = [process.execPath, ...testArgs].map(x => JSON.stringify(x)).join(' ');
function execute(content, toolId) {
  writeFileSync(join(project, 'src/companion.ts'), content);
  const r = spawnSync(process.execPath, testArgs, { cwd: project, encoding: 'utf8', timeout: 15_000, env: childEnvironment });
  if (r.error || r.status === null) throw r.error ?? Error('Pilot test terminated');
  const result = { exitCode: r.status, output: r.stdout + r.stderr, sourceSha256: createHash('sha256').update(content).digest('hex') };
  invoke(['hook'], { session_id: session, turn_id: 'review', cwd: project, hook_event_name: 'PostToolUse', tool_name: 'Bash',
    tool_use_id: toolId, tool_input: { command }, tool_response: { exit_code: r.status, output: result.output }, evolveflow_capture: 'local-fault-injection-pilot' });
  return result;
}
const baseline = execute(broken, 'before-fix');
if (baseline.exitCode === 0) throw Error('Regression did not reproduce; refusing to claim red/green evidence');
const fixed = execute(original, 'after-fix');
if (fixed.exitCode !== 0) throw Error('Current source failed the pilot verification');
const status = invoke(['status', '--session', session]);
const success = status.events.find(e => e.exitCode === 0);
const report = { sessionId: session, problemKey: status.problems[0].id, title: '候选规则必须保留已有有效解法',
  symptoms: ['提交待确认核心变更后，原 active 解法消失'], environment: status.environment,
  failedAttempts: [{ action: command, reason: '候选和生效版本共用覆盖路径' }],
  solution: '将 pending/candidate 提案独立保存；只有 active 新版本才替换已有 active 记录。版本号从不可变历史单调分配，回滚不得重写旧版本。修复后运行对应回归测试。',
  verification: { eventId: success.id, command, evidence: 'Node public behavior regression failed with injected old defect and passed with current source' },
  triggerTerms: ['候选覆盖', '待确认规则', 'active memory', 'candidate memory'], invalidWhen: ['存储或版本接口改变'], scope: 'session', kind: 'memory' };
const reportPath = join(out, 'report.json'); writeFileSync(reportPath, JSON.stringify(report, null, 2));
const memory = invoke(['report', '--file', reportPath]);
const context = invoke(['context', '--session', session]);
if (!context.context.includes('将 pending/candidate 提案独立保存')) throw Error('Verified method not available at the next context checkpoint');
const reused = execute(original, 'reused-verification');
const final = invoke(['status', '--session', session]);
const result = { date: new Date().toISOString(), pilotKind: 'actual-code-review-case / deliberate-regression-replay',
  nativeHookTriggering: 'not_tested', modelCalls: 0, command, baseline, fixed, reused, memory,
  problemState: final.problems[0].state, immediateContextIncludesMethod: true, project,
  boundaries: ['Hook payloads submitted explicitly through real CLI; desktop trust was not changed', 'Regression deliberately injected in isolated source copy', 'No production deployment, no autonomous model calls'] };
writeFileSync(join(out, 'context.json'), JSON.stringify(context, null, 2));
writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify({ out, baseline: baseline.exitCode, fixed: fixed.exitCode, reused: reused.exitCode, memory: memory.id, state: final.problems[0].state }));
