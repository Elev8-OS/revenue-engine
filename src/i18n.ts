/**
 * Two languages, one shape.
 *
 * `Strings` is an interface rather than a loose record on purpose: TypeScript
 * then refuses to compile a locale that is missing a key, and refuses a key that
 * exists in only one locale. Half-translated screens happen precisely where that
 * is unchecked, and this dashboard is read by the Bali team and the Swiss side of
 * the portfolio at the same time.
 *
 * Anything with a number in it is a function, so word order stays the
 * translator's decision rather than being fixed by concatenation in the caller.
 */
export type Lang = 'en' | 'id'

export interface Strings {
  /** For the html lang attribute — screen readers and hyphenation use it. */
  htmlLang: string
  /**
   * Money formatting locale. Both run at maximumFractionDigits 0, which is the
   * point: with no decimals, "1,234" and "1.234" cannot be misread as each
   * other by a reader expecting the other convention.
   */
  numberLocale: string
  langName: string
  otherLangName: string

  /* --- shell */
  appTitle: string
  heading: string
  signedInAs: (email: string) => string
  signOut: string
  readiness: string
  basisRevenue: string
  basisMargin: string

  /* --- the four counters */
  largestSingle: string
  nothingOpen: string
  openFindings: string
  severityBreakdown: (critical: number, high: number) => string
  rooms: string
  activeInPortfolio: string
  notAssessable: string
  signalMissing: string
  /**
   * Why a room cannot be assessed at all, as opposed to a check that did not
   * reach it. Without a band there is no cohort, and without a cohort there is
   * nothing to compare against — so this is a structural fact about the room,
   * true no matter which checks run.
   */
  reasonNoBand: string
  /**
   * A credential being set is not the same as a source being read. Conflating
   * the two made a readiness page report four green sources while exactly one
   * of them had an adapter, which is worse than reporting none.
   */
  notRead: string

  /* --- the table */
  colProperty: string
  colAtStake: string
  colFindings: string
  colWorstDomain: string
  /**
   * Renamed from `colAdrVsSet` and `colSync`, which were placeholders for a
   * comparison that did not exist yet and rendered an em dash for months. They
   * now carry measurements, and the keys say what.
   */
  colVsMarket: string
  colArchived: string
  notMeasured: string
  mpiLabel: string
  recommendLabel: string
  occupancy30: string
  nightsArchived: (n: number) => string
  discoverStart: string
  discoverRun: string
  discoverNote: string
  funnelStart: string
  funnelRun: string
  funnelNote: string
  checksStart: string
  checksRun: string
  checksNote: string
  lastRun: (source: string) => string
  /** The picture in an opened row. */
  potentialHeading: string
  potentialOurs: string
  potentialMarket: string
  potentialGapPp: (pp: number) => string
  potentialRange: string
  potentialAhead: string
  /** The glossary. Terms in the order a reader meets them on the page. */
  legendHeading: string
  legendLead: string
  legend: Array<{ term: string, text: string }>
  /** The micro layer: where our price sits in its own neighbourhood. */
  pricePosHeading: string
  pricePosLive: string
  pricePosRecommended: string
  pricePosBasis: (listings: number, band: string) => string
  pricePosNoBasis: string
  pricePosNoPanel: string
  pricePosNoPrice: string
  /** Where the live price falls in the neighbourhood distribution. */
  pricePos: Record<'belowP25' | 'p25p50' | 'p50p75' | 'p75p90' | 'aboveP90', string>
  /** The macro layer, and why it is not here. */
  macroHeading: string
  funnelChannelBooking: string
  funnelChannelAirbnb: string
  funnelAxisTrailing: string
  funnelAxisForward: (nights: number) => string
  funnelImpressions: string
  funnelViews: string
  funnelBookings: string
  funnelChainNote: string
  /**
   * One sentence per measured state — NOT one constant.
   *
   * `macroBlocked` was a single string with "whose grant is revoked" written into
   * it. It rendered on every page load, so unlike the stored gate prose it did
   * not even need a stale check run to be wrong: it was wrong the moment the
   * grant came back, and it stayed wrong on every screen. The identical mistake
   * as the gate notes, made twice in the same afternoon.
   */
  macro: Record<'not_configured' | 'grant_revoked' | 'grant_stale' | 'unread' | 'read', string>
  findingCount: (n: number, severity: string) => string
  noneOpen: string
  notRated: string
  gateLabel: (stage: string) => string
  roomsNotAssessable: (n: number) => string

  /* --- the empty state */
  noPropertiesYet: string
  noPropertiesWhy: string

  /* --- open row */
  noOpenFinding: string
  gatekeeper: string
  gateAllHold: string
  gateBreaksAt: (stage: string) => string
  gateNoneBreak: string
  cohortCaveat: string
  evidence: string
  evidenceFor: string
  evidenceAgainst: string
  evidenceAgainstNote: string
  evidenceUnknown: string

  /* --- footer */
  largestNotSum: string
  freshness: string

  /* --- banners */
  openToTheInternet: string
  demoData: string

  /* --- vocabulary that appears inside data */
  severity: Record<string, string>
  contract: Record<string, string>
  domain: Record<string, string>
  stage: Record<string, string>
  ageMinutes: (n: number) => string
  ageHours: (n: number) => string
  ageDays: (n: number) => string

  /* --- sign-in */
  loginTitle: string
  loginWithMicrosoft: string
  loginSsoLead: string
  loginMagicLead: string
  loginMagicAlso: string
  loginSendLink: string
  loginEmailPlaceholder: string
  loginLinkSent: string
  loginNoMethod: string
  loginLinkDead: string
  loginProviderDeclined: (code: string) => string
  loginNotAdmitted: string
  loginGroupsNotEmitted: string
  loginTooManyGroups: string
  loginFailed: string

  /* --- readiness page */
  readinessHeading: string
  readinessLead: string
  toDashboard: string
  database: string
  dbReady: (tables: number, migrations: number) => string
  dbUnreachable: string
  dbUnconfigured: string
  colSource: string
  colState: string
  colWhatFor: string
  connected: string
  missing: string
  sourceNotes: Record<'elev8' | 'pricelabs' | 'pricelabsMarket' | 'channex' | 'mdv', string>
  redirectUriLabel: string
  tenantLabel: string
  grantNone: string
  grantLive: (rotation: number) => string
  grantRevoked: string
  grantStale: string
  authoriseNow: string
  grantReplace: string
  grantReplaceCaution: string
  authBlockedNoAllowlist: string
  signIn: string
  signInActive: string
  signInMicrosoft: string
  signInMailLink: (mode: string) => string
  /** Fragments, joined by the caller, because more than one gate can apply. */
  admittedCount: (n: number) => string
  admittedGroups: (n: number) => string
  admittedLead: (what: string) => string
  admittedAnd: string
  admittedEveryGateApplies: string
  admittedWholeTenant: string
  signInOff: string

