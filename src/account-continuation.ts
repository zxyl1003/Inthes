export async function continuationFingerprint(signature: string, history: string): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([signature, history]));
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...hash].map(n => n.toString(16).padStart(2, '0')).join('');
}
