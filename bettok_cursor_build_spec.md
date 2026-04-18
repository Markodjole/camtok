
# BetTok / StoryBet — Cursor Build Specification




## Purpose
Build a mobile-first short-video betting app where users watch a paused clip, read or submit story predictions about what happens next, place money on existing predictions or their counters, and later receive the actual continuation plus bet settlement. The feed behaves like TikTok: vertical clips, fast interaction, infinite scrolling, and repeat loops. Every resolved continuation can itself become the starting point for another continuation, creating an endless branching stream of clips.

This document is the implementation specification for Cursor. It defines the product, architecture, schema, LLM engines, workflows, stages, and engineering rules. The goal is to make the build scalable, explainable, and production-ready.

## Product summary
Core loop:
1. User opens feed of short vertical clips.
2. Clip pauses at a betting point.
3. Existing predictions are visible.
4. User can:
   - bet on an existing prediction side (YES / NO),
   - submit a new prediction,
   - rewatch the paused clip in a loop before deciding.
5. Betting closes.
6. Story engine generates continuation.
7. Settlement engine scores each prediction.
8. User receives notification and sees:
   - what continuation happened,
   - whether their suggestion was accepted, rejected, or partially matched,
   - correctness score,
   - money won or lost,
   - clear explanation of why.
9. Continued clip can later pause again and become a new betting node.

## Non-negotiable product principles
- Mobile-first UX.
- Fast, almost addictive feed rhythm.
- Betting and settlement must feel understandable.
- The system must not feel rigged.
- Every result screen must explain what happened in plain language.
- All money movement must be audit-friendly.
- LLM decisions must be logged and replayable.
- Free-text prediction submission must be normalized into canonical markets.
- Each prediction always has a counter side.
- Odds exist before the bet, based on story plausibility.
- Settlement is based on story outcome plus correctness score.
- The system must be designed for scale from day one.

## Recommended stack
Frontend:
- Next.js App Router
- React
- TypeScript
- Tailwind CSS
- shadcn/ui
- Zustand for UI-local state
- TanStack Query for server state
- React Hook Form + Zod for forms
- PWA support for near-mobile feel if native wrapper is not yet used

Backend:
- Supabase Postgres
- Supabase Auth
- Supabase Storage
- Supabase Realtime
- Supabase Edge Functions
- Background job runner (start with database queue + edge functions; later move to dedicated worker service if load grows)

AI / media:
- Seedance or equivalent for text/image/video generation
- LLM provider abstraction layer
- Primary judge/director model: Claude-class reasoning model
- Secondary validator model optional for dispute reduction
- FFmpeg pipeline for clip transforms, thumbnailing, audio normalization, segmentation

Notifications:
- In-app notifications first
- Web push second
- Later native push if app wrapped or moved to React Native

Payments / wallet:
- Start with internal demo wallet ledger
- Keep architecture ready for real-money compliance separation later
- Never mix wallet math with UI math; all money calculations must live server-side

## Build strategy
Build in stages. Do not start by trying to ship the whole AI betting engine at once. First make the content graph, feed, wallets, bets, and settlement shell. Then add smarter LLM logic.

Phases:
1. Foundation and schema
2. Auth, profiles, wallet ledger
3. Feed and clip pages
4. Predictions and betting
5. Basic odds engine
6. Continuation generation pipeline
7. Settlement engine
8. Notifications and result screens
9. Infinite continuation graph
10. Moderation, analytics, and hardening

## User roles
- Viewer: watches clips and may bet
- Creator: uploads a clip or creates one from text/image
- Bettor: submits or joins predictions
- Moderator: reviews flagged media or toxic predictions
- Admin: monitors ledger, jobs, disputes, feature flags

## Main entities
- User
- Profile
- Wallet
- Wallet transaction
- Clip
- Clip segment / pause node
- Prediction
- Prediction side
- Bet
- Odds snapshot
- Continuation job
- Continuation result
- Settlement result
- Notification
- Moderation report
- LLM decision log

## High-level architecture
Use a modular architecture with hard boundaries:

Client apps:
- feed UI
- clip viewer
- bet composer
- wallet screens
- notifications
- history

API / server actions:
- authenticated writes
- read aggregation
- business-rule validation

