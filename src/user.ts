#!/usr/bin/env node
import { existsSync, realpathSync, statSync, mkdirSync, readSync, readdirSync, lstatSync, copyFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { Companion } from './companion.ts';
import { hash } from './normalize.ts';
import type { HookInput } from './types.ts';
import { DatabaseSync, backup } from 'node:sqlite';

export function projectRoot(cwd: string) {
  if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error('Conversation cwd is not an available directory');
  const original = realpathSync(cwd);
  let path = original;
  while (true) {
    if (existsSync(join(path, '.git'))) return path;
    const parent = dirname(path); if (parent === path) return original; path = parent;
  }
}
export function stateDirectory(home: string, project: string) {
  const path = resolve(project);
  const key = process.platform === 'win32' ? path.toLowerCase() : path;
  const state = join(resolve(home), 'evolveflow', 'projects', hash(key), 'state');
  let current = state;
  while (true) {
    try { if (lstatSync(current).isSymbolicLink()) throw new Error('Refusing user state symlink/junction: ' + current); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const parent = dirname(current); if (parent === current) break; current = parent;
  }
  return state;
}
export async function migrateProject(home: string, cwd: string) {
  const root = projectRoot(cwd);
  const source = join(root, '.evolveflow', 'state');
  const destination = stateDirectory(home, root);
  const sourceDb = join(source, 'evolveflow.sqlite');
  const destinationDb = join(destination, 'evolveflow.sqlite');
  if (!existsSync(sourceDb)) return { migrated: false, reason: 'No project-local state', destination };
  if (existsSync(destinationDb)) return { migrated: false, reason: 'User state already exists; preserved', destination };
  for (const path of [join(root, '.evolveflow'), source, sourceDb]) if (lstatSync(path).isSymbolicLink()) throw new Error('Refusing migration symlink: ' + path);
  mkdirSync(destination, { recursive: true });
  const db = new DatabaseSync(sourceDb, { readOnly: true });
  try { await backup(db, destinationDb); } finally { db.close(); }
  const templates = join(source, 'templates');
  if (existsSync(templates)) {
    if (lstatSync(templates).isSymbolicLink()) throw new Error('Refusing template symlink');
    mkdirSync(join(destination, 'templates'), { recursive: true });
    for (const name of readdirSync(templates)) if (/^[a-f0-9]{24}\.(?:md|json)$/.test(name) && lstatSync(join(templates, name)).isFile() && !lstatSync(join(templates, name)).isSymbolicLink()) copyFileSync(join(templates, name), join(destination, 'templates', name));
  }
  return { migrated: true, source, destination, originalPreserved: true };
}
function inputText() {
  const chunks: Buffer[] = []; let size = 0;
  while (true) {
    const buffer = Buffer.alloc(65536); const n = readSync(0, buffer, 0, buffer.length, null); if (!n) break;
    size += n; if (size > 2 * 1024 * 1024) throw new Error('Hook input exceeds 2MiB'); chunks.push(buffer.subarray(0, n));
  }
  return Buffer.concat(chunks).toString('utf8').replace(/^\uFEFF/, '');
}
export async function userMain(argv: string[]) {
  let app: Companion | undefined;
  const command = argv[0] ?? 'status';
  try {
    let home = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex');
    let explicitProject: string | undefined;
    const forward: string[] = [];
    for (let i = 0; i < argv.length; i++) {
      if (argv[i] === '--home') { if (!argv[i + 1]) throw new Error('--home needs a path'); home = resolve(argv[++i]); }
      else if (argv[i] === '--project') { if (!argv[i + 1]) throw new Error('--project needs a path'); explicitProject = argv[++i]; }
      else forward.push(argv[i]);
    }
    if (command === 'migrate') {
      if (!explicitProject) throw new Error('migrate requires an explicit --project path');
      process.stdout.write(JSON.stringify(await migrateProject(home, resolve(explicitProject))) + '\n'); return;
    }
    if (command !== 'hook') {
      const project = projectRoot(resolve(explicitProject ?? process.cwd()));
      const result = spawnSync(process.execPath, [fileURLToPath(new URL('./cli.ts', import.meta.url)), ...forward, '--project', project, '--state', stateDirectory(home, project)], { stdio: 'inherit' });
      process.exitCode = result.status ?? 1; return;
    }
    const input = JSON.parse(inputText()) as HookInput;
    let root: string;
    if (explicitProject || input.cwd) root = projectRoot(resolve(explicitProject ?? input.cwd!));
    else {
      root = join(resolve(home), 'evolveflow', 'unscoped', hash(input.session_id ?? 'unknown'));
      mkdirSync(root, { recursive: true });
    }
    app = new Companion(stateDirectory(home, root), root, { automaticSummary: true });
    if (!input.cwd) app.gap(String(input.session_id ?? 'unknown'), 'Conversation cwd unavailable; unscoped conversation only, executable project scope cannot be inferred');
    process.stdout.write(JSON.stringify(app.handle(input).output) + '\n');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (command === 'hook') process.stdout.write(JSON.stringify({ systemMessage: 'EvolveFlow 用户级监控缺口：' + message }) + '\n');
    else { process.stderr.write(message + '\n'); process.exitCode = 1; }
  } finally { app?.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await userMain(process.argv.slice(2));
