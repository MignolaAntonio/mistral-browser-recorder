const MISTRAL_BASE = "https://api.mistral.ai/v1";
const OCR_MODEL = "mistral-ocr-latest";
const DEFAULT_PIXTRAL_MODEL = "pixtral-12b-2409";
const DEFAULT_MODE = "scrape";
const CAPTURE_QUALITY = 85;

// Limiti di sicurezza per la cattura a scorrimento (pagina intera):
// numero massimo di sezioni catturate e altezza massima dell'immagine finale.
const MAX_SCROLL_SECTIONS = 15;
const SCROLL_WAIT_MS = 450;
const MAX_STITCH_HEIGHT_PX = 16000;

// Limite di testo estratto in modalità scrape (caratteri).
const SCRAPE_MAX_CHARS = 150000;

const PIXTRAL_PROMPT =
  "Sei un assistente che analizza schermate di pagine web. Trascrivi in italiano, in modo conciso e strutturato, il contenuto di questa schermata: riporta il testo leggibile, i titoli, le sezioni principali e gli elementi rilevanti (avvisi, pulsanti, moduli). Non inventare contenuti non presenti nell'immagine.";

// Domini su cui la cattura e' vietata a livello di codice (non modificabile dalle opzioni):
// home banking, pagamenti, login, gestori di password, webmail.
const BLOCKED_HOST_SUBSTRINGS = [
  "bank", "banca", "banco", "paypal", "satispay", "postepay", "revolut",
  "n26", "wise.com", "1password", "lastpass", "bitwarden", "dashlane",
  "keepass", "proton.me", "protonmail", "gmail", "mail.google",
  "outlook.live", "outlook.office", "office365", "login.microsoftonline",
  "accounts.google", "signin.", "auth0.", ".okta.", "webmail", "roundcube",
  "stripe.com"
];

function isBlockedHost(hostname) {
  const h = (hostname || "").toLowerCase();
  return BLOCKED_HOST_SUBSTRINGS.some((s) => h.includes(s));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getStore() {
  const data = await chrome.storage.local.get(["settings", "records", "stats", "lastStatus"]);
  return {
    settings: Object.assign(
      { apiKey: "", mode: DEFAULT_MODE, pixtralModel: DEFAULT_PIXTRAL_MODEL },
      data.settings || {}
    ),
    records: Array.isArray(data.records) ? data.records : [],
    stats: Object.assign({ totalCaptured: 0, totalTranscribed: 0 }, data.stats || {}),
    lastStatus: data.lastStatus || { state: "idle", message: "Pronto.", at: null }
  };
}

async function setStatus(state, message) {
  const lastStatus = { state, message, at: new Date().toISOString() };
  await chrome.storage.local.set({ lastStatus });
  return lastStatus;
}

async function getState() {
  const store = await getStore();
  return {
    lastStatus: store.lastStatus,
    stats: store.stats,
    recordCount: store.records.length,
    settings: {
      mode: store.settings.mode,
      pixtralModel: store.settings.pixtralModel,
      hasApiKey: Boolean(store.settings.apiKey)
    }
  };
}

async function fetchWithRetry(url, options, maxRetries = 3) {
  let attempt = 0;
  for (;;) {
    const res = await fetch(url, options);
    if (res.status === 401 || res.status === 403) {
      const err = new Error("Chiave API Mistral non valida o non autorizzata (HTTP " + res.status + ").");
      err.code = "auth";
      throw err;
    }
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= maxRetries) {
        const err = new Error("API Mistral non disponibile (HTTP " + res.status + ") dopo " + (maxRetries + 1) + " tentativi.");
        err.code = "api";
        throw err;
      }
      const retryAfter = Number(res.headers.get("Retry-After"));
      const delay = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(1000 * 2 ** attempt, 8000);
      await sleep(delay);
      attempt += 1;
      continue;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const err = new Error("Errore API Mistral (HTTP " + res.status + "): " + body.slice(0, 200));
      err.code = "api";
      throw err;
    }
    return res;
  }
}

async function mistralOcr(apiKey, dataUrl) {
  const res = await fetchWithRetry(MISTRAL_BASE + "/ocr", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + apiKey,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: OCR_MODEL,
      document: { type: "image_url", image_url: dataUrl }
    })
  });
  const json = await res.json();
  const pages = Array.isArray(json.pages) ? json.pages : [];
  return pages.map((p) => p.markdown || "").join("\n\n").trim();
}

