# Walletool

A Solana vanity-address generator with a searchable web UI and a CLI worker. Generate keypairs that start or end with human-readable words (e.g. `SOL...`, `...ANA`), then browse, export, and archive them in a local SQLite database.

---

## What it does

- **Generate** Solana vanity addresses in parallel workers.
- **Search** stored wallets by start/end match, length, type, and export/archive status.
- **Export** selected wallets with optional archive notes.
- **CLI mode** for headless generation with thermal protection on Apple Silicon Macs.

---

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Create your personal search-term list (gitignored by default)
node scripts/init-baseTerms.js

# 3. Start the Next.js dev server
npm run dev

# 4. Open http://localhost:3000
```

The dev server starts the generation API automatically when you click **Start** in the UI.

### CLI mode (headless)

```bash
npm run cli -- help
npm run cli -- vanity-generator.js
```

CLI mode is useful for long-running sessions on a dedicated machine.

---

## Customizing search terms (`baseTerms.js`)

Wallets are matched against the terms you define in `baseTerms.js`.

- **Starter script:** run `node scripts/init-baseTerms.js` to create the file with a safe, generic set of terms.
- **Example list:** see `baseTerms.example.js` for the starter template.
- **Rules:**
  - Terms must be **Base58-safe** (no `0`, `O`, `I`, or `l`).
  - Use **at least 3 characters** for reliable matching.
  - The generator automatically creates **leetspeak variants** (`e` → `3`, `a` → `4`, etc.).
  - Duplicate and invalid terms are filtered automatically.
- `baseTerms.js` is **gitignored** by default so your personal term lists are never pushed.

Edit `baseTerms.js`, then restart the dev server or CLI to pick up changes.

---

## macOS / Apple Silicon features

The CLI includes **thermal protection** optimized for macOS (especially fanless MacBook Air models).

- Detects thermal pressure via `powermetrics`.
- Automatically pauses generation when the machine runs hot and resumes once it cools.
- On non-macOS systems the thermal layer falls back gracefully to "Unknown" and generation continues normally.

> **Note:** thermal monitoring is designed for Apple Silicon Macs. Linux and Windows users can still run the generator; the heat-throttle logic simply does not activate.

### Avoiding `sudo` password prompts for `powermetrics`

`powermetrics` often requires `sudo`. To let the CLI check temperature without typing a password each time, add a `sudoers` rule:

```bash
# Replace $USER with your actual macOS username if needed
sudo visudo -f /etc/sudoers.d/powermetrics
```

Paste this line into the editor (replace `your_username` with your actual username):

```
your_username ALL=(ALL) NOPASSWD: /usr/bin/powermetrics
```

Save and exit. The CLI will now read thermal pressure silently.

If you prefer not to edit `sudoers`, run the CLI once with `sudo` so the password is cached for a few minutes, or grant your terminal **Full Disk Access** in **System Settings → Privacy & Security**.

---

## Security & data safety

- **Never commit wallet data.** The repository is configured to ignore:
  - `novelty_wallets/` — all generated wallets, JSONL exports, and the SQLite database
  - `.env` and local env files
  - `*.db`, `*.sqlite`, `*.sqlite3`
  - `*.pem`, `*.key`
  - `.DS_Store`
- Private keys are stored **only** in your local `novelty_wallets/wallets.db`.
- The web UI serves private keys only when explicitly requested via the **Export** flow.
- If you push this repo anywhere, verify with `git ls-files` that no secrets are tracked.

---

## Project structure

```
app/                      Next.js app (pages & API routes)
  api/generation/         Start / stop generation workers
  api/sse/                Real-time terminal log stream
  api/stats/              Dashboard statistics
  api/wallets/            List, filter, and paginate wallets
  api/wallets/export/     Export selected wallets
  api/wallets/archive/    Archive selected wallets
  page.js                 Main UI
lib/
  sqlite_storage.js       SQLite DAO (WAL mode, indexed)
  leet_cache.js           Leetspeak variant generator
shared/
  walletoolUtils.js       Shared search & display logic
walletool.cjs             CLI entry point (workers + thermal monitor)
scripts/
  init-baseTerms.js       Generates a starter baseTerms.js
baseTerms.example.js      Starter term list example
```

---

## Search behavior

- **Exact term search** matches the start or end of public keys against the stored `search_terms` index.
- **Leetspeak variants** are included automatically (e.g. searching `leet` also finds `1337`).
- **Pair search:** type two terms separated by a space or comma (e.g. `sol ana`) to find wallets that match both start and end.
- **Partial / prefix search** (e.g. `teth` → `tether`) is not supported by the current SQLite schema. If you need this, create an FTS table or post-process results in-memory.

---

## Requirements

- Node.js 18+
- macOS recommended for thermal protection (optional)
- `sqlite3` native module will compile on first install
- Database (`novelty_wallets/wallets.db`) auto-creates on first run — no manual migration needed

---

## License

MIT — see [LICENSE](LICENSE).
