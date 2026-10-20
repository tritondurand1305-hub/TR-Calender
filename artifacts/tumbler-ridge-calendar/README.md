# Tumbler Ridge Community Calendar

A mobile-friendly public calendar and event-submission proof of concept for Tumbler Ridge, BC. It is an independent community prototype and does not represent an authorized District service.

## What works

- Upcoming, week, and month calendar views; category filters and search; shareable event detail pages; weekly print layout.
- Persistent event records with source URLs, verification timestamps, status, and duplicate checks.
- Public, anonymous event suggestions with optional follow-up email and a submission reference.
- Private JPG, PNG, WebP, and PDF uploads (8 MB per file, up to three per submission). The API checks file signatures and size; files remain private, are previewed only by an administrator, and never publish automatically.
- Clerk sign-in for the organizer area, with authorization limited to the verified email addresses in `ADMIN_EMAILS`.
- Optional email preferences, confirmation and management flows, plus a read-only digest preview.

## Architecture and local setup

- The Vite/React interface is `artifacts/tumbler-ridge-calendar`.
- The Express API is the shared `artifacts/api-server` service.
- Both use the shared PostgreSQL schema in `lib/db`; there is no browser-only event store.
- Apply the current development schema with `pnpm --filter @workspace/db run push`.
- Run the configured calendar and API workflows. Useful checks are `pnpm --filter @workspace/tumbler-ridge-calendar run typecheck` and `pnpm --filter @workspace/api-server run typecheck`.
- In Replit Secrets, set `ADMIN_EMAILS` to a comma-separated list of the exact verified primary email addresses allowed to administer the calendar. No account is an administrator by default.
- Anonymous uploads require the private object-storage configuration. If it is unavailable, the API returns a clear setup error and text/link submissions remain available. Do not change the storage bucket to public.
- Rate limits are process-local for this proof of concept. Use a shared rate-limit store before running multiple API instances or handling significant public traffic.

Development startup seeds three clearly labeled demo events only when the event table is empty. Production does not seed demo events; organizers should publish verified listings through the admin area.

## Source research and import limits

The listed public sources were inspected:

- [District events and programs calendar](https://www.districtoftumblerridge.ca/p/events-calendar) — a public calendar with categories for community-centre programs, events, library programs, local government, sports, and other listings.
- [Visit Tumbler Ridge community centre](https://www.visittumblerridge.ca/community-centre) — facility information, not an event feed.
- [Univerus facility portal](https://app.univerusrec.com/tumblerridgepub/facilities/index.asp) — facility availability and booking, not a general community-event feed.

This version does **not** scrape, import, or synchronize those sites. Events entered by an organizer or approved from a suggestion retain their source URL and can be marked with a last-verified date. Any future importer must be source-specific, preserve attribution, deduplicate against existing events, and require review before publication.

The upload workflow is ready for a future poster parser, but no AI extraction is currently run. Any later extraction must remain a draft for a human to verify.

## Email setup and limits

Email is optional and does not gate calendar browsing or event submissions. Preferences default to a weekly digest; sports/recreation and family/youth are opt-in categories. Consent is separate from event submission.

No email provider is connected in this proof of concept. Until a server-side provider adapter and verified sender are configured, subscription requests are not stored or represented as confirmed; no confirmation or digest email is sent. The organizer page reports the actual delivery status. The weekly digest screen is a preview only: no scheduled sender is active.

The replaceable server interface expects sender details in `EMAIL_FROM_NAME` and `EMAIL_FROM_ADDRESS`. Development sending additionally requires `EMAIL_TEST_MODE=true` and an explicitly allow-listed `EMAIL_TEST_RECIPIENTS` address. Production sending stays disabled unless `EMAIL_DELIVERY_ENABLED=true` is explicitly set after the provider is configured and tested. Keep all credentials in Replit Secrets, never in source control. Review the final consent copy, sender identity, unsubscribe handling, and message classification against current CASL requirements before launch.

## Before public launch

1. Set and test the administrator allow-list.
2. Decide how official listings will be entered or imported; verify each item and source date.
3. Connect and test an email provider before enabling subscriptions or digest delivery.
4. Review CASL and privacy requirements, and replace process-local rate limiting if traffic or instance count grows.
