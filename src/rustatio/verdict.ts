export type Verdict = { ok: boolean; message: string };

/** Verdict pur du test de connexion Rustatio (GET /api/instances). Ne fuit jamais l'URL/token. */
export function verdictRustatio(status: number | null, body: unknown): Verdict {
  if (status === null) return { ok: false, message: 'Rustatio injoignable a cette adresse.' };
  if (status === 401 || status === 403) {
    return { ok: false, message: 'Rustatio refuse : token manquant ou invalide.' };
  }
  if (status < 200 || status >= 300) return { ok: false, message: `Rustatio a repondu ${status}.` };
  const ok = !!body && typeof body === 'object' && Array.isArray((body as { data?: unknown }).data);
  return ok
    ? { ok: true, message: 'Connexion Rustatio OK.' }
    : { ok: false, message: 'Reponse inattendue : est-ce bien un Rustatio ?' };
}
