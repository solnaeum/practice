// Cloudflare Access JWT 검증.
// 정적 파일을 함께 쓰는 Worker에는 ctx.access가 전달되지 않으므로,
// Access가 붙여 주는 Cf-Access-Jwt-Assertion 헤더를 팀 도메인의 공개키로 직접 검증한다.

const KEY_CACHE_MS = 10 * 60 * 1000;
const keyCache = new Map(); // teamDomain -> { keys, fetchedAt }

function base64UrlToBytes(input) {
  const base64 = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeJson(part) {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(part)));
}

async function fetchKeys(teamDomain, force) {
  const cached = keyCache.get(teamDomain);
  if (!force && cached && Date.now() - cached.fetchedAt < KEY_CACHE_MS) return cached.keys;
  const res = await fetch(`${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access 공개키를 가져오지 못했습니다 (${res.status})`);
  const body = await res.json();
  const keys = Array.isArray(body.keys) ? body.keys : [];
  keyCache.set(teamDomain, { keys, fetchedAt: Date.now() });
  return keys;
}

/**
 * 토큰이 유효하면 payload를, 아니면 null을 돌려준다.
 * teamDomain 예: https://<팀 이름>.cloudflareaccess.com
 */
export async function verifyAccessJwt(token, teamDomain, audience) {
  const domain = teamDomain.replace(/\/+$/, "");
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  let header, payload;
  try {
    header = decodeJson(parts[0]);
    payload = decodeJson(parts[1]);
  } catch {
    return null;
  }
  if (header.alg !== "RS256" || !header.kid) return null;

  let jwk = (await fetchKeys(domain, false)).find((k) => k.kid === header.kid);
  if (!jwk) jwk = (await fetchKeys(domain, true)).find((k) => k.kid === header.kid);
  if (!jwk) return null;

  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true },
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    base64UrlToBytes(parts[2]),
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!valid) return null;

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp < now) return null;
  if (typeof payload.nbf === "number" && payload.nbf > now + 60) return null;
  if (payload.iss !== domain) return null;
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!audiences.includes(audience)) return null;
  return payload;
}
