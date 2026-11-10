# Requirements: Community Library Loan System

## 1. Scope

This document specifies one JavaScript ES module for Node.js 26.

- It has no dependencies.
- It performs no file, network or console I/O.
- It exports exactly one function, `createLibrary()`.
- Each call to `createLibrary()` returns a new, independent, empty library object. Two libraries never share state.
- All methods are synchronous.

## 2. Fixed Business Parameters

| Parameter | Value |
|---|---|
| Copies per `bookId` | 1. Each `bookId` is one physical copy. |
| Loan period | 21 days |
| Maximum renewals per loan | 2 |
| Renewal extension | 21 days, added to the current due date |
| Maximum simultaneous loans per member | 5 |
| Fine rate | 25 cents per charged day |
| Grace period | 3 days. The first 3 late days are never charged. |
| Maximum fine per loan | 1000 cents |
| Debt limit | A member who owes 1000 cents or more cannot borrow or renew. |
| Pickup window | A book set aside on day S can be collected up to and including S + 7. |

## 3. General Conventions

### 3.1 Dates

- A valid date is a string exactly matching `YYYY-MM-DD`: four digits, a hyphen, two digits, a hyphen, two digits.
- It must also be a real Gregorian calendar date:
  - The month is 01–12.
  - The day is valid for that month.
  - February 29 is valid only in leap years. A leap year is divisible by 4, except century years, which must be divisible by 400.
- Date arithmetic uses whole calendar days, with no time zones and no daylight-saving effects. Implementing it with UTC is recommended.
- "D + n" means the date n days after D.
- "B − A" means the number of days from A to B.
- Every date the module outputs uses `YYYY-MM-DD` format with zero padding.

### 3.2 IDs

- `bookId` and `memberId` must be non-empty strings.
- IDs are compared exactly: case-sensitive, with no trimming.
- Books and members are separate namespaces. The same string may be both a `bookId` and a `memberId`.

### 3.3 Money

- All money values are integer numbers of cents.

### 3.4 Failure results

- No method ever throws for any input. This includes:
  - missing arguments;
  - wrong types;
  - `null` or `undefined` arguments.
- When an action is invalid or not allowed, the method returns `{ ok: false, reason: <string> }`.
  - The `reason` text is free-form.
  - A failed call changes no state, except for the time processing described in §4.
- Unless stated otherwise, a failed result contains only `ok` and `reason`.

### 3.5 Clock

- The library keeps `lastDate`, which is the latest date of any accepted date-bearing call. It starts empty.
- A call is "accepted" if its date is valid and not earlier than `lastDate`. Accepted calls include ones that later fail a business rule.
- If a call has a valid date earlier than `lastDate`, it returns `{ ok: false }` and changes nothing. The interface promises this never happens; this rule makes the behaviour deterministic anyway.
- If a call has an invalid or missing date, it returns `{ ok: false }` and does not change `lastDate`.
- `addBook` and `addMember` carry no date. They do not touch the clock and do not trigger time processing.

### 3.6 Validation order

Every date-bearing method checks its input in this order:

1. Check that the arguments object and all fields are present and valid in type and format. If not, fail.
2. Check the date against the clock. If it is earlier than `lastDate`, fail.
3. Set `lastDate` to the date and run time processing (§4).
4. Apply the method's business rules.

## 4. Time Processing: Pickup Expiry

### 4.1 Books and holds

A book is in exactly one of three states:

- **available**: on the shelf, with no one waiting.
- **on loan**: borrowed by one member.
- **set aside**: reserved on the shelf for the first member in its hold queue. This state has a `readyUntil` date.

Each book has a FIFO hold queue of member IDs. The queue is ordered by the time each hold was placed.

- A hold's position is its 1-based index in its book's queue.
- When the book is set aside, it is always set aside for the member at position 1.

### 4.2 Expiry processing

This runs at step 3 of every accepted date-bearing call, with date D. While a book is set aside and D > `readyUntil`, the module does the following:

1. Remove the first member's hold from the queue. That hold has expired, and the member is not charged.
2. Find the next set-aside day: S = old `readyUntil` + 1.
3. If the queue still has members, set the book aside for the new first member, with `readyUntil` = S + 7.
4. If the queue is now empty, the book becomes available.

The loop repeats until the book is no longer set aside or `readyUntil` ≥ D. It is run for every book.

This processing depends only on time. It applies even if the call that triggered it then fails.

## 5. Methods

### 5.1 `addBook({ bookId })` → `{ ok }`

- The call fails if `bookId` is invalid or already exists.
- Otherwise, the book is added as available with an empty queue, and the method returns `{ ok: true }`.

### 5.2 `addMember({ memberId })` → `{ ok }`

- The call fails if `memberId` is invalid or already exists.
- Otherwise, the member is added with no loans, no holds and `owed` = 0, and the method returns `{ ok: true }`.

### 5.3 `borrow({ memberId, bookId, date })` → `{ ok, dueDate }`

The call fails if any of these is true:

- The member or the book does not exist.
- The book is on loan, including when it is on loan to this member.
- The book is set aside for a different member.
- The book is available but its hold queue is not empty. By §4 this cannot happen; the check is a safeguard.
- The member owes 1000 cents or more.
- The member has any loan with `date` > `dueDate` (an overdue loan).
- The member already has 5 loans.

On success:

