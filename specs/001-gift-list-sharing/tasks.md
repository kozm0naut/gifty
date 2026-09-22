# Tasks: Gift List Sharing

**Input**: Design documents from `/specs/001-gift-list-sharing/`

**Prerequisites**: plan.md (required), spec.md (required for user stories), research.md, data-model.md, contracts/

**Tests**: The examples below include validation tasks only where needed for story verification; this feature’s acceptance tests are covered by the quickstart and story-specific validation steps.

**Organization**: Tasks are grouped by user story to enable independent implementation and testing of each story.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependencies)
- **[Story]**: Which user story this task belongs to (e.g., US1, US2, US3)
- Include exact file paths in descriptions## Status Legend

- `[x]` Done and verified
- `[ ]` Not started
- `[~]` In progress (partially implemented; remaining work noted inline)

## Current Status (as of 2026-09-15)

- **Phases 1–4 (Setup, Foundational, US1, US2)**: Complete.
- **Phase 5 (US3 Sharing)**: Complete, including T019A (frontend "List Deleted" placeholder now implemented in `frontend/src/pages/ListPage.tsx`; backend cascade cleanup in place).
- **Phase 6 (US4 Claiming)**: Core lifecycle (claim/purchase/unclaim/unpurchase) and owner-privacy filtering are implemented. T025 is complete — the dedicated concurrency/race test exists in `backend/tests/sc-validation.test.ts` (SC-004); the frontend e2e portions are now automated in `frontend/tests/e2e/lifecycle.spec.ts` (Playwright). US5 (state management) is delivered by the same US4 implementation.
- **Phase 7 (Validation & Polish)**: Backend validation track complete. T031–T034 (SC-003–SC-006) implemented and passing in `backend/tests/sc-validation.test.ts`; T039 (API docs + contract suite) complete; T040 (quickstart validation) confirmed — full backend suite of 59 tests passing; T041 (hardening) and T042 (concurrency/privacy audit, incl. a fixed dashboard privacy regression) complete. T043 (DB-backed storage) complete; T044 (persistence tests) complete — backend `persistence.test.ts` + frontend `frontend/tests/e2e/persistence.spec.ts`.
- **Frontend e2e validation track (T035–T038)**: Validated **manually in-browser** and now **automated with Playwright** (`frontend/tests/e2e/`). **All four tasks are confirmed passing:**
  - **T035 (share & claim UX success flows)** — owner (Alice) and recipient (Bob) completed the full share → claim → purchase flow without a blocking error.
  - **T036 (duplicate-claim conflict messaging)** — Bob claimed the Wireless Headphones; a second claim attempt (Jane) was rejected with `409` "This item is no longer available to claim", which the frontend surfaces in its error alert.
  - **T037 (owner privacy visibility)** — the owner saw no claim/purchase state or claimant identity on any item while the recipient saw correct state + actions.
  - **T038 (lifecycle & permission UX)** — Bob reverted his purchase (Espresso Machine `purchased → claimed`) and his claim (Scented Candle Set `claimed → available`); Alice revoked Bob's access, after which Bob's dashboard no longer listed the list and the API returned `403` "You do not have access to this list".
  - All four are now automated with Playwright in `frontend/tests/e2e/` (8 tests passing) for regression.
- **Phase 10 (Convergence, 2026-09-20)**: T048 (owner-side list rename, US1/AC2) implemented and verified — `PATCH /lists/:listId` endpoint, `updateList` client function, `RenameListForm` UI in `ListPage.tsx`, contract doc update, and 2 new backend tests. Full backend suite: 80 tests passing across 10 files.

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Project initialization and shared toolchain setup

- [x] T001 [P] Create backend and frontend project skeleton per plan.md in backend/ and frontend/
- [x] T002 [P] Initialize Node.js + TypeScript and shared dev tooling in backend/package.json, frontend/package.json, and .eslintrc.json
- [x] T003 [P] Configure PostgreSQL, Prisma, and environment templates in backend/prisma/schema.prisma, backend/.env.example, and backend/src/config/

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure that MUST be complete before ANY user story can be implemented

