import test from 'node:test';
import assert from 'node:assert/strict';
import {
  actualModelName,
  modelCatalogSummary,
  resolveModelSelection,
  sameModelSelection,
} from '../src/model-selection.mjs';

function throws(action) {
  try { action(); } catch (error) { return error; }
  return assert.fail('expected a refusal');
}

const catalog = {
  default: { provider: 'openai', model: 'gpt-5', reasoningEffort: 'high' },
  routableProviders: ['openai', 'duplicate'],
  groups: [
    { id: 'openai', models: [
      { id: 'gpt-5', reasoning: { efforts: [{ id: 'low' }, { id: 'high' }], defaultEffort: 'high' } },
      { id: 'gpt-5-mini', reasoning: { efforts: [{ id: 'low' }, { id: 'medium' }] } },
      { id: 'o3', reasoningEfforts: ['low', 'high'] },
    ] },
    // A live DSH catalog can repeat a provider ID. Both groups stay in order.
    { id: 'duplicate', models: [{ id: 'gpt-5' }, { id: 'o3-pro' }] },
    { id: 'not-routable', models: [{ id: 'hidden-model' }] },
  ],
};

test('catalog summary keeps catalog order and reports the deployment default', () => {
  assert.deepEqual(modelCatalogSummary(catalog), {
    models: ['gpt-5', 'gpt-5-mini', 'o3', 'o3-pro'],
    defaultModel: 'gpt-5',
  });
  assert.deepEqual(modelCatalogSummary({}), { models: [], defaultModel: null });
  assert.deepEqual(modelCatalogSummary({ defaultModel: { provider: 'p', model: 'm' }, groups: [] }),
    { models: [], defaultModel: 'm' });
});

test('model matching is case-insensitive, exact first, then the first substring in catalog order', () => {
  assert.equal(resolveModelSelection(catalog, { model: 'GPT-5' }).model, 'gpt-5');
  assert.equal(resolveModelSelection(catalog, { model: 'O3' }).model, 'o3');
  assert.equal(resolveModelSelection(catalog, { model: 'mini' }).model, 'gpt-5-mini');
  assert.equal(resolveModelSelection(catalog, { model: 'gpt' }).model, 'gpt-5',
    'the first catalog match wins');
  assert.equal(resolveModelSelection(catalog, { model: 'pro' }).provider, 'duplicate',
    'a repeated provider ID does not collapse later groups');
});

test('unknown models list every selectable full ID', () => {
  const error = throws(() => resolveModelSelection(catalog, { model: 'does-not-exist' }));
  assert.equal(error.code, 'model-not-found');
  assert.match(error.message, /gpt-5, gpt-5-mini, o3, o3-pro/);
  assert.deepEqual(error.availableModels, ['gpt-5', 'gpt-5-mini', 'o3', 'o3-pro']);
  assert.equal(throws(() => resolveModelSelection({ groups: [] }, { model: 'x' })).code, 'model-not-found');
});

test('a selected model uses its advertised default effort; explicit effort is validated', () => {
  assert.deepEqual(resolveModelSelection(catalog, { model: 'gpt-5' }),
    { provider: 'openai', model: 'gpt-5', reasoningEffort: 'high' });
  assert.deepEqual(resolveModelSelection(catalog, { model: 'gpt-5', effort: 'LOW' }),
    { provider: 'openai', model: 'gpt-5', reasoningEffort: 'low' });
  assert.deepEqual(resolveModelSelection(catalog, { model: 'o3', effort: 'high' }),
    { provider: 'openai', model: 'o3', reasoningEffort: 'high' });
  const error = throws(() => resolveModelSelection(catalog, { model: 'gpt-5-mini', effort: 'max' }));
  assert.equal(error.code, 'effort-not-supported');
  assert.match(error.message, /low, medium/);
});

test('effort alone only refines an existing explicit pin', () => {
  assert.deepEqual(resolveModelSelection(catalog, { effort: 'high' },
    { pinned: { provider: 'openai', model: 'gpt-5', reasoningEffort: 'low' } }),
  { provider: 'openai', model: 'gpt-5', reasoningEffort: 'high' });
  const error = throws(() => resolveModelSelection(catalog, { effort: 'high' }));
  assert.equal(error.code, 'model-required-for-effort');
  assert.match(error.message, /host default/);
});

test('no request freezes the existing pin', () => {
  const pin = { provider: 'openai', model: 'o3-pro', reasoningEffort: 'high' };
  assert.deepEqual(resolveModelSelection(catalog, {}, { pinned: pin }), pin);
  assert.notEqual(resolveModelSelection(catalog, {}, { pinned: pin }), pin, 'returns a detached copy');
  assert.equal(resolveModelSelection(catalog, {}), undefined);
});

test('actualModelName reports only a full model ID', () => {
  assert.equal(actualModelName({ provider: 'p', model: 'full-id' }), 'full-id');
  assert.equal(actualModelName('full-id'), 'full-id');
  assert.equal(actualModelName({ provider: 'p' }), null);
  assert.equal(actualModelName(undefined), null);
  assert.equal(sameModelSelection({ provider: 'p', model: 'm' }, { provider: 'p', model: 'm' }), true);
  assert.equal(sameModelSelection({ provider: 'p', model: 'm', reasoningEffort: 'low' },
    { provider: 'p', model: 'm', reasoningEffort: 'high' }), false);
});
