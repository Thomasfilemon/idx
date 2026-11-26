export function createFormatting() {
  let fmt;
  let dateFmt;
  function setLocale(locale) {
    fmt = new Intl.NumberFormat(locale, { maximumFractionDigits: 2 });
    dateFmt = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone: "Asia/Jakarta" });
  }
  setLocale("id-ID");
  const number = (n) => Number.isFinite(n) ? fmt.format(n) : "—";
  const money = (n) => Number.isFinite(n) ? "Rp" + fmt.format(n) : "—";
  const signed = (n, unit = "") => Number.isFinite(n) ? (n > 0 ? "+" : "") + fmt.format(n) + unit : "—";
  const cls = (n) => n > 0 ? "positive" : n < 0 ? "negative" : "";
  const date = (value) => { if (!value) return "—"; const d = new Date(value); return Number.isNaN(d.getTime()) ? "—" : dateFmt.format(d) + " WIB"; };
  function quoteChange(change, percent) {
    if (!Number.isFinite(change)) return signed(percent, "%");
    return Number.isFinite(percent) ? signed(change) + " (" + signed(percent, "%") + ")" : signed(change);
  }
  return { setLocale, number, money, signed, cls, date, quoteChange };
}
