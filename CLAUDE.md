# Claude Code Project Instructions

- **Project:** SubZeroDev.BibleStudy
- **Last Updated:** 2026-10-30

<!-- BEGIN project-commands -->
## Commands

The implementation language has not been selected yet, so this project has no install, build, test, lint or run commands. Do not guess or invent them; they are added here when the language is chosen.
<!-- END project-commands -->

## Architecture Principles

- Keep domain logic independent from infrastructure
- Put external integrations behind well-defined interfaces
- Avoid circular dependencies between modules
- Record consequential architecture decisions in [docs/decisions/](docs/decisions/)

## Project Structure

```
SubZeroDev.BibleStudy/
├── src/           # Source code
├── tests/         # Test suite
├── docs/          # Documentation
│   ├── architecture.md
│   └── decisions/  # Architecture Decision Records
└── README.md      # Project overview
```

## Workflow Guidelines

1. **Before making changes:**
   - Read relevant tests to understand expected behavior
   - Check [docs/architecture.md](docs/architecture.md) for component relationships

2. **During implementation:**
   - Make the smallest coherent change
   - Keep commits focused and descriptive
   - Run affected checks before committing

3. **Before committing:**
   - Ensure tests pass
   - Verify no secrets or credentials in diff
   - Update documentation if behavior changed

## Memory & Knowledge Management

- Store important conventions and lessons learned
- Memory supplements but doesn't replace documentation
- Keep architecture rationale in docs/decisions/ (not just memory)
