# Requirements: Community Library Loan System

## 1. Scope and deliverable

1.1. Deliver one JavaScript ES module for Node.js 26. It has no dependencies. It performs no file, network or console I/O.

1.2. The module exports exactly one named export, `createLibrary()`.

1.3. Each call to `createLibrary()` returns a new, independent, empty library object. Two libraries never share state.

1.4. All methods are synchronous.

1.5. No method throws for any input. This includes missing, malformed or wrongly typed arguments. Every rejected action returns `{ ok: false }` and changes nothing. A rejection may also include a `reason` string. Callers ignore it. Suggested codes are listed in section 13.

## 2. Fixed policy values

| Policy | Value |
|---|---|
| Loan period | 21 days |
| Maximum renewals per loan | 2 |
| Renewal period | 21 days, counted from the renewal date |
| Late fine | 25 cents per day late |
| Maximum fine per returned book | 500 cents. This cap is the "not harsh" rule. |
| Pick-up window for a book set aside on a hold | The set-aside day plus 7 more days |
| Maximum number of loans per member | No limit |
| Money owed blocks borrowing, renewing or holds | No. Members may always act regardless of what they owe. |

## 3. Data conventions

### 3.1. Dates

- A date is a string in the exact form `YYYY-MM-DD`: 4 digits, a hyphen, 2 digits, a hyphen, 2 digits.
- It must be a real date in the proleptic Gregorian calendar. Leap years follow the usual rule: divisible by 4, except centuries that are not divisible by 400.
  - Invalid examples: `2026-02-30`, `2026-13-01`, `2026-1-05`, `20260105`.
- Dates are whole days with no time of day and no time zone.
- Implement day arithmetic in a way that is immune to the local time zone and daylight saving time. Two safe approaches:
  - convert the date to a day number using UTC, or
  - do pure calendar arithmetic.
- Output dates always use the same zero-padded format.
- "D + n days" means the calendar date n days after D. For example, `2026-12-20` + 21 days = `2027-01-10`.
- "Days between A and B" means the number of calendar days from A to B. For example, from `2026-01-01` to `2026-01-03` is 2 days.

### 3.2. Money

- Money is always an integer number of cents.
- Fines and the amount owed are never negative.

### 3.3. Identifiers

- `bookId` and `memberId` must be non-empty strings.
- They are compared exactly. Comparison is case-sensitive, with no trimming.
- Book IDs and member IDs are separate namespaces. A book and a member may share the same ID string.
- Each `bookId` identifies one physical copy. There are no multiple copies under one ID.

### 3.4. Arguments

- Each method takes a single object argument.
- Extra properties are ignored.
- The call is rejected with `{ ok: false }` if any of these hold:
  - the argument is not a non-null object,
  - a required property is missing,
  - a property has the wrong type or format.

## 4. Time handling

### 4.1. Library clock

- The library keeps a clock, which is the latest date seen so far. It starts with no value.
- A dated call is any of `borrow`, `returnBook`, `renew`, `placeHold`, `payFine` or `getMember`.
- Every dated call with a valid date that is not earlier than the clock moves the clock to that date. This applies even if the call is then rejected for a business rule.
- `addBook` and `addMember` have no date and do not affect the clock.

### 4.2. Out-of-order dates

The interface guarantees dates never go backwards. As a defensive rule, a dated call whose date is earlier than the clock is rejected with `{ ok: false }` and changes nothing. This also applies to `getMember`.

### 4.3. Time-based events

- Hold pick-up expirations (section 9.4) depend only on dates, not on which calls happen.
- Before evaluating any dated call, the library applies every expiration due up to and including that call's date.
- This catch-up step is not considered a "change" made by the call. It happens whether or not the call itself succeeds.

## 5. Library state (conceptual)

**Books.** A set of book IDs. Each book is in exactly one of three states:

| State | Meaning |
|---|---|
| Available | On the shelf. Any member may borrow it. |
| On loan | Held by exactly one member. |
| Set aside | Returned, and reserved for the first member in its hold line until that member's `readyUntil` date. |

**Members.** A set of member IDs. Each member has an owed balance in cents, which starts at 0.

