import { Env, SessionPayload } from "../types";
import { verifyJWT } from "./jwt";

export async function getSession(request: Request, env: Env): Promise<SessionPayload | null> {
  const cookieHeader = request.headers.get("Cookie");
  if (!cookieHeader) return null;

  const match = cookieHeader.match(/session=([^;]+)/);
  if (!match) return null;

  const token = match[1];
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
