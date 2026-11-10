# Community Library Loan System: Requirements

## 1. Scope

This document specifies one JavaScript ES module for Node.js 26.

- It has no dependencies.
- It performs no file, network or console I/O.
- It exports exactly one function: `createLibrary()`.

Each call to `createLibrary()` returns a new, independent, empty library object. Libraries never share state. All methods are synchronous.

## 2. Policy constants

| Name | Value | Meaning |
|---|---|---|
| `LOAN_DAYS` | 21 | Length of a loan and of each renewal extension. |
| `MAX_RENEWALS` | 2 | Maximum renewals per loan. |
| `FINE_PER_DAY` | 25 | Cents charged per chargeable late day. |
| `GRACE_DAYS` | 3 | The first 3 late days are never charged. |
| `MAX_FINE_PER_LOAN` | 500 | Maximum fine for a single return (20 chargeable days). |
| `BLOCK_THRESHOLD` | 500 | A member who owes this many cents or more cannot borrow or renew. |
| `MAX_LOANS` | 5 | Maximum books a member may have on loan at once. |
| `MAX_HOLDS` | 5 | Maximum active holds per member, including holds that are set aside. |
| `PICKUP_DAYS` | 7 | Length of the pickup window for a set-aside book. |

## 3. Conventions

### 3.1 Dates

- A valid date is a string matching `^\d{4}-\d{2}-\d{2}$` that names a real Gregorian calendar day.
  - Leap years follow standard rules: `2024-02-29` is valid, `2023-02-29` is not.
  - Months run 01–12. Days must be valid for the month.
- Date arithmetic works on whole days with no time zones. Implement it with UTC, for example `Date.UTC`.
- `addDays(d, n)` returns the date `n` days after `d`.
- `diffDays(a, b)` returns `b − a` in days.
- Dates are compared chronologically. Lexicographic string comparison is valid for valid dates.
- Callers guarantee that a call's date is never earlier than the previous dated call's date. The implementation does not need to check this.

### 3.2 IDs

- `bookId` and `memberId` must be non-empty strings. Anything else is invalid.
- IDs are compared exactly and case-sensitively.
- A book ID and a member ID may be the same string; they live in separate namespaces.

### 3.3 Money

All amounts are integer cents.

### 3.4 Failure results

- No method ever throws, whatever the input. This includes a missing argument object, wrong types, unknown IDs and invalid dates.
- A disallowed or invalid action returns `{ ok: false, reason: <string> }` and changes no state.
  - The exception is time-driven hold expiry (§5), which is not a change made by the call.
- The `reason` values below are suggestions; they are ignored by callers.

### 3.5 Success results

Success results contain exactly the fields listed in the interface, with `ok: true` where `ok` is listed. They contain no other fields.

### 3.6 Copying

- Returned objects and arrays must be fresh copies.
- Mutating a returned value must not affect library state.

## 4. Data model

### 4.1 Book

A book has:

- `bookId`.
- `status`, which is exactly one of:
  - `shelf`: available to anyone.
  - `loaned`: on loan to exactly one member.
  - `reserved`: set aside for the first member in its hold queue.
- `holdQueue`: an ordered list of member IDs, earliest placed first. Each entry is either:
  - waiting, or
  - set aside, with `readyFrom` and `readyUntil` dates. Only the first entry can be set aside, and only when the status is `reserved`.

### 4.2 Loan

A loan has:

- `memberId` and `bookId`.
- `borrowDate`.
- `dueDate`.
- `renewals`, starting at 0.
- A creation sequence number, used for ordering.

### 4.3 Member

A member has:

- `memberId`.
- `owed`, an integer of cents, ≥ 0, starting at 0.
- Their active loans.
- Their active holds.

### 4.4 Invariants

- A book is `loaned` if and only if exactly one active loan references it.
- A book with `status = shelf` has an empty hold queue.
- A book with `status = reserved` has a non-empty queue, and its first entry is set aside.
- A member never holds a book they currently have on loan.
- A member never appears twice in one queue.

## 5. Time processing (hold expiry)

### 5.1 When it runs

Every dated method does the following before anything else:

1. Check the shape of its arguments.
2. If `date` is valid, run **advance(date)**.
3. Then evaluate the business rules.

Advance also runs when the call later fails for another reason, such as an unknown member. It does not run when `date` is invalid.

### 5.2 What advance(date) does

For every book with `status = reserved` whose first entry has `readyUntil < date`, repeat the following until that condition no longer holds:

1. Remove the first queue entry. The hold expires and that member gets no penalty.
2. Let `nextStart = addDays(expired.readyUntil, 1)`.
3. If the queue is now empty, set the book to `shelf`.
4. Otherwise, set aside the book for the new first entry with:
   - `readyFrom = nextStart`
   - `readyUntil = addDays(nextStart, PICKUP_DAYS − 1)`

### 5.3 Results of this rule

- The result is identical whether or not calls happened in between.
- On the call date, a book can be cascaded several members down the queue.
- The last valid pickup day is `readyUntil`, inclusive.
- Example: a book returned on 2026-01-10 is set aside with `readyUntil = 2026-01-16`. It is pickable through 2026-01-16. On 2026-01-17 it passes to the next member, ready 2026-01-17 to 2026-01-23.

## 6. Methods

Validation checks are applied in the order listed. The first failing check produces `{ ok: false }`.

### 6.1 `addBook({ bookId })` → `{ ok }`

**Fails when:**

- `bookId` is invalid.
- The book ID already exists.

**On success:**

- Creates the book with status `shelf` and an empty queue.
- Returns `{ ok: true }`.

Books cannot be removed.

### 6.2 `addMember({ memberId })` → `{ ok }`

