# Agent Instructions

When starting a new session or if you are a fresh agent, please review the following directories to understand the project state, history, and specifications:

- `.agents/`: Contains ongoing memory, project state, and context for agents.
- `specs/`: Contains the formal specifications, plans, and tasks for the features being implemented.

### How to run the app (Docker)
The app ships as a single container (SPA + API) on one URL. From the repo root:

- **Start (build if needed): `npm run docker:up`**  *(= `docker compose up --build -d`)* → app at **http://localhost:8080**
- Health check: `GET http://localhost:8080/healthz` → `{"status":"ok"}`
- Stop (keeps data): `docker compose down` • Reset + wipe DB: `docker compose down -v`
- Requires `JWT_SECRET` in the root `.env` (no default; the app fails fast at boot without it).
- Data is in the `gifty_postgres_data` volume; Postgres is internal-only (not published to the host).
- **GitHub Codespaces exception (verified 2026-09-24):** Codespaces DinD drops inter-container bridge traffic, so use `docker compose -f docker-compose.codespace.yml up --build -d` (host networking; app↔Postgres over loopback) instead of `docker compose up`. See `docs/docker.md` §3b.

### Crucial Files for Context
- **Project State & Memory**: `.agents/memories.md` tracks progress, current focus, and high-level implementation status.
- **Specifications & Planning**:
    - `specs/002-docker-deployment/`: **COMPLETE FEATURE** — `spec.md`, `plan.md`, `tasks.md`, `quickstart.md`, and `contracts/deployment.md` for the single-command Docker deployment (all 25 tasks `[x]`).
    - `specs/001-gift-list-sharing/spec.md`: **COMPLETE FEATURE** — the source of truth for the core gift-list-sharing requirements and user stories (implemented).
    - `specs/001-gift-list-sharing/plan.md`: The architectural plan for the core feature.
    - `specs/001-gift-list-sharing/tasks.md`: The dependency-ordered task list for the core feature (all marked `[x]`).
- **Core Backend Logic**:
    - `backend/prisma/schema.prisma`: The data model defining all entities and relationships.
    - `backend/src/permissions/access.ts`: Implements the critical privacy/visibility rules (`view` / `claim` / `manage`).
    - `backend/src/gift-lists/router.ts` + `backend/src/gift-items/router.ts`: The API and the owner-privacy filtering (data access is inline Prisma; **there is no `backend/src/storage.ts`** — that file no longer exists).
    - `backend/src/auth/middleware.ts`: JWT verification + `requireAuth` / `authorizeList` / `authorizeItem`.
- **Core Frontend Logic**:
    - `frontend/src/App.tsx`: The main entry point and routing configuration.
    - `frontend/src/components/GiftItemList.tsx`: Implements the privacy-aware item rendering logic.

Reviewing these is crucial to maintain continuity and follow the established development workflow.
