// Statos di sessione (effimero): si svuota chiudendo il pannello.
let history = [];
let record = null;

const messagesEl = document.getElementById("messages");
const questionEl = document.getElementById("question");
const sendBtn = document.getElementById("sendBtn");
const contextEl = document.getElementById("context");

function addMessage(role, text) {
  const div = document.createElement("div");
  div.className = "msg " + role;
  div.textContent = text;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

async function loadRecord() {
  const data = await chrome.storage.local.get(["records", "settings"]);
  const records = Array.isArray(data.records) ? data.records : [];
  record = records.length ? records[records.length - 1] : null;
  if (record) {
    contextEl.textContent = "Contesto: " + (record.hostname || "") + " — " + (record.title || "(senza titolo)") + " (" + (record.text || "").length + " caratteri)";
  } else {
    contextEl.textContent = "Nessuna pagina catturata: apri l'estensione e premi \"Cattura e trascrivi\" prima di chiedere.";
  }
}

const SYSTEM_PROMPT =
  "Sei un assistente che risponde a domande sul contenuto di una pagina web catturata dall'utente. " +
  "Rispondi in italiano, in modo chiaro e conciso, basandoti SOLO sul contenuto fornito. " +
  "Se la risposta non è nel contenuto, dillo esplicitamente senza inventare.";

async function ask(question) {
  const data = await chrome.storage.local.get(["settings"]);
  const apiKey = (data.settings || {}).apiKey || "";
  if (!apiKey) { addMessage("assistant", "Nessuna chiave API configurata: apri le opzioni dell'estensione."); return; }
  if (!record) { addMessage("assistant", "Prima cattura una pagina con il pulsante dell'estensione, poi riprova."); return; }

  history.push({ role: "user", content: question });
  const body = {
    model: "mistral-small-latest",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "system", content: "Contenuto della pagina catturata:\n" + (record.text || "").slice(0, 60000) },
      ...history
    ],
    max_tokens: 800
  };
  try {
    const res = await fetch("https://api.mistral.ai/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const msg = "Errore API Mistral (HTTP " + res.status + ").";
      history.pop();
      addMessage("assistant", msg);
      return;
    }
    const json = await res.json();
    const answer = json.choices && json.choices[0] && json.choices[0].message ? json.choices[0].message.content : "(nessuna risposta)";
    history.push({ role: "assistant", content: answer });
    addMessage("assistant", answer);
  } catch (e) {
    history.pop();
    addMessage("assistant", "Errore di rete: " + e.message);
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
