'use strict';

/**
 * Routing context capture and propagation for bag-ui.
 *
 * bag-ui is the first hop that sees the browser's cookies and the only one that can put them onto
 * the wire for the rest of the chain. It never interprets them: which version of bag-xapi answers
 * is decided by that hop's Istio VirtualService, matching on the values forwarded here.
 */

/** Pins the version of bag-ui (matched by the ingress gateway, not by this app). */
const COOKIE_FED = 'bag_fed';
/** Pins the version of bag-xapi. */
const COOKIE_ORCH = 'bag_orch';
/** Pins the version of bag-service. */
const COOKIE_SERVICE = 'bag_service';

const ROUTING_COOKIES = [COOKIE_FED, COOKIE_ORCH, COOKIE_SERVICE];

/** Header form of each routing cookie; a VirtualService can match either form. */
const HEADER_FOR_COOKIE = {
  [COOKIE_FED]: 'x-bag-fed',
  [COOKIE_ORCH]: 'x-bag-orch',
  [COOKIE_SERVICE]: 'x-bag-service',
};

/** Propagated so Istio/Kiali can stitch the hops into a single trace. */
const TRACE_HEADERS = [
  'x-request-id',
  'x-b3-traceid',
  'x-b3-spanid',
  'x-b3-parentspanid',
  'x-b3-sampled',
  'x-b3-flags',
  'b3',
  'traceparent',
  'tracestate',
  'x-ot-span-context',
];

function parseCookieHeader(header) {
  const jar = {};
  if (!header) return jar;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name) jar[name] = decodeURIComponent(value);
  }
  return jar;
}

/**
 * Express middleware: captures the routing context onto `req.routingContext`.
 * Routing cookies win; their header form is a fallback for non-browser callers.
 */
function routingContextMiddleware(req, res, next) {
  const jar = parseCookieHeader(req.headers.cookie);
  const cookies = {};
  for (const name of ROUTING_COOKIES) {
    const fromCookie = jar[name];
    const fromHeader = req.headers[HEADER_FOR_COOKIE[name]];
    const value = fromCookie || fromHeader;
    if (value && String(value).trim() !== '') cookies[name] = String(value).trim();
  }

  const traceHeaders = {};
  for (const name of TRACE_HEADERS) {
    const value = req.headers[name];
    if (value) traceHeaders[name] = Array.isArray(value) ? value[0] : value;
  }

  req.routingContext = { cookies, traceHeaders };
  next();
}

/**
 * Rebuilds a Cookie header from the routing cookies only. Session, analytics and consent cookies
 * are deliberately dropped — internal services have no business seeing them.
 */
function cookieHeaderValue(context) {
  return ROUTING_COOKIES.filter((name) => context.cookies[name])
    .map((name) => `${name}=${context.cookies[name]}`)
    .join('; ');
}

/**
 * The headers every downstream call must carry. Used by `downstreamFetch` so propagation is a
 * property of the client, not something each call site has to remember.
 */
function downstreamHeaders(context) {
  const headers = {};
  const cookie = cookieHeaderValue(context);
  if (cookie) headers.cookie = cookie;
  for (const [name, value] of Object.entries(context.cookies)) {
    headers[HEADER_FOR_COOKIE[name]] = value;
  }
  Object.assign(headers, context.traceHeaders);
  return headers;
}

/** All three cookies, null where unset — the propagation proof shown in the UI. */
function asReportedMap(context) {
  const out = {};
  for (const name of ROUTING_COOKIES) out[name] = context.cookies[name] ?? null;
  return out;
}

/** fetch() with routing propagation and a timeout, for every server-side downstream call. */
async function downstreamFetch(url, context, { timeoutMs = 5000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      headers: { accept: 'application/json', ...downstreamHeaders(context) },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  COOKIE_FED,
  COOKIE_ORCH,
  COOKIE_SERVICE,
  ROUTING_COOKIES,
  HEADER_FOR_COOKIE,
  routingContextMiddleware,
  cookieHeaderValue,
  downstreamHeaders,
  downstreamFetch,
  asReportedMap,
};
