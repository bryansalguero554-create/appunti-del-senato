# 📚 Appunti del Senato

Sito di studio con appunti condivisi, divisi per **materia → argomento (cartella) → appunti**, con
visualizzatore multi-formato, **quiz di verifica**, **assistente AI**, **sincronizzazione con Google Drive**
e un'**area riservata al proprietario** con gestione delle sessioni e dei visitatori in tempo reale.
Design minimalista in stile Apple, con tema chiaro/scuro automatico e animazioni 3D.

## Funzionalità

| Area | Cosa fa |
|---|---|
| **Home** | Saluto personale: **"Ciao Nome."** alla prima visita, **"Bentornato, Nome."** dalle visite successive, con scena 3D animata delle materie. |
| **Account** | Registrazione e accesso con email e password (hash bcrypt), sessioni sicure, cambio password, elenco dei propri dispositivi con disconnessione remota. |
| **Materie** | Card 3D che si inclinano seguendo il mouse, con icona, colore e contatori. |
| **Argomenti** | Le cartelle (es. *Modulo 1*) si "aprono" in 3D al passaggio del mouse e mostrano autori, formati e ultimi file. |
| **Appunti** | Ogni utente carica i propri appunti (fino a 20 file insieme). Anteprime della prima pagina dei PDF e delle immagini, filtri per autore e formato. |
| **Visualizzatore** | PDF, HTML (isolato in sandbox), Word, Excel/ODS, Markdown, testo/codice, CSV, immagini, audio e video direttamente nel browser; gli altri formati si scaricano. |
| **Google Drive** | Le materie e le cartelle del sito sono le cartelle del tuo Drive, sempre sincronizzate nei due sensi (vedi sotto). |
| **Assistente AI** | Chat che conosce la materia e l'argomento aperti e legge l'appunto che stai guardando (PDF, immagini, Word, PowerPoint, HTML, testo). Usa Claude di Anthropic. |
| **Quiz** | Quiz a scelta multipla creati a mano o **generati dall'AI** dagli appunti; correzione sul server, spiegazioni e classifica. |
| **👑 Area riservata** | Solo per il proprietario: statistiche, **chi è online adesso** e su quale pagina, gestione **sessioni**, utenti (ruoli, sospensione, reset password), contenuti, Google Drive e impostazioni. |
| **Pagina 404** | Pagina personalizzata con "404" in rilievo 3D e un foglio di appunti che vola. |

### Ruoli

- **Proprietario (VIP)** – tutti i permessi più l'area riservata. È l'account con l'email `OWNER_EMAIL`
  (`bryansalguero26@icloud.com`); quell'email non può essere usata da nessun altro per registrarsi.
- **Moderatore** – assegnato dal proprietario: crea/modifica materie ed elimina qualsiasi contenuto.
- **Utente** – studia, carica appunti, crea argomenti e quiz, gestisce solo i propri contenuti.

---

## 🚀 Messa online (passo per passo)

Il sito è un'app Node.js con database integrato. La strada più semplice è **Render**, che legge già la
configurazione dal file `render.yaml` di questo repository.

> 💶 Per non perdere utenti e appunti a ogni aggiornamento serve un disco persistente, disponibile sul piano
> **Starter di Render (circa 7 $/mese)**. Il piano gratuito funziona per provare, ma i dati vengono cancellati a ogni riavvio.

1. Vai su **<https://render.com>** e accedi con il tuo account **GitHub**.
2. Clicca **New → Blueprint** e scegli il repository **appunti-del-senato** (branch `studio-dei-senatori`).
3. Render ti chiede i valori segreti:
   - `OWNER_PASSWORD` → la password del tuo account VIP;
   - `ANTHROPIC_API_KEY` → la chiave dell'assistente AI (vedi sotto; puoi lasciarla vuota e aggiungerla dopo);
   - `GOOGLE_CLIENT_ID` e `GOOGLE_CLIENT_SECRET` → per Google Drive (vedi sotto; anche questi si possono aggiungere dopo);
   - `PUBLIC_URL` → lascialo vuoto per ora.
