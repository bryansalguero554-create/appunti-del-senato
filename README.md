# 📚 Appunti del Senato

Sito di studio con appunti condivisi, divisi per **materia → argomento (cartella) → appunti**, con
visualizzatore multi-formato, **quiz di verifica**, **assistente AI** per togliere i dubbi e un'**area
riservata al proprietario** con gestione delle sessioni e visitatori in tempo reale.

## Funzionalità

| Area | Cosa fa |
|---|---|
| **Account** | Registrazione e accesso con email e password (hash bcrypt), sessioni sicure con cookie `httpOnly`, cambio password, elenco dei propri dispositivi con disconnessione remota. |
| **Materie** | La home mostra tutte le materie (icona, colore, numero di argomenti/appunti/quiz). Le crea il proprietario o un moderatore. |
| **Argomenti** | Dentro ogni materia ci sono le cartelle (es. *Modulo 1*), con anteprima: autori, formati presenti, ultimi file caricati. Ogni utente può creare argomenti. |
| **Appunti** | Ogni utente carica i propri appunti (fino a 20 file insieme, trascinandoli). Anteprime: prima pagina dei PDF e miniature delle immagini. Filtri per autore e formato. |
| **Visualizzatore** | PDF, HTML (isolato in sandbox), Word `.docx`, Excel/ODS, Markdown, testo/codice, CSV, immagini, audio e video direttamente nel browser; tutti gli altri formati si scaricano. |
| **Assistente AI** | Chat (pulsante "Chiedi all'AI") che conosce la materia e l'argomento aperti e può leggere l'appunto che stai guardando (PDF, immagini, Word, PowerPoint, HTML, testo). Usa Claude di Anthropic. |
| **Quiz** | Crea quiz a scelta multipla a mano oppure **generali con l'AI** a partire dagli appunti di un argomento o di un singolo file, rivedili e salvali. La correzione avviene sul server, con spiegazioni e classifica. |
| **👑 Area riservata** | Solo per il proprietario: statistiche, **chi è online in questo momento** e su quale pagina (aggiornato ogni 5 s), gestione di tutte le **sessioni** (chiudi singole o tutte), utenti (ruoli, sospensione, reset password, eliminazione), contenuti e impostazioni (nome del sito, avviso, apertura registrazioni). |

### Ruoli

- **Proprietario (VIP)** – tutti i permessi più l'area riservata. È l'account con l'email `OWNER_EMAIL`
  (predefinita: `bryansalguero26@icloud.com`); quell'email non può essere usata da nessun altro per registrarsi.
- **Moderatore** – assegnato dal proprietario: crea/modifica materie ed elimina qualsiasi contenuto.
- **Utente** – studia, carica appunti, crea argomenti e quiz, gestisce solo i propri contenuti.

## Avvio rapido

Serve **Node.js 22.13 o superiore**.

```bash
npm install
cp .env.example .env      # poi apri .env e completa i valori
npm start                 # http://localhost:3000
```

Nel file `.env` imposta almeno:

```ini
OWNER_PASSWORD=la-password-del-proprietario
ANTHROPIC_API_KEY=sk-ant-...      # facoltativa: senza, l'assistente AI resta disattivato
```

Al primo avvio viene creato l'account del proprietario con quell'email e password. Per cambiarla in
seguito puoi farlo dal **Profilo**, oppure dal server con:

```bash
npm run set-owner-password -- "NuovaPassword"
```

> 🔒 Il file `.env` è escluso da git: la password non viene mai salvata nel repository.
> Nel database è conservata solo come hash bcrypt.

### Assistente AI

L'assistente usa l'API di Anthropic (modello predefinito `claude-opus-5-5`, modificabile con `AI_MODEL`).
Crea una chiave su <https://console.anthropic.com/> e mettila in `ANTHROPIC_API_KEY`.
Ogni utente può fare al massimo `AI_DAILY_LIMIT` richieste nelle 24 ore (predefinito 100; il proprietario
non ha limiti). Se una richiesta viene bloccata dai filtri di sicurezza, l'API riprova automaticamente con
il modello di riserva consigliato (parametro `fallbacks: "default"`).

## Configurazione (`.env`)

| Variabile | Predefinito | Descrizione |
|---|---|---|
| `PORT` | `3000` | Porta HTTP |
| `OWNER_EMAIL` | `bryansalguero26@icloud.com` | Email dell'account proprietario |
| `OWNER_PASSWORD` | – | Password usata per creare l'account proprietario al primo avvio |
| `OWNER_NAME` | `Proprietario` | Nome visualizzato del proprietario |
| `ANTHROPIC_API_KEY` | – | Chiave per l'assistente AI |
| `AI_MODEL` | `claude-opus-5-5` | Modello Claude |
| `AI_DAILY_LIMIT` | `100` | Richieste AI per utente ogni 24 ore |
| `MAX_UPLOAD_MB` | `50` | Dimensione massima per file |
| `SESSION_DAYS` | `30` | Durata delle sessioni |
| `COOKIE_SECURE` | `false` | Metti `true` quando il sito è in HTTPS |
| `TRUST_PROXY` | `false` | Metti `true` dietro un reverse proxy (per vedere gli IP reali) |
| `DATA_DIR` / `UPLOAD_DIR` | `data/` / `uploads/` | Dove salvare database e file caricati |

## Messa online

Il sito è un'unica app Node.js con database SQLite integrato (nessun servizio esterno da installare).
Si può pubblicare su qualsiasi server/VPS o servizio che supporti Node e un disco persistente
(Render, Railway, Fly.io, un VPS con `pm2`…):

1. `npm install --omit=dev` e `npm start`.
2. Imposta le variabili d'ambiente (o il file `.env`), con `COOKIE_SECURE=true` e `TRUST_PROXY=true` se c'è HTTPS davanti.
3. Assicurati che le cartelle `data/` e `uploads/` stiano su un disco persistente e fai backup regolari.

## Sicurezza

- Password con bcrypt; token di sessione casuali salvati solo come hash SHA-256; sessioni revocabili.
- Limite ai tentativi di accesso (10 errori ogni 15 minuti per IP).
- Protezione CSRF (controllo dell'header `Origin` + cookie `SameSite=Lax`).
- I file HTML/SVG caricati dagli utenti vengono serviti con `Content-Security-Policy: sandbox`, quindi
  non possono leggere i cookie né usare le API del sito; i formati non visualizzabili vengono sempre scaricati.
- Le soluzioni dei quiz non vengono mai inviate al browser prima della consegna.

## Struttura del progetto

```
server.js              avvio di Express, presenza in tempo reale, file statici
src/config.js          configurazione da variabili d'ambiente
src/db.js              schema SQLite (node:sqlite)
src/auth.js            password, sessioni, ruoli, CSRF, account proprietario
src/presence.js        chi è online adesso (in memoria)
src/extract.js         lettura del contenuto degli appunti per l'AI (PDF, immagini, docx, pptx, html…)
src/routes/            API: auth, content (materie/argomenti/appunti), quizzes, ai, admin
public/                frontend (HTML, CSS, JavaScript senza framework)
test/                  test automatici (npm test)
```

## Test

```bash
npm test
```
