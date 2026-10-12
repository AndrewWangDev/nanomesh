import { Env } from "../types";

export function bufferToBase64Url(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlToBuffer(base64url: string): Uint8Array {
  const padding = "=".repeat((4 - (base64url.length % 4)) % 4);
  const base64 = (base64url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export function getRpId(request: Request): string {
  const url = new URL(request.url);
  if (url.hostname === "localhost" || url.hostname === "127.0.0.1") {
    return "localhost";
  }
  return url.hostname;
}

export function isOriginAllowed(origin: string, request: Request, env: Env): boolean {
  const reqOrigin = new URL(request.url).origin;
  if (origin === reqOrigin) return true;
  if (env.FRONTEND_URL && origin === env.FRONTEND_URL) return true;
  if (origin.startsWith("http://localhost:") || origin.startsWith("https://localhost:")) return true;
  return false;
}

export async function createChallenge(
  action: "register" | "login",
  secret: string
): Promise<{ challenge: string; cookieHeader: string }> {
  const randomBytes = crypto.getRandomValues(new Uint8Array(32));
  const challenge = bufferToBase64Url(randomBytes);
  const timestamp = Math.floor(Date.now() / 1000);

  const payload = `${action}:${challenge}:${timestamp}`;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, enc.encode(payload));
  const sigB64 = bufferToBase64Url(signature);

  const cookieVal = `${payload}:${sigB64}`;
  const cookieHeader = `passkey_challenge=${cookieVal}; HttpOnly; Path=/; Max-Age=300; SameSite=Lax; Secure`;

  return { challenge, cookieHeader };
}

export async function verifyChallenge(
  request: Request,
  action: "register" | "login",
  clientChallenge: string,
  secret: string
): Promise<boolean> {
  const cookieHeader = request.headers.get("Cookie");
  if (!cookieHeader) return false;

  const match = cookieHeader.match(/passkey_challenge=([^;]+)/);
  if (!match) return false;

  const cookieVal = decodeURIComponent(match[1]);
  const parts = cookieVal.split(":");
  if (parts.length !== 4) return false;

  const [cookieAction, challenge, timestampStr, sigB64] = parts;
  if (cookieAction !== action) return false;
  if (challenge !== clientChallenge) return false;

  const timestamp = parseInt(timestampStr, 10);
  const now = Math.floor(Date.now() / 1000);
  if (isNaN(timestamp) || now - timestamp > 300 || timestamp > now + 60) {
    return false;
  }

  const payload = `${action}:${challenge}:${timestampStr}`;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );

  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    base64UrlToBuffer(sigB64) as any,
    enc.encode(payload) as any
  );

  return valid;
}

export function clearChallengeCookie(): string {
  return "passkey_challenge=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax; Secure";
}

export function derToP1363(der: Uint8Array): Uint8Array {
  let offset = 0;
  if (der[offset++] !== 0x30) throw new Error("Invalid DER sequence");
  let seqLen = der[offset++];
  if (seqLen & 0x80) {
    offset += seqLen & 0x7f;
  }
  if (der[offset++] !== 0x02) throw new Error("Invalid integer r in DER");
  let rLen = der[offset++];
  let r = der.slice(offset, offset + rLen);
  offset += rLen;

  if (der[offset++] !== 0x02) throw new Error("Invalid integer s in DER");
  let sLen = der[offset++];
  let s = der.slice(offset, offset + sLen);

  if (r.length === 33 && r[0] === 0) r = r.slice(1);
  if (s.length === 33 && s[0] === 0) s = s.slice(1);

  const raw = new Uint8Array(64);
  raw.set(r, 32 - r.length);
  raw.set(s, 64 - s.length);
  return raw;
}

export function decodeCbor(buffer: Uint8Array): { value: any; bytesRead: number } {
  let offset = 0;
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);

  function decodeItem(): any {
    if (offset >= buffer.byteLength) throw new Error("Unexpected end of CBOR buffer");
    const initialByte = buffer[offset++];
    const majorType = initialByte >> 5;
    const additionalInfo = initialByte & 0x1f;

    let length = 0;
    if (additionalInfo < 24) {
      length = additionalInfo;
    } else if (additionalInfo === 24) {
      length = view.getUint8(offset++);
    } else if (additionalInfo === 25) {
      length = view.getUint16(offset);
      offset += 2;
    } else if (additionalInfo === 26) {
      length = view.getUint32(offset);
      offset += 4;
    } else if (additionalInfo === 27) {
      const high = view.getUint32(offset);
      const low = view.getUint32(offset + 4);
      offset += 8;
      length = high * 4294967296 + low;
    } else {
      throw new Error("Unsupported CBOR additional info: " + additionalInfo);
    }

    if (majorType === 0) {
      return length;
    } else if (majorType === 1) {
      return -1 - length;
    } else if (majorType === 2) {
      const data = buffer.slice(offset, offset + length);
      offset += length;
      return data;
    } else if (majorType === 3) {
      const data = buffer.slice(offset, offset + length);
      offset += length;
      return new TextDecoder().decode(data);
    } else if (majorType === 4) {
      const arr: any[] = [];
      for (let i = 0; i < length; i++) {
        arr.push(decodeItem());
      }
      return arr;
    } else if (majorType === 5) {
      const map = new Map<any, any>();
      for (let i = 0; i < length; i++) {
        const key = decodeItem();
        const value = decodeItem();
        map.set(key, value);
      }
      return map;
    } else if (majorType === 7) {
      if (additionalInfo === 20) return false;
      if (additionalInfo === 21) return true;
      if (additionalInfo === 22) return null;
      return undefined;
    }
    throw new Error("Unsupported CBOR major type: " + majorType);
  }

  const value = decodeItem();
  return { value, bytesRead: offset };
}

