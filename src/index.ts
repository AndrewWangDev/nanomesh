import { Env } from "./types";
import { 
  handleRegister, handleLogin, handleSendCode, 
  handleLogout, handleMe, handleGitHubRedirect, 
  handleGoogleRedirect, handleGitHubCallback, 
  handleGoogleCallback, handleGetBindings, handleUnbindOAuth 
} from "./api/auth";
import { getSession } from "./auth/middleware";

function getCorsHeaders(env: Env) {
  return {
    "Access-Control-Allow-Origin": env.FRONTEND_URL,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Cookie",
    "Access-Control-Allow-Credentials": "true",
  };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: getCorsHeaders(env) });
    }

    try {
      if (url.pathname.startsWith("/api/")) {
        let res: Response;
        if (url.pathname.startsWith("/api/auth/oauth/") && request.method === "DELETE") {
           const provider = url.pathname.replace(/\/$/, "").split("/").pop();
           res = await handleUnbindOAuth(request, env, provider || "");
        } else if (url.pathname.startsWith("/api/admin/")) {
           const admin = await import("./api/admin");
           if (url.pathname === "/api/admin/login") res = await admin.handleAdminLogin(request, env);
           else if (url.pathname === "/api/admin/logout") res = await admin.handleAdminLogout(request, env);
           else if (url.pathname === "/api/admin/models" && request.method === "GET") res = await admin.handleAdminListModels(request, env);
           else if (url.pathname.endsWith("/download") && request.method === "GET") res = await admin.handleAdminDownload(request, env);
           else if (url.pathname === "/api/admin/gift-codes" && request.method === "POST") res = await admin.handleAdminCreateGiftCodes(request, env);
           else if (url.pathname === "/api/admin/gift-codes" && request.method === "GET") res = await admin.handleAdminListGiftCodes(request, env);
           else if (url.pathname.endsWith("/revoke") && request.method === "POST") res = await admin.handleAdminRevokeGiftCode(request, env);
           else if (url.pathname === "/api/admin/gift-codes/revoke-batch" && request.method === "POST") res = await admin.handleAdminRevokeBatch(request, env);
           else if (url.pathname === "/api/admin/notifications" && request.method === "GET") {
             const notif = await import("./api/notifications");
             res = await notif.handleAdminListNotifications(request, env);
           } else if (url.pathname === "/api/admin/notifications" && request.method === "POST") {
             const notif = await import("./api/notifications");
             res = await notif.handleAdminSendNotification(request, env);
           } else if (url.pathname.startsWith("/api/admin/notifications/") && request.method === "DELETE") {
             const notif = await import("./api/notifications");
             res = await notif.handleAdminRevokeNotification(request, env);
           }
           else if (request.method === "PATCH") res = await admin.handleAdminUpdateModel(request, env);
           else res = new Response("Not Found", { status: 404 });
        } else if (url.pathname === "/api/notifications" && request.method === "GET") {
           const { handleGetNotifications } = await import("./api/notifications");
           res = await handleGetNotifications(request, env);
        } else if (url.pathname === "/api/notifications/read-all" && request.method === "POST") {
           const { handleMarkAllAsRead } = await import("./api/notifications");
           res = await handleMarkAllAsRead(request, env);
        } else if (url.pathname.startsWith("/api/notifications/") && url.pathname.endsWith("/read") && request.method === "POST") {
           const notifId = url.pathname.split("/")[3];
           const { handleMarkAsRead } = await import("./api/notifications");
           res = await handleMarkAsRead(request, env, notifId);
        } else if (url.pathname.startsWith("/api/models/mine/") && request.method === "DELETE") {
           const { handleDeleteMyModel } = await import("./api/models");
           res = await handleDeleteMyModel(request, env);
        } else if (url.pathname === "/api/history" && request.method === "GET") {
           const { handleGetHistory } = await import("./api/history");
           res = await handleGetHistory(request, env);
        } else if (url.pathname === "/api/history" && request.method === "POST") {
           const { handleSaveHistory } = await import("./api/history");
           res = await handleSaveHistory(request, env);
        } else if (url.pathname.startsWith("/api/history/") && request.method === "PATCH") {
           const sessionId = url.pathname.slice("/api/history/".length);
           const { handleUpdateHistoryItem } = await import("./api/history");
           res = await handleUpdateHistoryItem(request, env, sessionId);
        } else if (url.pathname.startsWith("/api/history/") && request.method === "DELETE") {
           const sessionId = url.pathname.slice("/api/history/".length);
           const { handleDeleteHistoryItem } = await import("./api/history");
           res = await handleDeleteHistoryItem(request, env, sessionId);
        } else if (url.pathname.startsWith("/api/auth/passkey")) {
           const passkey = await import("./api/passkey");
           if (url.pathname === "/api/auth/passkey/register/options" && request.method === "POST") {
             res = await passkey.handlePasskeyRegisterOptions(request, env);
           } else if (url.pathname === "/api/auth/passkey/register/verify" && request.method === "POST") {
             res = await passkey.handlePasskeyRegisterVerify(request, env);
           } else if (url.pathname === "/api/auth/passkey/login/options" && request.method === "POST") {
             res = await passkey.handlePasskeyLoginOptions(request, env);
           } else if (url.pathname === "/api/auth/passkey/login/verify" && request.method === "POST") {
             res = await passkey.handlePasskeyLoginVerify(request, env);
           } else if ((url.pathname === "/api/auth/passkey/list" || url.pathname === "/api/auth/passkey") && request.method === "GET") {
             res = await passkey.handlePasskeyList(request, env);
           } else if (url.pathname.startsWith("/api/auth/passkey/") && request.method === "DELETE") {
             const credentialId = url.pathname.slice("/api/auth/passkey/".length);
             res = await passkey.handlePasskeyDelete(request, env, credentialId);
           } else {
             res = new Response("Not Found", { status: 404 });
           }
        } else {
          switch (url.pathname) {
            case "/api/auth/register":
              res = await handleRegister(request, env); break;
            case "/api/auth/login":
              res = await handleLogin(request, env); break;
            case "/api/auth/logout":
              res = await handleLogout(request, env); break;
            case "/api/auth/send-code":
              res = await handleSendCode(request, env); break;
            case "/api/auth/me":
              res = await handleMe(request, env); break;
            case "/api/user/bindings":
              res = await handleGetBindings(request, env); break;
            case "/api/auth/config":
              res = Response.json({ turnstile_site_key: env.TURNSTILE_SITE_KEY }); break;
            case "/api/auth/github":
              res = await handleGitHubRedirect(request, env); break;
            case "/api/auth/google":
              res = await handleGoogleRedirect(request, env); break;
            case "/api/auth/callback/github":
              res = await handleGitHubCallback(request, env); break;
            case "/api/auth/callback/google":
              res = await handleGoogleCallback(request, env); break;
            case "/api/user/profile": {
              const { handleUpdateProfile } = await import("./api/user");
              res = await handleUpdateProfile(request, env); break;
            }
            case "/api/user/delete": {
              const { handleDeleteAccount } = await import("./api/user");
              res = await handleDeleteAccount(request, env); break;
            }
            case "/api/user/avatar": {
              const { handleUpdateAvatar } = await import("./api/user");
              res = await handleUpdateAvatar(request, env); break;
            }
            case "/api/user/password": {
              const { handleUpdatePassword } = await import("./api/user");
              res = await handleUpdatePassword(request, env); break;
            }
            case "/api/user/ledger": {
              const { handleGetLedger } = await import("./api/billing");
              res = await handleGetLedger(request, env); break;
            }
            case "/api/billing/redeem": {
              const { handleRedeem } = await import("./api/billing");
              res = await handleRedeem(request, env); break;
            }
            case "/api/user/credits": {
              const user = await getSession(request, env);
              if (!user) return new Response("Unauthorized", { status: 401 });
              const dbUser = await env.DB.prepare("SELECT credits FROM users WHERE user_id = ?").bind(user.userId).first();
              res = Response.json({ credits: dbUser?.credits ?? 0 });
              break;
            }
            case "/api/models/upload/init": {
              const { handleUploadInit } = await import("./api/models");
              res = await handleUploadInit(request, env); break;
            }
            case "/api/models/upload/complete": {
              const { handleUploadComplete } = await import("./api/models");
              res = await handleUploadComplete(request, env); break;
            }
            case "/api/models/upload/abort": {
              const { handleUploadAbort } = await import("./api/models");
              res = await handleUploadAbort(request, env); break;
            }
            case "/api/models/mine": {
              const { handleListMyModels } = await import("./api/models");
              res = await handleListMyModels(request, env); break;
            }
            case "/api/chat": {
              const { handleChat } = await import("./api/chat");
              res = await handleChat(request, env); break;
            }
            case "/api/upload/presign": {
              const { handleChatPresign } = await import("./api/presign");
              res = await handleChatPresign(request, env); break;
            }
            case "/api/upload/file": {
              const { handleChatUpload } = await import("./api/presign");
              res = await handleChatUpload(request, env); break;
            }
            case "/api/asset": {
              const { handleGetAsset } = await import("./api/presign");
              res = await handleGetAsset(request, env); break;
            }
            default:
              res = new Response("Not Found", { status: 404 }); break;
          }
        }

        // Add CORS headers to API responses
        const newRes = new Response(res.body, res);
        Object.entries(getCorsHeaders(env)).forEach(([k, v]) => newRes.headers.set(k, v));
        newRes.headers.set("X-Content-Type-Options", "nosniff");
        return newRes;
      }

      if (url.pathname === "/") {
        // Guests are allowed on the index page, no redirect
      }

      if (url.pathname === "/terms" || url.pathname === "/terms/" || url.pathname === "/terms.html") {
        const assetRes = await env.ASSETS.fetch(new Request(new URL("/terms.html", request.url)));
        const res = new Response(assetRes.body, assetRes);
        res.headers.set("X-Robots-Tag", "noindex, follow");
        return res;
      }

      if (url.pathname === "/privacy" || url.pathname === "/privacy/" || url.pathname === "/privacy.html") {
        const assetRes = await env.ASSETS.fetch(new Request(new URL("/privacy.html", request.url)));
        const res = new Response(assetRes.body, assetRes);
        res.headers.set("X-Robots-Tag", "noindex, follow");
        return res;
      }
      
      // Serve R2 Storage (strictly restricted to public avatars)
      if (url.pathname.startsWith("/storage/")) {
        const key = url.pathname.slice("/storage/".length);
        if (!key.startsWith("avatars/")) {
          return new Response("Forbidden", { status: 403 });
        }
        const object = await env.R2.get(key);
        if (!object) return new Response("Not Found", { status: 404 });
        
        const headers = new Headers();
        object.writeHttpMetadata(headers);
        headers.set("etag", object.httpEtag);
        // Cache control for immutable assets
        headers.set("cache-control", "public, max-age=31536000, immutable");
        
        return new Response(object.body, { headers });
      }
      
            // Pass other requests to ASSETS (static site)
      const assetResponse = await env.ASSETS.fetch(request);
      if (assetResponse.status === 404) {
        const notFoundUrl = new URL('/404', request.url);
        const fallbackResponse = await env.ASSETS.fetch(new Request(notFoundUrl));
        return new Response(fallbackResponse.body, {
          status: 404,
          headers: {
            'Content-Type': 'text/html;charset=UTF-8',
            'X-Content-Type-Options': 'nosniff'
          }
        });
      }
      const secureAssetRes = new Response(assetResponse.body, assetResponse);
      secureAssetRes.headers.set("X-Content-Type-Options", "nosniff");
      if (url.pathname.match(/^\/(favicon|apple-touch-icon|android-chrome)/)) {
        secureAssetRes.headers.set("Cache-Control", "public, max-age=86400, stale-while-revalidate=604800");
      }
      return secureAssetRes;
      
    } catch (err: any) {
      console.error(err);
      return new Response(JSON.stringify({ error: err.message || "Internal Server Error" }), { 
        status: 500, 
        headers: { "Content-Type": "application/json", ...getCorsHeaders(env) } 
      });
    }
  }
};



