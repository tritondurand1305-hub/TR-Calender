---
name: tr-community-calendar
description: Project-specific development guide for the Tumbler Ridge Community Calendar repository. Use when inspecting, planning, implementing, debugging, reviewing, or testing this application.
---

# Tumbler Ridge Community Calendar — Agent Skill

## Mission and product intent

Build a practical, trustworthy community information hub for Tumbler Ridge, British Columbia. The primary users are local families, seniors, coal-mine workers, and residents who may be on poor mobile reception or uncomfortable with complicated technology.

The product should make local information easier to find than scrolling through multiple Facebook groups, posters, bulletin boards, and separate municipal/recreation websites. Favor a clear, welcoming, fast, mobile-friendly experience that can also be printed and shared.

This is a community-first proof of concept. Reliability, clarity, trust, and low operating cost matter more than impressive but fragile features.

## Owner's working preferences and constraints

- The owner wants capable coding agents to inspect the repository, plan, implement, test, and iterate with minimal manual copy/paste debugging.
- GitHub is the shared source of truth. Replit is already connected to GitHub, and LM Arena agents can work against the connected repository. Do not assume the owner will pay for Replit's paid Agent tier or ongoing Replit usage.
- Prefer free or low-cost hosting, database, and services where practical. Do not add paid APIs or services without explaining why and getting approval where a new cost is involved.
- Work in small, reversible, reviewable changes. Avoid broad rewrites, needless framework changes, and unrelated cleanup.
- Do not repeatedly reread the whole repository. Inspect the relevant files, follow imports/contracts, and widen the investigation only when evidence requires it.
- Use 4-space indentation for new code where consistent with the touched file; otherwise follow that file's established formatting to minimize churn.
- Be direct about failures, unknowns, and tradeoffs. No pep talks or claims that something works without evidence.
- Never overwrite or discard user work, force-push, reset branches, delete data, or run destructive database operations without explicit authorization.
- Do not treat old conversational notes as proof of current runtime state. Check the current branch, code, environment, and database before asserting status.

## Current repository facts observed on 2026-10-20

Repository: https://github.com/tritondurand1305-hub/TR-Calender  
Default branch: `main`  
Latest observed commit: `6b65325bb94bdb57ce6ce520b46091fabeac0edf` (dependency/project configuration update, 2026-10-20).

The root README and AGENTS.md were not present at the time of inspection. The root `replit.md` is still the generic Replit workspace template and should eventually be replaced with accurate project-specific documentation.

### Stack and structure

- pnpm monorepo/workspaces, Node.js 24, TypeScript 5.9.
- Frontend: React + Vite + TypeScript in `artifacts/tumbler-ridge-calendar`; Wouter routing, TanStack Query, generated API client, Clerk UI integration, and shadcn-style UI components.
- API: Express 5 in `artifacts/api-server`; routes mounted at `/api`.
- Database: PostgreSQL + Drizzle ORM in `lib/db`.
- API contract source: `lib/api-spec/openapi.yaml`.
- Generated validation schemas/types: `lib/api-zod`.
- Generated client/hooks: `lib/api-client-react`.
- A separate `artifacts/mockup-sandbox` exists; do not confuse it with the main app.
- Root workspace scripts include `pnpm run typecheck` and `pnpm run build`.
- API package scripts include `pnpm --filter @workspace/api-server run dev` and `pnpm --filter @workspace/api-server run typecheck`.
- `replit.md` mentions `pnpm --filter @workspace/api-spec run codegen` to regenerate generated API hooks/Zod schemas from OpenAPI, and `pnpm --filter @workspace/db run push` for development schema push. Confirm the actual package scripts before running a command.
- `.replit` currently declares Node.js 24 and PostgreSQL 16 modules and autoscale deployment. Do not assume that means production database credentials or deployment are correctly configured.

### Main app capabilities visible in the current code

- Public searchable event list, categories, date filtering, shareable event detail pages, and weekly calendar overview.
- Categories currently include Community Events, Families & Youth, Sports & Recreation, Seniors & Services, and Community Notices.
- Admin event creation/editing/deletion and submission review, guarded by administrator middleware.
- Anonymous community submissions, including source links and flyer/image attachments. Submissions are queued for human review; they should not publish themselves.
- Uploads use temporary upload URLs, validation, private object storage, and one-use claim tokens.
- Optional email subscriptions with confirmation, preferences, management/unsubscribe links, weekly digest preview, and delivery configuration checks.
- Email preferences in the code include weekly digest, sports/recreation, and family/youth. The intended default is weekly digest ON; sports/recreation and family/youth OFF unless the person explicitly opts in.
- The code uses `America/Vancouver` for community date/time display and date logic. Preserve correct Pacific timezone and daylight-saving behavior.
- Event status, source URL, last verification time, demo flag, and tags are represented in the event model. Make source provenance and freshness visible where appropriate.