- The member gets a loan with `dueDate` = `date` + 21 and a renewal count of 0.
- The book becomes on loan.
- If the book was set aside for this member, their hold is removed from the queue. The remaining holds move up one position. The queue stays attached to the book, which is now on loan.
- The method returns `{ ok: true, dueDate }`.

If borrowing fails for a member whose book is set aside, the set-aside and the hold are unchanged.

### 5.4 `returnBook({ memberId, bookId, date })` → `{ ok, fine }`

The call fails if:

- the member or the book does not exist; or
- this member does not currently have this book on loan.

On success:

- The number of late days is `late` = max(0, `date` − `dueDate`).
- The fine is `fine` = min(1000, 25 × max(0, `late` − 3)).
- The fine is added to the member's `owed`.
- The loan is removed.
- If the book's queue is not empty, the book is set aside for position 1 with `readyUntil` = `date` + 7.
- If the queue is empty, the book becomes available.
- The method returns `{ ok: true, fine }`. The fine is 0 when nothing is charged.

Examples of fines:

| Days late | Fine (cents) |
|---|---|
| 0 | 0 |
| 3 | 0 |
| 4 | 25 |
| 10 | 175 |
| 43 | 1000 |
| 100 | 1000 |

### 5.5 `renew({ memberId, bookId, date })` → `{ ok, dueDate }`

The call fails if any of these is true:

- The member or the book does not exist.
- The member does not have this book on loan.
- The loan is overdue: `date` > `dueDate`. Renewing on the due date itself is allowed.
- The loan has already been renewed 2 times.
- The book's hold queue is not empty, meaning someone is waiting for it.
- The member owes 1000 cents or more.

On success:

- The new due date is `dueDate` = old `dueDate` + 21.
- The renewal count increases by 1.
- The method returns `{ ok: true, dueDate }` with the new date.

### 5.6 `placeHold({ memberId, bookId, date })` → `{ ok, position }`

The call fails if any of these is true:

- The member or the book does not exist.
- The book is available. The member should borrow it instead.
- This member currently has the book on loan.
- This member already has a hold on this book. This includes the case where the book is set aside for them.

Holds are allowed regardless of how much the member owes. There is no limit on the number of holds a member may have.

On success:

- The member is appended to the end of the book's queue.
- The method returns `{ ok: true, position }`, where `position` is the new length of the queue.

Placing a hold never changes the book's state or its `readyUntil`.

### 5.7 `payFine({ memberId, amount, date })` → `{ ok, owed }`

The call fails if any of these is true:

- The member does not exist.
- `amount` is not an integer number.
- `amount` < 1.
- `amount` > the member's current `owed`. Overpayment is rejected, which means any payment fails when `owed` is 0.

On success:

- The amount is subtracted from `owed`.
- The method returns `{ ok: true, owed }` with the amount still owed.

### 5.8 `getMember({ memberId, date })` → `{ loans, owed, holds }`

- The call fails with `{ ok: false, reason }` if the date is invalid or earlier than `lastDate`, or if the member does not exist.
- The call applies clock and time processing like any other date-bearing method. It does not otherwise change state.

On success, it returns exactly `{ loans, owed, holds }`, with no `ok` field:

- `loans` is an array of `{ bookId, dueDate }`.
  - It is ordered by when each loan was created, oldest first.
  - Renewing a loan does not change its order.
  - Overdue loans are included.
- `owed` is the integer number of cents the member currently owes.
- `holds` is an array of `{ bookId, position, readyUntil }`.
  - It is ordered by when each hold was placed, oldest first.
  - `position` is the hold's current place in that book's queue.
  - `readyUntil` is the book's `readyUntil` date if the book is set aside for this member (which means `position` is 1). Otherwise it is `null`.
  - A member at position 1 whose book is still on loan has `readyUntil` set to `null`.

Expired holds have already been removed by §4, so they never appear.

Returned arrays and objects must be fresh copies. Changing them must not affect the library's state.

## 6. Additional Rules and Clarifications

- **Same-day actions.** Borrowing and returning on the same day is allowed, and so is renewing on the day of borrowing.
- **Repeat borrowing.** After returning a book with an empty queue, the same member may borrow it again immediately.
- **State changes on failure.** No method changes any state on failure, apart from `lastDate` and the time processing in §4.
- **Members are never removed, and neither are books.** There is no method to cancel a hold.
- **Anti-cheating.** A hold can only be placed on a book that is on loan or set aside. A member therefore cannot reserve a book that is sitting on the shelf.

## 7. Worked Example

| Call | Result |
|---|---|
| `addBook b1`; `addMember A`; `addMember B` | Each returns `ok: true`. |
| `borrow A b1 2026-01-01` | `ok: true`, `dueDate` 2026-01-22 |
| `placeHold B b1 2026-01-05` | `ok: true`, `position` 1 |
| `renew A b1 2026-01-10` | `ok: false`, because someone is waiting for the book. |
| `returnBook A b1 2026-01-27` | 5 days late, so `fine` = 25 × (5 − 3) = 50. |
| `getMember B 2026-01-27` | `holds` = `[{ bookId: 'b1', position: 1, readyUntil: '2026-02-03' }]` |
| `getMember B 2026-02-04` | `holds` = `[]`, and b1 is available. |
| `payFine A 50 2026-02-04` | `ok: true`, `owed` 0 |