**Loans.** Each loan records:
- member,
- book,
- borrow date,
- current due date,
- number of renewals used (0–2),
- a creation sequence number, used for ordering.

**Holds.** Each book has an ordered line of active holds, oldest first. Each hold records:
- member,
- book,
- placement sequence number,
- `readyUntil`: a date if the book is set aside for this hold, otherwise null.

Only the first hold in a line can be set aside.

**Invariant.** An available book never has active holds.

## 6. `addBook({ bookId })` → `{ ok }`

1. Reject if `bookId` is invalid (see 3.3).
2. Reject if a book with this ID already exists.
3. Otherwise, add the book in the Available state and return `{ ok: true }`.

There is no way to remove books.

## 7. `addMember({ memberId })` → `{ ok }`

1. Reject if `memberId` is invalid.
2. Reject if a member with this ID already exists.
3. Otherwise, add the member with owed = 0 and return `{ ok: true }`.

There is no way to remove members.

## 8. `borrow({ memberId, bookId, date })` → `{ ok, dueDate }`

Apply the date checks (section 4), then check these rules in order. Reject at the first failure.

1. The IDs and the date must be valid.
2. The member must exist.
3. The book must exist.
4. The book must not be on loan. This covers loans to any member, including this one.
5. If the book is set aside, it must be set aside for this member.

On success:

- If the book was set aside for this member, remove that hold from the line. The remaining holds move up one position.
- Create a loan:
  - borrow date = `date`,
  - due date = `date` + 21 days,
  - renewals used = 0.
- Mark the book as on loan to the member.
- Return `{ ok: true, dueDate }`.

Owed money never blocks borrowing.

## 9. Holds

### 9.1. `placeHold({ memberId, bookId, date })` → `{ ok, position }`

Apply the date checks, then check these rules in order. Reject at the first failure.

1. The IDs and the date must be valid.
2. The member must exist.
3. The book must exist.
4. The book must not be available. A member should borrow an available book instead of holding it. A book is "out" when it is on loan or set aside.
5. The member must not currently have this book on loan.
6. The member must not already have an active hold on this book, whether waiting or set aside.

On success:

- Append the hold to the end of the book's line, with `readyUntil` = null.
- Return `{ ok: true, position }`, where `position` is the new line length.
- The set-aside hold, if any, counts as position 1.

### 9.2. Positions

- A hold's position is its 1-based index in its book's line.
- Positions always reflect the current state after removals. When a hold ahead is fulfilled or expires, the holds behind it move up.

### 9.3. Setting a book aside

When a book becomes free and its line is not empty:

- the book becomes set aside for the first hold in the line, and
- that hold's `readyUntil` = (the day the book became free) + 7 days.

The book becomes free in one of two ways:
- it is returned (see 11), or
- a previous set-aside expired (see 9.4).

When a book becomes free and its line is empty, it becomes available.

### 9.4. Expiration of a set-aside

A set-aside hold with `readyUntil` R is still valid on day R. If the book has not been borrowed by that member by the end of day R:

- the hold is removed at the start of day R + 1, and
- the book becomes free on day R + 1.

The next hold therefore gets `readyUntil` = R + 1 + 7. If the line is now empty, the book becomes available on day R + 1.

Expirations cascade. If several windows elapse before the next call, process them in order until the current set-aside window covers the call date, or the line is empty.

### 9.5. Other hold rules

- No penalty is charged for an expired hold.
- There is no method to cancel a hold.
- Holds are fulfilled only by the held member borrowing the set-aside book.

## 10. `renew({ memberId, bookId, date })` → `{ ok, dueDate }`

Apply the date checks, then check these rules in order. Reject at the first failure.

1. The IDs and the date must be valid.
2. The member must exist.
3. The book must exist.
4. The member must currently have this book on loan.
5. The loan must not be overdue: `date` must be on or before the current due date.
6. The loan must have fewer than 2 renewals used.
7. The book must have no active holds by any member.

On success:

- Set the new due date to `date` + 21 days.
  - Renewing on the due date gives a full new period.
  - Renewing on the day the current period started leaves the due date unchanged, but still counts as a renewal.
