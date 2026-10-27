// src/api/chat.ts
import { Env } from "../types";
import { getSession } from "../auth/middleware";
import { runOrchestrationPipeline, OrchestrationOptions } from "../orchestration/orchestrator";
import { executeDAGStream } from "../orchestration/dispatcher";
import { UnifiedProtocolEnvelope } from "../orchestration/types";

// --- Rate Limiting: In-Memory Sliding-Window Token Bucket ---
// Non-aggressive: Allows a burst of up to 3 requests, refills 1 token every 5 seconds (~12 req/min sustained).
interface RateLimitBucket {
  tokens: number;
  lastRefill: number; // timestamp ms
}

const RATE_LIMIT_CAPACITY = 3;
const REFILL_INTERVAL_MS = 5000;
const rateLimitMap = new Map<string, RateLimitBucket>();

function checkRateLimit(userId: string): { allowed: boolean; retryAfter: number } {
  const now = Date.now();
  let bucket = rateLimitMap.get(userId);

  if (!bucket) {
    bucket = { tokens: RATE_LIMIT_CAPACITY, lastRefill: now };
    rateLimitMap.set(userId, bucket);
  }

  // Refill tokens based on elapsed time
  const elapsed = now - bucket.lastRefill;
  if (elapsed >= REFILL_INTERVAL_MS) {
    const tokensToAdd = Math.floor(elapsed / REFILL_INTERVAL_MS);
    bucket.tokens = Math.min(RATE_LIMIT_CAPACITY, bucket.tokens + tokensToAdd);
    bucket.lastRefill = now - (elapsed % REFILL_INTERVAL_MS);
  }

  // Periodic pruning of stale records if map grows large (> 2000 entries)
  if (rateLimitMap.size > 2000) {
    const pruneThreshold = now - 60000;
    for (const [key, b] of rateLimitMap.entries()) {
      if (b.lastRefill < pruneThreshold) {
        rateLimitMap.delete(key);
      }
    }
  }

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return { allowed: true, retryAfter: 0 };
  } else {
    const msUntilRefill = REFILL_INTERVAL_MS - (now - bucket.lastRefill);
    const retryAfter = Math.max(1, Math.ceil(msUntilRefill / 1000));
    return { allowed: false, retryAfter };
  }
}

export async function handleChat(request: Request, env: Env): Promise<Response> {
  const session = await getSession(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { 
      status: 401, 
      headers: { "Content-Type": "application/json" } 
    });
  }

  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // 1. Sliding-Window Rate Limit Check (Non-aggressive Demo Protection)
  const rateLimit = checkRateLimit(session.userId);
  if (!rateLimit.allowed) {
    return new Response(JSON.stringify({ 
      error: "rate_limited", 
      retry_after: rateLimit.retryAfter,
      message: `请求过于频繁，请稍候 ${rateLimit.retryAfter} 秒后再试（Demo 环境保护）` 
    }), { 
      status: 429, 
      headers: { 
        "Content-Type": "application/json; charset=utf-8",
        "Retry-After": String(rateLimit.retryAfter)
      } 
    });
  }

  // 2. Quota Check & Atomic Reservation: Prevent concurrent TOCTOU overdraft
  const userRow = await env.DB.prepare(
    "SELECT credits FROM users WHERE user_id = ?"
  ).bind(session.userId).first<{ credits: number }>();

  const credits = userRow?.credits ?? 0;
  if (credits <= 0) {
    return new Response(JSON.stringify({ 
      error: "insufficient_quota", 
      message: "当前可用积分余额为 0 ⚡，无法提交任务，请先充值额度。" 
    }), { 
      status: 403, 
      headers: { "Content-Type": "application/json" } 
    });
  }

  // Atomically reserve 1 base credit to prevent race conditions across parallel requests
  const reserveResult = await env.DB.prepare(
    "UPDATE users SET credits = credits - 1 WHERE user_id = ? AND credits >= 1"
  ).bind(session.userId).run();

  if (!reserveResult.meta.changes || reserveResult.meta.changes === 0) {
    return new Response(JSON.stringify({ 
      error: "insufficient_quota", 
      message: "可用积分不足或并发请求额度受限，请稍后重试。" 
    }), { 
      status: 403, 
      headers: { "Content-Type": "application/json" } 
    });
  }

  // 2. Parse Payload
  let body: {
    envelope: UnifiedProtocolEnvelope;
    reRouteMode?: 'normal' | 'switch_template' | 'switch_model';
    chosenTemplateId?: string;
    chosenRoleModels?: Record<string, string>;
    customRolePrompts?: Record<string, string>;
    customNodePrompt?: string;
    hasPreviousRound?: boolean;
    previousRoundSummary?: string;
    hadMediaAssets?: boolean;
    hasNewUploads?: boolean;
    newUploadModalities?: string[];
    sessionAssetLedger?: Array<{
      asset_id: string;
      filename?: string;
      modality: string;
      introduced_round?: number;
      branch_id?: string;
    }>;
    activeBranchId?: string;
    activeBranchSummary?: string;
    branchCatalog?: Array<{
      branch_id: string;
      topic?: string;
      is_media?: boolean;
      last_summary?: string;
      is_active?: boolean;
    }>;
    disableBrowserInference?: boolean;
  };

  try {
    body = await request.json();
  } catch (err) {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), { 
      status: 400, 
      headers: { "Content-Type": "application/json" } 
    });
  }

  const envelope = body.envelope;
  if (!envelope || !envelope.instruction_payload) {
    return new Response(JSON.stringify({ error: "Missing instruction payload" }), { 
      status: 400, 
      headers: { "Content-Type": "application/json" } 
    });
  }

  const hasNewUploads = body.hasNewUploads ?? envelope.metadata?.has_new_upload ?? (envelope.assets_manifest || []).some(a => a.is_new);
  const newUploadModalities = body.newUploadModalities ?? envelope.metadata?.new_upload_modalities ?? (envelope.assets_manifest || []).filter(a => a.is_new).map(a => a.modality);

  const orchestrationOptions: OrchestrationOptions = {
    reRouteMode: body.reRouteMode,
    chosenTemplateId: body.chosenTemplateId,
    chosenRoleModels: body.chosenRoleModels,
    customRolePrompts: body.customRolePrompts,
    customNodePrompt: body.customNodePrompt,
    hasPreviousRound: body.hasPreviousRound,
    previousRoundSummary: body.previousRoundSummary,
    hadMediaAssets: body.hadMediaAssets,
    hasNewUploads,
    newUploadModalities,
    sessionAssetLedger: body.sessionAssetLedger,
    activeBranchId: body.activeBranchId,
    activeBranchSummary: body.activeBranchSummary,
    branchCatalog: body.branchCatalog,
    disableBrowserInference: !!body.disableBrowserInference
  };

  try {
    // 3. Run Gateway 3-Step Arbitration & Instantiate DAG
    const dag = await runOrchestrationPipeline(env, envelope, orchestrationOptions);

    // 4. Return SSE Stream (with pre-deduction tracking for atomic billing)
    const stream = await executeDAGStream(env, dag, envelope, { 
      userId: session.userId, 
      hasPreDeducted: true 
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive"
      }
    });
  } catch (err: any) {
    console.error("Orchestration error:", err);
    return new Response(JSON.stringify({ 
      error: "orchestration_failed", 
      message: err.message || "Failed to orchestrate task" 
    }), { 
      status: 500, 
      headers: { "Content-Type": "application/json" } 
    });
  }
}
