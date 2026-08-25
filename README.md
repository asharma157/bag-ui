# Cookie-Based Per-Layer Version Routing — POC

A 3-tier retail "bag" application where **every developer can pin their own version of any
layer, in a shared staging cluster, without affecting anybody else's traffic.**

Three browser cookies — one per layer — select which version serves each hop:

| Cookie | Pins | Example | Effect |
|---|---|---|---|
| `bag_fed` | `bag-ui` | `bag_fed=feature1` | the ingress gateway routes you to bag-ui `feature1` |
| `bag_orch` | `bag-xapi` | `bag_orch=2.3` | your calls to the orchestration layer hit version `2.3` |
| `bag_service` | `bag-service` | `bag_service=1.10` | your calls to the backend hit version `1.10` |

An unset cookie means that layer serves whichever version currently takes 100% of default
traffic. The cookies are independent: Dev A pinning `bag_service=1.10` and Dev B pinning
`bag_orch=2.3` at the same time see completely different chains, and every other user keeps
getting the default versions.

---

## What this POC actually proves

Two separate things, and it is worth keeping them apart:

1. **The mesh can route per layer from a cookie.** No application code selects a version. One
   Kubernetes Service per app fronts every version of that app; Istio slices it into subsets by
   the pod's `version` label and picks one per request.
2. **The apps propagate the routing context.** This is the part that does *not* work in the
   enterprise apps today, and the part the mesh cannot do for you. Envoy does **not** copy
   application headers from an inbound request onto a new outbound one. If bag-xapi drops the
   `bag_service` cookie when it calls the backend, that hop's sidecar has nothing to match on and
   silently falls through to the default version — the chain un-pins itself one hop short and
   looks like it "sometimes works".

Point 2 is what `docker compose` validates locally. Point 1 needs the mesh.

---

## Layout — three repositories

Each layer is its own repository, so each has its own CI pipeline, its own image, its own release
cadence, and can be deployed without touching the other two. Clone them side by side:

```
bag-poc/
├── bag-ui/        Node.js / Express      — serves the page, proxies to bag-xapi
├── bag-xapi/      Java 17 / Spring Boot  — GET /api/bags, calls bag-service
└── bag-service/   Java 17 / Spring Boot  — hardcoded bag contents
```

The cross-cutting demo material — this README, `docker-compose.yml`, `verify-propagation.sh` —
lives in **bag-ui**, the entry point. None of it is a deployment artifact; compose reaches the
other two through relative build contexts (`../bag-xapi`, `../bag-service`), which is the only
thing that assumes the side-by-side layout. Each app's own pipeline never looks outside its repo.

```
bag-ui/                                   ← this repo
├── server.js                             request handling + the outbound proxy call
├── src/routing-context.js                capture + propagation (the routing code)
├── public/                               the demo page (cookie controls, chain, items)
├── Dockerfile
├── k8s/           deployment-1-0.yaml, deployment-feature1.yaml, service.yaml
├── docker-compose.yml                    local propagation validation (all three apps)
├── verify-propagation.sh                 scripted four-scenario check (local or GKE)
└── README.md                             the whole POC, documented here

bag-xapi/
├── src/main/java/com/example/bagxapi/
│   ├── routing/RoutingContextFilter.java          inbound capture
│   ├── routing/RoutingPropagationInterceptor.java outbound replay  ← the fix
│   ├── config/DownstreamConfig.java               RestTemplate w/ interceptor
│   ├── service/BagAggregationService.java         backend call + orchestration
│   └── web/BagController.java
├── Dockerfile
└── k8s/           deployment-2-2.yaml, deployment-2-3.yaml, service.yaml

bag-service/
├── src/main/java/com/example/bagservice/
│   ├── service/BagService.java   the one service: hardcoded item lists per version
│   └── web/BagController.java    the one controller: /api/bags, /health
├── Dockerfile
└── k8s/           deployment-1-9.yaml, deployment-1-10.yaml, deployment-feature1.yaml, service.yaml
```