### Database and API contract source of truth

- `lib/db/src/schema/community.ts` defines Drizzle tables including `community_events`, `community_submissions`, `community_uploads`, and submission attachments (plus other community tables later in the file).
- The event table is named **`community_events`**, not `events`.
- `artifacts/api-server/src/routes/events.ts` implements public event search/detail/overview and protected admin event operations.
- `artifacts/api-server/src/routes/submissions.ts` implements anonymous submissions, duplicate-potential checks, rate limiting, and attachment claims.
- `artifacts/api-server/src/routes/subscriptions.ts` implements subscription lifecycle and digest behavior.
- `artifacts/api-server/src/routes/storage.ts` and `artifacts/api-server/src/lib/objectStorage.ts` handle upload/storage behavior.
- `artifacts/api-server/src/middlewares/adminAuth.ts` is the place to inspect administrator authorization.
- `artifacts/api-server/src/lib/emailDelivery.ts` is the place to inspect email configuration and sending behavior.
- Update the OpenAPI source and regenerate the client/schema artifacts when API contracts change. Do not hand-edit generated files as the only change.

## Product priorities

### Priority 1 — make the existing foundation work reliably

1. Verify the app boots, the API health endpoint responds, database connectivity works, and the frontend can load real API data.
2. Diagnose the previously observed API development failure: the database reported that the `community_events` table was missing. The current schema defines that table, so first establish whether the correct database is connected and whether migrations/schema push were applied. Do not invent a new table or rename the schema to work around a database setup issue.
3. Test event list/detail, calendar overview, admin authorization, submission, upload, and subscription flows.
4. Distinguish demo/sample data from real events. Never present sample events or unverified notices as confirmed facts.
5. Fix the root `replit.md` so it accurately documents the project, key files, environment, commands, architecture decisions, owner preferences, and gotchas.

### Priority 2 — trustworthy local information ingestion

The owner specifically wants poster/photo upload with AI/OCR extraction and a manual-entry alternative that both produce the same normalized event draft. Treat this as a core future feature.

- Extract candidate title, date, start/end time, location, organizer, cost, registration/contact details, category, and source/provenance where available.
- Preserve the original uploaded source and a link/reference to it.
- Mark uncertain or missing fields clearly; never silently guess dates, times, locations, or whether a notice is still valid.
- AI/OCR output must be a **draft for human review**, never auto-published.
- Keep a manual form available if AI is unavailable or produces poor results.
- Use one normalized event model and shared validation for manual and OCR paths.
- Deduplicate conservatively using source URL and normalized title/date evidence. Flag possible duplicates for review rather than automatically deleting or merging legitimate recurring events.
- Keep ingestion adapters and parsing logic modular so new sources can be added without rewriting the app.

### Priority 3 — alerts and useful community notices

The latest owner priorities for future alerts are:

1. Highway conditions leaving Tumbler Ridge, including DriveBC closures and significant travel disruptions. Useful, frequently checked information should have a clear source and last-checked time.
2. Animal sightings and hazards: bears, lost dogs, deer, moose, cattle, and animals on the highway. Present calm, factual, location/time-bounded information; avoid panic, unverified accusations, or implying an old sighting is current.
3. Community safety reports such as theft, ATM issues, or suspicious activity. Use careful wording, source attribution, and human moderation; do not amplify rumors or identify private individuals without a legitimate, verified public source.
4. BC Hydro outages and infrastructure disruptions, including resident-submitted outage reports. Distinguish official confirmed outages from community reports.

For all alerts: show source, timestamp/last verified, area affected, status, and expiry/recheck behavior where feasible. Stale alerts must not look current. Do not claim automated monitoring exists until it is implemented and tested.

### Priority 4 — optional email subscriptions

- No visitor accounts should be required to browse the public calendar or submit an event.
- Email subscriptions are optional and require explicit consent and email confirmation.
- Weekly digest ON by default; sports/recreation and family/youth categories OFF by default, unless the user chooses otherwise.
- Provide clear unsubscribe and preference management.
- Follow Canadian anti-spam requirements: clear consent, sender identity/contact details where required, and a functioning unsubscribe process.
- Do not save an email address when confirmation delivery is not configured; the current API code is intended to refuse storage in that case.
- Do not send real email during tests unless explicitly configured for a test environment.

## Architecture and safety rules

