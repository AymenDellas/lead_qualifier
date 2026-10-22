import test from 'node:test';
import assert from 'node:assert/strict';
import { packSavedProject, unpackSavedProject } from '../../src/lib/copy-studio/shared/saved-projects';
import { fingerprint, projectSchema } from '../../src/lib/copy-studio/shared/contracts';
import { input, draft } from './fixtures';

const project = () => {
  const source = { source: { title: 'Original page', url: 'https://coach.example', headings: [], text: 'Original page copy. '.repeat(12_000) },
    extraction: { fields: {}, evidence: [], warnings: [] } };
  const saved = projectSchema.parse({ id: 'storage-test', name: 'Example', updatedAt: '', ...input,
    source, result: { draft, issues: [] }, generatedFrom: null, history: [] });
  saved.generatedFrom = fingerprint(saved);
  saved.history = Array.from({ length: 8 }, () => ({ result: { draft, issues: [] }, generatedFrom: saved.generatedFrom }));
  return saved;
};

test('saved references are stored once while all drafts and history round-trip exactly', () => {
  const original = project();
  const packed = packSavedProject(original);
  assert.ok(JSON.stringify(packed).length < JSON.stringify(original).length / 4);
  const restored = unpackSavedProject(projectSchema.parse(JSON.parse(JSON.stringify(packed))));
  assert.deepEqual(restored, original);
  assert.equal(original.generatedFrom, fingerprint(original));
  assert.equal(packed.history.length, 8);
});

test('old source snapshots and legacy fingerprints stay intact when a project source changes', () => {
  const original = project();
  original.source!.source.text += 'Changed source';
  const packed = packSavedProject(original);
  assert.equal(packed.generatedFrom, original.generatedFrom);
  assert.deepEqual(unpackSavedProject(packed), original);
  assert.deepEqual(unpackSavedProject(original), original);
});

test('a broken saved reference fails safely rather than silently changing draft provenance', () => {
  const packed = packSavedProject(project());
  assert.throws(() => unpackSavedProject({ ...packed, source: null }), /could not be restored/);
});
