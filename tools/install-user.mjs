#!/usr/bin/env node
import { readFile, writeFile, mkdir, readdir, lstat, unlink } from 'node:fs/promises';
import { resolve, join, dirname, isAbsolute, relative } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { events } from './install.mjs';
import { commandHook } from './hook-command.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
async function maybe(path) { try { return await readFile(path); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
async function safe(home, name) {
  const path = resolve(home, name); const rel = relative(home, path);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw Error('Unsafe user install path: ' + name);
  let current = path;
  while (true) {
    try { if ((await lstat(current)).isSymbolicLink()) throw Error('Refusing symlink/junction: ' + current); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const parent = dirname(current); if (parent === current) break; current = parent;
  }
  return path;
}
async function files(root, prefix = '') {
  const result = [];
  for (const item of await readdir(join(root, prefix), { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isSymbolicLink()) throw Error('Refusing source symlink: ' + name);
    if (item.isDirectory()) result.push(...await files(root, name)); else if (item.isFile()) result.push(name);
  }
  return result.sort();
}
function ownedPath(name) {
  return !name.includes('\\') && !name.includes(':') && !name.split('/').some(p => !p || p === '.' || p === '..') &&
    (name === 'hooks.json' || name.startsWith('evolveflow/runtime/') || name.startsWith('skills/evolveflow-companion/'));
}
export async function executeUser({ action, home = process.env.CODEX_HOME?.trim() || join(homedir(), '.codex'), source = resolve(dirname(fileURLToPath(import.meta.url)), '..'), dryRun = false }) {
  if (!isAbsolute(home)) throw Error('--home must be an absolute Codex home path');
  if (!['install', 'update', 'check', 'uninstall'].includes(action)) throw Error('Use install, update, check, uninstall');
  home = resolve(home); source = resolve(source);
  const receiptPath = await safe(home, 'evolveflow/install-user.json');
  const previous = await maybe(receiptPath); const receipt = previous && JSON.parse(previous);
  if (receipt && (receipt.version !== 1 || receipt.home !== home || !receipt.files || typeof receipt.files !== 'object' || Array.isArray(receipt.files))) throw Error('Invalid user ownership receipt');
  for (const [name, owned] of Object.entries(receipt?.files ?? {})) {
    if (!ownedPath(name)) throw Error('Invalid owned user path: ' + name);
    const content = await maybe(await safe(home, name));
    if (!content || digest(content) !== owned.sha256) throw Error('Owned file changed or missing; preserve and resolve manually: ' + name);
  }
  if (action === 'check') {
    if (!receipt) throw Error('A is not installed in this Codex home');
    return { ok: true, scope: 'user', home, automaticSummary: true, files: Object.keys(receipt.files).length,
      hooksTrusted: 'unknown; inspect /hooks', hostAutomaticTriggering: 'not established by file checks', stateRoot: join(home, 'evolveflow/projects'), model: 'active Codex conversation only' };
  }
  if (action === 'uninstall') {
    if (!receipt) return { ok: true, action, changed: 0 };
    if (!dryRun) {
      for (const [name, owned] of Object.entries(receipt.files)) {
        const path = await safe(home, name);
        if (owned.original === null) await unlink(path); else await writeFile(path, Buffer.from(owned.original, 'base64'));
      }
      await unlink(receiptPath);
    }
    return { ok: true, action, dryRun, preservedState: join(home, 'evolveflow/projects') };
  }
  if (Number(process.versions.node.split('.')[0]) < 24) throw Error('Node.js 24 or newer required');
  const desired = new Map();
  const srcFiles = await files(join(source, 'src'));
  if (!srcFiles.includes('user.ts') || !srcFiles.includes('cli.ts')) throw Error('Complete A source/runtime required for user installation');
  for (const name of srcFiles) desired.set('evolveflow/runtime/src/' + name, await readFile(join(source, 'src', name)));
  desired.set('evolveflow/runtime/package.json', await readFile(join(source, 'package.json')));
  const skillRoot = join(source, 'skills/evolveflow-companion');
  for (const name of await files(skillRoot)) desired.set('skills/evolveflow-companion/' + name, await readFile(join(skillRoot, name)));
  const runtime = join(home, 'evolveflow/runtime');
  desired.set('skills/evolveflow-companion/user-install.json', json({ scope: 'user', router: join(runtime, 'src/user.ts'), home, automaticSummary: true }));
  const hookFile = await safe(home, 'hooks.json');
  const old = receipt?.files['hooks.json']?.original;
  const original = old === undefined ? await maybe(hookFile) : old === null ? null : Buffer.from(old, 'base64');
  const config = original ? JSON.parse(original.toString('utf8').replace(/^\uFEFF/, '')) : {};
  if (config.hooks !== undefined && (!config.hooks || typeof config.hooks !== 'object' || Array.isArray(config.hooks))) throw Error('Existing user hooks have invalid shape');
  config.hooks ??= {};
  const hook = commandHook([join(runtime, 'src/user.ts'), 'hook', '--home', home]);
  for (const event of events) {
    if (config.hooks[event] !== undefined && !Array.isArray(config.hooks[event])) throw Error('Invalid existing user hook event: ' + event);
    config.hooks[event] = [...(config.hooks[event] ?? []), { hooks: [hook] }];
  }
  desired.set('hooks.json', json(config));
  const next = { version: 1, home, source, scope: 'user', files: {} };
  for (const [name, content] of desired) {
    const current = await maybe(await safe(home, name)); const owned = receipt?.files[name];
    if (current !== null && !owned && name !== 'hooks.json') throw Error('Unowned user file exists: ' + name);
    if (receipt && action === 'install' && (!owned || owned.sha256 !== digest(content))) throw Error('Installation differs; use update');
    next.files[name] = { sha256: digest(content), original: owned ? owned.original : current?.toString('base64') ?? null };
  }
  if (receipt && action === 'install' && Object.keys(receipt.files).some(name => !desired.has(name))) throw Error('Installation differs; use update');
  if (!dryRun) {
    for (const [name, owned] of Object.entries(receipt?.files ?? {})) if (!desired.has(name)) {
      const path = await safe(home, name); if (owned.original === null) await unlink(path); else await writeFile(path, Buffer.from(owned.original, 'base64'));
    }
    for (const [name, content] of desired) { const path = await safe(home, name); await mkdir(dirname(path), { recursive: true }); await writeFile(path, content); }
    await mkdir(dirname(receiptPath), { recursive: true }); await writeFile(receiptPath, json(next));
  }
  return { ok: true, action, dryRun, scope: 'user', home, automaticSummary: true, files: [...desired.keys()], hookReviewRequired: true, configTomlChanged: false };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const [action, ...args] = process.argv.slice(2); const options = { action };
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--dry-run') options.dryRun = true;
      else if (['--home', '--source'].includes(args[i]) && args[i + 1]) options[args[i].slice(2)] = args[++i];
      else throw Error('Unsupported argument: ' + args[i]);
    }
    console.log(JSON.stringify(await executeUser(options), null, 2));
  } catch (e) { console.error(e.message); process.exitCode = 1; }
}
