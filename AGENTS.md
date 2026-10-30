# Project Working Agreement

- **Project:** SubZeroDev.BibleStudy
- **Last Updated:** 2026-10-30

<!-- BEGIN project-commands -->
## Essential Commands

The implementation language has not been selected yet, so this project has no install, build, test, lint or run commands. Do not guess or invent them; they are added here when the language is chosen.
<!-- END project-commands -->

## Architecture & Design

- Keep domain logic independent from infrastructure
- Put external integrations behind well-defined interfaces
- Avoid circular dependencies between modules
- Record all consequential architecture decisions in [docs/decisions/](docs/decisions/)

### Project Structure

```
SubZeroDev.BibleStudy/
├── src/           # Source code
├── tests/         # Test suite
├── docs/          # Documentation
│   ├── architecture.md
│   └── decisions/  # Architecture Decision Records (ADRs)
└── README.md
```

## Development Workflow

1. **Before making changes:**
   - Read relevant tests to understand expected behavior
   - Review [docs/architecture.md](docs/architecture.md) for design context

2. **During implementation:**
   - Make the smallest coherent change possible
   - Keep commits focused and well-described
   - Run the checks affected by your change

3. **Commit safety:**
   - Never commit secrets, generated credentials, or local .env files
   - Ensure all tests pass locally
   - Verify no unwanted files in the diff
