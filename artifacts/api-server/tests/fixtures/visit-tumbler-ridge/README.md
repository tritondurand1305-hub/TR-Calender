# Synthetic source fixtures

**These files were written for the tests. They are not captures of
`https://www.visittumblerridge.ca/events` and must not be treated as evidence
of how that page is marked up.** This environment has no outbound internet
access, so the live page could not be fetched.

They exercise the structures the adapter supports, which are defined by public
formats rather than by the site's own markup:

| Fixture | What it represents |
| --- | --- |
| `listing.html` | A listing page with schema.org JSON-LD events, standard Google Calendar `action=TEMPLATE` links, a per-event `.ics` link on the source host, a shared calendar export link (which must be ignored) and a `<link rel="alternate" type="text/calendar">` feed hint. |
| `event.ics` | A single-event iCalendar file with a `UID`, `TZID` times, a folded line and escaped text. |
| `all-day.ics` | An all-day `VALUE=DATE` event. |
| `recurring.ics` | A recurring event, which the adapter refuses to expand. |
| `feed.ics` | Two events in one file, which the adapter holds rather than partly importing. |
| `listing-relative.html` | The same listing with relative `.ics` links, so the end-to-end HTTP test can serve it from a local server. |
| `malformed.html` | A page with neither links nor structured data. |

The first live run to a network-enabled environment must confirm or refute the
assumptions listed in `docs/ingestion-visit-tumbler-ridge.md` before any of
this is described as working against the real source.
