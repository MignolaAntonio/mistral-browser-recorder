import { OCR_MODEL, DEFAULT_PIXTRAL_MODEL, ocrImage, describeImage } from "./mistral.js";

const CAPTURE_QUALITY = 85;

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

async function getStore() {
  const data = await chrome.storage.local.get(["settings", "records", "stats", "lastStatus"]);
  return {
    settings: Object.assign(
      { apiKey: "", mode: "ocr", pixtralModel: DEFAULT_PIXTRAL_MODEL },
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

async function handleCapture() {
  const store = await getStore();
  const settings = store.settings;

  if (!settings.apiKey) {
    await setStatus("error", "Nessuna chiave API configurata: apri le opzioni dell'estensione e inseriscila.");
    return { ok: false, error: "no-api-key" };
  }

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

  await setStatus("capturing", "Cattura della scheda visibile in corso…");
  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab({ format: "jpeg", quality: CAPTURE_QUALITY });
  } catch (e) {
    await setStatus("error", "Impossibile catturare questa scheda (pagina di sistema, finestra non visibile o permesso mancante).");
    return { ok: false, error: "capture-failed" };
  }

  await setStatus("analyzing", "Trascrizione in corso via Mistral (modalita': " + settings.mode + ")…");
  const models = [];
  let text = "";
  try {
    if (settings.mode === "ocr" || settings.mode === "both") {
      text += await ocrImage(settings.apiKey, dataUrl);
      models.push(OCR_MODEL);
    }
    if (settings.mode === "pixtral" || settings.mode === "both") {
      const t = await describeImage(settings.apiKey, settings.pixtralModel, dataUrl, PIXTRAL_PROMPT);
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
    text
  };
  store.records.push(record);
  store.stats.totalCaptured += 1;
  store.stats.totalTranscribed += 1;
  await chrome.storage.local.set({ records: store.records, stats: store.stats });
  await setStatus("ok", "Trascrizione salvata in locale (" + text.length + " caratteri, modello: " + record.model + ").");
  return { ok: true, record };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || !msg.type) return undefined;
  if (msg.type === "capture") {
    handleCapture()
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