Domain services:
- odds service
- prediction normalization service
- continuation orchestration service
- settlement service
- wallet ledger service
- notification service
- moderation service

Infra:
- postgres
- storage
- queue/jobs
- llm provider adapter
- media provider adapter
- metrics/logging

## Recommended monorepo structure
/apps
  /web
/packages
  /ui
  /config
  /types
  /db
  /core
  /wallet
  /betting
  /story-engine
  /notifications
  /media
  /analytics
  /prompts
/supabase
  /migrations
  /functions
/docs

Inside packages/core:
- shared constants
- env validation
- ids
- feature flags
- error types
- logging contracts

Inside packages/story-engine:
- normalization
- odds scoring
- continuation prompts
- settlement scoring
- explanation generator
- llm adapters
- replay tools

## Core content model: branching clip graph
Do not model content as a flat list only. Model it as a graph.

A clip node represents:
- a playable media asset
- a pause point where betting occurs
- a parent clip node if it is a continuation
- metadata about story context

A continuation creates a child node.

This lets the app support:
- infinite continuation chains
- alternate branches
- story ancestry
- replay of previous context

Minimum fields for clip_node:
- id
- root_story_id
- parent_clip_node_id nullable
- depth
- creator_user_id
- source_type (upload, text_to_video, image_to_video, continuation)
- status (draft, processing, live, archived, failed)
- video_storage_path
- poster_storage_path
- transcript
- scene_summary
- genre
- tone
- realism_level
- pause_start_ms
- pause_end_ms
- duration_ms
- created_at
- published_at

## Profiles
Profile fields:
- id
- username
- display_name
- avatar_path
- bio
- country_code
- wallet_visibility
- preferred_language
- notification_preferences
- stats cache fields
- created_at

## Wallet architecture
Use a ledger, not balance mutations.

Tables:
- wallets
- wallet_transactions
- wallet_holds

Wallet transaction types:
- deposit_demo
- withdrawal_demo
- bet_hold
- bet_release
- bet_win
- bet_loss
- admin_adjustment
- referral_bonus
- creator_reward

Rules:
- Never update balance directly without ledger entry.
- Available balance = confirmed credits - confirmed debits - open holds.
- Settlement must be idempotent.
- Every bet placement first creates a hold.
- Final settlement converts hold into loss/win entries.

## Prediction model
A user prediction is free text on input, but must be normalized.

Raw user input:
- "wolf turns giant wolverine"
- "dog runs away"
- "2 more wolves come"
- "wolf loses"
- "dog wins"

Normalized result:
- market_key
- side_key
- canonical_text
- raw_text
- normalization_confidence
- structured attributes json

Examples:
- winner / wolf
- winner / dog
- dog_runs_away / yes
- wolf_transforms_wolverine / yes
- wolf_transforms_wolverine / no

This prevents duplicated liquidity fragmentation.

## Every prediction must have a counter
Requirement accepted. For every canonical prediction there is:
- YES
- NO

If user writes a new prediction and no counter money exists yet, the market still exists, but counter participation remains open until lock.

Important: for fuzzy markets, NO means "the specific predicted event does not sufficiently happen."

Example:
Prediction:
- "wolf turns giant wolverine"

YES means:
- that event happens enough to count

NO means:
- that event does not happen enough to count

## Odds model
Before betting closes, every market side needs displayed odds.

Use LLM-based plausibility scoring from the paused clip context.

For each prediction, the odds engine evaluates:
- continuity fit
- genre fit
- character logic
- realism fit
- cinematic value
- surprise factor
- attention retention potential
- contradiction to prior facts

Output:
- probability_yes
- probability_no = 1 - probability_yes
- decimal odds for each side

Display:
- YES odds
- NO odds

Store the reasoning snapshot at the time of odds generation.

## Odds engine prompt role
The model is not a gambler. It is a story plausibility engine.

System role:
"You are an elite film story analyst and commercial short-video director. Given the current scene and candidate next-event predictions, estimate how plausible each prediction is if the next continuation should remain coherent, engaging, and watchable. Avoid random nonsense. Reward logical escalation, character consistency, genre consistency, and strong viewer retention."

