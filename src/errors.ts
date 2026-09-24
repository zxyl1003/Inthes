export function redactError(value: unknown, secrets: string[] = []) {
  let message = value instanceof Error ? value.message : String(value);
  for (const secret of secrets.filter(Boolean).sort((a, b) => b.length - a.length)) message = message.split(secret).join('[已隐藏]');
  return message.replace(/(\b[a-z][\w+.-]*:\/\/)[^\s/@]+@/gi, '$1[已隐藏]@')
    .replace(/sk-[\w-]+/g, '[已隐藏]')
    .replace(/\bBearer\s+[^\s"',;]+/gi, 'Bearer [已隐藏]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|password)["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi, '$1[已隐藏]');
}

export function credentialValues(key: string, headers: string) {
  const values = [key];
  try { for (const [name, value] of Object.entries(JSON.parse(headers || '{}'))) if (typeof value === 'string' && /key|token|auth|secret/i.test(name)) values.push(value); }
  catch { /* Invalid header JSON is reported by the request builder. */ }
  return values;
}
