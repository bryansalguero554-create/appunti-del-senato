# 📚 Appunti del Senato

Sito di studio con appunti condivisi, divisi per **materia → argomento (cartella) → appunti**, con
visualizzatore multi-formato, **quiz di verifica**, **assistente AI**, **sincronizzazione con Google Drive**
e un'**area riservata al proprietario** con gestione delle sessioni e dei visitatori in tempo reale.
Design minimalista in stile Apple, con tema chiaro/scuro automatico e animazioni 3D.

## Funzionalità

| Area | Cosa fa |
|---|---|
| **Home** | Saluto personale: **"Ciao Nome."** alla prima visita, **"Bentornato, Nome."** dalle visite successive, con scena 3D animata. Il pulsante **"Le tue materie"** apre la griglia ordinata di tutte le materie. |
| **Account** | Registrazione e accesso con email e password (hash bcrypt), sessioni sicure, cambio password, elenco dei propri dispositivi con disconnessione remota. |
| **Materie** | Il sito parte con Storia, Filosofia, Scienze umane, Fisica, Italiano, Spagnolo, Inglese, Matematica, Diritto e Storia dell'arte (create una sola volta al primo avvio; il proprietario può aggiungerne, rinominarle o eliminarle). Card 3D che si inclinano seguendo il mouse. |
| **Argomenti** | Le cartelle (es. *Modulo 1*) si "aprono" in 3D al passaggio del mouse e mostrano autori, formati e ultimi file. |
| **Appunti** | Ogni utente carica i propri appunti (fino a 20 file insieme). Anteprime della prima pagina dei PDF e delle immagini, filtri per autore e formato. |
| **Visualizzatore** | PDF, HTML (isolato in sandbox), Word, Excel/ODS, Markdown, testo/codice, CSV, immagini, audio e video direttamente nel browser; gli altri formati si scaricano. |
| **Google Drive** | È il cloud principale del sito: materie e argomenti sono le cartelle del tuo Drive, sempre sincronizzate nei due sensi, e anche il database viene salvato lì. |
| **Assistente AI** | Chat che conosce la materia e l'argomento aperti e legge l'appunto che stai guardando (PDF, immagini, Word, PowerPoint, HTML, testo). Usa **Google Gemini** con chiave gratuita (in alternativa Claude). Se non è configurata, l'AI resta nascosta. |
| **Quiz** | Quiz a scelta multipla creati a mano o **generati dall'AI** dagli appunti; correzione sul server, spiegazioni e classifica. |
| **👑 Area riservata** | Solo per il proprietario: statistiche, **chi è online adesso** e su quale pagina, gestione **sessioni**, utenti (ruoli, sospensione, reset password), contenuti, Google Drive e impostazioni. |
| **Pagina 404** | Pagina personalizzata con "404" in rilievo 3D e un foglio di appunti che vola. |

### Ruoli

- **Proprietario (VIP)** – tutti i permessi più l'area riservata. È l'account con l'email `OWNER_EMAIL`
  (`bryansalguero26@icloud.com`); quell'email non può essere usata da nessun altro per registrarsi.
- **Moderatore** – assegnato dal proprietario: crea/modifica materie ed elimina qualsiasi contenuto.
- **Utente** – studia, carica appunti, crea argomenti e quiz, gestisce solo i propri contenuti.

---

## 🚀 Messa online gratis (passo per passo)

Tutto a **costo zero**:

| Cosa | Servizio | Costo |
|---|---|---|
| Server del sito | **Render**, piano gratuito | 0 € |
| Cloud per appunti e database | **il tuo Google Drive** (15 GB gratis, 2 TB con Google AI Pro) | 0 € in più |
| Assistente AI | **Google Gemini**, chiave gratuita | 0 € |

Il server gratuito di Render non ha un disco permanente (si azzera a ogni riavvio), quindi il sito usa
**Google Drive come cloud principale**: gli appunti stanno nel Drive e vengono scaricati solo quando qualcuno li apre,
mentre il database (utenti, quiz, sessioni) viene copiato nel Drive pochi secondi dopo ogni modifica e
ripristinato automaticamente a ogni riavvio. Unico difetto del piano gratuito: dopo 15 minuti senza visite
il sito "si addormenta" e la prima apertura successiva impiega circa un minuto.

Ci vogliono circa 20 minuti, una volta sola. Servono solo il tuo account Google e il tuo account GitHub.

