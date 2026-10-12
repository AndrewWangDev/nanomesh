import { Env } from "../types";
import { signJWT, verifyJWT } from "../auth/jwt";
import { AwsClient } from "aws4fetch";
import { hashGiftCode, normalizeGiftCode } from "./billing";

// Crockford Base32 alphabet (32 characters, no I, L, O, U)
const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function generateCrockfordCode(): { raw: string; formatted: string } {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let chars = "";
  for (let i = 0; i < 16; i++) {
    chars += CROCKFORD_ALPHABET[bytes[i] & 31];
  }
  const formatted = `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}-${chars.slice(12, 16)}`;
  return { raw: chars, formatted };
}

export async function getAdminSession(request: Request, env: Env) {
  const cookie = request.headers.get("Cookie") || "";
  const match = cookie.match(/admin_session=([^;]+)/);
  if (!match) return null;
  const token = match[1];
  try {
    const payload = await verifyJWT(token, env.JWT_SECRET);
    if (payload && payload.role === "admin") return payload;
  } catch (e) {}
  return null;
}

export async function handleAdminLogin(request: Request, env: Env): Promise<Response> {
  const adminPass = env.ADMIN_PASSWORD;
  // Security hardening: reject login if ADMIN_PASSWORD secret is not configured
  if (!adminPass) {
    return new Response(JSON.stringify({ error: "Admin access not configured on server" }), {
      status: 503,
      headers: { "Content-Type": "application/json" }
    });
  }

  const ip = request.headers.get("CF-Connecting-IP") || "unknown";

  // Rate limit: 5 failed attempts per IP in last 15 minutes
  const failRecord = await env.DB.prepare(
    "SELECT COUNT(*) as count FROM admin_login_attempts WHERE ip = ? AND created_at > datetime('now', '-15 minutes')"
  ).bind(ip).first<{ count: number }>();

  if (failRecord && failRecord.count >= 5) {
    return new Response(JSON.stringify({ error: "Too many failed login attempts. Please wait 15 minutes." }), {
      status: 429,
      headers: { "Content-Type": "application/json" }
    });
  }

  const body = await request.json().catch(() => ({})) as { password?: string };
  const enc = new TextEncoder();
  const inputBuffer = enc.encode(body.password || "");
  const passBuffer = enc.encode(adminPass);
  const isMatch = inputBuffer.length === passBuffer.length && crypto.subtle.timingSafeEqual(inputBuffer, passBuffer);

  if (!isMatch) {
    await env.DB.prepare("INSERT INTO admin_login_attempts (ip) VALUES (?)").bind(ip).run();
    return new Response(JSON.stringify({ error: "Invalid admin password" }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    });
  }

  // Clear failed attempts on successful authentication
  await env.DB.prepare("DELETE FROM admin_login_attempts WHERE ip = ?").bind(ip).run();

  const token = await signJWT({ role: "admin" }, env.JWT_SECRET, 8 * 3600);
  const headers = new Headers();
  headers.set("Set-Cookie", `admin_session=${token}; HttpOnly; Path=/; Max-Age=${8 * 3600}; SameSite=Lax; Secure`);
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify({ success: true }), { headers });
}

export async function handleAdminLogout(request: Request, env: Env): Promise<Response> {
  const headers = new Headers();
  headers.set("Set-Cookie", "admin_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax; Secure");
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify({ success: true }), { headers });
}

// ----------------- Model Management -----------------