**Fails when:**

- `memberId` is invalid.
- The member ID already exists.

**On success:**

- Creates the member with `owed = 0`, no loans and no holds.
- Returns `{ ok: true }`.

Members cannot be removed.

### 6.3 `borrow({ memberId, bookId, date })` → `{ ok, dueDate }`

**Fails when, in this order:**

1. An ID is invalid or the date is invalid.
2. The member is unknown.
3. The book is unknown.
4. The book is `loaned`. This includes the case where the member already has it.
5. The book is `reserved` for a different member.
6. The member's `owed ≥ BLOCK_THRESHOLD`.
7. The member has any loan with `dueDate < date` (an overdue loan).
8. The member already has `MAX_LOANS` loans.

**Success cases:**

- The book is `shelf`.
- The book is `reserved` and its first queue entry is this member. This is a pickup:
  - Remove that hold from the queue.
  - The remaining entries keep their order and shift up one position.

**On success:**

- Create a loan with `borrowDate = date`, `dueDate = addDays(date, LOAN_DAYS)` and `renewals = 0`.
- Set the book to `loaned`.
- Return `{ ok: true, dueDate }`.

If a pickup fails because of rule 6, 7 or 8, the hold stays set aside until it is picked up or it expires.

### 6.4 `returnBook({ memberId, bookId, date })` → `{ ok, fine }`

**Fails when:**

- An ID or the date is invalid.
- The member is unknown.
- The book is unknown.
- This member has no active loan of this book.

**Fine calculation:**

- `daysLate = max(0, diffDays(dueDate, date))`.
- `fine = min(MAX_FINE_PER_LOAN, FINE_PER_DAY × max(0, daysLate − GRACE_DAYS))`.
- Fine examples:

  | Days late | Fine (cents) |
  |---|---|
  | 0–3 | 0 |
  | 4 | 25 |
  | 5 | 50 |
  | 23 | 500 |
  | 100 | 500 |

**On success:**

1. Remove the loan.
2. Add `fine` to the member's `owed`.
3. If the hold queue is empty, set the book to `shelf`.
4. Otherwise, set the book to `reserved` for the first entry with:
   - `readyFrom = date`
   - `readyUntil = addDays(date, PICKUP_DAYS − 1)`
5. Return `{ ok: true, fine }`.

Returning is never blocked by money owed.

### 6.5 `renew({ memberId, bookId, date })` → `{ ok, dueDate }`

**Fails when, in this order:**

1. An ID or the date is invalid.
2. The member is unknown.
3. The book is unknown.
4. The member has no active loan of this book.
5. `date > dueDate`. An overdue loan cannot be renewed and must be returned.
6. `renewals ≥ MAX_RENEWALS`.
7. The book's hold queue is non-empty, meaning someone is waiting.
8. The member's `owed ≥ BLOCK_THRESHOLD`.

**On success:**

- Set `dueDate = addDays(oldDueDate, LOAN_DAYS)`. The extension is counted from the old due date, not from the renewal date, so early renewal loses no days.
- Increment `renewals`.
- Return `{ ok: true, dueDate }` with the new due date.

A renewal on the due date itself is allowed. The maximum total loan length is 63 days.

### 6.6 `placeHold({ memberId, bookId, date })` → `{ ok, position }`

**Fails when, in this order:**

1. An ID or the date is invalid.
2. The member is unknown.
3. The book is unknown.
4. The book is `shelf`, so it is available and should be borrowed instead.
5. The member currently has this book on loan.
6. The member is already in this book's queue. This includes being the member it is set aside for.
7. The member already has `MAX_HOLDS` active holds.

**On success:**

- Append the member to the end of the queue as waiting.
- Return `{ ok: true, position }`, where `position` is the new queue length.

Owing money does not prevent placing holds. Holds cannot be cancelled; they end only through pickup or expiry.

### 6.7 `payFine({ memberId, amount, date })` → `{ ok, owed }`

**Fails when:**

- The member ID or date is invalid.
- The member is unknown.
- `amount` is not an integer (`Number.isInteger`) or is `< 1`.
- `amount > owed`. Overpayment is rejected, which includes any payment when `owed = 0`.

**On success:**

- Set `owed -= amount`.
- Return `{ ok: true, owed }`.

Partial payments are allowed.

### 6.8 `getMember({ memberId, date })` → `{ loans, owed, holds }`

**On invalid input or an unknown member:** return `{ ok: false, reason }`.

**On success:** return exactly `{ loans, owed, holds }`, with no `ok` field.

- `loans` is an array of `{ bookId, dueDate }` in loan-creation order, oldest first. Each `dueDate` is current and reflects renewals.
- `owed` is the member's current owed cents.
- `holds` is an array of `{ bookId, position, readyUntil }` in the order the holds were placed, oldest first.
  - `position` is the 1-based index in that book's queue. The set-aside member is position 1.
  - `readyUntil` is the date when the book is set aside for this member, otherwise `null`.
- The values reflect state after `advance(date)`.

This method changes nothing except through expiry processing.

## 7. Worked example

1. Members A and B and book X are added.
2. **2026-01-01:** A borrows X. Due date is 2026-01-22.
3. **2026-01-05:** B places a hold on X. Position is 1.
4. **2026-01-10:** A tries to renew X. This fails because B is waiting.
5. **2026-01-27:** A returns X, 5 days late.
   - The fine is 50, so A owes 50.
   - X is reserved for B until 2026-02-02.
6. **2026-02-03:** `getMember(B)` shows no holds. The hold expired and X is back on the shelf.
7. **2026-02-03:** A borrows X successfully.
   - A owes 50, which is below the threshold.
   - A has no overdue loans.
   - The due date is 2026-02-24.