async function mistralPixtral(apiKey, model, dataUrl) {
  const res = await fetchWithRetry(MISTRAL_BASE + "/chat/completions", {
    method: "POST",
    headers: {
      Authorization: "Bearer " + apiKey,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: model || DEFAULT_PIXTRAL_MODEL,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: PIXTRAL_PROMPT },
            { type: "image_url", image_url: { url: dataUrl } }
          ]
        }
      ]
    })
  });
  const json = await res.json();
  const choice = json.choices && json.choices[0];
  return String((choice && choice.message && choice.message.content) || "").trim();
}

// ---------- Modalita' scrape: estrazione testo diretta dal DOM ----------

// Estrae il testo della pagina con chrome.scripting: nessuno screenshot,
// nessuna chiamata API, la pagina gira completamente nel browser.
async function scrapePageText(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const desc = document.querySelector('meta[name="description"]');
      return {
        title: document.title || "",
        description: (desc && desc.content) || "",
        text: (document.scrollingElement || document.body).innerText || ""
      };
    }
  });
  const r = results && results[0] && results[0].result;
  if (!r || typeof r.text !== "string" || !r.text.trim()) {
    throw new Error("La pagina non restituisce testo estraibile (potrebbe essere un PDF, un canvas o una pagina dinamica vuota).");
  }
  let text = r.text.trim();
  let truncated = false;
  if (text.length > SCRAPE_MAX_CHARS) {
    text = text.slice(0, SCRAPE_MAX_CHARS);
    truncated = true;
  }
  const header = (r.description ? "Descrizione: " + r.description + "\n\n" : "");
  return { text: header + text, title: r.title, truncated };
}

// ---------- Cattura a scorrimento (pagina intera) ----------

async function getScrollMetrics(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const el = document.scrollingElement || document.documentElement;
      return {
        scrollHeight: el.scrollHeight,
        viewportHeight: window.innerHeight,
        scrollX: window.scrollX,
        scrollY: window.scrollY
      };
    }
  });
  const r = results && results[0] && results[0].result;
  if (!r || typeof r.scrollHeight !== "number" || typeof r.viewportHeight !== "number") {
    throw new Error("Impossibile leggere le dimensioni della pagina.");
  }
  return r;
}

async function scrollToOffset(tabId, y) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    func: (yy) => {
      window.scrollTo(0, yy);
      return window.scrollY;
    },
    args: [Math.round(y)]
  });
  const scrolledTo = results && results[0] && results[0].result;
  if (typeof scrolledTo !== "number") {
    throw new Error("Impossibile scorrere la pagina.");
  }
  return scrolledTo;
}

async function restoreScroll(tabId, x, y) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (sx, sy) => window.scrollTo(sx, sy),
      args: [Math.round(x), Math.round(y)]
    });
  } catch (e) {
    // Ripristino best-effort: non fallisce la cattura se non riesce.
  }
}

// Offset (px CSS) a cui scorrere per ogni sezione. L'ultima sezione e'
// ancorata al fondo pagina in modo da coprirne la coda, anche se questo
// comporta una sovrapposizione con la sezione precedente.
function computeSectionOffsets(scrollHeight, viewportHeight) {
  const total = Math.max(scrollHeight - viewportHeight, 0);
  if (total <= 0) return [0];
  const sections = Math.min(Math.ceil(total / viewportHeight) + 1, MAX_SCROLL_SECTIONS);
  const offsets = [];
  for (let i = 0; i < sections; i += 1) {
    const y = i === sections - 1 ? scrollHeight - viewportHeight : i * viewportHeight;
    if (offsets.length === 0 || y > offsets[offsets.length - 1]) {
      offsets.push(y);
    }
  }
  return offsets;
}

