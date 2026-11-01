import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PACK_CATALOG } from '../packs/catalog.ts';
import { parsePack } from '../packs/packs.ts';

test('packs: the catalog parses as packs and every OpenAPI connector is https', () => {
  assert.ok(PACK_CATALOG.length >= 3);
  for (const pack of PACK_CATALOG) {
    const parsed = parsePack(JSON.stringify(pack));
    assert.equal(parsed.id, pack.id);
    assert.equal(parsed.workflows?.length, pack.workflows?.length);
    for (const connector of pack.connectors ?? []) {
      assert.match(String((connector.openapi.servers as Array<{ url: string }>)[0]!.url), /^https:\/\//);
    }
  }
  assert.equal(new Set(PACK_CATALOG.map((pack) => pack.id)).size, PACK_CATALOG.length);
});

test('packs: malformed pack files are refused with a reason', () => {
  const base = { format: 1, id: 'demo', name: 'Demo', description: 'Demo pack' };
  assert.throws(() => parsePack('{ nope'), /not valid JSON/);
  assert.throws(() => parsePack('[]'), /JSON object/);
  assert.throws(() => parsePack(JSON.stringify({ ...base, format: 2 })), /unknown pack format/);
  assert.throws(() => parsePack(JSON.stringify({ ...base, id: 'Bad Id' })), /"id"/);
  assert.throws(() => parsePack(JSON.stringify({ ...base, description: '' })), /required/);
  assert.throws(() => parsePack(JSON.stringify({ ...base, agents: [{ name: 'overseer' }] })), /agents\[0\]: invalid name/);
  assert.throws(() => parsePack(JSON.stringify({ ...base, agents: Array.from({ length: 9 }, (_, index) => ({ name: `a${index}` })) })), /at most 8 agents/);
  assert.throws(() => parsePack(JSON.stringify({ ...base, connectors: [{ key: 'x' }] })), /"openapi"/);
  assert.throws(() => parsePack(JSON.stringify({ ...base, workflows: [{ name: 'w', agent: 'mimi', nodes: [] }] })), /trigger/);
  // Credential links other than plain https are dropped, the item stays.
  const parsed = parsePack(JSON.stringify({ ...base, credentials: [{ kind: 'secret', key: 'K', label: 'Key', url: 'javascript:alert(1)' }, { kind: 'nope', key: 'x', label: 'x' }] }));
  assert.deepEqual(parsed.credentials, [{ kind: 'secret', key: 'K', label: 'Key' }]);
});
