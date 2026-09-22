# Agent Instructions

When starting a new session or if you are a fresh agent, please review the following directories to understand the project state, history, and specifications:

- `.agents/`: Contains ongoing memory, project state, and context for agents.
- `specs/`: Contains the formal specifications, plans, and tasks for the features being implemented.

### Crucial Files for Context
- **Project State & Memory**: `.agents/memories.md` tracks progress, current focus, and high-level implementation status.
- **Specifications & Planning**:
    - `specs/002-docker-deployment/spec.md`: **ACTIVE FEATURE** — the source of truth for the current work (containerized deployment). Clarified and validated; `plan.md`/`tasks.md` pending.
    - `specs/001-gift-list-sharing/spec.md`: **COMPLETE FEATURE** — the source of truth for the core gift-list-sharing requirements and user stories (implemented).
    - `specs/001-gift-list-sharing/plan.md`: The architectural plan for the core feature.
    - `specs/001-gift-list-sharing/tasks.md`: The dependency-ordered task list for the core feature (all marked `[x]`).
- **Core Backend Logic**:
    - `backend/prisma/schema.prisma`: The data model defining all entities and relationships.
    - `backend/src/permissions/access.ts`: Implements the critical privacy/visibility rules.
    - `backend/src/storage.ts`: The primary data access layer.
- **Core Frontend Logic**:
    - `frontend/src/App.tsx`: The main entry point and routing configuration.
    - `frontend/src/components/GiftItemList.tsx`: Implements the privacy-aware item rendering logic.

Reviewing these is crucial to maintain continuity and follow the established development workflow.
