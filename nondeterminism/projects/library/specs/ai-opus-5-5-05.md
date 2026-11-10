# Requirements: Community Library Loan System

## 1. Scope and deliverable

1.1. Deliver one JavaScript ES module for Node.js 26. It has no dependencies and does no file, network or console I/O.

1.2. The module exports exactly one named export: `createLibrary()`.

1.3. Each call to `createLibrary()` returns a new, independent library object. It starts with no books, no members, no loans, no holds and no debts. Instances never share state.

1.4. All methods are synchronous. A method never throws, whatever its input: missing arguments, wrong types, malformed values and unknown IDs all produce a failure result.

## 2. Business parameters (fixed constants)

| Constant | Value |
|---|---|
| Loan period | 21 days |
| Maximum renewals per loan | 2 |
| Maximum simultaneous loans per member | 5 |
| Late fee | 25 cents per chargeable day |
| Grace period | 2 days (the first 2 late days are free) |
| Maximum fine per return | 1000 cents |
| Borrowing blocked when owed is at least | 500 cents |
| Pickup window for a set-aside book | 7 days |

## 3. General conventions

### 3.1. Results

- **Success:** every action method returns an object with `ok: true` plus the fields named in its section.
- **Failure:** the method returns `{ ok: false, reason: <string> }`. The `reason` text is informative only and has no required wording. A failed call changes no business state, except for time-based processing (§3.4).
- **getMember:** on success it returns `{ ok: true, loans, owed, holds }`. On failure it returns `{ ok: false, reason }`.

### 3.2. Input validation (applies to every method)

The call fails if any of the following is true:

- The argument is not a non-null object.
- `memberId` or `bookId`, where required, is not a non-empty string. IDs are compared exactly and are case-sensitive.
- `date`, where required, is not a valid date string (§3.3).
- `amount`, where required, is not a safe integer greater than 0.

Book IDs and member IDs are separate namespaces. A book and a member may share the same ID string.

### 3.3. Dates

- **Format:** exactly `YYYY-MM-DD`, matching `^\d{4}-\d{2}-\d{2}$`.
- **Valid values:** year 0001–9999, month 01–12, and a day that exists in that month under Gregorian leap-year rules. For example, `2024-02-29` is valid and `2023-02-29` is invalid.
- **Arithmetic:** dates are whole calendar days with no time zones. "Date + N days" and "days between A and B" are pure calendar arithmetic. Implement them with a day-number conversion or with UTC-only `Date` methods so that local time zones and DST cannot affect results.
- **Output:** all output dates use the same zero-padded `YYYY-MM-DD` format.

### 3.4. The library clock and time-based processing

- **Clock:** the library keeps a "current date". It is initially unset.
- **Order of steps in a dated call:** for every call carrying a date, after input validation:
  1. If the date is earlier than the current date, the call fails and nothing changes. The interface promises this cannot happen; this rule is defensive only.
  2. Otherwise the current date becomes the call's date.
  3. Hold expiry (§7.4) is processed up to and including that date.
  4. Only then are the business rules checked.
- **Persistence:** steps 2 and 3 persist even if the call then fails a business rule. They reflect the passage of time and are not changes made by the action.
- **Undated calls:** `addBook` and `addMember` carry no date. They do not affect the clock and trigger no processing.

## 4. Catalog and members

### 4.1. `addBook({ bookId })` returns `{ ok }`

- **Fails if** `bookId` is invalid or already exists.
- **On success,** the book is registered as an available copy: not on loan, not set aside, and with an empty hold queue.
- Each `bookId` is one physical copy.

### 4.2. `addMember({ memberId })` returns `{ ok }`

- **Fails if** `memberId` is invalid or already exists.
- **On success,** the member is registered with no loans, no holds, and `owed = 0`.

### 4.3. Removal

Books and members can never be removed.

## 5. Book states

At any moment a book is in exactly one of these states:

- **Available:** not on loan and not set aside. Its hold queue is necessarily empty.
- **On loan:** borrowed by exactly one member. Its hold queue may be empty or not.
- **Set aside:** not on loan and reserved for the member at the head of its hold queue, until that hold's `readyUntil` date (inclusive).

## 6. Loans

### 6.1. `borrow({ memberId, bookId, date })` returns `{ ok, dueDate }`

The call fails if any of the following is true:

- The member or the book does not exist.
- The book is on loan to anyone, including this member.
- The book is set aside for a different member.
- The member already has 5 loans.
- The member's `owed` is at least 500.

It succeeds when the book is either:

- available, or
- set aside for this member, with `date` on or before `readyUntil`. After expiry processing (§3.4), that is always the case if the book is still set aside for them.

On success:

- A loan is created with `dueDate = date + 21 days` and a renewal count of 0. The response contains this `dueDate`.
- If the book was set aside for this member, that hold is removed. Every remaining hold on the book moves up one position.

### 6.2. `renew({ memberId, bookId, date })` returns `{ ok, dueDate }`

The call fails if any of the following is true:

- The member or the book does not exist.
- The member does not currently have this book on loan.
- The loan has already been renewed 2 times.
- The book's hold queue is not empty (someone is waiting).
- The loan is overdue, meaning `date` is later than the current `dueDate`. Overdue books must be returned instead.
- `date + 21 days` is not later than the current `dueDate`. This happens, for example, when renewing on the same day as the borrow or the previous renewal. A renewal must actually extend the loan.

