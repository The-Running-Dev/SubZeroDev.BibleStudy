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

## Integration and browser tests

`npm run test:integration` runs against the Postgres and Mailpit from `npm run dev:services` and empties their tables, so re-import afterwards. Override them with `TEST_DATABASE_URL`, `TEST_SMTP_URL` and `TEST_MAILPIT_URL`. The content tests import Romans from the live AO Lab API (`AOLAB_BASE_URL` overrides it), so they need network access; import failures and retries are tested against a local fixture server.

`npm run test:e2e` drives the built client in headless Chromium at phone size. Run `npm run build` and, once, `npx playwright install chromium` first. Set `E2E_SCREENSHOTS` to a directory to keep screenshots.

## Container

```bash
docker build --build-arg BUILD_ID=$(git rev-parse --short HEAD) -t biblestudy .
docker run -p 3000:3000 -e DATABASE_URL=... -e APP_SECRET=... -e SMTP_URL=... biblestudy
```

`GET /__build-id` returns the running build. See `.env.example` for every variable. Import the text inside the running container with `docker exec <container> node src/server/content/import-cli.ts --translation BSB`. Mount a volume at `/app/data/media` (the image's `MEDIA_DIR`) so recordings survive a new container.

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
