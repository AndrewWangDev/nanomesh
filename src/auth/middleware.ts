import { Env, SessionPayload } from "../types";
import { verifyJWT } from "./jwt";

export async function getSession(request: Request, env: Env): Promise<SessionPayload | null> {
  let token: string | null = null;

  // 1. Check Authorization header (Bearer token)
  const authHeader = request.headers.get("Authorization");
  if (authHeader && authHeader.startsWith("Bearer ")) {
    token = authHeader.slice(7).trim();
  }

  // 2. Fall back to Cookie
  if (!token) {
    const cookieHeader = request.headers.get("Cookie");
    if (cookieHeader) {
      const match = cookieHeader.match(/session=([^;]+)/);
      if (match) token = match[1];
    }
  }

  if (!token) return null;

  const payload = await verifyJWT(token, env.JWT_SECRET);
  return payload as SessionPayload | null;
}

export async function requireAuth(request: Request, env: Env): Promise<SessionPayload | Response> {
  const session = await getSession(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { 
      status: 401, 
      headers: { "Content-Type": "application/json" } 
    });
  }
  return session;
}
