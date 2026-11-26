export function createApi(document, fetchImpl) {
  const apiBase = document.querySelector('meta[name="idx-api-base"]')?.content.trim().replace(/\/+$/, "") || "";
  async function get(path, signal, base = apiBase) {
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), 55000);
    const abort = () => timeout.abort();
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await fetchImpl(base + path, { signal: timeout.signal, headers: { Accept: "application/json" } });
      if (!response.ok) throw Error("HTTP " + response.status);
      const body = await response.json();
      if (body?.error) throw Error(body.error.message || "API error");
      return body;
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
  }
  return { get };
}

export function createPanelState() {
  return { meta: null, loading: false, error: "", controller: null };
}

export const ensureEnvelope = (body, schema, isValid) => {
  if (!body || body.schema !== schema || !isValid(body.data)) {
    throw Error("Schema mismatch", { cause: { schema } });
  }
  return body;
};

export async function loadPanel(api, panel, path, schema, isValid, accept, render) {
  panel.controller?.abort();
  const controller = new AbortController();
  panel.controller = controller;
  panel.loading = true;
  panel.error = "";
  render();
  try {
    const body = ensureEnvelope(await api.get(path, controller.signal), schema, isValid);
    if (panel.controller !== controller) return;
    panel.meta = body;
    accept(body.data);
  } catch (e) {
    if (panel.controller !== controller) return;
    panel.error = e;
  }
  panel.loading = false;
  render();
}
