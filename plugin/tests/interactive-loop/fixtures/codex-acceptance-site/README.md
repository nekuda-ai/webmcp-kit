# Reading Room Supply acceptance fixture

This is a real, deliberately small website for exercising the WebMCP Kit implement flow in a temporary copy. It begins with **no WebMCP tools**. The target has enough application behavior to discover and implement useful tools instead of replaying canned agent output:

- read journey: search and filter a live product catalog;
- confirmed mutation journey: reserve an in-stock piece through an explicit confirmation dialog;
- visible effects: inventory, shelf counts, and the reservation list update together;
- persistent state: reservations survive server restarts in `data/state.json`;
- reset semantics: the local inventory can always be restored to its seed state.

The server and smoke test use Node built-ins only. There is no install step and no network dependency.
The server serves generated browser modules from any nested path beneath `public/`, matching the
two-module WebMCP code-generation shape.

## Start it

Node 20 or newer is required.

```sh
bun server.mjs
```

Open <http://127.0.0.1:4173>. To select a different port:

```sh
PORT=4317 bun server.mjs
```

`PORT=0` asks the operating system for a free port; use the URL printed by the server. The package aliases are also available:

```sh
npm start
npm run dev
```

The default state file is `data/state.json`, which is created on first start and ignored by Git. Set `STATE_FILE=/absolute/path/to/state.json` to isolate a run.

## Operator endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Liveness and state-schema version |
| `GET` | `/api/catalog?q=&category=&available=true` | Read/filter catalog and current stock |
| `GET` | `/api/reservations` | Read current local reservations |
| `POST` | `/api/reservations` | Reserve `{ "productId": "aurora-lamp", "quantity": 1 }` |
| `DELETE` | `/api/reservations/:id` | Release one reservation |
| `POST` | `/api/reset` | Restore seed stock and clear reservations |

This is a localhost verifier fixture, so reset is intentionally available without authentication. The browser asks for confirmation before every user-facing mutation.

## Verify it

```sh
npm run check
npm test
```

The smoke test starts on an ephemeral port with a temporary state file. It checks health, a filtered catalog read, a reservation mutation, persistence after a full server restart, and reset back to the initial inventory. It removes its temporary state afterward and does not touch the interactive fixture state.

## Acceptance use

Copy this entire directory to a temporary working directory, start the server, and point the implementation flow at the copy. A valid run should add tools to the copy's application code and exercise those real server journeys. Do not pre-seed generated tool modules or deterministic agent responses here; the fixture is the application under test.