  /* --- import */
  importHeading: string
  importLead: string
  importStart: string
  importNever: string
  importRunningSince: (when: string) => string
  importFinishedAt: (when: string) => string
  importCounts: (created: number, known: number, unresolved: number) => string
  importFailedWith: (reason: string) => string
  importBusy: string
  importNeedsMdv: string
  importDemoStillOn: string
  importRefresh: string
  importBack: string

  /* --- notices */
  noticeAuthBlocked: string
  noticeAuthBlockedBody: string
  noticeMissingVars: string
  noticeMissingVarsBody: (names: string) => string
  noticeMdvRefused: string
  noticeMdvRefusedBody: (code: string) => string
  noticeMdvConnected: string
  noticeMdvConnectedBody: string
  noticeClientRegistered: string
  noticeClientRegisteredBody: (clientId: string) => string
  noticeRegisterFailed: string
  /** The readiness card for the client this service is actually using. */
  clientOwn: (clientId: string) => string
  clientShared: (clientId: string) => string
  clientNone: string
  clientRegisterAction: string
  clientSharedCaution: string
  noticeStartFailed: string
  noticeStartFailedBody: string
  noticeAuthFailed: string
  noticeAuthFailedBody: string
  noticeSsoUnconfigured: string
  noticeSsoUnconfiguredBody: string
}