Output JSON per prediction:
- market_key
- side_yes_probability
- side_no_probability
- reasoning_short
- reasoning_detailed
- rejected_for_story_break boolean
- plausibility_score
- cinematic_score
- surprise_score
- retention_score

## Odds formula
Use a probability-to-odds conversion with optional house-free spread logic if operating purely pool-based.

For V1 display:
- decimal_odds_yes = 1 / probability_yes
- decimal_odds_no = 1 / probability_no

Then round safely.

If later pool influence is desired, final displayed odds can be blended:
- final_probability = alpha * model_probability + beta * market_implied_probability

But V1 should stay model-first for simplicity.

## Continuation engine
After lock, the continuation engine chooses what happens next.

This must be separated from odds generation.

Reason:
- Odds generation asks "what could plausibly happen?"
- Continuation generation asks "what should happen next to make the best coherent continuation?"

Continuation engine criteria:
- story coherence
- cinematic quality
- attention retention
- payoff to setup
- controlled surprise
- consistency with clip tone and realism
- ability to settle predictions fairly

Output:
- chosen continuation summary
- accepted predictions
- rejected predictions
- partially matched predictions
- generated media prompt
- generated scene explanation

## Story director engine role
System role:
"You are the head writer and director of the next scene. Continue the story in a way that is coherent, emotionally readable, engaging to watch, and aligned with the current clip. Do not choose random outcomes only because users bet on them. However, user predictions may be incorporated if they improve the scene."

The engine may:
- fully accept a prediction
- partially accept a prediction
- reject a prediction
- combine multiple compatible predictions

## Settlement engine
Settlement should be a third separate step.

Inputs:
- original paused clip context
- canonical market
- actual continuation
- prediction text
- canonical attributes
- chosen outcome summary

For each market, LLM returns:
- yes_correctness score 0..1
- no_correctness score 1 - yes_correctness
- short explanation
- evidence bullets

Important:
- keep raw score numeric
- keep explanation
- keep a confidence measure

## Settlement math
Use the simple rule agreed in discussion.

For a market:
- YES pool = Y
- NO pool = N
- yes_correctness = s

Winner:
- if s > 0.5 => YES side wins
- if s < 0.5 => NO side wins
- if s = 0.5 => neutral edge rule or draw rule (recommend draw/refund of transfer)

Strength:
- strength = 2 * abs(s - 0.5)

Transfer:
- losing_amount = losing_pool * strength

Final pools:
- winning_side_final = winning_pool + losing_amount
- losing_side_final = losing_pool - losing_amount

Each bettor on the winning side gets proportional share based on stake.
Each bettor on the losing side keeps proportional share of what remains.

This is critical because:
- only one side wins
- stronger correctness means bigger transfer
- fuzzy partial correctness works
- both sides never fully win

## Example settlement
Market:
- wolf_turns_giant_wolverine
- YES pool = 100
- NO pool = 300
- yes_correctness = 0.70

Then:
- YES wins
- strength = 2 * (0.70 - 0.50) = 0.40
- NO loses 300 * 0.40 = 120
- YES final side value = 220
- NO final side value = 180

If a user had 10 on YES and YES total pool was 100:
- user gets 10% of 220 = 22

If a user had 30 on NO and NO total pool was 300:
- user keeps 10% of 180 = 18

## Handling thin or zero counter liquidity
You wanted every market to have counter side. Good. But there may still be too little or zero money on one side.

Recommended practical rule:
- allow markets with zero on one side
- but expose that visibly in UI
- if one side has no counter, cap total payout to real pool plus global wrong-pool augmentation if enabled in later phase
- for V1 keep it simple: low or zero counter liquidity means low actual payout potential, even if high displayed odds exist
- do not fake money into the system

If later needed:
- create a cross-market reward pool funded from partially wrong under-contested markets
- but do not include this in V1

## My recommendation on this exact point
Do not build the global wrong-pool redistribution in V1. It adds too much complexity and will make the app harder to trust. Launch with direct-side pool settlement only. Then test behavior.

## UX flows

### Feed
- vertical snapping feed
- muted autoplay by default with tap for sound
- visible loop progress
- pause point marker
- "Bet on what happens next" sheet
- visible story depth and parent chain access