// Ricompone le sezioni catturate in un'unica immagine JPEG usando OffscreenCanvas
// (disponibile nei service worker MV3). Riduce l'immagine se supera MAX_STITCH_HEIGHT_PX.
async function stitchBitmaps(dataUrls, offsets, viewportHeight) {
  const bitmaps = [];
  for (const url of dataUrls) {
    const blob = await (await fetch(url)).blob();
    bitmaps.push(await createImageBitmap(blob));
  }
  const first = bitmaps[0];
  const scaleY = first.height / viewportHeight;
  const lastOffset = offsets[offsets.length - 1];
  const stitchHeight = Math.round((lastOffset + viewportHeight) * scaleY);
  let scale = 1;
  if (stitchHeight > MAX_STITCH_HEIGHT_PX) {
    scale = MAX_STITCH_HEIGHT_PX / stitchHeight;
  }
  const outW = Math.max(1, Math.round(first.width * scale));
  const outH = Math.max(1, Math.round(stitchHeight * scale));
  const canvas = new OffscreenCanvas(outW, outH);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, outW, outH);
  for (let i = 0; i < bitmaps.length; i += 1) {
    const b = bitmaps[i];
    const y = Math.round(offsets[i] * scaleY * scale);
    ctx.drawImage(b, 0, y, Math.round(b.width * scale), Math.round(b.height * scale));
    b.close();
  }
  const outBlob = await canvas.convertToBlob({ type: "image/jpeg", quality: CAPTURE_QUALITY / 100 });
  const buffer = await outBlob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return "data:image/jpeg;base64," + btoa(binary);
}

async function captureFullPage(tabId) {
  const metrics = await getScrollMetrics(tabId);
  if (metrics.scrollHeight <= metrics.viewportHeight) {
    const dataUrl = await chrome.tabs.captureVisibleTab({ format: "jpeg", quality: CAPTURE_QUALITY });
    return { dataUrl, sections: 1, truncated: false };
  }
  const offsets = computeSectionOffsets(metrics.scrollHeight, metrics.viewportHeight);
  const dataUrls = [];
  try {
    for (let i = 0; i < offsets.length; i += 1) {
      await scrollToOffset(tabId, offsets[i]);
      await sleep(SCROLL_WAIT_MS);
      dataUrls.push(await chrome.tabs.captureVisibleTab({ format: "jpeg", quality: CAPTURE_QUALITY }));
    }
  } finally {
    await restoreScroll(tabId, metrics.scrollX, metrics.scrollY);
  }
  const lastOffset = offsets[offsets.length - 1];
  const truncated = lastOffset < metrics.scrollHeight - metrics.viewportHeight - 1;
  const dataUrl = await stitchBitmaps(dataUrls, offsets, metrics.viewportHeight);
  return { dataUrl, sections: offsets.length, truncated };
}

// ---------- Convalida e cattura ----------

async function validateActiveTab() {
  const store = await getStore();
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = tabs && tabs[0];
  if (!tab || !tab.url) {
    await setStatus("error", "Nessuna scheda attiva trovata.");
    return { ok: false, error: "no-tab" };
  }
  if (tab.incognito) {
    await setStatus("error", "Cattura disabilitata in modalita' incognito.");
    return { ok: false, error: "incognito" };
  }

  let url;
  try {
    url = new URL(tab.url);
  } catch (e) {
    await setStatus("error", "URL della scheda non valido.");
    return { ok: false, error: "bad-url" };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    await setStatus("error", "Cattura non consentita su pagine di sistema (" + url.protocol + "//).");
    return { ok: false, error: "scheme", detail: url.protocol };
  }
  if (isBlockedHost(url.hostname)) {
    await setStatus("error", "Dominio bloccato per sicurezza (banca, pagamenti, login, password manager, webmail): nessuna cattura effettuata.");
    return { ok: false, error: "blocked-domain", hostname: url.hostname };
  }
  return { ok: true, tab, url, settings: store.settings };
}