export const en: Strings = {
  htmlLang: 'en',
  numberLocale: 'en-CH',
  langName: 'English',
  otherLangName: 'Bahasa Indonesia',

  appTitle: 'Revenue Engine — Listing Health',
  heading: 'Listing Health',
  signedInAs: email => `signed in as ${email}`,
  signOut: 'sign out',
  readiness: 'Readiness',
  basisRevenue: 'Revenue',
  basisMargin: 'Contribution',

  largestSingle: 'Largest single opportunity',
  nothingOpen: 'nothing open',
  openFindings: 'Open findings',
  severityBreakdown: (c, h) => `${c} critical · ${h} high`,
  rooms: 'Rooms',
  activeInPortfolio: 'active in the portfolio',
  notAssessable: 'Not assessable',
  signalMissing: 'signal missing',
  reasonNoBand: 'no room count and no capacity — nothing to compare it against',
  notRead: 'connected, not read yet',

  colProperty: 'Property',
  colAtStake: 'At stake',
  colFindings: 'Findings',
  colWorstDomain: 'Worst domain',
  colVsMarket: 'vs market · 30 d',
  colArchived: 'Archived',
  notMeasured: 'not measured',
  mpiLabel: 'MPI',
  recommendLabel: 'recommended',
  occupancy30: 'occupancy, next 30 nights',
  nightsArchived: n => `${n} night${n === 1 ? '' : 's'}`,
  funnelStart: 'Read the funnel',
  funnelRun: 'Read visibility',
  funnelNote: 'Reads impressions, views and conversions per listing from MyDataValue. '
    + 'Field names are resolved against the payload rather than assumed, and the run '
    + 'reports which name carried which figure — plus any key it found that nothing '
    + 'asked for. A rate whose scale cannot be established is left unstored on purpose.',
  discoverStart: 'Ask MyDataValue what it has',
  discoverRun: 'Probe endpoints',
  discoverNote: 'Calls a list of candidate endpoints and records only the SHAPE of each '
    + 'answer — paths, key names and how often each was filled, never a value. Writes no '
    + 'objects and no measurements. Read the result on /shapes; it is what the funnel '
    + 'mapper gets written against, instead of against remembered field names.',
  checksStart: 'Assess the portfolio',
  checksRun: 'Run checks',
  checksNote: 'Reads the archive and writes findings. Re-running replaces the previous set '
    + 'rather than adding to it, and shares the import lock so it never reads a half-written pass.',
  lastRun: source => `Last run: ${source}`,
  potentialHeading: 'Potential',
  potentialOurs: 'ours',
  potentialMarket: 'market',
  potentialGapPp: pp => `${pp} pp behind`,
  potentialRange: 'range',
  potentialAhead: 'ahead of the market on this window',
  legendHeading: 'What the columns mean',
  legendLead: 'Every term below is a measurement or a verdict. Nothing here is an estimate '
    + 'unless it says so.',
  legend: [
    { term: 'At stake', text: 'The largest SINGLE opportunity on a room, never a sum of its '
      + 'findings: two findings can cover the same nights, so a total would count them twice.' },
    { term: 'Findings', text: 'What a check concluded, with a severity. Critical is reserved '
      + 'for a claim with a confirmed cost behind it, so no check can reach it yet.' },
    { term: 'Worst domain', text: 'Which lever a finding blames. It stays empty unless we can '
      + 'show the room is reachable at all — while MyDataValue is disconnected, "invisible" '
      + 'and "overpriced" measure the same thing.' },
    { term: 'vs market · 30 d', text: 'Our occupancy over the next 30 nights against the market '
      + 'for this listing\u2019s own neighbourhood, both from the same PriceLabs comparison. '
      + 'The chip is the difference in percentage points.' },
    { term: 'MPI', text: 'Market Pricing Index: our asking price divided by the market\u2019s. '
      + '1.00 is level; 2.08 means we ask twice what the neighbourhood does.' },
    { term: 'Archived', text: 'How many of the next 30 nights we hold a stored price for. A '
      + 'median over three nights is not a median over ninety, so the count is shown beside it.' },
    { term: 'Band', text: 'The cohort a room is compared inside — "2BR" from a bedroom count, '
      + '"sleeps 3-4" where only capacity is known. The basis is stored beside the band because '
      + 'the two are different yardsticks.' },
    { term: 'Not assessable', text: 'Rooms a check ran on and could not reach, with the missing '
      + 'signal named, plus rooms with no band at all. It is the number that stops a portfolio '
      + 'with three findings from looking healthy.' },
    { term: 'Confidence', text: 'How much of the causal chain was actually observed. Three of '
      + 'the four gates are unknown while MyDataValue is disconnected, so it is multiplied down '
      + 'rather than shown at face value.' },
    { term: 'Holdout', text: 'A room deliberately excluded from writes, so the effect of the '
      + 'recommendations stays measurable against something.' },
    { term: 'Contract', text: 'Guaranteed rent or commission — whose money is at stake, and '
      + 'therefore whether a finding can be a recommendation at all.' },
  ],
  pricePosHeading: 'Price position',
  pricePosLive: 'live',
  pricePosRecommended: 'recommended',
  pricePosBasis: (listings, band) =>
    `${band} band in this neighbourhood, ${listings} listing${listings === 1 ? '' : 's'}`,
  pricePosNoBasis: 'no neighbourhood band for this room',
  pricePosNoPanel: 'No neighbourhood band yet. PriceLabs returns the panel in an encoding '
    + 'this reader does not yet accept — the labels it saw are in the import report and on '
    + '/shapes, and nothing is written until they can be read as percentiles.',
  pricePosNoPrice: 'No price of our own on this calendar, so there is nothing to place '
    + 'inside the neighbourhood band.',
  pricePos: {
    belowP25: 'below the bottom quarter of the neighbourhood',
    p25p50: 'in the lower half, below the median',
    p50p75: 'in the upper half, above the median',
    p75p90: 'in the top quarter',
    aboveP90: 'above the top tenth of the neighbourhood',
  },
  macroHeading: 'Macro',
  funnelChannelBooking: 'Booking.com',
  funnelChannelAirbnb: 'Airbnb',
  funnelAxisTrailing: 'recent history, window set by the channel',
  funnelAxisForward: n => `next 30 nights (${n} read)`,
  funnelImpressions: 'seen in search',
  funnelViews: 'opened the listing',
  funnelBookings: 'booked',
  funnelChainNote: 'Each share is computed from the two counts beside it, not taken '
    + 'from the provider — a rate whose scale is unstated can be wrong by a hundredfold.',
  macro: {
    not_configured: 'Not connected. Arrivals, exchange rates and season only become a signal '
      + 'for THIS room once the guest-origin mix is known per object — and that lives in '
      + 'MyDataValue, which is not configured. A market-wide number applied to one room '
      + 'without its origin mix is a decoration, not evidence.',
    grant_revoked: 'Not connected. The guest-origin mix per object is what turns arrivals, '
      + 'exchange rates and season into a signal for THIS room, and it lives in MyDataValue '
      + '— whose grant is revoked and needs a new authorisation.',
    grant_stale: 'Not connected. The guest-origin mix per object is what turns arrivals, '
      + 'exchange rates and season into a signal for THIS room. MyDataValue is reachable and '
      + 'the stored token is behind the chain; one current token in '
      + 'MDV_SEED_REFRESH_TOKEN fixes it.',
    unread: 'Connected, not read. MyDataValue holds the guest-origin mix per object — the '
      + 'thing that turns arrivals, exchange rates and season into a signal for THIS room — '
      + 'and nothing pulls it yet. Until it does, a market-wide number applied to one room '
      + 'without its origin mix would be a decoration, not evidence.',
    read: 'No macro signal for this room yet. The guest-origin mix is being read, but none '
      + 'has been recorded against this room in this window.',
  },
  findingCount: (n, s) => `${n}× ${s}`,
  noneOpen: 'none open',
  notRated: 'not assessed',
  gateLabel: stage => `Gate: ${stage}`,
  roomsNotAssessable: n => `${n} room${n === 1 ? '' : 's'} not assessable`,

  noPropertiesYet: 'No properties yet.',
  noPropertiesWhy: 'Nothing is flowing in — credentials are missing. What exactly is missing is on the',

  noOpenFinding: 'No open finding for this room.',
  gatekeeper: 'Gatekeeper',
  gateAllHold: 'All three visibility gates hold — this is a genuine price case.',
  gateBreaksAt: stage => `The gate breaks at <b>${stage}</b>. Price findings are held back until that is fixed.`,
  gateNoneBreak: 'No gate breaks.',
  cohortCaveat: 'Measured against our own cohort, not the market — no provider sells competitor funnel data.',
  evidence: 'Evidence',
  evidenceFor: 'For',
  evidenceAgainst: 'Against',
  evidenceAgainstNote: 'required — a check that cannot argue its own opposite is not finished',
  evidenceUnknown: 'Unknown',

  largestNotSum: 'Every row shows its <b>largest single opportunity</b> — never a sum, because findings can overlap the same nights.',
  freshness: 'Freshness',

  openToTheInternet: '<b>This page is open on the internet.</b> No sign-in is configured, so anyone with the URL can read it. Setting the Microsoft 365 variables closes it.',
  demoData: '<b>Demonstration data.</b> Nothing is flowing in yet, so what you see are the figures <em>measured</em> on the live account for the three Bali rooms, as an example — marked with the prefix <code>[Demo]</code>. They are deleted the moment real data arrives.',

  severity: { critical: 'critical', high: 'high', medium: 'medium', low: 'low', info: 'info' },
  contract: {
    guaranteed_rent: 'guaranteed rent',
    net_share: '% of net',
    fixed_fee: 'flat fee',
    gross_share: '% of gross',
  },
  domain: {
    impressions: 'Restrictions & stay mix',
    ctr: 'Visibility & conversion',
    conversion: 'Visibility & conversion',
    price: 'Price & yield',
  },
  stage: { impressions: 'Impressions', ctr: 'Click rate', conversion: 'Conversion', price: 'Price level' },
  ageMinutes: n => `${n} min`,
  ageHours: n => `${n} h`,
  ageDays: n => `${n} d`,

  loginTitle: 'Revenue Engine — Sign in',
  loginWithMicrosoft: 'Sign in with Microsoft',
  loginSsoLead: 'Sign in with your Elev8-Suite Microsoft 365 account.',
  loginMagicLead: 'Sign in by link, no password.',
  loginMagicAlso: 'Or by email link:',
  loginSendLink: 'Send link',
  loginEmailPlaceholder: 'you@elev8-suite.com',
  loginLinkSent: 'If that address has access, a sign-in link is on its way. It is valid for <b>15 minutes</b> and works <b>once</b>.',
  loginNoMethod: 'No sign-in method is configured. Railway is missing <code>ENTRA_CLIENT_ID</code>, <code>ENTRA_CLIENT_SECRET</code> or <code>PUBLIC_BASE_URL</code>.',
  loginLinkDead: 'That link has expired or was already used.',
  loginProviderDeclined: code => `Microsoft declined the sign-in (<code>${code}</code>).`,
  loginNotAdmitted: 'That account is signed in, but has no access to this tool.',
  loginGroupsNotEmitted: 'Access is decided by a Microsoft 365 group, but this application is not sending group membership yet. In Entra, under Token configuration, add the <b>groups</b> claim — until then nobody can get in.',
  loginTooManyGroups: 'This account belongs to more than 200 groups, so Microsoft sends a pointer instead of the list and membership cannot be read from the token.',
  loginFailed: 'The sign-in could not be completed. Please try again.',

  readinessHeading: 'Readiness',
  readinessLead: 'Variable <em>names</em> only, never values.',
  toDashboard: 'to the dashboard',
  database: 'Database',
  dbReady: (t, m) => `ready — ${t} tables, ${m} migrations`,
  dbUnreachable: 'unreachable',
  dbUnconfigured: 'not configured',
  colSource: 'Source',
  colState: 'State',
  colWhatFor: 'What for',
  connected: 'connected',
  missing: 'missing',
  sourceNotes: {
    // Rewritten twice. First it claimed cleaning minutes and capacity, which the
    // Partner API does not carry. Then it described the Partner API — seven
    // endpoints — while the adapter had moved to the Internal API, which carries
    // the rooms and the channel mapping the cohort actually depends on.
    elev8: 'rooms and beds per listing — the cohort band; and the channel mapping that links an OTA listing to ours',
    pricelabs: 'the forward price calendar archived nightly, the performance grid against each listing\u2019s own market, and realised bookings with the OTA commission on them',
    pricelabsMarket: 'the cohort benchmark: what a listing of this size earns in this market, asked by coordinate and bedroom count \u2014 a separate key from the one above',
    // Kept because the key is typed, but Elev8 proxies Channex in full, so this
    // row is no longer shown on the readiness page.
    channex: 'reached through Elev8, which proxies it in full — no separate key needed',
    mdv: 'direct HTTP API; the refresh token lives in the database because it rotates',
  },
  redirectUriLabel: 'Redirect URI for the app registration:',
  tenantLabel: 'Tenant',
  grantNone: 'no grant stored yet',
  grantLive: r => `grant live, ${r} rotation${r === 1 ? '' : 's'} so far`,
  grantRevoked: 'grant revoked — a newly issued token is needed; re-seeding the old one cannot work',
  grantStale: 'the stored token is behind the chain — the grant itself is live. A current '
    + 'refresh token in MDV_SEED_REFRESH_TOKEN is adopted on the next boot.',
  authoriseNow: 'authorise now',
  grantReplace: 'replace this grant',
  grantReplaceCaution: 'Only needed if the grant dies. It starts a fresh authorisation and, if that succeeds, the new refresh token replaces the stored one — the current grant keeps working until then. It will fail with <code>invalid_redirect_uri</code> unless the redirect URI above is registered for this client, which it is not when the provider issued the grant directly.',
  authBlockedNoAllowlist: 'authorisation is blocked while no sign-in is configured',
  signIn: 'Sign-in',
  signInActive: 'active',
  signInMicrosoft: 'Microsoft 365 (Entra ID)',
  signInMailLink: mode => `email link via <code>${mode}</code>`,
  admittedCount: n => `${n} address${n === 1 ? '' : 'es'}`,
  admittedGroups: n => `members of ${n} Microsoft 365 group${n === 1 ? '' : 's'}`,
  admittedLead: what => `Admitted: ${what}.`,
  admittedAnd: 'and',
  admittedEveryGateApplies: 'Every condition listed must match — so adding one can only narrow access.',
  admittedWholeTenant: 'Admitted: <b>everyone</b> in the Elev8-Suite tenant — <code>ALLOWED_EMAILS</code> narrows that.',
  signInOff: 'off',

  importHeading: 'Import objects',
  importLead: 'Reads objects into the portfolio. Elev8 brings the listings with their rooms and the channel mapping to the OTAs; MyDataValue brings the Booking and Airbnb objects. Safe to run again: an object that is already known costs nothing, so only what is new or still unplaceable is fetched.',
  importStart: 'Start import',
  importNever: 'No import has run yet.',
  importRunningSince: when => `Running since ${when}. This page refreshes itself every few seconds until it finishes.`,
  importFinishedAt: when => `Finished ${when}.`,
  importCounts: (created, known, unresolved) =>
    `${created} new object${created === 1 ? '' : 's'}, ${known} already known, `
    + `${unresolved} could not be placed.`,
  importFailedWith: reason => `It failed: ${reason}`,
  importBusy: 'An import is already running. Nothing was started twice.',
  importNeedsMdv: 'MyDataValue is not configured, so there is nothing to import from. <code>MDV_CLIENT_ID</code> and <code>MDV_CLIENT_SECRET</code> are needed.',
  importDemoStillOn: '<b>Demonstration data is still switched on.</b> Real objects and <code>[Demo]</code> rows will sit side by side until <code>SEED_DEMO</code> is unset or set to anything other than <code>true</code> and the service restarts.',
  importRefresh: 'reload',
  importBack: 'back to readiness',

  noticeAuthBlocked: 'Authorisation blocked',
  noticeAuthBlockedBody: 'While no sign-in is configured this route stays shut. Otherwise anyone with the URL could park a foreign MyDataValue grant here.',
  noticeMissingVars: 'Variables are missing',
  noticeMissingVarsBody: names => `Please set these in Railway: ${names}.`,
  noticeMdvRefused: 'MyDataValue declined',
  noticeMdvRefusedBody: code => `The provider reports <code>${code}</code>.`,
  noticeMdvConnected: 'MyDataValue is connected',
  noticeMdvConnectedBody: 'The refresh token now lives in the database and rotates there. <code>MDV_SEED_REFRESH_TOKEN</code> is no longer read and can stay empty.',
  noticeClientRegistered: 'Client registered',
  noticeClientRegisteredBody: clientId =>
    `This service now has a client of its own, <code>${clientId}</code>. Authorise it once `
    + 'and its grant is separate from every other service on the account.',
  noticeRegisterFailed: 'Client registration failed',
  clientOwn: clientId =>
    `using a client of our own (${clientId}) — its grant is not shared with anything else`,
  clientShared: clientId =>
    `using the configured client (${clientId}), which is SHARED. MyDataValue rotates the `
    + 'refresh token on every use, so whichever service refreshes last leaves the other '
    + 'holding a spent one. Register a client of our own to end that.',
  clientNone: 'no client at all: none registered and MDV_CLIENT_ID is not set',
  clientRegisterAction: 'Register a client of our own',
  clientSharedCaution: 'Registering replaces the current registration and abandons its grant.',
  noticeStartFailed: 'Authorisation could not start',
  noticeStartFailedBody: 'The provider metadata was not readable. Details are in the deploy log.',
  noticeAuthFailed: 'Authorisation failed',
  noticeAuthFailedBody: 'The code was refused or had already been used. Please start again at <code>/auth/mdv</code>. The reason is in the deploy log.',
  noticeSsoUnconfigured: 'Sign-in is not configured',
  noticeSsoUnconfiguredBody: 'Railway is missing <code>ENTRA_CLIENT_ID</code>, <code>ENTRA_CLIENT_SECRET</code> or <code>PUBLIC_BASE_URL</code>.',
}

