# Dotquill: notes for working on this repo

Local pixel-art studio driven over MCP. Node ≥ 22.18 runs the TypeScript directly (type stripping), so there is no build step.

- `src/core/`: document model and pure logic (no MCP, no HTTP). `doc.ts` model and file format, `grid.ts` the character encoding of pixels, `draw.ts` drawing ops, `render.ts` previews for the model, `export.ts` PNG/sheet/GIF, `audit.ts`, `importer.ts`, `store.ts` workspace files, history, focus, `guide.ts` pixel-art guide text served to the model.
- `src/mcp/server.ts`: MCP tools (zod schemas). Tool descriptions and `guide.ts` are prompts: keep them short and precise.
- `src/viewer/`: local HTTP server (127.0.0.1, SSE live updates via fs.watch). `web/` is vanilla JS, no build.

Rules:
- Only erasable TypeScript syntax (no enums, namespaces or parameter properties); import local files with `.ts` extensions.
- Pixel chars must stay in sync between `src/core/grid.ts` (`ALPHABET`) and `web/app.js`.
- Never write to stdout in the MCP server (stdio transport); log with `console.error`.

Checks: `npm run typecheck`, `npm test`, `npm run smoke` (drives the real MCP server through a client and writes previews).
