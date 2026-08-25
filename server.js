'use strict';

const path = require('path');
const express = require('express');
const {
  routingContextMiddleware,
  cookieHeaderValue,
  downstreamHeaders,
  downstreamFetch,
  asReportedMap,
} = require('./src/routing-context');

const LAYER = 'bag-ui';
// Fed by the downward API from the pod's `version` label in Kubernetes.
const VERSION = process.env.APP_VERSION || '1.0';
const INSTANCE = process.env.POD_NAME || process.env.HOSTNAME || 'local';

// CONSTANT and version-agnostic. One Kubernetes Service fronts every bag-xapi version; the
// sidecar picks the subset from the propagated bag_orch cookie. The env override exists only so
// the app can run outside a cluster, never to select a version.
const XAPI_BASE_URL = process.env.BAG_XAPI_URL || 'http://bag-xapi:8080';
const PORT = Number(process.env.PORT || 8080);

const app = express();
app.disable('x-powered-by');

app.use(routingContextMiddleware);

// Stamp this pod's identity on every response, so the serving UI version is visible even when
// the page fails to load anything else.
app.use((req, res, next) => {
  res.set('x-bag-ui-version', VERSION);
  res.set('x-bag-ui-instance', INSTANCE);
  next();
});

app.get('/health', (req, res) => {
  res.json({ status: 'UP', layer: LAYER, version: VERSION, instance: INSTANCE });
});

/** Identity of the UI pod that served this page, available even if the API chain is down. */
app.get('/api/ui', (req, res) => {
  res.json({
    layer: LAYER,
    version: VERSION,
    instance: INSTANCE,
    routingContextReceived: asReportedMap(req.routingContext),
  });
});

/**
 * Server-side proxy to the orchestration layer.
 *
 * This is the hop that matters: the browser's cookies are turned into headers on an outbound
 * call so the sidecar can route it. Note the URL below contains no version — it never changes,
 * whichever version of bag-xapi the user has pinned.
 */
app.get('/api/bags', async (req, res) => {
  const context = req.routingContext;
  const url = `${XAPI_BASE_URL}/api/bags`;
  const forwarded = downstreamHeaders(context);

  const envelope = {
    ui: { layer: LAYER, version: VERSION, instance: INSTANCE },
    routingContextReceived: asReportedMap(context),
    routingContextForwarded: cookieHeaderValue(context),
    forwardedHeaders: forwarded,
    downstream: { layer: 'bag-xapi', url },
  };

  try {
    const response = await downstreamFetch(url, context);
    const body = await response.json();

    // The header is stamped by the pod that actually served the call — the authoritative answer
    // to "which bag-xapi version did I reach?".
    const xapiVersion = response.headers.get('x-bag-xapi-version') || body.version || null;
    const backend = body.downstream || {};

    envelope.downstream.status = response.ok ? 'OK' : 'ERROR';
    envelope.downstream.httpStatus = response.status;
    envelope.downstream.version = xapiVersion;
    envelope.downstream.body = body;

    envelope.chain = [
      {
        layer: 'bag-ui',
        cookie: 'bag_fed',
        routedBy: 'Istio ingress gateway VirtualService',
        requestedVersion: context.cookies.bag_fed ?? null,
        servingVersion: VERSION,
        instance: INSTANCE,
      },
      {
        layer: 'bag-xapi',
        cookie: 'bag_orch',
        routedBy: 'bag-ui sidecar, bag-xapi VirtualService',
        requestedVersion: context.cookies.bag_orch ?? null,
        servingVersion: xapiVersion,
        instance: body.instance ?? null,
      },
      {
        layer: 'bag-service',
        cookie: 'bag_service',
        routedBy: 'bag-xapi sidecar, bag-service VirtualService',
        requestedVersion: context.cookies.bag_service ?? null,
        servingVersion: backend.version ?? null,
        instance: backend.instance ?? null,
      },
    ];

    // What each layer reported receiving: the end-to-end propagation proof.
    envelope.propagation = [
      { layer: 'bag-ui', received: asReportedMap(context) },
      { layer: 'bag-xapi', received: body.routingContextReceived ?? null },
      { layer: 'bag-service', received: backend.routingContextReceived ?? null },
    ];

    envelope.currency = body.currency ?? 'USD';
    envelope.itemCount = body.itemCount ?? 0;
    envelope.subtotal = body.subtotal ?? 0;
    envelope.promotion = body.promotion ?? null;
    envelope.total = body.total ?? body.subtotal ?? 0;
    envelope.estimatedDelivery = body.estimatedDelivery ?? null;
    envelope.items = body.items ?? [];

    res.status(response.ok ? 200 : 502).json(envelope);
  } catch (err) {
    envelope.downstream.status = 'ERROR';
    envelope.downstream.error = `${err.name}: ${err.message}`;
    envelope.chain = [
      { layer: 'bag-ui', cookie: 'bag_fed', requestedVersion: context.cookies.bag_fed ?? null, servingVersion: VERSION, instance: INSTANCE },
      { layer: 'bag-xapi', cookie: 'bag_orch', requestedVersion: context.cookies.bag_orch ?? null, servingVersion: null, instance: null },
      { layer: 'bag-service', cookie: 'bag_service', requestedVersion: context.cookies.bag_service ?? null, servingVersion: null, instance: null },
    ];
    envelope.propagation = [{ layer: 'bag-ui', received: asReportedMap(context) }];
    envelope.items = [];
    res.status(502).json(envelope);
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`[${LAYER}] version=${VERSION} instance=${INSTANCE} listening on :${PORT}, downstream=${XAPI_BASE_URL}`);
});
