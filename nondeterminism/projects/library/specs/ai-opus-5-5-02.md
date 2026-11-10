# Community Library Loan System: Requirements

## 1. Scope

This is a single JavaScript ES module for Node.js 26.

- It has no dependencies.
- It performs no file, network or console I/O.
- It exports exactly one function, `createLibrary()`.
- Every call to `createLibrary()` returns a new, independent, empty library object. Separate libraries never share state.
- All methods are synchronous.

## 2. Constants

| Name | Value | Meaning |
|---|---|---|
| `LOAN_DAYS` | 21 | Loan period, and the extension granted by each renewal |
| `MAX_RENEWALS` | 2 | Renewals allowed per loan |
| `FINE_PER_DAY` | 25 | Cents charged per late day |
| `MAX_FINE_PER_LOAN` | 1000 | Cap on the fine for one return ($10). This is the "not harsh" rule. |
| `GRACE_DAYS` | 0 | There is no grace period. The cap provides the leniency. |
| `BORROW_BLOCK_OWED` | 1000 | A member who owes this many cents or more cannot borrow |
| `MAX_LOANS` | 5 | Maximum active loans per member |
| `MAX_HOLDS` | 5 | Maximum active holds per member. Both waiting and set-aside holds count. |
| `PICKUP_DAYS` | 7 | Length of the pickup window for a set-aside book |

## 3. General conventions

### 3.1 Identifiers

- `bookId` and `memberId` must be non-empty strings. Any other value is invalid.
- IDs are compared exactly, so they are case-sensitive.
- Books and members live in separate namespaces. A book and a member may have the same ID.

### 3.2 Dates

- A valid date is a string matching `YYYY-MM-DD` that names a real calendar date. The year must be 0001–9999, the month 01–12, and the day must exist in that month, including leap-year rules.
- Strings such as `2026-02-30`, `2026-1-05` or `2026-01-05T00:00` are invalid.
- Date arithmetic uses whole days in UTC, so there are no time zone or DST effects.
- "date + n" means the calendar date n days later.
- "a − b" means the number of whole days between them.

### 3.3 Money

- All amounts are integer numbers of cents.

### 3.4 Time ordering

- The library remembers the latest date seen. This is the date of the most recent accepted, dated call.
- A dated call is a call to `borrow`, `returnBook`, `renew`, `placeHold`, `payFine` or `getMember` that carries a valid date.
- A dated call whose date is earlier than the latest date seen is rejected with `{ ok: false }`, and no state changes. This includes no expiry processing. This is a defensive rule; the interface promises it will not happen.
- A dated call whose date is valid and not earlier than the latest date seen does two things before evaluating its own business rules:
  1. It updates the latest date seen.
  2. It runs hold-expiry processing up to that date (see §6.4).
- These two steps happen even if the call itself then fails a business rule. They reflect the passage of time, not a change made by the call.
- `addBook` and `addMember` carry no date. They never affect the latest date seen or expiry processing.

### 3.5 Failure behaviour

- Methods never throw because of a business rule or bad input. A missing argument object, wrong types and invalid dates are all handled without throwing.
- When an action is not allowed, the method returns `{ ok: false }` and changes nothing. The only exception is the time and expiry processing described in §3.4.
- A `reason` string may be added to a failure result. Callers ignore it.
- On failure, no other fields are required. Implementations should not include `dueDate`, `fine`, `position` or `owed` on failure.

### 3.6 Success result shape

Successful results contain `ok: true` plus exactly the fields listed for that method. There are no extra fields.

## 4. State model

### 4.1 Book

Each book has:
- its ID;
- a status, which is one of:
  - **on shelf**;
  - **on loan** to a member;
  - **set aside** for a member, until a `readyUntil` date;
- a hold queue: an ordered list of member IDs waiting for the book, oldest first.

If the book is set aside, the member it is set aside for is not in the queue; that member is tracked separately as the set-aside holder.

### 4.2 Loan

Each loan has:
- the member ID and book ID;
- the `dueDate`;
- the number of renewals used (0–2);
- a creation sequence number, used for ordering.

### 4.3 Member

