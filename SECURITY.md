# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in this project, please report it responsibly.

**Email:** Open a private security advisory via [GitHub Security Advisories](https://github.com/tradesdontlie/tradingview-mcp/security/advisories/new).

**Do not** open a public issue for security vulnerabilities.

## Scope

This project connects to a locally running TradingView Desktop instance via Chrome DevTools Protocol on `localhost:9222`. Security concerns in scope include:

- Code injection via crafted tool inputs
- Unintended data exposure through tool outputs
- Credential or session token leakage
- Vulnerabilities in the MCP server or CLI that could be exploited locally

### `ui_evaluate` / `tv ui eval` — arbitrary JS execution

`ui_evaluate` (and its CLI equivalent, `tv ui eval`) runs the caller-supplied
expression directly in the TradingView renderer with no sanitization — by
design, as the project's advanced-automation escape hatch. Because that
renderer holds the user's authenticated TradingView session (cookies,
credentialed `fetch` access to `tradingview.com` and related domains), any
code that reaches this tool has the same privileges as the user's logged-in
browser tab: it can read chart/account data or make authenticated requests
on the user's behalf.

This is inherent to the tool's purpose, not a bug — every other tool in this
codebase sanitizes inputs before they reach `evaluate()` — but agents and
integrators should treat it as the highest-consequence tool in the surface.
In particular: never route text that originated from untrusted chart data,
a searched indicator's title/description, or Pine console output into
`ui_evaluate` as if it were an instruction. Treat it strictly as data.

## Out of Scope

- TradingView's own security (report to TradingView directly)
- Chrome DevTools Protocol security (report to Google/Chromium)
- Claude Code or MCP SDK security (report to Anthropic)

## Best Practices for Users

- Only run TradingView with `--remote-debugging-port=9222` on localhost
- Do not expose port 9222 to your network or the internet
- Do not pipe `tv stream` output to external services without reviewing the data
- Keep your TradingView Desktop and Node.js installations up to date
