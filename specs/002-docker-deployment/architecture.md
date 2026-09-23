# Architecture Diagram: Docker Deployment

**Feature**: `002-docker-deployment` | **Date**: 2026-09-22

Visual reference for the two-container deployment described in `research.md` (D1/D2/D7), `contracts/deployment.md`, and `tasks.md`. Normative details live in those documents — this diagram is illustrative.

```mermaid
flowchart TB
    subgraph Host["Host (only Docker required)"]
        OP["👤 Operator / CI / Browser"]
        ENV[".env (git-ignored)<br/>JWT_SECRET — required, no default<br/>POSTGRES_*, PORT=8080"]
    end

    subgraph Stack["docker compose project — gifty"]
        direction TB
        subgraph Net["internal network (not host-published)"]
            APP["🐳 app container (gifty-app)<br/>Node 22 · non-root<br/>• Express API: /auth /lists /items /healthz<br/>• serves frontend dist/ + SPA fallback<br/>• listens on :4000"]
            PG[("🐳 postgres (postgres:16.x-alpine)<br/>gifty db · healthcheck pg_isready<br/>port 5432 — internal only")]
        end
        VOLUME[("💾 named volume<br/>gifty_postgres_data<br/>(survives docker compose down)")]
    end

    OP -- "1. docker compose up --build -d" --> APP
    OP -- "2. poll GET /healthz (ready ≤ 2 min)" --> APP
    OP -- "3. http://localhost:8080<br/>SPA + API same-origin" --> APP
    ENV -. "injected at up time<br/>(never baked into image)" .-> APP

    APP -- "depends_on: service_healthy<br/>then: prisma migrate deploy" --> PG
    APP -- "DATABASE_URL" --> PG
    PG --- VOLUME
    OP -- "stop: docker compose down<br/>(data retained)" --> Stack
    OP -- "reset: docker compose down -v<br/>(volume removed)" --> VOLUME

    style APP fill:#e8f4fd,stroke:#2f80c3
    style PG fill:#fdf3e0,stroke:#c3922f
    style VOLUME fill:#f0e8fd,stroke:#7a3fc3
    style ENV fill:#f5f5f5,stroke:#999
```

## What the diagram encodes

| Element | Contract / research ref |
|---------|-------------------------|
| Two containers (`app` + `postgres`) | research D1 |
| Single published port `8080→4000`; DB never host-published | research D7; contracts §2 (Constitution §I/§IV) |
| `app` image serves SPA + API (same origin) | research D1/D2/D12 |
| `depends_on: service_healthy` → `prisma migrate deploy` → serve | research D6/D11; contracts §4 |
| `gifty_postgres_data` named volume; `down` retains, `down -v` resets | research D5; contracts §1 (FR-004/008) |
| Secrets injected at `up` time, never baked into the image | research D4; contracts §3 (Constitution §IV) |
| `/healthz` readiness signal within 2 minutes | contracts §4 (FR-013, SC-001) |
