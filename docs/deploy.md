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
| `migrate` | Runs the migrations once, each in one transaction, then exits. |
| `biblestudy` | The web server. Joins the reverse proxy's network as `biblestudy-app:3000`. Keeps recordings on the named volume `media`. Publishes no port. |
| `backup` | Writes a backup at start when the newest is more than a day old, then every day at `BACKUP_AT` (UTC), and keeps the newest `BACKUP_KEEP`. Its health check is unhealthy once the newest run is older than `BACKUP_HEALTH_HOURS` (default 26). |

The app also migrates on start and exits non-zero if that fails, before it listens, so nothing ever serves a half-migrated schema. The image's health check is `GET /__health`, which answers 503 while the database cannot. Portainer then shows the app unhealthy; the restart policy acts on an exit only, so the app is not restarted, and it serves again once the database is back.

**A failed migration takes the site down.** Compose stops the running app before it waits on `migrate`, so when a new image's migration fails, `up` fails with nothing of that migration applied and no app running. Redeploy the previous image ([Rolling back](#rolling-back)); the drill checks both halves.

## One-time setup (owner)

These are account and server settings, so they are the owner's to make. Nothing in the repository makes them.

1. **The image is pullable.** The first run of `deploy.yml` creates the GHCR package `subzerodev.biblestudy`. Either make the package public (GitHub → the package → Package settings → Change visibility), or add GHCR as a registry in Portainer with a personal access token that has `read:packages`.
2. **The proxy network exists** on the VPS. The stack expects `proxy-net`; set `PROXY_NETWORK` if yours is named differently. It is declared external, so the stack fails to start rather than create a network the proxy cannot reach.
3. **The hostname resolves and is routed.** Add the DNS record (proposed: `biblestudy.subzerodev.com`) and a proxy route from it to `http://biblestudy-app:3000`, with TLS terminated at the proxy. The route must pass WebSocket upgrades (`/ws`, `/connector`).
4. **Create the stack in Portainer:** Stacks → Add stack → Repository. Repository URL `https://github.com/The-Running-Dev/SubZeroDev.BibleStudy`, reference `refs/heads/main`, compose path `compose.yaml`. Set the environment variables below. Turn on the stack webhook and copy its URL.
5. **Turn on automatic deploys:** in the repository's Settings → Secrets and variables → Actions, add the secret `PORTAINER_REDEPLOY_WEBHOOK_URL` with the webhook URL, and the variable `DEPLOY_ENABLED` = `true`. Until both exist, a merge only publishes the image. Add the variable `PUBLIC_URL` = `https://<hostname>` too, and the deploy waits up to five minutes for the site to serve the merged commit, failing if it does not.
6. **Import the text** once the stack is up, from the VPS shell:

   ```bash
   docker exec "$(docker ps -q --filter label=com.docker.compose.project=subzerodev-biblestudy --filter label=com.docker.compose.service=biblestudy)" node src/server/content/import-cli.ts --translation BSB
   ```
7. **Import CSB** from the owner's files, if you hold them. They are licensed text, so they are never in git or the image. Copy the folder of `NN-Book.xml` files to the VPS (for example `scp -r bibles/CSB vps:/tmp/CSB`), then copy it into the app, import it, and delete both copies:

   ```bash
   app="$(docker ps -q --filter label=com.docker.compose.project=subzerodev-biblestudy --filter label=com.docker.compose.service=biblestudy)"
   docker cp /tmp/CSB "$app":/tmp/CSB
   docker exec "$app" node src/server/content/import-cli.ts --translation CSB --from /tmp/CSB
   docker exec -u 0 "$app" rm -rf /tmp/CSB && rm -rf /tmp/CSB
   ```

   The text lives in Postgres from then on, so it survives redeploys and is in the backups. An imported CSB chapter never expires and is never replaced by an API.Bible fetch; re-running the import changes only chapters whose text changed. CSB is copyrighted: serving it on a public site, even behind sign-in, needs the owner's licence (D-2026-11-01 in [the decision log](../design/90-decisions.md)).

## Environment variables

Set these in the Portainer stack (or a git-ignored `.env` next to `compose.yaml` when running by hand). [stack.env.example](../stack.env.example) lists them with placeholder values; [.env.example](../.env.example) is for local development only. The server refuses to start with the examples' `APP_SECRET` or `CONNECTOR_TOKEN`.

| Variable | Required | Notes |
|---|---|---|
| `DB_PASSWORD` | yes | PostgreSQL password, letters, digits, `_` and `-` only (it is placed in a URL): `openssl rand -hex 24`. The stack builds `DATABASE_URL` from it. PostgreSQL takes it only when the `db` volume is first created; changing it later needs `ALTER USER` as well. |
| `APP_SECRET` | yes | At least 32 random characters: `openssl rand -base64 48`. Changing it signs everyone out. |
| `SMTP_URL` | yes | The mail relay, for example `smtps://user:password@smtp.example.org:465`. |
| `PUBLIC_URL` | yes | `https://<hostname>`, used in emailed links. |
| `MAIL_FROM` | no | Sender address for sign-in codes and invitations. |
| `OWNER_EMAIL` | no | The account that may create groups. |
| `ASSISTANT_OWNER_EMAIL`, `CONNECTOR_TOKEN` | no | The study assistant (S6). Without them it shows offline. |
| `BIBLESTUDY_IMAGE` | no | Pin a build, `ghcr.io/the-running-dev/subzerodev.biblestudy:<sha>`, for a rollback. |
| `PROXY_NETWORK` | no | Default `proxy-net`. |
| `BACKUP_AT`, `BACKUP_KEEP` | no | Default `03:30` (UTC) and `14` runs. |
| `BACKUP_HEALTH_HOURS` | no | Default `26`: how old the newest run may be before the backup service reports unhealthy. |
| `BACKUP_DIR` | no | A host path for the backups instead of the `backups` volume, so the host's own off-site sync can pick them up. It must be writable by uid 1000. |

