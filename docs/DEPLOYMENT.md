# Deployment

## Architecture (current, dev/testing scale)

- **Client** (`apps/client`, static Vite build) → **Azure Static Web Apps**, Free tier.
- **Server** (`apps/server`, Colyseus/WebSocket) → **Azure Container Apps**, Consumption plan,
  `min-replicas 0` / `max-replicas 1` (scales to zero when no one is playing).
- **Container images** → **GitHub Container Registry** (`ghcr.io`), not Azure Container Registry —
  avoids ACR's ~$5/mo minimum tier since GHCR is free at this scale.
- Deploys run on every push to `main` via `.github/workflows/deploy-client.yml` and
  `deploy-server.yml`.

This setup is sized for **one active lobby at a time during development**. It is not yet built to
run multiple lobbies concurrently in production — see "Scaling migration" below for what changes
when that's needed.

## Deployed resources (as of 2026-09-12)

| Resource | Name | Region | Subscription |
|---|---|---|---|
| Resource group | `vole-wars-rg` | Sweden Central | `Azure subscription 1` (`ef0b9e2e-81d6-4b7d-a464-0c9d0026e87e`, tenant `dec42c2a-8e93-44ee-9a1c-03905ff1e6da`, account `ville.vainio92@outlook.com`) |
| Static Web App | `vole-wars-client` | West Europe (only supported region closest to Sweden Central; SWA serves from a global CDN regardless) | same |
| Container Apps environment | `vole-wars-env` | Sweden Central | same |
| Container App (server) | `vole-wars-server`, FQDN `vole-wars-server.gentlemoss-eacdcb24.swedencentral.azurecontainerapps.io` | Sweden Central | same |
| Deployer app registration (OIDC) | `vole-wars-deployer`, app/client id `b9f6cf3e-5c24-4486-b006-b111daadfb84` | — | same |

This is a **separate personal Azure account/subscription**, not the `360mediatalo.fi` Sponsorship
subscription used for other apps — the CLI needed `az login --tenant dec42c2a-8e93-44ee-9a1c-03905ff1e6da`
to reach it, since default account discovery hit an MFA snag on that tenant and stopped short of
listing its subscription.

