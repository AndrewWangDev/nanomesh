import { Env } from "../types";
import { getSession } from "../auth/middleware";

export async function hashGiftCode(code: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(code + secret);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

export function normalizeGiftCode(raw: string): string {
  if (!raw) return "";
  let clean = raw.trim().toUpperCase().replace(/[\s\-]/g, "");
  // Crockford Base32 character mapping tolerance:
  clean = clean.replace(/O/g, "0").replace(/[IL]/g, "1");
  return clean;
}

export async function handleGetLedger(req: Request, env: Env) {
  const session = await getSession(req, env);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const category = url.searchParams.get('category') || 'all';
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1'));
  const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get('limit') || '20')));
  const offset = (page - 1) * limit;

  // Map frontend filter to backend categories
  let categoryFilter = '';
  if (category === 'compute') {
    categoryFilter = " AND category = 'compute_cost'";
  } else if (category === 'gas') {
    categoryFilter = " AND category IN ('gas_earned', 'referral_reward')";
  } else if (category === 'topup') {
    categoryFilter = " AND category IN ('signup_bonus', 'topup', 'gift_redeem')";
  }
  // 'all' = no filter

  const countResult = await env.DB.prepare(
    `SELECT COUNT(*) as total FROM credit_ledger WHERE user_id = ?${categoryFilter}`
  ).bind(session.userId).first<{total: number}>();

  const items = await env.DB.prepare(
    `SELECT ledger_id, category, amount, balance, title, detail, created_at FROM credit_ledger WHERE user_id = ?${categoryFilter} ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).bind(session.userId, limit, offset).all();

  // Compute gas_earned total for the hero card
  const gasTotal = await env.DB.prepare(
    "SELECT COALESCE(SUM(amount), 0) as total FROM credit_ledger WHERE user_id = ? AND category IN ('gas_earned', 'referral_reward')"
  ).bind(session.userId).first<{total: number}>();

  return Response.json({
    items: items.results,
    total: countResult?.total || 0,
    page,
    limit,
    gasEarnedTotal: gasTotal?.total || 0
  });
}

export async function handleRedeem(req: Request, env: Env): Promise<Response> {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const session = await getSession(req, env);
  if (!session || !session.userId) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body: any = await req.json().catch(() => ({}));
  const rawCode = typeof body.code === "string" ? body.code : "";
  if (!rawCode.trim()) {
    return Response.json({ error: "error.redeem.empty" }, { status: 400 });
  }

  // 1. Rate-limit check: 5 failed attempts in last 10 minutes
  const recentFails = await env.DB.prepare(
    "SELECT COUNT(*) as count FROM redeem_attempts WHERE user_id = ? AND created_at > datetime('now', '-10 minutes')"
  ).bind(session.userId).first<{ count: number }>();

  if (recentFails && recentFails.count >= 5) {
    return Response.json({ error: "error.redeem.rateLimited" }, { status: 429 });
  }

  const normalized = normalizeGiftCode(rawCode);
  // Valid Crockford Base32 (32 chars: 0-9, A-Z excluding I, L, O, U)
  const codeRegex = /^[0-9A-HJKMNP-TV-Z]{16}$/;
  if (!codeRegex.test(normalized)) {
    await env.DB.prepare("INSERT INTO redeem_attempts (user_id) VALUES (?)").bind(session.userId).run();
    return Response.json({ error: "error.redeem.invalid" }, { status: 400 });
  }

  // 2. Hash and query gift code
  const codeHash = await hashGiftCode(normalized, env.JWT_SECRET);
  const giftCode = await env.DB.prepare(`
    SELECT code_id, amount, status, expires_at, code_hint,
           CASE WHEN expires_at IS NOT NULL AND expires_at <= datetime('now') THEN 1 ELSE 0 END as is_expired
    FROM gift_codes 
    WHERE code_hash = ?
  `).bind(codeHash).first<{
    code_id: string;
    amount: number;
    status: string;
    expires_at: string | null;
    code_hint: string;
    is_expired: number;
  }>();

  if (!giftCode || giftCode.status === "revoked") {
    await env.DB.prepare("INSERT INTO redeem_attempts (user_id) VALUES (?)").bind(session.userId).run();
    // Return unified invalid error so attackers cannot differentiate between non-existent and revoked codes
    return Response.json({ error: "error.redeem.invalid" }, { status: 400 });
  }

  if (giftCode.status === "redeemed") {
    await env.DB.prepare("INSERT INTO redeem_attempts (user_id) VALUES (?)").bind(session.userId).run();
    return Response.json({ error: "error.redeem.used" }, { status: 400 });
  }

  if (giftCode.is_expired === 1) {
    await env.DB.prepare("INSERT INTO redeem_attempts (user_id) VALUES (?)").bind(session.userId).run();
    return Response.json({ error: "error.redeem.expired" }, { status: 400 });
  }

  // 3. Atomic redemption using D1 batch transaction with unique redemption_id guard
  const rid = crypto.randomUUID();
  const ledgerId = crypto.randomUUID();

  const batchResults = await env.DB.batch([
    // Step 1: Update status to 'redeemed' and write rid (guaranteed unique)
    env.DB.prepare(`
      UPDATE gift_codes 
      SET status = 'redeemed', redemption_id = ?, redeemed_by = ?, redeemed_at = datetime('now')
      WHERE code_id = ? AND status = 'active' AND (expires_at IS NULL OR expires_at > datetime('now'))
    `).bind(rid, session.userId, giftCode.code_id),

    // Step 2: Add credits to user ONLY if Step 1 actually succeeded
    env.DB.prepare(`
      UPDATE users 
      SET credits = credits + ? 
      WHERE user_id = ? AND EXISTS (SELECT 1 FROM gift_codes WHERE redemption_id = ?)
    `).bind(giftCode.amount, session.userId, rid),

    // Step 3: Insert credit_ledger entry ONLY if Step 1 succeeded
    env.DB.prepare(`
      INSERT INTO credit_ledger (ledger_id, user_id, category, amount, balance, title, detail, related_id)
      SELECT ?, ?, 'gift_redeem', ?, u.credits, 'Gift Code', '****-' || ?, ?
      FROM users u
      WHERE u.user_id = ? AND EXISTS (SELECT 1 FROM gift_codes WHERE redemption_id = ?)
    `).bind(ledgerId, session.userId, giftCode.amount, giftCode.code_hint, giftCode.code_id, session.userId, rid)
  ]);

  const step1Changes = batchResults[0]?.meta?.changes || 0;
  if (step1Changes === 0) {
    // Concurrent collision: someone else just redeemed this code milliseconds ago or admin revoked it
    await env.DB.prepare("INSERT INTO redeem_attempts (user_id) VALUES (?)").bind(session.userId).run();
    return Response.json({ error: "error.redeem.used" }, { status: 409 });
  }

  // Query updated balance
  const updatedUser = await env.DB.prepare(
    "SELECT credits FROM users WHERE user_id = ?"
  ).bind(session.userId).first<{ credits: number }>();

  try {
    const { dispatchNotification } = await import("./notifications");
    await dispatchNotification(env, {
      userId: session.userId,
      category: 'billing',
      eventType: 'topup_success',
      priority: 'normal',
      titleZh: '额度充值成功',
      titleEn: 'Top-up Successful',
      contentZh: `使用兑换码成功兑换 +${giftCode.amount.toLocaleString()} ⚡ 算力额度，当前可用额度为 ${(updatedUser?.credits ?? 0).toLocaleString()} ⚡。`,
      contentEn: `Successfully redeemed gift code for +${giftCode.amount.toLocaleString()} ⚡. Available balance: ${(updatedUser?.credits ?? 0).toLocaleString()} ⚡.`,
      actionType: 'route',
      actionPayload: JSON.stringify({ modal: 'settings', tab: 'billing' }),
      relatedId: giftCode.code_id
    });
  } catch (notifErr) {
    console.error("Failed to send topup notification:", notifErr);
  }

  return Response.json({
    success: true,
    amount: giftCode.amount,
    newBalance: updatedUser?.credits ?? 0,
    hint: giftCode.code_hint
  });
}
