import { Env } from "../types";
import { getSession } from "../auth/middleware";
import { getSinglePresignedPutUrl } from "../lib/r2s3";

const MAX_CHAT_FILE_SIZE = 25 * 1024 * 1024; // 25MB hard limit

export async function handleChatPresign(request: Request, env: Env): Promise<Response> {
  const session = await getSession(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { 
      status: 401, 
      headers: { "Content-Type": "application/json" } 
    });
  }

  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // 1. Quota check: Query DB for user credits
  const userRow = await env.DB.prepare(
    "SELECT credits FROM users WHERE user_id = ?"
  ).bind(session.userId).first<{ credits: number }>();

  const credits = userRow?.credits ?? 0;
  if (credits <= 0) {
    return new Response(JSON.stringify({ 
      error: "insufficient_quota", 
      message: "当前可用积分余额为 0 ⚡，无法上传附件或提交任务，请先充值额度。" 
    }), { 
      status: 403, 
      headers: { "Content-Type": "application/json" } 
    });
  }

  // 2. Parse request
  let body: { file_name?: string; file_size?: number; mime_type?: string; modality?: string };
  try {
    body = await request.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), { 
      status: 400, 
      headers: { "Content-Type": "application/json" } 
    });
  }

  const fileName = (body.file_name || 'upload.bin').replace(/[^a-zA-Z0-9._-]/g, '_');
  const fileSize = body.file_size || 0;
  const mimeType = body.mime_type || 'application/octet-stream';

  if (fileSize > MAX_CHAT_FILE_SIZE) {
    return new Response(JSON.stringify({ 
      error: "file_too_large", 
      message: "单文件超出 25MB 大小限制，请精简后重试。" 
    }), { 
      status: 400, 
      headers: { "Content-Type": "application/json" } 
    });
  }

  // 3. Generate presigned URL targeting tmp/ directory
  const assetId = crypto.randomUUID();
  const r2Key = `tmp/${session.userId}/${assetId}/${fileName}`;

  try {
    const uploadUrl = await getSinglePresignedPutUrl(env, r2Key, mimeType);
    return new Response(JSON.stringify({
      assetId,
      r2Key,
      uploadUrl,
      modality: body.modality || 'image'
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ 
      error: "presign_failed", 
      message: err.message || "Failed to generate presigned upload URL" 
    }), { 
      status: 500, 
      headers: { "Content-Type": "application/json" } 
    });
  }
}

export async function handleChatUpload(request: Request, env: Env): Promise<Response> {
  const session = await getSession(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { 
      status: 401, 
      headers: { "Content-Type": "application/json" } 
    });
  }

  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  // 1. Quota check
  const userRow = await env.DB.prepare(
    "SELECT credits FROM users WHERE user_id = ?"
  ).bind(session.userId).first<{ credits: number }>();

  const credits = userRow?.credits ?? 0;
  if (credits <= 0) {
    return new Response(JSON.stringify({ 
      error: "insufficient_quota", 
      message: "当前可用积分余额为 0 ⚡，无法上传附件，请先充值额度。" 
    }), { 
      status: 403, 
      headers: { "Content-Type": "application/json" } 
    });
  }

  // 2. Parse FormData
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch (err) {
    return new Response(JSON.stringify({ error: "Invalid multipart form data" }), { 
      status: 400, 
      headers: { "Content-Type": "application/json" } 
    });
  }

  const file = formData.get('file') as File | null;
  const modality = (formData.get('modality') as string) || 'image';

  if (!file) {
    return new Response(JSON.stringify({ error: "Missing file payload" }), { 
      status: 400, 
      headers: { "Content-Type": "application/json" } 
    });
  }

  if (file.size > MAX_CHAT_FILE_SIZE) {
    return new Response(JSON.stringify({ 
      error: "file_too_large", 
      message: "单文件超出 25MB 大小限制，请精简后重试。" 
    }), { 
      status: 400, 
      headers: { "Content-Type": "application/json" } 
    });
  }

  const fileName = (file.name || 'upload.bin').replace(/[^a-zA-Z0-9._-]/g, '_');
  const assetId = crypto.randomUUID();
  const r2Key = `tmp/${session.userId}/${assetId}/${fileName}`;
  const contentType = file.type || 'application/octet-stream';

  try {
    const fileBuf = await file.arrayBuffer();
    await env.R2.put(r2Key, fileBuf, {
      httpMetadata: {
        contentType: contentType
      },
      customMetadata: {
        userId: session.userId,
        originalName: fileName,
        assetId: assetId
      }
    });

    return new Response(JSON.stringify({
      assetId,
      r2Key,
      file_name: fileName,
      file_size: file.size,
      mime_type: contentType,
      modality
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });
  } catch (putErr: any) {
    console.error("Direct R2 upload error:", putErr);
    return new Response(JSON.stringify({ 
      error: "upload_failed", 
      message: putErr.message || "Failed to store file to R2" 
    }), { 
      status: 500, 
      headers: { "Content-Type": "application/json" } 
    });
  }
}

export async function handleGetAsset(request: Request, env: Env): Promise<Response> {
  const session = await getSession(request, env);
  if (!session) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { 
      status: 401, 
      headers: { "Content-Type": "application/json" } 
    });
  }

  const url = new URL(request.url);
  const key = url.searchParams.get("key");
  if (!key) {
    return new Response("Missing asset key", { status: 400 });
  }

  // Security check: Only allow user to access their own assets
  if (!key.startsWith(`tmp/${session.userId}/`)) {
    return new Response("Forbidden", { status: 403 });
  }

  const object = await env.R2.get(key);
  if (!object) {
    return new Response("Not Found", { status: 404 });
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "private, max-age=86400");
  return new Response(object.body, { headers });
}

