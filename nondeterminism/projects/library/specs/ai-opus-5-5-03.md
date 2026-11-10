# Requirements: Community Library Loan System

## 1. Scope

This document specifies one JavaScript ES module for Node.js 26.

- It has no dependencies.
- It performs no file, network or console I/O.
- It exports exactly one function, `createLibrary()`.
- Every call to `createLibrary()` returns a new, independent, empty library. Libraries share no state.
- All methods are synchronous.
- No method ever throws, for any input. This includes missing arguments, wrong types and malformed values.

## 2. Glossary

| Term | Meaning |
|---|---|
| **Book** | One physical copy, identified by `bookId`. A `bookId` is never more than one copy. |
| **Member** | A borrower, identified by `memberId`. |
| **Loan** | A book currently checked out to a member. |
| **Hold** | A member's place in a book's waiting line. |
| **Waiting hold** | A hold whose book is not yet set aside for that member. |
| **Ready hold** | A hold whose book has been set aside for that member. Its `readyUntil` is a date. |
| **Queue** | The ordered list of holds on one book, oldest first. |
| **Owed** | A member's unpaid fine balance, in integer cents. |
| **Day difference** | `diff(a, b)` = number of calendar days from date `a` to date `b`. |

## 3. Constants

| Name | Value |
|---|---|
| `LOAN_DAYS` | 21 |
| `MAX_RENEWALS` | 2 per loan |
| `MAX_LOANS` | 5 simultaneous loans per member |
| `FINE_PER_DAY` | 25 cents |
| `GRACE_DAYS` | 3 |
| `MAX_FINE_PER_LOAN` | 1000 cents |
| `BORROW_BLOCK_OWED` | 500 cents (borrowing is blocked when owed ≥ 500) |
| `PICKUP_DAYS` | 7 |

## 4. General Conventions

### 4.1 Result shape

**Failure.** When an action is not allowed or the input is invalid:
- The method returns `{ ok: false }`.
- A `reason` string may be added. Its content is free and is ignored by callers.
- No other fields are included.
- Nothing is changed.

**Success.** The method returns `ok: true` plus the fields listed for that method.

**Returned data.** Every returned object and array is a fresh copy. Mutating a returned value must never affect library state.

### 4.2 Input validation

Each method receives one argument object. The call fails if any of the following is true:
- The argument is not a non-null object.
- A required field is missing or invalid.

Field rules:
- **`memberId` and `bookId`:** must be non-empty strings. Comparison is exact and case-sensitive. Book IDs and member IDs are separate namespaces, so a book and a member may share an ID.
- **`date`:** must be a string that matches `^\d{4}-\d{2}-\d{2}$` and is a real Gregorian date.
  - The month must be 01–12.
  - The day must be valid for that month, including leap years (for example, `2024-02-29` is valid and `2023-02-29` is not).
  - The year must be 0001–9999.
- **`amount`:** must be a number that is a safe integer and > 0.

Extra fields in the argument object are ignored.

### 4.3 Dates

- Dates are whole calendar days with no time zones.
- Implement date arithmetic on UTC days, for example with `Date.UTC`. Never use local time.
- `addDays(d, n)` returns a `'YYYY-MM-DD'` string, zero-padded.

### 4.4 Clock and time order

- The library keeps a clock: the latest valid date it has seen. The clock starts unset.
- For any dated method:
  1. If the date is invalid, fail.
  2. If the date is earlier than the clock, fail. This guards against out-of-order calls, even though the caller promises calls arrive in time order.
  3. Otherwise, set the clock to the date, then run hold processing (§5) up to that date. Only then evaluate the business rules.
- Steps 2 and 3 apply even if the call later fails a business rule. This does not break "change nothing", because hold processing depends only on dates (§5). The observable state at any date is the same whatever calls are made.
- `addBook` and `addMember` take no date. They do not touch the clock.

### 4.5 Validation order

The order of checks does not matter, because every failure returns only `{ ok: false }`.

## 5. Hold Processing (Pickup Expiry)

This runs at the start of every dated call, for every book, using the call date `D`.

For each book, repeat while the head of its queue is a ready hold with `readyUntil < D`:
1. Remove that hold. No charge is made.
2. Let `E = addDays(oldReadyUntil, 1)`.
3. If the queue still has holds, the new head becomes ready with `readyUntil = addDays(E, PICKUP_DAYS)`.
4. If the queue is empty, the book returns to the shelf and is available.

The result is that set-aside windows chain back-to-back. They do not depend on when calls happen to arrive.

## 6. Book States

Each book is in exactly one of these states:

| State | Description | Queue |
|---|---|---|
| **Available** | On the shelf, no loan, no ready hold. | Always empty. |
| **On loan** | Checked out to one member. | May have waiting holds. |
| **Set aside** | No loan. The head of the queue is a ready hold. | The other holds are waiting. |

Only the head of a queue can be ready.

## 7. Methods

