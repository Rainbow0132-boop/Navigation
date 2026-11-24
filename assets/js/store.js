const ZenStore = (() => {
  const memory = new Map();

  function readRaw(key) {
    try {
      return sessionStorage.getItem(key);
    } catch {
      return null;
    }
  }

  function readEntry(key) {
    const raw = readRaw(key);
    if (raw) {
      try {
        return JSON.parse(raw);
      } catch {}
    }
    return memory.get(key) || null;
  }

  function get(key, ttl = Infinity) {
    const entry = readEntry(key);
    if (!entry || typeof entry.time !== 'number' || !('value' in entry)) return null;
    if (Date.now() - entry.time > ttl) return null;
    memory.set(key, entry);
    return entry.value;
  }

  function getStale(key) {
    const entry = readEntry(key);
    return entry && 'value' in entry ? entry.value : null;
  }

  function set(key, value) {
    const entry = { time: Date.now(), value };
    memory.set(key, entry);
    try {
      sessionStorage.setItem(key, JSON.stringify(entry));
    } catch {}
  }

  function remove(key) {
    memory.delete(key);
    try {
      sessionStorage.removeItem(key);
    } catch {}
  }

  return { get, getStale, set, remove };
})();