# Requirements: Community Library Loan System

## 1. Scope

This document specifies one JavaScript ES module for Node.js 26.

- It has no dependencies.
- It performs no file, network or console I/O.
- It exports exactly one function, `createLibrary()`.

Each call to `createLibrary()` returns a new, independent, empty library object. Library objects never share state with each other.

All methods are synchronous. No method may throw for any input, including missing or malformed arguments. Every rule violation and every invalid input produces a failure result and leaves the state unchanged.

## 2. Constants

| Name | Value | Meaning |
|---|---|---|
| `LOAN_DAYS` | 21 | Length of a loan and of each renewal extension |
| `MAX_RENEWALS` | 2 | Maximum successful renewals per loan |
| `FINE_PER_DAY` | 25 | Cents charged per day late |
| `FINE_CAP` | 500 | Maximum fine in cents for a single loan |
| `BLOCK_THRESHOLD` | 1000 | A member owing this many cents or more cannot borrow or renew |
| `PICKUP_DAYS` | 7 | Days added to the set-aside start date to get `readyUntil` |

There is no limit on the number of loans or holds per member.

## 3. Conventions

### 3.1 Dates

A date is a string in the exact form `YYYY-MM-DD`.

- It must match `/^\d{4}-\d{2}-\d{2}$/`.
- It must be a real date in the proleptic Gregorian calendar. For example, `2026-02-29` is invalid and `2028-02-29` is valid.

Day arithmetic works on whole calendar days with no time zones. One approach is to convert to a UTC day count, add the days, and convert back. "D + n" means the date n days after D.

The difference "A − B" is the number of days from B to A.

### 3.2 Money

Money is an integer number of cents.

### 3.3 Identifiers

`bookId` and `memberId` must be non-empty strings. Comparison is exact and case-sensitive.

Books and members are separate namespaces. A book and a member may have the same id.

### 3.4 Results

Successful results have exactly the fields listed for each method. For methods that have an `ok` field, `ok` is `true`.

A failure result is `{ ok: false, reason: <string> }`. The reason text is free-form and is not part of the contract.

### 3.5 Time order and the library clock

The library keeps a **clock**, which is the date of the most recent accepted dated call. It starts unset.

The following calls are dated calls:
- `borrow`
- `returnBook`
- `renew`
- `placeHold`
- `payFine`
- `getMember`

Every dated call is processed in this order:

1. **Validate arguments.**
   - Arguments must be an object.
   - The ids must be valid.
   - The date must be valid.
   - `amount` is checked as described in §6.6.

   If any check fails, return a failure. The clock and the state do not change.

2. **Check time order.**
   - If the date is earlier than the clock, return a failure and change nothing.
   - Otherwise, set the clock to the date.

   The interface promises this check never fails. It exists only for robustness.

3. **Process hold expirations** up to this date (§5.3).

   This step and the clock update from step 2 still count as having happened, even if the business action in step 4 fails. They are not "changes" made by the failed action. They are the passage of time, and they are deterministic.

4. **Perform the business checks and the action.** If any check fails, return a failure. The action makes no changes.

`addBook` and `addMember` are undated. They do not read or move the clock, and they do not process expirations.

## 4. State

### 4.1 Books

Each book has an id and exactly one status:

| Status | Meaning |
|---|---|
| `available` | On the shelf. Anyone can borrow it. |
| `onLoan` | Lent to one member. Also stores the loan record (§4.3). |
| `readyForPickup` | Set aside for the first member in the book's hold queue, through that hold's `readyUntil` date. |

### 4.2 Members

Each member has:
- an id;
- `owed`, an integer in cents that starts at 0 and is never negative;
- a list of loans;
- a list of holds.

### 4.3 Loans

Each loan stores:
- `bookId`;
- `memberId`;
- the borrow date;
- `dueDate`;
- `renewals`, which starts at 0.

### 4.4 Hold queues

Each book has a FIFO hold queue of holds. Each hold stores:
- `memberId`;
- `placedOrder`, a global counter used for ordering;
- `readyUntil`, which is either `null` or a date.

Only the first hold in a queue can have a non-null `readyUntil`. It is non-null exactly when the book's status is `readyForPickup`.

## 5. Core Rules

### 5.1 Fine calculation

When a book is returned on date R for a loan with due date D:

```
daysLate = R − D
fine = daysLate > 0 ? min(daysLate × 25, 500) : 0
```

- Returning on the due date or earlier costs nothing.
- One day late costs 25 cents.
- The fine for one loan never exceeds 500 cents. This cap is how the system meets the client's wish not to be harsh.

Fines exist only at return time. A book that is overdue but not yet returned adds nothing to `owed`.

### 5.2 Passing a returned book to the hold queue

When a book stops being held by someone, it goes to the hold queue or back to the shelf. This happens when it is returned on date S, or when a ready hold expires and the next hold starts on date S.

- **The queue is empty:** the status becomes `available`.
- **The queue is not empty:**
  - The status becomes `readyForPickup`.
  - The first hold's `readyUntil` becomes S + 7.
  - Only that member may borrow the book from S through `readyUntil`, both days included.

### 5.3 Hold expiration

Processing expirations up to date T means repeating the following until nothing changes:

- If a book is `readyForPickup` and its first hold's `readyUntil` is earlier than T:
  - Remove that hold.
  - Apply §5.2 with S = `readyUntil` + 1.

This chains. Several holds can expire one after another inside a single gap between calls, and each successor's window starts the day after its predecessor's window ended.

**Example.** A book is returned on 2026-01-01 with holds by A, then B, then C.

1. A is ready until 2026-01-08.
2. If A never picks the book up, then on 2026-01-09 B becomes ready until 2026-01-16.
3. If B never picks it up, then on 2026-01-17 C becomes ready until 2026-01-24.
4. If C never picks it up, then from 2026-01-25 the book is `available`.

