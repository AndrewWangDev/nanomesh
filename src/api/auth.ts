import { Env, User } from "../types";
import { verifyTurnstile } from "../auth/turnstile";
import { signJWT, verifyJWT } from "../auth/jwt";
import { getSession } from "../auth/middleware";
import { getGitHubAuthURL, getGoogleAuthURL, handleGitHubCallback as ghCallback, handleGoogleCallback as goCallback } from "../auth/oauth";
import * as bcrypt from "bcryptjs";

const VALID_EMAIL_DOMAINS = ["gmail.com", "outlook.com", "yahoo.com", "protonmail.com", "icloud.com", "hotmail.com"];

function isValidEmailDomain(email: string) {
  const parts = email.split("@");
  if (parts.length !== 2) return false;
  return VALID_EMAIL_DOMAINS.includes(parts[1].toLowerCase());
}

const SESSION_TTL_SECONDS = 30 * 24 * 3600; // 30 days (2,592,000s)

function setCookieHeaders(token: string | null): Headers {
  const headers = new Headers();
  if (token) {
    headers.set("Set-Cookie", `session=${token}; HttpOnly; Path=/; Max-Age=${SESSION_TTL_SECONDS}; SameSite=Lax; Secure`);
  } else {
    headers.set("Set-Cookie", `session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax; Secure`);
  }
  headers.set("Content-Type", "application/json");
  return headers;
}

function generateReferralCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(3));
  return 'NM-' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase().substring(0, 6);
}

