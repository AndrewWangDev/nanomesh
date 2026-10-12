// src/orchestration/scoring.ts
import { Env } from "../types";
import { ModelMetadata, ScoredModel } from "./types";

/**
 * Computes Cosine Similarity between two L2-normalized float vectors
 */
export function cosineSimilarity(vecA: number[], vecB: number[]): number {
  if (!vecA || !vecB || vecA.length !== vecB.length || vecA.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dot += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Generate embedding using @cf/baai/bge-m3 via Workers AI
 */
export async function generatePromptEmbedding(env: Env, text: string): Promise<number[] | null> {
  try {
    if (env.AI) {
      const res = await env.AI.run('@cf/baai/bge-m3', { text: [text.slice(0, 500)] });
      if (res && Array.isArray(res.data) && res.data[0]) {
        return res.data[0];
      }
    }
  } catch (err) {
    console.warn("bge-m3 embedding failed, falling back to keyword heuristics:", err);
  }
  return null;
}

/**
 * Step 3: Ultimate Scoring Formula & Traffic Shaping
 * 
 * Formula:
 * S = μ0 + α * max(0, sim - τ) + β * (Rm / 5) - γ * (C_active / C_max)^2
 * 
 * Parameters:
 * - μ0: Generalist prior (0.25 for generalist, 0.0 for specialist)
 * - α: 0.50 (Specialist boost)
 * - τ: 0.65 (Gating threshold)
 * - β: 0.25 (User rating weight)
 * - γ: 0.40 (Quadratic congestion penalty)
 */
export async function scoreAndRankRoleModels(
  env: Env,
  roleModels: ModelMetadata[],
  promptEmbedding: number[] | null,
  rawPrompt: string
): Promise<ScoredModel[]> {
  const ALPHA = 0.50;
  const TAU = 0.65;
  const BETA = 0.25;
  const GAMMA = 0.40;

  const scoredList: ScoredModel[] = [];

  for (const model of roleModels) {
    // 1. Generalist Prior
    const mu0 = model.is_generalist ? (model.prior_score || 0.25) : 0.0;

    // 2. Scenario Anchor Similarity (sim)
    // Strictly computed via vector cosine similarity between prompt embedding and model anchor embeddings
    let maxSim = 0.0;
    if (promptEmbedding && model.anchor_embeddings && model.anchor_embeddings.length > 0) {
      for (const anchorVec of model.anchor_embeddings) {
        if (Array.isArray(anchorVec) && anchorVec.length > 0) {
          const sim = cosineSimilarity(promptEmbedding, anchorVec);
          if (sim > maxSim) maxSim = sim;
        }
      }
    }

    // 3. Specialist gated score
    const specialistScore = ALPHA * Math.max(0, maxSim - TAU);

    // 4. Rating score: β * (Rm / 5)
    const ratingScore = BETA * (Math.min(5, Math.max(0, model.user_rating || 4.5)) / 5);

    // 5. Quadratic concurrency penalty: -γ * (C_active / C_max)^2
    const maxC = model.max_concurrency > 0 ? model.max_concurrency : 50;
    const loadRatio = Math.min(1.0, model.active_connections / maxC);
    const concurrencyPenalty = GAMMA * Math.pow(loadRatio, 2);

    // Final Score
    const totalScore = mu0 + specialistScore + ratingScore - concurrencyPenalty;

    scoredList.push({
      model,
      score: totalScore,
      sim: maxSim,
      concurrency_penalty: concurrencyPenalty,
      specialist_score: specialistScore
    });
  }

  // Sort descending by score
  scoredList.sort((a, b) => b.score - a.score);
  return scoredList;
}
