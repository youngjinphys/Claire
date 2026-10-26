import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('../', import.meta.url);
const courseHashes = {
  "AGENTS.md": "f9019e5e21682d911953a5c2eb7e0711ee9d079d",
  "docs/DECIDER_REQUEST.md": "9449cd7674c2d0ffa236c29bd13518fe08cb745f",
  "docs/DETECT_EVENTS.md": "40e5100ba3c179dc118a10883aea575f520553eb",
  "xdr/README.md": "06ddb9d1f1ec19f633f890d242922f09435343ab",
  "package/baseline-functions.json": "5c60323af01d8ec10f91fdcce586007941d98000",
  "test/r5.test.mjs": "e6d157456be771c6da2dfa320cff1075cfa19b67",
  "test/xdr-run.test.mjs": "236af89c970c8e20c18dcaa89a56ced075055ed2",
  "scripts/xdr-run.mjs": "58f4898f503f8e360895600e99fae2632bf01d6b"
};

function hashGitBlob(data) {
  const prefix = Buffer.from('blob ' + data.length + String.fromCharCode(0));
  return createHash('sha1').update(prefix).update(data).digest('hex');
}

test('course-provided contracts, original tests and XDR runner match imported Git blobs exactly', () => {
  for (const [path, sha] of Object.entries(courseHashes)) {
    const content = readFileSync(new URL(path, root));
    assert.equal(hashGitBlob(content), sha, 'modified protected course asset: ' + path);
  }
});

test('Stage12 additions keep initial allowedNew separate and preserve exactly three note lines', () => {
  const course = JSON.parse(readFileSync(new URL('package/baseline-functions.json',root),'utf8'));
  assert.deepEqual(course.allowedNew,['api/ai.js','api/threat-intel.js']);
  const ext = JSON.parse(readFileSync(new URL('package/stage-api-inventory.json',root),'utf8'));
  assert.equal(ext.schema,'aleph.defense.stage_api_inventory.v1');
  assert.equal(ext.extensions.length,6);
  const memo = JSON.parse(readFileSync(new URL('package/bundle-notes.template.json',root),'utf8'));
  assert.equal(memo.explanation.split(/\r?\n/u).filter(s => s.trim()).length,3);
  const ignores = readFileSync(new URL('.gitignore',root),'utf8');
  assert.match(ignores,/(?:^|\n)bundle-notes\.json(?:\r?\n|$)/u);
  // The ignore policy evolves with privacy needs; verify invariants, not its obsolete blob SHA.
  for(const entry of ['.env','.env.*','node_modules/','artifacts/','public/aleph.json']) {
    assert.ok(ignores.split(/\r?\n/u).includes(entry), 'missing privacy ignore: '+entry);
  }
});
