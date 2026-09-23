# Data Model: Docker Deployment

**Feature**: `002-docker-deployment` | **Date**: 2026-09-22

This feature does **not** introduce new application data entities. It packages the existing Gifty application and its existing data store for containerized, persistent execution. The data model below therefore has two parts:

1. **Persisted application data** (unchanged by this feature) — the entities that MUST survive stop/start cycles (FR-004, FR-005).
2. **Deployment artifacts** (new) — the container/volume/environment entities that the deployment introduces.

## 1. Persisted Application Data (unchanged)

The source of truth is `backend/prisma/schema.prisma`. The containerized deployment stores these entities in PostgreSQL 16 and MUST preserve them across restarts.

| Entity | Key attributes (abridged) | Notes for deployment |
|--------|---------------------------|----------------------|
| **User** | `id`, `email` (unique), `passwordHash`, `displayName`, `createdAt` | Password hashes (bcrypt) must round-trip unchanged across restarts. |
| **GiftList** | `id`, `title`, `description?`, `ownerId → User`, `createdAt`, `updatedAt` | Owner relationship must be intact after restart. |
| **GiftItem** | `id`, `giftListId → GiftList`, `name`, `quantity?`, `unitPrice?`, `state ∈ {available, claimed, purchased}`, `claimantUserId?`, `purchaserUserId?`, `createdAt`, `updatedAt` | `state` / `claimantUserId` / `purchaserUserId` MUST be exactly as persisted — no reset, no re-derivation (FR-004, Constitution §II). |
| **SharePermission** | `id`, `giftListId → GiftList`, `recipientId → User`, `permission` (single `shared` level), `createdAt` | Grant/consent records must survive restart (Constitution §I, §II). |

**Invariants the deployment must NOT break**:
- Owner-privacy filtering is a **read-time** behavior in the backend routers; it is independent of storage. The deployment must not change it (Constitution §I).
- Atomic state transitions (claim/purchase) are enforced by conditional `updateMany` in the backend; the deployment must not alter the schema or the transactional guarantees (Constitution §II, §III).
- Schema is applied via `prisma migrate deploy` from committed migrations (research D3/D11). The deployment MUST NOT rely on `prisma db push` at boot (non-auditable, can drift).

## 2. Deployment Artifacts (new)

| Entity | What it is | Key attributes / constraints |
|--------|-----------|------------------------------|
| **Compose project** | The `docker-compose.yml` at the repo root defining the full stack. | Two services: `postgres`, `app`. One internal network. Named volume `gifty_postgres_data`. |
| **`app` image** | A single container image (built from the root `Dockerfile`) that runs the compiled backend API **and** serves the frontend static build. | Runs as a **non-root user** (Constitution §IV). No secrets baked in. Node 22 runtime. |
| **`postgres` container** | PostgreSQL 16 (`postgres:16.x-alpine`, minor-pinned) holding all persisted application data. | Healthcheck: `pg_isready -U gifty -d gifty`. Not published to the host by default. |
| **Named volume `gifty_postgres_data`** | Durable storage for the Postgres data directory. | The **single source of truth** for persisted application data (FR-004/FR-005). Survives `docker compose down` (without `-v`); removed by `docker compose down -v` (reset, FR-008). |
| **Environment configuration** | Runtime config injected at `docker compose up` time. | `DATABASE_URL`, `JWT_SECRET` (required, no default), `NODE_ENV=production`, `POSTGRES_*`. See `contracts/deployment.md` for the full table. |
| **Readiness endpoint** | `GET /healthz` on the `app` service. | Returns `200 {"status":"ok"}` when the API process is up (FR-013). The operator/test "wait for ready" signal. |

### Lifecycle / state transitions (deployment-level)

```text
            start (docker compose up)
  [stopped] ───────────────────────────▶ [starting]
                                            │  postgres healthy → app runs `migrate deploy` → API listening
                                            ▼
                                         [ready]   (GET /healthz == 200)
                                            │
        stop (docker compose down)          │  data persists in gifty_postgres_data
  [stopped] ◀───────────────────────────────┘
        │
        │  reset (docker compose down -v)  →  volume removed → data lost
        ▼
  [stopped, no data]
```

- **start**: creates/reuses containers; `app` waits for `postgres` to be healthy before running migrations and serving.
- **stop**: tears down containers; the named volume (and therefore all data) is retained.
- **reset**: tears down containers **and** removes the named volume; a subsequent start presents a clean initial state (FR-008, US3 scenario 4).

## Validation rules (deployment-relevant)

- **First start**: volume is empty → `prisma migrate deploy` applies the initial migration → app is usable.
- **Subsequent starts**: volume has data → `migrate deploy` is a no-op (already applied) → app reuses existing data (FR-005).
- **Missing/corrupted store**: `postgres` fails its healthcheck → `app` does not start → clear startup failure surfaced (FR-006, US2 scenario 3). The app MUST NOT serve on a broken store.
- **Port conflict**: the host port `8080` is already bound → `docker compose up` fails with a clear, human-readable message identifying the conflict (FR-006, edge case).

## Security notes (Constitution §IV)

- `JWT_SECRET` is **required** and injected via environment; the code's `'development-secret'` fallback must be removed so a missing secret fails fast instead of silently using a known value.
- DB credentials are injected via environment; never baked into the image.
- The `postgres` service is not published to the host by default (least exposure of personal data, Constitution §I/§IV).
- The `app` container runs as a non-root user.
