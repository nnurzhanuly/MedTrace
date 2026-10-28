import {test} from 'node:test';
import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {resolve} from 'node:path';

const root = resolve(import.meta.dirname, '..');
const read = path => readFileSync(resolve(root, path), 'utf8');
const demo = JSON.parse(read('src/data/demo.json'));
const traces = JSON.parse(read('src/data/traces.json'));

test('site is a static export without authentication or API routes', () => {
  assert.match(read('next.config.ts'), /output:\s*'export'/);
  assert.equal(existsSync(resolve(root, 'src/app/api')), false);
  assert.equal(existsSync(resolve(root, 'src/lib/auth.ts')), false);
  assert.equal(existsSync(resolve(root, 'src/lib/db.ts')), false);
  assert.doesNotMatch(read('src/components/App.tsx'), /fetch\s*\(|\/api\/|login|logout|password/i);
});

test('demo lineage links source material, finished lots and buyers', () => {
  const result = traces['RM-2026-000001'];
  assert.equal(result.kind, 'material');
  assert.equal(result.lot.code, 'RM-2026-000001');
  assert.ok(result.descendants.length >= 2);
  assert.ok(result.shipments.length >= 2);
  assert.ok(demo.lots.some(lot => lot.code === result.descendants[0].code));
});

test('published fixture has no credentials or private file paths', () => {
  const text = JSON.stringify({demo, traces});
  assert.doesNotMatch(text, /password_hash|SESSION_SECRET|SUPABASE_|DATABASE_URL|storage_path|public_token/i);
  assert.equal(Array.isArray(demo.users), false);
  assert.equal(Array.isArray(demo.audit), false);
});
