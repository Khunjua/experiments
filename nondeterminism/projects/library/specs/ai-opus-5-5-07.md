# Community Library Loan System: Requirements

## 1. Scope

Deliver one JavaScript ES module for Node.js 26.

- It has no dependencies.
- It performs no file, network or console I/O.
- It exports exactly one function, `createLibrary()`.
- Each call returns a new, empty and independent library object. Library objects share no state with each other.
- All methods are synchronous.

## 2. Constants

| Name | Value | Meaning |
|---|---|---|
| LOAN_DAYS | 21 | Length of a loan and of each renewal, in days |
| MAX_RENEWALS | 2 | Maximum renewals per loan |
| FINE_PER_DAY | 25 | Cents charged per chargeable late day |
| GRACE_DAYS | 2 | Late days that are never charged |
| FINE_CAP | 1000 | Maximum fine for a single loan, in cents |
| BLOCK_THRESHOLD | 500 | If owed ≥ this amount, the member cannot borrow or renew |
| PICKUP_DAYS | 7 | Days a set-aside book waits for the member at the front of the line |

## 3. General conventions

### 3.1 Never throw

No method may throw for any input. This includes:

- missing arguments
- a non-object argument
- wrong types
- unknown IDs
- invalid dates

### 3.2 Failure result

- On failure, a method returns `{ ok: false }`. It may add a `reason` string. It must change nothing.
- On success, a method returns `ok: true` plus the fields described for that method.
- A failed call still triggers the hold-expiry processing in §5.4. That processing is not counted as a change made by the call.

### 3.3 Input validation

A call fails if any of these checks fails:

- **IDs** (`bookId`, `memberId`): must be non-empty strings. Book IDs and member IDs are separate namespaces, so the same string may be used for a book and a member. IDs are compared exactly, and case matters.
- **Dates**: must be strings matching `^\d{4}-\d{2}-\d{2}$` and naming a real Gregorian calendar date. Leap years count, so `2024-02-29` is valid and `2023-02-29` is not.
- **Amount** (`payFine`): must be an integer number (`Number.isInteger`) greater than 0.

### 3.4 Date arithmetic

- Dates are whole calendar days. Use day-count arithmetic that does not depend on time zones, such as UTC epoch days.
- Output dates use the `YYYY-MM-DD` format with zero padding.
- "date + n" means the calendar day n days later.
- `daysBetween(a, b)` is b − a, measured in days.

### 3.5 Call order

- Dated calls never go backwards in time. The implementation does not need to check this.
- `addBook` and `addMember` carry no date and do not trigger expiry processing.

### 3.6 Copies

Each `bookId` is exactly one physical copy.

## 4. State

### 4.1 Book state

A book is in exactly one of these states:

- **Available**: on the shelf.
- **On loan**: held by one member. The book records:
  - its due date
  - the number of renewals used
- **Set aside**: reserved for the first member in its hold line. The book records:
  - the reserved member
  - `readyUntil`

### 4.2 Hold line

- Each book has a hold line: an ordered list of member IDs, with the first entry at position 1.
- If a book is set aside, the member at position 1 is the member it is set aside for.
- An available book always has an empty hold line.

### 4.3 Member state

Each member has an `owed` balance in integer cents, starting at 0.

## 5. Methods

### 5.1 `addBook({ bookId })`

- Fails if `bookId` is invalid.
- Fails if `bookId` already exists.
- Otherwise, the book is added as Available and the method returns `{ ok: true }`.

### 5.2 `addMember({ memberId })`

- Fails if `memberId` is invalid.
- Fails if `memberId` already exists.
- Otherwise, the member is added with owed = 0, no loans and no holds, and the method returns `{ ok: true }`.

### 5.3 Common steps for dated methods

Every dated method follows these steps in order:

1. Validate the inputs.
2. Run expiry processing (§5.4) for the call's date. This uses the date only, and runs even if the other inputs are invalid or the IDs are unknown, as long as the date itself is valid.
3. Apply the method's rules.

### 5.4 Expiry processing for date D

For every book that is set aside, repeat while it is set aside and D > `readyUntil`:

1. Remove the reserved member's hold. The member is not charged.
2. If the hold line is still not empty, set the book aside for the new first member, with `readyUntil` = previous `readyUntil` + 1 + PICKUP_DAYS.
3. If the hold line is now empty, the book becomes Available.

