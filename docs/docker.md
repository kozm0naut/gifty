# Gifty — Docker Deployment Guide

Run the complete Gifty application (web UI + API + database) from a machine with
**only Docker installed**. No Node.js, no database, no other runtime needed on the host.

## Prerequisites

- Docker (with Compose) installed and running — e.g. Docker Desktop ≥ 4.x, or
  Docker Engine + Compose v2. Verify with `docker version` and `docker compose version`.
- A browser for the UI.
- `curl` (or any HTTP client) for the readiness check (preinstalled on macOS/Linux and
  Windows 10+ PowerShell).
- Network access for the **first** build (to pull base images). Cached builds work offline.

## 1. Configure the environment (one time)

Copy the sample env file and set the required secret:

```powershell
# Windows PowerShell
Copy-Item .env.example .env
```

```bash
# Linux / macOS
cp .env.example .env
```

Edit `.env` and set **`JWT_SECRET`** — it is **required and has no default** (a known
secret would be a security violation). Generate 32+ random characters:

```powershell
# PowerShell: replace the JWT_SECRET= line in .env with a generated value
$secret = -join ((48..57) + (97..122) + (65..90) | Get-Random -Count 48 | ForEach-Object { [char]$_ })
(Get-Content .env) -replace '^JWT_SECRET=.*', "JWT_SECRET=$secret" | Set-Content .env
```

```bash
# Linux / macOS
sed -i.bak "s|^JWT_SECRET=.*|JWT_SECRET=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')|" .env && rm .env.bak
```

Other variables (all optional, sensible dev defaults already in `.env.example`):

| Variable | Default | Purpose |
|----------|---------|---------|
| `POSTGRES_DB` | `gifty` | Database name |
| `POSTGRES_USER` | `gifty` | Database user |
| `POSTGRES_PASSWORD` | `gifty_dev_password` | Database password (change for any shared use) |
| `PORT` | `8080` | Host port for the app URL |

> `.env` is git-ignored. Never commit secrets.

## 2. The four commands

Run these from the repository root:

| Action | Command |
|--------|---------|
| **Start** (builds if needed) | `docker compose up --build -d` |
| **Ready check** | `curl -fs http://localhost:8080/healthz` → `200 {"status":"ok"}` |
| **Stop** (data retained) | `docker compose down` |
| **Reset** (data deleted) | `docker compose down -v` |

### Wait until ready (scriptable)

```bash
until curl -fs http://localhost:8080/healthz > /dev/null 2>&1; do sleep 1; done
echo "Gifty is ready at http://localhost:8080"
```

### Open the app

**http://localhost:8080** — the single URL serves the web UI *and* the API (same origin).
Deep links (e.g. `/list/<id>`) survive a hard refresh via the SPA fallback.

## 3. What you're running

- Two containers in one Compose project:
  - `app` — the compiled API **and** the static web build, on host port `8080` → container `4000`.
  - `postgres` — PostgreSQL 16, **internal only** (not reachable from the host).
- Data lives in the named volume **`gifty_postgres_data`**. It survives `docker compose down`
  and is removed only by `docker compose down -v`.
- The `app` container runs migrations (`prisma migrate deploy`) on startup, then starts the
  server. A failed migration fails startup without dropping data.

## 3b. Running in GitHub Codespaces (verified working)

Codespaces runs Docker via a DinD sidecar that **drops traffic between containers on a
compose bridge network** (the app can resolve `postgres` but TCP connects are dropped —
observed as `prisma migrate deploy` → `P1001` while postgres is healthy). The standard
`docker-compose.yml` therefore does not work there. Use the dedicated host-networking
variant instead (same image, same data volume, same `JWT_SECRET` requirement):

```bash
docker compose -f docker-compose.codespace.yml up --build -d
until curl -fs http://localhost:8080/healthz > /dev/null 2>&1; do sleep 2; done
# App at the port-8080 forwarded URL (e.g. <codespace>-8080.app.github.dev)
```

`network_mode: host` puts both containers in one network namespace: the app reaches
Postgres over loopback (never filtered) and binds `8080` directly. On Docker Desktop
(Windows/macOS) the bridge topology works fine — keep using `docker-compose.yml` there.

## 4. Failure modes and what they mean

| Symptom | Cause / fix |
|---------|-------------|
| `Error: port is already allocated` (or similar) on `8080` | Another process owns host port `8080`. Stop it, or set `PORT` in `.env` to a free port and restart. |
| App container exits/restarts; logs show `JWT_SECRET is required` / `Configuration validation failed` | `JWT_SECRET` is missing or blank in `.env`. Set it (see §1) and `docker compose up -d` again. The app **never** starts with a known/default secret. |
| `postgres` never becomes healthy | Check `docker compose logs postgres`. Ensure nothing else holds the DB and the volume is intact. The `app` service waits for a healthy DB before starting. |
| Migration error on startup | Inspect `docker compose logs app`. Existing data is **not** dropped; fix the migration state and restart. |
| App restarts; logs show `P1001: Can't reach database server at postgres:5432` (browser may show 502) | The TCP path between containers is unavailable. In **GitHub Codespaces** this is a persistent DinD limitation (inter-container bridge traffic is dropped), not a transient race. Use the Codespaces variant: `docker compose -f docker-compose.codespace.yml up --build -d` (host networking; app reaches Postgres over loopback). Elsewhere, the entrypoint's 12 × 5 s migration retry usually absorbs a slow start; if it persists, check `docker compose logs postgres`. |

