import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { supplementWithV2 } from '../dist/services/models-dev-v2.js';
import { NewApiBuilder } from '../dist/services/newapi-builder.js';
import { defaultDeployment } from '../dist/billing/deployment.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/models-dev-v2.json', import.meta.url)));
test('V2 metadata keeps shared-model provider priority and normalizes MIME families', () => {
  const raw = fixture.openai.models['gpt-image-2.5-flare'];
  raw.modalities.input.push('application/pdf', 'audio/wav');
  const { source } = supplementWithV2({}, fixture);
  const model = source.openai.models['gpt-image-2.5-flare'];
  assert.deepEqual(model.modalities.input, ['text', 'image', 'pdf', 'audio']);
  assert.deepEqual(model.limit, { context: 0, output: 0 });
  assert.equal(model.reasoning, false);
  assert.equal(model.tool_call, false);
  const builder = new NewApiBuilder(defaultDeployment({}), {});
  const providers = {
    openai: { ...source.openai, billing: { priority: 10 } },
    alternate: { ...source.openai, id: 'alternate', name: 'Alternate', billing: { priority: 20 } },
  };
  const payload = builder.buildSyncPayload({ providers });
  assert.equal(payload.models.length, 1);
  assert.equal(payload.models[0].vendor_name, 'Alternate');
  assert.equal(payload.models[0].model_name, 'gpt-image-2.5-flare');
});