- [x] T004 Create the core domain schema for User, GiftList, GiftItem, and SharePermission in backend/prisma/schema.prisma
- [x] T005 [P] Implement password hashing, JWT/session auth, and request identity middleware in backend/src/auth/
- [x] T006 [P] Implement API routing, validation, and centralized error handling in backend/src/api/ and backend/src/common/
- [x] T007 [P] Implement access guards and permission utilities for owner/recipient enforcement in backend/src/permissions/
- [x] T008 Add logging, configuration management, and environment validation in backend/src/config/ and backend/src/common/

## Phase 3: User Story 1 - Account & List Management (Priority: P1) 🎯 MVP

**Goal**: Allow a user to register an account and create/manage their personal gift lists.

**Independent Test**: A user can register, create a list, and view their dashboard without needing another account.

### Implementation for User Story 1

- [x] T010 [P] [US1] Create User and GiftList domain models and repository contracts in backend/src/users/ and backend/src/gift-lists/
- [x] T011 [P] [US1] Create GiftItem entity, validation rules, and list association model in backend/src/gift-items/
- [x] T012 [US1] Implement list creation, retrieval, update, and item CRUD services in backend/src/gift-lists/ and backend/src/gift-items/
- [x] T013 [US1] Add register/login and personal list endpoints with auth enforcement in backend/src/auth/ and backend/src/api/
- [x] T014 [US1] Build dashboard, list creation form, and item management UI in frontend/src/pages/ and frontend/src/components/
- [x] T015 [US1] Add validation and privacy-safe user-facing messages for list/item management in backend/src/common/ and frontend/src/services/

**Checkpoint**: At this point, User Story 1 should be fully functional and testable independently

---

## Phase 4: User Story 2 - Item Management (Priority: P1)

**Goal**: Allow a user to add, view, and manage the details of gift items within their own lists.

**Independent Test**: A user can create a list and add multiple items to it with names and descriptions.

### Implementation for User Story 2
- [x] T011B [P] [US2] Create GiftItem entity, validation rules, and list association model in backend/src/gift-items/
- [x] T012B [US2] Implement item repository and CRUD services in backend/src/gift-items/
- [x] T013B [US2] Add item management API endpoints in backend/src/gift-items/router.ts
- [x] T014B [US2] Build item management UI in frontend/src/components/ and frontend/src/pages/
- [x] T015B [US2] Add validation and privacy-safe user-facing messages in backend/src/common/ and frontend/src/services/ (validation in `gift-item.validation.ts`; user-facing error/success messages in `frontend/src/services/api.ts` and components)

---

## Phase 5: User Story 3 - Share a list with trusted recipients (Priority: P1)

**Goal**: Enable explicit, least-privilege sharing so only invited recipients can access list content.

**Independent Test**: A user can invite a recipient, confirm access works from that account, and verify non-invited users are denied access.

### Implementation for User Story 3

- [x] T016 [P] [US3] Create SharePermission model, validation, and repository layer in backend/src/permissions/
- [x] T017 [P] [US3] Implement share creation, update, and revocation logic in backend/src/permissions/ and backend/src/gift-lists/
- [x] T018 [US3] Add share endpoints and authorization checks for view/claim/manage permissions in backend/src/api/ and backend/src/permissions/
- [x] T019 [US3] Build owner-side invite and permission management UI in frontend/src/components/ and frontend/src/pages/ (implemented in `frontend/src/components/PermissionManager.tsx`, wired into `frontend/src/pages/ListPage.tsx`)
- [x] T019A [US3] Define the list-deletion-after-share behavior: when a list is deleted after being shared, revoke all share permissions immediately, remove shared recipients' access, and clean up list/item records. Backend cascade cleanup is in place (`onDelete: Cascade` on `GiftItem` and `SharePermission` in `backend/prisma/schema.prisma`; `DELETE /lists/:listId` in `backend/src/gift-lists/router.ts`). Frontend "List Deleted" placeholder with distinct styling is implemented in `frontend/src/pages/ListPage.tsx` (renders when the list returns 404).
- [x] T020 [US3] Add deny-by-default access enforcement and permission error messaging in backend/src/auth/ and backend/src/common/

**Checkpoint**: At this point, User Stories 1, 2 and 3 should both work independently

---

## Phase 6: User Story 4 - Claim gifts without revealing that information to the list owner (Priority: P1)

**Goal**: Allow authorized recipients to claim or purchase gifts while preserving the surprise for the list owner.

