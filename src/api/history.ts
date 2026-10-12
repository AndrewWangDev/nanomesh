import { Env } from "../types";
import { getSession } from "../auth/middleware";

export async function handleGetHistory(request: Request, env: Env): Promise<Response> {
  const session = await getSession(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    });
  }

  try {
    const res = await env.DB.prepare(
      `SELECT session_id, user_id, trace_id, title, cost, duration, nodes_count, cached, pinned, rounds_json, created_at, updated_at
       FROM user_chat_sessions
       WHERE user_id = ?
       ORDER BY pinned DESC, updated_at DESC
       LIMIT 50`
    ).bind(session.userId).all<any>();

    const sessions = (res.results || []).map(r => {
      let rounds = [];
      try {
        rounds = JSON.parse(r.rounds_json || '[]');
      } catch (e) {}

      return {
        id: r.trace_id || r.session_id,
        sessionId: r.session_id,
        title: r.title,
        cost: r.cost,
        duration: r.duration,
        nodesCount: r.nodes_count,
        cached: !!r.cached,
        pinned: !!r.pinned,
        timestamp: new Date(r.updated_at).getTime() || Date.now(),
        rounds
      };
    });

    return new Response(JSON.stringify({ sessions }), {
      headers: { "Content-Type": "application/json" }
    });
  } catch (err: any) {
    console.error("Failed to fetch history:", err);
    return new Response(JSON.stringify({ error: err.message || "Failed to fetch history" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}

export async function handleSaveHistory(request: Request, env: Env): Promise<Response> {
  const session = await getSession(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    });
  }

  try {
    const body: any = await request.json();
    const sessionId = body.sessionId || body.session_id;
    if (!sessionId) {
      return new Response(JSON.stringify({ error: "Missing sessionId" }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    const traceId = body.id || body.trace_id || ('trace-' + Date.now());
    const title = body.title || '多模态任务编排';
    const cost = String(body.cost ?? '0');
    const duration = String(body.duration ?? '0s');
    const nodesCount = Number(body.nodesCount ?? body.nodes_count ?? 1);
    const cached = body.cached ? 1 : 0;
    const pinned = body.pinned ? 1 : 0;
    const roundsJson = JSON.stringify(body.rounds || []);

    await env.DB.prepare(
      `INSERT INTO user_chat_sessions (session_id, user_id, trace_id, title, cost, duration, nodes_count, cached, pinned, rounds_json, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(session_id) DO UPDATE SET
         trace_id = excluded.trace_id,
         title = excluded.title,
         cost = excluded.cost,
         duration = excluded.duration,
         nodes_count = excluded.nodes_count,
         cached = excluded.cached,
         pinned = excluded.pinned,
         rounds_json = excluded.rounds_json,
         updated_at = datetime('now')`
    ).bind(
      sessionId,
      session.userId,
      traceId,
      title,
      cost,
      duration,
      nodesCount,
      cached,
      pinned,
      roundsJson
    ).run();

    return new Response(JSON.stringify({ success: true, sessionId }), {
      headers: { "Content-Type": "application/json" }
    });
  } catch (err: any) {
    console.error("Failed to save history:", err);
    return new Response(JSON.stringify({ error: err.message || "Failed to save history" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}

export async function handleUpdateHistoryItem(request: Request, env: Env, sessionId: string): Promise<Response> {
  const session = await getSession(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    });
  }

  try {
    const body: any = await request.json();
    const updates: string[] = [];
    const values: any[] = [];

    if (body.title !== undefined) {
      updates.push("title = ?");
      values.push(body.title);
    }
    if (body.pinned !== undefined) {
      updates.push("pinned = ?");
      values.push(body.pinned ? 1 : 0);
    }

    if (updates.length === 0) {
      return new Response(JSON.stringify({ success: true }), {
        headers: { "Content-Type": "application/json" }
      });
    }

    updates.push("updated_at = datetime('now')");
    values.push(sessionId);
    values.push(session.userId);

    await env.DB.prepare(
      `UPDATE user_chat_sessions SET ${updates.join(', ')} WHERE session_id = ? AND user_id = ?`
    ).bind(...values).run();

    return new Response(JSON.stringify({ success: true }), {
      headers: { "Content-Type": "application/json" }
    });
  } catch (err: any) {
    console.error("Failed to update history item:", err);
    return new Response(JSON.stringify({ error: err.message || "Failed to update history" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}

export async function handleDeleteHistoryItem(request: Request, env: Env, sessionId: string): Promise<Response> {
  const session = await getSession(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    });
  }

  try {
    await env.DB.prepare(
      `DELETE FROM user_chat_sessions WHERE (session_id = ? OR trace_id = ?) AND user_id = ?`
    ).bind(sessionId, sessionId, session.userId).run();

    return new Response(JSON.stringify({ success: true }), {
      headers: { "Content-Type": "application/json" }
    });
  } catch (err: any) {
    console.error("Failed to delete history item:", err);
    return new Response(JSON.stringify({ error: err.message || "Failed to delete history" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
}