No database, no auth, no persistent state. Every app exposes `/health`.

### Versions shipped

| App | Versions | Default | What differs |
|---|---|---|---|
| `bag-ui` | `1.0`, `feature1` | `1.0` | version chip + accent colour on the page |
| `bag-xapi` | `2.2`, `2.3` | `2.2` | `2.3` applies a `MEMBER10` 10% discount and quotes a delivery date |
| `bag-service` | `1.9`, `1.10`, `feature1` | `1.9` | different item lists: 3 items / $467.00, 4 items / $662.00, 2 monogram items |

---

## The routing model

### Service URLs are constant and version-agnostic

```
bag-ui   ──►  http://bag-xapi:8080/api/bags      (always, for every version)
bag-xapi ──►  http://bag-service:8080/api/bags   (always, for every version)
```

There is **one** Kubernetes Service per app, selecting on `app: <service>` only — never on
`version` — so it spans all versions of that app. No per-version Service, no URL rewriting, no
dynamic hostname resolution anywhere in application code. Version selection happens entirely in
the mesh.

### Per hop

| Hop | Cookie | Who routes it |
|---|---|---|
| browser → `bag-ui` | `bag_fed` | Istio ingress gateway + the `bag-ui` VirtualService |
| `bag-ui` → `bag-xapi` | `bag_orch` | the sidecar on the **bag-ui** pod, evaluating the `bag-xapi` VirtualService |
| `bag-xapi` → `bag-service` | `bag_service` | the sidecar on the **bag-xapi** pod, evaluating the `bag-service` VirtualService |

Each app's pods carry `app: <service>` and `version: <version>` labels. A DestinationRule per app
defines subsets keyed on `version`; a VirtualService per app matches the routing cookie by regex
on the `cookie` header and routes to that subset. The final catch-all route (no cookie match)
points at the version designated as default.