export async function handleAdminListModels(request: Request, env: Env): Promise<Response> {
  const session = await getAdminSession(request, env);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const url = new URL(request.url);
  const statusFilter = url.searchParams.get("status") || "all";

  const allowedStatuses = ['pending', 'approved', 'published', 'rejected'];
  let whereClause = "WHERE uum.status != 'uploading'";
  const queryParams: any[] = [];
  if (statusFilter !== "all" && allowedStatuses.includes(statusFilter)) {
    whereClause += " AND uum.status = ?";
    queryParams.push(statusFilter);
  }

  let stmt = env.DB.prepare(
    `SELECT uum.*, u.username, u.email 
     FROM user_uploaded_models uum
     LEFT JOIN users u ON uum.user_id = u.user_id 
     ${whereClause}
     ORDER BY uum.created_at DESC`
  );
  if (queryParams.length > 0) {
    stmt = stmt.bind(...queryParams);
  }
  const { results } = await stmt.all();

  // Pending counts for sidebar badge
  const pendingCount = await env.DB.prepare(
    "SELECT COUNT(*) as count FROM user_uploaded_models WHERE status = 'pending'"
  ).first<{ count: number }>();

  return Response.json({
    models: results,
    pendingCount: pendingCount?.count || 0
  });
}

export async function handleAdminDownload(request: Request, env: Env): Promise<Response> {
  const session = await getAdminSession(request, env);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const url = new URL(request.url);
  const pathParts = url.pathname.split("/");
  const id = pathParts[pathParts.length - 2];

  const model = await env.DB.prepare("SELECT r2_object_key FROM user_uploaded_models WHERE upload_id = ?").bind(id).first<{ r2_object_key: string }>();
  if (!model) return new Response("Not found", { status: 404 });

  const aws = new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: "s3",
    region: "auto"
  });
  const objectUrl = new URL(`https://${env.Cloudflare_Account_ID}.r2.cloudflarestorage.com/nanomesh-assets/${model.r2_object_key}`);
  objectUrl.searchParams.set("X-Amz-Expires", "3600");
  const req = await aws.sign(objectUrl, {
    method: "GET",
    aws: { signQuery: true }
  });

  return Response.json({ url: req.url });
}

