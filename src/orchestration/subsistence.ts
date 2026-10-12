// src/orchestration/subsistence.ts
import { DAGTemplate, ModelMetadata } from "./types";

/**
 * Step 1: Hard Filtering for Models
 * Drops models with user rating < 1.0, active concurrency > 300 or at capacity, or insufficient context window
 */
export function hardFilterModels(
  models: ModelMetadata[],
  estimatedTokens: number = 512,
  disableBrowser: boolean = false
): ModelMetadata[] {
  return models.filter(m => {
    // 0. Disable browser inference filter
    if (disableBrowser && m.inference_target === 'browser') return false;

    // 1. Rating check: Rm >= 1.0
    if (m.user_rating < 1.0) return false;

    // 2. Concurrency check: active <= 300 and active < max
    if (m.active_connections > 300 || m.active_connections >= m.max_concurrency) return false;

    // 3. Context window check
    if (m.context_window < estimatedTokens) return false;

    // 4. Status active
    if (m.status !== 'active') return false;

    return true;
  });
}

/**
 * Step 1: Subsistence Law (温饱定律) for DAG Templates
 * 
 * Formula:
 * { Head Node In-Modalities } ⊆ A_user ⊆ { Head Node In-Modalities } ∪ { Tail Node In-Modalities }
 * 
 * In Single-Node DAG (in=0 and out=0):
 * Head == Tail == N, so N_in ⊆ A_user ⊆ N_in, which mathematically forces A_user ≡ N_in!
 */
export function filterTemplatesBySubsistence(
  templates: DAGTemplate[],
  userModalities: string[]
): DAGTemplate[] {
  const userModalitySet = new Set(userModalities.length ? userModalities : ['text']);

  return templates.filter(tpl => {
    if (tpl.status !== 'active') return false;

    const headSet = new Set(tpl.head_modalities);
    const tailSet = new Set(tpl.tail_modalities);
    const combinedSet = new Set([...tpl.head_modalities, ...tpl.tail_modalities]);

    // Check single-node DAG case
    const isSingleNode = tpl.roles.length === 1 && tpl.roles[0].in_degree === 0 && tpl.roles[0].out_degree === 0;
    if (isSingleNode) {
      const singleInSet = new Set(tpl.roles[0].in_modalities);
      // Must be exact equivalence: A_user ≡ N_in
      if (userModalitySet.size !== singleInSet.size) return false;
      for (const m of userModalitySet) {
        if (!singleInSet.has(m)) return false;
      }
      return true;
    }

    // 1. Condition A: { Head Node In-Modalities } ⊆ A_user
    // Every modality that the head node requires must be present in user assets
    for (const m of headSet) {
      if (!userModalitySet.has(m)) return false;
    }

    // 2. Condition B: A_user ⊆ { Head Node In-Modalities } ∪ { Tail Node In-Modalities }
    // User assets cannot contain orphan modalities that neither head nor tail can accept
    for (const m of userModalitySet) {
      if (!combinedSet.has(m)) return false;
    }

    return true;
  });
}
