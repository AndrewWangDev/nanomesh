import { Env } from "../types";
import { getSession } from "../auth/middleware";
import {
  createMultipartUpload,
  getPresignedUrls,
  completeMultipartUpload,
  abortMultipartUpload,
  deleteObject
} from "../lib/r2s3";

const CHUNK_SIZE = 64 * 1024 * 1024; // 64MB
const MAX_FILE_SIZE = 3 * 1024 * 1024 * 1024; // 3GB

export async function handleUploadInit(request: Request, env: Env): Promise<Response> {
  const session = await getSession(request, env);
  if (!session) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  
  const body = await request.json() as { file_name: string; file_size: number; contentType?: string; display_name?: string; param_scale?: string; in_modalities?: string; out_modality?: string; capability_tags?: string; context_window?: number; description?: string; };
  
  if (body.file_size > MAX_FILE_SIZE) {
    return new Response(JSON.stringify({ error: "errorFileTooLarge" }), { status: 400 });
  }
  
  const pendingCountRow = await env.DB.prepare(
    "SELECT COUNT(*) as count FROM user_uploaded_models WHERE user_id = ? AND status = 'pending'"
  ).bind(session.userId).first();
  
  const pendingCount = (pendingCountRow?.count as number) || 0;
  if (pendingCount >= 3) {
    return new Response(JSON.stringify({ error: "errorMaxPending" }), { status: 403 });
  }
  
  const upload_id = crypto.randomUUID();
  const objectKey = `models/${session.userId}/${upload_id}/${body.file_name}`;
  const contentType = body.contentType || 'application/octet-stream';
  
  const r2_upload_id = await createMultipartUpload(env, objectKey, contentType);
  
  const partsCount = Math.ceil(body.file_size / CHUNK_SIZE);
  const urls = await getPresignedUrls(env, objectKey, r2_upload_id, partsCount);
  
  await env.DB.prepare(
    `INSERT INTO user_uploaded_models 
     (upload_id, user_id, file_name, r2_object_key, file_size, status, r2_upload_id, display_name, param_scale, in_modalities, out_modality, capability_tags, context_window, description)
     VALUES (?, ?, ?, ?, ?, 'uploading', ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(upload_id, session.userId, body.file_name, objectKey, body.file_size, r2_upload_id, body.display_name || '', body.param_scale || '', body.in_modalities || '', body.out_modality || '', body.capability_tags || '', body.context_window || 4096, body.description || '').run();
  
  return Response.json({ uploadId: upload_id, parts: urls });
}

export async function handleUploadComplete(request: Request, env: Env): Promise<Response> {
  const session = await getSession(request, env);
  if (!session) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  
  const body = await request.json() as { uploadId: string; parts: { PartNumber: number, ETag: string }[] };
  
  const model = await env.DB.prepare(
    "SELECT * FROM user_uploaded_models WHERE upload_id = ? AND user_id = ?"
  ).bind(body.uploadId, session.userId).first();
  
  if (!model) return new Response("Not found", { status: 404 });
  if (model.status !== 'uploading') return new Response("Invalid status", { status: 400 });
  
  await completeMultipartUpload(env, model.r2_object_key as string, model.r2_upload_id as string, body.parts);
  
  await env.DB.prepare(
    "UPDATE user_uploaded_models SET status = 'pending' WHERE upload_id = ?"
  ).bind(body.uploadId).run();
  
  return Response.json({ success: true });
}

export async function handleUploadAbort(request: Request, env: Env): Promise<Response> {
  const session = await getSession(request, env);
  if (!session) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  
  if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });
  
  const body = await request.json() as { uploadId: string };
  
  const model = await env.DB.prepare(
    "SELECT * FROM user_uploaded_models WHERE upload_id = ? AND user_id = ?"
  ).bind(body.uploadId, session.userId).first();
  
  if (!model) return new Response("Not found", { status: 404 });
  if (model.status !== 'uploading') return new Response("Invalid status", { status: 400 });
  
  await abortMultipartUpload(env, model.r2_object_key as string, model.r2_upload_id as string);
  
  await env.DB.prepare(
    "DELETE FROM user_uploaded_models WHERE upload_id = ?"
  ).bind(body.uploadId).run();
  
  return Response.json({ success: true });
}

export async function handleListMyModels(request: Request, env: Env): Promise<Response> {
  const session = await getSession(request, env);
  if (!session) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
  
  const { results } = await env.DB.prepare(
    `SELECT uum.*, m.usage_count as live_usage, m.user_rating as live_rating 
     FROM user_uploaded_models uum 
     LEFT JOIN models m ON uum.live_model_id = m.model_id 
     WHERE uum.user_id = ? AND uum.status != 'uploading' 
     ORDER BY uum.created_at DESC`
  ).bind(session.userId).all();
  
  return Response.json({ models: results });
}

export async function handleDeleteMyModel(request: Request, env: Env): Promise<Response> {
  const session = await getSession(request, env);
  if (!session) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  
  if (request.method !== "DELETE") return new Response("Method not allowed", { status: 405 });
  
  const url = new URL(request.url);
  const pathParts = url.pathname.split('/');
  const modelId = pathParts[pathParts.length - 1];
  
  const model = await env.DB.prepare(
    "SELECT * FROM user_uploaded_models WHERE upload_id = ? AND user_id = ?"
  ).bind(modelId, session.userId).first();
  
  if (!model) return new Response("Not found", { status: 404 });
  
  if (!['pending', 'rejected', 'uploading'].includes(model.status as string)) {
    return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 });
  }
  
  try {
    if (model.status === 'uploading' && model.r2_upload_id) {
        await abortMultipartUpload(env, model.r2_object_key as string, model.r2_upload_id as string);
    } else {
        await deleteObject(env, model.r2_object_key as string);
    }
  } catch(err) {
    console.error("Cleanup error", err);
  }
  
  await env.DB.prepare(
    "DELETE FROM user_uploaded_models WHERE upload_id = ?"
  ).bind(modelId).run();
  
  return Response.json({ success: true });
}
