// Supabase Edge 内本地 JWT 验签：用 SUPABASE_JWKS（平台默认注入的 secret）
// 直接验证手机端带来的 access_token，省掉 getClaims 的 300-400ms 网络往返。
// 仅支持 Supabase 签发的非对称 JWT（ES256 / RS256）；验签失败一律拒绝。

export type JwtClaims = {
  sub: string;
  exp: number;
  iss?: string;
  aud?: string | string[];
  role?: string;
};

type Jwk = {
  kty: string;
  kid?: string;
  alg?: string;
  crv?: string;
  x?: string;
  y?: string;
  n?: string;
  e?: string;
};

export async function verifySupabaseJwt(
  accessToken: string,
  { jwksJson, issuer }: { jwksJson: string; issuer: string }
): Promise<JwtClaims> {
  const jwks = parseJwks(jwksJson);
  const token = parseToken(accessToken);

  const matchingKey = jwks.keys.find(
    (k) => (!token.header.kid || !k.kid || k.kid === token.header.kid)
      && (token.header.alg === "ES256" ? k.kty === "EC" && k.crv === "P-256" : token.header.alg === "RS256" && k.kty === "RSA")
  );
  if (!matchingKey) throw new Error("no_matching_jwk");

  const key = await importKey(matchingKey, token.header.alg);
  const encoded = new TextEncoder().encode(`${token.parts[0]}.${token.parts[1]}`);
  const signedContent = new Uint8Array(
    encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength) as ArrayBuffer
  );
  const { signature } = token;
  const ok = await crypto.subtle.verify(
    token.header.alg === "ES256" ? { name: "ECDSA", hash: "SHA-256" } : { name: "RSASSA-PKCS1-v1_5" },
    key,
    signature,
    signedContent
  );
  if (!ok) throw new Error("bad_signature");

  const claims = token.claims;
  if (typeof claims.exp !== "number" || claims.exp * 1000 <= Date.now()) {
    throw new Error("token_expired");
  }
  if (issuer && claims.iss && claims.iss !== issuer) {
    throw new Error("bad_issuer");
  }
  const aud = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : [];
  if (claims.aud && !aud.includes("authenticated")) {
    throw new Error("bad_audience");
  }
  if (typeof claims.sub !== "string" || !claims.sub) {
    throw new Error("missing_sub");
  }
  return claims as JwtClaims;
}

function parseJwks(jwksJson: string): { keys: Jwk[] } {
  const parsed = JSON.parse(jwksJson);
  if (!parsed || !Array.isArray(parsed.keys)) throw new Error("invalid_jwks");
  return parsed;
}

function parseToken(accessToken: string) {
  const parts = accessToken.split(".");
  if (parts.length !== 3) throw new Error("malformed_token");
  const decode = (part: string) => JSON.parse(new TextDecoder().decode(base64UrlDecode(part)));
  const header = decode(parts[0]) as { alg: string; kid?: string; typ?: string };
  if (header.alg !== "ES256" && header.alg !== "RS256") throw new Error("unsupported_alg");
  const claims = decode(parts[1]) as Record<string, unknown>;
  const signature = base64UrlDecode(parts[2]);
  return { parts, header, claims, signature };
}

async function importKey(jwk: Jwk, alg: string): Promise<CryptoKey> {
  const usable: Jwk & { ext: boolean; key_ops?: string[] } = {
    ...jwk,
    ext: true,
    key_ops: ["verify"]
  };
  if (alg === "ES256") {
    return crypto.subtle.importKey(
      "jwk",
      usable,
      { name: "ECDSA", namedCurve: "P-256" },
      true,
      ["verify"]
    );
  }
  return crypto.subtle.importKey(
    "jwk",
    usable,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    true,
    ["verify"]
  );
}

function base64UrlDecode(input: string): Uint8Array<ArrayBuffer> {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