### Clip detail / betting sheet
Sections:
- looped paused clip
- countdown until lock
- top active predictions
- odds chips
- enter your own prediction
- join YES / NO quickly
- wallet amount
- your open bets
- creator / story metadata

### Open bet history
- pending bets
- locked bets awaiting continuation
- settled bets
- won/lost amounts
- explanation log

### Result screen
After continuation:
- continuation clip plays
- cards show:
  - your prediction
  - accepted / partial / rejected
  - score
  - side you took
  - stake
  - payout
  - "why" explanation
- CTA to continue the next node

### Upload / create flow
Options:
- upload video
- create from image
- create from text

Input fields:
- title
- genre
- tone
- realism level
- target clip length
- pause point preference
- content tags
- age sensitivity

## Moderation
You need moderation early, not late.

Moderate:
- uploaded clips
- generated clips
- user prediction text
- comments if later added
- profile content

Rules:
- block illegal content
- block hateful or graphic content where needed
- rate-limit spam predictions
- quarantine unsafe generated continuations
- creator reputation scoring later

## Notifications
Events:
- your bet locked
- your prediction was accepted into canonical market
- continuation is live
- your bet settled
- you won
- you lost
- you were partially correct
- your uploaded clip got first bets
- moderation action on your content

Store notifications server-side and show unread badges.

## Analytics and observability
Track:
- feed watch time
- loops per clip
- bet placement conversion
- prediction submission conversion
- average predictions per node
- continuation completion rate
- settlement dispute rate
- notification open rate
- story branch depth
- model latency
- model disagreement rate
- moderation flag rate

## Security and anti-abuse
- Row Level Security in Supabase from the start
- all wallet writes server-only
- signed URLs for protected media if needed
- rate limit prediction creation
- rate limit bet spam
- duplicate market normalization
- anti-sybil checks later
- immutable settlement logs
- prompt-injection resistant LLM wrappers
- content moderation before publishing generated outputs

## Scalability choices
Make these choices immediately:
- never mix UI models with DB records
- use service layer even if Next can call Supabase directly
- create append-only ledger tables
- use status machines for jobs
- make all settlement idempotent
- store all LLM outputs as JSON snapshots
- version prompts
- version scoring algorithms
- version odds algorithms
- keep generated media async
- keep feed queries denormalized through views or materialized summaries when needed

## Suggested status machines

### Clip node status
- draft
- processing
- ready_for_betting
- betting_open
- betting_locked
- continuation_generating
- continuation_ready
- settled
- archived
- failed

### Bet status
- pending_hold
- active
- locked
- settled_win
- settled_loss
- cancelled
- refunded

### Prediction status
- raw_submitted
- normalized
- open
- locked
- settled
- rejected_moderation
- rejected_normalization

### Continuation job status
- queued
- running
- generated_text
- generated_media
- validated
- failed
- published

## Suggested database tables
Keep names explicit and boring.

Core:
- users
- profiles
- wallets
- wallet_transactions
- wallet_holds

Content:
- stories
- clip_nodes
- clip_assets
- clip_context_snapshots

Betting:
- prediction_markets
- prediction_market_versions
- market_sides
- bets
- odds_snapshots
- settlement_results
- settlement_side_results

LLM / jobs:
- llm_runs
- llm_prompt_versions
- continuation_jobs
- media_generation_jobs
- moderation_jobs

Social / UX:
- notifications
- follows optional later
- bookmarks optional later
- reports

## Suggested key table details

### prediction_markets
- id
- clip_node_id
- raw_creator_input
- canonical_text
- market_key
- schema_version
- normalization_confidence
- normalization_explanation
- created_by_user_id
- status
- created_at

### market_sides
- id
- prediction_market_id
- side_key ('yes', 'no')
- current_odds_decimal
- probability
- pool_amount_cached
- created_at

### bets
- id
- user_id
- clip_node_id
- prediction_market_id
- market_side_id
- stake_amount
- odds_at_bet
- available_balance_snapshot
- status
- created_at
- locked_at
- settled_at

### settlement_results
- id
- clip_node_id
- continuation_clip_node_id
- settled_at
- algorithm_version
- llm_run_id
- summary

