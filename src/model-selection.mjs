// Named model selection for the scoped state machine. This module is deliberately
// independent of agents.mjs: the durable agent registry keeps its old provider/model
// resolution, while scoped names accept a model ID or substring plus an optional effort.
//
// DSH's live catalog (session/modelCatalog) has this shape:
//   {
//     default: { provider, model, reasoningEffort? },
//     routableProviders: [providerId, ...],
//     groups: [{ id: providerId, models: [{
//       id, name, reasoning?: { efforts: [{ id, name }], defaultEffort? }
//     }] }]
//   }
// Older fixtures and adapters may expose `reasoningEfforts: ['high']` instead of
// `reasoning.efforts`; both are accepted, so a catalog is read the same way everywhere.

const text = value => typeof value === 'string' ? value.trim() : '';
const modelId = model => text(model?.id) || text(model?.model);
const providerId = group => text(group?.id) || text(group?.provider);

const failure = (code, message, details = {}) => Object.assign(new Error(message), { code, ...details });

function groupsOf(catalog) {
  const groups = Array.isArray(catalog?.groups) ? catalog.groups : [];
  const routable = Array.isArray(catalog?.routableProviders)
    ? new Set(catalog.routableProviders.filter(provider => typeof provider === 'string'))
    : undefined;
  return groups.filter(group => group && Array.isArray(group.models) && group.models.length > 0
    && (!routable || routable.has(providerId(group))));
}

function entriesOf(catalog) {
  const entries = [];
  for (const group of groupsOf(catalog)) {
    for (const model of group.models) {
      const id = modelId(model);
      if (id) entries.push({ provider: providerId(group), model, id });
    }
  }
  return entries;
}

/** A model's advertised efforts, normalized to objects with a string `id`. */
function modelEfforts(model) {
  const efforts = model?.reasoning?.efforts ?? model?.reasoningEfforts;
  if (!Array.isArray(efforts)) return [];
  return efforts
    .map(effort => typeof effort === 'string' ? { id: effort } : effort)
    .filter(effort => text(effort?.id));
}

/** The model's own default effort, when the catalog advertises one. */
function modelDefaultEffort(model) {
  return text(model?.reasoning?.defaultEffort) || text(model?.defaultEffort) || undefined;
}

/**
 * Compact catalog view shared with `futureaide_status`.
 * Models are listed in catalog order (provider groups, then each group's models),
 * without duplicates; `defaultModel` is the full default ID or null.
 * @param {object} catalog Raw target catalog.
 * @returns {{models: string[], defaultModel: string|null}}
 */
export function modelCatalogSummary(catalog) {
  const models = [];
  for (const entry of entriesOf(catalog)) {
    if (!models.includes(entry.id)) models.push(entry.id);
  }
  const fallback = catalog?.default?.model
    ?? (typeof catalog?.defaultModel === 'string' ? catalog.defaultModel : catalog?.defaultModel?.model);
  return { models, defaultModel: text(fallback) || null };
}

/**
 * Find one catalog entry by full ID or substring.
 * Matching is case-insensitive. An exact ID wins over every substring; when several
 * entries match a substring, the first in catalog order wins. A miss reports the
 * available full IDs so the caller can correct the request without guessing.
 */
function findCatalogModel(catalog, query) {
  const wanted = text(query);
  const available = modelCatalogSummary(catalog).models;
  if (!wanted) {
    throw failure('model-required', available.length
      ? `A model ID or substring is required. Available model IDs: ${available.join(', ')}.`
      : 'A model ID or substring is required; the target catalog lists no models.', { availableModels: available });
  }
  const entries = entriesOf(catalog);
  const lower = wanted.toLowerCase();
  const exact = entries.find(entry => entry.id.toLowerCase() === lower);
  if (exact) return exact;
  const partial = entries.find(entry => entry.id.toLowerCase().includes(lower));
  if (partial) return partial;
  throw failure('model-not-found', available.length
    ? `Unknown model "${wanted}". Available model IDs: ${available.join(', ')}.`
    : `Unknown model "${wanted}". The target catalog lists no available model IDs.`, { availableModels: available });
}

