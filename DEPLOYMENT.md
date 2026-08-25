# Deploying the POC

From three GitHub repos to a working cookie-routing demo on GKE.

**Read this first:** you asked in the order GitHub Actions → CI → CD → Kubernetes → GCP project
→ billing, but the dependency chain runs almost exactly backwards. CI is the only piece that
works with no cloud at all (it is already green). Everything after it needs a GCP project with
billing attached, a registry to push to, and a cluster to deploy into — in that order. The
milestones below are in the order you can actually execute them.

| # | Milestone | Time | Blocks what |
|---|---|---|---|
| 0 | [GCP project + billing](#milestone-0--gcp-project--billing) | ~10 min | everything |
| 1 | [Artifact Registry](#milestone-1--artifact-registry) | ~2 min | any image push |
| 2 | [Keyless auth: GitHub → GCP](#milestone-2--keyless-auth-from-github-to-gcp) | ~10 min | the Deploy workflow |
| 3 | [CI](#milestone-3--ci-already-done) | done | nothing |
| 4 | [GKE cluster](#milestone-4--gke-cluster) | ~10 min | any deploy |
| 5 | [Istio + Kiali](#milestone-5--istio--kiali) | ~10 min | all routing |
| 6 | [CD: first deploy](#milestone-6--cd-first-deploy) | ~10 min | the demo |
| 7 | [Routing rules](#milestone-7--routing-rules) | ~15 min | the demo |
| 8 | [Verify the demo](#milestone-8--verify-the-demo) | ~10 min | — |
| 9 | [Cost and teardown](#milestone-9--cost-and-teardown) | — | your wallet |

Set these once and keep the shell open — every milestone uses them:

```bash
export PROJECT_ID=bag-poc-$(date +%s | tail -c 5)   # must be globally unique
export REGION=us-central1
export ZONE=us-central1-a
export GITHUB_OWNER=asharma157
export CLUSTER=bag-poc
```

---

## Milestone 0 — GCP project + billing

> **TL;DR** — Create a project, attach a billing account (the free trial still requires one), and
> enable five APIs. Nothing else in this guide works until billing is linked.

```bash
gcloud auth login
gcloud projects create "$PROJECT_ID" --name="Bag Routing POC"
gcloud config set project "$PROJECT_ID"
```

Link billing. The $300 free-trial credit is attached to a billing account, and a project with no
billing account cannot create a cluster or a registry — this is the step people skip:

```bash
gcloud billing accounts list          # copy the ACCOUNT_ID of the trial account
gcloud billing projects link "$PROJECT_ID" --billing-account=XXXXXX-XXXXXX-XXXXXX
```

Enable the APIs:

```bash
gcloud services enable \
  compute.googleapis.com \
  container.googleapis.com \
  artifactregistry.googleapis.com \
  iamcredentials.googleapis.com \
  sts.googleapis.com
```

`iamcredentials` and `sts` are what make Workload Identity Federation work in Milestone 2. If you
skip them, the Deploy workflow fails at the auth step with a permission error that does not
mention either service.

**Check:** `gcloud projects describe $PROJECT_ID` returns `lifecycleState: ACTIVE`, and
`gcloud billing projects describe $PROJECT_ID` shows `billingEnabled: true`.

---

## Milestone 1 — Artifact Registry

> **TL;DR** — One Docker repository named `bag-poc` holds the images for all three apps. The
> workflows already expect that name.

```bash
gcloud artifacts repositories create bag-poc \
  --repository-format=docker \
  --location="$REGION" \
  --description="Images for the cookie routing POC"
```

Images will land at `$REGION-docker.pkg.dev/$PROJECT_ID/bag-poc/<app>:<version>` — one repository,
three apps, many version tags. There is no reason to split it per app; Artifact Registry charges
by storage, not by repository.

**Check:** `gcloud artifacts repositories list --location=$REGION` lists `bag-poc`.

---

## Milestone 2 — Keyless auth from GitHub to GCP

> **TL;DR** — Create one service account the workflows impersonate, then let GitHub prove its
> identity with a short-lived OIDC token instead of a stored JSON key. Six repo variables, set by
> script, and the Deploy workflows switch themselves on.

This is the fiddliest milestone and the one worth doing properly. The alternative — generating a
service account key and pasting the JSON into a GitHub secret — is a long-lived credential that
grants deploy rights to anyone who can read the secret, and it never expires on its own.

### The service account the workflows act as

```bash
gcloud iam service-accounts create gh-deployer \
  --display-name="GitHub Actions deployer"

export SA="gh-deployer@$PROJECT_ID.iam.gserviceaccount.com"

# Push images
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$SA" --role="roles/artifactregistry.writer"

# Manage Kubernetes objects (not cluster admin — it cannot change the cluster itself)
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:$SA" --role="roles/container.developer"
```

### The trust relationship

```bash
gcloud iam workload-identity-pools create github \
  --location=global --display-name="GitHub Actions"

gcloud iam workload-identity-pools providers create-oidc github \
  --location=global \
  --workload-identity-pool=github \
  --display-name="GitHub OIDC" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.repository_owner=assertion.repository_owner" \
  --attribute-condition="assertion.repository_owner == '$GITHUB_OWNER'"
```

**The `--attribute-condition` is not optional in spirit.** Without it, the pool trusts tokens from
*any* repository on GitHub — anyone could mint one and deploy into your project. gcloud now
refuses to create the provider without a condition when `attribute.repository` is mapped, which is
the right default.

Then allow each repo — and only each repo — to impersonate the service account:

```bash
export PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
export WIF_PROVIDER="projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github/providers/github"

for repo in bag-ui bag-xapi bag-service; do
  gcloud iam service-accounts add-iam-policy-binding "$SA" \
    --role="roles/iam.workloadIdentityUser" \
    --member="principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github/attribute.repository/$GITHUB_OWNER/$repo"
done
```

### Tell the repos where to point

The Deploy workflows read six repository variables and skip themselves entirely while
`WIF_PROVIDER` is unset — which is why adding them earlier produced no red X:

```bash
for repo in bag-ui bag-xapi bag-service; do
  gh variable set GCP_PROJECT_ID      --repo "$GITHUB_OWNER/$repo" --body "$PROJECT_ID"
  gh variable set GCP_SERVICE_ACCOUNT --repo "$GITHUB_OWNER/$repo" --body "$SA"
  gh variable set WIF_PROVIDER        --repo "$GITHUB_OWNER/$repo" --body "$WIF_PROVIDER"
  gh variable set GAR_LOCATION        --repo "$GITHUB_OWNER/$repo" --body "$REGION"
  gh variable set GKE_CLUSTER         --repo "$GITHUB_OWNER/$repo" --body "$CLUSTER"
  gh variable set GKE_LOCATION        --repo "$GITHUB_OWNER/$repo" --body "$ZONE"
done
```

These are *variables*, not secrets — none of them is sensitive, and having them visible in the
run log makes a failed deploy far easier to read.

**Check:** `gh variable list --repo $GITHUB_OWNER/bag-ui` shows all six.

---

## Milestone 3 — CI (already done)

> **TL;DR** — Nothing to do. Every push and PR already builds each app, boots it, and asserts it
> reports the version it was handed. No cloud access involved.

Each repo has `.github/workflows/ci.yml`. It runs on **every branch** and every PR:

| Step | bag-ui | bag-xapi / bag-service |
|---|---|---|
| Build | `npm ci` (fails on lockfile drift) | `mvn -B package` |
| Static check | `node --check` on all three JS files | — (compiler covers it) |
| Smoke test | boot, `GET /health`, assert `version` and `x-bag-ui-version` | boot, `GET /health`, assert `version` and `x-bag-<app>-version` |

`bag-service` additionally calls `/api/bags` with a cookie and asserts the routing context comes
back in the response. That single check is the cheapest possible regression test for the whole
propagation contract — if someone refactors the filter away, CI goes red.

The smoke test asserts on the *version the app reports*, not just that it started. A pod that
boots but misreports its version makes every routing result in the demo untrustworthy, so it is
worth failing the build over.

---

## Milestone 4 — GKE cluster

> **TL;DR** — One zonal Standard cluster, two `e2-standard-2` Spot nodes. Zonal because the
> control plane is free-tier eligible; Spot because these nodes are disposable.

```bash
gcloud container clusters create "$CLUSTER" \
  --zone "$ZONE" \
  --num-nodes 2 \
  --machine-type e2-standard-2 \
  --spot \
  --disk-size 50 \
  --disk-type pd-balanced

gcloud container clusters get-credentials "$CLUSTER" --zone "$ZONE"
```

Sizing rationale: istiod alone requests 500m CPU, and the demo runs seven app pods each with a
sidecar. Two `e2-standard-2` (4 vCPU total, ~3.6 allocatable) fits it with a little room. Two
`e2-medium` does **not** — you will get `Pending` pods with `Insufficient cpu`, which reads like a
mysterious deploy failure. If you hit it anyway, add a node:

```bash
gcloud container clusters resize "$CLUSTER" --zone "$ZONE" --num-nodes 3 --quiet
```

Spot nodes can be reclaimed at any time. For a demo that is fine — pods reschedule — but do not
be surprised by a pod restarting mid-presentation.

**Check:** `kubectl get nodes` shows 2 nodes `Ready`.

---

## Milestone 5 — Istio + Kiali

> **TL;DR** — Install the mesh, add Prometheus and Kiali, then label the `bag` namespace for
> sidecar injection. **The label is the whole ballgame** — without it you get healthy pods and
> zero routing.

```bash
curl -L https://istio.io/downloadIstio | sh -
cd istio-*/ && export PATH=$PWD/bin:$PATH

istioctl install --set profile=default -y     # istiod + istio-ingressgateway
kubectl apply -f samples/addons/prometheus.yaml
kubectl apply -f samples/addons/kiali.yaml
kubectl -n istio-system rollout status deploy/kiali
```

Kiali needs Prometheus for its graph; installing Kiali alone gives you a UI with no traffic in it.

Create the namespace **with** the injection label:

```bash
kubectl create namespace bag
kubectl label namespace bag istio-injection=enabled
```

The Deploy workflow refuses to apply into a namespace missing that label, for a specific reason:
an un-injected pod is `1/1` and perfectly healthy, the rollout succeeds, the app answers
requests — and every cookie is ignored, because there is no Envoy to read it. It looks like the
routing model doesn't work rather than like a missing label.

**Check:** `kubectl get ns bag --show-labels` includes `istio-injection=enabled`.

---

## Milestone 6 — CD: first deploy

> **TL;DR** — Trigger Deploy in each repo. It builds the image, pushes to Artifact Registry,
> applies that version's Deployment pinned to the image it just built, and waits for the rollout.

The default version of each app, straight from `main`:

```bash
gh workflow run deploy.yml --repo "$GITHUB_OWNER/bag-service"
gh workflow run deploy.yml --repo "$GITHUB_OWNER/bag-xapi"
gh workflow run deploy.yml --repo "$GITHUB_OWNER/bag-ui"
```

Then the extra versions the demo needs. Same code, different version label — the version-keyed
item lists inside each app do the rest:

```bash
gh workflow run deploy.yml --repo "$GITHUB_OWNER/bag-service" -f version=1.10
gh workflow run deploy.yml --repo "$GITHUB_OWNER/bag-service" -f version=feature1
gh workflow run deploy.yml --repo "$GITHUB_OWNER/bag-xapi"    -f version=2.3
gh workflow run deploy.yml --repo "$GITHUB_OWNER/bag-ui"      -f version=feature1
```

Watch one:

```bash
gh run watch --repo "$GITHUB_OWNER/bag-service"
```

### What the workflow decides, and what it doesn't

| Trigger | Version built |
|---|---|
| push to `main` | that app's default (`1.9` / `2.2` / `1.0`) |
| push to any other branch | the branch name, sanitised — branch `feature1` ships version `feature1` |
| manual run with `version=X` | `X` |

It decides which **label** a new set of pods carries. It never decides which version serves a
request — that is the mesh's job, driven by the cookie, and no pipeline is involved at request
time. This is the separation that lets a developer ship a version without coordinating with
anyone.

Deploying a version with no manifest fails with an explicit message telling you to add
`k8s/deployment-<version>.yaml`. That is deliberate: the Deployment is a reviewable artifact in
the repo, not something a pipeline conjures.

**Check:**

```bash
kubectl -n bag get pods -L version
```

Every pod should be **`2/2`** — the app plus its Envoy sidecar. `1/1` means injection did not
happen; fix the namespace label and `kubectl -n bag rollout restart deploy`.

You should see seven pods: `bag-ui` 1.0 + feature1, `bag-xapi` 2.2 + 2.3, `bag-service` 1.9 +
1.10 + feature1.

---

## Milestone 7 — Routing rules

> **TL;DR** — DestinationRule subsets plus VirtualService cookie matches, one set per app. These
> live outside the app repos on purpose, so changing a route needs no app deploy.

Use Kiali's request-routing wizard, per app:

1. `istioctl dashboard kiali`
2. **Services → bag-service → Actions → Request Routing**
3. **Add Route Rule → Request Matching →** header `cookie`, match `regex`, value
   `.*bag_service=1\.10(;.*)?` → route to subset `1.10`
4. Repeat for `feature1`
5. Add a final rule with **no** matching, 100% to `1.9` — the catch-all. It **must be last**;
   Istio evaluates in order and first match wins
6. **Create**

Repeat for `bag-xapi` (`bag_orch` → `2.3`, catch-all `2.2`) and `bag-ui` (`bag_fed` → `feature1`,
catch-all `1.0`). For `bag-ui`, open **Advanced Options → Gateways** and attach it to the ingress
gateway, or browser traffic will never hit the rule.

The equivalent YAML — if you would rather read it, review it, or hand it to a routing controller —
is in the [appendix of the main README](README.md#appendix-reference-routing-rules).

Two details that cost people an afternoon:

- Envoy regex matches are **full matches** on the whole header value. Hence the leading `.*`, and
  the trailing `(;.*)?` that stops `feature1` from also matching `feature10`.
- The catch-all must be the last rule. Put it first and it swallows everything.

**Check:** `istioctl analyze -n bag` reports no errors, and Kiali's **Istio Config** shows valid
VirtualServices and DestinationRules.

---

## Milestone 8 — Verify the demo

> **TL;DR** — Get the gateway IP, run the four-scenario script, then do it by hand in two browsers
> to show independence.

```bash
export GW=$(kubectl -n istio-system get svc istio-ingressgateway \
  -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
echo "http://$GW"

./verify-propagation.sh "http://$GW"
```

On GKE the `serving` column should now follow the `requested` column — that is the difference
between this and the local run, where propagation works but nothing routes.

Then the human version, which is what actually lands in a demo. Open `http://$GW` and:

1. **Baseline** — clear all cookies. `1.0 → 2.2 → 1.9`, three items, $467.00.
2. **Dev A** — set `bag_service=1.10`. Four items, $662.00. UI and orchestration unchanged.
3. **Dev B, in a private window at the same time** — set only `bag_orch=2.3`. Three items, but a
   `MEMBER10` discount and a delivery date. Dev A's window is unaffected; so is the baseline.
4. **Dev C** — set all three. The page reloads, the accent colour changes, chain is
   `feature1 → 2.3 → feature1`.

The point to make out loud during step 3: **all three sessions are hitting the same Services, the
same hostnames, and the same pods' worth of infrastructure.** Nothing was duplicated per
developer.

Watch it in Kiali's **Graph** (namespace `bag`, *Versioned app graph*) while clicking around — each
request lights the edges into the specific subsets that served it.

Any amber `x ≠ y` on the page means the cookie was carried correctly but no route matched it — a
missing subset or a rule ordering problem, not an app bug. That distinction is why the page shows
propagation and routing as separate tables.

---

## Milestone 9 — Cost and teardown

> **TL;DR** — The cluster is the expensive part. Delete it when you are not demoing; the repos and
> images cost approximately nothing.

Rough shape of the bill while everything is running (check the
[pricing calculator](https://cloud.google.com/products/calculator) for current numbers — these
move):

| Item | Notes |
|---|---|
| GKE control plane | one zonal cluster is free-tier eligible |
| 2 × e2-standard-2 Spot | the main line item, a small fraction of on-demand |
| Ingress LoadBalancer | billed hourly whether or not anyone hits it |
| 2 × 50 GB pd-balanced | small but constant |
| Artifact Registry | storage only; a few hundred MB here |
| GitHub Actions | private repos include a free monthly minute allowance; these runs are 1–3 min |

The free trial's $300 credit covers a POC of this size comfortably. The thing that quietly burns
it is leaving the cluster and the load balancer up for weeks.

Pause between demos (keeps the cluster config, drops the node cost):

```bash
gcloud container clusters resize "$CLUSTER" --zone "$ZONE" --num-nodes 0 --quiet
```

Full teardown:

```bash
gcloud container clusters delete "$CLUSTER" --zone "$ZONE" --quiet
gcloud artifacts repositories delete bag-poc --location="$REGION" --quiet
# or, to be certain nothing lingers:
gcloud projects delete "$PROJECT_ID"
```

---

## How this maps to your real stack

The POC deliberately uses the simplest thing that demonstrates the pattern. Two of those choices
differ from what you run today, and it is worth naming them before anyone asks:

| This POC | Your stack | Does it change the argument? |
|---|---|---|
| GitHub Actions | GitLab CI | No. Same three stages — build, push, apply. A `.gitlab-ci.yml` with `build`/`deploy` jobs is a direct translation. |
| Actions runs `kubectl apply` (push-based CD) | ArgoCD syncs from git (pull-based) | No, and ArgoCD is *better* here. The per-version Deployments are ordinary manifests; ArgoCD watches the repo and syncs them. Drop the `Roll out` step and let Argo do it. |
| Kiali wizard writes the routing rules | a routing controller, or rules in a deploy repo | No. That is exactly why VirtualService and DestinationRule are not in the app repos — routing is managed on its own lifecycle. |
| nginx-ingress | still there | The Istio gateway is added *alongside* it. Nothing about the existing ingress path has to move for this to work. |
| blue/green | still there | Per-version subsets are a superset of blue/green: "blue" and "green" are just two version labels with the catch-all pointed at one of them. Promoting is one edit to the catch-all, no redeploy. |

The one genuinely new convention this asks the organisation to adopt is the `version` label on
every pod, plus the header-propagation code in each app's outbound HTTP client. Everything else is
configuration.