## 6. Methods

### 6.1 `addBook({ bookId })` → `{ ok }`

This call fails in these cases:
- `bookId` is invalid.
- A book with this id already exists.

On success, the book is created with status `available` and an empty queue. The result is `{ ok: true }`.

### 6.2 `addMember({ memberId })` → `{ ok }`

This call fails in these cases:
- `memberId` is invalid.
- A member with this id already exists.

On success, the member is created with `owed` 0, no loans and no holds. The result is `{ ok: true }`.

### 6.3 `borrow({ memberId, bookId, date })` → `{ ok, dueDate }`

This call fails in these cases:
- The member does not exist.
- The book does not exist.
- The member's `owed` is 1000 or more.
- The book is `onLoan`. This includes a book on loan to the same member.
- The book is `readyForPickup` for a different member.
- The book is `available` and its queue is not empty. This cannot happen given §5.2, but implementations should treat it as a failure.

On success:
- If the book was `readyForPickup` for this member, remove that hold from the queue and from the member's holds. The positions of the remaining holds shift up by one.
- Create a loan with `dueDate = date + 21` and `renewals = 0`.
- Set the book's status to `onLoan`.
- Return `{ ok: true, dueDate }`.

### 6.4 `returnBook({ memberId, bookId, date })` → `{ ok, fine }`

This call fails in these cases:
- The member does not exist.
- The book does not exist.
- The book is not on loan to this member.

A member who owes money may always return books.

On success:
1. Compute the fine (§5.1) and add it to the member's `owed`.
2. Remove the loan.
3. Apply §5.2 with S = `date`.
4. Return `{ ok: true, fine }`.

### 6.5 `renew({ memberId, bookId, date })` → `{ ok, dueDate }`

This call fails in these cases:
- The member does not exist.
- The book does not exist.
- The book is not on loan to this member.
- The book's hold queue is not empty, meaning someone is waiting.
- The loan has already been renewed 2 times.
- `date` is later than the current `dueDate`. An overdue loan cannot be renewed. This prevents fines from being erased.
- The member's `owed` is 1000 or more.

On success:
- Set `dueDate = old dueDate + 21`. The new due date is based on the old due date, not the renewal date, so renewing early never loses days.
- Increase `renewals` by 1.
- Return `{ ok: true, dueDate }`.

### 6.6 `placeHold({ memberId, bookId, date })` → `{ ok, position }`

This call fails in these cases:
- The member does not exist.
- The book does not exist.
- The book is `available`. The member should borrow it instead.
- The book is on loan to this same member.
- The member already has a hold on this book, whether waiting or ready.

Holds are allowed whatever the member owes.

On success:
- Append a hold with `readyUntil: null` to the end of the queue.
- Return `{ ok: true, position }`, where `position` is the new length of the queue.

A book that is `readyForPickup` for someone else is not available to this member, so placing a hold on it is allowed.

### 6.7 `payFine({ memberId, amount, date })` → `{ ok, owed }`

Argument validation, which is step 1 of §3.5: `amount` must be an integer and greater than 0. Use `Number.isInteger`.

This call fails in these cases:
- The member does not exist.
- `amount` is greater than the member's current `owed`. Overpayment is rejected rather than turned into credit.
- The member owes 0, which follows from the previous two rules.

On success:
- Reduce `owed` by `amount`.
- Return `{ ok: true, owed }` with the remaining amount.

### 6.8 `getMember({ memberId, date })` → `{ loans, owed, holds }`

This is a dated call. It follows §3.5, so it advances the clock and processes expirations.

If the member does not exist or the arguments are invalid, it returns the failure `{ ok: false, reason }`.

On success, it returns exactly:

```
{
  loans: [{ bookId, dueDate }],
  owed,
  holds: [{ bookId, position, readyUntil }]
}
```

There is no `ok` field. The parts are defined as follows:

- **`loans`:** the member's current loans, ordered by borrow date and then by call order. Renewals do not change the order.
- **`owed`:** the cents currently owed.
- **`holds`:** the member's current holds, ordered by when they were placed, oldest first.
  - `position` is the 1-based index of the hold in its book's queue.
  - `readyUntil` is the pickup deadline if the book is set aside for this member. Otherwise it is `null`.

The result must be a fresh object. Changing it must not affect the library.

## 7. Worked Example

| # | Call | Result |
|---|---|---|
| 1 | `addBook b1`; `addMember m1`, `m2`, `m3` | all `{ ok: true }` |
| 2 | `borrow m1 b1 2026-03-01` | `{ ok: true, dueDate: '2026-03-22' }` |
| 3 | `renew m1 b1 2026-03-10` | `{ ok: true, dueDate: '2026-04-12' }` |
| 4 | `placeHold m2 b1 2026-03-11` | `{ ok: true, position: 1 }` |
| 5 | `renew m1 b1 2026-03-12` | `{ ok: false }` because someone is waiting |
| 6 | `placeHold m3 b1 2026-03-12` | `{ ok: true, position: 2 }` |
| 7 | `returnBook m1 b1 2026-04-15` | `{ ok: true, fine: 75 }`; m2 is ready until `2026-04-22` |
| 8 | `borrow m3 b1 2026-04-16` | `{ ok: false }` because the book is set aside for m2 |
| 9 | `getMember m3 2026-04-23` | m2's hold has expired; m3's hold is `{ bookId: 'b1', position: 1, readyUntil: '2026-04-30' }` |
| 10 | `payFine m1 100 2026-04-23` | `{ ok: false }` because the amount is more than the 75 owed |
| 11 | `payFine m1 75 2026-04-23` | `{ ok: true, owed: 0 }` |
