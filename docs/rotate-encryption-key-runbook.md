# Rotating `ENCRYPTION_KEY`

`ENCRYPTION_KEY` (AES-256-GCM) protects everything in `user_api_keys`, `connected_accounts`
(broker API keys/secrets), `notification_prefs` (Pushover/Twilio tokens), and the Robinhood MCP
OAuth token blob in `settings`. It has no built-in key versioning — `decryptValue()` only ever
tries the *current* key. Swapping the env var without re-encrypting first makes every stored
credential silently undecryptable (fail-closed, returns `""`), which on this app means broker
order placement breaks with no error, for every account with a stored key.

**Never just generate a new key and swap the env var.** Use `scripts/rotate-encryption-key.ts`.

## Why this is inert until you run it

This script does nothing on its own — it's not called from app boot, a cron, or CI. It only runs
when explicitly invoked with `OLD_ENCRYPTION_KEY`/`NEW_ENCRYPTION_KEY` set and `--dry-run` or
`--apply` passed. Safe to have merged to `main`.

## Procedure

1. **Back up the DB file first.** Non-negotiable — this rewrites every credential row in place.
   ```bash
   cp data/app.db data/app.db.pre-rotation-$(date +%Y%m%d).bak
   ```
   Or, if pulling a fresh copy from prod for a dry-run first, do that instead of touching the live
   file at all until you're confident in `--apply`.

   The script does **not** enforce this and cannot — it has no way to tell a real backup from a
   stale one.  A clean run is not evidence that a backup exists.

2. **Generate the new key:**
   ```bash
   openssl rand -hex 32
   ```

3. **Dry run** — decrypts every row under the OLD key, re-encrypts in memory, verifies the
   round-trip, writes NOTHING:
   ```bash
   DATABASE_URL=file:./data/app.db \
   OLD_ENCRYPTION_KEY=<current ENCRYPTION_KEY> \
   NEW_ENCRYPTION_KEY=<the key from step 2> \
   npx tsx scripts/rotate-encryption-key.ts --dry-run
   ```
   If this reports any failures, STOP — do not proceed to `--apply`. A failure means either the
   `OLD_ENCRYPTION_KEY` you supplied is wrong, or some rows are already under a different key than
   you think.

4. **Apply** — same env, single all-or-nothing SQLite transaction:
   ```bash
   ...same env as step 3... npx tsx scripts/rotate-encryption-key.ts --apply
   ```
   If ANY row fails mid-run, the whole transaction rolls back automatically — nothing partial is
   ever left committed.

5. **Only after a successful `--apply`**, update `ENCRYPTION_KEY` to the new value in
   Infisical (prod project) and Coolify, then redeploy.

6. **Verify post-deploy** with the now-current key:
   ```bash
   DATABASE_URL=file:./data/app.db npx tsx scripts/rotate-encryption-key.ts --verify
   ```
   Reads `ENCRYPTION_KEY` from the environment exactly like the app does. Exits non-zero and lists
   every row that fails to decrypt.

   **Read the row count, not just the exit code.** Every mode refuses to create a database that
   does not exist (a mistyped `DATABASE_URL` or the wrong working directory is a hard failure, not
   an empty run), but an existing-yet-wrong database would still report `0 OK, 0 FAILED` and exit
   0.  A run that finds zero encrypted values prints a warning for exactly that reason; treat it as
   "I am pointed at the wrong file" unless you genuinely expect no stored credentials.

7. Retire the old key value everywhere it might still be written down (secrets manager history,
   `.env` backups, `~/.secrets`).

## `--verify` as a standalone health check

Run `--verify` any time, unrelated to rotation, to confirm every stored ciphertext still decrypts
under the currently-configured `ENCRYPTION_KEY` — useful after a restore-from-backup drill, or as
a periodic sanity check.
