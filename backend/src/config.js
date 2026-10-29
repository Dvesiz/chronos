export function requireConfig(env) {
  const missing = [];
  for (const key of ['JWT_SECRET', 'RESEND_API_KEY', 'RESEND_FROM_EMAIL']) {
    if (!env[key]) missing.push(key);
  }
  if (missing.length) throw new Error(`missing_config:${missing.join(',')}`);
}
