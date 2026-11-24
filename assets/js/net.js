const ZenNet = (() => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function timeoutSignal(ms) {
    if (typeof AbortSignal?.timeout === 'function') return AbortSignal.timeout(ms);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), ms);
    return controller.signal;
  }

  async function fetchJson(url, { timeout = 10000, retries = 1, headers = { Accept: 'application/json' } } = {}) {
    let lastError = null;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const response = await fetch(url, { signal: timeoutSignal(timeout), headers });
        if (!response.ok) throw new Error(`http-${response.status}`);
        return await response.json();
      } catch (error) {
        lastError = error;
        if (attempt < retries && navigator.onLine) await wait(600 * (attempt + 1));
      }
    }

    throw lastError;
  }

  return { fetchJson, timeoutSignal };
})();