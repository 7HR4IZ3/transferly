# Notes for Claude

## Tooling
- **Use Bun, not npm/npx/yarn/pnpm.** `bun install`, `bun run <script>`, `bunx <tool>`, `bun add` / `bun add -d`.
  Lockfiles are `bun.lock` (root and `worker/`); never create `package-lock.json`.
- Checks before committing: `bun run lint`, `bun run typecheck`, `bun run build`, and `cd worker && bun run typecheck`.

## Project
- Next.js app (Vercel) + Cloudflare Worker in `worker/` (pairing over WebSockets, TURN relay credentials).
- See README.md for the architecture, pairing protocol, offline mode and deploy steps.
