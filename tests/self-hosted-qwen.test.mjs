import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { DataLoader } from '../dist/services/data-loader.js';
import { DataProcessor } from '../dist/services/data-processor.js';
import { I18nService } from '../dist/services/i18n-service.js';
import { NativeFilter } from '../dist/services/native-filter.js';
import { NewApiBuilder } from '../dist/services/newapi-builder.js';
import { defaultDeployment } from '../dist/billing/deployment.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const freeBaseIds = ['qwen3.5-2b', 'qwen3.5-4b', 'qwen3.5-9b'];
const freeCost = { currency: 'USD', input: 0, output: 0, cache_read: 0, cache_write: 0 };
const presets = [
  ['qwen3.5-9b', 'q4', 131072, 'text'],
  ['qwen3.5-4b', 'q4', 8192, 'text'],
  ['qwen3.5-2b', 'q4', 8192, 'text'],
  ['qwen3-embedding-0.6b', 'q8', 2048, 'embedding'],
  ['qwen3-reranker-0.6b', 'q8', 2048, 'reranking'],
];

// Exercise real overrides and localization without fetching upstream data or writing caches.
test('self-hosted Qwen metadata survives native filtering and en/zh/ja New API output', () => {
  const loader = new DataLoader(join(root, 'data'), join(root, '.cache'));
  const allOverrides = loader.loadOverrides();
  const ids = presets.flatMap(([base, suffix]) => [base, `${base}-${suffix}`]);
  const overrides = {
    models: Object.fromEntries(ids.map((id) => {
      const key = `alibaba/${id}`;
      assert.ok(allOverrides.models[key], `missing override: ${key}`);
      return [key, allOverrides.models[key]];
    })),
    i18n: allOverrides.i18n,
  };
  const processor = new DataProcessor(new I18nService(root));
  const normalized = processor.mapSourceToNormalized({
    alibaba: { id: 'alibaba', name: 'Alibaba', models: {} },
  });
  const processed = processor.processAllData(normalized, overrides, new Set(['alibaba']));
  const filtered = new NativeFilter(loader.loadNativeProviders()).apply(processed).data;
  const models = filtered.providers.alibaba.models;
  assert.deepEqual(Object.keys(models).sort(), [...ids].sort());

  for (const [base, suffix, context, output] of presets) {
    const deployed = models[`${base}-${suffix}`];
    assert.deepEqual(deployed.limit, { context });
    assert.equal(models[base].limit, undefined, 'base ID must not assume preset limits');
    assert.deepEqual(models[base].cost, freeBaseIds.includes(base) ? freeCost : undefined,
      'Qwen3.5 base IDs must be free; other base ID pricing remains unspecified');
    assert.deepEqual(deployed.cost, freeCost, 'deployed presets must be explicitly free');
    for (const id of [base, `${base}-${suffix}`]) {
      assert.deepEqual(models[id].modalities, { input: ['text'], output: [output] });
      assert.equal(models[id].attachment, undefined, 'no vision deployment was supplied');
      for (const locale of ['en', 'zh', 'ja']) {
        assert.ok(overrides.i18n.models[`alibaba/${id}`].description[locale]);
      }
    }
  }
  // Explicit currency replaces the entire upstream price list, including paid tiers.
  const freeIds = [...freeBaseIds, ...presets.map(([base, suffix]) => `${base}-${suffix}`)];
  const paidSource = processor.mapSourceToNormalized({
    alibaba: {
      id: 'alibaba', name: 'Alibaba',
      models: Object.fromEntries(freeIds.map((id) => {
        return [id, { id, name: id, cost: {
          input: 1, output: 2, reasoning: 3, cache_read: 0.5, cache_write: 1,
          tiers: [{ context: 4096, input: 4, output: 8 }],
        } }];
      })),
    },
  });
  const repriced = processor.processAllData(paidSource, overrides, new Set(['alibaba']));
  for (const id of freeIds) {
    assert.deepEqual(repriced.providers.alibaba.models[id].cost, freeCost,
      'upstream prices must not leak into free models');
  }
  assert.equal(models['qwen3.5-9b-q4'].reasoning, true);
  for (const id of ['qwen3.5', 'qwen3-embedding', 'qwen3-reranker', 'gpt-image-2.5', 'codex-auto-review']) {
    assert.equal(models[id], undefined, `must not guess ambiguous model: ${id}`);
  }

  const builder = new NewApiBuilder(defaultDeployment({}), {});
  for (const locale of ['en', 'zh', 'ja']) {
    const localized = processor.localizeNormalizedData(filtered, overrides, locale);
    const payload = builder.buildSyncPayload(localized.data);
    assert.deepEqual(payload.models.map((m) => m.model_name).sort(), [...ids].sort());
    assert.deepEqual(payload.vendors.map((v) => v.name), ['Alibaba']);
    for (const model of payload.models) {
      assert.equal(model.vendor_name, 'Alibaba');
      assert.equal(model.icon, 'Qwen.Color');
      assert.equal(model.name_rule, 0);
      assert.equal(model.endpoints, null, 'metadata must not rewrite routing');
      assert.equal(model.description, overrides.i18n.models[`alibaba/${model.model_name}`].description[locale]);
    }
  }
});
