export const MISTRAL_BASE = "https://api.mistral.ai/v1";
export const OCR_MODEL = "mistral-ocr-latest";
export const DEFAULT_PIXTRAL_MODEL = "pixtral-12b-2409";
export const DEFAULT_CHAT_MODEL = "mistral-small-latest";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchWithRetry(url, options, maxRetries = 3) {
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

async function post(apiKey, path, payload) {
  const res = await fetchWithRetry(MISTRAL_BASE + path, {
    method: "POST",
    headers: {
      Authorization: "Bearer " + apiKey,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });
  return res.json();
}

export async function ocrImage(apiKey, dataUrl) {
  const json = await post(apiKey, "/ocr", {
    model: OCR_MODEL,
    document: { type: "image_url", image_url: dataUrl }
  });
  const pages = Array.isArray(json.pages) ? json.pages : [];
  return pages.map((p) => p.markdown || "").join("\n\n").trim();
}

export async function describeImage(apiKey, model, dataUrl, prompt) {
  const json = await post(apiKey, "/chat/completions", {
    model: model || DEFAULT_PIXTRAL_MODEL,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: dataUrl } }
        ]
      }
    ]
  });
  const choice = json.choices && json.choices[0];
  return String((choice && choice.message && choice.message.content) || "").trim();
}

export async function chatCompletion(apiKey, payload) {
  const json = await post(apiKey, "/chat/completions", payload);
  const choice = json.choices && json.choices[0];
  return String((choice && choice.message && choice.message.content) || "").trim();
}
