export function calendarDay(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === value
    ? timestamp / 86400000 : null;
}

export function validHistory(data, symbol, range) {
  return data?.symbol === symbol && data.range === range && Array.isArray(data.points)
    && (data.currency == null || (typeof data.currency === "string" && /^[A-Z]{3}$/.test(data.currency)))
    && data.points.length <= 1100 && data.points.every((point, i, list) =>
      calendarDay(point?.date) !== null && (!i || list[i - 1].date < point.date)
      && Number.isFinite(point.close) && point.close > 0
      && (point.volume === null || (Number.isInteger(point.volume) && point.volume >= 0))
      && (point.adjusted_close == null || (Number.isFinite(point.adjusted_close) && point.adjusted_close > 0))
      && (point.provisional === undefined || typeof point.provisional === "boolean"));
}

export function historyPosition(points, point) {
  const span = calendarDay(points.at(-1).date) - calendarDay(points[0].date);
  return span ? 3 + 394 * (calendarDay(point.date) - calendarDay(points[0].date)) / span : 200;
}

export function historyGeometry(points) {
  const days = points.map(point => calendarDay(point.date));
  const closes = points.map(point => point.close);
  const low = Math.min(...closes), high = Math.max(...closes);
  const maxVolume = Math.max(0, ...points.map(point => point.volume ?? 0));
  const span = days.at(-1) - days[0];
  const x = i => span ? 3 + 394 * (days[i] - days[0]) / span : 200;
  const y = close => high === low ? 58 : 6 + 104 * (high - close) / (high - low);
  const width = Math.min(9, 340 / Math.max(1, span));
  // Plot observations at their calendar dates and leave unreported days blank.
  const pricePath = points.map((point, i) =>
    "M" + x(i) + " " + y(point.close) + "h0.1").join(" ");
  const volumePath = points.map((point, i) => {
    if (!point.volume) return "";
    const height = 62 * point.volume / maxVolume;
    return "M" + (x(i) - width / 2) + " 64v-" + height + "h" + width + "v" + height + "Z";
  }).join(" ");

  return { low, high, maxVolume, pricePath, volumePath };
}
