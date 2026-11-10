# Requirements: Community Library Loan System

## 1. Scope

This document specifies one JavaScript ES module for Node.js 26.

- It has no dependencies.
- It performs no file, network or console I/O.
- It exports exactly one function, `createLibrary()`.
- Each call to `createLibrary()` returns a new, independent, empty library object. Two library objects never share state.
- All methods are synchronous.

## 2. Domain Rules (Business Decisions)

| Rule | Value |
|---|---|
| Loan period | 21 days. Due date = borrow date + 21 days. |
| Maximum renewals per loan | 2 |
| Renewal extension | 21 days, added to the **current due date** |
| Late fee | 25 cents per chargeable late day |
| Grace period | The first 2 late days are free |
| Fine cap | At most 1000 cents for a single return |
| Maximum simultaneous loans per member | 5 |
| Debt that blocks borrowing | Owed ≥ 1000 cents |
| Maximum active holds per member | 5 |
| Pickup window for a set-aside book | 7 days. `readyUntil` = start day + 7, and that day is included. |

Each `bookId` is one physical copy. A book is in exactly one of these states:

- **On shelf**: available to anyone.
- **On loan**: held by exactly one member.
- **Set aside**: reserved for the first member in its hold queue.

## 3. General Conventions

### 3.1 Return values and errors

- Methods never throw, whatever the input. This includes `undefined`, `null`, non-object arguments, and missing or wrong-typed fields.
- On failure a method returns `{ ok: false }` and changes no state. It may add a `reason` string, which callers ignore.
- On success a method returns `ok: true` plus the documented fields.
- Fields not listed in the interface are ignored.

### 3.2 Input validation

**IDs**
- `bookId` and `memberId` must be non-empty strings.
- IDs are compared exactly: case-sensitive, with no trimming.

**Dates**
- A date must be a string matching `^\d{4}-\d{2}-\d{2}$`.
- It must be a real calendar date. For example, `2026-02-30` is rejected.
- Leap years follow Gregorian rules.

**Money**
- `amount` must be a safe integer ≥ 1. Numeric strings are rejected.

### 3.3 Date arithmetic

- Dates are treated as whole calendar days.
- Add days and compute differences in UTC so that daylight-saving time and time zones have no effect. For example, use `Date.UTC`.
- Output dates are always formatted `YYYY-MM-DD`, zero-padded.

### 3.4 Time ordering

- Calls arrive in non-decreasing date order. The implementation does not need to check this.
- If dates go backwards, the behavior is unspecified, but the methods must still not throw.

### 3.5 Hold expiration (time processing)

Hold expiration is processed lazily. At the start of every **dated** call, after input validation passes, process expirations for **all books** up to the call's date. This happens even if the call later fails for a business reason.

For each book that is set aside, repeat the following while `date > readyUntil`:

1. Remove the first hold from that book's queue. That member loses the hold, and the remaining positions shift up by 1.
2. If the queue is still non-empty, set the book aside for the new first member:
   - start day = previous `readyUntil` + 1
   - `readyUntil` = start day + 7
3. If the queue is now empty, the book returns to the shelf.

Expiration processing is the only time-driven state change. It is not a business change of the failing call, so its effects persist when the call fails.

Expiration is still processed when the call fails for any of these reasons:
- an unknown member
- an unknown book
- an invalid `amount`

It is not processed when the date itself is invalid or missing, or when the argument is not an object.

## 4. Methods

### 4.1 `addBook({ bookId })` → `{ ok }`

This call fails if:
- `bookId` is invalid, or
- a book with this `bookId` already exists.

On success, the book is created on the shelf with an empty hold queue.

### 4.2 `addMember({ memberId })` → `{ ok }`

This call fails if:
- `memberId` is invalid, or
- a member with this `memberId` already exists.

On success, the member is created with no loans, no holds, and owed = 0.

### 4.3 `borrow({ memberId, bookId, date })` → `{ ok, dueDate }`

First run the time processing in §3.5. The call fails if any of these is true:

1. The input is invalid, the member is unknown, or the book is unknown.
2. The book is on loan, including on loan to this same member.
3. The book is set aside for a different member.
4. The book is on the shelf but its hold queue is non-empty. This cannot happen given the other rules; reject it defensively.
5. The member already has 5 loans.
6. The member owes ≥ 1000 cents.
7. The member has any overdue loan, meaning a loan whose `dueDate < date`.

On success:

- A loan is created with `dueDate = date + 21`.
- The loan's renewal count is set to 0.
- If the book was set aside for this member, that hold is removed and the remaining queue positions shift up by 1.

The call returns `{ ok: true, dueDate }`.

A member who has a waiting hold that is not yet set aside cannot borrow the book until it is set aside for them. This follows from rule 2.

### 4.4 `returnBook({ memberId, bookId, date })` → `{ ok, fine }`

First run the time processing in §3.5. The call fails if:
- the input is invalid, the member is unknown, or the book is unknown, or
- this member does not currently have this book on loan.

