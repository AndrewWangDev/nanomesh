import { Env } from "../types";
import { getSession } from "../auth/middleware";
import * as bcrypt from "bcryptjs";

export async function handleUpdateProfile(req: Request, env: Env) {
  if (req.method !== "PUT") return new Response("Method not allowed", { status: 405 });
  const session = await getSession(req, env);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const body: any = await req.json().catch(() => ({}));
  const { username } = body;

  if (!username || !/^[a-zA-Z0-9_-]{3,20}$/.test(username)) {
    return Response.json({ error: "error.invalidUsernameFormat" }, { status: 400 });
  }

  // Check uniqueness
  const existing = await env.DB.prepare("SELECT user_id FROM users WHERE username = ? AND user_id != ?").bind(username, session.userId).first();
  if (existing) {
    return Response.json({ error: "error.usernameExists" }, { status: 400 });
  }

  await env.DB.prepare("UPDATE users SET username = ? WHERE user_id = ?").bind(username, session.userId).run();

  return Response.json({ success: true });
}

export async function handleUpdatePassword(req: Request, env: Env) {
  if (req.method !== "PUT") return new Response("Method not allowed", { status: 405 });
  const session = await getSession(req, env);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const body: any = await req.json().catch(() => ({}));
  const { oldPassword, newPassword } = body;

  if (!newPassword || newPassword.length < 8 || newPassword.length > 64 || !/[a-zA-Z]/.test(newPassword) || !/[0-9]/.test(newPassword)) {
    return Response.json({ error: "error.invalidPasswordFormat" }, { status: 400 });
  }

  // Get user
  const user = await env.DB.prepare("SELECT password_hash FROM users WHERE user_id = ?").bind(session.userId).first<{password_hash: string | null}>();
  if (!user) return Response.json({ error: "error.userNotFound" }, { status: 404 });

  if (user.password_hash) {
    if (!oldPassword) {
      return Response.json({ error: "error.oldPasswordRequired" }, { status: 400 });
    }
    const valid = bcrypt.compareSync(oldPassword, user.password_hash);
    if (!valid) return Response.json({ error: "error.incorrectOldPassword" }, { status: 400 });
  }

  const newHash = bcrypt.hashSync(newPassword, 10);
  await env.DB.prepare("UPDATE users SET password_hash = ? WHERE user_id = ?").bind(newHash, session.userId).run();

  return Response.json({ success: true });
}

export async function handleUpdateAvatar(req: Request, env: Env) {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const session = await getSession(req, env);
  if (!session) return Response.json({ error: "error.unauthorized" }, { status: 401 });

  const userRow = await env.DB.prepare("SELECT avatar_updated_at FROM users WHERE user_id = ?").bind(session.userId).first<{avatar_updated_at: string | null}>();
  if (!userRow) return Response.json({ error: "error.userNotFound" }, { status: 404 });

  if (userRow.avatar_updated_at) {
    const lastUpdate = new Date(userRow.avatar_updated_at.replace(' ', 'T') + 'Z').getTime();
    if (Date.now() - lastUpdate < 24 * 60 * 60 * 1000) {
      return Response.json({ error: "error.avatarCooldown" }, { status: 429 });
    }
  }

  const formData = await req.formData().catch(() => null);
  if (!formData) return Response.json({ error: "error.invalidRequest" }, { status: 400 });

  const file = formData.get("file") as File;
  if (!file || !file.size) return Response.json({ error: "error.noFile" }, { status: 400 });

  if (file.size > 5 * 1024 * 1024) {
    return Response.json({ error: "error.fileTooLarge" }, { status: 400 });
  }

  const extension = file.name.split('.').pop()?.toLowerCase() || 'png';
  const validExts = ['png', 'jpg', 'jpeg', 'webp', 'gif'];
  if (!validExts.includes(extension)) {
    return Response.json({ error: "error.unsupportedFile" }, { status: 400 });
  }

  const objectKey = `avatars/${session.userId}_${Date.now()}.${extension}`;
  
  await env.R2.put(objectKey, file.stream(), {
    httpMetadata: {
      contentType: file.type || 'image/png'
    }
  });

  const avatarUrl = `/storage/${objectKey}`;

  await env.DB.prepare("UPDATE users SET avatar_url = ?, avatar_updated_at = datetime('now') WHERE user_id = ?").bind(avatarUrl, session.userId).run();

  return Response.json({ success: true, avatar_url: avatarUrl });
}

export async function handleDeleteAccount(req: Request, env: Env) {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const session = await getSession(req, env);
  if (!session) return Response.json({ error: "error.unauthorized" }, { status: 401 });

  // 1. Check frozen_credits
  const user = await env.DB.prepare("SELECT email, oauth_id, frozen_credits FROM users WHERE user_id = ?").bind(session.userId).first<{email: string, oauth_id: string | null, frozen_credits: number}>();
  if (!user) return Response.json({ error: "error.userNotFound" }, { status: 404 });

  if (user.frozen_credits > 0) {
    return Response.json({ error: "error.hasFrozenCredits" }, { status: 400 });
  }

  // 2. Hash fingerprints (email and oauth_id)
  const encoder = new TextEncoder();
  const emailData = encoder.encode(user.email + env.JWT_SECRET);
  const emailHashBuffer = await crypto.subtle.digest('SHA-256', emailData);
  const emailHash = Array.from(new Uint8Array(emailHashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');

  // 3. Insert tombstone
  await env.DB.prepare("INSERT INTO account_tombstones (hash_id, type, expires_at) VALUES (?, 'email', datetime('now', '+90 days'))").bind(emailHash).run();

  const bindings = await env.DB.prepare("SELECT provider_id FROM user_oauth_bindings WHERE user_id = ?").bind(session.userId).all<{provider_id: string}>();
  if (bindings.results && bindings.results.length > 0) {
    for (const b of bindings.results) {
      const oauthData = encoder.encode(b.provider_id + env.JWT_SECRET);
      const oauthHashBuffer = await crypto.subtle.digest('SHA-256', oauthData);
      const oauthHash = Array.from(new Uint8Array(oauthHashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
      await env.DB.prepare("INSERT INTO account_tombstones (hash_id, type, expires_at) VALUES (?, 'oauth', datetime('now', '+90 days'))").bind(oauthHash).run();
    }
  }

  // 4. In-place anonymization
  await env.DB.prepare(`
    UPDATE users 
    SET email = 'deleted_' || user_id, 
        oauth_id = NULL, 
        oauth_provider = NULL, 
        username = 'Deleted User', 
        password_hash = NULL, 
        avatar_url = NULL, 
        credits = 0 
    WHERE user_id = ?
  `).bind(session.userId).run();

  await env.DB.prepare("DELETE FROM user_oauth_bindings WHERE user_id = ?").bind(session.userId).run();
  await env.DB.prepare("DELETE FROM user_passkeys WHERE user_id = ?").bind(session.userId).run();

  // Clear cookie
  const response = Response.json({ success: true });
  response.headers.set(
    'Set-Cookie',
    `session=; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=0`
  );
  return response;
}