### 1. Credenziali gratuite di Google (per il Drive)

1. Vai su **<https://console.cloud.google.com>** e accedi con il tuo account Google. Non serve la carta di credito.
2. In alto clicca **Seleziona un progetto → Nuovo progetto**, chiamalo "Appunti del Senato" e crealo.
3. Menu ☰ → **API e servizi → Libreria** → cerca **Google Drive API** → **Abilita**.
4. Menu ☰ → **API e servizi → Schermata consenso OAuth** (o "Google Auth Platform") → **Inizia**:
   nome app "Appunti del Senato", la tua email, tipo di utenti **Esterno** → **Crea**.
   Poi in **Pubblico** clicca **Pubblica app** → Conferma (in modalità "Test" Google scollegherebbe il Drive ogni 7 giorni).
5. Menu ☰ → **API e servizi → Credenziali → Crea credenziali → ID client OAuth** → tipo **Applicazione web**.
   In **URI di reindirizzamento autorizzati** per ora scrivi `https://appunti-del-senato.onrender.com/api/drive/callback`
   (se Render ti darà un indirizzo diverso, lo correggerai al passo 3).
6. Copia **ID client** e **Client secret**: ti servono tra poco.

### 2. Chiave gratuita di Gemini (per l'assistente AI)

1. Vai su **<https://aistudio.google.com>** con il tuo account Google.
2. Clicca **Get API key → Create API key** e copiala.

Il piano gratuito ha un limite di richieste al minuto e al giorno, più che sufficiente per un sito di studio.
Nota: con la chiave gratuita Google può usare i testi inviati all'AI per migliorare i propri servizi.
Se vuoi tenere l'AI spenta, salta questo passaggio.

### 3. Pubblica su Render

1. Vai su **<https://render.com>** e accedi con **GitHub**.
2. **New → Blueprint** → scegli il repository **appunti-del-senato** (branch `studio-dei-senatori`).
3. Inserisci i valori richiesti:
   - `OWNER_PASSWORD` → la password del tuo account VIP;
   - `GOOGLE_CLIENT_ID` e `GOOGLE_CLIENT_SECRET` → quelli del passo 1;
   - `GEMINI_API_KEY` → la chiave del passo 2 (o lascia vuoto);
   - `DRIVE_REFRESH_TOKEN` → **lascialo vuoto per ora**.
4. **Apply**. Dopo qualche minuto il sito è online, es. `https://appunti-del-senato.onrender.com`.
   Se l'indirizzo è diverso da quello del passo 1.5, correggi l'URI di reindirizzamento su Google Cloud.

### 4. Collega il Drive