**VirtualService and DestinationRule manifests are deliberately not part of this repo.** Routing
rules are managed separately — by the routing controller or through Kiali's request-routing
wizard — so they can change without redeploying an app. See
[Appendix: reference routing rules](#appendix-reference-routing-rules) for the shape they take.

---

## Header propagation — the only routing duty the apps have

Each app forwards the routing context it received, unchanged, on every outbound call. It never
inspects a value to make a decision; it only carries it.

What is forwarded:

- a rebuilt `Cookie` header containing **only** `bag_fed`, `bag_orch` and `bag_service` — the
  browser's session, analytics and consent cookies are dropped and never reach an internal service
- `x-bag-fed`, `x-bag-orch`, `x-bag-service` — the same values in header form, so a VirtualService
  can match either, and so curl or a test harness can pin a version without faking a cookie jar
- the B3 / W3C tracing headers, so Kiali can draw the browser-to-backend chain as one trace

It is implemented once per app, on the client, not at each call site:

| App | Inbound capture | Outbound replay |
|---|---|---|
| `bag-ui` | `routingContextMiddleware` in `src/routing-context.js` | `downstreamFetch` / `downstreamHeaders` in the same file |
| `bag-xapi` | `RoutingContextFilter` | `RoutingPropagationInterceptor`, registered on the shared `RestTemplate` in `DownstreamConfig` |
| `bag-service` | `RoutingContextFilter` | n/a — last hop; it echoes what it received so propagation is provable end to end |

Every layer also stamps its own identity on every response — `x-bag-ui-version`,
`x-bag-xapi-version`, `x-bag-service-version` (plus `-instance`) — sourced from the pod's
`version` label via the downward API. Nothing in the demo page is inferred; each layer reports
itself.

---

## Run it locally first

Clone the three repos side by side, then bring the stack up from `bag-ui`:

```bash
mkdir bag-poc && cd bag-poc
git clone https://github.com/asharma157/bag-ui.git      bag-ui
git clone https://github.com/asharma157/bag-xapi.git    bag-xapi
git clone https://github.com/asharma157/bag-service.git bag-service

cd bag-ui
docker compose up --build
```

Then open <http://localhost:8080>.

```bash
./verify-propagation.sh
```

Expected local output — the cookie values reach **every** layer, while the serving versions stay
on the defaults:

```
── Dev A pins only the backend
   Cookie: bag_service=1.10
   layer          requested    serving      received bag_fed/bag_orch/bag_service
   bag-ui         -            1.0          -/-/1.10
   bag-xapi       -            2.2          -/-/1.10
   bag-service    1.10         1.9          -/-/1.10
```

That is the correct local result. **Compose has no mesh, so nothing can act on the cookie** — the
demo page marks the mismatch in amber (`1.9 ≠ 1.10`). What compose proves is the propagation
column: `1.10` arriving intact at all three layers means every outbound client forwards the
context. The two backend versions run side by side so you can see they really differ:

```bash
curl -s localhost:8082/api/bags | jq '{version, itemCount, subtotal}'   # 1.9  — the default
curl -s localhost:8083/api/bags | jq '{version, itemCount, subtotal}'   # 1.10 — the candidate
```

| Port | Container |
|---|---|
| 8080 | `bag-ui` 1.0 |
| 8081 | `bag-xapi` 2.2 |
| 8082 | `bag-service` 1.9 — holds the `bag-service` network alias, so it is what the chain reaches |
| 8083 | `bag-service` 1.10 — reachable directly, nothing routes to it without a mesh |

### Without Docker

The apps are ordinary processes; the constant hostnames are overridable purely so they can run
off-cluster (`BAG_XAPI_URL`, `BAG_SERVICE_URL`). Nothing else changes between local and cluster.

From the `bag-poc` directory holding all three clones:

```bash
(cd bag-service && mvn -q package -DskipTests)
(cd bag-xapi    && mvn -q package -DskipTests)
(cd bag-ui      && npm ci)

APP_VERSION=1.9 java -jar bag-service/target/bag-service-0.0.1-SNAPSHOT.jar --server.port=8082 &
APP_VERSION=2.2 BAG_SERVICE_URL=http://localhost:8082 \
  java -jar bag-xapi/target/bag-xapi-0.0.1-SNAPSHOT.jar --server.port=8081 &
APP_VERSION=1.0 BAG_XAPI_URL=http://localhost:8081 PORT=8080 node bag-ui/server.js &
```

---

## Deploy to GKE

### 1. Project, registry, cluster

```bash
export PROJECT_ID=$(gcloud config get-value project)
export REGION=us-central1
export ZONE=us-central1-a
export REPO=$REGION-docker.pkg.dev/$PROJECT_ID/bag-poc

gcloud services enable container.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com
gcloud artifacts repositories create bag-poc --repository-format=docker --location=$REGION
```

One zonal Standard cluster on two small spot nodes — the cheapest shape that still fits istiod,
an ingress gateway, Kiali, Prometheus and seven app pods with sidecars:

```bash
gcloud container clusters create bag-poc \
  --zone $ZONE \
  --num-nodes 2 \
  --machine-type e2-standard-2 \
  --spot \
  --disk-size 50 \
  --disk-type pd-balanced \
  --no-enable-autoupgrade

gcloud container clusters get-credentials bag-poc --zone $ZONE
```

### 2. Istio + Kiali

```bash
curl -L https://istio.io/downloadIstio | sh -
cd istio-*/ && export PATH=$PWD/bin:$PATH

istioctl install --set profile=default -y          # istiod + istio-ingressgateway
kubectl apply -f samples/addons/prometheus.yaml    # Kiali needs it for the graph
kubectl apply -f samples/addons/kiali.yaml
kubectl -n istio-system rollout status deploy/kiali
```

Namespace with sidecar injection — without the label there are no sidecars and no routing:

```bash
kubectl create namespace bag
kubectl label namespace bag istio-injection=enabled
```

### 3. Build and push

Each repo builds itself, from its own root — this is the one command an app's CI pipeline runs,
and it never reaches outside the repo. Cloud Build is the simplest path (and avoids the
architecture trap below):

```bash
(cd bag-ui      && gcloud builds submit . --tag $REPO/bag-ui:1.0)
(cd bag-xapi    && gcloud builds submit . --tag $REPO/bag-xapi:2.2)
(cd bag-service && gcloud builds submit . --tag $REPO/bag-service:1.9)
```

Each app's image reads its version from `APP_VERSION` at runtime, so one build can serve as
several versions — enough for the POC, and it keeps the free trial cheap:

```bash
gcloud artifacts docker tags add $REPO/bag-ui:1.0      $REPO/bag-ui:feature1
gcloud artifacts docker tags add $REPO/bag-xapi:2.2    $REPO/bag-xapi:2.3
gcloud artifacts docker tags add $REPO/bag-service:1.9 $REPO/bag-service:1.10
gcloud artifacts docker tags add $REPO/bag-service:1.9 $REPO/bag-service:feature1
```

> In a real pipeline each version is a distinct build of a distinct source revision, and the
> version-keyed item lists inside `BagService` would just be the difference between two commits.
> The behaviour that varies by version is driven by `APP_VERSION` only so this POC can demonstrate
> several versions from one build.

Building locally instead? On Apple Silicon you **must** cross-build, or the pods will crash-loop
with `exec format error` on GKE's amd64 nodes:

```bash
gcloud auth configure-docker $REGION-docker.pkg.dev
cd bag-service && docker buildx build --platform linux/amd64 -t $REPO/bag-service:1.9 --push .
```

### 4. Deploy

Each repo owns its manifests and applies them independently — deploying bag-service touches
nothing belonging to bag-ui or bag-xapi:

```bash
cd bag-service
sed -i.bak "s#us-central1-docker.pkg.dev/PROJECT_ID/bag-poc#$REPO#g" k8s/deployment-*.yaml
kubectl apply -f k8s/
```

For a first bring-up, all three at once from the directory holding the clones:

```bash
sed -i.bak "s#us-central1-docker.pkg.dev/PROJECT_ID/bag-poc#$REPO#g" */k8s/deployment-*.yaml
kubectl apply -f bag-service/k8s/ -f bag-xapi/k8s/ -f bag-ui/k8s/
kubectl -n bag get pods -o wide
```

Every pod should show `2/2` — the app plus its Envoy sidecar. `1/1` means injection did not
happen; check the namespace label and restart the deployments.

```bash
kubectl -n bag get pods -L version
```

### 5. Routing rules

The rules live outside this repo. Create them with **Kiali's request-routing wizard**, once per
app:

1. `istioctl dashboard kiali`
2. **Services → `bag-service` → Actions → Request Routing**
3. **Add Route Rule** → **Request Matching** → header `cookie`, match `regex`,
   value `.*bag_service=1\.10(;.*)?` → route to subset `1.10` → **Add Rule**
4. Repeat for `feature1`
5. Add a final rule with no matching, routing 100% to `1.9` — this is the catch-all, and it must
   be **last**; Istio evaluates rules in order and the first match wins
6. **Create**

Then the same for `bag-xapi` (`bag_orch` → `2.3`, catch-all `2.2`) and for `bag-ui` (`bag_fed` →
`feature1`, catch-all `1.0`). For `bag-ui`, open the wizard's **Advanced Options → Gateways** and
attach it to the ingress gateway so the rule applies to browser traffic.

Kiali writes the DestinationRules and VirtualServices for you and shows them under
**Istio Config**, where you can also validate them. The equivalent YAML, if you prefer to read
it or hand it to a routing controller, is in the [appendix](#appendix-reference-routing-rules).

Get the entry point:

```bash
kubectl -n istio-system get svc istio-ingressgateway -o jsonpath='{.status.loadBalancer.ingress[0].ip}'
```

---

## Demo: three developers, one cluster

Open `http://<GATEWAY_IP>/` in a browser. The page shows the current cookie values, which version
of each layer served the request, what each layer received, and the bag contents.

**Baseline — nobody has pinned anything.** Clear all cookies. The chain reads
`bag-ui 1.0 → bag-xapi 2.2 → bag-service 1.9`, three items, $467.00. This is what every ordinary
user of the staging environment sees, throughout everything below.

**Dev A tests a backend change.** Set `bag_service` to `1.10`, leave the others empty. The chain
becomes `1.0 → 2.2 → 1.10`: four items, $662.00, a Weekender Duffel appears, the tote is
repriced. The UI and orchestration versions did not move.

**Dev B tests an orchestration change, at the same time.** In a different browser (or a private
window), set only `bag_orch` to `2.3`. That session reads `1.0 → 2.3 → 1.9`: the same three items
as the baseline, but now with a `MEMBER10` discount and a delivery estimate. Dev B does not see
Dev A's backend, Dev A does not see Dev B's promotion, and the baseline window still shows
$467.00 with no discount.

**Dev C pins the whole chain.** Set all three: `bag_fed=feature1`, `bag_orch=2.3`,
`bag_service=feature1`. The page reloads (the UI version is chosen at the gateway, before the
page is served), the accent colour changes, the chip reads `feature1`, and the chain is
`feature1 → 2.3 → feature1`.

Scripted equivalent, running all four scenarios against the cluster:

```bash
./verify-propagation.sh http://<GATEWAY_IP>
```

On GKE the `serving` column follows the `requested` column. Any amber `x ≠ y` in the page means
the cookie was carried correctly but no route matched it — a missing subset or rule, not an app
bug. Single curl:

```bash
curl -s -H 'Cookie: bag_service=1.10' http://<GATEWAY_IP>/api/bags \
  | jq '{chain, propagation}'
```

In Kiali's **Graph** (namespace `bag`, "Versioned app graph"), each request lights up the edges
into the specific version subsets that served it.

---

## Adding a version

The developer workflow this POC is arguing for:

1. Build and push `bag-service:feature2` from the feature branch.
2. In the same repo, copy `k8s/deployment-1-10.yaml` to `k8s/deployment-feature2.yaml`, set the name to
   `bag-service-feature2`, the `version` label to `feature2` (three places) and the image tag.
   Apply it. Nothing else changes — the Service already spans every version, and the app picks up
   its `APP_VERSION` from the label.
3. Add a subset and a matching rule for `feature2` in Kiali. The catch-all stays where it is, so
   default traffic never moves.
4. Share `bag_service=feature2` with whoever needs to test it.
5. Delete the Deployment and the rule when the branch merges.

Promoting a version to default is one edit to the catch-all route — no redeploy of anything.

---

## Notes and limitations

- **Compose proves propagation, not routing.** Cookie-based version selection only works in-mesh.
- **The cookies are not a security boundary.** Anyone who can reach the gateway can pin any
  deployed version. This is a staging pattern; do not carry it to production without gating the
  match (e.g. also requiring an authenticated internal identity).
- **Propagation is synchronous.** `bag-xapi` and `bag-service` hold the routing context in a
  ThreadLocal, which is valid because every request is handled on one servlet thread. Going
  reactive, or handing work to an executor, means replacing that holder with real context
  propagation — the interceptor above it stays as-is.
- **Port names matter.** Every Service port is named `http`. Rename it and Envoy treats the
  traffic as opaque TCP, and cookie matching stops working with no error anywhere.
- **A cookie naming a version that is not deployed** falls through to the catch-all and serves the
  default. The page flags it in amber rather than failing, which is usually what you want in
  staging, but it does mean a typo looks like "my feature didn't deploy".
- **Where this fits the existing stack.** The per-version Deployments are ordinary manifests —
  they drop into ArgoCD/Helm exactly like today's blue/green ones, with `version` as the only new
  convention. The nginx-ingress path stays untouched; the Istio gateway is added alongside it.
  Routing rules stay out of the app repos on purpose: a developer testing a feature should not
  need a merge to a deployment repo to get traffic.

## Teardown

```bash
gcloud container clusters delete bag-poc --zone $ZONE
gcloud artifacts repositories delete bag-poc --location=$REGION
```

---

## Appendix: reference routing rules

Not part of the deliverable — routing is managed by the routing controller or Kiali. Included so
the demo is reproducible and so the rule shape is reviewable.

```yaml
# Ingress entry point.
apiVersion: networking.istio.io/v1
kind: Gateway
metadata:
  name: bag-gateway
  namespace: bag
spec:
  selector:
    istio: ingressgateway
  servers:
    - port:
        number: 80
        name: http
        protocol: HTTP
      hosts: ["*"]
---
# Subsets are built from the pod `version` label — the same label the downward API feeds to the app.
apiVersion: networking.istio.io/v1
kind: DestinationRule
metadata:
  name: bag-ui
  namespace: bag
spec:
  host: bag-ui
  subsets:
    - name: v1-0
      labels: {version: "1.0"}
    - name: feature1
      labels: {version: "feature1"}
---
# Browser → bag-ui, matched at the gateway on bag_fed.
apiVersion: networking.istio.io/v1
kind: VirtualService
metadata:
  name: bag-ui
  namespace: bag
spec:
  hosts: ["*"]
  gateways: [bag-gateway]
  http:
    - name: bag_fed-feature1
      match:
        - headers:
            cookie:
              # Envoy regex matches are FULL matches on the header value, hence the leading `.*`.
              # The trailing `(;.*)?` stops `feature1` from also matching `feature10`.
              regex: ".*bag_fed=feature1(;.*)?"
      route:
        - destination: {host: bag-ui, subset: feature1}
    - name: default          # catch-all — must be last; first match wins
      route:
        - destination: {host: bag-ui, subset: v1-0}
---
apiVersion: networking.istio.io/v1
kind: DestinationRule
metadata:
  name: bag-xapi
  namespace: bag
spec:
  host: bag-xapi
  subsets:
    - name: v2-2
      labels: {version: "2.2"}
    - name: v2-3
      labels: {version: "2.3"}
---
# bag-ui → bag-xapi, evaluated by the sidecar on the bag-ui pod against the propagated bag_orch.
apiVersion: networking.istio.io/v1
kind: VirtualService
metadata:
  name: bag-xapi
  namespace: bag
spec:
  hosts: [bag-xapi]
  http:
    - name: bag_orch-2-3
      match:
        - headers:
            cookie:
              regex: ".*bag_orch=2\\.3(;.*)?"
      route:
        - destination: {host: bag-xapi, subset: v2-3}
    - name: default
      route:
        - destination: {host: bag-xapi, subset: v2-2}
---
apiVersion: networking.istio.io/v1
kind: DestinationRule
metadata:
  name: bag-service
  namespace: bag
spec:
  host: bag-service
  subsets:
    - name: v1-9
      labels: {version: "1.9"}
    - name: v1-10
      labels: {version: "1.10"}
    - name: feature1
      labels: {version: "feature1"}
---
# bag-xapi → bag-service, evaluated by the sidecar on the bag-xapi pod against the propagated
# bag_service value — the hop that only works because bag-xapi replays the context.
apiVersion: networking.istio.io/v1
kind: VirtualService
metadata:
  name: bag-service
  namespace: bag
spec:
  hosts: [bag-service]
  http:
    - name: bag_service-1-10
      match:
        - headers:
            cookie:
              regex: ".*bag_service=1\\.10(;.*)?"
      route:
        - destination: {host: bag-service, subset: v1-10}
    - name: bag_service-feature1
      match:
        - headers:
            cookie:
              regex: ".*bag_service=feature1(;.*)?"
      route:
        - destination: {host: bag-service, subset: feature1}
    - name: default
      route:
        - destination: {host: bag-service, subset: v1-9}
```

Each rule can equally match the header form the apps also send (`x-bag-service: 1.10`), which is
handy for curl-driven tests:

```yaml
      match:
        - headers:
            x-bag-service:
              exact: "1.10"
```