**Independent Test**: A shared recipient can claim an item and then view only their own claim state, while the owner sees no claim or purchaser identity related to that item.

### Implementation for User Story 4

- [x] T021 [P] [US4] Extend the GiftItem state model to enforce allowed transitions and validation constraints in backend/src/gift-items/ (atomic `available -> claimed -> purchased` transitions via conditional `updateMany` in `backend/src/gift-items/router.ts`)
- [x] T022 [P] [US4] Implement claim cancellation workflow so claimed -> available is only allowed by the current claimant in backend/src/gift-items/ and backend/src/api/ (`POST /items/:itemId/unclaim`)
- [x] T023 [US4] Implement revoke/restore and purchase-state workflows in backend/src/gift-items/ and backend/src/api/ (`POST /items/:itemId/purchase` and `POST /items/:itemId/unpurchase`)
- [x] T024 [US4] Update list and item views to display lifecycle state without leaking hidden claimant or purchaser data in frontend/src/components/ and frontend/src/pages/ (owner sees no state/claimant; recipient sees state + actions in `frontend/src/components/GiftItemList.tsx`; owner-privacy filtering in `backend/src/gift-lists/router.ts` and `backend/src/gift-items/router.ts`)
- [x] T025 [US4] Add end-to-end validation for claim, cancellation, purchase, and reset edge cases in backend/tests/integration/ and frontend/tests/e2e/ (backend coverage exists in `user-story-3.test.ts`, `user-story-3-management.test.ts`, `user-story-4-revert.test.ts`; a dedicated concurrency/race test exists in `sc-validation.test.ts` (SC-004); the claim/purchase success path was validated manually in-browser on 2026-09-15; automated frontend e2e suite now in `frontend/tests/e2e/lifecycle.spec.ts` — 2 tests passing)

**Checkpoint**: All user stories should now be independently functional

---

## Phase 7: Validation, Polish & Cross-Cutting Concerns

**Purpose**: Final quality, documentation, validation, and hardening across all stories

### Backend validation track

- [x] T031 [P] [SC-003] Validate share and claim success-rate thresholds in backend/tests/integration/ and backend/tests/contract/ — Pass when >=95% of valid share and claim actions complete without errors for authorized users. (Implemented in `backend/tests/sc-validation.test.ts`; passing.)
- [x] T032 [P] [SC-004] Validate duplicate-claim race protection in backend/tests/integration/ — Pass when concurrent same-item claims produce exactly one valid success and the failure rate on duplicate claim attempts stays within the 99% protection threshold. (Implemented in `backend/tests/sc-validation.test.ts` with concurrent `Promise.all` race rounds; passing.)
- [x] T033 [P] [SC-005] Validate owner privacy boundary enforcement in backend/tests/integration/ — Pass when the list owner never receives claimant or purchaser identity or claim/purchase state for items on their own list while authorized recipients do. (Implemented in `backend/tests/sc-validation.test.ts`, including a dashboard `GET /lists` regression test; passing.)
- [x] T034 [P] [SC-006] Validate permission and lifecycle update coverage in backend/tests/integration/ — Pass when at least 90% of permission-change and state-update scenarios succeed without support and all blocked actions return clear rejection errors. (Implemented in `backend/tests/sc-validation.test.ts`; passing.)

### Frontend validation track