4. Clicca **Apply**. Dopo qualche minuto il sito è online a un indirizzo come
   `https://appunti-del-senato.onrender.com`.
5. Torna in **Environment** del servizio, imposta `PUBLIC_URL` con quell'indirizzo e salva.
6. Apri il sito e accedi con `bryansalguero26@icloud.com` e la password scelta. 🎉

Per un dominio tuo (es. `appuntidelsenato.it`): Render → servizio → **Settings → Custom Domains**.
Ogni volta che il branch `studio-dei-senatori` viene aggiornato, Render ripubblica il sito da solo.

C'è anche un `Dockerfile` se preferisci un altro servizio (Railway, Fly.io, un VPS…): monta un disco su `/data`.

### 🤖 Chiave per l'assistente AI

1. Vai su **<https://console.anthropic.com>** e crea un account (è separato dall'abbonamento a Claude.ai).
2. In **Billing** aggiungi un metodo di pagamento e un po' di credito: l'API si paga a consumo.
3. **Settings → API Keys → Create Key**, copia la chiave (inizia con `sk-ant-api03-…`; viene mostrata una sola volta).
4. Incollala in `ANTHROPIC_API_KEY` su Render (**Environment**) e salva: il sito si riavvia con l'AI attiva.

Ogni utente può fare al massimo `AI_DAILY_LIMIT` richieste al giorno (predefinito 100; il proprietario non ha limiti).

### ☁️ Google Drive

**Come funziona:** scegli una cartella del tuo Drive (es. "Appunti"). Le sue sottocartelle diventano le
**materie**, le sottocartelle di ogni materia diventano gli **argomenti**, e i file dentro sono gli **appunti**:

```
Appunti/                    ← cartella principale
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

**Configurazione (una volta sola, circa 10 minuti):**

1. Vai su **<https://console.cloud.google.com>** e crea un progetto (es. "Appunti del Senato").
2. **API e servizi → Libreria** → cerca **Google Drive API** → **Abilita**.
3. **API e servizi → Schermata consenso OAuth**: tipo **Esterno**, nome dell'app, la tua email come assistenza.
   Poi clicca **Pubblica app** (in modalità "Test" Google scollega il Drive ogni 7 giorni).
4. **API e servizi → Credenziali → Crea credenziali → ID client OAuth** → tipo **Applicazione web**.
   In **URI di reindirizzamento autorizzati** aggiungi:
   `https://IL-TUO-SITO.onrender.com/api/drive/callback`
5. Copia **ID client** e **Client secret** in `GOOGLE_CLIENT_ID` e `GOOGLE_CLIENT_SECRET` su Render e salva.
6. Sul sito: **👑 Area riservata → Google Drive → Collega Google Drive**. Google mostrerà l'avviso
   "app non verificata" (è normale, l'app è tua): **Avanzate → Vai a … → Consenti**.
7. Incolla il link della cartella principale (o sceglila dall'elenco) e premi **Usa questa cartella**.

---

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
| `ANTHROPIC_API_KEY` | – | Chiave per l'assistente AI |
| `AI_MODEL` | `claude-opus-5-5` | Modello Claude |
| `AI_DAILY_LIMIT` | `100` | Richieste AI per utente ogni 24 ore |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | – | Credenziali OAuth per Google Drive |
| `PUBLIC_URL` | – | Indirizzo pubblico del sito (per il collegamento a Google) |
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
server.js              avvio di Express, presenza in tempo reale, pagina 404
src/config.js          configurazione da variabili d'ambiente
src/db.js              schema SQLite (node:sqlite)
src/auth.js            password, sessioni, ruoli, CSRF, account proprietario
src/presence.js        chi è online adesso
src/extract.js         lettura del contenuto degli appunti per l'AI
src/drive.js           client Google Drive
src/sync.js            sincronizzazione bidirezionale con il Drive
src/routes/            API: auth, content, quizzes, ai, admin, drive
public/                frontend (HTML, CSS, JavaScript senza framework; effetti 3D in js/fx.js)
test/                  test automatici
render.yaml, Dockerfile  messa online
```
