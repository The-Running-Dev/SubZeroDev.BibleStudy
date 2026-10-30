# Deploying to the VPS

The app runs on the owner's VPS as a Portainer Git stack defined by [compose.yaml](../compose.yaml). GitHub Actions publishes the image on every merge to `main`, and the stack pulls it.

```
merge to main ─▶ deploy.yml builds the image ─▶ ghcr.io/the-running-dev/subzerodev.biblestudy:<sha> and :latest
                                             └▶ (DEPLOY_ENABLED) POST the Portainer webhook ─▶ stack pulls :latest, migrates, restarts
```

## The stack

| Service | What it does |
|---|---|
| `db` | PostgreSQL 17 on the named volume `db`. Reachable only from the stack's own network. |
| `migrate` | Runs the migrations once, then exits. If one fails, `docker compose up` stops here and the running app is not replaced. |
| `app` | The web server. Joins the reverse proxy's network as `biblestudy-app:3000`. Keeps recordings on the named volume `media`. Publishes no port. |
| `backup` | Writes a backup every day at `BACKUP_AT` (UTC) and keeps the newest `BACKUP_KEEP`. |

The app also migrates on start and exits non-zero if that fails, before it listens, so nothing ever serves a half-migrated schema. The image's health check is `GET /__build-id`.

## One-time setup (owner)

These are account and server settings, so they are the owner's to make. Nothing in the repository makes them.

1. **The image is pullable.** The first run of `deploy.yml` creates the GHCR package `subzerodev.biblestudy`. Either make the package public (GitHub → the package → Package settings → Change visibility), or add GHCR as a registry in Portainer with a personal access token that has `read:packages`.
2. **The proxy network exists** on the VPS. The stack expects `proxy-net`; set `PROXY_NETWORK` if yours is named differently. It is declared external, so the stack fails to start rather than create a network the proxy cannot reach.
3. **The hostname resolves and is routed.** Add the DNS record (proposed: `biblestudy.subzerodev.com`) and a proxy route from it to `http://biblestudy-app:3000`, with TLS terminated at the proxy. The route must pass WebSocket upgrades (`/ws`, `/connector`).
4. **Create the stack in Portainer:** Stacks → Add stack → Repository. Repository URL `https://github.com/The-Running-Dev/SubZeroDev.BibleStudy`, reference `refs/heads/main`, compose path `compose.yaml`. Set the environment variables below. Turn on the stack webhook and copy its URL.
5. **Turn on automatic deploys:** in the repository's Settings → Secrets and variables → Actions, add the secret `PORTAINER_REDEPLOY_WEBHOOK_URL` with the webhook URL, and the variable `DEPLOY_ENABLED` = `true`. Until both exist, a merge only publishes the image.
6. **Import the text** once the stack is up:

   ```bash
   docker exec subzerodev-biblestudy-app-1 node src/server/content/import-cli.ts --translation BSB
   ```

## Environment variables

Set these in the Portainer stack (or a git-ignored `.env` next to `compose.yaml` when running by hand). [.env.example](../.env.example) lists them with placeholder values.

| Variable | Required | Notes |
|---|---|---|
| `DB_PASSWORD` | yes | PostgreSQL password. The stack builds `DATABASE_URL` from it. |
| `APP_SECRET` | yes | At least 32 random characters. Changing it signs everyone out. |
| `SMTP_URL` | yes | The mail relay, for example `smtp://user:pass@smtp.example.org:587`. |
| `PUBLIC_URL` | yes | `https://<hostname>`, used in emailed links. |
| `MAIL_FROM` | no | Sender address for sign-in codes and invitations. |
| `OWNER_EMAIL` | no | The account that may create groups. |
| `ASSISTANT_OWNER_EMAIL`, `CONNECTOR_TOKEN` | no | The study assistant (S6). Without them it shows offline. |
| `BIBLESTUDY_IMAGE` | no | Pin a build, `ghcr.io/the-running-dev/subzerodev.biblestudy:<sha>`, for a rollback. |
| `PROXY_NETWORK` | no | Default `proxy-net`. |
| `BACKUP_AT`, `BACKUP_KEEP` | no | Default `03:30` (UTC) and `14` runs. |
| `BACKUP_DIR` | no | A host path for the backups instead of the `backups` volume, so the host's own off-site sync can pick them up. It must be writable by uid 1000. |

## Checking a deploy

`GET https://<hostname>/__build-id` returns `{"buildId":"<commit sha>"}` for the commit the image was built from. Compare it with the merge commit.

## Rolling back

Set `BIBLESTUDY_IMAGE` to the last good `:<sha>` tag in the stack's environment and update the stack. Migrations are forward-only: an older build runs against the newer schema, which works while migrations only add tables and columns. If a migration changed something an older build depends on, restore the backup taken before the deploy instead.

## Backups

Each run writes a folder named for its UTC time, plus a shared store for recordings:

```
<backups>/2026-10-31T033000Z/db.dump        pg_dump, custom format
<backups>/2026-10-31T033000Z/manifest.json  dump checksum, row counts, and every media file's name, size and SHA-256
<backups>/media/<sha256>.mp3                each recording once, shared by every run that lists it
```

A run that fails (the database is unreachable, a recording's bytes no longer match its name) leaves nothing behind and is retried at the next slot; the service logs `backup failed`. The backups live on the VPS: copy the folder off the server with whatever the host already uses for off-site copies.

```bash
# A backup now
docker compose run --rm backup node src/server/platform/backup-cli.ts backup
# What is on disk
docker compose run --rm backup node src/server/platform/backup-cli.ts list
```

### Restoring

A restore goes into an empty stack. It checks the dump's and every recording's checksum against the manifest before it touches the database, and refuses a database that already has users unless given `--force`.

```bash
docker compose stop app migrate backup
docker compose up -d --wait db
docker compose run --rm --no-deps backup node src/server/platform/backup-cli.ts restore latest   # or a folder name
docker compose up -d
```

It prints the manifest's row counts next to the restored database's. To replace a database that has data, add `--force`; `pg_restore` then drops and recreates every object in one transaction.

## The drill

`npm run drill` checks the stack end to end against Docker on the machine it runs on, with synthetic data only. CI runs it on every pull request.

1. Builds the image and starts `compose.yaml` with `.env.example`'s values, its secrets replaced by random ones.
2. `/__build-id` returns the build the image was given.
3. Seeds two users, a group with both as members, two chapters and a recording, then checks that rows, chapter checksums and the media file are unchanged after `down` and `up`.
4. Runs a backup, starts a second stack with empty volumes, restores into it, and checks rows, chapter checksums (stored and recomputed) and media match the first stack.
5. Checks that a restore over a stack with users is refused.
6. Mounts a migrations folder with a broken migration over the image's and checks the app exits non-zero, logs `migration failed`, never logs `listening`, and leaves nothing of the broken migration applied.

`--keep` leaves the stacks and temporary files for inspection; `--image <tag>` drills an existing image instead of building one.

### Drill record

| Date (UTC) | Where | Image | Result |
|---|---|---|---|
| 2026-10-30 23:41 | Owner's PC, Docker 29.9.2, Compose 5.6.1 | built from `b3afebf` + S7 working tree | 6/6 passed. Dump 51,543 bytes, 1 media file; restored counts users 2, groups 1, memberships 2, chapters 2, recordings 1. |

The VPS itself (S7.5) is not drilled: it needs the DNS record, proxy route and webhook secret above.
