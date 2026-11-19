const $ = (id) => document.getElementById(id);

async function load() {
  const data = await chrome.storage.local.get(["settings", "records", "stats"]);
  const settings = Object.assign(
    { apiKey: "", mode: "scrape", pixtralModel: "pixtral-12b-2409" },
    data.settings || {}
  );
  $("apiKey").value = settings.apiKey;
  $("mode").value = settings.mode;
  $("pixtralModel").value = settings.pixtralModel;
  $("recordCount").textContent = String((data.records || []).length);
  renderRecords(data.records || []);
}

function renderRecords(records) {
  const list = $("records");
  list.innerHTML = "";
  if (!records.length) {
    list.textContent = "Nessun elemento salvato.";
    return;
  }
  const sorted = [...records].sort((a, b) => (a.ts < b.ts ? 1 : -1));
  for (const r of sorted.slice(0, 100)) {
    const item = document.createElement("details");
    const sum = document.createElement("summary");
    sum.textContent =
      new Date(r.ts).toLocaleString("it-IT") + " — " + r.hostname + " — " +
      (r.title || "(senza titolo)") + " [" + r.mode + ", " + r.model + "]";
    const pre = document.createElement("pre");
    pre.textContent = r.text;
    item.appendChild(sum);
    item.appendChild(pre);
    list.appendChild(item);
  }
}

$("save").addEventListener("click", async () => {
  const settings = {
    apiKey: $("apiKey").value.trim(),
    mode: $("mode").value,
    pixtralModel: $("pixtralModel").value.trim() || "pixtral-12b-2409"
  };
  await chrome.storage.local.set({ settings });
  $("saveStatus").textContent = "Impostazioni salvate.";
});

$("showKey").addEventListener("change", () => {
  $("apiKey").type = $("showKey").checked ? "text" : "password";
});

function download(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function getRecords() {
  const d = await chrome.storage.local.get("records");
  return d.records || [];
}

$("exportJsonl").addEventListener("click", async () => {
  const records = await getRecords();
  const day = new Date().toISOString().slice(0, 10);
  const content = records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : "");
  download("browser-recorder-" + day + ".json", content, "application/json");
});

$("clear").addEventListener("click", async () => {
  if (!confirm("Eliminare tutti gli elementi salvati in locale?")) return;
  await chrome.storage.local.set({ records: [] });
  await load();
});

load();