1. **Public reading, private administration.** Public event browsing should not require a login. Only verified/authorized administrators may publish, edit, delete, or approve records.
2. **Human review gate.** Anonymous submissions and AI/OCR-extracted events are untrusted input. They must remain pending/draft until reviewed by an authorized admin.
3. **Provenance matters.** Preserve original source URL/file, submission metadata, timestamps, and verification state. Do not strip the origin of an event.
4. **Treat public safety reports carefully.** Do not convert a single unverified user report into an official alert. Clearly label reports and moderate them.
5. **Validate every boundary.** Reuse Zod/API schemas for request validation. Enforce file type/size limits on the server; do not trust the browser-provided content type or filename.
6. **Secrets stay secret.** Never commit API keys, credentials, tokens, database URLs, personal email lists, or uploaded private files. Do not print secrets into logs or responses.
7. **Database changes are deliberate.** Inspect schema, package scripts, and connected database before applying migrations/pushes. Prefer additive migrations and backups for data-bearing environments. Never run destructive operations against production.
8. **Timezone discipline.** Tumbler Ridge uses Pacific time. Store timestamps consistently and render event times in `America/Vancouver`; handle all-day/date-only values separately to avoid off-by-one-day bugs.
9. **Generated code discipline.** Treat OpenAPI as the contract source of truth; regenerate dependent artifacts and check generated diffs after contract changes.
10. **Cost discipline.** Prefer local parsing and low-cost services when adequate. Propose paid AI/OCR/email/SMS services with a cost estimate and fallback path before adopting them.
11. **Accessibility and low-bandwidth UX.** Use readable text, strong contrast, large tap targets, plain language, responsive layouts, print styles, and clear loading/empty/error states. Avoid decorative complexity that makes the site harder to use.
12. **No false claims.** Do not say an endpoint, workflow, or feature works unless you ran a relevant test or can cite current evidence.

## Agent workflow for every task

1. **Establish state first**
   - Confirm current branch/commit and inspect the relevant files.
   - Check whether the task is already implemented or partially implemented before changing anything.
   - Look for existing issues, tests, generated contracts, and environment assumptions relevant to the task.
2. **State the actual problem**
   - Separate observed facts from hypotheses.
   - Identify the smallest likely root cause and any risks.
   - If the issue could be caused by environment/database configuration, verify that before changing application logic.
3. **Make a focused plan**
   - Keep the change set narrow.
   - Identify the contract, schema, UI, security, and tests that may be affected.
   - Avoid asking the owner to do manual debugging that an agent can perform through repository tools.
4. **Implement in small steps**
   - Reuse established patterns and dependencies.
   - Do not add dependencies unless needed.
   - Preserve unrelated work and do not perform opportunistic cleanup.
5. **Verify**
   - Run the narrowest relevant tests/typechecks first, then broader checks when practical.
   - For API/schema changes, check OpenAPI, generated types/client, and DB schema consistency.
   - For UI changes, verify loading, empty, error, mobile, and accessibility behavior where relevant.
   - For database-dependent bugs, report which database/environment was checked and whether the schema exists there.
6. **Report completion honestly**
   - Summarize files changed and why.
   - List exact commands/tests run and their outcomes.
   - Clearly state remaining failures, untested behavior, assumptions, and any environment variables/services still required.
   - Do not claim deployment or production verification if only static checks passed.

## Useful commands to verify before using

- `pnpm run typecheck`
- `pnpm run build`
- `pnpm --filter @workspace/api-server run typecheck`
- `pnpm --filter @workspace/api-server run dev`
- `pnpm --filter @workspace/api-spec run codegen`
- `pnpm --filter @workspace/db run push` — development only, after confirming the target database.

Check package scripts before assuming these commands still exist. The observed API server mounts routes at `/api`; `/api/healthz` is defined in the API contract. Do not assume a particular external port or deployment URL without inspecting current Replit/workspace configuration.

## Known things to verify, not assume

- A prior development run reported a missing `community_events` table. The schema file currently defines it; check the actual database and schema deployment.
- Current root `replit.md` is a generic template with stale example port information (it says API port 5000); runtime port routing must be confirmed from current workspace configuration.
- Email sending depends on environment configuration and a valid public HTTPS app URL.
- Admin authorization depends on the configured admin identity/environment and Clerk setup. Never weaken admin middleware to make local testing easier.
- The repository contains `zipFile.zip` (about 5.9 MB) at the root. Do not delete or rewrite it without checking its purpose and obtaining authorization.
- No root `README.md` or `AGENTS.md` was present in the observed tree. This skill is the project-specific development guide; keep it accurate as the repo changes.

## Definition of done

A change is complete only when it solves the stated problem, preserves the product's trust/security constraints, has relevant verification, updates contracts/docs when needed, and leaves a concise, honest report of what was and was not tested.