- Add 1 to renewals used.
- Keep the loan's original order position.
- Return `{ ok: true, dueDate }` with the new due date.

## 11. `returnBook({ memberId, bookId, date })` → `{ ok, fine }`

Apply the date checks, then check these rules in order. Reject at the first failure.

1. The IDs and the date must be valid.
2. The member must exist.
3. The book must exist.
4. The member must currently have this book on loan.

On success:

1. Compute the fine:
   - days late = days between the current due date and `date`, or 0 if not positive,
   - fine = min(25 × days late, 500).
   - Returning on the due date costs nothing.
2. Add the fine to the member's owed balance.
3. Remove the loan.
4. The book becomes free on `date` (apply 9.3). It is either set aside for the first hold, with `readyUntil` = `date` + 7, or it becomes available.
5. Return `{ ok: true, fine }`. `fine` is 0 if the book was not late.

Fines on books not yet returned are not charged and are not included in owed.

## 12. `payFine({ memberId, amount, date })` → `{ ok, owed }`

Apply the date checks, then check these rules in order. Reject at the first failure.

1. `memberId` and the date must be valid.
2. `amount` must be a safe integer of 1 or more. It must be of type number; numeric strings are rejected.
3. The member must exist.
4. `amount` must not exceed the member's current owed balance. Overpayment is rejected, so a member who owes 0 cannot pay anything.

On success:
- Subtract `amount` from owed.
- Return `{ ok: true, owed }` with the remaining balance.

## 13. `getMember({ memberId, date })`

Apply the date checks and catch-up (section 4).

**Rejection.** Return `{ ok: false }` if:
- the ID or date is invalid,
- the date is earlier than the clock, or
- the member does not exist.

**Success.** Return an object with exactly the properties `loans`, `owed` and `holds`, and no `ok` property:

- `loans`: an array of `{ bookId, dueDate }`, one per current loan, ordered by when the loan was created (oldest first). `dueDate` is the current due date after any renewals.
- `owed`: the member's current owed balance in cents.
- `holds`: an array of `{ bookId, position, readyUntil }`, one per active hold of the member, ordered by when the hold was placed (oldest first).
  - `position` is computed as in 9.2.
  - `readyUntil` is the date if the book is currently set aside for this member as of `date`, otherwise `null`.

Rules for the result:
- Expired or fulfilled holds do not appear.
- Arrays and objects in the result are fresh copies. Changing them must not affect library state.
- `getMember` changes no state except the clock and catch-up.

**Suggested rejection `reason` codes (optional, for all methods):**
- `INVALID_INPUT`
- `DATE_OUT_OF_ORDER`
- `DUPLICATE`
- `NO_MEMBER`
- `NO_BOOK`
- `NOT_AVAILABLE`
- `NOT_ON_LOAN`
- `OVERDUE`
- `RENEWAL_LIMIT`
- `HAS_HOLDS`
- `BOOK_AVAILABLE`
- `ALREADY_HOLDING`
- `ALREADY_BORROWED`
- `BAD_AMOUNT`

## 14. Worked example

| Call | Result |
|---|---|
| `addBook({bookId:'B1'})`, `addMember` for A and C | all `{ok:true}` |
| `borrow` A, B1, `2026-01-01` | `{ok:true, dueDate:'2026-01-22'}` |
| `renew` A, B1, `2026-01-20` | `{ok:true, dueDate:'2026-02-10'}` |
| `placeHold` C, B1, `2026-01-25` | `{ok:true, position:1}` |
| `renew` A, B1, `2026-01-26` | `{ok:false}` because the book has holds |
| `returnBook` A, B1, `2026-02-14` | `{ok:true, fine:100}` (4 days late) |
| `getMember` C, `2026-02-20` | `holds:[{bookId:'B1', position:1, readyUntil:'2026-02-21'}]` |
| `getMember` C, `2026-02-22` | `holds:[]`. The hold expired and B1 is available. |
| `payFine` A, 40, `2026-02-22` | `{ok:true, owed:60}` |
| `payFine` A, 100, `2026-02-22` | `{ok:false}` because this is an overpayment |
| A return 40 days late | `fine:500` (capped) |
