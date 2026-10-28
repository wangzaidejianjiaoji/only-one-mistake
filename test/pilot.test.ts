import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

test('code-review pilot captures a real regression, verification and immediate method reuse', () => {
  const dir = mkdtempSync(join(tmpdir(), 'evolveflow pilot '));
  try {
    const r = spawnSync(process.execPath, [resolve('tools/pilot.mjs'), '--out', dir], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const result = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8'));
    assert.equal(result.baseline.exitCode, 1);
    assert.equal(result.fixed.exitCode, 0);
    assert.equal(result.reused.exitCode, 0);
    assert.equal(result.memory.status, 'active');
    assert.equal(result.problemState, 'applied');
    assert.equal(result.nativeHookTriggering, 'not_tested');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
