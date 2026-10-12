import { AwsClient } from 'aws4fetch';
import { Env } from '../types';

function getClient(env: Env) {
  return new AwsClient({
    accessKeyId: env.R2_ACCESS_KEY_ID,
    secretAccessKey: env.R2_SECRET_ACCESS_KEY,
    service: 's3',
    region: 'auto'
  });
}

function getEndpoint(env: Env) {
  return `https://${env.Cloudflare_Account_ID}.r2.cloudflarestorage.com/nanomesh-assets`;
}

export async function createMultipartUpload(env: Env, objectKey: string, contentType: string = 'application/octet-stream'): Promise<string> {
  const aws = getClient(env);
  const url = `${getEndpoint(env)}/${objectKey}?uploads`;
  const response = await aws.fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': contentType
    }
  });
  
  if (!response.ok) {
    throw new Error(`Failed to create multipart upload: ${await response.text()}`);
  }
  
  const text = await response.text();
  const match = text.match(/<UploadId>(.*?)<\/UploadId>/);
  if (!match) throw new Error('UploadId not found in S3 response');
  return match[1];
}

export async function getPresignedUrls(env: Env, objectKey: string, uploadId: string, partsCount: number): Promise<string[]> {
  const aws = getClient(env);
  const endpoint = getEndpoint(env);
  const urls: string[] = [];
  
  for (let i = 1; i <= partsCount; i++) {
    const url = new URL(`${endpoint}/${objectKey}?partNumber=${i}&uploadId=${uploadId}`);
    const request = await aws.sign(url, {
      method: 'PUT',
      aws: { signQuery: true }
    });
    urls.push(request.url);
  }
  return urls;
}

export async function completeMultipartUpload(env: Env, objectKey: string, uploadId: string, parts: { PartNumber: number, ETag: string }[]): Promise<void> {
  const aws = getClient(env);
  const url = `${getEndpoint(env)}/${objectKey}?uploadId=${uploadId}`;
  
  parts.sort((a, b) => a.PartNumber - b.PartNumber);
  
  const body = `
    <CompleteMultipartUpload>
      ${parts.map(p => `<Part><PartNumber>${p.PartNumber}</PartNumber><ETag>${p.ETag}</ETag></Part>`).join('')}
    </CompleteMultipartUpload>
  `;
  
  const response = await aws.fetch(url, {
    method: 'POST',
    body
  });
  
  if (!response.ok) {
    throw new Error(`Failed to complete multipart upload: ${await response.text()}`);
  }
}

export async function abortMultipartUpload(env: Env, objectKey: string, uploadId: string): Promise<void> {
  const aws = getClient(env);
  const url = `${getEndpoint(env)}/${objectKey}?uploadId=${uploadId}`;
  
  const response = await aws.fetch(url, {
    method: 'DELETE'
  });
  
  if (!response.ok) {
    throw new Error(`Failed to abort multipart upload: ${await response.text()}`);
  }
}

export async function deleteObject(env: Env, objectKey: string): Promise<void> {
  const aws = getClient(env);
  const url = `${getEndpoint(env)}/${objectKey}`;
  
  const response = await aws.fetch(url, {
    method: 'DELETE'
  });
  
  if (!response.ok) {
    throw new Error(`Failed to delete object: ${await response.text()}`);
  }
}

export async function getSinglePresignedPutUrl(env: Env, objectKey: string, contentType: string = 'application/octet-stream'): Promise<string> {
  const aws = getClient(env);
  const endpoint = getEndpoint(env);
  const url = new URL(`${endpoint}/${objectKey}`);
  const request = await aws.sign(url, {
    method: 'PUT',
    headers: {
      'Content-Type': contentType
    },
    aws: { signQuery: true, allHeaders: true }
  });
  return request.url;
}