- [x] T035 [P] [SC-003] Validate share and claim UX success flows in frontend/tests/e2e/ — Pass when the owner and recipient complete the primary share-and-claim flow in under 2 minutes without a blocking error. (Validated **manually in-browser** on 2026-09-15: owner Alice + recipient Bob completed share → claim → purchase without a blocking error. Automated e2e suite now in `frontend/tests/e2e/share-claim.spec.ts` — 2 tests passing.)
- [x] T036 [P] [SC-004] Validate duplicate-claim conflict messaging in frontend/tests/e2e/ — Pass when only one claim wins and the losing attempt displays a clear conflict message. (Validated **manually in-browser** on 2026-09-15: Bob claimed the Wireless Headphones; a second claim attempt was rejected with `409` "This item is no longer available to claim", surfaced in the frontend error alert. Backend race protection also verified in `sc-validation.test.ts`. Automated e2e suite now in `frontend/tests/e2e/share-claim.spec.ts` — 2 tests passing.)
- [x] T037 [P] [SC-005] Validate owner privacy visibility in frontend/tests/e2e/ — Pass when the owner cannot see claimant or purchaser identity details while shared recipients can see the correct state. (Validated **manually in-browser** on 2026-09-15: owner Alice saw no state/claimant on any item incl. the claimed+purchased Espresso Machine; recipient Bob saw correct state + actions. Automated e2e suite now in `frontend/tests/e2e/owner-privacy.spec.ts` — 2 tests passing.)
- [x] T038 [P] [SC-006] Validate lifecycle and permission UX in frontend/tests/e2e/ — Pass when users can update permissions and state changes without technical support in at least 90% of executed flows. (Validated **manually in-browser** on 2026-09-15: Bob reverted his purchase (Espresso Machine `purchased → claimed`) and his claim (Scented Candle Set `claimed → available`); Alice revoked Bob's access, after which Bob's dashboard no longer listed the list and the API returned `403` "You do not have access to this list". Automated e2e suite now in `frontend/tests/e2e/lifecycle.spec.ts` — 2 tests passing.)

### Final polish and hardening

- [x] T039 [P] Update API documentation and contract validation for account, list, share, item, and cancellation flows in backend/docs/ and backend/tests/contract/ (API reference in `backend/docs/api.md`; contract suite in `backend/tests/contract/api-contract.test.ts`, 26 tests passing.)
- [x] T040 [P] Run the quickstart validation scenarios from specs/001-gift-list-sharing/quickstart.md and confirm the success criteria are met (full backend suite: 59 tests passing across 8 files, covering all 6 quickstart scenarios.)
- [x] T041 Review and harden logging, error UX, and access-control edge cases in backend/src/ and frontend/src/ (added request-logging middleware, security headers, CORS origin restriction, JSON body limit, 404 handler, and fixed the error-handler response shape to the flat `{ message }` the frontend expects; production-safe 5xx message masking.)
- [x] T042 Audit performance, concurrency, and privacy regression risks for claim, cancellation, and purchase races across backend/src/gift-items/ and backend/src/permissions/ (audit found and fixed a privacy regression: the dashboard `GET /lists` was leaking claim/purchase state to the owner; now filtered. Concurrency verified via atomic conditional `updateMany` + SC-004 race tests.)
- [x] T043 [P] Replace the temporary JSON-based MVP storage with database-backed persistence and migration strategy in backend/src/storage.ts, backend/src/config/, and backend/prisma/schema.prisma — persist User, GiftList, GiftItem, and SharePermission records without data loss across restarts and with schema constraints matching the requirements in specs/001-gift-list-sharing/data-model.md (storage is now Prisma-backed; `backend/src/storage.ts` reads/writes via Prisma)
- [x] T044 [P] Update backend and frontend tests to validate the database-backed storage model instead of the temporary JSON/in-memory setup in backend/tests/, frontend/tests/, and any persistence regression checks under backend/src/storage.ts — ensure restart behavior, auth flow, list access, and share-permission scenarios are covered against the real persistence layer (backend tests run against Prisma/PostgreSQL, including `persistence.test.ts`; the share/claim/purchase flow was validated manually in-browser against the live DB on 2026-09-15; automated frontend e2e persistence suite now in `frontend/tests/e2e/persistence.spec.ts` — 2 tests passing)

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (Phase 1)**: No dependencies - can start immediately
- **Foundational (Phase 2)**: Depends on Setup completion - BLOCKS all user stories
- **User Stories (Phase 3-7)**: All depend on the Foundational phase completing successfully
  - User Story 1: can start after Foundational; provides the MVP value chain
  - User Story 2: depends on the personal list foundation and can proceed after US1 is stable
  - User Story 3: depends on list sharing and auth flow and should be validated after US2 is in place
  - User Story 4: depends on US3's lifecycle logic and can be validated independently (also covers US5 state management)
- **Validation & Polish (Phase 7)**: Depends on all desired stories being complete and validated

### Story Completion Order

- **US1** -> **US2** -> **US3** -> **US4**
- A single team can work through these in priority order; the stories are designed to remain independently testable after each milestone.

### Parallel Opportunities

