import { Env } from "../types";
import { getSession } from "../auth/middleware";
import { getAdminSession } from "./admin";

export interface CreateNotificationParams {
  userId?: string | null; // null for broadcast
  category: 'model' | 'billing' | 'quota' | 'task' | 'system';
  eventType: string;
  priority?: 'normal' | 'urgent';
  titleZh: string;
  titleEn: string;
  contentZh: string;
  contentEn: string;
  actionType?: 'route' | 'url' | 'none';
  actionPayload?: string;
  relatedId?: string;
  extraData?: string;
}

/**
 * Universal dispatcher for both system triggers and admin broadcasts.
 */
export async function dispatchNotification(env: Env, params: CreateNotificationParams): Promise<string> {
  const notificationId = crypto.randomUUID();
  const priority = params.priority || 'normal';
  const actionType = params.actionType || 'none';
  const actionPayload = params.actionPayload || null;
  const relatedId = params.relatedId || null;
  const extraData = params.extraData || null;

  await env.DB.prepare(
    `INSERT INTO notifications (
      notification_id, user_id, category, event_type, priority,
      title_zh, title_en, content_zh, content_en,
      action_type, action_payload, related_id, extra_data, is_read
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
  ).bind(
    notificationId,
    params.userId || null,
    params.category,
    params.eventType,
    priority,
    params.titleZh,
    params.titleEn,
    params.contentZh,
    params.contentEn,
    actionType,
    actionPayload,
    relatedId,
    extraData
  ).run();

  return notificationId;
}

/**
 * Low balance check (< 500 credits) with a 24-hour deduplication window.
 */
export async function checkAndNotifyLowBalance(env: Env, userId: string, currentCredits: number): Promise<void> {
  if (currentCredits >= 500) return;

  const recent = await env.DB.prepare(
    `SELECT notification_id FROM notifications 
     WHERE user_id = ? AND event_type = 'low_balance' AND created_at > datetime('now', '-24 hours')
     LIMIT 1`
  ).bind(userId).first();

  if (recent) return;

  await dispatchNotification(env, {
    userId,
    category: 'quota',
    eventType: 'low_balance',
    priority: 'urgent',
    titleZh: '算力额度不足提醒',
    titleEn: 'Low Balance Warning',
    contentZh: `当前账户可用额度已低于 500 ⚡（剩余 ${currentCredits} ⚡），为免影响推理调度，请及时充值。`,
    contentEn: `Available quota is below 500 ⚡ (remaining: ${currentCredits} ⚡). Please top up to maintain uninterrupted model routing.`,
    actionType: 'route',
    actionPayload: JSON.stringify({ modal: 'recharge' })
  });
}

// ----------------- Client Handlers -----------------

export async function handleGetNotifications(req: Request, env: Env): Promise<Response> {
  const session = await getSession(req, env);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  const filter = url.searchParams.get("filter") || "all";
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1"));
  const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get("limit") || "20")));
  const offset = (page - 1) * limit;

  let filterClause = "";
  if (filter === "unread") {
    filterClause = ` AND (
      (n.user_id IS NOT NULL AND n.is_read = 0) OR
      (n.user_id IS NULL AND br.read_at IS NULL)
    )`;
  } else if (filter === "model") {
    filterClause = " AND n.category = 'model'";
  } else if (filter === "billing" || filter === "quota") {
    filterClause = " AND n.category IN ('billing', 'quota')";
  } else if (filter === "system") {
    filterClause = " AND n.category = 'system'";
  }

  // 1. Fetch paginated list
  const items = await env.DB.prepare(
    `SELECT 
      n.notification_id,
      n.user_id,
      n.category,
      n.event_type,
      n.priority,
      n.title_zh,
      n.title_en,
      n.content_zh,
      n.content_en,
      n.action_type,
      n.action_payload,
      n.related_id,
      n.created_at,
      CASE 
        WHEN n.user_id IS NOT NULL THEN n.is_read
        ELSE CASE WHEN br.read_at IS NOT NULL THEN 1 ELSE 0 END
      END as is_read
    FROM notifications n
    LEFT JOIN broadcast_reads br ON n.notification_id = br.notification_id AND br.user_id = ?
    WHERE (n.user_id = ? OR n.user_id IS NULL)${filterClause}
    ORDER BY n.created_at DESC
    LIMIT ? OFFSET ?`
  ).bind(session.userId, session.userId, limit, offset).all();

  // 2. Fetch total count for current filter
  const countResult = await env.DB.prepare(
    `SELECT COUNT(*) as total
    FROM notifications n
    LEFT JOIN broadcast_reads br ON n.notification_id = br.notification_id AND br.user_id = ?
    WHERE (n.user_id = ? OR n.user_id IS NULL)${filterClause}`
  ).bind(session.userId, session.userId).first<{ total: number }>();

  // 3. Fetch overall unread & urgent metrics
  const unreadStats = await env.DB.prepare(
    `SELECT 
      COUNT(*) as unread_count,
      SUM(CASE WHEN n.priority = 'urgent' THEN 1 ELSE 0 END) as urgent_count
    FROM notifications n
    LEFT JOIN broadcast_reads br ON n.notification_id = br.notification_id AND br.user_id = ?
    WHERE (n.user_id = ? OR n.user_id IS NULL)
      AND (
        (n.user_id IS NOT NULL AND n.is_read = 0) OR
        (n.user_id IS NULL AND br.read_at IS NULL)
      )`
  ).bind(session.userId, session.userId).first<{ unread_count: number; urgent_count: number }>();

  const unreadCount = unreadStats?.unread_count || 0;
  const urgentCount = unreadStats?.urgent_count || 0;

  return Response.json({
    items: items.results,
    total: countResult?.total || 0,
    unreadCount,
    hasUrgentUnread: urgentCount > 0,
    page,
    limit
  });
}

export async function handleMarkAsRead(req: Request, env: Env, notificationId: string): Promise<Response> {
  const session = await getSession(req, env);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const notif = await env.DB.prepare(
    "SELECT notification_id, user_id FROM notifications WHERE notification_id = ?"
  ).bind(notificationId).first<{ notification_id: string; user_id: string | null }>();

  if (!notif) {
    return Response.json({ error: "Notification not found" }, { status: 404 });
  }

  if (notif.user_id) {
    if (notif.user_id !== session.userId) {
      return Response.json({ error: "Forbidden" }, { status: 403 });
    }
    await env.DB.prepare(
      "UPDATE notifications SET is_read = 1, read_at = datetime('now') WHERE notification_id = ?"
    ).bind(notificationId).run();
  } else {
    // Broadcast message: record in broadcast_reads
    await env.DB.prepare(
      "INSERT OR IGNORE INTO broadcast_reads (user_id, notification_id) VALUES (?, ?)"
    ).bind(session.userId, notificationId).run();
  }

  return Response.json({ success: true });
}

export async function handleMarkAllAsRead(req: Request, env: Env): Promise<Response> {
  const session = await getSession(req, env);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  // 1. Mark all direct notifications as read
  await env.DB.prepare(
    "UPDATE notifications SET is_read = 1, read_at = datetime('now') WHERE user_id = ? AND is_read = 0"
  ).bind(session.userId).run();

  // 2. Insert read receipts for all unread global broadcasts
  await env.DB.prepare(
    `INSERT OR IGNORE INTO broadcast_reads (user_id, notification_id)
     SELECT ?, n.notification_id
     FROM notifications n
     LEFT JOIN broadcast_reads br ON n.notification_id = br.notification_id AND br.user_id = ?
     WHERE n.user_id IS NULL AND br.read_at IS NULL`
  ).bind(session.userId, session.userId).run();

  return Response.json({ success: true });
}

// ----------------- Admin Handlers -----------------

export async function handleAdminSendNotification(req: Request, env: Env): Promise<Response> {
  const session = await getAdminSession(req, env);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const body = (await req.json().catch(() => ({}))) as {
    target?: 'all' | 'user';
    targetUser?: string; // email or user_id
    category?: 'system' | 'model' | 'billing' | 'quota' | 'task';
    priority?: 'normal' | 'urgent';
    titleZh?: string;
    titleEn?: string;
    contentZh?: string;
    contentEn?: string;
    actionType?: 'route' | 'url' | 'none';
    actionPayload?: string;
  };

  const target = body.target || 'all';
  let targetUserId: string | null = null;

  if (target === 'user') {
    if (!body.targetUser?.trim()) {
      return Response.json({ error: "Target user (email or ID) is required" }, { status: 400 });
    }
    const cleanUser = body.targetUser.trim();
    const user = await env.DB.prepare(
      "SELECT user_id FROM users WHERE user_id = ? OR email = ? OR username = ?"
    ).bind(cleanUser, cleanUser, cleanUser).first<{ user_id: string }>();

    if (!user) {
      return Response.json({ error: "Specified user not found" }, { status: 404 });
    }
    targetUserId = user.user_id;
  }

  const titleZh = body.titleZh?.trim();
  const contentZh = body.contentZh?.trim();
  if (!titleZh || !contentZh) {
    return Response.json({ error: "Title and content (Chinese) are required" }, { status: 400 });
  }

  const titleEn = body.titleEn?.trim() || titleZh;
  const contentEn = body.contentEn?.trim() || contentZh;

  const id = await dispatchNotification(env, {
    userId: targetUserId,
    category: body.category || 'system',
    eventType: target === 'all' ? 'admin_broadcast' : 'admin_direct',
    priority: body.priority || 'normal',
    titleZh,
    titleEn,
    contentZh,
    contentEn,
    actionType: body.actionType || 'none',
    actionPayload: body.actionPayload || undefined
  });

  return Response.json({ success: true, notificationId: id });
}

export async function handleAdminListNotifications(req: Request, env: Env): Promise<Response> {
  const session = await getAdminSession(req, env);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const { results } = await env.DB.prepare(
    `SELECT n.*, u.email as target_email, u.username as target_username
     FROM notifications n
     LEFT JOIN users u ON n.user_id = u.user_id
     WHERE n.event_type IN ('admin_broadcast', 'admin_direct') OR n.category = 'system'
     ORDER BY n.created_at DESC
     LIMIT 100`
  ).all();

  return Response.json({ items: results });
}

export async function handleAdminRevokeNotification(req: Request, env: Env): Promise<Response> {
  const session = await getAdminSession(req, env);
  if (!session) return new Response("Unauthorized", { status: 401 });

  const url = new URL(req.url);
  const id = url.pathname.split("/").pop();
  if (!id) return Response.json({ error: "Missing notification ID" }, { status: 400 });

  await env.DB.prepare("DELETE FROM notifications WHERE notification_id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM broadcast_reads WHERE notification_id = ?").bind(id).run();

  return Response.json({ success: true });
}
