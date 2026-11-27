export function createI18n(document, storage, formatting) {
  const $ = id => document.getElementById(id);
  let language = "en";
  try {
    if (storage?.getItem("idx-language") === "id") language = "id";
  } catch {
    // Language remains usable when browser storage is unavailable.
  }
  const tr = (id, en) => language === "en" ? en : id;

  const localizedMessages = new Map();
  function setLocalizedMessage(element, message) {
    localizedMessages.set(element, message);
    element.textContent = message();
  }

  const staticCopy = [];
  for (const [selector, attr] of [
    ["[data-en]", null], ["[data-en-aria-label]", "aria-label"], ["[data-en-placeholder]", "placeholder"],
    ["[data-en-content]", "content"],
  ]) {
    for (const element of document.querySelectorAll?.(selector) ?? []) {
      const id = attr ? element.getAttribute(attr) : element.textContent;
      const en = element.getAttribute(attr ? "data-en-" + attr : "data-en");
      staticCopy.push(() => {
        if (attr) element.setAttribute(attr, tr(id, en));
        else element.textContent = tr(id, en);
      });
    }
  }
  function applyLanguage() {
    if (document.documentElement) document.documentElement.lang = language;
    $("dashboard-language").value = language;
    formatting.setLocale(tr("id-ID", "en-GB"));
    staticCopy.forEach(update => update());
    for (const [element, message] of localizedMessages) element.textContent = message();
  }
  function bind(onChange) {
    $("dashboard-language").addEventListener("change", event => {
      language = event.target.value === "en" ? "en" : "id";
      try {
        storage?.setItem("idx-language", language);
      } catch {
        // Apply the selected language for this page even without storage.
      }
      applyLanguage();
      onChange();
    });
    applyLanguage();
  }
  return { tr, setLocalizedMessage, bind };
}
