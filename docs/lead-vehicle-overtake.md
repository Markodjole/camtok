# Lead vehicle → overtake_30s

Mobile posts lead-vehicle telemetry:

`POST /api/live/sessions/:sessionId/lead-vehicle-events`

When `predictionReady` is true and the room is `waiting_for_next_market`, the
engine opens an `overtake_30s` yes/no market (“Will the rider overtake the lead
vehicle in 30s?”).

Settlement uses `lead_vehicle_events` (lost-while-approaching → yes; window
elapsed → no). See:

- `apps/web/src/actions/live-lead-vehicle.ts`
- `apps/web/src/actions/live-overtake-market.ts`
- `apps/web/src/lib/live/market-resolvers/overtake30sResolver.ts`
- migration `supabase/migrations/00065_lead_vehicle_events_and_overtake_market.sql`

Bettors use the existing live room market UI on web — no new screen for v1.