- Setup tasks T001-T003 can run in parallel
- Foundational tasks T005-T009 can run in parallel where file ownership is distinct
- US1 tasks T010-T015 can be parallelized across backend and frontend workstreams
- US2 tasks T011B-T015B can proceed once the list foundation is stable
- US3 tasks T016-T020 include database, service, API, and UI workstreams that can be split by component
- US4 tasks T021-T025 can run after the core state model is stable
- Validation and polish tasks T031-T044 are parallelizable after all story work is complete, with the SC-003 through SC-006 validation tasks leading the final QA passes

---

## Parallel Example: User Story 1

```bash
# Backend and frontend work can proceed together once Phase 2 is complete
Task: "Create User and GiftList domain models and repository contracts in backend/src/users/ and backend/src/gift-lists/"
Task: "Create GiftItem entity, validation rules, and list association model in backend/src/gift-items/"
Task: "Build dashboard, list creation form, and item management UI in frontend/src/pages/ and frontend/src/components/"
```

## Parallel Example: User Story 3

```bash
# Concurrency, API, and UI tasks can be developed in parallel once the claim model is defined
Task: "Create atomic item-state transition service and claim/purchase rules in backend/src/gift-items/"
Task: "Implement claim and purchase API endpoints with hidden-identity response filtering in backend/src/api/ and backend/src/gift-items/"
Task: "Build recipient claim and purchase flows, status badges, and conflict messages in frontend/src/components/, frontend/src/pages/, and frontend/src/services/"
```

---

## Implementation Strategy

### MVP First (User Story 1 Only)

1. Complete Setup and Foundational phases
2. Deliver User Story 1 end-to-end
3. Validate personal list creation and item management
4. Stop and confirm the MVP is stable before adding sharing and claim flows

### Incremental Delivery

1. Setup + Foundation -> base app infrastructure
2. US1 -> personal list management -> demo and validate
3. US2 -> explicit sharing -> validate access boundaries
4. US3 -> privacy-focused claim/purchase flow -> validate concurrency protections
5. US4 -> lifecycle state refinement -> validate full state model
6. Final polish -> docs, hardening, and regression checks

### Parallel Team Strategy

With multiple developers:

1. Team completes Setup + Foundational together
2. Developer A handles US1 backend and API
3. Developer B handles US1 frontend and forms
4. Developer C handles US2 permissions and share UX
5. Developer D handles US3 concurrency and privacy enforcement
6. Final phase is shared for validation, docs, and QA

---

## Notes

- [P] tasks represent distinct files or workstreams that can run in parallel without blocking each other.
- [USx] labels map work to the user story it supports for traceability and independent validation.
- Each story is intentionally scoped so it can be completed and tested without needing the entire system to be built at once.
- Claim and purchase logic MUST preserve the privacy rule that the list owner cannot see claimant identity (the purchaser is always the claimant) while shared recipients can still see necessary state.

---

## Phase 8: Convergence

_Added by `/speckit-converge` on 2026-09-19 after assessing the codebase against spec.md, plan.md, and the constitution. All existing tasks (T001–T044) are unchanged. Constitution check: no violations._

- [x] T045 Make item `quantity` optional to match FR-003 ("optional quantity or price information"): `quantity` is now `Int?` in backend/prisma/schema.prisma, `validateCreateGiftItem` in backend/src/gift-items/gift-item.validation.ts treats it as optional (min 1 only when supplied), the create route in backend/src/gift-items/router.ts stores `null` when absent, the form (frontend/src/components/GiftItemForm.tsx) no longer forces a value, the list row (frontend/src/components/GiftItemList.tsx) hides the "Qty:" segment when absent, and the spec artifacts (data-model.md, contracts/gift-list-api.md) were updated to reflect the optionality. `backend/tests/user-story-2.test.ts` now asserts that omitting `quantity` succeeds.
- [x] T046 Add the unit-test layer called for by the plan.md Testing decision (currently only integration and e2e suites exist): added `backend/tests/unit/gift-item-validation.test.ts` (11 tests) and `backend/tests/unit/access.test.ts` (7 tests, mocking Prisma) covering `backend/src/permissions/access.ts` and `backend/src/gift-items/gift-item.validation.ts`. Full backend suite: 77 tests passing across 10 files.
- The implementation should validate the quickstart success criteria and concurrency constraints before release.

---

## Phase 9: Convergence

