// Separate series across calculation resets so a plotted line never spans a data gap.
export const indicators = {
  sma20: ["SMA20", "#ffd166"], sma50: ["SMA50", "#78c9fa"],
  sma200: ["SMA200", "#ff9ac6"], ema20: ["EMA20", "#c2a4ff"],
  rsi14: ["RSI14", "#a6ef79"], macd: ["MACD", "#78c9fa"],
};
export function segments(points, key, component) {
  const groups = [];
  let group;
  let previous;
  for (const p of points) {
    const row = p.indicators;
    const value = component ? row?.[key]?.[component] : row?.[key];
    if (Number.isFinite(value)) {
      if (!group || row.observations !== previous + 1) {
        group = [];
        groups.push(group);
      }
      group.push({ time: p.date, value });
    } else group = undefined;
    previous = row?.observations;
  }
  return groups;
}