### settlement_side_results
- id
- prediction_market_id
- yes_correctness
- no_correctness
- winner_side
- strength
- transfer_amount
- explanation_short
- explanation_long
- confidence

## Cursor implementation stages

### Stage 1 — project skeleton
Deliverables:
- monorepo setup
- Next.js app
- package boundaries
- env validation
- Supabase local/dev/prod setup
- migrations folder
- seed data scripts
- linting, formatting, CI

Acceptance:
- app boots
- auth works
- migrations apply
- example feed page renders

### Stage 2 — auth, profile, wallet ledger
Deliverables:
- signup/login
- profile edit
- demo wallet
- ledger screens
- RLS policies

Acceptance:
- user can authenticate
- wallet transactions are append-only
- no direct balance mutation path exists

### Stage 3 — clip ingest and feed
Deliverables:
- upload clip
- store video and poster
- clip card/feed
- clip detail page
- pause point metadata
- loop playback UX

Acceptance:
- creator can upload a short clip
- clip appears in feed
- clip loops correctly around pause region

### Stage 4 — prediction markets
Deliverables:
- submit new prediction
- normalization service
- canonical market creation
- existing prediction list
- join YES/NO

Acceptance:
- semantically duplicate predictions merge
- user sees canonical text
- both sides visible

### Stage 5 — odds engine V1
Deliverables:
- LLM plausibility scoring
- odds snapshot generation
- odds display
- prompt versioning
- audit log

Acceptance:
- each market has YES/NO odds before lock
- reasoning is stored
- odds refresh path exists but is controlled

### Stage 6 — betting and holds
Deliverables:
- bet form
- wallet hold creation
- open bet screen
- lock flow

Acceptance:
- balance check server-side
- holds created atomically
- user cannot overspend

### Stage 7 — continuation generation
Deliverables:
- continuation job queue
- director engine
- media generation orchestration
- continuation publish flow

Acceptance:
- a locked node can generate a child continuation node
- continuation appears when ready
- full logs stored

### Stage 8 — settlement engine
Deliverables:
- settlement prompt
- score generation
- strength calculation
- side transfer calculation
- ledger settlement
- result explanations

Acceptance:
- only one side wins per market
- transfer matches formula
- result screen shows clear why

### Stage 9 — notifications
Deliverables:
- in-app notifications
- result notifications
- unread counts
- settlement links

Acceptance:
- user is notified when continuation is live
- user can jump directly into result screen

### Stage 10 — infinite story graph
Deliverables:
- each continuation can become a new paused node
- parent chain navigation
- story map page
- branch depth metadata

Acceptance:
- user can continue scrolling through branches
- lineage is preserved

### Stage 11 — moderation and admin
Deliverables:
- reports
- moderation queue
- admin dashboard basics
- clip takedown flow
- market freeze/cancel flow

Acceptance:
- unsafe content can be disabled
- stuck jobs can be retried
- admins can inspect settlement history

### Stage 12 — hardening
Deliverables:
- analytics
- caching
- retries
- dead-letter handling
- edge case tests
- prompt regression harness

Acceptance:
- core flows are resilient
- repeated settlement does not duplicate money movement

## Prompting system design
Do not hardcode huge prompt strings inline across random files.

Create prompt packs:
- odds.system.md
- odds.user.md
- normalize.system.md
- normalize.user.md
- director.system.md
- director.user.md
- settlement.system.md
- settlement.user.md

Version each prompt.
Store prompt version on every llm_run.

## LLM output discipline
Every LLM output must be schema-validated with Zod before use.
Never trust raw text output.
If validation fails:
- retry with repair prompt
- else mark job failed safely

## Proposed service boundaries

### normalization service
Input:
- clip context
- raw prediction text
Output:
- canonical market
- side mapping
- confidence
- explanation

### odds service
Input:
- clip context
- canonical prediction markets
Output:
- yes/no probabilities
- decimal odds
- reasons

### director service
Input:
- clip context
- active predictions
- genre/tone/realism
Output:
- continuation plan
- accepted and rejected idea map
- media prompt

### settlement service
Input:
- continuation result
- canonical predictions
- bet pools
Output:
- correctness scores
- winning side
- strength
- pool transfer
- per-bet payout entries

