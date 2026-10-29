import type { SourceData } from '../types/index.js';
/** Add missing provider/model keys only; never change a V1 provider or model's fields. */
export declare function supplementWithV2(v1: SourceData, v2: unknown): {
    source: SourceData;
    warnings: string[];
};
//# sourceMappingURL=models-dev-v2.d.ts.map