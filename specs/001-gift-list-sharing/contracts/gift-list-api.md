# Gift List API Contract

## Overview

This document defines the user-facing contracts for a web application that supports account creation, gift-list management, list sharing, and claim/purchase workflows. The interface is intentionally framed as a public project contract and not a full implementation specification.

## Authentication

### POST /auth/register

Creates a new user account.

Request body:
- email: string
- password: string
- displayName: string

Response:
- 201 Created
- user: { id, email, displayName }

### POST /auth/login

Authenticates an existing account.

Request body:
- email: string
- password: string

Response:
- 200 OK
- token: string
- user: { id, email, displayName }

## Gift Lists

### GET /lists

Returns all lists accessible to the current authenticated user.

Response:
- 200 OK
- lists: array of objects with list metadata and permissions

### POST /lists

Creates a new gift list.

Request body:
- title: string
- description: string (optional)

Response:
- 201 Created
- list: { id, title, description, owner: { id, displayName, email } }

### GET /lists/{listId}

Returns a single list and its visible item details.

Response:
- 200 OK
- list: { id, title, items: [...] }

### PATCH /lists/{listId}

Updates the title (and optionally the description) of a list. Only the list
owner may perform this action.

Request body:
- title: string (required, non-empty)
- description: string (optional; omit to leave unchanged, null to clear)

Response:
- 200 OK
- list: { id, title, description, owner: { id, displayName, email } }

### POST /lists/{listId}/share

Shares a list with a specific recipient.

Request body:
- recipientUserId: UUID (or recipientEmail: string)
- permission: "shared"

Response:
- 201 Created
- sharePermission: { id, giftListId, recipientUserId, permission }

## Gift Items

### POST /lists/{listId}/items

Adds an item to a gift list.

Request body:
- name: string
- description: string (optional)
- quantity: integer (optional; min 1 when supplied, per FR-003)
- unitPrice: number (optional)

Response:
- 201 Created
- item: { id, giftListId, name, state: "available" }

### PATCH /items/{itemId}

Gift items are immutable once created (FR-010). This endpoint is rejected to
prevent breaking existing claims or purchases.

Response:
- 403 Forbidden
- message: "Gift items are immutable once created"

## Claims and Purchases

### POST /items/{itemId}/claim

Claims an item for the authenticated recipient. The claimant is always the
authenticated user; a `claimantUserId` in the body must match it or the request
is rejected.

Request body:
- claimantUserId: UUID (optional; must match the authenticated user)

Response:
- 200 OK
- item: { id, state: "claimed", claimantUserId }

### POST /items/{itemId}/purchase

Marks a claimed item as purchased. Only the current claimant may purchase; the
purchaser is always the authenticated user (the claimant), so no separate
purchaser identity is stored.

Request body:
- (none)

Response:
- 200 OK
- item: { id, state: "purchased", claimantUserId }

## Authorization Rules

- Only the authenticated list owner may manage the list configuration and permissions.
- Only authorized recipients can view a list or interact with gift items.
- The list owner cannot claim, purchase, unclaim, or unpurchase items on their own list; only shared recipients may act on items. Attempting any of these actions as the owner returns `403` with "Only shared recipients can claim items".
- The list owner must not receive any claim or purchase state in response payloads for items on their own list.
- Any authorized recipient with list access must be able to see all claim and purchase state details, including the claimant identity (which is also the purchaser), for items on lists shared with them.
- Any claim or purchase action must be validated server-side before state change is committed.
