export function createPanelStatus({ tr, date }) {
  function panelError(error) {
    if (error.name === "AbortError") return tr("request timeout (55 detik)", "Request timed out (55 seconds)");
    if (error.cause?.schema) {
      return tr("Format respons API tidak sesuai (", "Unexpected API response format (") + error.cause.schema + ")";
    }
    if (/^HTTP \d{3}$/.test(error.message)) return error.message;
    return tr("API tidak dapat dihubungi atau memberi respons yang tidak valid", "The API could not be reached or returned an invalid response");
  }
  function metaState(panel) {
    if (panel.loading) return panel.meta ? tr("Memperbarui data…", "Updating data…") : tr("Menghubungkan ke API… Server dapat memerlukan waktu untuk aktif.", "Connecting to the API… The server may need time to start.");
    if (panel.error) {
      const message = tr("Gagal memuat data: ", "Could not load data: ") + panelError(panel.error) + ".";
      return panel.meta ? message + tr(" Menampilkan data terakhir yang berhasil diambil pada ", " Showing the last data received at ") + date(panel.meta.fetched_at) + "." : message;
    }
    const meta = panel.meta;
    if (!meta) return "";
    const state = [];
    if (meta.data?.behind_session === true) state.push(tr("Data tertinggal dari sesi terakhir", "Data is behind the latest session"));
    else if (meta.stale) state.push(tr("Data lama dari provider", "Stale provider data"));
    if (meta.cached) state.push(tr("Respons dari cache", "Cached response"));
    if (meta.warnings?.length) state.push(tr("Provider melaporkan keterbatasan data", "The provider reported limited data"));
    state.push(tr("Respons diambil ", "Response received ") + date(meta.fetched_at));
    return state.join(" · ");
  }
  return metaState;
}