## Checking a deploy

Every merge to main builds the image, runs [the drill](#the-drill) on that exact image, and only then publishes it as `:<sha>` and `:latest`, so an image that fails the drill never reaches the VPS. With `PUBLIC_URL` set, the deploy job then runs `scripts/verify-deploy.ts`, which does the check below until it passes.

`GET https://<hostname>/__build-id` returns `{"buildId":"<commit sha>"}` for the commit the image was built from. Compare it with the merge commit. In Portainer every long-running service (`db`, `biblestudy`, `backup`) shows healthy; `migrate` shows exited (0).

## Rolling back

Set `BIBLESTUDY_IMAGE` to the last good `:<sha>` tag in the stack's environment and update the stack. This is also the recovery from a deploy whose migration failed: nothing of that migration was applied, so the previous image starts against the schema it knows.

Migrations are forward-only: after a deploy whose migrations succeeded, an older build runs against the newer schema, which works while migrations only add tables and columns. If a migration changed something an older build depends on, restore the backup taken before the deploy instead.

## Backups

Each run writes a folder named for its UTC time, plus a shared store for recordings:

```
<backups>/2026-10-31T033000Z/db.dump        pg_dump, custom format
<backups>/2026-10-31T033000Z/manifest.json  dump checksum, row counts, and every media file's name, size and SHA-256
<backups>/media/<sha256>.mp3                each recording once, shared by every run that lists it
```

A run that fails (the database is unreachable, a recording's bytes no longer match its name) leaves nothing behind and is retried at the next slot; the service logs `backup failed` and turns unhealthy once the newest good run is too old. Only one run happens at a time, scheduled or by hand. The backups live on the VPS and are readable only by the backup service's user: copy the folder off the server with whatever the host already uses for off-site copies.

The commands below run inside the running `backup` container, from the VPS shell:

```bash
BACKUP=$(docker ps -q --filter label=com.docker.compose.project=subzerodev-biblestudy --filter label=com.docker.compose.service=backup)
# A backup now
docker exec "$BACKUP" node src/server/platform/backup-cli.ts backup
# What is on disk
docker exec "$BACKUP" node src/server/platform/backup-cli.ts list
```

### Restoring

A restore checks the dump's and every recording's checksum against the manifest before it touches the database. It refuses a database that already has users unless given `--force`. It replaces the whole `public` schema, so tables a later migration added are dropped with it, and the app migrates the restored database forward when it starts.

Stop the app first, so nothing writes while the database is replaced, then restore from the `backup` container and start everything again:

```bash
BACKUP=$(docker ps -q --filter label=com.docker.compose.project=subzerodev-biblestudy --filter label=com.docker.compose.service=backup)
APP=$(docker ps -q --filter label=com.docker.compose.project=subzerodev-biblestudy --filter label=com.docker.compose.service=biblestudy)
docker stop "$APP"
docker exec "$BACKUP" node src/server/platform/backup-cli.ts restore latest   # or a folder name; add --force over existing data
docker start "$APP"
```

It prints the manifest's row counts next to the restored database's. Into a brand-new stack (a new server), deploy it, let it come up healthy, then run the same commands.

## The drill

`npm run drill` checks the stack end to end against Docker on the machine it runs on, with synthetic data only. CI runs it on every pull request.

1. Builds the image and starts `compose.yaml` with `stack.env.example`'s values, its secrets replaced by random ones.
2. `/__build-id` returns the build the image was given, and every long-running service is healthy, which includes the backup taken at start.
3. Seeds two users, a group with both as members, two chapters and a recording, then checks that rows, chapter checksums and the media file are unchanged after `down` and `up`.
4. Runs a backup inside the `backup` service, starts a second stack with empty volumes, restores into it, and checks rows, chapter checksums (stored and recomputed) and media match the first stack.
5. Checks that a restore over a stack with users is refused, and that a forced restore over a database with a table and foreign key the backup does not have replaces it.
6. Mounts a migrations folder with a broken migration over the image's and checks the app exits non-zero, logs `migration failed`, never logs `listening`, and leaves nothing of the broken migration applied.
7. Builds an image with that broken migration and deploys it with `up`: checks the deploy fails with nothing applied, then that `up` with the previous image serves the expected build with the data intact.

`--keep` leaves the stacks and temporary files for inspection; `--image <tag>` drills an existing image instead of building one.

### Drill record

| Date (UTC) | Where | Image | Result |
|---|---|---|---|
| 2026-10-30 23:41 | Owner's PC, Docker 29.9.2, Compose 5.6.1 | built from `b3afebf` + S7 working tree | 6/6 passed. Dump 51,543 bytes, 1 media file; restored counts users 2, groups 1, memberships 2, chapters 2, recordings 1. |
| 2026-10-31 00:05 | Owner's PC, Docker 29.9.2, Compose 5.6.1 | built from `b3afebf` + S7 review fixes | 9/9 passed. Dump 51,548 bytes, 1 media file; restored counts match; the failed deploy exited 1 with nothing applied and the rollback served the build. |

The VPS itself (S7.5) is not drilled: it needs the DNS record, proxy route and webhook secret above.
