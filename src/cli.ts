#!/usr/bin/env node
import { readFileSync, readSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Companion } from './companion.ts';
import type { HookInput, Report } from './types.ts';

const args = process.argv.slice(2);
const flags = new Map<string, string>();
const position: string[] = [];
for (let i = 0; i < args.length; i++) {
  if (args[i].startsWith('--')) {
    const key = args[i].slice(2);
    const value = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : 'true';
    flags.set(key, value);
  } else position.push(args[i]);
}
const command = position[0] ?? 'help';
const print = (data: unknown) => process.stdout.write(JSON.stringify(data, null, 2) + '\n');
function stdin(): string {
  const pieces: Buffer[] = []; let total = 0;
  while (true) {
    const piece = Buffer.alloc(65536); const n = readSync(0, piece, 0, piece.length, null); if (!n) break;
    total += n; if (total > 2 * 1024 * 1024) throw new Error('Hook input exceeds 2MiB');
    pieces.push(piece.subarray(0, n));
  }
  return Buffer.concat(pieces).toString('utf8').replace(/^\uFEFF/, '');
}
let app: Companion | undefined;
try {
  if (Number(process.versions.node.split('.')[0]) < 24) throw new Error('EvolveFlow requires Node.js 24 or newer');
  if (command === 'help' || flags.has('help')) {
    print({ name: 'EvolveFlow', version: '0.1.0', commands: [
      'hook [--project ABS] [--state ABS] < hook.json',
      'context --session ID [--query TEXT]', 'status [--session ID]', 'coverage [--session ID]', 'metrics [--session ID]',
      'report --file REPORT.json', 'memory list|disable ID|rollback ID',
      'worker --once [--session ID]', 'worker --watch [--interval 2000]',
      'reproduce MEMORY_ID --session ID --reason EXPLICIT_USER_REQUEST', 'pause', 'resume',
      'review EVENT_ID --session ID --disposition reviewed|deferred --reason TEXT',
      'summary --session ID --turn ORIGINAL_TURN_ID --note TEXT', 'summary history [--session ID]',
      'replay --file EVENTS.json',
    ], globalFlags: ['--project ABS (defaults to hook.cwd or current directory)', '--state ABS (defaults to PROJECT/.evolveflow/state)'],
    learning: 'No background model calls. The active host interprets context and submits evidence-linked reports.' });
  } else {
    let input: HookInput | undefined;
    if (command === 'hook') input = JSON.parse(stdin()) as HookInput;
    const project = resolve(flags.get('project') ?? input?.cwd ?? process.cwd());
    if (!existsSync(project)) throw new Error('Project directory does not exist: ' + project);
    app = new Companion(resolve(flags.get('state') ?? join(project, '.evolveflow', 'state')), project);
    const session = flags.get('session');
    if (command === 'hook') print(app.handle(input!).output);
    else if (command === 'status') print(app.status(session));
    else if (command === 'coverage') print(app.status(session).coverage);
    else if (command === 'metrics') print(app.metrics(session));
    else if (command === 'context') {
      if (!session) throw new Error('--session is required');
      print({ context: app.context(session, flags.get('query')) });
    } else if (command === 'report') {
      const file = flags.get('file'); if (!file || file === 'true') throw new Error('--file REPORT.json is required');
      print(app.report(JSON.parse(readFileSync(resolve(file), 'utf8').replace(/^\uFEFF/, '')) as Report));
    } else if (command === 'memory') {
      if (position[1] === 'list') print(app.memories());
      else if (position[1] === 'disable') { app.disable(position[2]); print({ disabled: position[2] }); }
      else if (position[1] === 'rollback') { app.rollback(position[2]); print({ restored: position[2] }); }
      else throw new Error('Use memory list, memory disable ID, memory rollback ID');
    } else if (command === 'pause' || command === 'resume') {
      app.pause(command === 'pause'); print({ paused: command === 'pause' });
    } else if (command === 'reproduce') {
      if (!session || !position[1] || !flags.get('reason')) throw new Error('reproduce requires MEMORY_ID, --session and --reason');
      app.allowReproduction(session, position[1], flags.get('reason')!); print({ oneShot: true, memoryId: position[1] });
    } else if (command === 'review') {
      const disposition = flags.get('disposition');
      if (!session || !position[1] || !flags.get('reason') || !['reviewed', 'deferred'].includes(disposition ?? '')) throw new Error('review requires EVENT_ID, --session, --disposition reviewed|deferred, --reason');
      app.review(session, position[1], disposition as 'reviewed' | 'deferred', flags.get('reason')!); print({ reviewed: position[1], disposition });
    } else if (command === 'summary') {
      if (position[1] === 'history') print(app.summaryHistory(session));
      else {
        const turn = flags.get('turn'); const note = flags.get('note');
        if (!session || !turn || !note) throw new Error('summary requires --session, --turn and --note');
        app.completeSummary(session, turn, note); print({ recorded: true, sessionId: session, turnId: turn });
      }
    } else if (command === 'worker') {
      if (!flags.has('once') && !flags.has('watch')) throw new Error('worker requires --once or --watch');
      if (flags.has('watch')) {
        const interval = Number(flags.get('interval') ?? 2000);
        if (!Number.isFinite(interval) || interval < 500) throw new Error('--interval must be at least 500 milliseconds');
        const tick = () => { const result = app!.workerOnce(session); if (result.processed) print(result); };
        tick();
        const timer = setInterval(tick, interval);
        const stop = () => { clearInterval(timer); app?.close(); process.exit(0); };
        process.on('SIGINT', stop); process.on('SIGTERM', stop);
        await new Promise<void>(() => {});
      } else print(app.workerOnce(session));
    } else if (command === 'replay') {
      const file = flags.get('file'); if (!file) throw new Error('--file is required');
      const rows: unknown = JSON.parse(readFileSync(resolve(file), 'utf8'));
      if (!Array.isArray(rows)) throw new Error('Replay requires an array of hook events');
      print(rows.map(row => app!.handle(row as HookInput)));
    } else throw new Error('Unknown command: ' + command);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  if (command === 'hook') print({ systemMessage: 'EvolveFlow 监控缺口：' + message });
  else { print({ error: message }); process.exitCode = 1; }
} finally { app?.close(); }