### ledger service
Input:
- settlement outputs
Output:
- holds release
- loss/win transactions
- audit records

## UI component list
- FeedShell
- VideoCard
- BettingBottomSheet
- PredictionChip
- OddsBadge
- MarketRow
- AddPredictionComposer
- WalletPill
- OpenBetList
- ResultCard
- ContinuationExplainer
- StoryBranchHeader
- NotificationCenter
- UploadClipWizard
- CreateFromPromptWizard
- ProfileHeader
- LedgerTable

## Engineering rules for Cursor
- Use server actions or route handlers only for secure writes
- Keep all money math in shared pure functions under packages/wallet and packages/betting
- No business logic inside React components
- All schemas defined once in Zod and reused
- Prefer explicit DTOs for API boundaries
- Use optimistic UI only where money is not finalized
- For bets, optimistic UI may show pending state but server decides truth
- Use feature flags for unfinished AI stages
- Keep strong typing end to end
- Write tests for normalization, odds conversion, settlement math, and ledger

## Test strategy

### Unit tests
Test:
- normalization merge logic
- odds conversion
- settlement formula
- wallet available balance
- idempotent settlement

### Integration tests
Test:
- place bet -> hold created
- lock market -> continuation job created
- continuation complete -> settlement runs
- settlement -> wallet ledger updated
- notification created

### Prompt regression tests
Maintain a fixed library of scenes and prediction inputs.
For each prompt version, compare:
- normalization outputs
- odds bands
- settlement consistency

### E2E tests
Use Playwright for:
- sign up
- load feed
- bet on existing prediction
- create new prediction
- receive result
- inspect wallet and notification

## Suggested V1 constraints
To reduce complexity in first working version:
- clip duration 5–20 seconds
- one pause node per clip initially
- demo wallet only
- one continuation branch chosen as canonical result
- no social comments yet
- no creator monetization yet
- no real-money withdrawals yet
- no global redistribution pool yet

## Important future extensions
After V1:
- blend model odds with market odds
- branch voting
- creator rewards
- ranked story leagues
- AI multi-judge consensus
- fraud detection
- real-money licensing separation by geography
- native mobile shell

## Direct product advice
What should stay:
- TikTok-like feed
- paused clip betting
- free-text predictions
- LLM director engine
- explanation-first result screens
- infinite continuation graph

What should not be overcomplicated in V1:
- cross-market redistribution
- multi-judge arbitration
- creator economy splits
- social graph complexity
- advanced financial mechanics

## Concrete build order for Cursor
Tell Cursor to build in this exact order:
1. Monorepo + web app + supabase
2. Auth + profiles + wallet ledger
3. Clip upload + feed + clip detail
4. Prediction market CRUD + canonical normalization
5. Bet placement + holds + open bets
6. Odds engine with mocked LLM first
7. Real LLM odds engine
8. Continuation job pipeline with mocked media
9. Real media generation adapter
10. Settlement engine and result screen
11. Notifications
12. Story graph navigation
13. Moderation and admin basics
14. Tests, retries, analytics, hardening

## What Cursor should mock first
Before integrating Seedance and real LLM:
- use static sample videos
- generate fake continuation plans
- generate fake settlement scores
- exercise full app flow end to end

Only after core mechanics work:
- switch adapters to real providers

## Final implementation note
The most important long-term asset in this app is not just the UI. It is the story engine log:
- what context was seen,
- what markets existed,
- what odds were generated,
- what continuation was chosen,
- why,
- how settlement happened.

Store that cleanly. It will matter for:
- user trust
- debugging
- audits
- tuning prompts
- future model improvements

## Final instruction to Cursor
Build a scalable, mobile-first, TikTok-style short-video prediction betting platform using Next.js, React, TypeScript, Tailwind, shadcn/ui, and Supabase. Use a modular architecture, append-only wallet ledger, canonical prediction markets with YES/NO sides, model-generated odds, a separate story director continuation engine, and a separate settlement engine using partial correctness scoring with one winning side per market. Implement the system in stages, keep all money logic server-side, validate all LLM outputs with schemas, version prompts and scoring algorithms, and prioritize explanation, auditability, and user trust in every screen.
