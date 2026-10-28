#!/usr/bin/env node
// Portable ZIP writer using only Node built-ins; includes dotfiles explicitly.
import { readFile, writeFile, readdir, mkdir, lstat } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';

const crcTable = Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n >>> 0;
});
function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0; }
function zip(entries) {
  const bodies = []; const directory = []; let offset = 0;
  for (const [name, content] of [...entries].sort(([a], [b]) => a.localeCompare(b))) {
    const filename = Buffer.from(name); const compressed = deflateRawSync(content); const crc = crc32(content);
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6); local.writeUInt16LE(8, 8); local.writeUInt16LE(33, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(compressed.length, 18); local.writeUInt32LE(content.length, 22); local.writeUInt16LE(filename.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8); central.writeUInt16LE(8, 10); central.writeUInt16LE(33, 14);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(compressed.length, 20); central.writeUInt32LE(content.length, 24); central.writeUInt16LE(filename.length, 28); central.writeUInt32LE(offset, 42);
    bodies.push(local, filename, compressed); directory.push(central, filename); offset += local.length + filename.length + compressed.length;
  }
  const centralBytes = Buffer.concat(directory); const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.size, 8); end.writeUInt16LE(entries.size, 10); end.writeUInt32LE(centralBytes.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...bodies, centralBytes, end]);
}
async function add(entries, source, input, output = input, required = true) {
  const path = join(source, input); let stat;
  try { stat = await lstat(path); } catch (e) { if (!required && e.code === 'ENOENT') return; throw e; }
  if (stat.isSymbolicLink()) throw Error(`Refusing package symlink: ${path}`);
  if (stat.isDirectory()) {
    for (const name of (await readdir(path)).sort()) await add(entries, source, `${input}/${name}`, `${output}/${name}`);
  } else if (stat.isFile()) entries.set(output, await readFile(path));
}
try {
  const options = {};
  for (let i = 2; i < process.argv.length; i += 2) {
    if (!['--source', '--out'].includes(process.argv[i]) || !process.argv[i + 1]) throw Error('Usage: node tools/package.mjs [--source PATH] [--out PATH]');
    options[process.argv[i].slice(2)] = process.argv[i + 1];
  }
  const source = resolve(options.source ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
  const out = resolve(options.out ?? join(source, 'dist')); await mkdir(out, { recursive: true });
  const entries = new Map();
  for (const name of ['.codex-plugin/plugin.json', 'hooks/hooks.json', 'skills/evolveflow-companion', 'src', 'package.json', 'README.md', 'README-EN.md']) await add(entries, source, name);
  for (const name of ['LICENSE', 'doc', 'tools/install.mjs', 'tools/install-user.mjs', 'tools/doctor.mjs', 'tools/hook-command.mjs']) await add(entries, source, name, name, false);
  const path = join(out, 'only-one-mistake.zip'); await writeFile(path, zip(entries));
  console.log(JSON.stringify({ artifacts: [{ path, files: entries.size, scope: 'A-only' }] }, null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
