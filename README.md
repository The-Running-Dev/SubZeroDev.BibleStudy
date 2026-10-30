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

## Integration tests

`npm run test:integration` runs against the Postgres and Mailpit from `npm run dev:services`. Override them with `TEST_DATABASE_URL`, `TEST_SMTP_URL` and `TEST_MAILPIT_URL`.

## Container

```bash
docker build --build-arg BUILD_ID=$(git rev-parse --short HEAD) -t biblestudy .
docker run -p 3000:3000 -e DATABASE_URL=... -e APP_SECRET=... -e SMTP_URL=... biblestudy
```

`GET /__build-id` returns the running build. See `.env.example` for every variable.

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
