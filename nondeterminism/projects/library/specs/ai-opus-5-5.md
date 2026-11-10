# Requirements: Community Library Loan System

## 1. Scope

This document specifies a single JavaScript ES module for Node.js 26. The module tracks books, members, loans, renewals, late fines, payments and holds for a small community library.

- The module has no dependencies.
- It performs no file, network or console I/O.
- It exports exactly one function: `export function createLibrary()`.
- Each call to `createLibrary()` returns a new, independent, empty library object. Separate library objects never share state.
- All methods are synchronous.

## 2. Fixed Business Parameters

| Parameter | Value |
|---|---|
| Loan period | 21 days |
| Maximum renewals per loan | 2 |
| Renewal length | 21 days, counted from the renewal date |
| Fine rate | 25 cents per chargeable late day |
| Grace period | 2 days (late days 1 and 2 are free) |
| Maximum fine per return | 500 cents |
| Maximum concurrent loans per member | 5 |
| Borrowing blocked when owed is at least | 1000 cents |
| Maximum active holds per member | 5 |
| Pickup window for a set-aside book | 7 days |

## 3. General Conventions

### 3.1 Identifiers

- `bookId` and `memberId` must be non-empty strings. Any other value is invalid.
- Identifiers are matched exactly. Matching is case-sensitive and nothing is trimmed.
- Book IDs and member IDs are separate namespaces. A book and a member may have the same ID.
- Each `bookId` identifies one physical copy.

### 3.2 Dates

- A valid date is a string matching `^\d{4}-\d{2}-\d{2}$`. It must also be a real calendar date in the Gregorian calendar, including leap years, with a year from 0001 to 9999.
  - Example: `2026-02-29` is invalid.
- Dates are whole days. All arithmetic is in whole days with no time zones. The implementation must compute dates in UTC (for example with `Date.UTC`) so local time zones and DST have no effect.
- "D + n" means the date n calendar days after D.
- There are no closed days. Due dates may fall on any day of the week.

### 3.3 Clock

- The library keeps a "current date". It starts unset.
- A dated call has a valid date. If that date is not earlier than the current date, the call sets the current date to its date. This happens whether the call then succeeds or fails for a business reason.
- A dated call whose date is earlier than the current date returns `{ ok: false }` and has no effect. The interface says this will not happen; the rule exists only as a safeguard.
- Before any dated method applies its rules, the library processes hold expiries up to and including the call's date (§7.4).

### 3.4 Money

- All amounts are integer cents.
- A payment `amount` must be a safe integer greater than 0.

### 3.5 Failure Handling

- Methods never throw because of business rules or invalid input. Invalid input includes:
  - a missing argument object;
  - missing fields;
  - wrong types;
  - malformed dates.
- On failure, a method returns `{ ok: false }` and changes nothing. It may add a `reason` string; callers ignore it.
- When several failure conditions apply, the result is the same `{ ok: false }`, so the order of checks does not matter.
- Extra unknown fields in arguments are ignored.

## 4. Book and Member Registration

### 4.1 `addBook({ bookId })` → `{ ok }`

- If `bookId` is invalid or already registered, the call fails.
- Otherwise it registers the book as available and returns `{ ok: true }`.

### 4.2 `addMember({ memberId })` → `{ ok }`

- If `memberId` is invalid or already registered, the call fails.
- Otherwise it registers the member with no loans, no holds and `owed = 0`, and returns `{ ok: true }`.

### 4.3 Removal

There is no way to remove books or members.

## 5. Book States

At any moment, every book is in exactly one of these states:

1. **Available**: not on loan and not set aside. Its hold queue is always empty.
2. **On loan**: lent to exactly one member. Its hold queue may contain waiting holds.
3. **Set aside**: not on loan, and reserved for the first hold in its queue. That hold is "ready". Other holds in the queue may wait behind it.

## 6. Loans

### 6.1 `borrow({ memberId, bookId, date })` → `{ ok, dueDate }`

The call fails if any of the following is true:

- an argument is invalid, or the date is earlier than the current date;
- the member or the book is not registered;
- the book is on loan, to anyone, including this member;
- the book is set aside for a different member;
- the member already has 5 loans;
- the member has an overdue loan, meaning a loan whose `dueDate` is earlier than `date`;
- the member owes 1000 cents or more.

On success:

- A loan is created with `dueDate = date + 21` and a renewal count of 0.
- If the book was set aside for this member, that hold is fulfilled and removed from the queue. The remaining holds move up one position and keep their order.
- The call returns `{ ok: true, dueDate }`.

If a member's set-aside book is blocked by one of the rules above, the hold stays in place until it is borrowed or it expires.

### 6.2 `returnBook({ memberId, bookId, date })` → `{ ok, fine }`

The call fails if any of the following is true:

- an argument is invalid, or the date is earlier than the current date;
- the member or the book is not registered;
- the book is not currently on loan to this member.

On success:

1. Compute the fine.
   - `daysLate = max(0, date − dueDate)`, in days.
   - `fine = min(500, 25 × max(0, daysLate − 2))`.
2. Add the fine to the member's `owed`.
3. Remove the loan.
4. Update the book's state.
   - If the hold queue is empty, the book becomes available.
   - Otherwise, the book is set aside for the first hold in the queue, with `readyUntil = date + 7`.
5. Return `{ ok: true, fine }`. The fine is 0 if nothing was charged.

Fine examples, with due date 2026-01-22:

