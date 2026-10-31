# SubZeroDev.BibleStudy

A private Bible-study app for a small group: shared narrated reading, questions during the week, and solo study. Phones install it as a PWA.

## Prerequisites

- Node.js 24 or later (runs the TypeScript server directly)
- Docker, for the local Postgres and Mailpit services and the production image

## Local Setup

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd SubZeroDev.BibleStudy
   ```

2. **Configure environment**
   ```bash
   cp .env.example .env
   # Set APP_SECRET; the defaults point at the local services below
   ```

3. **Start Postgres and Mailpit**
   ```bash
   npm run dev:services
   ```
   Mailpit shows every email the app sends at http://localhost:8025.

4. **Run the server and client**
   ```bash
   node --env-file=.env src/server/web/main.ts
   npm run dev:client
   ```
   The server applies migrations on start. Open http://localhost:5173 and sign in with any address; the code arrives in Mailpit.

5. **Import the Bible text**
   ```bash
   node --env-file=.env src/server/content/import-cli.ts --translation BSB
   ```
   This copies the Berean Standard Bible (public domain) from the AO Lab Free Use Bible API into Postgres: 66 books, 1,189 chapters, about a minute. `--books ROM,1CO` limits it. Re-running it changes only chapters whose text changed, and every run is recorded in `import_manifests`. The exit code is 2 when any chapter failed; the JSON summary names them. The reader opens at Romans 1. CSB shows as not available until it has a licensed source.

6. **Import narration (optional)**
   ```bash
   node --env-file=.env src/server/content/import-cli.ts --translation BSB --audio ROM:1-16
   ```
   This stores AO Lab's public-domain (CC0) recordings by Bob Souer and Barry Hays in `MEDIA_DIR` (default `data/media`), one file per chapter and narrator, named by its SHA-256, with the per-verse timing that drives the highlight. `--audio ROM:1-16,1CO` takes several books, and `--narrators souer` limits the narrators. `--audio` alone needs the text already imported; with `--books` the text is imported first. A chapter nobody imported is fetched in the background the first time a member opens its player, so this step only warms the cache. A recording whose timing is missing or fails validation still plays, without verse following.

7. **Set up the group**

   Set `OWNER_EMAIL` in `.env` to the owner's address before the owner first signs in. That first sign-in creates the one group, "Bible Study", meeting Mondays at 06:15 `America/Chicago` and starting at Romans 1, owned by that user. Anyone else who signs in without an invitation has an account but no group. In the app, tap the group name, then **Create invitation link**, and send the link yourself; the app never emails invitations. Each link lets one person join and works for 14 days. The owner can revoke an open link and remove a member; a removed member's open connection is closed at once, and they need a new link to come back.

8. **Study together**

   A member of the group sees **Study** next to the group name. **Start study** opens the group's one live session at its current passage (Romans 1 to begin with); anyone who arrives later gets **Join study**, and two people starting at once land in the same session. Everyone in the session hears the same narration at the same point: any member can play, pause, skip ±10 s, scrub, change the passage, narrator or speed, or end the study, and the status line names who paused. Each phone corrects its own drift against the server clock. A phone that drops its connection reconnects by itself and picks up the current state; anything tapped while it was offline is not sent. With CSB as the shared translation there is no narration, so the study runs as reading together: a tap on a verse marks it for everyone. The session keeps going when its starter leaves; once nobody is connected for 20 s it pauses, and a server restart leaves it paused where it was.

9. **Study assistant (optional)**

   The owner can ask Skynet about the passage on screen. The model runs on the owner's PC under the AgentConsole runtime; a small connector there dials out to the server, so the PC needs no open port and the server never holds model credentials. Set `ASSISTANT_OWNER_EMAIL` (only that member sees the panel) and `CONNECTOR_TOKEN` (32+ random characters) on the server. On the PC, with the Claude CLI signed in, set the same `CONNECTOR_TOKEN`, `CONNECTOR_SERVER_URL` and `AGENTCONSOLE_RUNTIME` (the runtime's `main.js`), then:
   ```bash
   npm run connector
   ```
   The connector starts the runtime, keeps its state in `CONNECTOR_STATE_DIR` (default `data/connector`), and gives each conversation its own empty working directory there. Claude runs with every tool, MCP server and user setting removed, and a turn that still asks for a tool is denied, stopped and shown as such. With the PC off or the connector stopped, the panel says the assistant is offline; reading and narration are unaffected. A connector restarted mid-answer resumes the runtime's event log, so the answer is neither lost nor shown twice.

## Integration and browser tests

`npm run test:integration` runs against the Postgres and Mailpit from `npm run dev:services` and empties their tables, so re-import afterwards. Override them with `TEST_DATABASE_URL`, `TEST_SMTP_URL` and `TEST_MAILPIT_URL`. The content tests import Romans from the live AO Lab API (`AOLAB_BASE_URL` overrides it), so they need network access; import failures and retries are tested against a local fixture server.

The assistant tests drive the real connector code against a fake AgentConsole runtime. To run S6.1 and S6.5 against the real runtime and model (a few model turns), point `AGENTCONSOLE_RUNTIME` at it with the Claude CLI signed in:
```bash
AGENTCONSOLE_RUNTIME=C:/path/to/agent-console/runtime/main.js node --test tests/integration/assistant-runtime.test.ts
```
Without it, that file is skipped.

`npm run test:e2e` drives the built client in headless Chromium at phone size. Run `npm run build` and, once, `npx playwright install chromium` first. Set `E2E_SCREENSHOTS` to a directory to keep screenshots. The study tests play Romans 1 on three clients for two minutes and print the drift report.

## Container

```bash
docker build --build-arg BUILD_ID=$(git rev-parse --short HEAD) -t biblestudy .
docker run -p 3000:3000 -e DATABASE_URL=... -e APP_SECRET=... -e SMTP_URL=... -e OWNER_EMAIL=... biblestudy
```

`GET /__build-id` returns the running build. See `.env.example` for every variable. Import the text inside the running container with `docker exec <container> node src/server/content/import-cli.ts --translation BSB`. Mount a volume at `/app/data/media` (the image's `MEDIA_DIR`) so recordings survive a new container.

On the VPS the app runs as the [compose.yaml](compose.yaml) stack with PostgreSQL, a one-shot migration and a nightly backup. [docs/deploy.md](docs/deploy.md) covers the one-time setup, environment, rollback, backup and restore. `npm run drill` checks that stack end to end in Docker.

<!-- BEGIN project-commands -->
## Install

```bash
npm install
```

## Build

```bash
npm run build
```

## Test

```bash
npm test
```

## Lint

```bash
npm run lint
```

## Run Locally

```bash
npm start
```
<!-- END project-commands -->

## Architecture

This project consists of:
- **src/** — Main source code
- **tests/** — Test suite
- **docs/** — Architecture and decision records

See [docs/architecture.md](docs/architecture.md) for detailed system design.

## Development Workflow

1. Create a feature branch
2. Make focused, atomic commits
3. Write or update tests for new functionality
4. Ensure all tests pass locally
5. Submit a pull request

See [AGENTS.md](AGENTS.md) and [CLAUDE.md](CLAUDE.md) for AI assistant guidelines.

## License

[Add license information]
