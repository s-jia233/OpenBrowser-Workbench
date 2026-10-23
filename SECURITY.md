# OpenBrowser Workbench Security Policy

## Development preview

Development is focused on the current `main` branch. Component versions are listed in [README](./README.md). This is a development preview without a production security guarantee.

## Reporting a vulnerability

If you discover a security vulnerability in this version of OpenBrowser Workbench, please report it responsibly to this repository's maintainer.

**Do not** open a public GitHub issue for security bugs.

Contact the maintainer privately with redacted information:

- A description of the vulnerability
- Steps to reproduce
- Potential impact (e.g. local file access, token exposure, remote code execution)
- Your environment (OS, Node version, browser)

**Contact:** Use **Report a vulnerability** on [this repository's Security page](https://github.com/s-jia233/OpenBrowser-Workbench/security), if enabled. Otherwise use contact information publicly provided by [the maintainer](https://github.com/s-jia233). No dedicated security email address is currently advertised.

There is no fixed response-time commitment. Do not open a public issue containing unpatched exploit details, credentials, full sessions or private source files.

## Scope

OpenBrowser is a **local-first** tool. The bridge server binds to `127.0.0.1` by default and is intended for development on your own machine.

In scope for security reports:

- Unauthorized file system access outside the project root
- Bridge API bypass when `BRIDGE_TOKEN` is configured
- Extension privilege escalation or cross-site data leakage
- Path traversal in agent operations
- Sensitive data written to logs or history files unintentionally

Out of scope (by design):

- Prompt injection against third-party AI services (ChatGPT, Gemini, etc.)
- Abuse of browser AI terms of service
- Issues that require physical access to an unlocked machine with OpenBrowser already running

## Recommended practices for users

- Run the bridge server only on `localhost`.
- Do not expose the server through public interfaces, port forwarding or shared proxies. `BRIDGE_TOKEN` alone does not provide complete network isolation for all endpoints.
- Never commit `.env` or share your `BRIDGE_TOKEN`.
- Review agent-mode diffs before approving file changes.
- Verification scripts run in temporary copies but retain local process permissions, including network and filesystem access outside the copy. Do not run untrusted project scripts.
- Browser or remote models receive tasks and relevant project context. Confirm sharing rights first. Local `.openbrowser` records and browser drafts can contain private code and must not be published.
- Keep the Chrome extension updated from a trusted source (this repository).

## Disclosure policy

We aim to:

1. Confirm the report and assign severity.
2. Develop and test a fix.
3. Release a patched version or document mitigations.
4. Credit reporters in the release notes (unless you prefer to remain anonymous).

Thank you for helping keep OpenBrowser and its users safe.
