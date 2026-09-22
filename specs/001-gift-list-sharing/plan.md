# Implementation Plan: Gift List Sharing

**Branch**: `001-gift-list-sharing` | **Date**: 2026-09-10 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from [spec.md](spec.md)

## Summary

This feature will be implemented as a TypeScript web application with a Node.js backend and a React front end. The backend will expose authenticated APIs for account management, list ownership, share permissions, and claim/purchase lifecycle updates; PostgreSQL will store the user, list, item, and permission records so the app can enforce transactional concurrency and privacy rules reliably. React will provide the interactive browser experience for list management, invitation flows, and recipient actions while the server remains the source of truth for authorization and privacy enforcement.

## Technical Context

**Language/Version**: Node.js 20 LTS with TypeScript for the application logic and client code.

**Primary Dependencies**: Node.js + TypeScript backend using NestJS (or Express with a structured service layer), PostgreSQL, Prisma or TypeORM, JWT/session authentication, React + Vite, React Router, form validation, and testing tools for API and browser-level validation.

**Storage**: PostgreSQL is the preferred database because the schema is relational and needs strict constraints around user ownership, share permissions, and atomic item-state transitions.

**Testing**: Unit, integration, and end-to-end tests covering access control, state transitions, concurrency control, and privacy boundaries. Recommended tools include Vitest/Jest, Supertest, and Playwright or Cypress for UI flows.

**Target Platform**: Web application with a Node.js API server and a browser-based React client; deployable to a standard cloud or VPS environment.

**Project Type**: Web application

**Performance Goals**: Support small-group gift-list usage with fast list reads, low-latency claim operations, and reliable concurrent access checks under expected daily traffic.

**Constraints**: Privacy-by-default behavior, explicit consent for sharing, no leakage of claimant or purchaser identity to the list owner, concurrency-safe claim resolution with transactional correctness, and a strict visibility matrix where the owner sees no claim or purchase state while shared recipients see all current claim/purchase state details for items on lists shared with them.

**Scale/Scope**: MVP for personal and small-group usage; supports multiple users, multiple lists, and moderate item volumes without requiring enterprise-scale infrastructure.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Gates from [.specify/memory/constitution.md](../../.specify/memory/constitution.md):

- **User Trust & Privacy**: PASS. The design explicitly requires authenticated access, consent-based sharing, and a strict visibility matrix that hides all claim or purchase state from list owners while exposing it to authorized recipients.
- **List Integrity & Consent**: PASS. Gift items are managed through permissioned state transitions with strong constraints on what each user can see and do, including owner-only suppression of claim/purchase state.
- **Test-First Delivery**: PASS. The plan includes automated tests for authorization, state transitions, and concurrency handling before implementation.
- **Security by Default**: PASS. Server-side authorization and model-level validation are required for every list access and mutation.
- **Simple, Explainable Sharing**: PASS. The state model is item-based and explicit; the app communicates access and status without forcing hidden behaviors.

No constitution violations were identified that require a complexity exception or extra justification.

## Project Structure

### Documentation (this feature)

```text
specs/001-gift-list-sharing/
├── plan.md              # This file
├── research.md          # Research findings and key product decisions
├── data-model.md        # Entity model and state transitions
├── quickstart.md        # Validation scenarios for feature verification
├── contracts/
│   └── gift-list-api.md # Shared interface contract for list and item operations
├── spec.md              # Product specification
└── checklists/
    └── requirements.md # Quality checklist
```

### Source Code (repository root)

```text
backend/
├── src/
│   ├── auth/
│   ├── users/
│   ├── gift-lists/
│   ├── gift-items/
│   ├── permissions/
│   └── api/
├── tests/
│   ├── integration/
│   ├── contract/
│   └── unit/
└── docs/

frontend/
├── src/
│   ├── app/
│   ├── components/
│   ├── pages/
│   ├── routes/
│   └── services/
├── tests/
│   └── e2e/
└── public/
```

**Structure Decision**: A split web app structure is the most appropriate fit because the feature includes both authenticated user flows and shared recipient interactions. A dedicated backend enforces privacy rules and item state transitions, while the front end handles user-facing list management and interaction flows.

## Phase 0: Research Findings

The design decisions resolved in [research.md](research.md) are:

- Shared lists use explicit invite-based permissions instead of broad public visibility.
- The canonical item lifecycle is available → claimed → purchased.
- Claim and purchase state are modeled as item lifecycle state fields, not independent entities.
- Claim operations are atomic and concurrency-safe to prevent duplicate claims.
- Relational storage is the default because permission and state models are strongly connected.

## Phase 1: Design & Contracts

### Data model summary

The concrete model is documented in [data-model.md](data-model.md):

- User: account and authentication state
- GiftList: owner, metadata, and permissions
- GiftItem: title, quantity, description, state, claimantUserId (the purchaser is always the claimant; no separate purchaser field)
- SharePermission: explicit recipient access entries

### Interface contract summary

The public contract for the app is described in [contracts/gift-list-api.md](contracts/gift-list-api.md):

- Account registration and login
- List creation and retrieval
- Sharing and access permissions
- Gift item creation and update
- Claim and purchase actions with authorization checks

### Validation guide

The feature validation flow is documented in [quickstart.md](quickstart.md):

- create a list
- share it to a recipient
- claim an item without exposing the claimant to the owner
- prevent duplicate claims
- mark a gift purchased while preserving the privacy boundary

## Re-check of Constitution

After design completion, the plan still satisfies the constitution because the design preserves:

- explicit consent for sharing
- user-level authorization and validation
- hidden claim/purchase identities from the list originator
- testable privacy and state transitions

## Complexity Tracking

No constitution-level complexity exceptions are required for this feature.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| None | N/A | N/A |