export async function handleAdminUpdateModel(request: Request, env: Env): Promise<Response> {
  const session = await getAdminSession(request, env);
  if (!session) return new Response("Unauthorized", { status: 401 });

  try {
    const url = new URL(request.url);
    const id = url.pathname.split("/").pop();
    if (!id) return Response.json({ error: "Missing model id" }, { status: 400 });

    const body = (await request.json().catch(() => ({}))) as { status: string; reason?: string };
    if (!body.status) return Response.json({ error: "Missing status" }, { status: 400 });

    const model = await env.DB.prepare("SELECT * FROM user_uploaded_models WHERE upload_id = ?").bind(id).first<any>();
    if (!model) return new Response("Not found", { status: 404 });

    const { dispatchNotification } = await import("./notifications");

    if (body.status === "published" && (model.status === "approved" || model.status === "pending")) {
      const liveModelId = model.live_model_id || ("um-" + id);
      // Use ON CONFLICT to gracefully handle re-publishing previously published/taken-down models
      await env.DB.prepare(
        `INSERT INTO models 
         (model_id, display_name, provider, endpoint, modalities, tags, context_window, max_concurrency, precision, user_rating, usage_count, cost_per_1k_tokens, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(model_id) DO UPDATE SET 
           display_name = excluded.display_name,
           modalities = excluded.modalities,
           tags = excluded.tags,
           context_window = excluded.context_window,
           status = 'active',
           updated_at = datetime('now')`
      ).bind(
        liveModelId,
        model.display_name || "User Model",
        "user-upload",
        "/api/infer",
        model.in_modalities || "[]",
        model.capability_tags || "[]",
        model.context_window || 4096,
        10,
        0.8,
        5.0,
        0,
        1.0,
        "active"
      ).run();

      await env.DB.prepare(
        "UPDATE user_uploaded_models SET status = ?, live_model_id = ?, published_at = datetime('now') WHERE upload_id = ?"
      ).bind("published", liveModelId, id).run();

      if (model.user_id) {
        await dispatchNotification(env, {
          userId: model.user_id,
          category: 'model',
          eventType: 'model_published',
          priority: 'normal',
          titleZh: '模型已成功发布上线',
          titleEn: 'Model Published Successfully',
          contentZh: `您的模型「${model.display_name || '自定义模型'}」已通过审核并正式加入 NanoMesh 全网调度池。`,
          contentEn: `Your model "${model.display_name || 'Custom Model'}" has passed review and is now live on the NanoMesh network.`,
          actionType: 'route',
          actionPayload: JSON.stringify({ modal: 'settings', tab: 'models' }),
          relatedId: id
        });
      }
    } else if (body.status === "approved" && model.status === "published") {
      // Take down / unpublish
      if (model.live_model_id) {
        await env.DB.prepare("UPDATE models SET status = 'disabled', updated_at = datetime('now') WHERE model_id = ?").bind(model.live_model_id).run();
      }
      await env.DB.prepare("UPDATE user_uploaded_models SET status = ? WHERE upload_id = ?").bind("approved", id).run();

      if (model.user_id) {
        const reasonZh = body.reason?.trim() ? `原因：${body.reason.trim()}` : '如需重新上线，请联系平台支持或更新模型。';
        const reasonEn = body.reason?.trim() ? `Reason: ${body.reason.trim()}` : 'To republish, please contact support or update the model.';
        await dispatchNotification(env, {
          userId: model.user_id,
          category: 'model',
          eventType: 'model_delisted',
          priority: 'urgent',
          titleZh: '模型已下架',
          titleEn: 'Model Delisted',
          contentZh: `您的模型「${model.display_name || '自定义模型'}」已被下架。${reasonZh}`,
          contentEn: `Your model "${model.display_name || 'Custom Model'}" has been delisted from the network. ${reasonEn}`,
          actionType: 'route',
          actionPayload: JSON.stringify({ modal: 'settings', tab: 'models' }),
          relatedId: id,
          extraData: body.reason ? JSON.stringify({ reason: body.reason }) : undefined
        });
      }
    } else {
      // If taking down to rejected, disable live model if it was active
      if (model.status === "published" && model.live_model_id) {
        await env.DB.prepare("UPDATE models SET status = 'disabled', updated_at = datetime('now') WHERE model_id = ?").bind(model.live_model_id).run();
      }
      await env.DB.prepare("UPDATE user_uploaded_models SET status = ?, reviewed_at = datetime('now') WHERE upload_id = ?").bind(body.status, id).run();

      if (model.user_id) {
        if (body.status === 'rejected') {
          const reasonZh = body.reason?.trim() ? `原因：${body.reason.trim()}` : '未符合平台合规条款或格式规范。';
          const reasonEn = body.reason?.trim() ? `Reason: ${body.reason.trim()}` : 'Did not meet compliance guidelines or format specifications.';
          await dispatchNotification(env, {
            userId: model.user_id,
            category: 'model',
            eventType: 'model_rejected',
            priority: 'urgent',
            titleZh: '模型审核未通过',
            titleEn: 'Model Review Rejected',
            contentZh: `您的模型「${model.display_name || '自定义模型'}」未能通过审核。${reasonZh}`,
            contentEn: `Your model "${model.display_name || 'Custom Model'}" was rejected. ${reasonEn}`,
            actionType: 'route',
            actionPayload: JSON.stringify({ modal: 'settings', tab: 'models' }),
            relatedId: id,
            extraData: body.reason ? JSON.stringify({ reason: body.reason }) : undefined
          });
        } else if (body.status === 'approved') {
          await dispatchNotification(env, {
            userId: model.user_id,
            category: 'model',
            eventType: 'model_approved',
            priority: 'normal',
            titleZh: '模型审核通过',
            titleEn: 'Model Approved',
            contentZh: `您的模型「${model.display_name || '自定义模型'}」已通过安全合规与模型结构审核，等待上线调度。`,
            contentEn: `Your model "${model.display_name || 'Custom Model'}" has passed review and is awaiting scheduling activation.`,
            actionType: 'route',
            actionPayload: JSON.stringify({ modal: 'settings', tab: 'models' }),
            relatedId: id
          });
        }
      }
    }

    return Response.json({ success: true, upload_id: id, status: body.status });
  } catch (err: any) {
    console.error("handleAdminUpdateModel error:", err);
    return Response.json({ error: err.message || "Failed to update model status" }, { status: 500 });
  }
}