On success:

- The new `dueDate` is `date + 21 days`.
- The renewal count increases by 1.
- The response contains the new `dueDate`.

Owing money does not block renewal.

### 6.3. `returnBook({ memberId, bookId, date })` returns `{ ok, fine }`

The call fails if any of the following is true:

- The member or the book does not exist.
- The member does not currently have this book on loan.

**Fine calculation.** On success, compute:

- `daysLate = days from dueDate to date`. This is 0 or negative if the book is returned on or before the due date.
- `chargeableDays = max(0, daysLate − 2)`.
- `fine = min(25 × chargeableDays, 1000)`.

Examples:

| Return timing | Fine |
|---|---|
| On or before the due date | 0 |
| 1 or 2 days late | 0 |
| 3 days late | 25 |
| 10 days late | 200 |
| 42 days late or more | 1000 |

**Effects of a successful return:**

1. The loan is removed.
2. `fine` is added to the member's `owed`.
3. If the book's hold queue is empty, the book becomes available.
4. Otherwise the book becomes set aside for the member at the head of the queue, with `readyUntil = date + 7 days`.

The response contains `fine`, which is 0 if none was charged.

**No other fines.** Fines arise only at return. Overdue books that are still on loan do not add to `owed`.

## 7. Holds

### 7.1. Queue model

- **Queue:** each book has a first-in, first-out hold queue of distinct members.
- **Position:** a member's position is their 1-based index in that queue. Position 1 means "next".
- **Set-aside hold:** when a book is set aside, it is always for the position-1 member. Only that hold has a non-null `readyUntil`.

### 7.2. `placeHold({ memberId, bookId, date })` returns `{ ok, position }`

The call fails if any of the following is true:

- The member or the book does not exist.
- The book is available. The member should borrow it instead.
- The member currently has this book on loan.
- The member already has a hold on this book, whether waiting or set aside.

The call succeeds when the book is on loan to another member or set aside for another member.

On success:

- The member is appended to the end of the queue.
- The response contains `position`, which equals the new queue length.

There is no limit on the number of holds per member. Owing money does not block holds.

### 7.3. Holds and a waiting queue

A non-empty queue blocks renewals (§6.2). It does not affect the current borrower's ability to return the book.

### 7.4. Pickup expiry (time-based processing)

Before handling any dated call (§3.4), repeat the following for every set-aside book until no further change occurs:

- If the current date is later than its `readyUntil`, then:
  1. Remove the head hold. No fine is charged for an uncollected hold.
  2. If the queue is now empty, the book becomes available.
  3. Otherwise the book is set aside for the new head, with `readyUntil = previous readyUntil + 8 days`. The new window starts the day after the previous one ended and lasts 7 days, so the result is independent of when calls happen to arrive.
  4. Check again: the new hold may also already be expired.

## 8. Money

### 8.1. `payFine({ memberId, amount, date })` returns `{ ok, owed }`

The call fails if any of the following is true:

- The member does not exist.
- `amount` is invalid (§3.2).
- `amount` is greater than the member's current `owed`. Overpayment is rejected, so a payment when `owed` is 0 always fails.

On success, `owed` decreases by `amount`. The response contains the remaining `owed`.

### 8.2. The `owed` total

- `owed` is a non-negative integer number of cents.
- It is a single running total per member.
- It increases only through fines charged in `returnBook` and decreases only through `payFine`.

## 9. `getMember({ memberId, date })`

**Failure.** The call fails if the input is invalid or the member does not exist. The date rules and expiry processing of §3.4 apply first.

**Success.** It returns `{ ok: true, loans, owed, holds }`. It changes no business state.

- **`loans`:** `[{ bookId, dueDate }]` for every current loan of the member.
  - The order is the order in which the loans were created, oldest first.
  - `dueDate` reflects any renewals. Overdue loans are included as normal.
- **`owed`:** the current total in cents.
- **`holds`:** `[{ bookId, position, readyUntil }]` for every current hold of the member.
  - The order is the order in which the holds were placed, oldest first.
  - `position` is the current queue position.
  - `readyUntil` is the last pickup date if the book is currently set aside for this member. Otherwise it is `null`.

**Returned objects.** They are fresh copies. Mutating them does not affect library state.

## 10. Worked example

| Step | Call | Result | Notes |
|---|---|---|---|
| 1 | Setup: `addBook B`, `addMember M1`, `addMember M2` | — | |
| 2 | `borrow(M1, B, 2026-01-01)` | ok, `dueDate` `2026-01-22` | |
| 3 | `placeHold(M2, B, 2026-01-05)` | ok, `position` 1 | |
| 4 | `renew(M1, B, 2026-01-10)` | fails | Someone is waiting. |
| 5 | `returnBook(M1, B, 2026-01-27)` | ok, `fine` 75 | 5 days late, minus 2 grace days, = 3 × 25. |
| 6 | `getMember(M2, 2026-01-27)` | `holds` `[{ bookId: B, position: 1, readyUntil: '2026-02-03' }]` | The book is set aside for M2. |
| 7 | `getMember(M2, 2026-02-04)` | `holds` `[]` | The hold expired and the book is available again. |
| 8 | `payFine(M1, 100, …)` | fails | Overpayment. |
| 9 | `payFine(M1, 75, …)` | ok, `owed` 0 | |