async function handleCapture(fullPage) {
  const v = await validateActiveTab();
  if (!v.ok) return v;
  const tab = v.tab;
  const url = v.url;
  const settings = v.settings;

  // Modalita' scrape: estrazione testo diretta, locale, senza chiave API
  // e senza screenshot (inner Tex copre gia' l'intera pagina, anche se non
  // visibile: lo scorrimento non serve).
  if (settings.mode === "scrape") {
    await setStatus("capturing", "Estrazione del testo della pagina (scrape locale)…");
    let scraped;
    try {
      scraped = await scrapePageText(tab.id);
    } catch (e) {
      await setStatus("error", e.message || "Estrazione non riuscita.");
      return { ok: false, error: "scrape-failed", message: e.message };
    }
    const record = {
      id: (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()),
      ts: new Date().toISOString(),
      url: tab.url,
      title: tab.title || scraped.title || "",
      hostname: url.hostname,
      mode: "scrape",
      model: "local-scrape (nessuna API)",
      fullPage: true,
      sections: 1,
      truncated: scraped.truncated,
      text: scraped.text
    };
    const store = await getStore();
    store.records.push(record);
    store.stats.totalCaptured += 1;
    store.stats.totalTranscribed += 1;
    await chrome.storage.local.set({ records: store.records, stats: store.stats });
    await setStatus("ok", "Testo estratto e salvato in locale (" + scraped.text.length + " caratteri" + (scraped.truncated ? ", troncato al limite" : "") + "). Nessuna API chiamata.");
    return { ok: true, record };
  }

  // Modalita' con API Mistral: serve la chiave.
  if (!settings.apiKey) {
    await setStatus("error", "Nessuna chiave API configurata: apri le opzioni dell'estensione e inseriscila (oppure usa la modalita' scrape, che non richiede chiave).");
    return { ok: false, error: "no-api-key" };
  }

  let dataUrl;
  let captureMeta = { sections: 1, truncated: false };
  if (fullPage) {
    await setStatus("capturing", "Cattura a scorrimento della pagina intera in corso…");
    try {
      const r = await captureFullPage(tab.id);
      dataUrl = r.dataUrl;
      captureMeta = r;
    } catch (e) {
      await setStatus("error", "Cattura a scorrimento non riuscita: " + (e.message || "errore sconosciuto") + " Riprova con la cattura normale.");
      return { ok: false, error: "capture-failed", message: e.message };
    }
  } else {
    await setStatus("capturing", "Cattura della scheda visibile in corso…");
    try {
      dataUrl = await chrome.tabs.captureVisibleTab({ format: "jpeg", quality: CAPTURE_QUALITY });
    } catch (e) {
      await setStatus("error", "Impossibile catturare questa scheda (pagina di sistema, finestra non visibile o permesso mancante).");
      return { ok: false, error: "capture-failed" };
    }
  }

  await setStatus("analyzing", "Trascrizione in corso via Mistral (modalita': " + settings.mode + ", " + captureMeta.sections + " sezione" + (captureMeta.sections > 1 ? "i" : "") + ")…");
  const models = [];
  let text = "";
  try {
    if (settings.mode === "ocr" || settings.mode === "both") {
      text += await mistralOcr(settings.apiKey, dataUrl);
      models.push(OCR_MODEL);
    }
    if (settings.mode === "pixtral" || settings.mode === "both") {
      const t = await mistralPixtral(settings.apiKey, settings.pixtralModel, dataUrl);
      text += (text ? "\n\n---\n\n" : "") + t;
      models.push(settings.pixtralModel || DEFAULT_PIXTRAL_MODEL);
    }
  } catch (e) {
    if (e.code === "auth") {
      await setStatus("error", "Chiave API Mistral non valida (401/403). Aggiornala nelle opzioni.");
    } else {
      await setStatus("error", e.message || "Errore durante la trascrizione.");
    }
    return { ok: false, error: e.code || "api", message: e.message };
  }

  const record = {
    id: (typeof crypto !== "undefined" && crypto.randomUUID) ? crypto.randomUUID() : String(Date.now()),
    ts: new Date().toISOString(),
    url: tab.url,
    title: tab.title || "",
    hostname: url.hostname,
    mode: settings.mode,
    model: models.join(" + "),
    fullPage: Boolean(fullPage),
    sections: captureMeta.sections,
    truncated: captureMeta.truncated,
    text
  };
  const store = await getStore();
  store.records.push(record);
  store.stats.totalCaptured += 1;
  store.stats.totalTranscribed += 1;
  await chrome.storage.local.set({ records: store.records, stats: store.stats });
  await setStatus("ok", "Trascrizione salvata in locale (" + text.length + " caratteri, modello: " + record.model + ", sezioni: " + record.sections + (record.truncated ? ", pagina troncata" : "") + ").");
  return { ok: true, record };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return undefined;
  if (msg.type === "capture") {
    handleCapture(Boolean(msg.fullPage))
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: "internal", message: String((e && e.message) || e) }));
    return true;
  }
  if (msg.type === "getState") {
    getState().then((s) => sendResponse(s));
    return true;
  }
  return undefined;
});