export async function handleRegister(req: Request, env: Env) {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const body: any = await req.json().catch(() => ({}));
  
  let { username, email, password, code, turnstile_token, referral_code } = body;
  if (typeof email === 'string') email = email.toLowerCase().trim();
  
  if (!await verifyTurnstile(turnstile_token, env.TURNSTILE_SECRET_KEY)) {
    return Response.json({ error: "error.invalidCaptcha" }, { status: 400 });
  }

  if (!isValidEmailDomain(email)) {
    return Response.json({ error: "error.unsupportedEmailDomain" }, { status: 400 });
  }
  
  if (!username || !/^[a-zA-Z0-9_-]{3,20}$/.test(username)) {
    return Response.json({ error: "error.invalidUsernameFormat" }, { status: 400 });
  }
  
  if (!password || password.length < 8 || password.length > 64 || !/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) {
    return Response.json({ error: "error.invalidPasswordFormat" }, { status: 400 });
  }

  // Check code
  const codeRecord = await env.DB.prepare("SELECT * FROM verification_codes WHERE email = ? AND code = ? AND expires_at > datetime('now')").bind(email || '', code || '').first();
  if (!codeRecord) {
    return Response.json({ error: "error.invalidCode" }, { status: 400 });
  }

  // Check tombstone (90-day cooldown)
  const encoder = new TextEncoder();
  const emailData = encoder.encode(email + env.JWT_SECRET);
  const emailHashBuffer = await crypto.subtle.digest('SHA-256', emailData);
  const emailHash = Array.from(new Uint8Array(emailHashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
  
  const tombstone = await env.DB.prepare("SELECT expires_at FROM account_tombstones WHERE hash_id = ? AND expires_at > datetime('now')").bind(emailHash).first();
  if (tombstone) {
    return Response.json({ error: "error.accountCooldown" }, { status: 403 });
  }

  // Check uniqueness
  const existing = await env.DB.prepare("SELECT user_id FROM users WHERE email = ? OR username = ?").bind(email || '', username || '').first();
  if (existing) {
    return Response.json({ error: "error.userOrEmailExists" }, { status: 400 });
  }

  // Validate referral code if provided
  let referrerId: string | null = null;
  if (referral_code && typeof referral_code === 'string' && referral_code.trim()) {
    const referrer = await env.DB.prepare("SELECT user_id FROM users WHERE referral_code = ?").bind(referral_code.trim().toUpperCase()).first<{user_id: string}>();
    if (!referrer) {
      return Response.json({ error: "error.invalidReferralCode" }, { status: 400 });
    }
    referrerId = referrer.user_id;
  }

  const hash = bcrypt.hashSync(password, 10);
  const userId = crypto.randomUUID();
  const newReferralCode = generateReferralCode();
  const initialCredits = referrerId ? 150 : 100;

  await env.DB.prepare(`
    INSERT INTO users (user_id, username, email, password_hash, credits, referral_code, referred_by) 
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(userId || '', username || '', email || '', hash || '', initialCredits, newReferralCode, referrerId).run();

  // Write signup bonus ledger entry (100)
  await env.DB.prepare(`
    INSERT INTO credit_ledger (ledger_id, user_id, category, amount, balance, title, detail)
    VALUES (?, ?, 'signup_bonus', 100, 100, 'Signup Bonus', 'Welcome credit pack')
  `).bind(crypto.randomUUID(), (userId || '')).run();

  // If referred, reward both the new user (+50) and the referrer (+50)
  if (referrerId) {
    // 1. Reward the new user +50 (bringing balance to 150)
    await env.DB.prepare(`
      INSERT INTO credit_ledger (ledger_id, user_id, category, amount, balance, title, detail, related_id)
      VALUES (?, ?, 'referral_reward', 50, 150, 'Referral Bonus', 'Invited by friend', ?)
    `).bind(crypto.randomUUID(), (userId || ''), referrerId).run();

    // 2. Reward the referrer +50
    await env.DB.prepare("UPDATE users SET credits = credits + 50 WHERE user_id = ?").bind(referrerId).run();
    const referrerCredits = await env.DB.prepare("SELECT credits FROM users WHERE user_id = ?").bind(referrerId).first<{credits: number}>();
    await env.DB.prepare(`
      INSERT INTO credit_ledger (ledger_id, user_id, category, amount, balance, title, detail, related_id)
      VALUES (?, ?, 'referral_reward', 50, ?, 'Referral Reward', ?, ?)
    `).bind(crypto.randomUUID(), referrerId, referrerCredits?.credits || 0, username, (userId || '')).run();
  }

  await env.DB.prepare("DELETE FROM verification_codes WHERE id = ?").bind(codeRecord.id).run();

  const token = await signJWT({ userId }, env.JWT_SECRET, SESSION_TTL_SECONDS);
  
  return new Response(JSON.stringify({ user_id: (userId || ''), username, email, credits: initialCredits }), {
    headers: setCookieHeaders(token)
  });
}

export async function handleLogin(req: Request, env: Env) {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const body: any = await req.json().catch(() => ({}));
  
  let { email, password, turnstile_token } = body;
  if (typeof email === 'string') email = email.toLowerCase().trim();
  
  if (!await verifyTurnstile(turnstile_token, env.TURNSTILE_SECRET_KEY)) {
    return Response.json({ error: "Invalid captcha" }, { status: 400 });
  }

  const user = await env.DB.prepare("SELECT * FROM users WHERE LOWER(email) = ?").bind(email || '').first<User & { password_hash: string | null }>();
  if (!user) return Response.json({ error: "Invalid credentials" }, { status: 401 });
  
  if (!user.password_hash) {
    return Response.json({ error: "Please login with OAuth" }, { status: 401 });
  }

  const valid = bcrypt.compareSync(password, user.password_hash);
  if (!valid) return Response.json({ error: "Invalid credentials" }, { status: 401 });

  const token = await signJWT({ userId: user.user_id }, env.JWT_SECRET, SESSION_TTL_SECONDS);
  
  return new Response(JSON.stringify({ 
    user_id: user.user_id, 
    username: user.username, 
    email: user.email, 
    credits: user.credits 
  }), { headers: setCookieHeaders(token) });
}

export async function handleSendCode(req: Request, env: Env) {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const body: any = await req.json().catch(() => ({}));
  let { email, turnstile_token, lang } = body;
  
  if (typeof email === 'string') email = email.toLowerCase().trim();

  if (!await verifyTurnstile(turnstile_token, env.TURNSTILE_SECRET_KEY)) {
    return Response.json({ error: "error.invalidCaptcha" }, { status: 400 });
  }

  if (!isValidEmailDomain(email)) {
    return Response.json({ error: "error.unsupportedEmailDomain" }, { status: 400 });
  }

  const counter = await env.DB.prepare("SELECT value FROM system_counters WHERE key = 'emails_sent'").first<{value: number}>();
  if (counter && counter.value >= 500) {
    return Response.json({ error: "error.dailyEmailLimit" }, { status: 429 });
  }

  const recent = await env.DB.prepare("SELECT id FROM verification_codes WHERE LOWER(email) = ? AND created_at > datetime('now', '-60 seconds')").bind(email || '').first();
  if (recent) {
    return Response.json({ error: "error.wait60s" }, { status: 429 });
  }

  const code = Math.floor(100000 + Math.random() * 900000).toString();

  await env.DB.prepare(`
    INSERT INTO verification_codes (email, code, expires_at) 
    VALUES (?, ?, datetime('now', '+10 minutes'))
  `).bind(email || '', code || '').run();

  const isZh = lang === 'zh';
  const subject = isZh ? "[NanoMesh] 您的注册验证码" : "[NanoMesh] Your Verification Code";
  
  const textGreeting = isZh ? "您好！感谢您注册 NanoMesh。" : "Hello! Thank you for registering for NanoMesh.";
  const textHint = isZh ? "该验证码将在 10 分钟后过期。如果您未请求此验证码，请忽略此邮件。" : "This code will expire in 10 minutes. If you did not request this code, please ignore this email.";
  const textFooter = isZh ? "&copy; 2026 NanoMesh 灵微络. 保留所有权利。" : "&copy; 2026 NanoMesh. All rights reserved.";

  const htmlContent = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; color: #333;">
      <h2 style="color: #00e5ff; margin-bottom: 24px; font-weight: normal;">NanoMesh ${isZh ? '灵微络' : ''}</h2>
      <p style="font-size: 16px; margin-bottom: 16px;">${textGreeting}</p>
      <div style="background-color: #f3f4f6; border-radius: 8px; padding: 24px; text-align: center; margin-bottom: 24px;">
        <span style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #111827;">${code}</span>
      </div>
      <p style="font-size: 14px; color: #6b7280; margin-bottom: 32px;">${textHint}</p>
      <hr style="border: none; border-top: 1px solid #e5e7eb; margin-bottom: 16px;">
      <p style="font-size: 12px; color: #9ca3af; text-align: center;">${textFooter}</p>
    </div>
  `;

  const resendRes = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      from: `NanoMesh <${env.RESEND_FROM_EMAIL}>`,
      to: email,
      subject: subject,
      html: htmlContent
    })
  });

  if (!resendRes.ok) {
    return Response.json({ error: "error.emailSendFailed" }, { status: 500 });
  }

  await env.DB.prepare("UPDATE system_counters SET value = value + 1 WHERE key = 'emails_sent'").run();

  return Response.json({ success: true });
}

