# Contributing to OpenBrowser Workbench

Thank you for your interest in contributing to OpenBrowser Workbench, maintained by Jia and based on OpenBrowser! This project is open source under the [MIT License](./LICENSE). Preserve the upstream and subsequent contribution notices.

## Ways to contribute

- Report bugs and request features via [GitHub Issues](https://github.com/s-jia233/OpenBrowser-Workbench/issues)
- Improve documentation (README, comments, examples)
- Fix bugs or add features via pull requests
- Add or improve support for browser AI providers in `browser-extension/src/providers.js`
- Write or extend unit tests with Vitest

## Before you start

1. Check existing [issues](https://github.com/s-jia233/OpenBrowser-Workbench/issues) and [pull requests](https://github.com/s-jia233/OpenBrowser-Workbench/pulls) to avoid duplicate work.
2. For large changes, open an issue first to discuss the approach.
3. Read the [workbench guide](./docs/WORKBENCH.zh-CN.md) for current behavior. The [upstream product specification](./pid.md) is retained as historical design context, not the current feature specification.

## Development setup

```bash
git clone https://github.com/s-jia233/OpenBrowser-Workbench.git
cd OpenBrowser-Workbench
pnpm install
cp .env.example .env   # Windows: copy .env.example .env
pnpm build
```

Load the `browser-extension` folder in Chrome (`chrome://extensions` → Load unpacked).

### Useful commands

```bash
pnpm dev           # CLI in watch mode
pnpm dev:server    # Bridge server in watch mode
pnpm build         # Compile TypeScript
pnpm typecheck     # Type-check without emitting
pnpm test          # Run unit tests
```

## Pull request workflow

1. **Fork** the repository on GitHub.
2. **Clone** your fork and create a branch from `main`:
   ```bash
   git switch -c codex/my-bug-fix
   ```
3. **Make your changes** with clear, focused commits.
4. **Run checks** before opening a PR:
   ```bash
   pnpm typecheck
   pnpm test
   pnpm build
   ```
5. **Push** to your fork and open a **Pull Request** against `main`.
6. Fill in the PR description: what changed, why, and how to test it.

## Code guidelines

- Match existing style in the file you edit (TypeScript for CLI/server, plain JS for the extension).
- Keep changes scoped — one logical change per PR when possible.
- Prefer extending existing helpers over duplicating logic.
- Add tests for non-trivial CLI/server logic when practical.
- Do not commit secrets (`.env`, tokens, API keys), `.openbrowser` sessions, private source snapshots, browser drafts or dependencies.
- Preserve explicit Diff approval, bounded retries and honest verification results. Temporary project copies are not container isolation.
- Follow each AI provider's service rules; do not add quota, authentication or CAPTCHA bypasses.

## Extension changes

After editing `browser-extension/`, reload the extension on `chrome://extensions` and refresh any open AI chat tabs before testing.

Provider-specific DOM selectors live in `browser-extension/src/providers.js`. When adding a provider, include `input`, `send`, `assistant`, and file-upload selectors tested on the live site.

## Reporting bugs

Include:

- OS and shell (e.g. Windows 11, PowerShell)
- Node.js version (`node -v`)
- Browser and AI site (e.g. Chrome, chatgpt.com)
- Steps to reproduce
- Expected vs actual behavior
- Relevant terminal or extension console output

## Code of conduct

This project follows the [Code of Conduct](./CODE_OF_CONDUCT.md). By participating, you agree to uphold it.

## Questions

Open an [issue in this repository](https://github.com/s-jia233/OpenBrowser-Workbench/issues) if you are unsure where to start. Do not include credentials or unredacted private logs.