// ----------------- Gift Code Management -----------------

export async function handleAdminCreateGiftCodes(request: Request, env: Env): Promise<Response> {
  const session = await getAdminSession(request, env);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const body = (await request.json().catch(() => ({}))) as {
    amount?: number;
    count?: number;
    expires_at?: string | null; // ISO string from client e.g. "2026-12-31T15:00:00.000Z"
    note?: string;
  };

  const amount = Number(body.amount);
  if (isNaN(amount) || amount <= 0 || amount > 10000000) {
    return Response.json({ error: "Invalid credit amount (1 - 10,000,000)" }, { status: 400 });
  }

  const count = Math.min(500, Math.max(1, Math.floor(Number(body.count) || 1)));
  const note = (body.note || "").trim().slice(0, 100);

  let expiresAtDb: string | null = null;
  if (body.expires_at) {
    const expDate = new Date(body.expires_at);
    if (isNaN(expDate.getTime()) || expDate.getTime() <= Date.now()) {
      return Response.json({ error: "Expiration date must be in the future" }, { status: 400 });
    }
    // SQLite UTC format 'YYYY-MM-DD HH:MM:SS'
    expiresAtDb = expDate.toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
  }

  const batchId = crypto.randomUUID();
  const generatedCodes: Array<{ id: string; hash: string; hint: string; displayCode: string }> = [];

  for (let i = 0; i < count; i++) {
    const { raw, formatted } = generateCrockfordCode();
    const hash = await hashGiftCode(raw, env.JWT_SECRET);
    generatedCodes.push({
      id: crypto.randomUUID(),
      hash,
      hint: raw.slice(-4),
      displayCode: formatted
    });
  }

  // Insert in chunks of 50 to stay well within D1 batch boundaries
  const CHUNK_SIZE = 50;
  for (let i = 0; i < generatedCodes.length; i += CHUNK_SIZE) {
    const chunk = generatedCodes.slice(i, i + CHUNK_SIZE);
    const statements = chunk.map(c =>
      env.DB.prepare(`
        INSERT INTO gift_codes (code_id, code_hash, code_hint, amount, status, expires_at, batch_id, note)
        VALUES (?, ?, ?, ?, 'active', ?, ?, ?)
      `).bind(c.id, c.hash, c.hint, amount, expiresAtDb, batchId, note || null)
    );
    await env.DB.batch(statements);
  }

  return Response.json({
    success: true,
    batch_id: batchId,
    count: generatedCodes.length,
    amount,
    expires_at: expiresAtDb,
    note,
    codes: generatedCodes.map(c => c.displayCode)
  });
}

