import { isRecord } from '../utils/object-utils.js';
function normalizeModel(id, raw) {
    // The internal contract uses modality families, not V2's MIME subtypes.
    const modalities = (values) => [
        ...new Set(values.map((value) => (value === 'application/pdf' ? 'pdf' : value.split('/')[0]))),
    ];
    const input = modalities(raw.modalities.input);
    return {
        id,
        name: raw.name,
        ...(raw.description !== undefined ? { description: raw.description } : {}),
        ...(raw.family !== undefined ? { family: raw.family } : {}),
        ...(raw.status !== undefined ? { status: raw.status } : {}),
        ...(raw.release_date !== undefined ? { release_date: raw.release_date } : {}),
        ...(raw.last_updated !== undefined ? { last_updated: raw.last_updated } : {}),
        ...(raw.knowledge !== undefined ? { knowledge: raw.knowledge } : {}),
        ...(raw.open_weights !== undefined ? { open_weights: raw.open_weights } : {}),
        modalities: { input, output: modalities(raw.modalities.output) },
        attachment: input.some((value) => value !== 'text'),
        tool_call: raw.capabilities.tools.supported,
        reasoning: raw.capabilities.reasoning.supported,
        ...(raw.capabilities.structured_output !== undefined
            ? { structured_output: raw.capabilities.structured_output }
            : {}),
        ...(raw.capabilities.temperature !== undefined
            ? { temperature: raw.capabilities.temperature }
            : {}),
        ...(raw.limit
            ? {
                limit: {
                    ...(raw.limit.context !== undefined ? { context: raw.limit.context } : {}),
                    ...(raw.limit.output !== undefined ? { output: raw.limit.output } : {}),
                },
            }
            : {}),
    };
}
/** Add missing provider/model keys only; never change a V1 provider or model's fields. */
export function supplementWithV2(v1, v2) {
    if (!isRecord(v2))
        throw new Error('Invalid models.dev V2 provider dictionary');
    const source = { ...v1 };
    const warnings = [];
    for (const [providerId, provider] of Object.entries(v2)) {
        if (!isRecord(provider) || typeof provider.name !== 'string' || !isRecord(provider.models)) {
            throw new Error(`Invalid models.dev V2 provider: ${providerId}`);
        }
        const existing = v1[providerId];
        const models = { ...existing?.models };
        const omittedPrices = [];
        for (const [modelId, raw] of Object.entries(provider.models)) {
            if (existing?.models[modelId])
                continue;
            if (!isRecord(raw) ||
                typeof raw.name !== 'string' ||
                !isRecord(raw.modalities) ||
                !Array.isArray(raw.modalities.input) ||
                !Array.isArray(raw.modalities.output) ||
                !isRecord(raw.capabilities) ||
                !isRecord(raw.capabilities.tools) ||
                !isRecord(raw.capabilities.reasoning)) {
                throw new Error(`Invalid models.dev V2 model: ${providerId}/${modelId}`);
            }
            models[modelId] = normalizeModel(modelId, raw);
            // V2 prices include modality-specific units, tiers and cache TTLs. Import metadata
            // independently; existing local cost overrides can still provide supported pricing.
            if (raw.cost !== undefined)
                omittedPrices.push(modelId);
        }
        source[providerId] = existing
            ? { ...existing, models }
            : {
                id: providerId,
                name: provider.name,
                ...(typeof provider.doc === 'string' ? { doc: provider.doc } : {}),
                models,
            };
        if (omittedPrices.length)
            warnings.push(`pricing: models.dev V2 prices not imported for ${providerId}: ${omittedPrices.join(', ')}; metadata retained; use local cost overrides for pricing`);
    }
    return { source, warnings };
}
//# sourceMappingURL=models-dev-v2.js.map