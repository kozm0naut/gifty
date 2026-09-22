# Gifty API Documentation

Base URL: `http://localhost:4000`

All endpoints require a `Bearer` token in the `Authorization` header unless noted otherwise.

## Authentication

### POST /auth/register

Creates a new user account.

**Request Body:**
```json
{
  "email": "user@example.com",
  "password": "Password123!",
  "displayName": "User Name"
}
```

**Response 201:**
```json
{
  "user": { "id": "uuid", "email": "user@example.com", "displayName": "User Name" },
  "token": "jwt-token"
}
```

**Errors:**
- `400` — Missing or invalid fields
- `409` — Email already registered

### POST /auth/login

Authenticates an existing account.

**Request Body:**
```json
{
  "email": "user@example.com",
  "password": "Password123!"
}
```

**Response 200:**
```json
{
  "user": { "id": "uuid", "email": "user@example.com", "displayName": "User Name" },
  "token": "jwt-token"
}
```

**Errors:**
- `401` — Invalid credentials

---

## Gift Lists

### GET /lists

Returns all lists accessible to the current user (owned + shared).

**Response 200:**
```json
{
  "lists": [
    {
      "id": "uuid",
      "title": "Birthday List",
      "description": "Notes",
      "owner": { "id": "uuid", "displayName": "Owner", "email": "owner@example.com" },
      "items": [ ... ]
    }
  ]
}
```

### POST /lists

Creates a new gift list.

**Request Body:**
```json
{
  "title": "Birthday List",
  "description": "Optional notes"
}
```

**Response 201:**
```json
{
  "list": { "id": "uuid", "title": "Birthday List", "owner": { "id": "uuid", "displayName": "Owner", "email": "owner@example.com" } }
}
```

**Errors:**
- `400` — Missing title

### GET /lists/:listId

Returns a single list with items. **Owner-privacy filtering applies**: the owner sees all items as `state: "available"` with no `claimantUserId`. Recipients see full state.

**Response 200:**
```json
{
  "list": {
    "id": "uuid",
    "title": "Birthday List",
    "items": [
      { "id": "uuid", "name": "Headphones", "state": "available", "claimantUserId": null }
    ],
    "owner": { "id": "uuid", "displayName": "Owner", "email": "owner@example.com" }
  }
}
```

**Errors:**
- `403` — No access permission
- `404` — List not found (or deleted)

### DELETE /lists/:listId

Deletes a list and cascades to items and share permissions.

**Response 200:**
```json
{ "message": "List deleted", "listId": "uuid" }
```

**Errors:**
- `403` — Not the list owner
- `404` — List not found

---

## Sharing

### POST /lists/:listId/share

Shares a list with a recipient (by user ID or email).

**Request Body:**
```json
{
  "recipientUserId": "uuid",
  "permission": "shared"
}
```
or
```json
{
  "recipientEmail": "recipient@example.com",
  "permission": "shared"
}
```

**Response 201 (new) / 200 (updated):**
```json
{
  "sharePermission": { "id": "uuid", "giftListId": "uuid", "recipientUserId": "uuid", "permission": "shared" }
}
```

**Errors:**
- `400` — Missing recipient, self-share, invalid permission
- `403` — Not the list owner
- `404` — List or recipient not found

### GET /lists/:listId/share-permissions

Returns all share permissions for a list (owner only).

**Response 200:**
```json
{
  "permissions": [
    { "id": "uuid", "recipientUserId": "uuid", "recipientDisplayName": "Name", "permission": "shared" }
  ]
}
```

### DELETE /lists/:listId/share/:permissionId

Revokes a specific share permission (owner only).

**Response 204:** No content

**Errors:**
- `403` — Not the list owner
- `404` — Permission not found

---

## Gift Items

### POST /lists/:listId/items

Adds an item to a list (owner only).

**Request Body:**
```json
{
  "name": "Headphones",
  "description": "Noise cancelling",
  "quantity": 1,
  "unitPrice": 99.99
}
```

**Response 201:**
```json
{
  "item": { "id": "uuid", "giftListId": "uuid", "name": "Headphones", "state": "available" }
}
```

**Errors:**
- `400` — Validation failure (missing name, invalid quantity)
- `403` — Not the list owner
- `404` — List not found

### GET /lists/:listId/items

Returns items for a list. **Owner-privacy filtering applies** (same as GET /lists/:listId).

**Response 200:**
```json
{ "items": [ ... ] }
```

### PATCH /items/:itemId

**Always returns 403.** Gift items are immutable once created.

### DELETE /items/:itemId

**Always returns 403.** Gift items are immutable once created.

---

## Item Lifecycle

### POST /items/:itemId/claim

Claims an item (recipient only, item must be `available`).

**Request Body:**
```json
{ "claimantUserId": "uuid" }
```

**Response 200:**
```json
{ "item": { "id": "uuid", "state": "claimed", "claimantUserId": "uuid" } }
```

**Errors:**
- `403` — Owner attempting claim, or claimant mismatch
- `404` — Item not found
- `409` — Item no longer available (already claimed/purchased)

### POST /items/:itemId/purchase

Marks a claimed item as purchased (claimant only).

**Response 200:**
```json
{ "item": { "id": "uuid", "state": "purchased", "claimantUserId": "uuid" } }
```

**Errors:**
- `403` — Owner, or non-claimant attempting purchase
- `404` — Item not found
- `409` — Item not in claimed state

### POST /items/:itemId/unclaim

Reverts a claim (claimant only, item must be `claimed`).

**Response 200:**
```json
{ "item": { "id": "uuid", "state": "available", "claimantUserId": null } }
```

**Errors:**
- `403` — Owner, or non-claimant
- `404` — Item not found
- `409` — Item not in claimed state

### POST /items/:itemId/unpurchase

Reverts a purchase (claimant only, item must be `purchased`). The claimant identity is preserved through the revert.

**Response 200:**
```json
{ "item": { "id": "uuid", "state": "claimed", "claimantUserId": "uuid" } }
```

**Errors:**
- `403` — Owner, or non-claimant
- `404` — Item not found
- `409` — Item not in purchased state

---

## State Transition Diagram

```
available ──claim──▶ claimed ──purchase──▶ purchased
   ▲                   │                      │
   └────unclaim────────┘◀────unpurchase────────┘
```

- `available → claimed`: atomic, only one claimant wins
- `claimed → purchased`: only the claimant can purchase
- `claimed → available`: only the claimant can unclaim
- `purchased → claimed`: only the claimant can unpurchase
- `available → purchased`: **not supported** (must claim first)

## Privacy Rules

| Role | Sees item state | Sees claimant |
|------|----------------|---------------|
| Owner | Always `available` | Never |
| Recipient | Actual state | Yes |