export async function handleAdminListGiftCodes(request: Request, env: Env): Promise<Response> {
  const session = await getAdminSession(request, env);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const url = new URL(request.url);
  const status = url.searchParams.get("status") || "all";
  const batch = url.searchParams.get("batch") || "all";
  const q = (url.searchParams.get("q") || "").trim();
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1"));
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") || "50")));
  const offset = (page - 1) * limit;

  // 1. Stats calculation
  const activeStats = await env.DB.prepare(`
    SELECT COUNT(*) as count, COALESCE(SUM(amount), 0) as total_credits 
    FROM gift_codes 
    WHERE status = 'active' AND (expires_at IS NULL OR expires_at > datetime('now'))
  `).first<{ count: number; total_credits: number }>();

  const redeemedStats = await env.DB.prepare(`
    SELECT COUNT(*) as count 
    FROM gift_codes 
    WHERE status = 'redeemed'
  `).first<{ count: number }>();

  const revokedStats = await env.DB.prepare(`
    SELECT COUNT(*) as count 
    FROM gift_codes 
    WHERE status = 'revoked'
  `).first<{ count: number }>();

  const expiredStats = await env.DB.prepare(`
    SELECT COUNT(*) as count 
    FROM gift_codes 
    WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= datetime('now')
  `).first<{ count: number }>();

  // 2. Query filter assembly
  const conditions: string[] = [];
  const params: any[] = [];

  if (status === "active") {
    conditions.push("g.status = 'active' AND (g.expires_at IS NULL OR g.expires_at > datetime('now'))");
  } else if (status === "expired") {
    conditions.push("g.status = 'active' AND g.expires_at IS NOT NULL AND g.expires_at <= datetime('now')");
  } else if (status === "redeemed") {
    conditions.push("g.status = 'redeemed'");
  } else if (status === "revoked") {
    conditions.push("g.status = 'revoked'");
  }

  if (batch && batch !== "all") {
    conditions.push("g.batch_id = ?");
    params.push(batch);
  }

  if (q) {
    conditions.push("(g.code_hint LIKE ? OR g.note LIKE ?)");
    params.push(`%${q}%`, `%${q}%`);
  }

  const whereStr = conditions.length > 0 ? "WHERE " + conditions.join(" AND ") : "";

  const countQuery = `SELECT COUNT(*) as total FROM gift_codes g ${whereStr}`;
  const totalRes = await env.DB.prepare(countQuery).bind(...params).first<{ total: number }>();

  const listQuery = `
    SELECT g.code_id, g.code_hint, g.amount, g.status, g.expires_at, g.redeemed_at, g.revoked_at, 
           g.batch_id, g.note, g.created_at,
           CASE 
             WHEN g.status = 'active' AND g.expires_at IS NOT NULL AND g.expires_at <= datetime('now') THEN 'expired'
             ELSE g.status 
           END as computed_status,
           u.username as redeemed_username, u.email as redeemed_email
    FROM gift_codes g
    LEFT JOIN users u ON g.redeemed_by = u.user_id
    ${whereStr}
    ORDER BY g.created_at DESC
    LIMIT ? OFFSET ?
  `;
  const listParams = [...params, limit, offset];
  const items = await env.DB.prepare(listQuery).bind(...listParams).all();

  // 3. Batches dropdown list
  const batches = await env.DB.prepare(`
    SELECT batch_id, note, amount, created_at, COUNT(*) as code_count
    FROM gift_codes
    GROUP BY batch_id
    ORDER BY created_at DESC
    LIMIT 50
  `).all();

  return Response.json({
    items: items.results,
    total: totalRes?.total || 0,
    page,
    limit,
    stats: {
      active: activeStats?.count || 0,
      activeCredits: activeStats?.total_credits || 0,
      redeemed: redeemedStats?.count || 0,
      revoked: revokedStats?.count || 0,
      expired: expiredStats?.count || 0
    },
    batches: batches.results
  });
}

export async function handleAdminRevokeGiftCode(request: Request, env: Env): Promise<Response> {
  const session = await getAdminSession(request, env);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const url = new URL(request.url);
  // Match /api/admin/gift-codes/:id/revoke
  const parts = url.pathname.split("/");
  const codeId = parts[parts.length - 2];

  if (!codeId) return Response.json({ error: "Missing code id" }, { status: 400 });

  const res = await env.DB.prepare(`
    UPDATE gift_codes 
    SET status = 'revoked', revoked_at = datetime('now') 
    WHERE code_id = ? AND status = 'active'
  `).bind(codeId).run();

  if (res.meta.changes === 0) {
    return Response.json({ error: "Code not found, already redeemed, or already revoked" }, { status: 400 });
  }

  return Response.json({ success: true, code_id: codeId });
}

export async function handleAdminRevokeBatch(request: Request, env: Env): Promise<Response> {
  const session = await getAdminSession(request, env);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const body = (await request.json().catch(() => ({}))) as { batch_id?: string };
  if (!body.batch_id) {
    return Response.json({ error: "Missing batch_id" }, { status: 400 });
  }

  const res = await env.DB.prepare(`
    UPDATE gift_codes 
    SET status = 'revoked', revoked_at = datetime('now') 
    WHERE batch_id = ? AND status = 'active'
  `).bind(body.batch_id).run();

  return Response.json({
    success: true,
    batch_id: body.batch_id,
    revokedCount: res.meta.changes || 0
  });
}