GHCR package is **private** (the image ships the server's unminified TypeScript source via `tsx`,
so it's kept out of public reach) — the Container App has GHCR registry credentials configured
directly (a GitHub PAT with `read:packages`, entered by hand, not stored in this repo or chat).

GitHub Actions → Azure auth uses **OIDC federated credentials**, not a stored client secret — the
app registration above trusts GitHub's OIDC issuer for `repo:Villev92/vole-wars:ref:refs/heads/main`,
so there's no long-lived Azure credential to leak or rotate.

## Recreating this from scratch (if the resource group is ever deleted)

```bash
az login --tenant dec42c2a-8e93-44ee-9a1c-03905ff1e6da
az group create --name vole-wars-rg --location swedencentral

# Static Web App (client) — free tier
az staticwebapp create \
  --name vole-wars-client \
  --resource-group vole-wars-rg \
  --location westeurope \
  --sku Free

# Grab the deployment token for the GitHub secret below
az staticwebapp secrets list \
  --name vole-wars-client \
  --query "properties.apiKey" -o tsv

# Container Apps environment + app (server)
az extension add --name containerapp --upgrade
az provider register --namespace Microsoft.App
az provider register --namespace Microsoft.OperationalInsights

az containerapp env create \
  --name vole-wars-env \
  --resource-group vole-wars-rg \
  --location swedencentral

# Placeholder image on first create; the GH Actions workflow updates it afterwards
az containerapp create \
  --name vole-wars-server \
  --resource-group vole-wars-rg \
  --environment vole-wars-env \
  --image mcr.microsoft.com/k8se/quickstart:latest \
  --target-port 2567 \
  --ingress external \
  --transport auto \
  --min-replicas 0 \
  --max-replicas 1 \
  --cpu 0.5 --memory 1.0Gi

# Point the Container App at your (private) GHCR images — run this yourself, not via
# an assistant, since it takes a GitHub PAT with read:packages scope as a plaintext argument
az containerapp registry set \
  --name vole-wars-server \
  --resource-group vole-wars-rg \
  --server ghcr.io \
  --username <your-github-username> \
  --password <github-PAT-with-read:packages>

# OIDC trust for GitHub Actions (no client secret stored anywhere)
appId=$(az ad app create --display-name vole-wars-deployer --query appId -o tsv)
az ad sp create --id "$appId"
az role assignment create --assignee "$appId" --role Contributor \
  --scope /subscriptions/<sub-id>/resourceGroups/vole-wars-rg
az ad app federated-credential create --id "$appId" --parameters '{
  "name": "github-main-branch",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "repo:Villev92@23382290/vole-wars@1343962841:ref:refs/heads/main",
  "audiences": ["api://AzureADTokenExchange"]
}'
```

`--transport auto` lets Container Apps negotiate WebSocket upgrades over the HTTP ingress, which
Colyseus needs.

**Windows/Git-Bash note:** Git Bash auto-converts any argument starting with `/` into a Windows
path, which corrupts `--scope /subscriptions/...` into garbage like `/C:/Program Files/Git/subscriptions/...`
and makes `az role assignment create` fail with a cryptic `MissingSubscription` error. Prefix the
command with `MSYS_NO_PATHCONV=1` when running these from Git Bash.

**Federated credential subject format:** this repo's OIDC subject claims include GitHub's
immutable owner/repo IDs (`repo:Villev92@23382290/vole-wars@1343962841:ref:refs/heads/main`), not
just the plain `repo:Villev92/vole-wars:ref:refs/heads/main` most docs show — GitHub added this to
survive repo renames/transfers without letting an old subject get reused. If the subject ever
looks wrong (login fails with `AADSTS700213: No matching federated identity record found`), check
the actual `sub` claim GitHub sent in the failed run's error message and update the federated
credential to match it exactly, rather than assuming the classic format.

### GitHub repo secrets

| Secret | Value |
|---|---|
| `AZURE_STATIC_WEB_APPS_API_TOKEN` | output of `az staticwebapp secrets list` above |
| `AZURE_CLIENT_ID` | `b9f6cf3e-5c24-4486-b006-b111daadfb84` |
| `AZURE_TENANT_ID` | `dec42c2a-8e93-44ee-9a1c-03905ff1e6da` |
| `AZURE_SUBSCRIPTION_ID` | `ef0b9e2e-81d6-4b7d-a464-0c9d0026e87e` |
| `VITE_SERVER_URL` | `wss://vole-wars-server.gentlemoss-eacdcb24.swedencentral.azurecontainerapps.io` |

None of the three Azure IDs above are secret in the sense of granting access on their own (OIDC
federation only trusts token exchanges that also match the GitHub repo/branch subject), but keep
them as Actions secrets rather than hardcoding them in the workflow anyway.

`GITHUB_TOKEN` for pushing to GHCR is automatic — no secret to add, just make sure the repo's
Actions settings allow write access to packages (Settings → Actions → General → Workflow
permissions → Read and write).

## Cost estimates

Container Apps Consumption pricing used below (approximate list price, East US, verify current
rates before relying on them): **$0.000024/vCPU-second** and **$0.000003/GiB-second** of *active*
time, after a **free monthly grant of 180,000 vCPU-seconds / 360,000 GiB-seconds / 2M requests**.
Idle time (scaled to zero) costs nothing. Static Web Apps Free tier is $0 regardless of traffic at
this scale.

### Your actual scenario: testing, max 2 lobbies, 2 hrs/day/lobby

Assuming the two lobbies don't fully overlap (worst case ~4 active hours/day = 120 hrs/month),
sized at 0.5 vCPU / 1 GiB per replica:

| Resource | Usage | Cost |
|---|---|---|
| Container Apps vCPU | 432,000 vCPU-s used vs. 180,000 free grant | ~$0.86/mo |
| Container Apps memory | 432,000 GiB-s used vs. 360,000 free grant | ~$0.22/mo |
| Static Web Apps | any | $0 |
| **Total** | | **~$1/month** |

If the two lobbies' sessions overlap (2 active hours/day total, 60 hrs/month), everything stays
inside the free grant and the total is **$0/month**. Either way, this is a rounding error — expect
your Azure bill for this app to be $0–2/month at current testing volume.

**Other cost buckets that exist but should also be ~$0 at this scale:**

- **Log Analytics** — Container Apps environments auto-attach a Log Analytics workspace for
  logs/metrics, billed separately from compute (own free grant, roughly 5 GB/month ingestion).
  Light console logging from one lightly-used server stays well under it; only becomes real money
  if logging gets verbose.
- **GHCR storage/bandwidth** — free for public repos; private repos get a small free allowance
  before charges. A handful of image pushes/month for testing won't approach it.
- **Egress bandwidth** — Azure has a small account-wide free outbound-data allowance; a couple of
  players' WebSocket traffic is nowhere near it.

### Reference point: sustained heavy usage (10 full lobbies, 24/7)

Included for context on when this architecture needs to change (see below), not because it applies
now:

| Approach | Est. cost/mo |
|---|---|
| Container Apps Consumption, 24/7, ~1.5 vCPU/3 GiB | ~$110–120 |
| Container Apps Consumption + Redis (multi-instance) | ~$130–140 |
| Plain Azure VM (2 vCPU/8 GB) + Redis instead | ~$85–95 |

Consumption billing is priced for bursty/idle-capable workloads; at sustained 24/7 full load a
reserved VM (or Container Apps' Dedicated/workload-profile plan, billed the same way) is cheaper.
This is the trigger for the migration below, not something to pre-build now.

## Scaling migration (do this later, not now)

Today's setup assumes **one Colyseus process holds all game rooms in memory**, which is why
`max-replicas` is capped at 1 — a second replica would be a second, disconnected copy of the game
state, and clients could land on either one at random.

When you outgrow a single instance (more concurrent lobbies than one process should carry), the
changes are:

1. **Add Colyseus's Redis-backed presence/driver** (`@colyseus/redis-presence`,
   `@colyseus/redis-driver`) so multiple server processes share matchmaking state instead of each
   owning an isolated set of rooms. Needs an Azure Cache for Redis instance (Basic C0, ~$16/mo is
   the cheapest tier — Azure has no free Redis tier).
2. **Raise `max-replicas`** above 1 and turn on **session affinity** on the Container App
   (cookie-based sticky routing), so a client's WebSocket connection keeps landing on the replica
   that actually holds its room.
3. Re-evaluate Consumption vs. a Dedicated workload profile / plain VM once usage is sustained
   rather than bursty — see the reference cost table above for why that crossover matters.
4. None of this needs code changes to game logic — it's purely the server bootstrap
   (`apps/server/src/index.ts`) swapping in the Redis presence/driver, plus the infra changes
   above.

Don't do this preemptively — it adds a paid dependency (Redis) and operational complexity for a
problem you don't have yet at one lobby.