1. Apri il sito e accedi con `bryansalguero26@icloud.com`.
2. **👑 Area riservata → Google Drive → Collega Google Drive**. Google mostrerà "app non verificata"
   (è normale: l'app è tua) → **Avanzate → Vai a Appunti del Senato → Continua**.
3. Scegli la cartella del Drive che conterrà le materie (o creane una, es. "Appunti") → **Usa questa cartella**.
   Il sito crea dentro le cartelle delle materie e importa quello che c'è già.
4. Nella stessa pagina, in **"Database salvato nel Drive"**, clicca **Copia** e incolla il codice su Render in
   **Environment → DRIVE_REFRESH_TOKEN** → **Save**. Fatto: da ora il sito si ricollega da solo dopo ogni riavvio. 🎉

> 💡 Preferisci un server sempre acceso e veloce? Su Render passa al piano **Starter** (~7 $/mese) e aggiungi un disco
> (o usa il `Dockerfile` su un altro servizio montando un disco su `/data`). Il Drive continuerà a funzionare uguale.

### ☁️ Come funziona la sincronizzazione con il Drive

```
Appunti/                    ← cartella principale scelta da te
├── Storia/                 ← materia
│   ├── Modulo 1/           ← argomento
│   │   ├── lezione.pdf     ← appunto
│   │   └── Riassunto       ← Documento Google (mostrato come PDF)
│   └── Modulo 2/
└── Matematica/
```

- Aggiungi, rinomini o elimini qualcosa **nel Drive** → il sito si aggiorna entro 5 minuti (o subito con "Sincronizza ora").
- Qualcuno crea una materia/argomento o carica un appunto **sul sito** → compare nella cartella giusta del Drive.
- Eliminare sul sito sposta l'elemento nel **cestino** del Drive (recuperabile per 30 giorni).
- I file messi direttamente nella cartella della materia (fuori da un argomento) non vengono importati.
- Se nel Drive esiste già una cartella con il nome di una materia (es. "Storia" o "storia"), le due vengono collegate.
- Il database del sito sta nella cartella **"Appunti del Senato – dati del sito (non toccare)"**, nella radice del Drive.

## Sviluppo in locale

Serve **Node.js 22.13 o superiore**.

```bash
npm install
cp .env.example .env      # poi apri .env e completa i valori (almeno OWNER_PASSWORD)
npm start                 # http://localhost:3000
npm test                  # test automatici
```

Per cambiare la password del proprietario dal server: `npm run set-owner-password -- "NuovaPassword"`.

> 🔒 Il file `.env` è escluso da git: password e chiavi non finiscono mai nel repository (che è pubblico).
> Nel database la password è conservata solo come hash bcrypt.

## Configurazione

| Variabile | Predefinito | Descrizione |
|---|---|---|
| `PORT` | `3000` | Porta HTTP |
| `OWNER_EMAIL` | `bryansalguero26@icloud.com` | Email dell'account proprietario |
| `OWNER_PASSWORD` | – | Password usata per creare l'account proprietario al primo avvio |
| `OWNER_NAME` | `Proprietario` | Nome visualizzato del proprietario |
| `GEMINI_API_KEY` | – | Chiave gratuita di Google Gemini per l'assistente AI |
| `GEMINI_MODEL` | Flash più recente | Modello Gemini da usare |
| `ANTHROPIC_API_KEY` | – | In alternativa a Gemini: chiave di Claude (a pagamento) |
| `AI_MODEL` | `claude-opus-5-5` | Modello Claude |
| `AI_DAILY_LIMIT` | `100` | Richieste AI per utente ogni 24 ore |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | – | Credenziali OAuth per Google Drive |
| `DRIVE_REFRESH_TOKEN` | – | Codice di accesso permanente al Drive (lo copi dall'area riservata); serve sui server senza disco |
| `PUBLIC_URL` | – | Indirizzo pubblico del sito (facoltativo, per il collegamento a Google) |
| `DRIVE_SYNC_MINUTES` | `5` | Frequenza della sincronizzazione automatica |
| `DRIVE_MAX_FILE_MB` | `100` | File del Drive più grandi non vengono importati |
| `MAX_UPLOAD_MB` | `50` | Dimensione massima per file caricato sul sito |
| `SESSION_DAYS` | `30` | Durata delle sessioni |
| `COOKIE_SECURE` | `false` | `true` quando il sito è in HTTPS |
| `TRUST_PROXY` | `false` | `true` dietro un reverse proxy (Render, ecc.) |
| `DATA_DIR` / `UPLOAD_DIR` | `data/` / `uploads/` | Dove salvare database e file |

## Sicurezza

- Password con bcrypt; token di sessione casuali salvati solo come hash; sessioni revocabili dal proprietario.
- Limite ai tentativi di accesso (10 errori ogni 15 minuti per IP) e protezione CSRF.
- I file HTML/SVG caricati vengono mostrati in una sandbox isolata: non possono leggere i cookie né usare le API del sito.
- Le soluzioni dei quiz non arrivano mai al browser prima della consegna.
- Google Drive: se la cartella principale risulta improvvisamente vuota, il sito non cancella nulla per sicurezza.

## Struttura del progetto

```
server.js              avvio: ripristina il database dal Drive se serve, poi carica src/main.js
src/main.js            Express, presenza in tempo reale, pagina 404
src/config.js          configurazione da variabili d'ambiente
src/db.js              schema SQLite (node:sqlite)
src/auth.js            password, sessioni, ruoli, CSRF, account proprietario
src/presence.js        chi è online adesso
src/extract.js         lettura del contenuto degli appunti per l'AI
src/drive.js           client Google Drive
src/sync.js            sincronizzazione bidirezionale con il Drive
src/backup.js          copia del database nel Drive; src/restore.js la ripristina all'avvio
src/gemini.js          client di Google Gemini per l'assistente AI
src/routes/            API: auth, content, quizzes, ai, admin, drive
public/                frontend (HTML, CSS, JavaScript senza framework; effetti 3D in js/fx.js)
test/                  test automatici
render.yaml, Dockerfile  messa online
```
