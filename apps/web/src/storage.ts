// Failed writes must shadow older persisted values, including removals.
export function resilientStorage(backend: () => Storage) {
  const fallback = new Map<string, unknown>();
  return {
    get<T>(key: string): T | null {
      if (fallback.has(key)) return fallback.get(key) as T | null;
      try { return JSON.parse(backend().getItem(key) ?? 'null'); } catch { return null; }
    },
    set(key: string, value: unknown) {
      try { backend().setItem(key, JSON.stringify(value)); fallback.delete(key); }
      catch { fallback.set(key, value); }
    },
    remove(key: string) {
      try { backend().removeItem(key); fallback.delete(key); }
      catch { fallback.set(key, null); }
    },
  };
}
export const storage = resilientStorage(() => localStorage);
