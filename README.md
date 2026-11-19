# Browser Recorder (on-demand)

Estensione per Google Chrome (Manifest V3, uso locale in modalità sviluppatore) che **cattura e trascrive la pagina corrente solo quando l'utente lo richiede esplicitamente**, usando esclusivamente le API di Mistral AI. I risultati vengono salvati in locale con metadati, così un assistente può in seguito rispondere a domande su ciò che hai visto.

> **Design deliberate: niente registrazione continua.** A differenza di un "registratore" automatico, non c'è alcun loop in background che cattura lo schermo a intervalli e non invia nulla a server esterni senza un'azione esplicita. Ogni cattura parte da un click nel popup, riguarda una sola scheda, e fallisce a priori su domini sensibili. Questo è lo stesso modello di funzionamento delle estensioni "assistente nel browser" on-demand (es. Claude in Chrome).

## Installazione

1. Apri `chrome://extensions` in Chrome.
2. Attiva **Modalità sviluppatore** (toggle in alto a destra).
3. Clicca **Carica estensione non pacchettizzata** e seleziona la cartella `browser-recorder/`.
4. Clicca sull'icona dell'estensione nella barra degli strumenti (se non compare, premi il pulsante "Estensioni" e fissala), poi **Apri opzioni** e incolla la tua chiave API Mistral (`sk-…`, creala su [console.mistral.ai](https://console.mistral.ai)). La chiave resta solo in `chrome.storage.local`.

## Come si usa

1. Apri la pagina che ti interessa.
2. Clicca l'icona dell'estensione → **Cattura e trascrivi la pagina corrente**.
3. Lo screenshot JPEG (qualità 85) della scheda visibile viene inviato a Mistral, trascritto, e salvato in locale con metadati.
4. Consulta lo storico e esporta manualmente dalla pagina **Opzioni** (JSONL e TXT).
5. (Opzionale) Dal popup premi **Chatta con la pagina**: si apre il side panel e puoi fare domande sull'ultima pagina catturata (Q&A effimero, valido finché il pannello resta aperto; il contesto si aggiorna da solo se catturi un'altra pagina).

## Configurazione (pagina Opzioni)

- **Chiave API Mistral**: salvata in `chrome.storage.local`, mai hardcodata.
- **Modalità di analisi**:
  - `ocr` (default): endpoint `POST https://api.mistral.ai/v1/ocr` con modello `mistral-ocr-latest`, estrae il testo della pagina;
  - `pixtral`: `POST https://api.mistral.ai/v1/chat/completions` con modello multimodale (default `pixtral-12b-2409`, modificabile) e prompt di trascrizione in italiano;
  - `both`: entrambe, concatenate.
- **Modello chat** (side panel): default `mistral-small-latest`, usato per le domande sull'ultima pagina catturata.
- **Esporta JSONL / TXT** e **Svuota archivio**: esportazione manuale, niente download automatici.

## Architettura

```
browser-recorder/
├── manifest.json      MV3: permissions tabs, storage, activeTab, sidePanel + host api.mistral.ai
├── mistral.js         modulo ES condiviso: fetch con retry/backoff + chiamate OCR/Pixtral/chat a Mistral
├── background.js      service worker (ES module): gestisce "capture", chiama mistral.js, salva in storage.local
├── popup.html/.css/.js     pulsante di cattura, apertura side panel, stato, contatori
├── chat.html/.css/.js      side panel "Chatta con la pagina": Q&A effimero sull'ultimo record
├── options.html/.css/.js   chiave API, modelli, modalità, storico, export manuale
└── README.md
```

- **Permessi e perché**: `tabs` per leggere URL/titolo della scheda attiva; `storage` per impostazioni e archivio locale; `activeTab` perché la cattura `chrome.tabs.captureVisibleTab` è consentita sulla scheda attiva solo dopo che l'utente ha invocato l'estensione (il click sul popup); `sidePanel` solo per aprire il pannello chat su click dell'utente. `host_permissions` è limitato a `https://api.mistral.ai/*`, unico dominio esterno contattato. **Non** servono `<all_urls>`, `scripting` né `downloads`: nessun content script viene iniettato nelle pagine e l'export avviene via blob nel browser, su richiesta.
- **Flusso cattura**: popup → `chrome.runtime.sendMessage({type:"capture"})` → service worker: validazioni (chiave, scheda attiva, incognito, scheme, blacklist hard-coded) → `captureVisibleTab` → `mistral.js` (fetch con retry/backoff) → salvataggio record in `chrome.storage.local`.
- **Flusso chat**: side panel → legge l'ultimo record da `chrome.storage.local` → `mistral.js` `chatCompletion` con system prompt + contesto (max 60k caratteri) + storico (max 20 messaggi). Lo storico è solo in memoria: chiudendo il pannello si azzera.
- **Record salvato**: `{ id, ts (ISO), url, title, hostname, mode, model, text }`. Lo screenshot **non** viene conservato, solo la trascrizione testuale.
- **Errori API**: 401/403 → messaggio "chiave non valida" nel popup; 429/5xx → retry con backoff esponenziale (fino a 3 tentativi, rispettando `Retry-After`); altri errori mostrati senza interrompere nulla (non esiste un loop da interrompere).
- **Niente service-worker "riavviabile" da gestire**: non essendoci loop, il service worker si riattiva da solo a ogni click del popup.

## Privacy e domini bloccati

- Nessuna telemetria. L'unico traffico di rete è verso `api.mistral.ai`, e avviene **solo** quando premi il pulsante di cattura: in quel momento lo screenshot della pagina visibile viene inviato a Mistral per la trascrizione.
- La cattura è **bloccata a livello di codice** (non disattivabile dalle opzioni) su domini che contengono: `bank`, `banca`, `banco`, `paypal`, `satispay`, `postepay`, `revolut`, `n26`, `wise.com`, `1password`, `lastpass`, `bitwarden`, `dashlane`, `keepass`, `proton.me`, `protonmail`, `gmail`, `mail.google`, `outlook.live`, `outlook.office`, `office365`, `login.microsoftonline`, `accounts.google`, `signin.`, `auth0.`, `.okta.`, `webmail`, `roundcube`, `stripe.com`.
- Pagine `chrome://`, `about:`, `chrome-extension://`, `file://` e schede in incognito non vengono mai catturate.

## Limiti noti

- Solo la **scheda visibile attiva** nella finestra corrente: no schermo intero, no altre finestre, no incognito.
- Se la finestra è minimizzata o la scheda non è renderizzata, `captureVisibleTab` fallisce e l'errore viene mostrato nel popup.
- La qualità della trascrizione dipende dal modello scelto e dalla risoluzione dello schermo.

## Test manuali consigliati

1. **Senza chiave API**: apri il popup e premi cattura → messaggio "Nessuna chiave API configurata".
2. **Chiave errata**: inserisci una chiave invalida nelle opzioni, cattura una pagina normale → errore 401 nel popup, nessun record salvato.
3. **Dominio bloccato**: vai su una pagina di login (es. accounts.google.com) e premi cattura → "Dominio bloccato", nessun record.
4. **Pagina di sistema**: su `chrome://extensions` → errore di cattura, nessun record.
5. **Pagina normale**: cattura una pagina di noticias → record salvato, visibile nello storico delle opzioni.
6. **Export**: esporta JSONL e TXT, verifica che i file contengano i metadati + testo; poi "Svuota archivio".
7. **Ricarica estensione**: premi "Ricarica" in `chrome://extensions`, verifica che popup e storico siano intatti (dati in `storage.local`).

## Collegare l'archivio a un assistente

Esporta lo storico in JSONL dalle opzioni e caricalo dove preferisci (una chat con un modello, uno strumento RAG locale, un notebook): ogni riga contiene timestamp, URL, titolo, hostname e testo trascritto, quindi puoi chiedere cose del tipo "cosa ho letto oggi su X?" o "riassumi gli articoli aperti nel pomeriggio". Finché non esporti e non partage tu stesso il file, i dati restano solo sul tuo computer (a parte lo screenshot inviato a Mistral al momento della singola cattura scelta da te).
