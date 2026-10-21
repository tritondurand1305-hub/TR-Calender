import { useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { Link, Route, Switch, Router as WouterRouter, useLocation, useParams } from 'wouter';
import { ClerkProvider, SignIn, SignUp, useClerk, useUser } from '@clerk/react';
import { publishableKeyFromHost } from '@clerk/react/internal';
import { shadcn } from '@clerk/themes';
import { CalendarDays, MapPin, Clock3, ArrowRight, Search, Menu, X, Megaphone, Upload, FileText, ShieldCheck, Mail, ExternalLink, ChevronLeft, ChevronRight, Leaf } from 'lucide-react';
import {
  EventCategory, EventStatus, SubmissionStatusInputStatus, useHealthCheck, useListEvents,
  useGetEvent, useGetCalendarOverview, useCreateSubmission, useRequestUploadUrl, useCompleteUpload,
  useCreateSubscription, useConfirmSubscription, useGetSubscriptionPreferences,
  useUpdateSubscriptionPreferences, useUnsubscribe, useGetAdminStatus, useListAdminEvents,
  useCreateEvent, useUpdateEvent, useDeleteEvent, useListSubmissions, useApproveSubmission,
  useUpdateSubmissionStatus, useGetEmailDeliveryStatus, useGetWeeklyDigestPreview,
  getListEventsQueryKey, getGetEventQueryKey, getGetCalendarOverviewQueryKey, getGetAdminStatusQueryKey,
  getListAdminEventsQueryKey, getListSubmissionsQueryKey, getGetEmailDeliveryStatusQueryKey,
  getGetWeeklyDigestPreviewQueryKey,
} from '@workspace/api-client-react';
import type { Event, EventInput, EventUpdate, EventCategory as EventCategoryType, ListSubmissionsQueryResult, UploadClaim } from '@workspace/api-client-react';

const queryClient = new QueryClient();
const basePath = import.meta.env.BASE_URL.replace(/\/$/, '');
const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;
function stripBase(path: string): string {
  return basePath && path.startsWith(basePath) ? path.slice(basePath.length) || '/' : path;
}
const clerkAppearance = {
  theme: shadcn,
  options: {
    logoPlacement: 'inside' as const,
    logoLinkUrl: basePath || '/',
    logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
  },
  variables: {
    colorPrimary: '#183D35',
    colorForeground: '#24332F',
    colorMutedForeground: '#58645F',
    colorDanger: '#9B352C',
    colorBackground: '#F7F5EF',
    colorInput: '#FFFFFF',
    colorInputForeground: '#24332F',
    colorNeutral: '#D5D8D0',
    fontFamily: '"DM Sans", Arial, sans-serif',
    borderRadius: '12px',
  },
  elements: {
    rootBox: { display: 'flex', justifyContent: 'center', width: '100%' },
    cardBox: { backgroundColor: '#F7F5EF', borderRadius: '20px', width: '440px', maxWidth: '100%', overflow: 'hidden' },
    card: { boxShadow: 'none', border: '0', backgroundColor: 'transparent' },
    footer: { boxShadow: 'none', border: '0', backgroundColor: 'transparent' },
    headerTitle: { color: '#24332F', fontFamily: '"DM Serif Display", Georgia, serif' },
    headerSubtitle: { color: '#58645F' },
    formFieldLabel: { color: '#24332F' },
    formFieldInput: { color: '#24332F', backgroundColor: '#FFFFFF', borderRadius: '10px' },
    formButtonPrimary: { color: '#FFFFFF', backgroundColor: '#183D35', borderRadius: '999px' },
    socialButtonsBlockButtonText: { color: '#24332F' },
    footerActionLink: { color: '#183D35' },
    footerActionText: { color: '#58645F' },
    dividerText: { color: '#58645F' },
    alertText: { color: '#812D25' },
  },
} as const;
const categories = Object.values(EventCategory);
const categoryShort: Record<string, string> = {
  'Community Events': 'Community',
  'Families & Youth': 'Families',
  'Sports & Recreation': 'Recreation',
  'Seniors & Services': 'Seniors',
  'Community Notices': 'Notice',
};
const communityTimeZone = 'America/Vancouver';
const vancouverDateString = (value: Date | string) => new Intl.DateTimeFormat('en-CA', { timeZone: communityTimeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
const dateFmt = (value?: string | null, options?: Intl.DateTimeFormatOptions) => value ? new Intl.DateTimeFormat('en-CA', { timeZone: communityTimeZone, weekday: 'short', month: 'long', day: 'numeric', ...options }).format(new Date(value)) : 'Date to be announced';
const dateOnlyFmt = (value: string) => new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', weekday: 'short', month: 'long', day: 'numeric' }).format(new Date(`${value.slice(0, 10)}T12:00:00Z`));
const timeFmt = (value?: string | null) => value ? new Intl.DateTimeFormat('en-CA', { timeZone: communityTimeZone, hour: 'numeric', minute: '2-digit' }).format(new Date(value)) : '';
const vancouverMidnight = (dateOnly: string) => {
  const [year, month, day] = dateOnly.split('-').map(Number);
  const wallClock = Date.UTC(year, month - 1, day);
  const initial = new Date(wallClock);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: communityTimeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(initial);
  const values = Object.fromEntries(parts.map(part => [part.type, Number(part.value)]));
  const offset = Date.UTC(values.year, values.month - 1, values.day, values.hour, values.minute, values.second) - wallClock;
  return new Date(wallClock - offset);
};
const addCalendarDays = (dateOnly: string, days: number) => {
  const date = new Date(`${dateOnly}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};
const mondayFor = (dateOnly: string) => {
  const date = new Date(`${dateOnly}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.toISOString().slice(0, 10);
};
const localInputDate = (iso?: string | null) => {
  if (!iso) return '';
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: communityTimeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso));
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}`;
};
const fromLocalInput = (value: string) => {
  if (!value) return '';
  const [datePart, timePart] = value.split('T');
  const [year, month, day] = datePart.split('-').map(Number);
  const [hour, minute] = timePart.split(':').map(Number);
  const wallClock = Date.UTC(year, month - 1, day, hour, minute);
  const first = new Date(wallClock);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: communityTimeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(first);
  const values = Object.fromEntries(parts.map(part => [part.type, Number(part.value)]));
  const offset = Date.UTC(values.year, values.month - 1, values.day, values.hour, values.minute, values.second) - wallClock;
  return new Date(wallClock - offset).toISOString();
};
const errorText = (error: unknown) => error instanceof Error ? error.message : 'Something went wrong. Please try again.';

function Header() {
  const [path] = useLocation();
  const [open, setOpen] = useState(false);
  const links = [['/', 'Home'], ['/calendar', 'Calendar'], ['/notices', 'Notices'], ['/submit', 'Share an event'], ['/updates', 'Email updates']];
  return <header className="topbar"><div className="topbar-inner">
    <Link href="/" className="brand" data-testid="link-home"><span className="brand-mark">T</span><span>Tumbler Ridge<br /><small style={{ fontWeight: 500, color: '#68766e', letterSpacing: '.02em' }}>Community Calendar</small></span></Link>
    <nav className="navlinks" aria-label="Main navigation">{links.map(([href, label]) => <Link key={href} href={href} className={path === href ? 'active' : ''} data-testid={`nav-${label.toLowerCase().replaceAll(' ', '-')}`}>{label}</Link>)}</nav>
    <button className="mobile-menu" aria-label={open ? 'Close menu' : 'Open menu'} onClick={() => setOpen(!open)} data-testid="button-mobile-menu">{open ? <X size={22} /> : <Menu size={22} />}</button>
    {open && <nav className="mobile-nav" aria-label="Mobile navigation">{links.map(([href, label]) => <Link onClick={() => setOpen(false)} key={href} href={href}>{label}</Link>)}<Link href="/admin" onClick={() => setOpen(false)}>Organizer sign-in</Link></nav>}
  </div></header>;
}

function Footer() {
  return <footer className="footer"><div className="footer-inner"><div><b className="serif" style={{ fontSize: 20, color: '#183D35' }}>A local guide, together.</b><div style={{ marginTop: 6 }}>Made for the people and places of Tumbler Ridge, BC.</div></div><div><Link href="/submit">Suggest an event</Link><Link href="/updates">Email updates</Link><Link href="/admin">Organizer access</Link></div></div></footer>;
}

function Shell({ children }: { children: ReactNode }) {
  return <div className="site-shell"><Header />{children}<Footer /></div>;
}
function Loading({ label = 'Loading community calendar' }: { label?: string }) {
  return <div className="page section" aria-label={label}><div className="skeleton" style={{ width: 160, marginBottom: 18 }} /><div className="skeleton" style={{ height: 42, width: '55%', marginBottom: 28 }} /><div className="event-grid">{[1, 2, 3].map(n => <div className="paper" key={n}><div className="skeleton" style={{ width: '35%', marginBottom: 22 }} /><div className="skeleton" style={{ height: 26, marginBottom: 14 }} /><div className="skeleton" style={{ width: '75%' }} /></div>)}</div></div>;
}
function LoadError({ error, retry }: { error: unknown; retry: () => void }) {
  return <div className="error-message" role="alert"><b>We couldn’t load that just now.</b><div>{errorText(error)}</div><button className="btn small secondary" style={{ marginTop: 10 }} onClick={retry}>Try again</button></div>;
}
function Empty({ title, text }: { title: string; text: string }) {
  return <div className="empty-state"><Leaf size={24} style={{ margin: '0 auto 12px', color: '#547261' }} /><b style={{ display: 'block', color: '#34443d', marginBottom: 7 }}>{title}</b>{text}</div>;
}
function EventCard({ event }: { event: Event }) {
  const date = event.startAt ? new Date(event.startAt) : null;
  const dateParts = date ? new Intl.DateTimeFormat('en-CA', { timeZone: communityTimeZone, month: 'short', day: 'numeric' }).formatToParts(date) : [];
  const month = dateParts.find(part => part.type === 'month')?.value;
  const dayNumber = dateParts.find(part => part.type === 'day')?.value;
  return <Link href={`/events/${event.slug}`} className="event-card" data-testid={`card-event-${event.id}`}>
    <div className="date-block"><span>{month || 'TBA'}</span><b>{dayNumber || '—'}</b></div>
    <div style={{ flex: 1 }}><span className="tag">{categoryShort[event.category] || event.category}</span><h3>{event.title}</h3><p>{event.summary || event.description || 'More details from the organizer.'}</p><div className="event-meta">{event.allDay ? <CalendarDays size={14} /> : <Clock3 size={14} />}{event.allDay ? 'All day' : timeFmt(event.startAt)}{event.location && <><span>·</span><MapPin size={14} />{event.location}</>}</div>{event.isDemo && <div className="hint" style={{ marginTop: 8 }}>Demonstration data</div>}</div><ArrowRight size={17} style={{ color: '#6c7a72', flexShrink: 0, marginTop: 4 }} />
  </Link>;
}
function EventList({ events, loading, error, retry, emptyTitle = 'Nothing on the calendar yet', emptyText = 'Check back soon, or share something happening in town.' }: { events?: Event[]; loading?: boolean; error?: unknown; retry?: () => void; emptyTitle?: string; emptyText?: string }) {
  if (loading) return <div className="event-grid">{[1, 2, 3].map(n => <div className="paper" key={n}><div className="skeleton" style={{ width: 70, marginBottom: 16 }} /><div className="skeleton" style={{ height: 25, marginBottom: 12 }} /><div className="skeleton" /></div>)}</div>;
  if (error) return <LoadError error={error} retry={retry || (() => {})} />;
  if (!events?.length) return <Empty title={emptyTitle} text={emptyText} />;
  return <div className="event-grid">{events.map(event => <EventCard key={event.id} event={event} />)}</div>;
}

function HomePage() {
  const health = useHealthCheck();
  const [category, setCategory] = useState('');
  const [search, setSearch] = useState('');
  const [weekOf, setWeekOf] = useState(() => vancouverDateString(new Date()));
  const params = useMemo(() => {
    const monday = mondayFor(weekOf);
    const from = vancouverMidnight(monday);
    const to = vancouverMidnight(addCalendarDays(monday, 7));
    return { ...(category ? { category: category as EventCategoryType } : {}), ...(search.trim() ? { q: search.trim() } : {}), from: from.toISOString(), to: to.toISOString(), includeNotices: true };
  }, [category, search, weekOf]);
  const events = useListEvents(params);
  const week = useGetCalendarOverview({ weekOf });
  const notices = useListEvents({ category: EventCategory.Community_Notices, includeNotices: true });
  const days = week.data?.days || [];
  return <Shell><main className="page">
    <section className="hero reveal"><div className="landscape" aria-hidden="true"><div className="ridge back" /><div className="ridge" /><div className="ridge front" /></div><div className="hero-copy"><div className="eyebrow">Your town, in the know</div><h1>Good things<br />happen here.</h1><p>A shared calendar for Tumbler Ridge—local events, useful notices, and the people bringing us together.</p><Link className="btn light" href="/calendar">Explore the calendar <ArrowRight size={16} /></Link></div></section>
    <div className="section-heading" style={{ marginTop: 36 }}><div><div className="eyebrow">Around the community</div><h2>Coming up</h2></div><Link href="/calendar" className="btn secondary small">Full calendar <ArrowRight size={15} /></Link></div>
    <div className="filterbar" role="search"><label style={{ position: 'relative', flex: '1 1 220px' }}><Search size={17} style={{ position: 'absolute', left: 13, top: 13, color: '#69766f' }} /><input aria-label="Search events" placeholder="Search events and activities" value={search} onChange={e => setSearch(e.target.value)} data-testid="input-event-search" style={{ paddingLeft: 40, width: '100%' }} /></label><select aria-label="Filter by category" value={category} onChange={e => setCategory(e.target.value)} data-testid="select-event-category"><option value="">All community events</option>{categories.map(item => <option key={item} value={item}>{item}</option>)}</select></div>
    <div className="filterbar" aria-label="Weekly event overview">{days.map(day => <button key={day.date} className={`pill ${day.date === weekOf ? 'selected' : ''}`} onClick={() => setWeekOf(day.date)} data-testid={`button-weekday-${day.date}`}>{new Date(day.date + 'T12:00:00Z').toLocaleDateString('en-CA', { timeZone: communityTimeZone, weekday: 'short', day: 'numeric' })}<span style={{ opacity: .75 }}> · {day.eventCount}</span></button>)}{week.isLoading && <span className="hint">Loading week…</span>}{week.isError && <button className="pill" onClick={() => week.refetch()}>Week unavailable · retry</button>}</div>
    <EventList events={events.data} loading={events.isLoading} error={events.error} retry={() => events.refetch()} />
    <section className="section"><div className="section-heading"><div><div className="eyebrow">A note from around town</div><h2>Community notices</h2></div><Link className="btn secondary small" href="/notices">See notices</Link></div>
      {notices.isLoading ? <div className="skeleton" style={{ height: 100 }} /> : notices.error ? <LoadError error={notices.error} retry={() => notices.refetch()} /> : notices.data?.length ? notices.data.slice(0, 2).map(item => <Link key={item.id} href={`/events/${item.slug}`} style={{ textDecoration: 'none', color: 'inherit' }}><div className="notice-box" style={{ marginBottom: 12 }}><Megaphone size={22} color="#9a6a2e" /><div><h3>{item.title}{item.isDemo && <span className="tag" style={{ marginLeft: 9 }}>Demo</span>}</h3><p>{item.summary || item.description || 'Open this notice for details.'}</p><div className="event-meta">{dateFmt(item.startAt)}{item.location && ` · ${item.location}`}</div></div></div></Link>) : <Empty title="No current notices" text="When something needs sharing, you’ll find it here." />}
    </section>
    <section className="split section" style={{ paddingTop: 10 }}><div><div className="eyebrow">Have something to share?</div><h2 className="serif" style={{ fontSize: 40, fontWeight: 400, lineHeight: 1.05 }}>This calendar belongs to all of us.</h2><p style={{ color: '#58645f', lineHeight: 1.7, maxWidth: 510 }}>Community groups, families, clubs, and local services can suggest an event for review. You don’t need an account, and submitting an event never publishes it automatically.</p><Link href="/submit" className="btn">Share an event <ArrowRight size={16} /></Link></div><div className="paper"><div className="eyebrow">A little good news</div><h3 className="serif" style={{ fontSize: 28, fontWeight: 400, margin: '10px 0' }}>The week, in your inbox.</h3><p className="hint">Optional weekly digest and topic updates. You’ll confirm your address before anything starts.</p><SubscribeForm compact /></div></section>
    <div className="hint" style={{ textAlign: 'center', paddingBottom: 15 }} data-testid="status-service">{health.isError ? 'Calendar service status is unavailable.' : health.data?.status ? 'Community calendar service is available.' : ''}</div>
  </main></Shell>;
}

function CalendarPage() {
  const [view, setView] = useState<'month' | 'week' | 'upcoming'>('upcoming');
  const [anchor, setAnchor] = useState(new Date());
  const anchorDay = vancouverDateString(anchor);
  const anchorDate = new Date(`${anchorDay}T12:00:00Z`);
  const range = useMemo(() => {
    if (view === 'week') {
      const monday = mondayFor(anchorDay);
      const start = vancouverMidnight(monday);
      const end = vancouverMidnight(addCalendarDays(monday, 7));
      return { from: start.toISOString(), to: end.toISOString() };
    }
    const year = anchorDate.getUTCFullYear();
    const month = anchorDate.getUTCMonth();
    const firstOfMonth = new Date(Date.UTC(year, month, 1, 12)).toISOString().slice(0, 10);
    const firstOfNextMonth = new Date(Date.UTC(year, month + 1, 1, 12)).toISOString().slice(0, 10);
    const start = vancouverMidnight(firstOfMonth);
    const end = vancouverMidnight(firstOfNextMonth);
    return { from: start.toISOString(), to: end.toISOString() };
  }, [anchorDay, anchorDate, view]);
  const events = useListEvents(view === 'upcoming' ? { includeNotices: true } : { ...range, includeNotices: true });
  const week = useGetCalendarOverview({ weekOf: anchorDay });
  const changePeriod = (delta: number) => {
    if (view === 'week') {
      const next = new Date(anchorDate);
      next.setUTCDate(next.getUTCDate() + delta * 7);
      setAnchor(next);
    } else {
      setAnchor(new Date(Date.UTC(anchorDate.getUTCFullYear(), anchorDate.getUTCMonth() + delta, 15, 12)));
    }
  };
  const monthGrid = useMemo(() => {
    const first = new Date(Date.UTC(anchorDate.getUTCFullYear(), anchorDate.getUTCMonth(), 1, 12));
    const start = new Date(first);
    start.setUTCDate(first.getUTCDate() - first.getUTCDay());
    return Array.from({ length: 42 }, (_, i) => { const d = new Date(start); d.setUTCDate(start.getUTCDate() + i); return d; });
  }, [anchorDate]);
  const monthLabel = new Intl.DateTimeFormat('en-CA', { timeZone: communityTimeZone, month: 'long', year: 'numeric' }).format(anchorDate);
  return <Shell><main className="page section calendar-page"><div className="eyebrow">Make a little room for it</div><div className="section-heading"><h1 className="serif" style={{ fontSize: 54, fontWeight: 400, margin: '10px 0 0' }}>Community calendar</h1><Link href="/submit" className="btn small">Add an event <ArrowRight size={15} /></Link></div>
    <div className="tabs" aria-label="Calendar view">{(['upcoming', 'week', 'month'] as const).map(item => <button key={item} className={view === item ? 'selected' : ''} onClick={() => setView(item)} data-testid={`tab-calendar-${item}`}>{item === 'upcoming' ? 'Upcoming' : item[0].toUpperCase() + item.slice(1)}</button>)}</div>
    <div className="section-heading"><div><h2 style={{ margin: 0 }}>{view === 'week' ? week.data ? `${dateOnlyFmt(week.data.weekStart)} – ${dateOnlyFmt(week.data.weekEnd)}` : 'Week view' : view === 'upcoming' ? 'What’s coming up' : monthLabel}</h2><p className="hint" style={{ margin: '8px 0 0' }}>All times shown in Tumbler Ridge time (Pacific).</p></div>{view !== 'upcoming' && <div style={{ display: 'flex', gap: 8 }}>{view === 'week' && <button className="btn secondary small" onClick={() => window.print()} aria-label="Print weekly schedule">Print week</button>}<button className="btn secondary small" onClick={() => changePeriod(-1)} aria-label={view === 'week' ? 'Previous week' : 'Previous month'}><ChevronLeft size={17} /></button><button className="btn secondary small" onClick={() => changePeriod(1)} aria-label={view === 'week' ? 'Next week' : 'Next month'}><ChevronRight size={17} /></button></div>}</div>
    {view === 'month' && !events.isLoading && !events.error && <div className="calendar-grid">{['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => <div key={d} className="calendar-cell" style={{ minHeight: 35, background: '#e8e5dd', fontWeight: 700 }}>{d}</div>)}{monthGrid.map((d, i) => { const sameMonth = d.getUTCMonth() === anchorDate.getUTCMonth(); const dayEvents = events.data?.filter(event => event.startAt && vancouverDateString(event.startAt) === vancouverDateString(d)) || []; return <div key={i} className="calendar-cell" style={{ opacity: sameMonth ? 1 : .48 }}><strong>{d.getUTCDate()}</strong>{dayEvents.map(event => <Link key={event.id} href={`/events/${event.slug}`}>{event.title}</Link>)}</div>; })}</div>}
    {view === 'week' && week.data && <div className="filterbar">{week.data.days.map(day => <button className="pill" key={day.date} onClick={() => setAnchor(new Date(day.date + 'T12:00:00Z'))}>{new Date(day.date + 'T12:00:00Z').toLocaleDateString('en-CA', { timeZone: communityTimeZone, weekday: 'long', month: 'short', day: 'numeric' })} · {day.eventCount}</button>)}</div>}
    {(view === 'upcoming' || view === 'week') && <EventList events={events.data} loading={events.isLoading} error={events.error} retry={() => events.refetch()} />}
    {view === 'month' && events.error && <LoadError error={events.error} retry={() => events.refetch()} />}
    {view === 'month' && !events.isLoading && !events.error && !events.data?.length && <Empty title="A clear month" text="No published events are listed yet." />}
  </main></Shell>;
}

function EventDetailPage() {
  const { slug = '' } = useParams<{ slug: string }>();
  const query = useGetEvent(slug, { query: { enabled: !!slug, queryKey: getGetEventQueryKey(slug) } });
  const event = query.data;
  if (query.isLoading) return <Shell><Loading /></Shell>;
  if (query.error || !event) return <Shell><main className="page section"><Link href="/calendar" className="hint">← Back to calendar</Link><Empty title="We couldn’t find that event" text="It may have changed, or its link may be out of date." /><LoadError error={query.error} retry={() => query.refetch()} /></main></Shell>;
  return <Shell><main className="page section"><Link href="/calendar" className="hint">← Back to calendar</Link><article style={{ maxWidth: 820, margin: '34px auto' }}><span className="tag">{event.category}</span>{event.isDemo && <span className="tag" style={{ marginLeft: 8, background: '#f0e4cc' }}>Demonstration data</span>}<h1 className="serif" style={{ fontSize: 'clamp(42px,7vw,72px)', fontWeight: 400, lineHeight: 1, margin: '18px 0' }}>{event.title}</h1>{event.summary && <p style={{ fontSize: 20, lineHeight: 1.6, color: '#53615a' }}>{event.summary}</p>}<div className="paper" style={{ display: 'flex', flexWrap: 'wrap', gap: 20, margin: '28px 0' }}><div><div className="eyebrow">When</div><p>{dateFmt(event.startAt)}{event.endAt && ` – ${dateFmt(event.endAt, { weekday: undefined })}`}<br />{event.allDay ? 'All day' : timeFmt(event.startAt)}{event.endAt && !event.allDay ? ` – ${timeFmt(event.endAt)}` : ''}</p></div>{event.location && <div><div className="eyebrow">Where</div><p><MapPin size={15} style={{ verticalAlign: 'middle' }} /> {event.location}</p></div>}{event.organizer && <div><div className="eyebrow">Organized by</div><p>{event.organizer}</p></div>}{event.cost && <div><div className="eyebrow">Cost</div><p>{event.cost}</p></div>}</div><div className="prose" style={{ whiteSpace: 'pre-wrap', lineHeight: 1.8 }}>{event.description || event.summary || 'The organizer has not added more details yet.'}</div>{event.tags?.length ? <p>{event.tags.map(tag => <span className="tag" style={{ marginRight: 6 }} key={tag}>{tag}</span>)}</p> : null}<div className="filterbar" style={{ marginTop: 30 }}>{event.registrationUrl && <a className="btn" href={event.registrationUrl} target="_blank" rel="noreferrer">Registration details <ExternalLink size={15} /></a>}{event.sourceUrl && <a className="btn secondary" href={event.sourceUrl} target="_blank" rel="noreferrer">{event.sourceName ? `From ${event.sourceName}` : 'Organizer’s source'} <ExternalLink size={15} /></a>}{event.contact && <a className="btn secondary" href={event.contact.includes('@') ? `mailto:${event.contact}` : undefined}>{event.contact}</a>}<button className="btn secondary" onClick={() => navigator.clipboard?.writeText(window.location.href)}>Copy event link</button></div>{event.lastVerifiedAt && <p className="hint">Details last checked {dateFmt(event.lastVerifiedAt)}.</p>}</article></main></Shell>;
}

function NoticesPage() {
  const q = useListEvents({ category: EventCategory.Community_Notices, includeNotices: true });
  return <Shell><main className="page section"><div className="eyebrow">Useful things to know</div><h1 className="serif" style={{ fontSize: 58, fontWeight: 400, margin: '8px 0' }}>Around town</h1><p style={{ maxWidth: 560, color: '#58645f', lineHeight: 1.7, marginBottom: 28 }}>Community notices shared by local organizations and services. For urgent or emergency information, use official channels.</p><EventList events={q.data} loading={q.isLoading} error={q.error} retry={() => q.refetch()} emptyTitle="No current notices" emptyText="There are no published community notices right now." /></main></Shell>;
}

function SubmitPage() {
  const create = useCreateSubmission(); const requestUpload = useRequestUploadUrl(); const complete = useCompleteUpload();
  const [files, setFiles] = useState<File[]>([]); const [claims, setClaims] = useState<UploadClaim[]>([]);
  const [receipt, setReceipt] = useState<{ reference: string; message: string; duplicatePotential: boolean } | null>(null);
  const [uploading, setUploading] = useState(false); const [failure, setFailure] = useState('');
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault(); setFailure(''); setReceipt(null);
    const formElement = e.currentTarget;
    const form = new FormData(formElement);
    try {
      setUploading(true);
      const uploaded: UploadClaim[] = [];
      for (const file of files) {
        const contentType = file.type as 'image/jpeg' | 'image/png' | 'image/webp' | 'application/pdf';
        const urlResult = await requestUpload.mutateAsync({ data: { name: file.name, size: file.size, contentType, website: String(form.get('website') || '') } });
        const put = await fetch(urlResult.uploadURL, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file });
        if (!put.ok) throw new Error(`Could not upload ${file.name}. Please try again.`);
        const completeResult = await complete.mutateAsync({ data: { uploadId: urlResult.uploadId, claimToken: urlResult.claimToken } });
        uploaded.push({ uploadId: completeResult.uploadId, claimToken: completeResult.claimToken });
      }
      setClaims(uploaded);
      const rawStart = String(form.get('startAt') || '');
      const rawEnd = String(form.get('endAt') || '');
      const details = [String(form.get('details') || ''), String(form.get('copiedText') || '') ? `Copied event text:\n${String(form.get('copiedText'))}` : ''].filter(Boolean).join('\n\n');
      const selectedCategory = String(form.get('category') || '');
      const result = await create.mutateAsync({ data: {
        title: String(form.get('title') || '') || null,
        ...(selectedCategory ? { category: selectedCategory as EventCategoryType } : {}),
        startAt: rawStart ? fromLocalInput(rawStart) : null,
        endAt: rawEnd ? fromLocalInput(rawEnd) : null,
        allDay: form.get('allDay') === 'on',
        location: String(form.get('location') || '') || null,
        details: details || null,
        sourceUrl: String(form.get('sourceUrl') || '') || null,
        organizer: String(form.get('organizer') || '') || null,
        followUpEmail: String(form.get('followUpEmail') || '') || null,
        attachmentClaims: uploaded,
        website: String(form.get('website') || ''),
      } });
      setReceipt({ reference: result.reference, message: result.message, duplicatePotential: result.duplicatePotential });
      formElement.reset(); setFiles([]); setClaims([]);
    } catch (err) { setFailure(errorText(err)); }
    finally { setUploading(false); }
  };
  const selectFiles = (list: FileList | null) => {
    setFailure('');
    const chosen = Array.from(list || []);
    const valid = chosen.filter(file => ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(file.type) && file.size <= 8 * 1024 * 1024);
    if (chosen.length > 3) { setFiles([]); setFailure('Please choose no more than three flyers.'); }
    else if (valid.length !== chosen.length) { setFiles([]); setFailure('Flyers must be JPG, PNG, WebP or PDF, no larger than 8 MB each.'); }
    else setFiles(valid);
  };
  return <Shell><main className="page section"><div className="eyebrow">No account required</div><h1 className="serif" style={{ fontSize: 58, fontWeight: 400, margin: '8px 0 12px' }}>Share what’s happening.</h1><p style={{ maxWidth: 680, color: '#58645f', lineHeight: 1.7 }}>Send us the details and our local calendar team will review them. A submission is not published automatically, and uploading a flyer does not publish it either.</p>
    <div className="split" style={{ marginTop: 30 }}><form className="paper form-grid" onSubmit={submit}>
      <div className="field full"><label htmlFor="submission-title">Event or notice title <span className="hint">(optional if you share a flyer, source link, or copied text)</span></label><input id="submission-title" name="title" maxLength={160} placeholder="What should we call it?" data-testid="input-submission-title" /></div>
      <div className="field"><label htmlFor="submission-category">Category <span className="hint">(optional)</span></label><select id="submission-category" name="category" defaultValue="" data-testid="select-submission-category"><option value="">Choose later</option>{categories.map(item => <option key={item} value={item}>{item}</option>)}</select></div>
      <div className="field"><label htmlFor="submission-organizer">Organizing group or person</label><input id="submission-organizer" name="organizer" maxLength={160} placeholder="Optional" /></div>
      <div className="field"><label htmlFor="submission-start">Start date and time</label><input id="submission-start" name="startAt" type="datetime-local" /></div>
      <div className="field"><label htmlFor="submission-end">End date and time</label><input id="submission-end" name="endAt" type="datetime-local" /></div>
      <div className="field full"><label style={{ display: 'flex', alignItems: 'center', gap: 9 }}><input type="checkbox" name="allDay" style={{ width: 17, height: 17 }} /> This is an all-day event</label></div>
      <div className="field full"><label htmlFor="submission-location">Location</label><input id="submission-location" name="location" maxLength={200} placeholder="Venue or meeting place" /></div>
      <div className="field full"><label htmlFor="submission-details">Details</label><textarea id="submission-details" name="details" maxLength={2500} placeholder="Include anything residents should know." /></div>
      <div className="field full"><label htmlFor="submission-copied-text">Copied text from the event source</label><textarea id="submission-copied-text" name="copiedText" maxLength={2400} placeholder="Paste the original listing text here, if useful." /><span className="hint">Copied text is kept with your details for the reviewer. Do not include private information.</span></div>
      <div className="field"><label htmlFor="submission-source">Source URL</label><input id="submission-source" name="sourceUrl" type="url" placeholder="https://" /></div>
      <div className="field"><label htmlFor="submission-email">Email for follow-up <span className="hint">(optional)</span></label><input id="submission-email" name="followUpEmail" type="email" maxLength={254} placeholder="you@example.ca" /></div>
      <div className="field full"><label htmlFor="submission-flyers">Flyers or supporting files</label><input id="submission-flyers" type="file" accept=".jpg,.jpeg,.png,.webp,.pdf,image/jpeg,image/png,image/webp,application/pdf" multiple onChange={e => selectFiles(e.target.files)} data-testid="input-submission-files" /><span className="hint">Up to 3 files. JPG, PNG, WebP or PDF, max 8 MB each. Files are attached privately for review.</span>{files.length > 0 && <div>{files.map(file => <div key={file.name} className="hint"><FileText size={14} style={{ verticalAlign: 'middle' }} /> {file.name} · {(file.size / 1024 / 1024).toFixed(1)} MB</div>)}</div>}</div>
      <div aria-hidden="true" style={{ position: 'absolute', left: '-10000px' }}><label htmlFor="website-check">Website</label><input id="website-check" name="website" tabIndex={-1} autoComplete="off" /></div>
      {failure && <div className="error-message field full" role="alert">{failure}</div>}{receipt && <div className="status-message field full" role="status"><b>Thanks for letting us know.</b><br />{receipt.message}<br /><span className="mono">Reference: {receipt.reference}</span>{receipt.duplicatePotential && <p>We noticed this may be a duplicate; the calendar team will check before publishing.</p>}</div>}
      <div className="form-actions"><button className="btn" type="submit" disabled={uploading || create.isPending}>{uploading ? <><Upload size={16} /> Uploading files…</> : create.isPending ? 'Sending…' : <>Send for review <ArrowRight size={16} /></>}</button><span className="hint">Your contact information is only for follow-up.</span></div>
    </form><aside><div className="notice-box"><ShieldCheck size={22} /><div><h3>Reviewed by a person</h3><p>Every suggestion is reviewed before it appears publicly. Attachments remain private and do not create an event on their own.</p></div></div><div className="paper" style={{ marginTop: 16 }}><div className="eyebrow">A helpful checklist</div><ul style={{ lineHeight: 1.9, paddingLeft: 20, color: '#53615a' }}><li>Use the organizer’s official date and time.</li><li>Include a public source link when you have one.</li><li>Tell us whether there is a cost or registration.</li></ul></div></aside></div>
  </main></Shell>;
}

function SubscribeForm({ compact = false }: { compact?: boolean }) {
  const create = useCreateSubscription(); const [message, setMessage] = useState(''); const [error, setError] = useState('');
  const submit = async (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); setError(''); setMessage(''); const formElement = e.currentTarget; const data = new FormData(formElement); try { const result = await create.mutateAsync({ data: { email: String(data.get('email')), weeklyDigest: data.get('weeklyDigest') === 'on', sportsRecreation: data.get('sportsRecreation') === 'on', familyYouth: data.get('familyYouth') === 'on', consent: true } }); setMessage(result.message); if (result.accepted) formElement.reset(); } catch (err) { setError(errorText(err)); } };
  return <form onSubmit={submit} className="form-grid" style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 12 }}><div className="field"><label htmlFor="updates-email">Email address</label><input id="updates-email" name="email" type="email" required maxLength={254} placeholder="you@example.ca" data-testid="input-updates-email" /></div><label className="hint"><input name="weeklyDigest" type="checkbox" defaultChecked /> Weekly digest <span className="hint">General community events, notices, and local services.</span></label><label className="hint"><input name="sportsRecreation" type="checkbox" /> Sports & recreation <span className="hint">Adds sports and recreation listings to the weekly digest.</span></label><label className="hint"><input name="familyYouth" type="checkbox" /> Families & youth <span className="hint">Adds family activities and youth programs to the weekly digest.</span></label><label className="hint"><input name="consent" type="checkbox" required /> I agree to receive the selected calendar emails. I can unsubscribe at any time.</label>{error && <div className="error-message" role="alert">{error}</div>}{message && <div className="status-message" role="status">{message}</div>}<button className={`btn ${compact ? 'small' : ''}`} disabled={create.isPending}>{create.isPending ? 'Sending request…' : 'Request email updates'} <ArrowRight size={15} /></button></form>;
}
function UpdatesPage() {
  return <Shell><main className="page section"><div className="eyebrow">Optional, and easy to manage</div><h1 className="serif" style={{ fontSize: 58, fontWeight: 400, margin: '8px 0 14px' }}>A useful note, once a week.</h1><p style={{ maxWidth: 650, color: '#58645f', lineHeight: 1.7 }}>Choose the updates you care about. We’ll send a confirmation request first; you won’t be subscribed until you confirm your email.</p><div className="split" style={{ marginTop: 30 }}><div className="paper"><SubscribeForm /></div><div><div className="notice-box"><Mail size={22} /><div><h3>Your inbox stays yours</h3><p>Every confirmation link is private and can be used to update your preferences or unsubscribe. Email availability depends on delivery configuration.</p></div></div><p className="hint" style={{ marginTop: 16 }}>Already subscribed? Use the secure management link included in your calendar email. It opens your preference and unsubscribe controls.</p></div></div></main></Shell>;
}

function SubscriptionActionPage({ action }: { action: 'confirm' | 'unsubscribe' | 'manage' }) {
  const storageKey = `community-calendar:${window.location.pathname}:token`;
  const [token] = useState(() => {
    let urlToken = '';
    try {
      urlToken = decodeURIComponent(window.location.hash.slice(1)) || new URLSearchParams(window.location.search).get('token') || '';
      const saved = window.sessionStorage.getItem(storageKey) || '';
      const value = urlToken || saved;
      if (urlToken) window.sessionStorage.setItem(storageKey, urlToken);
      if (window.location.hash || window.location.search) window.history.replaceState(window.history.state, document.title, window.location.pathname);
      return value;
    } catch {
      return urlToken;
    }
  });
  const clearPrivateToken = () => { try { window.sessionStorage.removeItem(storageKey); } catch { /* Session storage may be disabled. */ } };
  const confirm = useConfirmSubscription(); const getPrefs = useGetSubscriptionPreferences(); const update = useUpdateSubscriptionPreferences(); const unsubscribe = useUnsubscribe();
  const [preferences, setPreferences] = useState({ weeklyDigest: true, sportsRecreation: false, familyYouth: false }); const [message, setMessage] = useState(''); const [error, setError] = useState('');
  const loadPrefs = async () => { if (!token) { setError('This management link is missing its private token. Please open the original email link.'); return; } try { const value = await getPrefs.mutateAsync({ data: { token } }); setPreferences({ weeklyDigest: value.weeklyDigest, sportsRecreation: value.sportsRecreation, familyYouth: value.familyYouth }); setMessage(value.unsubscribed ? 'This subscription is currently unsubscribed.' : value.confirmed ? 'Your email is confirmed. You can update your choices below.' : 'This email has not been confirmed yet.'); } catch (err) { setError(errorText(err)); } };
  const doConfirm = async () => { try { const result = await confirm.mutateAsync({ data: { token } }); setMessage(result.message); if (!result.success) setError(result.message); else clearPrivateToken(); } catch (err) { setError(errorText(err)); } };
  const doUnsubscribe = async () => { try { const result = await unsubscribe.mutateAsync({ data: { token } }); setMessage(result.message); if (!result.success) setError(result.message); else clearPrivateToken(); } catch (err) { setError(errorText(err)); } };
  const savePrefs = async (e: FormEvent) => { e.preventDefault(); try { const result = await update.mutateAsync({ data: { token, ...preferences } }); setMessage(result.message); } catch (err) { setError(errorText(err)); } };
  return <Shell><main className="page section" style={{ maxWidth: 760 }}><div className="eyebrow">Calendar email settings</div><h1 className="serif" style={{ fontSize: 52, fontWeight: 400, margin: '8px 0 24px' }}>{action === 'confirm' ? 'Confirm your email' : action === 'unsubscribe' ? 'Unsubscribe' : 'Manage preferences'}</h1>{!token && <div className="error-message">A private management token is required. Please use the secure link from your calendar email.</div>}{action === 'confirm' && <div className="paper"><p>Confirm your request to receive the community calendar by email.</p><button className="btn" onClick={doConfirm} disabled={!token || confirm.isPending}>{confirm.isPending ? 'Confirming…' : 'Confirm subscription'}</button></div>}{action === 'unsubscribe' && <div className="paper"><p>Stop future calendar emails for this address. You can subscribe again at any time.</p><button className="btn" onClick={doUnsubscribe} disabled={!token || unsubscribe.isPending}>{unsubscribe.isPending ? 'Unsubscribing…' : 'Unsubscribe'}</button></div>}{action === 'manage' && <div className="paper"><button className="btn secondary small" onClick={loadPrefs} disabled={!token || getPrefs.isPending}>{getPrefs.isPending ? 'Loading preferences…' : 'Load current preferences'}</button><form onSubmit={savePrefs} style={{ marginTop: 20, display: 'grid', gap: 13 }}>{[['weeklyDigest', 'Weekly digest'], ['sportsRecreation', 'Sports & recreation'], ['familyYouth', 'Families & youth']].map(([key, label]) => <label className="hint" key={key}><input type="checkbox" checked={preferences[key as keyof typeof preferences]} onChange={e => setPreferences(p => ({ ...p, [key]: e.target.checked }))} /> {label}</label>)}<button className="btn" disabled={!token || update.isPending}>{update.isPending ? 'Saving…' : 'Save preferences'}</button></form><button className="btn secondary small" style={{ marginTop: 12 }} onClick={doUnsubscribe} disabled={!token || unsubscribe.isPending}>Unsubscribe instead</button></div>}{error && <div className="error-message" role="alert">{error}</div>}{message && <div className="status-message" role="status">{message}</div>}</main></Shell>;
}

function EventEditor({ initial, onDone }: { initial?: Event; onDone: () => void }) {
  const create = useCreateEvent(); const update = useUpdateEvent(); const qc = useQueryClient(); const [error, setError] = useState('');
  const mutation = initial ? update : create;
  const submit = async (e: FormEvent<HTMLFormElement>) => { e.preventDefault(); setError(''); const f = new FormData(e.currentTarget);
    const payload: EventInput = { title: String(f.get('title')), summary: String(f.get('summary') || '') || null, description: String(f.get('description') || '') || null, category: String(f.get('category')) as EventCategoryType, startAt: fromLocalInput(String(f.get('startAt'))), endAt: String(f.get('endAt') || '') ? fromLocalInput(String(f.get('endAt'))) : null, allDay: f.get('allDay') === 'on', location: String(f.get('location') || '') || null, sourceUrl: String(f.get('sourceUrl') || '') || null, organizer: String(f.get('organizer') || '') || null, contact: String(f.get('contact') || '') || null, cost: String(f.get('cost') || '') || null, registrationUrl: String(f.get('registrationUrl') || '') || null, tags: String(f.get('tags') || '').split(',').map(x => x.trim()).filter(Boolean), status: String(f.get('status')) as Event['status'], isDemo: f.get('isDemo') === 'on' };
    try { if (initial) await update.mutateAsync({ id: initial.id, data: payload as EventUpdate }); else await create.mutateAsync({ data: payload }); await Promise.all([qc.invalidateQueries({ queryKey: getListAdminEventsQueryKey() }), qc.invalidateQueries({ queryKey: getListEventsQueryKey() }), qc.invalidateQueries({ queryKey: getGetCalendarOverviewQueryKey() }), ...(initial ? [qc.invalidateQueries({ queryKey: getGetEventQueryKey(initial.slug) })] : [])]); onDone(); } catch (err) { setError(errorText(err)); }
  };
  return <form onSubmit={submit} className="paper form-grid" style={{ margin: '18px 0' }}><div className="field full"><label>Title</label><input name="title" defaultValue={initial?.title} required minLength={3} maxLength={160} /></div><div className="field"><label>Category</label><select name="category" defaultValue={initial?.category || EventCategory.Community_Events}>{categories.map(c => <option value={c} key={c}>{c}</option>)}</select></div><div className="field"><label>Status</label><select name="status" defaultValue={initial?.status || EventStatus.draft}>{Object.values(EventStatus).map(s => <option key={s} value={s}>{s}</option>)}</select></div><div className="field"><label>Start</label><input name="startAt" type="datetime-local" defaultValue={localInputDate(initial?.startAt)} required /></div><div className="field"><label>End</label><input name="endAt" type="datetime-local" defaultValue={localInputDate(initial?.endAt)} /></div><div className="field full"><label>Summary</label><input name="summary" defaultValue={initial?.summary || ''} maxLength={280} /></div><div className="field full"><label>Description</label><textarea name="description" defaultValue={initial?.description || ''} maxLength={5000} /></div><div className="field"><label>Location</label><input name="location" defaultValue={initial?.location || ''} /></div><div className="field"><label>Organizer</label><input name="organizer" defaultValue={initial?.organizer || ''} /></div><div className="field"><label>Contact</label><input name="contact" defaultValue={initial?.contact || ''} /></div><div className="field"><label>Cost</label><input name="cost" defaultValue={initial?.cost || ''} /></div><div className="field"><label>Source URL</label><input name="sourceUrl" type="url" defaultValue={initial?.sourceUrl || ''} /></div><div className="field"><label>Registration URL</label><input name="registrationUrl" type="url" defaultValue={initial?.registrationUrl || ''} /></div><div className="field full"><label>Tags, comma separated</label><input name="tags" defaultValue={initial?.tags?.join(', ')} /></div><div className="field full"><label><input name="allDay" type="checkbox" defaultChecked={initial?.allDay} /> All day</label><label><input name="isDemo" type="checkbox" defaultChecked={initial?.isDemo} /> Demonstration data (clearly labeled publicly)</label></div>{error && <div className="error-message field full">{error}</div>}<div className="form-actions"><button className="btn" disabled={mutation.isPending}>{mutation.isPending ? 'Saving…' : initial ? 'Save changes' : 'Create event'}</button><button type="button" className="btn secondary" onClick={onDone}>Cancel</button></div></form>;
}

type SubmissionRow = ListSubmissionsQueryResult[number];
const normalizationLabels: Record<string, string> = {
  not_run: 'Normalization did not run. Review the original submission and its files.',
  normalized: 'Draft ready with no review flags. This is not verification: a person must still check it.',
  needs_review: 'Draft ready. Resolve every review flag before publishing.',
  invalid_input: 'Normalization could not read this submission. Review the original submission.',
  failed: 'Normalization failed. Review the original submission.',
  cancelled: 'Normalization was cancelled. Review the original submission.',
};
function NormalizationPanel({ normalization }: { normalization: SubmissionRow['normalization'] }) {
  const draft = normalization.draft;
  const rows: Array<[string, string | null]> = draft ? [
    ['Title', draft.title],
    ['Category', draft.category],
    ['Starts', draft.startAt ? `${dateFmt(draft.startAt)} · ${timeFmt(draft.startAt)}` : null],
    ['Ends', draft.endAt ? `${dateFmt(draft.endAt)} · ${timeFmt(draft.endAt)}` : null],
    ['All day', draft.allDay ? 'Yes' : 'No'],
    ['Location', draft.location],
    ['Organizer', draft.organizer],
    ['Public contact', draft.contact],
    ['Cost', draft.cost],
    ['Registration', draft.registrationUrl],
    ['Source', draft.sourceUrl],
    ['Summary', draft.summary],
    ['Tags', draft.tags.length ? draft.tags.join(', ') : null],
  ] : [];
  return <section className="paper" style={{ marginTop: 14, background: '#fbfaf6' }} aria-label="Normalizer suggestion">
    <div className="eyebrow">Normalizer suggestion{normalization.version ? ` · ${normalization.version}` : ''}</div>
    <p className="hint" style={{ marginTop: 4 }}>{normalization.status} · {normalizationLabels[normalization.status] || 'Normalization status is unavailable.'}{normalization.errorCode ? ` · error ${normalization.errorCode}` : ''}{normalization.referenceTime ? ` · reference ${dateFmt(normalization.referenceTime)}` : ''}</p>
    {draft ? <>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 10, marginTop: 10 }}>
        {rows.map(([label, value]) => <div key={label}><div className="hint">{label}</div><div style={{ whiteSpace: 'pre-wrap' }}>{value || 'Not supplied'}</div></div>)}
      </div>
      <div style={{ marginTop: 12 }}><div className="hint">Review flags ({draft.reviewFlags.length})</div>{draft.reviewFlags.length > 0 ? <ul style={{ margin: '6px 0', paddingLeft: 20 }}>{draft.reviewFlags.map(flag => <li key={flag.code}><b className="mono">{flag.code}</b> — {flag.message}</li>)}</ul> : <p className="hint">No review flags. A person must still confirm every detail against the source.</p>}</div>
      {draft.unresolvedQuestions.length > 0 && <div style={{ marginTop: 8 }}><div className="hint">Questions for the reviewer</div><ul style={{ margin: '6px 0', paddingLeft: 20 }}>{draft.unresolvedQuestions.map(question => <li key={question}>{question}</li>)}</ul></div>}
      {draft.changedFields.length > 0 && <p className="hint" style={{ marginTop: 8 }}>Changed by the normalizer: {draft.changedFields.join(', ')}</p>}
    </> : <p className="hint" style={{ marginTop: 8 }}>No draft is stored. Work from the original submission and the private attachments.</p>}
  </section>;
}
function SubmissionApprovalEditor({ submission, onCancel, onApproved }: { submission: SubmissionRow; onCancel: () => void; onApproved: () => void }) {
  const approve = useApproveSubmission();
  const [error, setError] = useState('');
  // When a draft exists the form starts from it, and a null draft value stays
  // empty: nothing is inferred. Without a draft the previous behaviour (raw
  // submission values) is kept so legacy rows are still reviewable.
  const draft = submission.normalization?.draft ?? null;
  const initial = draft ? {
    title: draft.title ?? '', category: draft.category, startAt: draft.startAt, endAt: draft.endAt,
    allDay: draft.allDay, location: draft.location ?? '', organizer: draft.organizer ?? '',
    summary: draft.summary ?? '', description: draft.description ?? '', contact: draft.contact ?? '',
    cost: draft.cost ?? '', sourceUrl: draft.sourceUrl ?? '', registrationUrl: draft.registrationUrl ?? '',
    tags: draft.tags.join(', '),
  } : {
    title: submission.title ?? '', category: submission.category || EventCategory.Community_Events,
    startAt: submission.startAt ?? null, endAt: submission.endAt ?? null, allDay: submission.allDay ?? false,
    location: submission.location ?? '', organizer: submission.organizer ?? '', summary: '',
    description: submission.details ?? '', contact: '', cost: '',
    sourceUrl: submission.sourceUrl ?? '', registrationUrl: '', tags: '',
  };
  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError('');
    const form = new FormData(e.currentTarget);
    const startAt = String(form.get('startAt') || '');
    if (!startAt) {
      setError('Add a confirmed start date and time before publishing.');
      return;
    }
    try {
      await approve.mutateAsync({
        id: submission.id,
        data: {
          title: String(form.get('title') || '').trim(),
          summary: String(form.get('summary') || '').trim() || null,
          description: String(form.get('description') || '').trim() || null,
          category: String(form.get('category')) as EventCategoryType,
          startAt: fromLocalInput(startAt),
          endAt: String(form.get('endAt') || '') ? fromLocalInput(String(form.get('endAt'))) : null,
          allDay: form.get('allDay') === 'on',
          location: String(form.get('location') || '').trim() || null,
          sourceUrl: String(form.get('sourceUrl') || '').trim() || null,
          organizer: String(form.get('organizer') || '').trim() || null,
          contact: String(form.get('contact') || '').trim() || null,
          cost: String(form.get('cost') || '').trim() || null,
          registrationUrl: String(form.get('registrationUrl') || '').trim() || null,
          tags: String(form.get('tags') || '').split(',').map(tag => tag.trim()).filter(Boolean).slice(0, 10).map(tag => tag.slice(0, 40)),
        },
      });
      onApproved();
    } catch (err) {
      setError(errorText(err));
    }
  };
  return <form onSubmit={submit} className="paper form-grid" style={{ marginTop: 14 }}>
    <div className="section-heading field full" style={{ marginBottom: 0 }}><div><h3>Review and publish event</h3><p className="hint">{draft ? 'Prefilled from the normalizer suggestion where it supplied a value; empty fields were not inferred. Confirm every detail against the source before publishing.' : 'Confirm every detail against the source before publishing.'}</p></div></div>
    <div className="field full"><label>Public event title</label><input name="title" defaultValue={initial.title} required minLength={3} maxLength={160} /></div>
    <div className="field"><label>Category</label><select name="category" defaultValue={initial.category}>{categories.map(category => <option key={category} value={category}>{category}</option>)}</select></div>
    <div className="field"><label>Start date and time</label><input name="startAt" type="datetime-local" defaultValue={localInputDate(initial.startAt)} required /></div>
    <div className="field"><label>End date and time</label><input name="endAt" type="datetime-local" defaultValue={localInputDate(initial.endAt)} /></div>
    <div className="field full"><label><input name="allDay" type="checkbox" defaultChecked={initial.allDay} /> All-day event</label></div>
    <div className="field"><label>Location</label><input name="location" defaultValue={initial.location} /></div>
    <div className="field"><label>Organizer</label><input name="organizer" defaultValue={initial.organizer} /></div>
    <div className="field full"><label>Public summary</label><input name="summary" defaultValue={initial.summary} maxLength={280} placeholder="Short description for the calendar" /></div>
    <div className="field full"><label>Public description</label><textarea name="description" defaultValue={initial.description} maxLength={5000} /></div>
    <div className="field"><label>Public organizer contact</label><input name="contact" defaultValue={initial.contact} placeholder="Only include a public contact" /></div>
    <div className="field"><label>Cost</label><input name="cost" defaultValue={initial.cost} /></div>
    <div className="field"><label>Source URL</label><input name="sourceUrl" type="url" defaultValue={initial.sourceUrl} /></div>
    <div className="field"><label>Registration URL</label><input name="registrationUrl" type="url" defaultValue={initial.registrationUrl} /></div>
    <div className="field full"><label>Tags, comma separated</label><input name="tags" defaultValue={initial.tags} /></div>
    {error && <div className="error-message field full" role="alert">{error}</div>}
    <div className="form-actions"><button className="btn" disabled={approve.isPending}>{approve.isPending ? 'Publishing…' : 'Approve and publish'}</button><button type="button" className="btn secondary" onClick={onCancel}>Cancel</button></div>
  </form>;
}

function AdminPage() {
  const status = useGetAdminStatus({ query: { queryKey: getGetAdminStatusQueryKey(), retry: false } });
  const { isSignedIn } = useUser();
  const { signOut } = useClerk();
  const [tab, setTab] = useState<'events' | 'submissions' | 'delivery'>('events');
  if (status.isLoading) return <Shell><Loading label="Checking administrator access" /></Shell>;
  if (status.error) return <Shell><main className="page section"><div className="eyebrow">Organizer workspace</div><h1 className="serif" style={{ fontSize: 52, fontWeight: 400 }}>Administrator access</h1><div className="error-message">We couldn’t check administrator access. {errorText(status.error)}</div><Link className="btn" href="/sign-in">Sign in</Link></main></Shell>;
  if (!status.data?.isAdmin) return <Shell><main className="page section" style={{ maxWidth: 720 }}><div className="eyebrow">For calendar organizers</div><h1 className="serif" style={{ fontSize: 54, fontWeight: 400 }}>Administrator access</h1><div className="notice-box"><ShieldCheck size={22} /><div><h3>{status.data?.adminSetupRequired ? 'Administrator access needs setup' : 'This area is restricted'}</h3><p>{status.data?.adminSetupRequired ? 'The project owner must configure the server-side ADMIN_EMAILS allow-list before anyone can manage events.' : isSignedIn ? 'This signed-in account is not on the administrator allow-list. Signing in alone does not grant access.' : 'Sign in with the account that the calendar administrator has authorized.'}</p></div></div><div style={{ marginTop: 20 }}>{isSignedIn ? <button className="btn secondary" onClick={() => signOut({ redirectUrl: basePath || '/' })}>Sign out and switch account</button> : <Link href="/sign-in" className="btn">Sign in with Clerk</Link>}</div></main></Shell>;
  return <Shell><main className="page section"><div className="eyebrow">Private organizer area</div><h1 className="serif" style={{ fontSize: 54, fontWeight: 400, margin: '8px 0' }}>Calendar desk</h1><div className="tabs">{(['events', 'submissions', 'delivery'] as const).map(t => <button key={t} onClick={() => setTab(t)} className={tab === t ? 'selected' : ''}>{t === 'events' ? 'Events' : t === 'submissions' ? 'Submissions' : 'Email & digest'}</button>)}</div>{tab === 'events' ? <AdminEvents /> : tab === 'submissions' ? <AdminSubmissions /> : <AdminDelivery />}</main></Shell>;
}
function AdminEvents() {
  const q = useListAdminEvents({ query: { queryKey: getListAdminEventsQueryKey(), retry: false } }); const del = useDeleteEvent(); const qc = useQueryClient(); const [editing, setEditing] = useState<Event | null | 'new'>(null);
  const remove = async (event: Event) => { if (!window.confirm(`Remove “${event.title}” from the calendar?`)) return; try { await del.mutateAsync({ id: event.id }); await Promise.all([qc.invalidateQueries({ queryKey: getListAdminEventsQueryKey() }), qc.invalidateQueries({ queryKey: getListEventsQueryKey() }), qc.invalidateQueries({ queryKey: getGetCalendarOverviewQueryKey() }), qc.invalidateQueries({ queryKey: getGetEventQueryKey(event.slug) })]); } catch (err) { window.alert(errorText(err)); } };
  return <><div className="section-heading"><div><h2>Events</h2><p className="hint">Only published events appear in the public calendar.</p></div><button className="btn" onClick={() => setEditing('new')}>Create event <ArrowRight size={15} /></button></div>{editing && <EventEditor key={editing === 'new' ? 'new' : editing.id} initial={editing === 'new' ? undefined : editing} onDone={() => setEditing(null)} />}{q.isLoading ? <Loading /> : q.error ? <LoadError error={q.error} retry={() => q.refetch()} /> : !q.data?.length ? <Empty title="No events to manage" text="Create the first event for the community calendar." /> : <div style={{ overflowX: 'auto' }}><table className="admin-table"><thead><tr><th>Event</th><th>Date</th><th>Status</th><th>Actions</th></tr></thead><tbody>{q.data.map(event => <tr key={event.id}><td><b>{event.title}</b><div className="hint">{event.category}{event.sourceName ? ` · Imported from ${event.sourceName}` : ''}{event.isDemo ? ' · Demonstration data' : ''}</div></td><td>{dateFmt(event.startAt)}<div className="hint">{event.allDay ? 'All day' : timeFmt(event.startAt)}</div></td><td><span className="tag">{event.status}</span></td><td><div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}><button className="btn secondary small" onClick={() => setEditing(event)}>Edit</button><button className="btn secondary small" disabled={del.isPending} onClick={() => remove(event)}>Remove</button></div></td></tr>)}</tbody></table></div>}</>;
}
function AdminSubmissions() {
  const q = useListSubmissions({ query: { queryKey: getListSubmissionsQueryKey(), retry: false } }); const status = useUpdateSubmissionStatus(); const qc = useQueryClient(); const [message, setMessage] = useState(''); const [approvalId, setApprovalId] = useState<string | null>(null);
  const refresh = async () => { await Promise.all([qc.invalidateQueries({ queryKey: getListSubmissionsQueryKey() }), qc.invalidateQueries({ queryKey: getListAdminEventsQueryKey() }), qc.invalidateQueries({ queryKey: getListEventsQueryKey() }), qc.invalidateQueries({ queryKey: getGetCalendarOverviewQueryKey() })]); };
  const reject = async (id: string, value: 'rejected' | 'removed') => { try { await status.mutateAsync({ id, data: { status: value as typeof SubmissionStatusInputStatus.rejected } }); await refresh(); } catch (err) { setMessage(errorText(err)); } };
  const openAttachment = async (id: string, attachmentId: string) => { try { const blob = await fetch(`${basePath}/api/admin/submissions/${id}/attachments/${attachmentId}`).then(r => { if (!r.ok) throw new Error('Could not open private attachment.'); return r.blob(); }); const url = URL.createObjectURL(blob); window.open(url, '_blank', 'noopener'); setTimeout(() => URL.revokeObjectURL(url), 60_000); } catch (err) { setMessage(errorText(err)); } };
  return <>
    <div className="section-heading"><div><h2>Submissions</h2><p className="hint">Files stay private; uploading never publishes a submission.</p></div></div>
    {message && <div className="status-message" role="status">{message}</div>}
    {q.isLoading ? <Loading /> : q.error ? <LoadError error={q.error} retry={() => q.refetch()} /> : !q.data?.length ? <Empty title="Nothing waiting for review" text="New suggestions will appear here." /> : <div style={{ display: 'grid', gap: 12 }}>
      {q.data.map(s => <article className="paper" key={s.id}><div style={{ display: 'flex', justifyContent: 'space-between', gap: 15, flexWrap: 'wrap' }}>
        <div><span className="tag">{s.status}</span>{s.normalization.status !== 'not_run' && <span className="tag" style={{ marginLeft: 6 }}>normalization: {s.normalization.status}</span>}{s.duplicatePotential && <span className="tag" style={{ marginLeft: 6, background: '#f0e4cc' }}>Possible duplicate</span>}<div className="eyebrow" style={{ marginTop: 10 }}>Original submission</div><h3 className="serif" style={{ fontSize: 27, fontWeight: 400, margin: '5px 0 9px' }}>{s.title || 'Untitled suggestion'}</h3><p className="hint mono">{s.reference} · received {dateFmt(s.createdAt)}</p><p style={{ whiteSpace: 'pre-wrap' }}>{s.details || 'No extra details supplied.'}</p><div className="hint">{s.category || 'Category not supplied'} · {dateFmt(s.startAt)} · {s.location || 'Location not supplied'}</div><div className="hint">Organizer: {s.organizer || 'Not supplied'} · follow-up: {s.followUpEmail || 'Not supplied'}</div>{s.sourceUrl && <a href={s.sourceUrl} target="_blank" rel="noreferrer">Source link <ExternalLink size={13} /></a>}</div>
        <div style={{ display: 'flex', alignItems: 'start', gap: 7, flexWrap: 'wrap' }}>{s.attachments.map(attachment => <button className="btn secondary small" key={attachment.id} onClick={() => openAttachment(s.id, attachment.id)}><FileText size={14} /> {attachment.name}</button>)}{s.status === 'pending' && <><button className="btn small" onClick={() => setApprovalId(approvalId === s.id ? null : s.id)}>Review and approve</button><button className="btn secondary small" disabled={status.isPending} onClick={() => reject(s.id, 'rejected')}>Reject</button></>}{s.status !== 'removed' && <button className="btn secondary small" disabled={status.isPending} onClick={() => reject(s.id, 'removed')}>Remove</button>}</div>
      </div><NormalizationPanel normalization={s.normalization} />{approvalId === s.id && <SubmissionApprovalEditor submission={s} onCancel={() => setApprovalId(null)} onApproved={() => { setApprovalId(null); setMessage('Submission approved and published after review.'); void refresh(); }} />}</article>)}
    </div>}
  </>;
}
function AdminDelivery() {
  const status = useGetEmailDeliveryStatus({ query: { queryKey: getGetEmailDeliveryStatusQueryKey(), retry: false } });
  const preview = useGetWeeklyDigestPreview(undefined, { query: { queryKey: getGetWeeklyDigestPreviewQueryKey(), retry: false } });
  return <><div className="section-heading"><div><h2>Email delivery & digest preview</h2><p className="hint">The preview is read-only. No weekly sending schedule is active.</p></div></div>{status.isLoading ? <div className="skeleton" style={{ height: 80 }} /> : status.error ? <LoadError error={status.error} retry={() => status.refetch()} /> : <div className="notice-box"><Mail size={23} /><div><h3>{status.data?.configured ? 'Delivery provider configured' : 'Email delivery is not configured'}</h3><p>{status.data?.message}</p><p className="hint">Provider: {status.data?.provider || 'None'} · sending {status.data?.automaticSendingEnabled ? 'enabled' : 'disabled'} · timezone {status.data?.timezone}</p></div></div>}<section className="paper" style={{ marginTop: 18 }}><h3 className="serif" style={{ fontSize: 26, fontWeight: 400, marginTop: 0 }}>Next weekly digest</h3>{preview.isLoading ? <div className="skeleton" style={{ height: 60 }} /> : preview.error ? <LoadError error={preview.error} retry={() => preview.refetch()} /> : preview.data && <><p className="hint">{dateOnlyFmt(preview.data.weekStart)} – {dateOnlyFmt(preview.data.weekEnd)} · {preview.data.timezone}</p><p className="status-message">Digest preview only — this screen does not send email.</p><EventList events={preview.data.events} emptyTitle="No events in the preview" emptyText="Published events for the digest week will be shown here." /></>}</section></>;
}

function AuthRoute({ kind }: { kind: 'sign-in' | 'sign-up' }) {
  return <main className="auth-page"><div className="auth-context"><Link href="/" className="brand"><span className="brand-mark">T</span><span>Tumbler Ridge<br /><small style={{ fontWeight: 500, color: '#68766e' }}>Community Calendar</small></span></Link><p>Public browsing and event suggestions do not require an account. A Clerk account alone does not grant administrator access.</p><Link href="/" className="hint">Return to the public calendar</Link></div><div className="auth-card">{kind === 'sign-in' ? <SignIn routing="path" path={`${basePath}/sign-in`} signUpUrl={`${basePath}/sign-up`} /> : <SignUp routing="path" path={`${basePath}/sign-up`} signInUrl={`${basePath}/sign-in`} />}</div></main>;
}
function NotFound() {
  return <Shell><main className="page section"><div className="eyebrow">A small detour</div><h1 className="serif" style={{ fontSize: 58, fontWeight: 400 }}>That page isn’t here.</h1><p className="hint">The calendar may have changed its path.</p><Link href="/" className="btn">Back to the calendar</Link></main></Shell>;
}
function Router() {
  return <Switch>
    <Route path="/" component={HomePage} /><Route path="/calendar" component={CalendarPage} /><Route path="/events/:slug" component={EventDetailPage} /><Route path="/notices" component={NoticesPage} /><Route path="/submit" component={SubmitPage} /><Route path="/updates" component={UpdatesPage} />
    <Route path="/updates/confirm" component={() => <SubscriptionActionPage action="confirm" />} /><Route path="/updates/unsubscribe" component={() => <SubscriptionActionPage action="unsubscribe" />} /><Route path="/updates/manage" component={() => <SubscriptionActionPage action="manage" />} />
    <Route path="/admin" component={AdminPage} /><Route path="/sign-in/*?" component={() => <AuthRoute kind="sign-in" />} /><Route path="/sign-up/*?" component={() => <AuthRoute kind="sign-up" />} /><Route component={NotFound} />
  </Switch>;
}
function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const client = useQueryClient();
  const previousUserId = useRef<string | null | undefined>(undefined);
  useEffect(() => addListener(({ user }) => {
    const nextUserId = user?.id ?? null;
    if (previousUserId.current !== undefined && previousUserId.current !== nextUserId) client.clear();
    previousUserId.current = nextUserId;
  }), [addListener, client]);
  return null;
}
function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();
  return <ClerkProvider
    publishableKey={clerkPubKey}
    proxyUrl={clerkProxyUrl}
    appearance={clerkAppearance}
    signInUrl={`${basePath}/sign-in`}
    signUpUrl={`${basePath}/sign-up`}
    localization={{
      signIn: { start: { title: 'Welcome back', subtitle: 'Sign in to access the organizer workspace' } },
      signUp: { start: { title: 'Create your account', subtitle: 'Request access to the community calendar team' } },
    }}
    routerPush={to => setLocation(stripBase(to))}
    routerReplace={to => setLocation(stripBase(to), { replace: true })}
  >
    <QueryClientProvider client={queryClient}>
      <ClerkQueryClientCacheInvalidator />
      <Router />
    </QueryClientProvider>
  </ClerkProvider>;
}
function App() {
  return <WouterRouter base={basePath}><ClerkProviderWithRoutes /></WouterRouter>;
}
export default App;
