import { chatCompletion, DEFAULT_CHAT_MODEL } from "./mistral.js";

const MAX_HISTORY = 20;
const MAX_CONTEXT_CHARS = 60000;

// Stato di sessione (effimero): si svuota chiudendo il pannello.
let history = [];
let record = null;

const messagesEl = document.getElementById("messages");
const questionEl = document.getElementById("question");
const sendBtn = document.getElementById("sendBtn");
const contextEl = document.getElementById("context");

const SYSTEM_PROMPT =
  "Sei un assistente che risponde a domande sul contenuto di una pagina web catturata dall'utente. " +
  "Rispondi in italiano, in modo chiaro e conciso, basandoti SOLO sul contenuto fornito. " +
  "Se la risposta non è nel contenuto, dillo esplicitamente senza inventare.";

function addMessage(role, text) {
  const div = document.createElement("div");
  div.className = "msg " + role;
  div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

async function loadRecord() {
  const data = await chrome.storage.local.get("records");
  const records = Array.isArray(data.records) ? data.records : [];
  record = records.length ? records[records.length - 1] : null;
  if (record) {
    contextEl.textContent = "Contesto: " + (record.hostname || "") + " — " + (record.title || "(senza titolo)") + " (" + (record.text || "").length + " caratteri)";
  } else {
    contextEl.textContent = "Nessuna pagina catturata: apri l'estensione e premi \"Cattura e trascrivi\" prima di chiedere.";
  }
}

// Aggiorna il contesto se nel frattempo è stata catturata un'altra pagina.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.records) loadRecord();
});

async function ask(question) {
  const data = await chrome.storage.local.get("settings");
  const settings = data.settings || {};
  const apiKey = settings.apiKey || "";
  if (!apiKey) { addMessage("assistant", "Nessuna chiave API configurata: apri le opzioni dell'estensione."); return; }
  if (!record) { addMessage("assistant", "Prima cattura una pagina con il pulsante dell'estensione, poi riprova."); return; }

  history.push({ role: "user", content: question });
  const payload = {
    model: settings.chatModel || DEFAULT_CHAT_MODEL,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "system", content: "Contenuto della pagina catturata:\n" + (record.text || "").slice(0, MAX_CONTEXT_CHARS) },
      ...history
    ],
    max_tokens: 800
  };
  try {
    const answer = (await chatCompletion(apiKey, payload)) || "(nessuna risposta)";
    history.push({ role: "assistant", content: answer });
    if (history.length > MAX_HISTORY) history = history.slice(-MAX_HISTORY);
    addMessage("assistant", answer);
  } catch (e) {
    history.pop();
    if (e.code === "auth") {
      addMessage("assistant", "Chiave API Mistral non valida (401/403): aggiornala nelle opzioni.");
    } else {
      addMessage("assistant", e.message || "Errore di rete.");
    }
  }
}

sendBtn.addEventListener("click", async () => {
  const q = questionEl.value.trim();
  if (!q) return;
  questionEl.value = "";
  sendBtn.disabled = true;
  addMessage("user", q);
  await ask(q);
  sendBtn.disabled = false;
  questionEl.focus();
});

questionEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendBtn.click(); }
});

loadRecord();