### 5.5 `borrow({ memberId, bookId, date })` → `{ ok, dueDate }`

The call fails if any of the following is true:

- an input is invalid
- the member is unknown
- the book is unknown
- the book is on loan, whether to this member or to anyone else
- the book is set aside for a different member
- the member has any loan with dueDate < date (an overdue loan)
- the member's owed ≥ BLOCK_THRESHOLD

There is no limit on how many books a member may have on loan.

On success:

- The book goes on loan to the member with dueDate = date + LOAN_DAYS and 0 renewals used.
- If the book was set aside for this member, that hold is removed and the remaining holds each move up one position.
- The method returns `{ ok: true, dueDate }`.

### 5.6 `returnBook({ memberId, bookId, date })` → `{ ok, fine }`

The call fails if:

- an input is invalid, or
- the member or book is unknown, or
- the book is not currently on loan to this member.

The fine is calculated as follows:

1. late = `daysBetween(dueDate, date)`.
2. chargeable = max(0, late − GRACE_DAYS).
3. fine = min(chargeable × FINE_PER_DAY, FINE_CAP).

The fine is added to the member's owed. Fines exist only once they are charged at return. A loan that is overdue but not yet returned adds nothing to owed.

After the return:

- If the hold line is not empty, the book is set aside for position 1 with `readyUntil` = date + PICKUP_DAYS.
- Otherwise the book becomes Available.

The method returns `{ ok: true, fine }`. The fine is 0 when there is no fine.

Examples (due date 2026-03-22):

| Return date | Late days | Fine |
|---|---|---|
| 2026-03-22 | 0 | 0 |
| 2026-03-24 | 2 | 0 |
| 2026-03-25 | 3 | 25 |
| 2026-04-01 | 10 | 200 |
| 2026-05-20 | 59 | 1000 (capped) |

### 5.7 `renew({ memberId, bookId, date })` → `{ ok, dueDate }`

The call fails if any of the following is true:

- an input is invalid
- the member or book is unknown
- the book is not on loan to this member
- date > dueDate (the loan is overdue)
- renewals used = MAX_RENEWALS
- the book's hold line is not empty (someone is waiting)
- the member's owed ≥ BLOCK_THRESHOLD

On success:

- New dueDate = date + LOAN_DAYS. This is never earlier than the old due date.
- Renewals used increases by 1.
- The method returns `{ ok: true, dueDate }`.

Renewing on the same day as the borrow is allowed. It still uses one of the renewals.

### 5.8 `placeHold({ memberId, bookId, date })` → `{ ok, position }`

The call fails if any of the following is true:

- an input is invalid
- the member or book is unknown
- the book is Available (the member should borrow it instead)
- the member currently has this book on loan
- the member is already in this book's hold line, including when the book is set aside for them

Holds are allowed whatever the member owes. A member may hold any number of different books.

On success:

- The member is appended to the end of the hold line.
- The method returns `{ ok: true, position }`, where position is the new length of the line.
- If the book is set aside for someone else, that member stays at position 1, so the new hold is at position 2 or later.

### 5.9 `payFine({ memberId, amount, date })` → `{ ok, owed }`

The call fails if any of the following is true:

- an input is invalid
- the member is unknown
- amount > owed. Overpayment is rejected. This includes any payment made when owed = 0.

On success:

- owed decreases by amount.
- The method returns `{ ok: true, owed }` with the new balance.

### 5.10 `getMember({ memberId, date })`

- If the input is invalid or the member is unknown, the method returns `{ ok: false }`.
- Otherwise it returns `{ loans, owed, holds }` and does not include an `ok` field.

The fields are:

- **`loans`**: `[{ bookId, dueDate }]` for every book currently on loan to the member, in the order the loans started.
- **`owed`**: the current balance in cents. It includes charged fines only.
- **`holds`**: `[{ bookId, position, readyUntil }]` for every hold the member currently has, in the order the holds were placed.
  - `position` is the current 1-based place in that book's line.
  - `readyUntil` is the date string if the book is set aside for this member, and `null` otherwise.

Expiry processing (§5.4) runs before the result is built.

The method is otherwise read-only. It must return fresh objects and arrays, so that changing them does not change the library's state.