/** Canonical effort ID advertised by this model, or a clear refusal. */
function resolveCatalogEffort(model, effort) {
  const wanted = text(effort);
  const efforts = modelEfforts(model);
  const available = efforts.map(item => text(item.id));
  const exact = wanted ? efforts.find(item => text(item.id).toLowerCase() === wanted.toLowerCase()) : undefined;
  if (!exact) {
    throw failure('effort-not-supported', available.length
      ? `Model "${modelId(model)}" does not support reasoning effort "${wanted}". Supported efforts: ${available.join(', ')}.`
      : `Model "${modelId(model)}" does not advertise any reasoning effort.`, { availableEfforts: available });
  }
  return text(exact.id);
}

function copySelection(selection) {
  if (!selection || typeof selection.model !== 'string' || !selection.model) return undefined;
  return {
    provider: text(selection.provider),
    model: text(selection.model),
    ...(text(selection.reasoningEffort) ? { reasoningEffort: text(selection.reasoningEffort) } : {}),
  };
}

/**
 * Resolve a requested selection against a live catalog.
 *
 * - `model` plus optional `effort`: find the model, validate the effort, and use the
 *   model's advertised default effort when `effort` is omitted.
 * - `effort` alone: only valid when this name already has an explicit pin; the pin's
 *   model is the one validated. This deliberately never falls back to the current
 *   host default, because doing so would turn "follow the default" into a new pin.
 * - neither: return the existing pin (for freezing later dispatches), or undefined.
 *
 * @param {object} catalog Raw target catalog.
 * @param {{model?: string, effort?: string}} input Caller's request.
 * @param {{pinned?: object}} [options] Existing explicit selection for this name.
 * @returns {{provider: string, model: string, reasoningEffort?: string}|undefined}
 */
export function resolveModelSelection(catalog, input = {}, { pinned } = {}) {
  const hasModel = input.model !== undefined && input.model !== null;
  const hasEffort = input.effort !== undefined && input.effort !== null;
  const existing = copySelection(pinned);
  if (!hasModel && !hasEffort) return existing;

  if (!hasModel) {
    if (!existing) {
      throw failure('model-required-for-effort',
        'Provide model together with effort: this name has no explicitly selected model yet. An effort alone cannot be based on the host default.');
    }
    const entry = entriesOf(catalog).find(item => item.id.toLowerCase() === existing.model.toLowerCase()
      && (!existing.provider || item.provider === existing.provider));
    if (!entry) {
      const available = modelCatalogSummary(catalog).models;
      throw failure('model-not-found', available.length
        ? `The selected model "${existing.model}" is no longer available. Provide model together with effort. Available model IDs: ${available.join(', ')}.`
        : `The selected model "${existing.model}" is no longer available; the target catalog lists no models.`, { availableModels: available });
    }
    return {
      provider: entry.provider || existing.provider,
      model: entry.id,
      reasoningEffort: resolveCatalogEffort(entry.model, input.effort),
    };
  }

  const entry = findCatalogModel(catalog, input.model);
  const effort = hasEffort ? resolveCatalogEffort(entry.model, input.effort) : modelDefaultEffort(entry.model);
  return {
    provider: entry.provider,
    model: entry.id,
    ...(effort ? { reasoningEffort: effort } : {}),
  };
}

/** True when two selections name the same provider, model and effort. */
export function sameModelSelection(left, right) {
  if (!left || !right) return false;
  return text(left.provider) === text(right.provider)
    && text(left.model) === text(right.model)
    && (text(left.reasoningEffort) || undefined) === (text(right.reasoningEffort) || undefined);
}

/** Full model ID for a persisted display value, or null when it is not known yet. */
export function actualModelName(value) {
  if (typeof value === 'string') return text(value) || null;
  return text(value?.model) || null;
}