_Added by `/speckit-converge` on 2026-09-20 after assessing the codebase against spec.md, plan.md, and the constitution. All existing tasks (T001–T046) are unchanged. Constitution check: no violations._

- [x] T047 Resolve and expose claimant identity for shared recipients per FR-009, US4/AC1, and the contract rule "claimant and purchaser identity": because only the claimant may purchase (FR-007/FR-008), the purchaser is always the claimant, so a single `claimantDisplayName` covers both. Added `backend/src/common/identity.ts` (`resolveIdentityNames` + `decorateItemIdentity`, one batched user lookup) and wired it into the recipient-facing reads only: `backend/src/gift-lists/router.ts` `GET /` and `GET /:listId`, and `backend/src/gift-items/router.ts` `GET /lists/:listId/items` — owner-side state/identity suppression is unchanged. The UI (`frontend/src/components/GiftItemList.tsx`) now shows "Claimed by / Purchased by <name>" for recipients; `frontend/src/services/api.ts` types `claimantDisplayName`. Also fixed a latent Prisma bug found by the new test (`orderBy` must be an array in `GET /lists/:listId/items`) and corrected stale e2e selectors (`button[title="Un-Claim"/"Un-Purchase"]` → `title="Cancel"`) in `owner-privacy.spec.ts` and `lifecycle.spec.ts`. Coverage: new backend test in `backend/tests/sc-validation.test.ts` (identity shown to recipients across all three read paths, absent for owner) and a new e2e assertion in `owner-privacy.spec.ts`. Backend suite: 78 tests passing; frontend e2e: 8 tests passing.

  _Convention refinement (2026-09-20): since the purchaser is always the claimant, the separate `purchaserUserId` field and `Purchaser` relation were removed from the Prisma schema and all code/tests/docs. The `state: 'purchased'` value is the sole source of purchase truth, and the claimant identity is authoritative even in the purchased state (and is preserved through a `purchased → claimed` unpurchase revert). Purchaser-specific authorization now anchors on `claimantUserId`._

---

## Phase 10: Convergence

_Added by `/speckit-converge` on 2026-09-20 after assessing the codebase against spec.md, plan.md, and the constitution. All existing tasks (T001–T047) are unchanged. Constitution check: no violations._

- [x] T048 Implement owner-side list rename (update list title) so User Story 1 AC2 is satisfied — currently `backend/src/gift-lists/router.ts` exposes only `GET`, `POST`, `POST /:listId/share`, `GET /:listId/share-permissions`, `GET /:listId`, and `DELETE /:listId` with no `PATCH`/`PUT /:listId` to change a list's title; there is no `updateList` client function in `frontend/src/services/api.ts` and no rename control in `frontend/src/pages/ListPage.tsx` or `frontend/src/pages/DashboardPage.tsx`. Add an owner-authorized list-update endpoint (validate a non-empty title, return the updated list, enforce `authorizeList('manage')`), document it in `specs/001-gift-list-sharing/contracts/gift-list-api.md`, expose it via a client function plus a rename UI, and add a backend test asserting the updated title round-trips in `GET /lists/:listId` (US1/AC2, partial).

  _Implemented 2026-09-20._ Added `PATCH /lists/:listId` to `backend/src/gift-lists/router.ts` (enforces `authorizeList('manage')` → owner-only; validates a non-empty title; updates `title` and optional `description`; returns the updated list with owner identity). Documented the endpoint in `specs/001-gift-list-sharing/contracts/gift-list-api.md`. Added `updateList()` to `frontend/src/services/api.ts` and a `RenameListForm` component (`frontend/src/components/RenameListForm.tsx`) wired into `frontend/src/pages/ListPage.tsx` as a "✎ Rename" button + modal for the owner. Added two backend tests in `backend/tests/user-story-1.test.ts` (owner rename round-trips through `GET /lists/:listId`; non-owner rename rejected with `403`). Validation: full backend suite **80 tests passing across 10 files** (up from 78); frontend unit test (`App.test.tsx`) **2 passing**. Note: the frontend `vite.config.ts` vitest block has no `include`/`exclude`, so `npm run test` also ingests the Playwright `tests/e2e/*.spec.ts` files (a pre-existing quirk — e2e runs via `test:e2e`/Playwright, not vitest); this does not affect T048.