export function parseAttestationObject(attestationObjectBytes: Uint8Array): {
  authData: Uint8Array;
  rpIdHash: Uint8Array;
  flags: number;
  counter: number;
  aaguid: string;
  credentialId: Uint8Array;
  publicKeySpki: Uint8Array;
  alg: number;
} {
  const decoded = decodeCbor(attestationObjectBytes).value;
  if (!(decoded instanceof Map)) {
    throw new Error("Invalid attestation object format");
  }
  const authData: Uint8Array = decoded.get("authData");
  if (!authData || authData.length < 37) {
    throw new Error("Invalid authData");
  }

  const rpIdHash = authData.slice(0, 32);
  const flags = authData[32];
  const view = new DataView(authData.buffer, authData.byteOffset, authData.byteLength);
  const counter = view.getUint32(33);

  // Check bit 6 (AT flag)
  if (!(flags & 0x40)) {
    throw new Error("Attested credential data missing in authData");
  }

  const aaguidBytes = authData.slice(37, 53);
  let aaguid = "";
  for (let i = 0; i < aaguidBytes.length; i++) {
    aaguid += aaguidBytes[i].toString(16).padStart(2, "0");
    if (i === 3 || i === 5 || i === 7 || i === 9) aaguid += "-";
  }

  const credLen = view.getUint16(53);
  const credentialId = authData.slice(55, 55 + credLen);

  const coseKeyBytes = authData.slice(55 + credLen);
  const { value: coseMap } = decodeCbor(coseKeyBytes);
  if (!(coseMap instanceof Map)) {
    throw new Error("Invalid COSE key structure");
  }

  const kty = coseMap.get(1); // 2 = EC2, 3 = RSA
  const alg = coseMap.get(3) || -7; // -7 = ES256, -257 = RS256

  let publicKeySpki: Uint8Array;

  if (kty === 2 && (alg === -7 || !alg)) {
    const x = coseMap.get(-2);
    const y = coseMap.get(-3);
    if (!x || !y || x.length !== 32 || y.length !== 32) {
      throw new Error("Invalid EC2 P-256 coordinates");
    }
    const spkiPrefix = new Uint8Array([
      0x30, 0x59, 0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01,
      0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07, 0x03, 0x42, 0x00, 0x04
    ]);
    publicKeySpki = new Uint8Array(spkiPrefix.length + 64);
    publicKeySpki.set(spkiPrefix, 0);
    publicKeySpki.set(x, spkiPrefix.length);
    publicKeySpki.set(y, spkiPrefix.length + 32);
  } else {
    throw new Error(`Unsupported COSE key algorithm: kty=${kty}, alg=${alg}`);
  }

  return {
    authData,
    rpIdHash,
    flags,
    counter,
    aaguid,
    credentialId,
    publicKeySpki,
    alg: Number(alg)
  };
}

export async function verifyAssertionSignature(params: {
  authenticatorData: Uint8Array;
  clientDataJSON: Uint8Array;
  signature: Uint8Array;
  publicKeySpki: Uint8Array;
  alg: number;
  expectedRpId: string;
}): Promise<boolean> {
  const { authenticatorData, clientDataJSON, signature, publicKeySpki, alg, expectedRpId } = params;

  if (authenticatorData.length < 37) {
    return false;
  }

  // 1. Verify rpIdHash
  const enc = new TextEncoder();
  const expectedRpIdHash = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(expectedRpId)));
  const actualRpIdHash = authenticatorData.slice(0, 32);
  for (let i = 0; i < 32; i++) {
    if (expectedRpIdHash[i] !== actualRpIdHash[i]) {
      return false;
    }
  }

  // 2. Verify User Present (UP) flag (bit 0)
  const flags = authenticatorData[32];
  if (!(flags & 0x01)) {
    return false;
  }

  // 3. Construct signed data = authenticatorData || SHA-256(clientDataJSON)
  const clientHash = new Uint8Array(await crypto.subtle.digest("SHA-256", clientDataJSON as any));
  const signedData = new Uint8Array(authenticatorData.length + clientHash.length);
  signedData.set(authenticatorData, 0);
  signedData.set(clientHash, authenticatorData.length);

  // 4. Verify cryptographic signature
  if (alg === -7) {
    // ES256
    let ieeeSig: Uint8Array;
    try {
      ieeeSig = derToP1363(signature);
    } catch {
      // If client already provided raw 64 bytes
      if (signature.length === 64) {
        ieeeSig = signature;
      } else {
        return false;
      }
    }

    const key = await crypto.subtle.importKey(
      "spki",
      publicKeySpki as any,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"]
    );

    return await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      ieeeSig as any,
      signedData as any
    );
  } else if (alg === -257) {
    // RS256
    const key = await crypto.subtle.importKey(
      "spki",
      publicKeySpki as any,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );

    return await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      signature as any,
      signedData as any
    );
  }

  return false;
}
