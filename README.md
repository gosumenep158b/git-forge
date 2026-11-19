# gh-forge-r4

A standalone GitHub-compatible git forge for [github-core-clone-01](https://make.fun/bounty/github-core-clone-01).
One Node 22 process, standard library only, no npm dependencies, serving from an in-memory store.

## Surfaces

- **git smart HTTP** at `/{owner}/{repo}.git` — upload-pack protocol v2 (`ls-refs`, `fetch`
  with shallow/deepen) and the v0 fallback with side-band-64k; receive-pack v0 advertising
  report-status, side-band-64k and delete-refs; fast-forward-only ref updates with per-ref
  `ok`/`ng` report lines.
- **REST v3** under `/api/v3` — repositories, branches, commits, contents (create/update/
  delete with sha staleness checks), labels, issues, comments, pull requests and merges.
- **GraphQL v4** at `/api/graphql` — a hand-rolled parser and executor covering the documents
  gh and github-mcp-server send, including `__type` introspection, cursor pagination and
  batched operations.
- **MCP** at `/mcp` — JSON-RPC 2.0 over Streamable HTTP, both the 2026-07-28 `server/discover`
  era and the initialize/initialized handshake; six tools over the same store as REST.

## Layout

| file | role |
|---|---|
| `main.ts` | entry ↔ env lifecycle: ephemeral port, register, poll done |
| `server.ts` | the HTTP server, routing, auth, request ids |
| `webkernel.ts` | router, reply helpers, bearer parsing, Link pagination |
| `model.ts` | the in-memory Forge: repos, objects, issues, pulls (deterministic ids) |
| `objformat.ts` | git objects: hashing, trees, commits, packs, pkt-lines |
| `gitsmart.ts` | upload-pack v2/v0 and receive-pack |
| `restapi.ts` | the REST v3 routes |
| `gqlapi.ts` | the GraphQL parser and executor |
| `mcpapi.ts` | the MCP transport and tools |

## Run

```sh
node --experimental-strip-types main.ts
```

Nothing to install: the program imports Node built-ins and its own modules only.

License: MIT.
