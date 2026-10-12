import { Env } from "../types";
import { requireAuth } from "../auth/middleware";
import { signJWT } from "../auth/jwt";
import {
  bufferToBase64Url,
  base64UrlToBuffer,
  getRpId,
  isOriginAllowed,
  createChallenge,
  verifyChallenge,
  clearChallengeCookie,
  parseAttestationObject,
  verifyAssertionSignature
} from "../auth/webauthn";

const SESSION_TTL_SECONDS = 30 * 24 * 3600; // 30 days

export async function handlePasskeyRegisterOptions(request: Request, env: Env): Promise<Response> {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  const user = await env.DB.prepare("SELECT user_id, username, email FROM users WHERE user_id = ?")
    .bind(auth.userId)
    .first<{ user_id: string; username: string; email: string }>();

  if (!user) {
    return Response.json({ error: "User not found" }, { status: 404 });
  }

  const existingKeys = await env.DB.prepare(
    "SELECT credential_id, transports FROM user_passkeys WHERE user_id = ?"
  )
    .bind(auth.userId)
    .all<{ credential_id: string; transports: string }>();

  const rpId = getRpId(request);
  const { challenge, cookieHeader } = await createChallenge("register", env.JWT_SECRET);

  const excludeCredentials = (existingKeys.results || []).map((k) => {
    let transports = ["internal"];
    try {
      if (k.transports) transports = JSON.parse(k.transports);
    } catch {}
    return {
      id: k.credential_id,
      type: "public-key",
      transports
    };
  });

  const encoder = new TextEncoder();
  const userIdBytes = encoder.encode(user.user_id);

  const options = {
    challenge,
    rp: {
      name: "NanoMesh",
      id: rpId
    },
    user: {
      id: bufferToBase64Url(userIdBytes),
      name: user.email,
      displayName: user.username || user.email
    },
    pubKeyCredParams: [
      { type: "public-key", alg: -7 },   // ES256
      { type: "public-key", alg: -257 }  // RS256
    ],
    timeout: 60000,
    attestation: "none",
    authenticatorSelection: {
      residentKey: "preferred",
      requireResidentKey: false,
      userVerification: "preferred"
    },
    excludeCredentials
  };

  const headers = new Headers({ "Content-Type": "application/json" });
  headers.set("Set-Cookie", cookieHeader);

  return new Response(JSON.stringify(options), { status: 200, headers });
}

export async function handlePasskeyRegisterVerify(request: Request, env: Env): Promise<Response> {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  const body: any = await request.json().catch(() => ({}));
  const { id, rawId, response, deviceName } = body;

  if (!id || !response || !response.clientDataJSON || !response.attestationObject) {
    return Response.json({ error: "error.passkeyInvalidPayload" }, { status: 400 });
  }

  // 1. Verify clientDataJSON
  let clientData: any;
  try {
    const clientDataStr = new TextDecoder().decode(base64UrlToBuffer(response.clientDataJSON));
    clientData = JSON.parse(clientDataStr);
  } catch {
    return Response.json({ error: "error.passkeyMalformedClientData" }, { status: 400 });
  }

  if (clientData.type !== "webauthn.create") {
    return Response.json({ error: "error.passkeyUnexpectedType" }, { status: 400 });
  }

  if (!isOriginAllowed(clientData.origin, request, env)) {
    return Response.json({ error: "error.passkeyOriginMismatch" }, { status: 400 });
  }

  const isChallengeValid = await verifyChallenge(
    request,
    "register",
    clientData.challenge,
    env.JWT_SECRET
  );
  if (!isChallengeValid) {
    return Response.json({ error: "error.passkeyChallengeExpired" }, { status: 400 });
  }

  // 2. Parse attestationObject
  let parsedAttestation: ReturnType<typeof parseAttestationObject>;
  try {
    parsedAttestation = parseAttestationObject(base64UrlToBuffer(response.attestationObject));
  } catch (err: any) {
    return Response.json({ error: err.message || "error.passkeyAttestationFailed" }, { status: 400 });
  }

  // 3. Verify rpIdHash
  const enc = new TextEncoder();
  const rpId = getRpId(request);
  const expectedRpIdHash = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(rpId)));
  for (let i = 0; i < 32; i++) {
    if (expectedRpIdHash[i] !== parsedAttestation.rpIdHash[i]) {
      return Response.json({ error: "error.passkeyRpMismatch" }, { status: 400 });
    }
  }

  // 4. Verify user present flag (bit 0)
  if (!(parsedAttestation.flags & 0x01)) {
    return Response.json({ error: "error.passkeyUserNotPresent" }, { status: 400 });
  }

  // 5. Store credential into database
  const credentialId = id;
  const publicKeyB64 = bufferToBase64Url(parsedAttestation.publicKeySpki);
  const transportsJson = JSON.stringify(response.transports || ["internal"]);
  const friendlyName = (typeof deviceName === "string" && deviceName.trim()) 
    ? deviceName.trim().slice(0, 50) 
    : "Passkey";

  const existing = await env.DB.prepare("SELECT credential_id FROM user_passkeys WHERE credential_id = ?")
    .bind(credentialId)
    .first();

  if (existing) {
    return Response.json({ error: "error.passkeyAlreadyExists" }, { status: 400 });
  }

  await env.DB.prepare(`
    INSERT INTO user_passkeys (
      credential_id, user_id, public_key, public_key_alg, counter, device_name, aaguid, transports
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `)
    .bind(
      credentialId,
      auth.userId,
      publicKeyB64,
      parsedAttestation.alg,
      parsedAttestation.counter,
      friendlyName,
      parsedAttestation.aaguid,
      transportsJson
    )
    .run();

  const headers = new Headers({ "Content-Type": "application/json" });
  headers.append("Set-Cookie", clearChallengeCookie());

  return new Response(JSON.stringify({ success: true, credential_id: credentialId }), {
    status: 200,
    headers
  });
}