export const id: Strings = {
  htmlLang: 'id',
  numberLocale: 'id-ID',
  langName: 'Bahasa Indonesia',
  otherLangName: 'English',

  appTitle: 'Revenue Engine — Kesehatan Listing',
  heading: 'Kesehatan Listing',
  signedInAs: email => `masuk sebagai ${email}`,
  signOut: 'keluar',
  readiness: 'Kesiapan',
  basisRevenue: 'Pendapatan',
  basisMargin: 'Kontribusi',

  largestSingle: 'Peluang tunggal terbesar',
  nothingOpen: 'tidak ada yang terbuka',
  openFindings: 'Temuan terbuka',
  severityBreakdown: (c, h) => `${c} kritis · ${h} tinggi`,
  rooms: 'Unit',
  activeInPortfolio: 'aktif dalam portofolio',
  notAssessable: 'Tidak dapat dinilai',
  signalMissing: 'sinyal tidak tersedia',
  reasonNoBand: 'tidak ada jumlah kamar dan tidak ada kapasitas — tidak ada pembanding',
  notRead: 'terhubung, belum dibaca',

  colProperty: 'Properti',
  colAtStake: 'Dipertaruhkan',
  colFindings: 'Temuan',
  colWorstDomain: 'Domain terburuk',
  colVsMarket: 'vs pasar · 30 hr',
  colArchived: 'Terarsip',
  notMeasured: 'belum diukur',
  mpiLabel: 'MPI',
  recommendLabel: 'disarankan',
  occupancy30: 'okupansi, 30 malam berikutnya',
  nightsArchived: n => `${n} malam`,
  funnelStart: 'Baca funnel',
  funnelRun: 'Baca keterlihatan',
  funnelNote: 'Membaca impresi, kunjungan dan konversi per listing dari MyDataValue. '
    + 'Nama field dicocokkan pada muatan, bukan diasumsikan, dan proses ini melaporkan '
    + 'nama mana yang membawa angka mana — beserta setiap kunci yang ditemukan tetapi '
    + 'tidak diminta. Rasio yang skalanya tidak dapat dipastikan sengaja tidak disimpan.',
  discoverStart: 'Tanya MyDataValue apa yang ada',
  discoverRun: 'Sondir endpoint',
  discoverNote: 'Memanggil daftar endpoint kandidat dan mencatat hanya BENTUK setiap '
    + 'jawaban — path, nama kunci dan seberapa sering terisi, tidak pernah nilainya. Tidak '
    + 'menulis objek maupun pengukuran. Baca hasilnya di /shapes.',
  checksStart: 'Nilai portofolio',
  checksRun: 'Jalankan pemeriksaan',
  checksNote: 'Membaca arsip dan menulis temuan. Menjalankan ulang menggantikan set sebelumnya, '
    + 'bukan menambahkannya, dan berbagi kunci impor agar tidak pernah membaca pass yang setengah tertulis.',
  lastRun: source => `Jalan terakhir: ${source}`,
  potentialHeading: 'Potensi',
  potentialOurs: 'kita',
  potentialMarket: 'pasar',
  potentialGapPp: pp => `tertinggal ${pp} pp`,
  potentialRange: 'rentang',
  potentialAhead: 'di atas pasar pada jendela ini',
  legendHeading: 'Arti kolom-kolomnya',
  legendLead: 'Setiap istilah di bawah adalah hasil pengukuran atau sebuah putusan. Tidak ada '
    + 'perkiraan di sini kecuali disebutkan.',
  legend: [
    { term: 'Nilai dipertaruhkan', text: 'Peluang TUNGGAL terbesar pada satu kamar, bukan '
      + 'jumlah temuannya: dua temuan bisa mencakup malam yang sama, jadi totalnya akan '
      + 'menghitung dua kali.' },
    { term: 'Temuan', text: 'Kesimpulan sebuah pemeriksaan, dengan tingkat keparahan. Critical '
      + 'disediakan untuk klaim dengan biaya terkonfirmasi, jadi belum bisa dicapai.' },
    { term: 'Domain terburuk', text: 'Tuas mana yang disalahkan sebuah temuan. Tetap kosong '
      + 'kecuali kita bisa menunjukkan kamar itu memang terjangkau — selama MyDataValue '
      + 'terputus, "tidak terlihat" dan "terlalu mahal" terukur sama.' },
    { term: 'vs pasar · 30 hr', text: 'Okupansi kita untuk 30 malam ke depan berbanding pasar '
      + 'di lingkungan listing itu sendiri, keduanya dari perbandingan PriceLabs yang sama. '
      + 'Chip-nya adalah selisih dalam poin persentase.' },
    { term: 'MPI', text: 'Market Pricing Index: harga kita dibagi harga pasar. 1,00 berarti '
      + 'setara; 2,08 berarti kita meminta dua kali lipat lingkungan sekitar.' },
    { term: 'Terarsip', text: 'Berapa dari 30 malam ke depan yang harganya sudah kita simpan. '
      + 'Median atas tiga malam bukan median atas sembilan puluh, jadi jumlahnya ditampilkan.' },
    { term: 'Band', text: 'Kohort tempat sebuah kamar dibandingkan — "2BR" dari jumlah kamar '
      + 'tidur, "sleeps 3-4" bila hanya kapasitas yang diketahui. Dasarnya disimpan di sebelah '
      + 'band karena keduanya tolok ukur yang berbeda.' },
    { term: 'Tidak bisa dinilai', text: 'Kamar yang diperiksa tetapi tidak terjangkau, dengan '
      + 'sinyal yang hilang disebutkan, ditambah kamar tanpa band sama sekali. Angka inilah '
      + 'yang mencegah portofolio dengan tiga temuan terlihat sehat.' },
    { term: 'Confidence', text: 'Seberapa banyak rantai sebab yang benar-benar teramati. Tiga '
      + 'dari empat gate tidak diketahui selama MyDataValue terputus, jadi angkanya dikalikan '
      + 'turun, bukan ditampilkan apa adanya.' },
    { term: 'Holdout', text: 'Kamar yang sengaja dikecualikan dari penulisan, agar efek '
      + 'rekomendasi tetap bisa diukur terhadap sesuatu.' },
    { term: 'Kontrak', text: 'Sewa terjamin atau komisi — uang siapa yang dipertaruhkan, dan '
      + 'karenanya apakah sebuah temuan bisa menjadi rekomendasi sama sekali.' },
  ],
  pricePosHeading: 'Posisi harga',
  pricePosLive: 'aktif',
  pricePosRecommended: 'disarankan',
  pricePosBasis: (listings, band) =>
    `band ${band} di lingkungan ini, ${listings} listing`,
  pricePosNoBasis: 'tidak ada band lingkungan untuk kamar ini',
  pricePosNoPanel: 'Belum ada band lingkungan. PriceLabs mengirim panelnya dalam bentuk yang '
    + 'pembaca ini belum terima — label yang terlihat ada di laporan impor dan di /shapes, '
    + 'dan tidak ada yang ditulis sampai label itu bisa dibaca sebagai persentil.',
  pricePosNoPrice: 'Tidak ada harga milik kita di kalender ini, jadi tidak ada yang bisa '
    + 'ditempatkan di dalam band lingkungan.',
  pricePos: {
    belowP25: 'di bawah kuartal terbawah lingkungan',
    p25p50: 'di paruh bawah, di bawah median',
    p50p75: 'di paruh atas, di atas median',
    p75p90: 'di kuartal teratas',
    aboveP90: 'di atas sepersepuluh teratas lingkungan',
  },
  macroHeading: 'Makro',
  funnelChannelBooking: 'Booking.com',
  funnelChannelAirbnb: 'Airbnb',
  funnelAxisTrailing: 'riwayat terkini, jendela ditentukan kanal',
  funnelAxisForward: n => `30 malam ke depan (${n} terbaca)`,
  funnelImpressions: 'terlihat di pencarian',
  funnelViews: 'membuka listing',
  funnelBookings: 'memesan',
  funnelChainNote: 'Setiap persentase dihitung dari dua angka di sebelahnya, bukan '
    + 'diambil dari penyedia — rasio yang skalanya tidak dinyatakan bisa salah seratus kali.',
  macro: {
    not_configured: 'Belum terhubung. Kedatangan, kurs dan musim baru menjadi sinyal untuk '
      + 'kamar INI bila komposisi asal tamu diketahui per objek — dan itu ada di '
      + 'MyDataValue, yang belum dikonfigurasi.',
    grant_revoked: 'Belum terhubung. Komposisi asal tamu per objek adalah yang mengubah '
      + 'kedatangan, kurs dan musim menjadi sinyal untuk kamar INI, dan itu ada di '
      + 'MyDataValue — yang izinnya dicabut dan perlu otorisasi baru.',
    grant_stale: 'Belum terhubung. Komposisi asal tamu per objek adalah yang mengubah '
      + 'kedatangan, kurs dan musim menjadi sinyal untuk kamar INI. MyDataValue terjangkau '
      + 'dan token yang tersimpan tertinggal; satu token terkini di '
      + 'MDV_SEED_REFRESH_TOKEN memperbaikinya.',
    unread: 'Terhubung, belum dibaca. MyDataValue menyimpan komposisi asal tamu per objek — '
      + 'yang mengubah kedatangan, kurs dan musim menjadi sinyal untuk kamar INI — dan belum '
      + 'ada yang menariknya. Sampai itu terjadi, angka sepasar yang ditempel pada satu '
      + 'kamar tanpa komposisi asalnya hanyalah hiasan, bukan bukti.',
    read: 'Belum ada sinyal makro untuk kamar ini. Komposisi asal tamu sudah dibaca, tetapi '
      + 'belum ada yang tercatat untuk kamar ini pada jendela ini.',
  },
  findingCount: (n, s) => `${n}× ${s}`,
  noneOpen: 'tidak ada',
  notRated: 'belum dinilai',
  gateLabel: stage => `Gerbang: ${stage}`,
  roomsNotAssessable: n => `${n} unit tidak dapat dinilai`,

  noPropertiesYet: 'Belum ada properti.',
  noPropertiesWhy: 'Belum ada data yang masuk — kredensial belum lengkap. Apa yang kurang tercantum di',

  noOpenFinding: 'Tidak ada temuan terbuka untuk unit ini.',
  gatekeeper: 'Penjaga gerbang',
  gateAllHold: 'Ketiga gerbang visibilitas lolos — ini benar-benar soal harga.',
  gateBreaksAt: stage => `Gerbang gagal di <b>${stage}</b>. Temuan harga ditahan sampai itu dibereskan.`,
  gateNoneBreak: 'Tidak ada gerbang yang gagal.',
  cohortCaveat: 'Diukur terhadap kohort kita sendiri, bukan terhadap pasar — tidak ada penyedia yang menjual data funnel pesaing.',
  evidence: 'Bukti',
  evidenceFor: 'Mendukung',
  evidenceAgainst: 'Menyanggah',
  evidenceAgainstNote: 'wajib — pemeriksaan yang tidak bisa menyanggah dirinya sendiri belum selesai',
  evidenceUnknown: 'Tidak diketahui',

  largestNotSum: 'Setiap baris menampilkan <b>peluang tunggal terbesarnya</b> — bukan jumlah total, karena beberapa temuan bisa menyangkut malam yang sama.',
  freshness: 'Kesegaran data',

  openToTheInternet: '<b>Halaman ini terbuka di internet.</b> Belum ada cara masuk yang dikonfigurasi, jadi siapa pun yang punya URL-nya bisa membacanya. Mengisi variabel Microsoft 365 akan menutupnya.',
  demoData: '<b>Data demonstrasi.</b> Belum ada data yang masuk, jadi yang tampil adalah angka yang <em>terukur</em> pada akun langsung untuk tiga unit di Bali, sebagai contoh — ditandai dengan awalan <code>[Demo]</code>. Semuanya dihapus begitu data sungguhan tiba.',

  severity: { critical: 'kritis', high: 'tinggi', medium: 'sedang', low: 'rendah', info: 'info' },
  contract: {
    guaranteed_rent: 'sewa terjamin',
    net_share: '% dari neto',
    fixed_fee: 'biaya tetap',
    gross_share: '% dari bruto',
  },
  domain: {
    impressions: 'Restriksi & bauran menginap',
    ctr: 'Visibilitas & konversi',
    conversion: 'Visibilitas & konversi',
    price: 'Harga & hasil',
  },
  stage: { impressions: 'Impresi', ctr: 'Rasio klik', conversion: 'Konversi', price: 'Tingkat harga' },
  ageMinutes: n => `${n} mnt`,
  ageHours: n => `${n} jam`,
  ageDays: n => `${n} hr`,

  loginTitle: 'Revenue Engine — Masuk',
  loginWithMicrosoft: 'Masuk dengan Microsoft',
  loginSsoLead: 'Masuk dengan akun Microsoft 365 Elev8-Suite Anda.',
  loginMagicLead: 'Masuk lewat tautan, tanpa kata sandi.',
  loginMagicAlso: 'Atau lewat tautan email:',
  loginSendLink: 'Kirim tautan',
  loginEmailPlaceholder: 'anda@elev8-suite.com',
  loginLinkSent: 'Jika alamat itu punya akses, tautan masuk sedang dikirim. Tautan berlaku <b>15 menit</b> dan hanya bisa dipakai <b>sekali</b>.',
  loginNoMethod: 'Belum ada cara masuk yang dikonfigurasi. Di Railway belum ada <code>ENTRA_CLIENT_ID</code>, <code>ENTRA_CLIENT_SECRET</code> atau <code>PUBLIC_BASE_URL</code>.',
  loginLinkDead: 'Tautan itu sudah kedaluwarsa atau sudah pernah dipakai.',
  loginProviderDeclined: code => `Microsoft menolak proses masuk (<code>${code}</code>).`,
  loginNotAdmitted: 'Akun itu sudah masuk, tetapi tidak punya akses ke alat ini.',
  loginGroupsNotEmitted: 'Akses ditentukan oleh grup Microsoft 365, tetapi aplikasi ini belum mengirimkan keanggotaan grup. Di Entra, pada Token configuration, tambahkan klaim <b>groups</b> — sampai itu dilakukan, tidak seorang pun bisa masuk.',
  loginTooManyGroups: 'Akun ini tergabung dalam lebih dari 200 grup, sehingga Microsoft mengirim penunjuk alih-alih daftarnya, dan keanggotaan tidak dapat dibaca dari token.',
  loginFailed: 'Proses masuk tidak dapat diselesaikan. Silakan coba lagi.',

  readinessHeading: 'Kesiapan',
  readinessLead: 'Hanya <em>nama</em> variabel, nilainya tidak pernah ditampilkan.',
  toDashboard: 'ke dasbor',
  database: 'Basis data',
  dbReady: (t, m) => `siap — ${t} tabel, ${m} migrasi`,
  dbUnreachable: 'tidak dapat dijangkau',
  dbUnconfigured: 'belum dikonfigurasi',
  colSource: 'Sumber',
  colState: 'Status',
  colWhatFor: 'Untuk apa',
  connected: 'tersambung',
  missing: 'belum ada',
  sourceNotes: {
    elev8: 'kamar dan tempat tidur per listing — band kohort; dan pemetaan kanal yang menghubungkan listing OTA dengan milik kita',
    pricelabs: 'kalender harga ke depan yang diarsipkan setiap malam, kisi performa terhadap pasar masing-masing listing, dan pemesanan terealisasi beserta komisi OTA-nya',
    pricelabsMarket: 'tolok ukur kohort: berapa pendapatan listing seukuran ini di pasar ini, ditanya lewat koordinat dan jumlah kamar tidur \u2014 kunci terpisah dari yang di atas',
    channex: 'diakses melalui Elev8, yang mem-proxy-nya sepenuhnya — tidak perlu kunci terpisah',
    mdv: 'API HTTP langsung; refresh token disimpan di basis data karena token itu berotasi',
  },
  redirectUriLabel: 'Redirect URI untuk pendaftaran aplikasi:',
  tenantLabel: 'Tenant',
  grantNone: 'belum ada izin yang tersimpan',
  grantLive: r => `izin aktif, sudah ${r} kali rotasi`,
  grantRevoked: 'izin dicabut — diperlukan token yang baru diterbitkan; menanam ulang token lama tidak akan berhasil',
  grantStale: 'token yang tersimpan tertinggal dari rantai — izinnya sendiri masih hidup. '
    + 'Token refresh terkini di MDV_SEED_REFRESH_TOKEN akan diambil pada boot berikutnya.',
  authoriseNow: 'otorisasi sekarang',
  grantReplace: 'ganti izin ini',
  grantReplaceCaution: 'Hanya perlu jika izin mati. Ini memulai otorisasi baru dan, jika berhasil, refresh token baru menggantikan yang tersimpan — izin yang sekarang tetap berfungsi sampai saat itu. Akan gagal dengan <code>invalid_redirect_uri</code> kecuali redirect URI di atas terdaftar untuk klien ini, dan itu tidak terjadi jika penyedia menerbitkan izin secara langsung.',
  authBlockedNoAllowlist: 'otorisasi terkunci selama belum ada cara masuk yang dikonfigurasi',
  signIn: 'Cara masuk',
  signInActive: 'aktif',
  signInMicrosoft: 'Microsoft 365 (Entra ID)',
  signInMailLink: mode => `tautan email lewat <code>${mode}</code>`,
  admittedCount: n => `${n} alamat`,
  admittedGroups: n => `anggota dari ${n} grup Microsoft 365`,
  admittedLead: what => `Diizinkan: ${what}.`,
  admittedAnd: 'dan',
  admittedEveryGateApplies: 'Setiap syarat yang tercantum harus terpenuhi — jadi menambah satu syarat hanya bisa mempersempit akses.',
  admittedWholeTenant: 'Diizinkan: <b>semua orang</b> di tenant Elev8-Suite — <code>ALLOWED_EMAILS</code> mempersempitnya.',
  signInOff: 'mati',

  importHeading: 'Impor objek',
  importLead: 'Membaca objek ke dalam portofolio. Elev8 membawa listing beserta kamarnya dan pemetaan kanal ke OTA; MyDataValue membawa objek Booking dan Airbnb. Aman dijalankan ulang: objek yang sudah dikenal tidak memakan biaya, jadi hanya yang baru atau yang masih belum bisa ditempatkan yang diambil.',
  importStart: 'Mulai impor',
  importNever: 'Belum ada impor yang dijalankan.',
  importRunningSince: when => `Berjalan sejak ${when}. Halaman ini menyegarkan dirinya sendiri setiap beberapa detik sampai selesai.`,
  importFinishedAt: when => `Selesai ${when}.`,
  importCounts: (created, known, unresolved) =>
    `${created} objek baru, ${known} sudah dikenal, ${unresolved} tidak dapat ditempatkan.`,
  importFailedWith: reason => `Gagal: ${reason}`,
  importBusy: 'Sebuah impor sedang berjalan. Tidak ada yang dimulai dua kali.',
  importNeedsMdv: 'MyDataValue belum dikonfigurasi, jadi tidak ada sumber untuk diimpor. Diperlukan <code>MDV_CLIENT_ID</code> dan <code>MDV_CLIENT_SECRET</code>.',
  importDemoStillOn: '<b>Data demonstrasi masih aktif.</b> Objek sungguhan dan baris <code>[Demo]</code> akan berdampingan sampai <code>SEED_DEMO</code> dihapus atau diisi selain <code>true</code> dan layanan dimulai ulang.',
  importRefresh: 'muat ulang',
  importBack: 'kembali ke kesiapan',

  noticeAuthBlocked: 'Otorisasi terkunci',
  noticeAuthBlockedBody: 'Selama belum ada cara masuk yang dikonfigurasi, rute ini tetap tertutup. Kalau tidak, siapa pun yang punya URL-nya bisa menitipkan izin MyDataValue milik orang lain di sini.',
  noticeMissingVars: 'Ada variabel yang belum diisi',
  noticeMissingVarsBody: names => `Mohon isi di Railway: ${names}.`,
  noticeMdvRefused: 'MyDataValue menolak',
  noticeMdvRefusedBody: code => `Penyedia melaporkan <code>${code}</code>.`,
  noticeMdvConnected: 'MyDataValue tersambung',
  noticeMdvConnectedBody: 'Refresh token sekarang tersimpan di basis data dan berotasi di sana. <code>MDV_SEED_REFRESH_TOKEN</code> tidak dibaca lagi dan boleh dibiarkan kosong.',
  noticeClientRegistered: 'Klien terdaftar',
  noticeClientRegisteredBody: clientId =>
    `Layanan ini kini punya klien sendiri, <code>${clientId}</code>. Otorisasikan sekali dan `
    + 'izinnya terpisah dari layanan lain di akun ini.',
  noticeRegisterFailed: 'Pendaftaran klien gagal',
  clientOwn: clientId =>
    `memakai klien milik sendiri (${clientId}) — izinnya tidak dibagi dengan apa pun`,
  clientShared: clientId =>
    `memakai klien dari konfigurasi (${clientId}), yang DIBAGI. MyDataValue memutar token `
    + 'refresh setiap kali dipakai, jadi layanan yang menyegarkan terakhir meninggalkan yang '
    + 'lain memegang token terpakai. Daftarkan klien sendiri untuk mengakhirinya.',
  clientNone: 'tidak ada klien sama sekali: belum terdaftar dan MDV_CLIENT_ID tidak diset',
  clientRegisterAction: 'Daftarkan klien sendiri',
  clientSharedCaution: 'Mendaftar menggantikan pendaftaran saat ini dan meninggalkan izinnya.',
  noticeStartFailed: 'Otorisasi tidak dapat dimulai',
  noticeStartFailedBody: 'Metadata penyedia tidak dapat dibaca. Detailnya ada di log deploy.',
  noticeAuthFailed: 'Otorisasi gagal',
  noticeAuthFailedBody: 'Kode ditolak atau sudah pernah dipakai. Silakan mulai lagi di <code>/auth/mdv</code>. Alasannya ada di log deploy.',
  noticeSsoUnconfigured: 'Cara masuk belum dikonfigurasi',
  noticeSsoUnconfiguredBody: 'Di Railway belum ada <code>ENTRA_CLIENT_ID</code>, <code>ENTRA_CLIENT_SECRET</code> atau <code>PUBLIC_BASE_URL</code>.',
}

