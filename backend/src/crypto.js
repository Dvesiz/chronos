const encoder = new TextEncoder();

function bytesToBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlToBytes(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}

export function randomId(bytes = 18) {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return bytesToBase64Url(buffer);
}

export async function sha256(value) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

export async function hmac(value, secret) {
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(value));
  return bytesToBase64Url(new Uint8Array(signature));
}

export async function signToken(payload, secret) {
  const encoded = bytesToBase64Url(encoder.encode(JSON.stringify(payload)));
  return `${encoded}.${await hmac(encoded, secret)}`;
}

export async function verifyToken(token, secret) {
  if (typeof token !== 'string') return null;
  const [encoded, signature] = token.split('.');
  if (!encoded || !signature) return null;
  const expected = await hmac(encoded, secret);
  if (expected.length !== signature.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  if (diff !== 0) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(base64UrlToBytes(encoded)));
    if (!payload.exp || payload.exp <= Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}
