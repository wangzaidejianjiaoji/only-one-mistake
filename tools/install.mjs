#!/usr/bin/env node
import { readFile, writeFile, mkdir, readdir, lstat, unlink } from 'node:fs/promises';
import { resolve, join, dirname, isAbsolute, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { commandHook } from './hook-command.mjs';

export const events = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PreCompact', 'PostCompact', 'Stop', 'Interrupt', 'SessionEnd'];
const receiptName = '.evolveflow/install-receipt.json';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
async function readMaybe(path) { try { return await readFile(path); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
function allowed(path) {
  if (path.includes('\\') || path.includes(':') || path.split('/').some(part => !part || part === '.' || part === '..')) return false;
  return path === '.codex/hooks.json' || path.startsWith('.agents/skills/') || path.startsWith('.evolveflow/runtime/');
}
async function safePath(target, name) {
  const path = resolve(target, name);
  const rel = relative(target, path);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw Error(`Unsafe installation path: ${name}`);
  // Do not follow junctions/symlinks into other projects, including in target ancestors.
  let current = path;
  while (true) {
    try { if ((await lstat(current)).isSymbolicLink()) throw Error(`Refusing symlink/junction: ${current}`); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    const parent = dirname(current); if (parent === current) break; current = parent;
  }
  return path;
}
async function filesUnder(root, prefix = '') {
  const result = [];
  for (const item of await readdir(join(root, prefix), { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.isSymbolicLink()) throw Error(`Source symlink is not copied: ${name}`);
    if (item.isDirectory()) result.push(...await filesUnder(root, name));
    else if (item.isFile()) result.push(name);
  }
  return result.sort();
}
export function hookConfig(runtime, project, node = process.execPath) {
  // Only a fixed JavaScript expression and a base64 literal reach the shell.
  // Real paths are decoded inside Node and passed as argv, including spaces/quotes.
  const args = [join(runtime, 'src/cli.ts'), 'hook', '--project', project, '--state', join(project, '.evolveflow/state')];
  return { hooks: Object.fromEntries(events.map(event => [event, [{ hooks: [commandHook(args, node)] }]])) };
}
export async function execute({ action, target, source = resolve(dirname(fileURLToPath(import.meta.url)), '..'), mode }) {
  if (!target || !isAbsolute(target)) throw Error('An explicit absolute --target project path is required.');
  if (!['install', 'update', 'check', 'uninstall'].includes(action)) throw Error('Use install, update, check, or uninstall.');
  target = resolve(target); source = resolve(source);
  const receiptPath = await safePath(target, receiptName);
  const existing = await readMaybe(receiptPath);
  const receipt = existing ? JSON.parse(existing) : null;
  if (receipt && (receipt.version !== 1 || receipt.target !== target || !receipt.files || typeof receipt.files !== 'object' || Array.isArray(receipt.files))) throw Error('Invalid ownership receipt.');
  mode ??= action === 'update' && receipt ? receipt.mode : 'skills';
  if (!['skills', 'companion', 'both'].includes(mode)) throw Error('--mode must be skills, companion, or both.');
  for (const [name, owned] of Object.entries(receipt?.files ?? {})) {
    if (!allowed(name)) throw Error(`Invalid receipt path: ${name}`);
    const bytes = await readMaybe(await safePath(target, name));
    if (bytes === null || digest(bytes) !== owned.sha256) throw Error(`Owned file changed or missing; preserve and resolve manually: ${name}`);
  }
  if (action === 'check') {
    if (!receipt) throw Error('No installation receipt in target project.');
    return { ok: true, mode: receipt.mode, ownedFiles: Object.keys(receipt.files).length, hooksTrusted: 'unknown', hooksLive: 'not verified' };
  }
  if (action === 'uninstall') {
    if (!receipt) return { ok: true, action, changed: 0 };
    for (const [name, owned] of Object.entries(receipt.files)) {
      const path = await safePath(target, name);
      if (owned.original !== null) await writeFile(path, Buffer.from(owned.original, 'base64'));
      else await unlink(path);
    }
    await unlink(receiptPath);
    return { ok: true, action, preservedState: join(target, '.evolveflow/state') };
  }
  const desired = new Map();
  if (mode !== 'companion') {
    const skillsRoot = join(source, 'skills');
    const names = await filesUnder(skillsRoot);
    if (!names.some(name => name.endsWith('/SKILL.md'))) throw Error('Source contains no discoverable skills.');
    for (const name of names) desired.set(`.agents/skills/${name}`, await readFile(join(skillsRoot, name)));
  }
  if (mode !== 'skills') {
    if (Number(process.versions.node.split('.')[0]) < 24) throw Error('Companion requires Node.js 24 or newer.');
    const runtimeFiles = await filesUnder(join(source, 'src'));
    if (!runtimeFiles.includes('cli.ts')) throw Error('Companion source is incomplete: src/cli.ts missing.');
    for (const name of runtimeFiles) desired.set(`.evolveflow/runtime/src/${name}`, await readFile(join(source, 'src', name)));
    const packageBytes = await readMaybe(join(source, 'package.json'));
    desired.set('.evolveflow/runtime/package.json', packageBytes ?? json({ type: 'module' }));
    const hookName = '.codex/hooks.json';
    const original = receipt?.files[hookName]?.original;
    const oldBytes = original !== undefined ? (original === null ? null : Buffer.from(original, 'base64')) : await readMaybe(await safePath(target, hookName));
    const config = oldBytes ? JSON.parse(oldBytes) : {};
    if (config.hooks !== undefined && (!config.hooks || typeof config.hooks !== 'object' || Array.isArray(config.hooks))) throw Error('Existing hooks configuration has invalid shape.');
    config.hooks ??= {};
    const addition = hookConfig(join(target, '.evolveflow/runtime'), target);
    for (const event of events) {
      if (config.hooks[event] !== undefined && !Array.isArray(config.hooks[event])) throw Error(`Invalid existing hook event: ${event}`);
      config.hooks[event] = [...(config.hooks[event] ?? []), ...addition.hooks[event]];
    }
    desired.set(hookName, json(config));
  }
  const next = { version: 1, target, source, mode, files: {} };
  // Preflight all conflicts before modifying target files.
  for (const [name, bytes] of desired) {
    const current = await readMaybe(await safePath(target, name));
    const owned = receipt?.files[name];
    if (!owned && current !== null && name !== '.codex/hooks.json') throw Error(`Unowned file exists; refusing overwrite: ${name}`);
    if (receipt && action === 'install' && (!owned || owned.sha256 !== digest(bytes) || receipt.mode !== mode)) throw Error('Installation differs; use explicit update.');
    next.files[name] = { sha256: digest(bytes), original: owned ? owned.original : current?.toString('base64') ?? null };
  }
  if (receipt && action === 'install' && Object.keys(receipt.files).some(name => !desired.has(name))) throw Error('Installation differs; use explicit update.');
  for (const [name, owned] of Object.entries(receipt?.files ?? {})) {
    if (!desired.has(name)) {
      const path = await safePath(target, name);
      if (owned.original !== null) await writeFile(path, Buffer.from(owned.original, 'base64')); else await unlink(path);
    }
  }
  for (const [name, bytes] of desired) {
    const path = await safePath(target, name);
    await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes);
  }
  await mkdir(dirname(receiptPath), { recursive: true }); await writeFile(receiptPath, json(next));
  return { ok: true, action, mode, ownedFiles: desired.size, hookReviewRequired: mode !== 'skills' };
}
export function parseArgs(argv) {
  const [action, ...rest] = argv; const options = { action };
  for (let i = 0; i < rest.length; i += 2) {
    if (!['--target', '--source', '--mode'].includes(rest[i]) || !rest[i + 1] || rest[i + 1].startsWith('--')) throw Error(`Invalid argument: ${rest[i]}`);
    options[rest[i].slice(2)] = rest[i + 1];
  }
  return options;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await execute(parseArgs(process.argv.slice(2))), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