### 7.1 `addBook({ bookId }) -> { ok }`

- Fails if `bookId` is invalid or already exists.
- On success, the book is added in the Available state.

### 7.2 `addMember({ memberId }) -> { ok }`

- Fails if `memberId` is invalid or already exists.
- On success, the member is added with no loans, no holds and owed = 0.

### 7.3 `borrow({ memberId, bookId, date }) -> { ok, dueDate }`

The call fails if any of the following is true:
- Any input is invalid.
- The member does not exist.
- The book does not exist.
- The book is on loan. This includes being on loan to this same member.
- The book is set aside for a different member.
- The member already has `MAX_LOANS` loans.
- The member's owed ≥ `BORROW_BLOCK_OWED`.

On success:
- If the book was set aside for this member, that ready hold is removed. The remaining holds on the book move up by one position and stay waiting.
- A loan is created with:
  - `loanDate = date`
  - `dueDate = addDays(date, LOAN_DAYS)`
  - `renewals = 0`
- The method returns `{ ok: true, dueDate }`.

### 7.4 `returnBook({ memberId, bookId, date }) -> { ok, fine }`

The call fails if any of the following is true:
- Any input is invalid.
- The member or the book does not exist.
- The book is not currently on loan to this member.

On success:

1. Calculate the fine:
   - Let `daysLate = diff(dueDate, date)`.
   - If `daysLate ≤ GRACE_DAYS`, the fine is 0. This includes early and on-time returns.
   - Otherwise, the fine is `min(daysLate × FINE_PER_DAY, MAX_FINE_PER_LOAN)`. Every late day is charged once the grace period is exceeded.
   - Examples: 3 days late → 0; 4 days late → 100; 40 days late → 1000; 60 days late → 1000.
2. Add the fine to the member's owed.
3. Remove the loan.
4. Update the book:
   - If its queue is non-empty, the head hold becomes ready with `readyUntil = addDays(date, PICKUP_DAYS)`, and the book becomes Set aside.
   - Otherwise, the book becomes Available.
5. Return `{ ok: true, fine }`.

### 7.5 `renew({ memberId, bookId, date }) -> { ok, dueDate }`

The call fails if any of the following is true:
- Any input is invalid.
- The member or the book does not exist.
- The book is not on loan to this member.
- The loan is overdue (`date > dueDate`). Renewing on the due date itself is allowed.
- The loan's `renewals` already equals `MAX_RENEWALS`.
- The book's queue is non-empty, meaning someone is waiting.

Owed fines do not block renewal.

On success:
- `dueDate = addDays(currentDueDate, LOAN_DAYS)`.
- `renewals` increases by 1.
- The method returns `{ ok: true, dueDate }` with the new due date.

### 7.6 `placeHold({ memberId, bookId, date }) -> { ok, position }`

The call fails if any of the following is true:
- Any input is invalid.
- The member or the book does not exist.
- The book is Available. The member should borrow it instead.
- The book is on loan to this member.
- The member already has a hold on this book, whether waiting or ready.

There is no limit on the number of holds a member may have.

On success:
- The hold is appended to the end of the book's queue as a waiting hold.
- `position` is the hold's 1-based index in the queue.
- A ready hold at the head of the queue counts as position 1.
- The method returns `{ ok: true, position }`.

### 7.7 `payFine({ memberId, amount, date }) -> { ok, owed }`

The call fails if any of the following is true:
- Any input is invalid.
- The member does not exist.
- `amount > owed`. Overpayment is rejected, so any payment fails when owed is 0.

On success:
- owed decreases by `amount`.
- The method returns `{ ok: true, owed }` with the remaining balance.

### 7.8 `getMember({ memberId, date })`

- Fails with `{ ok: false }` if any input is invalid or the member does not exist.
- On success it returns:

```
{ ok: true,
  loans: [{ bookId, dueDate }],
  owed,
  holds: [{ bookId, position, readyUntil }] }
```

| Field | Content |
|---|---|
| `loans` | The member's current loans, in the order they were borrowed (call order). `dueDate` reflects any renewals. |
| `owed` | The current balance in cents. |
| `holds` | Every hold the member has, waiting or ready, in the order the holds were placed. |
| `holds[].position` | The hold's current 1-based index in its book's queue. |
| `holds[].readyUntil` | The date the book is set aside until, if the book is set aside for this member. Otherwise `null`. |

- The member can borrow a set-aside book on any date ≤ `readyUntil`.
- Expired holds have already been removed by §5, so they never appear.
- Holds removed by borrowing never appear.
- Empty lists are returned as `[]`.
- Apart from clock and hold processing (§4.4, §5), this method changes nothing.

## 8. Invariants (for testing)

- A book has at most one loan.
- When a book is on loan, no hold on it is ready.
- A member never holds a book they currently have on loan.
- A member has at most one hold per book.
- owed is always an integer ≥ 0.
- All money values are integers.
- All returned dates are valid `'YYYY-MM-DD'` strings.