On success, the fine is computed as follows:

- `daysLate = max(0, date − dueDate)`, counted in days.
- `chargeable = max(0, daysLate − 2)`.
- `fine = min(chargeable × 25, 1000)`.

The return then has these effects:

- The fine is added to the member's owed amount. The fine can be 0.
- The loan is removed.
- If the book's hold queue is non-empty, the book is set aside for the first member in the queue:
  - start day = return date
  - `readyUntil = date + 7`
- If the queue is empty, the book goes back on the shelf.

The call returns `{ ok: true, fine }`.

Fine examples:

| Days late | Fine (cents) |
|---|---|
| 0 | 0 |
| 1 | 0 |
| 2 | 0 |
| 3 | 25 |
| 10 | 200 |
| 42 | 1000 |
| 100 | 1000 |

Fines accrue only when the book is returned. A book that is overdue but not yet returned adds nothing to owed.

### 4.5 `renew({ memberId, bookId, date })` → `{ ok, dueDate }`

First run the time processing in §3.5. The call fails if any of these is true:

1. The input is invalid, the member is unknown, or the book is unknown.
2. This member does not currently have this book on loan.
3. The loan has already been renewed 2 times.
4. The loan is overdue (`date > dueDate`). Renewing on the due date itself is allowed.
5. The book's hold queue is non-empty, meaning someone else is waiting.

On success:

- New `dueDate` = current `dueDate` + 21.
- The loan's renewal count increases by 1.

The call returns `{ ok: true, dueDate }` with the new due date.

Owed money does not block renewal.

### 4.6 `placeHold({ memberId, bookId, date })` → `{ ok, position }`

First run the time processing in §3.5. The call fails if any of these is true:

1. The input is invalid, the member is unknown, or the book is unknown.
2. The book is on the shelf. The member should borrow it instead.
3. The member currently has this book on loan.
4. The member already has a hold on this book. This includes a hold that is set aside for them.
5. The member already has 5 active holds.

On success, the hold is appended to the end of the book's queue. The call returns `{ ok: true, position }`, where `position` is the hold's 1-based place in the queue.

- Holds are allowed even when the member owes money.
- There is no way to cancel a hold.

### 4.7 `payFine({ memberId, amount, date })` → `{ ok, owed }`

First run the time processing in §3.5. The call fails if any of these is true:
- the input is invalid or the member is unknown;
- `amount` is not a safe integer ≥ 1;
- `amount` is greater than the current owed amount. Overpayment is rejected, and so is any payment when owed = 0.

On success, `amount` is subtracted from owed. The call returns `{ ok: true, owed }` with the remaining amount, which is ≥ 0.

### 4.8 `getMember({ memberId, date })`

First run the time processing in §3.5.

If the input is invalid or the member is unknown, return `{ ok: false }`.

Otherwise return:

```
{ ok: true, loans, owed, holds }
```

**`loans`**
- Each entry is `[{ bookId, dueDate }]`.
- Sort ascending by `dueDate`, then by `bookId` using string comparison.

**`owed`**
- The total fines charged minus the total paid, in cents.

**`holds`**
- Each entry is `[{ bookId, position, readyUntil }]`, one per active hold.
- `position` is the member's current 1-based place in that book's queue.
- `readyUntil` is the date when the book is set aside for this member, which is always position 1. Otherwise it is `null`.
- List holds in the order the member placed them.

The returned arrays and objects must be fresh copies. If the caller mutates them, library state must not change.

## 5. Hold Queue Invariants

- A book's queue never contains the same member twice.
- If a book is set aside, it is always set aside for queue position 1.
- If a book is on the shelf, its queue is empty.
- A member never holds a book that they currently have on loan.

## 6. Example Scenario

1. `addBook({bookId:'B1'})` and `addMember` for `A`, `B`, `C`.
2. `borrow(A, B1, '2026-01-01')` returns due date `2026-01-22`.
3. `placeHold(B, B1, '2026-01-05')` returns position 1.
4. `placeHold(C, B1, '2026-01-06')` returns position 2.
5. `renew(A, B1, '2026-01-10')` fails, because the queue is non-empty.
6. `returnBook(A, B1, '2026-01-27')`: the book is 5 days late, so the fine is (5 − 2) × 25 = 75. A now owes 75. B1 is set aside for B with `readyUntil` `2026-02-03`.
7. `borrow(C, B1, '2026-01-28')` fails, because the book is set aside for B.
8. `getMember(C, '2026-02-04')`:
   - B's hold expires, because `2026-02-04` is after `2026-02-03`.
   - The book is set aside for C from `2026-02-04`, with `readyUntil` `2026-02-11`.
   - The result shows C's hold as position 1, `readyUntil` `2026-02-11`.
9. `payFine(A, 100, ...)` fails, because it is an overpayment. `payFine(A, 75, ...)` returns owed 0.
