// 편집 비밀번호 로그인.
// 비밀번호(EDIT_PASSWORD, Worker Secret)가 맞으면 그 비밀번호로 서명한 세션 쿠키를 준다.
// 서버에 세션을 따로 저장하지 않으므로, 비밀번호를 바꾸면 기존 세션은 모두 무효가 된다.

export const SESSION_COOKIE = "titan_session";
export const SESSION_SECONDS = 30 * 24 * 60 * 60;

const encoder = new TextEncoder();

function toBase64Url(bytes) {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text) {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function hmacKey(secret) {
  return crypto.subtle.importKey("raw", encoder.encode("titan-session:" + secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/** Compare a submitted password with the secret without leaking timing. */
export async function passwordMatches(input, secret) {
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(input)),
    crypto.subtle.digest("SHA-256", encoder.encode(secret)),
  ]);
  const x = new Uint8Array(a);
  const y = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export async function createSession(secret, name) {
  const body = toBase64Url(encoder.encode(JSON.stringify({ n: name, exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS })));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(body)));
  return `${body}.${toBase64Url(sig)}`;
}

/** Returns the editor name stored in a valid session, or null. */
export async function readSession(request, secret) {
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  try {
    const valid = await crypto.subtle.verify("HMAC", await hmacKey(secret), fromBase64Url(sig), encoder.encode(body));
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(fromBase64Url(body)));
    if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) return null;
    return typeof payload.n === "string" && payload.n ? payload.n : "편집자";
  } catch {
    return null;
  }
}

function readCookie(request, name) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return null;
}

export function sessionCookie(token, maxAge) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
}