export async function handlePasskeyList(request: Request, env: Env): Promise<Response> {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  const { results } = await env.DB.prepare(`
    SELECT credential_id, device_name, aaguid, transports, created_at, last_used_at
    FROM user_passkeys
    WHERE user_id = ?
    ORDER BY created_at DESC
  `)
    .bind(auth.userId)
    .all();

  return Response.json({ passkeys: results || [] });
}

export async function handlePasskeyDelete(
  request: Request,
  env: Env,
  credentialId: string
): Promise<Response> {
  const auth = await requireAuth(request, env);
  if (auth instanceof Response) return auth;

  if (!credentialId) {
    return Response.json({ error: "error.invalidCredentialId" }, { status: 400 });
  }

  // 1. Verify existence & ownership
  const keyRecord = await env.DB.prepare(
    "SELECT credential_id FROM user_passkeys WHERE credential_id = ? AND user_id = ?"
  )
    .bind(credentialId, auth.userId)
    .first();

  if (!keyRecord) {
    return Response.json({ error: "error.passkeyNotFound" }, { status: 404 });
  }

  // 2. Anti-lockout guard:
  // If user has no password and no OAuth binding, ensure this is not their last passkey
  const user = await env.DB.prepare("SELECT password_hash FROM users WHERE user_id = ?")
    .bind(auth.userId)
    .first<{ password_hash: string | null }>();

  const oauthCount = await env.DB.prepare(
    "SELECT COUNT(*) as cnt FROM user_oauth_bindings WHERE user_id = ?"
  )
    .bind(auth.userId)
    .first<{ cnt: number }>();

  const passkeyCount = await env.DB.prepare(
    "SELECT COUNT(*) as cnt FROM user_passkeys WHERE user_id = ?"
  )
    .bind(auth.userId)
    .first<{ cnt: number }>();

  const hasPassword = !!(user && user.password_hash);
  const hasOAuth = (oauthCount?.cnt ?? 0) > 0;
  const totalPasskeys = passkeyCount?.cnt ?? 0;

  if (!hasPassword && !hasOAuth && totalPasskeys <= 1) {
    return Response.json({ error: "error.passkeyLastAuthMethod" }, { status: 400 });
  }

  // 3. Delete passkey
  await env.DB.prepare("DELETE FROM user_passkeys WHERE credential_id = ? AND user_id = ?")
    .bind(credentialId, auth.userId)
    .run();

  return Response.json({ success: true });
}

export async function handlePasskeyLoginOptions(request: Request, env: Env): Promise<Response> {
  const body: any = await request.json().catch(() => ({}));
  let email = body?.email;
  if (typeof email === "string") email = email.toLowerCase().trim();

  const rpId = getRpId(request);
  const { challenge, cookieHeader } = await createChallenge("login", env.JWT_SECRET);

  let allowCredentials: any[] = [];

  if (email) {
    const user = await env.DB.prepare("SELECT user_id FROM users WHERE LOWER(email) = ?")
      .bind(email)
      .first<{ user_id: string }>();

    if (user) {
      const keys = await env.DB.prepare(
        "SELECT credential_id, transports FROM user_passkeys WHERE user_id = ?"
      )
        .bind(user.user_id)
        .all<{ credential_id: string; transports: string }>();

      allowCredentials = (keys.results || []).map((k) => {
        let transports = ["internal"];
        try {
          if (k.transports) transports = JSON.parse(k.transports);
        } catch {}
        return {
          id: k.credential_id,
          type: "public-key",
          transports
        };
      });
    }
  }

  const options = {
    challenge,
    rpId,
    timeout: 60000,
    userVerification: "preferred",
    allowCredentials
  };

  const headers = new Headers({ "Content-Type": "application/json" });
  headers.set("Set-Cookie", cookieHeader);

  return new Response(JSON.stringify(options), { status: 200, headers });
}

