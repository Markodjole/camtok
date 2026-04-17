# CamTok

Live WebRTC + GPS route-state betting for pedestrians, bikes, and vehicles.

> Pivoted from the earlier AI-generated clip betting architecture. The route
> state engine is the true game engine; the stream is the viewing layer;
> the room timeline is the fairness layer; the market lock/settlement system
> is the betting layer.

## Core product modes

- **Feed (`/live`)** — live characters, open markets, countdowns
- **Live room (`/live/rooms/:roomId`)** — shared WebRTC stream + market
- **Owner control panel (`/live/go/:characterId`)** — go live (transport
  mode, status, camera + GPS)
- **User market composer** — spectators can propose validated markets on
  top of live context (walking/bike only by default)

## Monorepo layout

```
apps/web                 Next.js 15 app (all product UI + API routes)
packages/core            env, errors, ids, feature flags
packages/live            live betting core (route-state, markets, safety,
                         stream tokens, location sanitization)
packages/types           shared Zod schemas and TS types
packages/db              Supabase client factories
packages/wallet          demo wallet ledger
packages/betting         legacy AI-clip betting engine (archive mode)
packages/story-engine    legacy continuation pipeline (archive mode)
```

## Key database tables (migration 00038)

- `character_live_sessions` — broadcaster state
- `live_route_snapshots`    — normalized GPS truth (owner-only read)
- `route_decision_nodes`    — upcoming decisions detected ahead of user
- `live_rooms`              — shared spectator surface per session
- `live_betting_markets`    — system + user generated markets
- `user_market_proposals`   — validated/rejected/converted proposals
- `market_lock_records`     — immutable commit evidence per market
- `live_room_events`        — canonical append-only room timeline
- `live_bets`               — bets placed in live markets
- `character_route_stats`   — aggregated per-character behavior

## Core services (in `@bettok/live`)

- `RouteState.normalizeGpsBatch` — smooth + sanity-check noisy GPS
- `RouteState.detectNextDecision` — infer upcoming decision node
- `RouteState.buildMarketDraftFromOptions` — human-friendly market draft
- `RouteState.computeCommitHash` — deterministic lock evidence hash
- `RouteState.revealFromMovement` — compare actual path vs locked options
- `Markets.validateUserMarket`   — safety + clarity rules
- `Markets.canTransitionRoom/Market` — state machine guards
- `Markets.computeParimutuelPayouts` — payout engine
- `Safety.policyFor`             — transport-mode policy (walking default,
                                   car restricted, bike gated)
- `Stream.issueBroadcasterToken / issueViewerToken / verifyToken` — HMAC
  tokens. Swap for LiveKit/Agora/mediasoup later without changing UI.
- `Location.sanitizeLocation`    — privacy: never surface raw coords

## Server actions & API surface

```
actions/live-sessions.ts        startLiveSession / heartbeat / end
actions/live-location.ts        ingestLocationBatch
actions/live-markets.ts         openSystemMarketForRoom / propose / placeBet
actions/live-settlement.ts      lockMarket / revealAndSettleMarket

/api/live/feed                  GET   list active rooms
/api/live/sessions/:id/
  heartbeat                     POST  heartbeat + status text update
  location                      POST  batch GPS ingest
  broadcaster-token             POST  broadcaster WebRTC token (owner)
  viewer-token                  POST  viewer WebRTC token
/api/live/rooms/:id/
  state                         GET   single-room details
  bet                           POST  place live bet
  markets/propose               POST  submit user market proposal
  tick                          POST  advance state machine (cron/client)
```

## Safety policy (v1)

- **Walking** — primary mode, full system + user markets
- **Bike / scooter** — allowed, shorter lock windows, owner approval
- **Car / other vehicle** — system markets disabled by default; hard
  restrictions on anything that could encourage unsafe driving behavior

## Environments (mirror: localhost <-> production)

CamTok runs with the same topology in both environments: Next.js app +
Supabase. Only the endpoints differ.

| Surface              | Localhost                              | Production                                 |
| -------------------- | -------------------------------------- | ------------------------------------------ |
| Next.js              | `http://localhost:3000` (`pnpm dev`)   | `https://camtok-web.vercel.app` (Vercel)   |
| Supabase             | Docker stack (`supabase start`, :5433x)| `tqsuhldwswkoqmwxinne.supabase.co`         |
| Migrations           | `supabase migration up --local`        | `supabase db push` (linked project)        |
| Env file             | `apps/web/.env.local`                  | Vercel project env vars                    |
| Live stream secret   | Generated per machine                  | Set once in Vercel (`LIVE_STREAM_SECRET`)  |

### Localhost

```bash
pnpm install
pnpm camtok:dev          # starts local Supabase + writes .env.local + runs next dev
```

Or the long form:

```bash
supabase start
pnpm db:migrate:local
pnpm --filter @bettok/web dev
```

### Production

1. Push schema: `pnpm db:migrate` (runs `supabase db push` against the
   linked project `tqsuhldwswkoqmwxinne`).
2. Sync env vars to Vercel (one time or when values change):
   ```bash
   pnpm vercel:env:push                   # all vars from apps/web/environment.txt
   pnpm vercel:env:push LIVE_STREAM_SECRET # a specific key
   ```
3. Deploy: Vercel auto-deploys on push to `main`, or run `vercel --prod`
   inside `apps/web`.

`LIVE_STREAM_SECRET` must be the SAME value across all scopes (prod,
preview, development). Generate with `openssl rand -hex 32`.
