// Shared helpers for console auth tests: deterministic JWTs and an in-memory localStorage.
export function fakeJwt(claims: Record<string, unknown>, expiresInSeconds = 3600) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'HS256', typ: 'JWT' })}.${encode({ exp: Math.floor(Date.now() / 1000) + expiresInSeconds, aal: 'aal1', amr: [{ method: 'password', timestamp: 1 }], ...claims })}.signature`
}

export function memoryStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial))
  return {
    get length() {
      return store.size
    },
    key: (index: number) => [...store.keys()][index] ?? null,
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, String(value)),
    removeItem: (key: string) => void store.delete(key),
    clear: () => store.clear(),
  } as Storage
}