export async function handlePasskeyLoginVerify(request: Request, env: Env): Promise<Response> {
  const body: any = await request.json().catch(() => ({}));
  const { id, rawId, response } = body;

  if (!id || !response || !response.clientDataJSON || !response.authenticatorData || !response.signature) {
    return Response.json({ error: "error.passkeyInvalidPayload" }, { status: 400 });
  }

  // 1. Fetch passkey from database
  const passkey = await env.DB.prepare(`
    SELECT credential_id, user_id, public_key, public_key_alg, counter
    FROM user_passkeys
    WHERE credential_id = ?
  `)
    .bind(id)
    .first<{
      credential_id: string;
      user_id: string;
      public_key: string;
      public_key_alg: number;
      counter: number;
    }>();

  if (!passkey) {
    return Response.json({ error: "error.passkeyNotFound" }, { status: 401 });
  }

  // 2. Fetch user
  const user = await env.DB.prepare("SELECT * FROM users WHERE user_id = ?")
    .bind(passkey.user_id)
    .first<any>();

  if (!user) {
    return Response.json({ error: "error.userNotFound" }, { status: 401 });
  }

  // 3. Verify clientDataJSON
  let clientData: any;
  try {
    const clientDataStr = new TextDecoder().decode(base64UrlToBuffer(response.clientDataJSON));
    clientData = JSON.parse(clientDataStr);
  } catch {
    return Response.json({ error: "error.passkeyMalformedClientData" }, { status: 400 });
  }

  if (clientData.type !== "webauthn.get") {
    return Response.json({ error: "error.passkeyUnexpectedType" }, { status: 400 });
  }

  if (!isOriginAllowed(clientData.origin, request, env)) {
    return Response.json({ error: "error.passkeyOriginMismatch" }, { status: 400 });
  }

  const isChallengeValid = await verifyChallenge(
    request,
    "login",
    clientData.challenge,
    env.JWT_SECRET
  );
  if (!isChallengeValid) {
    return Response.json({ error: "error.passkeyChallengeExpired" }, { status: 400 });
  }

  // 4. Verify cryptographic assertion signature
  const authenticatorDataBytes = base64UrlToBuffer(response.authenticatorData);
  const clientDataJSONBytes = base64UrlToBuffer(response.clientDataJSON);
  const signatureBytes = base64UrlToBuffer(response.signature);
  const publicKeySpkiBytes = base64UrlToBuffer(passkey.public_key);
  const rpId = getRpId(request);

  const isSignatureValid = await verifyAssertionSignature({
    authenticatorData: authenticatorDataBytes,
    clientDataJSON: clientDataJSONBytes,
    signature: signatureBytes,
    publicKeySpki: publicKeySpkiBytes,
    alg: passkey.public_key_alg,
    expectedRpId: rpId
  });

  if (!isSignatureValid) {
    return Response.json({ error: "error.passkeySignatureFailed" }, { status: 401 });
  }

  // 5. Counter check & update
  const view = new DataView(
    authenticatorDataBytes.buffer,
    authenticatorDataBytes.byteOffset,
    authenticatorDataBytes.byteLength
  );
  const newCounter = view.getUint32(33);

  // If counter is enabled and decreases/repeats (unless 0), warn/handle
  if (newCounter > 0 && passkey.counter > 0 && newCounter <= passkey.counter) {
    console.warn(`[Passkey] Potential cloned authenticator detected: newCounter=${newCounter}, storedCounter=${passkey.counter}`);
  }

  await env.DB.prepare(`
    UPDATE user_passkeys
    SET counter = ?, last_used_at = datetime('now')
    WHERE credential_id = ?
  `)
    .bind(newCounter, passkey.credential_id)
    .run();

  // 6. Issue JWT session token
  const token = await signJWT({ userId: user.user_id }, env.JWT_SECRET, SESSION_TTL_SECONDS);

  const headers = new Headers({ "Content-Type": "application/json" });
  headers.append("Set-Cookie", `session=${token}; HttpOnly; Path=/; Max-Age=${SESSION_TTL_SECONDS}; SameSite=Lax; Secure`);
  headers.append("Set-Cookie", clearChallengeCookie());

  return new Response(
    JSON.stringify({
      user_id: user.user_id,
      username: user.username,
      email: user.email,
      credits: user.credits
    }),
    { status: 200, headers }
  );
}