Each member has:
- an `owed` balance in cents, always 0 or more;
- active loans;
- active holds, ordered by when they were placed.

## 5. Methods

### 5.1 `addBook({ bookId })` → `{ ok }`

It fails if:
- `bookId` is invalid; or
- a book with that ID already exists.

On success:
- The book is created on the shelf with an empty hold queue.
- It returns `{ ok: true }`.

### 5.2 `addMember({ memberId })` → `{ ok }`

It fails if:
- `memberId` is invalid; or
- a member with that ID already exists.

On success:
- The member is created with `owed = 0`, no loans and no holds.
- It returns `{ ok: true }`.

### 5.3 `borrow({ memberId, bookId, date })` → `{ ok, dueDate }`

It fails if any of these are true:
- The date is invalid, or earlier than the latest date seen.
- The member does not exist.
- The book does not exist.
- The book is on loan. This includes being on loan to this same member.
- The book is set aside for a different member.
- The book is on the shelf, but its hold queue is not empty. This is a safety rule; under the rules in §6 this state does not occur.
- The member already has `MAX_LOANS` (5) active loans.
- The member's `owed` is at least `BORROW_BLOCK_OWED` (1000).

A member who is only waiting in the queue cannot borrow the book. This follows from the book being on loan or set aside for someone else.

On success:
- If the book was set aside for this member, that hold is consumed and removed from the member's holds. The book's queue is unchanged, so the remaining waiters keep their relative order.
- A loan is created with `dueDate = date + 21` and 0 renewals used.
- The book becomes on loan to this member.
- It returns `{ ok: true, dueDate }`.

### 5.4 `returnBook({ memberId, bookId, date })` → `{ ok, fine }`

It fails if:
- the date is invalid or too early;
- the member or book does not exist; or
- the book is not currently on loan to this member.

On success:
1. Compute the late days: `daysLate = max(0, date − dueDate)`. Returning on the due date means 0 late days.
2. Compute the fine: `fine = min(daysLate × 25, 1000)`.
3. Add the fine to the member's `owed`.
4. Remove the loan.
5. Update the book:
   - If the book's queue is non-empty, remove the first member from the queue. The book becomes set aside for that member, with `readyUntil = date + 7`.
   - Otherwise, the book goes back on the shelf.
6. Return `{ ok: true, fine }`. The fine is 0 if the book was not late.

### 5.5 `renew({ memberId, bookId, date })` → `{ ok, dueDate }`

It fails if:
- the date is invalid or too early;
- the member or book does not exist;
- the book is not on loan to this member;
- the loan has already been renewed 2 times;
- the loan is overdue, meaning `date > dueDate`. Renewal is allowed on the due date itself;
- the book's hold queue is not empty, meaning someone is waiting.

Renewal is not blocked by money owed.

On success:
- The new due date is `date + 21`. Because calls arrive in time order, this is never earlier than the old due date.
- The renewal count increases by 1.
- It returns `{ ok: true, dueDate }` with the new due date.

### 5.6 `placeHold({ memberId, bookId, date })` → `{ ok, position }`

It fails if:
- the date is invalid or too early;
- the member or book does not exist;
- the book is on the shelf. A member cannot hold an available book; they should borrow it;
- the book is on loan to this member;
- this member is already in the book's queue, or the book is set aside for this member;
- the member already has `MAX_HOLDS` (5) active holds.

Holds are not blocked by money owed.

On success:
- The member is appended to the end of the book's queue.
- The returned position is:
  - (number of members in the queue, including the new one) + 1, if the book is set aside for someone;
  - otherwise, the number of members in the queue, including the new one.
- It returns `{ ok: true, position }`.

### 5.7 `payFine({ memberId, amount, date })` → `{ ok, owed }`

It fails if:
- the date is invalid or too early;
- the member does not exist;
- `amount` is not an integer, or is less than or equal to 0;
- `amount` is greater than the member's current `owed`. Overpayment is rejected; partial payment is allowed.

On success:
- `owed` decreases by `amount`.
- It returns `{ ok: true, owed }` with the remaining balance.

