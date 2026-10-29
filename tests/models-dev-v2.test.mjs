import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { supplementWithV2 } from '../dist/services/models-dev-v2.js';
import { loadCatalog, catalogPaths } from '../dist/services/catalog.js';
import { NewApiBuilder } from '../dist/services/newapi-builder.js';
import { defaultDeployment } from '../dist/billing/deployment.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/models-dev-v2.json', import.meta.url)));
const flare = 'gpt-image-2.5-flare';
const v1 = {
  openai: {
    id: 'openai',
    name: 'OpenAI',
    api: 'https://example.test',
    models: {
      legacy: {
        id: 'legacy',
        name: 'Legacy',
        description: 'Original',
        cost: { input: 1, output: 2 },
      },
    },
  },
};
const builder = new NewApiBuilder(defaultDeployment({}), {});

test('V1 wins entire provider fields and duplicate model, V2 keys remain invocation IDs', () => {
  const v2 = structuredClone(fixture);
  v2.openai.models.legacy = v2.openai.models[flare];
  v2.openai.models['path/model'] = v2.openai.models[flare];
  const { source, warnings } = supplementWithV2(v1, v2);
  assert.deepEqual(source.openai.models.legacy, v1.openai.models.legacy);
  assert.equal(source.openai.api, v1.openai.api);
  assert.equal(source.openai.models['path/model'].id, 'path/model');
  assert.equal(source.openai.models[flare].name, 'GPT Image 2.5 Flare');
  assert.deepEqual(source.openai.models[flare].modalities, {
    input: ['text', 'image'],
    output: ['image'],
  });
  assert.equal(source.openai.models[flare].cost, undefined);
  assert.match(warnings.join('\n'), /V2 prices not imported/);
  assert.equal(v1.openai.models[flare], undefined);
});

test('catalog load → overrides → native filter → en/zh/ja → NewAPI; isolated caches and visible failures', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'llm-v2-'));
  // This exact path was created by this test, never a user-provided cleanup path.
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const save = (path, data) => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), JSON.stringify(data));
  };
  save('data/native-providers.json', {
    version: 1,
    providers: { openai: { lobeIcon: 'OpenAI', excludeModels: ['^excluded$'] } },
  });
  save('data/overrides/models/openai/override.json', {
    name: 'Local wins',
    cost: { input: 2, output: 3 },
  });
  save('data/overrides/i18n/models/openai/override.json', {
    description: { en: 'English', zh: '中文', ja: '日本語' },
  });
  const v2 = structuredClone(fixture);
  for (const id of ['override', 'excluded', 'no-price'])
    v2.openai.models[id] = structuredClone(v2.openai.models[flare]);
  delete v2.openai.models['no-price'].cost;
  v2.aggregator = { ...v2.openai, id: 'aggregator', name: 'Aggregator' };
  const fetchOriginal = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = fetchOriginal;
  });
  globalThis.fetch = async (url) => ({
    ok: true,
    json: async () => structuredClone(url.includes('/experimental/') ? v2 : v1),
  });
  const catalog = await loadCatalog(catalogPaths(root));
  assert.equal(catalog.data.providers.aggregator, undefined);
  assert.equal(catalog.data.providers.openai.models.excluded, undefined);
  assert.equal(catalog.data.providers.openai.models.override.name, 'Local wins');
  assert.deepEqual(catalog.data.providers.openai.models.override.cost, { input: 2, output: 3 });
  assert.equal(
    JSON.parse(readFileSync(join(root, '.cache/api.json'))).openai.models[flare],
    undefined,
  );
  assert.ok(JSON.parse(readFileSync(join(root, '.cache/api-v2.json'))).openai.models[flare]);
  for (const locale of ['en', 'zh', 'ja']) {
    const localized = catalog.processor.localizeNormalizedData(
      catalog.data,
      catalog.overrides,
      locale,
    );
    const payload = builder.buildSyncPayload(localized.data, { vision: 'Vision' });
    assert.deepEqual(
      payload.models.find((m) => m.model_name === flare),
      {
        model_name: flare,
        description: fixture.openai.models[flare].description,
        tags: 'files,Vision',
        vendor_name: 'OpenAI',
        endpoints: null,
        status: 1,
        name_rule: 0,
        icon: 'OpenAI',
      },
    );
    assert.equal(
      payload.models.find((m) => m.model_name === 'override').description,
      { en: 'English', zh: '中文', ja: '日本語' }[locale],
    );
    assert.ok(payload.models.some((m) => m.model_name === 'no-price'));
    assert.deepEqual(
      payload.models.find((m) => m.model_name === 'legacy'),
      builder.buildSyncPayload({ providers: { openai: { ...v1.openai, lobeIcon: 'OpenAI' } } })
        .models[0],
    );
  }
  globalThis.fetch = async () => {
    throw new Error('offline fixture');
  };
  assert.ok((await loadCatalog(catalogPaths(root))).data.providers.openai.models[flare]);
  const emptyRoot = join(root, 'without-cache');
  await assert.rejects(loadCatalog(catalogPaths(emptyRoot)), /offline fixture/);
  globalThis.fetch = async (url) => {
    if (url.includes('/experimental/')) throw new Error('V2 unavailable');
    return { ok: true, json: async () => v1 };
  };
  await assert.rejects(loadCatalog(catalogPaths(emptyRoot)), /V2 unavailable/);
  writeFileSync(join(root, '.cache/api-v2.json'), 'invalid');
  globalThis.fetch = async () => {
    throw new Error('offline');
  };
  await assert.rejects(loadCatalog(catalogPaths(root)), SyntaxError);
});

test('invalid V2 envelope fails instead of silently succeeding with incomplete data', () => {
  assert.throws(() => supplementWithV2(v1, { providers: {} }), /Invalid/);
});
