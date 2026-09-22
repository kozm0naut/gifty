# Quickstart: Gift List Sharing Validation

## Prerequisites

- Web browser for end-user flow validation.
- Authenticated user accounts for list owner and at least one recipient.
- A relational database supporting user, list, item, and permission records.

## Validation Scenarios

### 1. Create and manage a list

1. Register a new account as the list owner.
2. Create a new gift list with a title and one or more items.
3. Confirm the list appears in the owner's dashboard.
4. Update the list and verify the latest item details are visible.

Expected result: The owner can maintain a personal list without needing permission from another user.

### 2. Share a list with a recipient

1. Register a second account for the recipient user.
2. In the owner account, open a gift list.
3. Add the recipient account to the list share permissions.
4. Log in as the recipient and verify access to the list details.
5. Attempt access as an uninvited user and verify denial.

Expected result: Only invited recipients have access.

### 3. Claim a gift without revealing identity to the owner
 
1. Register a third account for a second recipient user.
2. Share the same gift list with both recipient accounts.
3. Log in as the first recipient with access to the list.
4. Claim a gift item.
5. Confirm the claim is visible to the authorized recipient group, including the second recipient, and that each recipient sees all claim and purchase state details for the shared list.
6. Log in as the list owner and verify they cannot see the claimant identity or any claim or purchase state details for the item.

Expected result: The claim is recorded and visible to the right audience while remaining hidden from the owner.

### 4. Prevent duplicate claims

1. Start two different recipient sessions for the same list.
2. Attempt to claim the same item simultaneously.
3. Confirm only one claim succeeds and the other is rejected.

Expected result: Duplicate claims are prevented consistently.

### 5. Mark a gift as purchased

1. After a valid claim exists, mark the item as purchased by an authorized recipient.
2. Verify the purchase state updates correctly for shared recipients.
3. Confirm the list owner does not see the purchaser identity.

Expected result: The lifecycle state progresses correctly while preserving privacy.

### 6. Prevent a direct purchase race

1. Share the same gift list with two recipient accounts.
2. Set the gift item to an available state.
3. In two separate recipient sessions, attempt to purchase the same item at nearly the same time while another recipient is also attempting to claim it.
4. Confirm only one action succeeds and the other is rejected with a conflict or stale state error.
5. Attempt to purchase the same item at nearly the same time while another recipient is also attempting to purchase it.
6. Confirm only one action succeeds and the other is rejected with a conflict or stale state error.

Expected result: A direct available -> purchased transition cannot win at the same time as another claim or purchase for the same item.
