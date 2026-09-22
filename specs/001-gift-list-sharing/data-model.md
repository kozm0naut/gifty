# Data Model: Gift List Sharing

## Overview

This feature centers on a user-owned collection of gift items, sharing permissions, and restricted visibility for claim and purchase actions. The data model intentionally keeps claim and purchase state as properties of the GiftItem rather than separate top-level entities.

## Entities

### User

| Field | Type | Description | Validation |
|-------|------|-------------|------------|
| id | UUID | Unique user identifier | Required |
| email | string | Login and account identity | Required, unique |
| passwordHash | string | Authenticated credential storage | Required |
| displayName | string | User-visible display label | Required |
| createdAt | datetime | Account creation time | Required |

Relationships:
- One user owns many GiftList records.
- One user can receive many SharePermission invitations.
- One user may hold many item claims or purchases as the claimant (the purchaser is always the claimant).

### GiftList

| Field | Type | Description | Validation |
|-------|------|-------------|------------|
| id | UUID | Unique list identifier | Required |
| ownerUserId | UUID | User who created and owns the list | Required |
| title | string | List name | Required |
| description | string | Optional notes or summary | Optional |
| status | enum | active, archived, or deleted | Required |
| createdAt | datetime | Creation time | Required |
| updatedAt | datetime | Last modification time | Required |

Relationships:
- Many GiftItem records belong to one GiftList.
- One GiftList has many SharePermission records.

### GiftItem

| Field | Type | Description | Validation |
|-------|------|-------------|------------|
| id | UUID | Unique item identifier | Required |
| giftListId | UUID | Owning list | Required |
| name | string | Gift title | Required |
| description | string | Optional notes | Optional |
| quantity | integer | Number requested | Optional; min 1 when supplied (FR-003) |
| unitPrice | decimal | Optional price estimate | Optional, non-negative |
| state | enum | available, claimed, purchased | Required |
| claimantUserId | UUID | Recipient currently assigned to this item (authoritative in all states, including purchased) | Optional |
| claimedAt | datetime | Time of claim | Optional |
| purchasedAt | datetime | Time of purchase | Optional |
| createdAt | datetime | Creation time | Required |
| updatedAt | datetime | Last modification time | Required |

Validation rules:
- state must be one of available, claimed, or purchased.
- claimantUserId is allowed only when state is claimed or purchased.
- the purchaser is always the claimant, so no separate purchaser identity is stored.
- claim and purchase information must be hidden from the list owner while remaining accessible to authorized recipients.
- only one active claimant may exist per item at a time.
- only one effective claim or purchase may be committed per item at a time.
- an item must be claimed before it can be purchased; there is no direct available -> purchased path.

State transitions:
- available -> claimed
- claimed -> available (if claim is revoked or canceled)
- claimed -> purchased
- purchased -> claimed (if the purchase is reverted by the claimant)
- purchased -> available is not allowed unless an explicit reset workflow exists.
- any state transition that would assign a new claimant must validate the item is still in the expected precondition at commit time; otherwise the operation is rejected.

### SharePermission

| Field | Type | Description | Validation |
|-------|------|-------------|------------|
| id | UUID | Unique permission identifier | Required |
| giftListId | UUID | List being shared | Required |
| ownerUserId | UUID | List owner granting access | Required |
| recipientUserId | UUID | Invited user | Required |
| permission | enum | shared | Required |
| createdAt | datetime | Permission creation time | Required |
| updatedAt | datetime | Last modification time | Required |

Validation rules:
- recipientUserId must be a different user from the ownerUserId.
- permission is a single `shared` level granting the recipient access to view the list and act on its items.
- a recipient without share permission cannot view list content or act on items.

## Relationships

- One User owns many GiftList records.
- One GiftList contains many GiftItem records.
- One GiftList has many SharePermission rows.
- A GiftItem belongs to exactly one GiftList.
- GiftItem state may reference one claimant; the purchaser is always the claimant, so the claimant reference is treated as item metadata rather than an independent entity.

## Privacy constraints

- The list owner must not be able to read any claim or purchase state for items on a list they own.
- Any authorized recipient who has access to a shared list must be able to see all claim and purchase state details, including the claimant identity (which is also the purchaser), for items on that shared list.
- Claim and purchase data must remain accessible only to the explicitly authorized recipient group and never to the list owner.
- Authorization is enforced server-side on every list and item read/write operation.
