import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { inflateRawSync } from 'node:zlib';
import { posix } from 'node:path';

const installer = resolve('tools/install.mjs');
async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'evolveflow install '));
  const source = join(base, 'source'); const target = join(base, 'project with spaces');
  await mkdir(join(source, 'skills', 'evolveflow'), { recursive: true });
  await mkdir(join(source, 'src'), { recursive: true });
  await mkdir(join(target, '.codex'), { recursive: true });
  await writeFile(join(source, 'skills/evolveflow/SKILL.md'), 'version one');
  await writeFile(join(source, 'src/cli.ts'), 'console.log(JSON.stringify({}));');
  const original = '{"description":"mine","hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo mine"}]}]}}';
  await writeFile(join(target, '.codex/hooks.json'), original);
  await writeFile(join(target, 'keep.txt'), 'keep');
  return { source, target, original };
}
function run(f: { source: string; target: string }, command: string, mode = 'both') {
  return spawnSync(process.execPath, [installer, command, '--target', f.target, '--source', f.source, '--mode', mode], { encoding: 'utf8' });
}
test('requires an explicit absolute target', () => {
  const r = spawnSync(process.execPath, [installer, 'install'], { encoding: 'utf8' });
  assert.notEqual(r.status, 0); assert.match(r.stderr, /target/i);
});
test('install is idempotent, preserves unrelated hooks, and uninstall restores exact original bytes', async () => {
  const f = await fixture();
  assert.equal(run(f, 'install').status, 0);
  assert.equal(run(f, 'install').status, 0);
  const hooks = JSON.parse(await readFile(join(f.target, '.codex/hooks.json'), 'utf8'));
  assert.equal(hooks.hooks.Stop.length, 2);
  assert.equal(run(f, 'check').status, 0);
  assert.equal(run(f, 'uninstall').status, 0);
  assert.equal(await readFile(join(f.target, '.codex/hooks.json'), 'utf8'), f.original);
  assert.equal(await readFile(join(f.target, 'keep.txt'), 'utf8'), 'keep');
  await assert.rejects(access(join(f.target, '.agents/skills/evolveflow/SKILL.md')));
});
test('refuses conflicts before writing anything and requires explicit update for source changes', async () => {
  const f = await fixture();
  await mkdir(join(f.target, '.agents/skills/evolveflow'), { recursive: true });
  const skill = join(f.target, '.agents/skills/evolveflow/SKILL.md');
  await writeFile(skill, 'user skill');
  assert.notEqual(run(f, 'install').status, 0);
  assert.equal(await readFile(join(f.target, '.codex/hooks.json'), 'utf8'), f.original);
  const g = await fixture(); assert.equal(run(g, 'install').status, 0);
  await writeFile(join(g.source, 'skills/evolveflow/SKILL.md'), 'version two');
  assert.notEqual(run(g, 'install').status, 0);
  assert.equal(run(g, 'update').status, 0);
  assert.equal(await readFile(join(g.target, '.agents/skills/evolveflow/SKILL.md'), 'utf8'), 'version two');
});
test('tampering blocks update and uninstall without deleting user edits', async () => {
  const f = await fixture(); assert.equal(run(f, 'install').status, 0);
  const path = join(f.target, '.agents/skills/evolveflow/SKILL.md');
  await writeFile(path, 'edited');
  assert.notEqual(run(f, 'check').status, 0);
  assert.notEqual(run(f, 'update').status, 0);
  assert.notEqual(run(f, 'uninstall').status, 0);
  assert.equal(await readFile(path, 'utf8'), 'edited');
});
test('update without mode preserves an installed companion and Interrupt coverage', async () => {
  const f = await fixture(); assert.equal(run(f, 'install', 'both').status, 0);
  const r = spawnSync(process.execPath, [installer, 'update', '--target', f.target, '--source', f.source], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const receipt = JSON.parse(await readFile(join(f.target, '.evolveflow/install-receipt.json'), 'utf8'));
  assert.equal(receipt.mode, 'both');
  await access(join(f.target, '.evolveflow/runtime/src/cli.ts'));
  const config = JSON.parse(await readFile(join(f.target, '.codex/hooks.json'), 'utf8'));
  assert.equal(config.hooks.Interrupt.length, 1);
});
test('configured Windows launcher works through cmd.exe with spaced paths and stdin', { skip: process.platform !== 'win32' }, async () => {
  const f = await fixture(); assert.equal(run(f, 'install').status, 0);
  const config = JSON.parse(await readFile(join(f.target, '.codex/hooks.json'), 'utf8'));
  const command = config.hooks.SessionStart[0].hooks[0].commandWindows;
  const result = spawnSync('cmd.exe', ['/d', '/s', '/c', command], { encoding: 'utf8', input: '{"hook_event_name":"SessionStart"}' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {});
});
test('doctor rejects an incomplete companion plugin', async () => {
  const f = await fixture();
  await mkdir(join(f.target, '.codex-plugin'), { recursive: true });
  await writeFile(join(f.target, '.codex-plugin/plugin.json'), '{"name":"evolveflow-companion"}');
  const r = spawnSync(process.execPath, [resolve('tools/doctor.mjs'), '--target', f.target], { encoding: 'utf8' });
  assert.notEqual(r.status, 0); assert.match(r.stderr, /packaging template/i);
});

test('A-only package includes runtime and one companion skill with valid document links', async () => {
  const f = await fixture(); const out = join(f.source, 'dist');
  await mkdir(join(f.source, '.codex-plugin'), { recursive: true });
  await mkdir(join(f.source, 'hooks'), { recursive: true });
  await mkdir(join(f.source, 'skills/evolveflow-companion/agents'), { recursive: true });
  await writeFile(join(f.source, 'skills/evolveflow-companion/SKILL.md'), '---\nname: evolveflow-companion\ndescription: Inspect companion context\n---\nUse context.');
  await writeFile(join(f.source, '.codex-plugin/plugin.json'), '{"name":"evolveflow-companion"}');
  await writeFile(join(f.source, 'hooks/hooks.json'), '{"hooks":{}}');
  await writeFile(join(f.source, 'package.json'), '{"type":"module"}');
  await mkdir(join(f.source, 'doc'), { recursive: true });
  await writeFile(join(f.source, 'README.md'), '[English](README-EN.md) [Types](src/types.ts) [Usage](doc/usage.md)');
  await writeFile(join(f.source, 'README-EN.md'), '[中文](README.md)');
  await writeFile(join(f.source, 'src/types.ts'), 'export type Report = {};');
  await writeFile(join(f.source, 'doc/usage.md'), '[Home](../README.md)');
  const r = spawnSync(process.execPath, [resolve('tools/package.mjs'), '--source', f.source, '--out', out], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  await assert.rejects(access(join(out, 'evolveflow-skills.zip')));
  const archive = await readFile(join(out, 'only-one-mistake.zip'));
  const files = new Map<string, Buffer>(); let offset = 0;
  while (archive.readUInt32LE(offset) === 0x04034b50) {
    const length = archive.readUInt32LE(offset + 18), nameLength = archive.readUInt16LE(offset + 26), extraLength = archive.readUInt16LE(offset + 28);
    const name = archive.subarray(offset + 30, offset + 30 + nameLength).toString('utf8');
    const start = offset + 30 + nameLength + extraLength;
    files.set(name, inflateRawSync(archive.subarray(start, start + length))); offset = start + length;
  }
  assert.ok(files.has('src/cli.ts')); assert.ok(files.has('hooks/hooks.json'));
  assert.ok(files.has('.codex-plugin/plugin.json'));
  assert.deepEqual([...files.keys()].filter(n => /^skills\/[^/]+\/SKILL.md$/.test(n)), ['skills/evolveflow-companion/SKILL.md']);
  for (const [name, bytes] of files) {
    if (!name.endsWith('.md')) continue;
    for (const match of bytes.toString('utf8').matchAll(/\]\(([^)]+)\)/g)) {
      const href = match[1].replace(/^<|>$/g, '').split('#')[0];
      if (!href || /^[a-z][a-z\d+.-]*:/i.test(href)) continue;
      assert.ok(files.has(posix.normalize(posix.join(posix.dirname(name), decodeURIComponent(href)))), `Broken packaged link ${name}: ${href}`);
    }
  }
});
