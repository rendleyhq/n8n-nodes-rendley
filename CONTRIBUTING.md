# Contributing

Thanks for helping improve the Rendley node for n8n.

## Setup

```bash
npm install
npm run typecheck && npm run lint && npm run build && npm test
```

Node.js 20 or newer. `npm run dev` starts a local n8n with the node linked for manual
testing.

## Rules the package must keep

These are n8n's verification requirements; CI enforces the automated ones.

- No runtime `dependencies`. Use n8n's `this.helpers.httpRequestWithAuthentication`
  for every call; never add an HTTP client.
- No file-system, environment-variable or child-process access in `nodes/` or
  `credentials/`.
- All user-facing text in English, Title Case for display names, sentence case for
  descriptions, and every option documented.
- `n8n-node lint` and `npm run scan` must pass.
- `@n8n/scan-community-package` is pinned to 0.35.0. Version 0.35.1 pins its ESLint
  parser to 8.35.0, which then loads the scanner's own TypeScript 7 and crashes with
  `Cannot read properties of undefined (reading 'Cjs')`. Bump the pin once a release
  resolves the parser against TypeScript 5.

## Layout

- `nodes/Rendley/Rendley.node.ts`: the single node (resources and operations).
- `nodes/Rendley/xxhash.ts`: dependency-free XXH64 for upload hashes.
- `credentials/RendleyApi.credentials.ts`: API key credential with a test request.
- `templates/`: importable workflow JSON.
- `test/`: stub-server and live harnesses that drive the compiled node.

## Before opening a pull request

1. `npm run typecheck && npm run lint && npm run build && npm test && npm run scan` pass.
2. If you changed a request or response shape, run the live harness against a real key.
3. Update `README.md` and add a `CHANGELOG.md` entry if the change is user-visible.
