import { Env } from "../types";
import { signJWT } from "./jwt";

// GitHub
export async function getGitHubAuthURL(env: Env, action: string = 'login'): Promise<string> {
  const state = await signJWT({ nonce: crypto.randomUUID(), action }, env.JWT_SECRET, 300); // 5 min
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
  url.searchParams.set("redirect_uri", `${env.FRONTEND_URL}/api/auth/callback/github`);
  url.searchParams.set("scope", "user:email");
  url.searchParams.set("state", state);
  return url.toString();
}

export async function handleGitHubCallback(code: string, state: string, env: Env) {
  // Exchange code for token
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json"
    },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
      redirect_uri: `${env.FRONTEND_URL}/api/auth/callback/github`
    })
  });
  
  const tokenData: any = await tokenRes.json();
  if (tokenData.error) throw new Error(tokenData.error_description || tokenData.error);
  
  const accessToken = tokenData.access_token;
  
  // Fetch user info
  const userRes = await fetch("https://api.github.com/user", {
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "User-Agent": "NanoMesh-Auth"
    }
  });
  const userData: any = await userRes.json();
  
  // Fetch user emails
  const emailsRes = await fetch("https://api.github.com/user/emails", {
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "User-Agent": "NanoMesh-Auth"
    }
  });
  const emailsData: any[] = await emailsRes.json();
  const primaryEmail = emailsData.find(e => e.primary)?.email || emailsData[0]?.email;
  
  return {
    id: String(userData.id),
    email: primaryEmail,
    username: userData.login,
    avatar_url: userData.avatar_url
  };
}

// Google
export async function getGoogleAuthURL(env: Env, action: string = 'login'): Promise<string> {
  const state = await signJWT({ nonce: crypto.randomUUID(), action }, env.JWT_SECRET, 300); // 5 min
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", env.GOOGLE_CLIENT_ID);
  url.searchParams.set("redirect_uri", `${env.FRONTEND_URL}/api/auth/callback/google`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "email profile");
  url.searchParams.set("state", state);
  return url.toString();
}

export async function handleGoogleCallback(code: string, state: string, env: Env) {
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: `${env.FRONTEND_URL}/api/auth/callback/google`
    }).toString()
  });
  
  const tokenData: any = await tokenRes.json();
  if (tokenData.error) throw new Error(tokenData.error_description || tokenData.error);
  
  const accessToken = tokenData.access_token;
  
  const userRes = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { "Authorization": `Bearer ${accessToken}` }
  });
  const userData: any = await userRes.json();
  
  return {
    id: userData.id,
    email: userData.email,
    name: userData.name || userData.email.split('@')[0],
    picture: userData.picture
  };
}
