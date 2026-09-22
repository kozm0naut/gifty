# Research: Gift List Sharing

## Decision: Use Node.js with TypeScript for the backend

- Decision: The backend will use Node.js with TypeScript, preferably with a structured framework such as NestJS or Express with a service-oriented architecture.
- Rationale: This project is primarily an API-driven web app with authenticated list, share, and item operations. Node.js delivers a strong TypeScript ecosystem, fast iteration, and good parity with a browser-based React front end while staying simple enough for an MVP.
- Alternatives considered: Go, Java/Spring Boot, and .NET. These are all viable for a production service, but they do not provide a materially better advantage for this feature and would add framework and operational overhead without solving a requirement that Node.js cannot address.

## Decision: Use PostgreSQL as the system of record

- Decision: PostgreSQL will store users, gift lists, gift items, and sharing permissions, with application logic enforcing access rules and transactional item-state checks.
- Rationale: The data model is relational, the requirements include concurrency-safe claims and purchases, and PostgreSQL provides robust transactions, constraints, and indexing for this domain.
- Alternatives considered: SQLite, MySQL, and document stores. SQLite is acceptable for local/dev prototypes but is less suitable for multi-user production use; MySQL is viable but less often chosen when the app’s rules are strongly relational; document stores would complicate transactional uniqueness and permission checks.

## Decision: Use React.js for the frontend

- Decision: The browser interface will be built with React.js and TypeScript, optionally using Vite for the app shell and state management patterns tailored to list management and recipient interactions.
- Rationale: React is a strong fit for a dashboard-driven app with forms, shared list views, claim flows, and permission updates. It provides a mature component model and ecosystem for a product that needs rich interactive UI but not a bespoke framework.
- Alternatives considered: Vue and server-rendered HTML-only approaches. Vue is viable and may be equally good in some teams, but React is the default choice here because of ecosystem familiarity, component patterns, and the need for a responsive interactive UI.

## Decision: Use explicit share permissions with a strict visibility matrix

- Decision: The application will model list access as an explicit permission relationship between the list owner and one or more invited users, with a strict visibility matrix: the list owner cannot see any claim or purchase state for items on a list they own, and any shared recipient can see all claim and purchase state details, including the claimant and/or purchaser, for items on lists shared with them.
- Rationale: The feature requires a surprise element for the list originator while still allowing recipients to coordinate a gift purchase. Explicit share permissions plus a role-based visibility matrix are the least-privilege model and align with the constitution's privacy rules.
- Alternatives considered: Broad public share links, visible buyer tracking for all participants, and making gift claims a separate data model. These were rejected because they either expose private data or add unnecessary domain complexity for the MVP.

## Decision: Treat gift state as a canonical item lifecycle, not a separate entity model

- Decision: Each GiftItem will carry the canonical lifecycle values available → claimed → purchased, with optional claimant and purchaser references stored as restricted fields.
- Rationale: State transitions are the core behavior and map directly to the feature requirements without introducing additional domain entities. This keeps the model simple and avoids over-engineering the initial product while preserving a single shared vocabulary.
- Alternatives considered: Creating standalone ClaimRecord and PurchaseState entities or introducing a parallel state alongside the canonical lifecycle. Rejected because the business requirement is centered on item lifecycle and privacy, not multi-entity audit records or a duplicated state model.

## Decision: Use transactional claim locking to prevent duplicate claims

- Decision: Claim and purchase operations will be processed as atomic transactions or equivalent lock-based checks to ensure only one recipient can hold a valid claim at the same time.
- Rationale: The feature explicitly requires preventing duplicate claims/purchases, and simultaneous attempts are a likely edge case. Atomic write validation is the simplest reliable mechanism.
- Alternatives considered: Best-effort UI validation and client-side checks only. Rejected because they do not protect against race conditions or multiple concurrent requests.

## Decision: Default to a relational data model for permissions and gift state

- Decision: The product should use a relational data model for users, lists, items, permissions, and item state transitions.
- Rationale: Relationships between owner, recipient, list, and item are strongly structured, and relational storage makes permission checks and auditability straightforward.
- Alternatives considered: Document-based or key-value storage. Rejected because rule enforcement around access, state, and uniqueness is easier to reason about in a relational schema.
