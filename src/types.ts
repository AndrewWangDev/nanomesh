export interface Env {
  DB: D1Database;
  AI: any;
  R2: R2Bucket;
  ASSETS: Fetcher;

  JWT_SECRET: string;
  TURNSTILE_SECRET_KEY: string;
  RESEND_API_KEY: string;

  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;

  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;

  R2_ACCESS_KEY_ID: string;
  R2_SECRET_ACCESS_KEY: string;
  Cloudflare_Account_ID: string;

  ADMIN_PASSWORD?: string;
  TURNSTILE_SITE_KEY: string;
  RESEND_FROM_EMAIL: string;
  BACKEND_URL: string;
  FRONTEND_URL: string;
}

export interface User {
  user_id: string;
  username: string;
  email: string;
  avatar_url: string | null;
  credits: number;
  frozen_credits: number;
}

export interface SessionPayload {
  userId: string;
  iat?: number;
  exp?: number;
}