### 5.8 `getMember({ memberId, date })` → `{ loans, owed, holds }`

This method is read-only, apart from the time and expiry processing in §3.4.

It returns `{ ok: false }` if:
- the date is invalid or too early; or
- the member does not exist.

On success it returns exactly `{ loans, owed, holds }`. The `ok` field is omitted, to match the interface.

- **`loans`**: an array of `{ bookId, dueDate }`, one for each active loan.
  - Entries are in the order the loans were created; renewal does not reorder them.
  - Each `dueDate` is the current due date.
- **`owed`**: the current balance in cents.
- **`holds`**: an array of `{ bookId, position, readyUntil }`, one for each active hold.
  - Entries are in the order the holds were placed.
  - For a hold whose book is set aside for this member, `position` is 1 and `readyUntil` is the last pickup day.
  - For a waiting hold, `position` is:
    - the member's 1-based index in the queue, plus 1 if the book is currently set aside for someone else;
    - otherwise, just the 1-based index.
    - In both cases `readyUntil` is `null`.
  - Positions are computed at call time, after expiry processing.
- The returned arrays and objects are fresh copies. Changing them must not affect library state.

## 6. Hold rules

1. A hold may only be placed on a book that is unavailable to the member, as listed in §5.6.
2. When a book with waiters is returned, it is immediately set aside for the first waiter, as described in §5.4.
3. The set-aside holder may borrow the book through `borrow` on any day up to and including `readyUntil`.
4. **Expiry.** A set-aside hold expires when time passes beyond its `readyUntil`.
   - Expiry processing to date `D` repeats the following for every book until nothing changes. Books may be processed in any order; the results are the same.
   - The rule: while the book is set aside and `readyUntil < D`:
     1. Remove that hold from its member's holds.
     2. Let `start = readyUntil + 1`.
     3. If the queue is non-empty, remove the first waiter and set the book aside for them with `readyUntil = start + 7`.
     4. Otherwise, put the book back on the shelf.
   - So an expired holder is dropped entirely. They are not re-queued, and they are not charged.
   - Several holds can expire in a chain during one call if a long time has passed.
5. Members have no way to cancel a hold through this interface. Holds end only through pickup or expiry.
6. A member's hold count includes both waiting and set-aside holds.

## 7. Worked examples

All examples start from a new library with books B1 and B2 and members A, C and D.

1. **Borrow and return late.**
   - A borrows B1 on 2026-01-01. Result: `dueDate` 2026-01-22.
   - A returns B1 on 2026-01-25. Result: `fine` 75. A owes 75.
2. **Fine cap.**
   - A loan due 2026-01-22 is returned on 2026-03-01, which is 38 days late.
   - The fine is `min(950, 1000) = 950`.
   - If it is returned 50 days late, the fine is 1000.
3. **Renewal.**
   - A borrows B1 on 2026-01-01; it is due 2026-01-22.
   - A renews on 2026-01-10. New due date: 2026-01-31.
   - A renews on 2026-01-31. New due date: 2026-02-21.
   - A third renewal fails with `{ ok: false }`.
4. **Hold blocks renewal; hold expires.**
   - A borrows B1 on 2026-01-01.
   - C places a hold on 2026-01-02. Result: position 1.
   - D places a hold the same day. Result: position 2.
   - A tries to renew. Result: `{ ok: false }`.
   - A returns B1 on 2026-01-05. B1 is set aside for C until 2026-01-12.
   - `getMember(D)` on 2026-01-05 shows `{ bookId: 'B1', position: 2, readyUntil: null }`.
   - C does not pick the book up.
   - On 2026-01-13, any dated call expires C's hold. B1 is set aside for D until 2026-01-20, and D now shows position 1 with `readyUntil` 2026-01-20.
   - If no call happens until 2026-01-25, both holds have expired by then and B1 is on the shelf.
5. **Borrow block.**
   - A owes 1000. A's `borrow` call fails.
   - A pays 1: `owed` becomes 999.
   - A can now borrow.
6. **Overpayment.**
   - A owes 75. `payFine` with amount 100 fails.
   - `payFine` with amount 75 succeeds and returns `owed: 0`.