## 5. Advanced: backing up the data volume

The volume is the unit of backup. To dump it to a file:

```powershell
docker run --rm -v gifty_postgres_data:/data -v ${PWD}/backup:/backup alpine sh -c "mkdir -p /backup && tar czf /backup/gifty-db.tar.gz -C /data ."
```

```bash
docker run --rm -v gifty_postgres_data:/data -v $(pwd)/backup:/backup alpine sh -c "mkdir -p /backup && tar czf /backup/gifty-db.tar.gz -C /data ."
```

## 6. Local development (outside the container)

The dev workflow is unchanged and independent of the deployment:

- `npm run dev` — starts the dev Postgres (via `docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d postgres`), the API on `:4000`, and Vite on `:5173`.
- The `docker-compose.dev.yml` override re-exposes Postgres `5432` on the host **for development only**; the deployment (`docker-compose.yml`) keeps the DB internal.
- Backend tests: `npm test` (against the dev Postgres). Frontend e2e: `npm --prefix frontend run test:e2e`.

## 7. One-time migration note (old dev volume)

If you previously ran the dev-only compose setup, an old `postgres_data` volume may exist.
The deployment uses a new volume name (`gifty_postgres_data`) initialized with the `gifty`
database user. Any data in the old volume is dev-only; dump/restore it if you need it
(§5 pattern), otherwise start fresh.

## 8. Security & operator settings (spec 003)

In addition to `JWT_SECRET` and `POSTGRES_PASSWORD`, the app exposes a small set of
operator-configurable security settings (feature 003, *Security Hardening*). All are
optional — sensible defaults apply — and each is enforced at the boundary so a misconfiguration
fails closed (e.g. an unset `CORS_ORIGINS` is **closed** in production, not open).

| Variable | Default | Purpose |
|----------|---------|---------|
| `CORS_ORIGINS` | *(unset)* | Comma-separated origin allow-list. **Unset = CORS closed by default** in production (no `Access-Control-Allow-Origin` is ever reflected). Set it only if you serve the app from a different origin than the API. |
| `CSP_FONT_ORIGIN` | `https://fonts.googleapis.com,https://fonts.gstatic.com` | Permitted `font-src` origin(s) for the Content-Security-Policy header (comma- or space-separated). Leave unset to keep the app's own fonts working. |
| `RATE_LIMIT_WINDOW_MINUTES` | `15` | Sliding window for the sign-in / registration failure budgets. |
| `LOGIN_MAX_FAILURES_PER_SOURCE` | `10` | Max failed sign-ins per source (trusted-proxy client IP) within the window. |
| `REGISTER_MAX_FAILURES_PER_SOURCE` | `3` | Max failed registrations per source — intentionally tighter than sign-in. |
| `LOGIN_MAX_FAILURES_PER_ACCOUNT` | `5` | Max failed sign-ins per account (email-keyed) within the window — protects against source-IP rotation. |
| `JWT_SECRET_MIN_LENGTH` | `32` | Minimum signing-secret length (256 bits) for the production boot gate. |
| `ACCESS_TOKEN_TTL_MINUTES` | `10` | Short-lived access-credential lifetime (spec caps it at ≤ 1 h). |
| `SESSION_MAX_AGE_DAYS` | `30` | Hard cap on the overall (refresh-credential) session lifetime. |

The **production boot gate** (`validateConfig()`) refuses to start when `JWT_SECRET` is
missing, below `JWT_SECRET_MIN_LENGTH`, or a known default value, or when the database
credential is a known default — each failure message names the offending value and the fix.

### Operational notes

- **Single-replica rate limiting.** The failure budgets are held in memory per process.
  Run **one** replica of the `app` container. Behind a load balancer with multiple
  replicas, split a source's budget across replicas (each sees only its share of the
  attempts), so the effective limit is weaker than configured. For multi-replica
  deployments, front the auth endpoints with an external rate limiter or a shared
  (e.g. Redis) counter.
- **Audit retention.** Audit events (sign-in success/failure, share, claim, purchase,
  revert, session revocation, account removal) are written to the `AuditEvent` table and
  are **retained for a minimum of 5 years** — the app never prunes them. Back up the
  `gifty_postgres_data` volume (§5) if you need to preserve them beyond the lifetime of
  the database. Audit rows are operator-inspectable only; there is no user-facing audit API
  in this feature.
- **Supply-chain gate.** `npm run audit` (alias `audit:prod`) runs `npm audit
  --omit=dev --audit-level=high` against both `backend/` and `frontend/` and **exits
  non-zero on any high/critical finding**, so it can be used as a blocking CI / release
  gate. The current tree reports **0 high / 0 critical**; the 2 remaining `react-router`
  *moderate* advisories (CVE-2026-53666 / CVE-2026-53669) are explicitly accepted — they
  are fixed only in `react-router` v7 (a breaking major bump) and are out of scope for the
  "zero high/critical" success criterion.
