const statusEl = document.getElementById("status");
const captureBtn = document.getElementById("captureBtn");
const resultEl = document.getElementById("result");
const countsEl = document.getElementById("counts");
const optionsBtn = document.getElementById("optionsBtn");
const chatBtn = document.getElementById("chatBtn");

function renderState(state) {
  const s = state.lastStatus || { state: "idle", message: "Pronto." };
  if (!state.settings.hasApiKey) {
    statusEl.textContent = "Nessuna chiave API configurata: apri le opzioni dell'estensione.";
    statusEl.dataset.state = "error";
  } else {
    statusEl.textContent = s.message;
    statusEl.dataset.state = s.state;
  }
  const st = state.stats || { totalTranscribed: 0 };
  countsEl.textContent =
    "Trascrizioni salvate: " + st.totalTranscribed +
    " (totale) · elementi in archivio: " + state.recordCount;
}

async function refresh() {
  try {
    const state = await chrome.runtime.sendMessage({ type: "getState" });
    renderState(state);
  } catch (e) {
    statusEl.textContent = "Errore: " + e.message;
    statusEl.dataset.state = "error";
  }
}

captureBtn.addEventListener("click", async () => {
  captureBtn.disabled = true;
  resultEl.textContent = "";
  statusEl.dataset.state = "capturing";
  statusEl.textContent = "Cattura e analisi in corso…";
  try {
    const res = await chrome.runtime.sendMessage({ type: "capture" });
    if (res && res.ok) {
      const r = res.record;
      resultEl.textContent =
        "Salvato: " + r.hostname + " — " + (r.title || "(senza titolo)") +
        " (" + r.text.length + " caratteri, modello: " + r.model + ")";
    } else {
      resultEl.textContent =
        "Operazione non riuscita: " + ((res && (res.message || res.error)) || "errore sconosciuto");
    }
  } catch (e) {
    resultEl.textContent = "Errore: " + e.message;
  } finally {
    captureBtn.disabled = false;
    await refresh();
  }
});

chatBtn.addEventListener("click", async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await chrome.sidePanel.open({ windowId: tab.windowId });
    window.close();
  } catch (e) {
    // Fallback: apri la chat in una scheda se il pannello non è disponibile
    chrome.tabs.create({ url: chrome.runtime.getURL("chat.html") });
    window.close();
  }
});

optionsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());

refresh();
