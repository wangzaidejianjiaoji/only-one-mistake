#!/usr/bin/env node
// Explicit, read-only pilot. Submitted events are NOT native Codex hook evidence.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, isAbsolute, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';

const args = process.argv.slice(2);
const flag = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const projectArg = flag('--project'); const outArg = flag('--out');
if (!projectArg || !outArg || !isAbsolute(projectArg) || !isAbsolute(outArg)) throw Error('Use --project ABS --out ABS; output must be new.');
const project = resolve(projectArg); const out = resolve(outArg);
if (!existsSync(project) || existsSync(out)) throw Error('Project must exist and output must not exist.');
const home = resolve(process.env.CODEX_HOME || join(homedir(), '.codex'));
const locator = JSON.parse(readFileSync(join(home, 'skills/evolveflow-companion/user-install.json'), 'utf8'));
const runtime = new URL('./companion.ts', pathToFileURL(locator.router));
const { Companion } = await import(runtime.href);
const { projectRoot, stateDirectory } = await import(pathToFileURL(locator.router).href);
const root = projectRoot(project);
const app = new Companion(stateDirectory(home, root), root);
const session = 'ssh-pilot-training-' + Date.now();
const reuseSession = session + '-new-connection';
const origin = 'explicit-readonly-ssh-pilot-not-native-hooks';
const results = [];
const target = 'lz@192.168.85.248';
const base = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'ConnectionAttempts=1', '-o', 'StrictHostKeyChecking=yes', '-o', 'ClearAllForwardings=yes'];
const render = (exe, argv) => [exe, ...argv].map(x => JSON.stringify(x)).join(' ');
function execute(label, exe, argv, sessionId = session) {
  const command = render(exe, argv);
  const before = app.handle({ hook_event_name: 'PreToolUse', session_id: sessionId, turn_id: label, cwd: root,
    tool_name: 'exec_command', tool_use_id: sessionId + ':' + label, tool_input: { command, shell: 'direct-exec' }, evolveflow_capture: origin });
  if (before.output.hookSpecificOutput?.permissionDecision === 'deny') throw Error('Blocked by memory: ' + before.output.hookSpecificOutput.permissionDecisionReason);
  const r = spawnSync(exe, argv, { cwd: root, encoding: 'utf8', timeout: 20000, windowsHide: true });
  if (r.error || r.status === null) throw r.error || Error('Process terminated');
  const output = r.stdout + r.stderr;
  const captured = app.handle({ hook_event_name: 'PostToolUse', session_id: sessionId, turn_id: label, cwd: root,
    tool_name: 'exec_command', tool_use_id: sessionId + ':' + label, tool_input: { command, shell: 'direct-exec' },
    tool_response: { exit_code: r.status, output }, evolveflow_capture: origin });
  const item = { label, sessionId, command, exitCode: r.status, output, eventId: captured.eventId, preToolOutput: before.output };
  results.push(item); return item;
}
try {
  app.gap(session, 'Explicit pilot events from real subprocesses; native Codex hook invocation/trust not established.');
  app.gap(reuseSession, 'New session is an explicit adapter simulation, not a newly created Codex chat.');
  app.handle({ hook_event_name: 'UserPromptSubmit', session_id: session, turn_id: 'review-source', cwd: root,
    prompt: '复盘对话 01a18080-c6ed-75e1-981b-376bb9eeeb9f。历史证据：exec-63631b4e-0fa1-49fb-bda3-7e7f583520e4 验证密码认证成功；exec-e30e35c9-55cd-40ae-96a0-850f200b8f0b 加公钥后 SSH 成功；exec-8f199338-c6da-41b2-b648-139ea7b23e99 固定 IP .248/22，旧临时入口已移除。代理隧道已撤回，不能作为有效方案复用。原失败只作历史原因，不能冒充本次采集。', evolveflow_capture: origin });
  // Intentionally suppress identities; never change authorized_keys or server networking.
  const failed = execute('intentional-no-identity', 'ssh', [...base, '-o', 'IdentityAgent=none', '-o', 'IdentitiesOnly=yes', '-o', 'IdentityFile=none', '-o', 'PreferredAuthentications=publickey', target, 'whoami']);
  if (failed.exitCode === 0 || !/Permission denied/i.test(failed.output)) throw Error('Expected controlled authentication rejection; no memory published.');
  const verified = execute('verified-existing-key', 'ssh', [...base, target, 'whoami; hostname']);
  const similar = execute('similar-new-transport', 'ssh', [...base, '-T', target, 'whoami; hostname']);
  const negative = execute('unrelated-local-success', process.execPath, ['-e', 'process.stdout.write("LOCAL_ONLY")']);
  if ([verified, similar, negative].some(r => r.exitCode !== 0) || !/^lz\r?\nadmin\b/m.test(verified.output)) throw Error('Verification failed; refusing activation.');
  const report = { sessionId: session, problemKey: 'ssh-248-noninteractive-existing-key', title: '248 SSH 非交互连接：区分认证、地址与远端联网',
    symptoms: ['Permission denied (publickey,password)', '非交互 SSH 连接失败'], environment: app.environment(),
    failedAttempts: [{ action: failed.command, reason: '本次有意禁用所有本地身份以复现认证失败；不是服务器重新丢失授权，也不是新业务故障。' }],
    solution: '范围：当前 Windows 客户端、lz@192.168.85.248、现有 known_hosts 与已授权密钥。先以 BatchMode=yes、StrictHostKeyChecking=yes、ClearAllForwardings=yes 和有界超时建立新连接，验证 whoami=lz、hostname=admin。认证失败先检查可用身份/authorized_keys，不重复猜密码；已授权密钥无需再次追加。地址不可达先查 TCP/地址及主机身份，不能直接改认证。历史该主机重启后 DHCP 从 .248 变 .52，后来已改回固定 .248/22；网络修复须先重新验证，不能自动把其他机器改成 .248。远端 Codex workspace routing discovery failed 属独立联网层；旧代理隧道已经撤回，不自动恢复。不能把本次连接成功当成自动修复新故障。',
    verification: { eventId: verified.eventId, command: verified.command, evidence: '真实独立 SSH 进程返回 lz/admin；受控禁用身份失败、默认现有身份成功；历史来源 01a18080-c6ed-75e1-981b-376bb9eeeb9f。' },
    evaluation: { similarEventId: similar.eventId, negativeEventId: negative.eventId },
    triggerTerms: ['192.168.85.248', 'SSH 登录', 'SSH连接', 'Permission denied'],
    invalidWhen: ['其他主机/账号/客户端；须重新验证身份和授权', '主机密钥变化；停止并核验，禁止跳过检查', 'IP、路由、SSH 配置、密钥或服务器授权发生变化', '连接成功但远端 Codex 联网失败；使用独立诊断'], scope: 'project', kind: 'memory' };
  const memory = app.report(report);
  if (memory.status !== 'active') throw Error('Memory not active');
  const fresh = app.handle({ hook_event_name: 'UserPromptSubmit', session_id: reuseSession, turn_id: 'new-connection', cwd: root,
    prompt: '请重新建立 SSH连接 lz@192.168.85.248，直接使用已验证方法，不修改服务器配置。', evolveflow_capture: origin });
  const text = fresh.output.hookSpecificOutput?.additionalContext || '';
  if (!text.includes(memory.id)) throw Error('New-session prompt did not retrieve memory');
  const connection = execute('reuse-verified-method', 'ssh', [...base, target, 'whoami; hostname'], reuseSession);
  if (connection.exitCode !== 0 || !/^lz\r?\nadmin\b/m.test(connection.output)) throw Error('New SSH process failed');
  const otherProject = resolve(fileURLToPath(new URL('../', import.meta.url)));
  if (otherProject === root) throw Error('SSH trial project must differ from the source checkout for the isolation check');
  const wrongProject = new Companion(stateDirectory(home, otherProject), otherProject);
  let crossProjectExcluded;
  try { crossProjectExcluded = !wrongProject.applicable(reuseSession, '192.168.85.248').some(m => m.id === memory.id); } finally { wrongProject.close(); }
  mkdirSync(out, { recursive: true });
  const result = { at: new Date().toISOString(), sourceThreadId: '01a18080-c6ed-75e1-981b-376bb9eeeb9f', origin,
    project: root, state: app.stateDir, memory, results, newSessionContextIncludesMemory: true,
    newConnectionSucceeded: true, crossProjectExcluded, metrics: app.metrics(),
    nativeHookTriggering: 'not_verified', newCodexChatCreated: false, serverChanges: false, passwordStored: false,
    limitations: ['Controlled identity-suppression failure; server was already repaired before this pilot.', 'Manual adapter submission proves retrieval and real SSH reuse, not automatic desktop hook execution.', 'Memory is project-scoped; different project/remote host cannot inherit it automatically.'] };
  writeFileSync(join(out, 'result.json'), JSON.stringify(result, null, 2) + '\n');
  writeFileSync(join(out, 'new-session-context.json'), JSON.stringify(fresh.output, null, 2) + '\n');
  console.log(JSON.stringify({ out, memoryId: memory.id, status: memory.status, newConnectionSucceeded: true, crossProjectExcluded, nativeHookTriggering: result.nativeHookTriggering }));
} finally { app.close(); }