export async function handleLogout(req: Request, env: Env) {
  return new Response(JSON.stringify({ success: true }), { headers: setCookieHeaders(null) });
}

export async function handleMe(req: Request, env: Env) {
  const session = await getSession(req, env);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const user = await env.DB.prepare("SELECT user_id, username, email, credits, frozen_credits, avatar_url, avatar_updated_at, referral_code, password_hash IS NOT NULL as has_password FROM users WHERE user_id = ?").bind(session.userId || '').first();
  if (!user) return Response.json({ error: "Not found" }, { status: 404 });

  return Response.json({ ...user, has_password: !!user.has_password });
}

export async function handleGitHubRedirect(req: Request, env: Env) {
  const urlObj = new URL(req.url);
  const action = urlObj.searchParams.get("action") || "login";
  const url = await getGitHubAuthURL(env, action);
  return Response.redirect(url, 302);
}

export async function handleGoogleRedirect(req: Request, env: Env) {
  const urlObj = new URL(req.url);
  const action = urlObj.searchParams.get("action") || "login";
  const url = await getGoogleAuthURL(env, action);
  return Response.redirect(url, 302);
}

async function handleOAuthCallback(req: Request, env: Env, provider: 'github' | 'google', callbackFn: any) {
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (!code || !state) return Response.redirect(`${env.FRONTEND_URL}/login.html?error=missing_params`);

  const payload = await verifyJWT(state, env.JWT_SECRET);
  if (!payload || !payload.nonce) {
    return Response.redirect(`${env.FRONTEND_URL}/login.html?error=invalid_state`);
  }

  const isBindAction = payload.action === 'bind';

  try {
    const profile = await callbackFn(code, state, env);
    const session = await getSession(req, env);
    const avatarToSet = profile.avatar_url || profile.picture || null;
    let userId;

    // Check tombstone for OAuth ID
    const encoder = new TextEncoder();
    const oauthData = encoder.encode(profile.id + env.JWT_SECRET);
    const oauthHashBuffer = await crypto.subtle.digest('SHA-256', oauthData);
    const oauthHash = Array.from(new Uint8Array(oauthHashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
    
    const tombstone = await env.DB.prepare("SELECT expires_at FROM account_tombstones WHERE hash_id = ? AND expires_at > datetime('now')").bind(oauthHash || '').first();
    if (tombstone) {
      return Response.redirect(`${env.FRONTEND_URL}/login.html?error=account_cooldown`);
    }

    let activeUser = null;
    if (session && session.userId) {
      activeUser = await env.DB.prepare("SELECT user_id, avatar_url FROM users WHERE user_id = ?").bind(session.userId).first<any>();
    }

    if (isBindAction && activeUser) {
      // Track 2: User explicitly clicked "Bind" from Settings while logged in
      userId = activeUser.user_id;
      await env.DB.prepare("INSERT OR IGNORE INTO user_oauth_bindings (user_id, provider, provider_id) VALUES (?, ?, ?)")
        .bind(userId || '', provider, String(profile.id || '')).run();
      
      if (avatarToSet && !activeUser.avatar_url) {
        await env.DB.prepare("UPDATE users SET avatar_url = ? WHERE user_id = ?").bind(avatarToSet, userId).run();
      }
    } else {
      // Track 1: Login / Register
      let binding = await env.DB.prepare("SELECT user_id FROM user_oauth_bindings WHERE provider = ? AND provider_id = ?").bind(provider, String(profile.id || '')).first<any>();

      if (binding) {
        userId = binding.user_id;
        if (avatarToSet) {
          const existing = await env.DB.prepare("SELECT avatar_url FROM users WHERE user_id = ?").bind(userId || '').first<any>();
          if (!existing?.avatar_url) {
            await env.DB.prepare("UPDATE users SET avatar_url = ? WHERE user_id = ?").bind(avatarToSet, (userId || '')).run();
          }
        }
      } else {
        // Check if email already registered
      const existingUser = await env.DB.prepare("SELECT user_id, avatar_url FROM users WHERE LOWER(email) = ?").bind((profile.email || "").toLowerCase()).first<any>();
      if (existingUser) {
        userId = existingUser.user_id;
        if (avatarToSet && !existingUser.avatar_url) {
          await env.DB.prepare("UPDATE users SET avatar_url = ? WHERE user_id = ?").bind(avatarToSet, (userId || '')).run();
        }
        // Bind to existing user
        await env.DB.prepare("INSERT OR IGNORE INTO user_oauth_bindings (user_id, provider, provider_id) VALUES (?, ?, ?)").bind(userId || '', provider, String(profile.id || '')).run();
      } else {
        userId = crypto.randomUUID();
        const oauthReferralCode = generateReferralCode();
        // Insert new user
        await env.DB.prepare(`
          INSERT INTO users (user_id, username, email, avatar_url, credits, referral_code)
          VALUES (?, ?, ?, ?, 100, ?)
        `).bind(userId || '', profile.username || profile.name || ('user_' + Math.random().toString(36).slice(2, 8)), (profile.email || "").toLowerCase(), avatarToSet, oauthReferralCode).run();
        // Write signup bonus ledger
        await env.DB.prepare(`
          INSERT INTO credit_ledger (ledger_id, user_id, category, amount, balance, title, detail)
          VALUES (?, ?, 'signup_bonus', 100, 100, 'Signup Bonus', 'Welcome credit pack')
        `).bind(crypto.randomUUID(), (userId || '')).run();
        // Bind new user
        await env.DB.prepare("INSERT INTO user_oauth_bindings (user_id, provider, provider_id) VALUES (?, ?, ?)").bind(userId || '', provider, String(profile.id || '')).run();
      }
    }
  }

    const token = await signJWT({ userId }, env.JWT_SECRET, SESSION_TTL_SECONDS);
    // Cannot use Response.redirect() — it returns an immutable response.
    // Must manually construct response with Location + Set-Cookie.
    return new Response(null, {
      status: 302,
      headers: {
        "Location": `${env.FRONTEND_URL}/`,
        "Set-Cookie": `session=${token}; HttpOnly; Path=/; Max-Age=${SESSION_TTL_SECONDS}; SameSite=Lax; Secure`,
      },
    });
  } catch (e: any) {
    return Response.redirect(`${env.FRONTEND_URL}/login.html?error=${encodeURIComponent(e.message)}`);
  }
}

export async function handleGitHubCallback(req: Request, env: Env) {
  return handleOAuthCallback(req, env, 'github', ghCallback);
}

export async function handleGoogleCallback(req: Request, env: Env) {
  return handleOAuthCallback(req, env, 'google', goCallback);
}

export async function handleGetBindings(req: Request, env: Env) {
  const session = await getSession(req, env);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const bindings = await env.DB.prepare("SELECT provider FROM user_oauth_bindings WHERE user_id = ?").bind(session.userId || '').all();
  return Response.json({ bindings: bindings.results.map(r => r.provider) });
}

export async function handleUnbindOAuth(req: Request, env: Env, provider: string) {
  const session = await getSession(req, env);
  if (!session) return Response.json({ error: "Unauthorized" }, { status: 401 });

  // Safety check: don't allow unbinding if they have no password and this is their LAST binding
  const user = await env.DB.prepare("SELECT password_hash FROM users WHERE user_id = ?").bind(session.userId || '').first<any>();
  const bindings = await env.DB.prepare("SELECT provider FROM user_oauth_bindings WHERE user_id = ?").bind(session.userId || '').all();

  if (!user?.password_hash && (!bindings.results || bindings.results.length <= 1)) {
    return Response.json({ error: "Cannot unbind last login method without a password." }, { status: 400 });
  }

  await env.DB.prepare("DELETE FROM user_oauth_bindings WHERE user_id = ? AND provider = ?").bind(session.userId, provider).run();
  
  return Response.json({ success: true });
}
