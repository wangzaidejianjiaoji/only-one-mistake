#!/usr/bin/env node
import { execute, parseArgs } from './install.mjs';
import { readFile, access } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';

try {
  const options = parseArgs(['check', ...process.argv.slice(2)]);
  if (options.target && isAbsolute(options.target)) {
    const manifest = await readFile(join(options.target, '.codex-plugin/plugin.json'), 'utf8').then(JSON.parse).catch(() => null);
    if (manifest?.name === 'evolveflow-companion') {
      const complete = await Promise.all(['src/cli.ts', 'skills'].map(name => access(join(options.target, name)).then(() => true, () => false)));
      if (complete.includes(false)) throw Error('Incomplete companion packaging template. Build or install dist/only-one-mistake.zip with its complete runtime.');
    }
  }
  const result = await execute(options);
  const receipt = JSON.parse(await readFile(join(options.target, '.evolveflow/install-receipt.json'), 'utf8'));
  console.log(JSON.stringify({ ...result, node: process.versions.node, node24: Number(process.versions.node.split('.')[0]) >= 24,
    skillDiscovery: receipt.mode === 'companion' ? 'not installed' : 'project .agents/skills files present',
    companion: receipt.mode === 'skills' ? 'not installed' : 'project .codex/hooks.json configured',
    hostCoverage: 'unknown until real host events are recorded',
    hookReview: 'Review exact definitions in host /hooks; doctor never grants trust.',
    cloudOrchestration: 'local command/plugin hooks unsupported',
    backgroundWorker: 'none; hooks run deterministic one-shot processing without model calls'
  }, null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