const table: Record<Lang, Strings> = { en, id }
export const LANGS = Object.keys(table) as Lang[]
export const langCookie = 're_lang'
/** A preference, not a credential: readable by the page, kept for a year. */
export const langCookieMaxAge = 365 * 24 * 3600

const isLang = (v: string | null | undefined): v is Lang =>
  v === 'en' || v === 'id'

/**
 * Resolves the language for one request.
 *
 * An explicit choice beats a remembered one, a remembered one beats the browser,
 * and the browser beats the default. Indonesian is matched on the primary
 * subtag, so id-ID and plain id both land correctly; English is the fallback
 * because it is the one both sides of the portfolio share.
 */
export function pickLang(req: {
  query?: string | null
  cookie?: string | undefined
  acceptLanguage?: string | undefined
}): Lang {
  if (isLang(req.query)) return req.query
  if (isLang(req.cookie)) return req.cookie
  for (const part of (req.acceptLanguage ?? '').split(',')) {
    const tag = part.split(';')[0]?.trim().toLowerCase() ?? ''
    const primary = tag.split('-')[0]
    if (primary === 'id' || primary === 'in') return 'id'   // "in" is the retired ISO code
    if (primary === 'en') return 'en'
  }
  return 'en'
}

export const stringsFor = (lang: Lang): Strings => table[lang]

/** The other language, for a two-state switch. */
export const otherLang = (lang: Lang): Lang => (lang === 'en' ? 'id' : 'en')