| Return date | Days late | Fine |
|---|---|---|
| 2026-01-22 | 0 | 0 |
| 2026-01-24 | 2 | 0 |
| 2026-01-25 | 3 | 25 |
| 2026-02-11 | 20 | 450 |
| 2026-02-13 | 22 | 500 |
| 2026-03-30 | 67 | 500 (cap) |

### 6.3 `renew({ memberId, bookId, date })` → `{ ok, dueDate }`

The call fails if any of the following is true:

- an argument is invalid, or the date is earlier than the current date;
- the member or the book is not registered;
- the book is not currently on loan to this member;
- the loan has already been renewed 2 times;
- the loan is overdue (`date > dueDate`);
- the book's hold queue is not empty, meaning someone is waiting.

Money owed does **not** block renewal.

On success:

- The new due date is `dueDate = date + 21`.
  - This is never earlier than the old due date.
  - Renewing on the day of borrowing is allowed. It counts as a renewal even though the due date does not change.
- The renewal count increases by 1.
- The call returns `{ ok: true, dueDate }` with the new due date.

## 7. Holds

### 7.1 Hold Queue

- Each book has a FIFO queue of holds.
- A hold's position is its index in the queue plus 1.
- If the book is set aside, the ready hold is position 1.

### 7.2 Active Holds

A member's active holds are all of their holds that are waiting or ready.

### 7.3 `placeHold({ memberId, bookId, date })` → `{ ok, position }`

The call fails if any of the following is true:

- an argument is invalid, or the date is earlier than the current date;
- the member or the book is not registered;
- the book is available. Holds are only for books that are out: either on loan or set aside.
- the member currently has this book on loan;
- the member already has a hold on this book, whether waiting or ready;
- the member already has 5 active holds.

Money owed and overdue loans do **not** block holds.

On success:

- The hold is added to the end of the queue.
- The call returns `{ ok: true, position }`, where `position` is the new length of the queue.

Holds cannot be cancelled.

### 7.4 Pickup and Expiry

- A ready hold can be picked up, by borrowing, through its `readyUntil` date, inclusive.
- Expiry runs at the start of every dated call, for every book, as of the call's date. While a book is set aside and the call's date is later than its `readyUntil`:
  1. The ready hold is removed. No fine or penalty applies.
  2. If more holds remain, the next hold becomes ready with `readyUntil = (previous readyUntil + 1) + 7`.
     - The book counts as passed on the day after the previous window ended, even if no call happened that day.
  3. If no holds remain, the book becomes available.
- Repeat these steps until the condition no longer holds. One call may therefore expire several holds in a row.

## 8. Fines and Payments

### 8.1 `payFine({ memberId, amount, date })` → `{ ok, owed }`

The call fails if any of the following is true:

- an argument is invalid, or the date is earlier than the current date;
- the member is not registered;
- `amount > owed`. Overpayment is not allowed, and members cannot hold a credit. When `owed` is 0, every payment fails.

On success:

- `owed` decreases by `amount`.
- The call returns `{ ok: true, owed }` with the remaining balance.
- Partial payments are allowed.

### 8.2 Owed Balance

`owed` is never negative. It changes only through return fines, which increase it, and payments, which decrease it.

## 9. `getMember({ memberId, date })`

- If an argument is invalid, the date is earlier than the current date, or the member is not registered, the call returns `{ ok: false }`.
- The call first processes hold expiry (§7.4). Otherwise it changes no state.

On success it returns:

```
{ ok: true,
  loans: [{ bookId, dueDate }],
  owed,
  holds: [{ bookId, position, readyUntil }] }
```

- **`loans`** lists the member's current loans in the order they were borrowed, oldest first. Each `dueDate` reflects any renewals.
- **`owed`** is the current balance in cents.
- **`holds`** lists the member's active holds in the order they were placed, oldest first.
  - `position` is the hold's current position in its book's queue.
  - `readyUntil` is the last pickup day if the book is set aside for this member, and `null` otherwise.
- The returned arrays and objects are fresh copies. Changing them does not affect the library.

## 10. Worked Example

| Call | Result |
|---|---|
| `addBook({bookId:'B1'})`; `addMember` for `'A'`, `'C'`, `'D'` | `{ok:true}` each |
| `borrow A,B1,2026-01-01` | `{ok:true, dueDate:'2026-01-22'}` |
| `renew A,B1,2026-01-20` | `{ok:true, dueDate:'2026-02-10'}` |
| `placeHold C,B1,2026-01-21` | `{ok:true, position:1}` |
| `placeHold D,B1,2026-01-21` | `{ok:true, position:2}` |
| `renew A,B1,2026-02-01` | `{ok:false}` (holds exist) |
| `returnBook A,B1,2026-02-15` | `{ok:true, fine:75}` (5 days late, minus 2 grace days, = 3 × 25) |
| `getMember C,2026-02-15` | holds `[{bookId:'B1', position:1, readyUntil:'2026-02-22'}]` |
| `borrow D,B1,2026-02-16` | `{ok:false}` (set aside for C) |
| `getMember D,2026-02-23` | C's hold expired. D: `[{bookId:'B1', position:1, readyUntil:'2026-03-02'}]` |
| `borrow D,B1,2026-02-25` | `{ok:true, dueDate:'2026-03-18'}`. D's hold is removed. |
| `payFine A,100,2026-02-25` | `{ok:false}` (owed is only 75) |
| `payFine A,75,2026-02-25` | `{ok:true, owed:0}` |
