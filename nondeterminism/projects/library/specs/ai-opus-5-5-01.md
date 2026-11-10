# Requirements: Community Library Loan System

## 1. Scope

Deliver one JavaScript ES module for Node.js 26.

- It has no dependencies.
- It performs no file, network or console I/O.
- It exports exactly one function, `createLibrary()`.
- Each call to `createLibrary()` returns a new, independent, empty library object. Library objects share no state.
- All methods are synchronous.
- No method ever throws, whatever input it receives.

## 2. Fixed Policy Values

| Name | Value |
|---|---|
| Loan period | 21 days |
| Maximum renewals per loan | 2 |
| Renewal extension | 21 days, added to the current due date |
| Fine rate | 25 cents per day late |
| Maximum fine per loan | 500 cents |
| Fine threshold that blocks borrowing | owed ≥ 500 cents |
| Maximum simultaneous loans per member | 5 |
| Pickup window for a set-aside book | 7 days (see §7) |
| Copies per book | Exactly 1. Each `bookId` is one physical item. |

## 3. Conventions

### 3.1 Dates
- A valid date is a string in the exact form `YYYY-MM-DD` that names a real date in the proleptic Gregorian calendar. For example, `2024-02-29` is valid and `2023-02-29` is not.
- Date arithmetic counts whole calendar days, with no time zones. Implementing it with UTC is acceptable.
- "D + n" means the date n days after D.
- "days between A and B" means B − A in whole days.

### 3.2 Money
- All amounts are integer numbers of cents.

### 3.3 Identifiers
- `memberId` and `bookId` must each be a non-empty string.
- Comparison is exact and case-sensitive.
- Books and members are separate namespaces. A book and a member may share the same id string.

### 3.4 Results
- Every successful mutating call returns `ok: true` plus the documented fields.
- Every failed call returns `{ ok: false, reason: <string> }` and changes nothing.
- The `reason` codes are listed in §10. They are informational only.

### 3.5 Time order
- The library remembers the latest date seen in any call that had a valid date, including calls that failed.
- A call whose date is earlier than that latest date fails with `reason: 'date_out_of_order'`.
- A call may use the same date as the previous call.
- `addBook` and `addMember` take no date. They do not affect the latest date.

### 3.6 Validation order
Each dated method checks its input in this order and stops at the first failure:

1. The argument is an object.
2. All fields have the required types and formats.
3. The date is in order.
4. The member exists, then the book exists, where the method needs them.
5. The method's business rules, checked in the order listed for that method.

## 4. Data Model

**Book**
- `bookId`
- Status: one of the following.
  - **available**: on the shelf, not set aside.
  - **on loan**: borrowed by a member.
  - **set aside**: returned and reserved for the first member in its hold queue.
- Hold queue: an ordered list of member ids.
  - Order is the order in which holds were placed.
  - Position 1 is the front of the queue.

**Loan**
- `memberId`
- `bookId`
- `borrowDate`
- `dueDate`
- `renewCount`, which starts at 0.
- A loan exists from its borrow until its return.

**Member**
- `memberId`
- `owed`: total charged fines minus payments. It is an integer of 0 or more.
- Active loans, kept in the order they were created.
- Active holds. These are derived from the book queues.

## 5. Methods

### 5.1 `addBook({ bookId })` → `{ ok }`
- **Succeeds when:** `bookId` is valid and not already registered. The book is created as available, with an empty queue.
- **Fails when:**
  - `bookId` is invalid: `invalid_input`.
  - `bookId` is already registered: `book_exists`.
- Books are never removed.

### 5.2 `addMember({ memberId })` → `{ ok }`
- **Succeeds when:** `memberId` is valid and not already registered. The member is created with `owed = 0`, no loans and no holds.
- **Fails when:**
  - `memberId` is invalid: `invalid_input`.
  - `memberId` is already registered: `member_exists`.
- Members are never removed.

### 5.3 `borrow({ memberId, bookId, date })` → `{ ok, dueDate }`

**Checks, in this order:**
1. The member exists, otherwise `unknown_member`.
2. The book exists, otherwise `unknown_book`.
3. The book is not on loan, otherwise:
   - `already_borrowed` if this member is the borrower;
   - `not_available` if another member is the borrower.
4. If the book is set aside, it must be set aside for this member. Otherwise the call fails with `reserved_for_other`.
5. No loan of this member is overdue. A loan is overdue when `date > dueDate`. Otherwise the call fails with `overdue_loans`.
6. The member's `owed` is less than 500, otherwise `fines_owed`.
7. The member has fewer than 5 active loans, otherwise `loan_limit`.

**On success:**
- A loan is created with `dueDate = date + 21` and `renewCount = 0`.
- The book becomes on loan.
- If the book was set aside for this member:
  - the member's hold is removed from the front of the queue;
  - every remaining member moves up one position.
- If the book was available, its queue is empty by definition (see §7).
- The result is `{ ok: true, dueDate }`.

**On failure:** a set-aside hold stays unchanged.

### 5.4 `returnBook({ memberId, bookId, date })` → `{ ok, fine }`

**Checks, in this order:**
1. The member exists, otherwise `unknown_member`.
2. The book exists, otherwise `unknown_book`.
3. This member has an active loan of this book, otherwise `not_borrowed`.

**On success:**
- `daysLate = max(0, days between dueDate and date)`.
- `fine = min(25 × daysLate, 500)`.
  - Returning on the due date is not late.
  - The cap of 500 cents is the "not harsh" measure.
- The fine is added to the member's `owed`.
- The loan ends.
- If the book's queue is empty, the book becomes available.
- Otherwise, the book becomes set aside for queue position 1, with `readyUntil = date + 7`.
- The result is `{ ok: true, fine }`. `fine` is 0 when the book is not late.

### 5.5 `renew({ memberId, bookId, date })` → `{ ok, dueDate }`

**Checks, in this order:**
1. The member exists, otherwise `unknown_member`.
2. The book exists, otherwise `unknown_book`.
3. This member has an active loan of this book, otherwise `not_borrowed`.
4. The loan is not overdue. Renewing on the due date itself is allowed. Otherwise the call fails with `overdue`.
5. `renewCount < 2`, otherwise `renewal_limit`.
6. The book's hold queue is empty, otherwise `has_holds`.

**On success:**
- `dueDate = old dueDate + 21`.
- `renewCount` increases by 1.
- The result is `{ ok: true, dueDate }`.

Fines owed do not block renewal.

### 5.6 `placeHold({ memberId, bookId, date })` → `{ ok, position }`

**Checks, in this order:**
1. The member exists, otherwise `unknown_member`.
2. The book exists, otherwise `unknown_book`.
3. The member does not currently have the book on loan, otherwise `already_borrowed`.
4. The member has no hold on this book. This includes the case where the book is set aside for them. Otherwise the call fails with `already_held`.
5. The book is not available. Holds are only for books that are on loan or set aside. Otherwise the call fails with `book_available`.

**On success:**
- The member is appended to the end of the queue.
- `position` is the new length of the queue.
- The result is `{ ok: true, position }`.

There is no limit on holds. Fines and overdue loans do not block holds.

### 5.7 `payFine({ memberId, amount, date })` → `{ ok, owed }`

**Checks, in this order:**
1. `amount` is an integer greater than 0, otherwise `invalid_input`. This check is part of input validation.
2. The member exists, otherwise `unknown_member`.
3. `amount ≤ owed`, otherwise `overpayment`. Overpayment and credit are not allowed.

**On success:**
- `owed` decreases by `amount`.
- The result is `{ ok: true, owed }`, where `owed` is the new balance.

### 5.8 `getMember({ memberId, date })`

**Fails when:**
- the input is invalid: `invalid_input`;
- the date is out of order: `date_out_of_order`;
- the member is unknown: `unknown_member`.

A failure returns `{ ok: false, reason }`.

**On success, returns:**
```
{ ok: true,
  loans: [{ bookId, dueDate }],
  owed,
  holds: [{ bookId, position, readyUntil }] }
```

- **`loans`**: the active loans, in the order they were created.
- **`owed`**: charged fines minus payments. It does not include accruing fines on loans that are overdue but not yet returned.
- **`holds`**: one entry per book whose queue contains the member, in the order the holds were placed.
  - `position` is the member's current place in that queue, where 1 is next.
  - `readyUntil` is the last pickup day if the book is set aside for this member. Otherwise it is `null`.
- Results reflect the state as of `date`, after the expiry rules in §7 have been applied.
- The returned arrays and objects are fresh copies. Mutating them does not affect the library.

## 6. Set-Aside Books and Holds: Invariants

- A book is set aside only while its queue is non-empty. It is set aside for the member at position 1.
- An available book always has an empty queue.
- A member appears at most once in a given book's queue.
- A member never holds a book they currently have on loan.

## 7. Pickup Expiry

A set-aside book with `readyUntil = R` stays reserved through day R inclusive.

**When the library processes a call with date D**, it first resolves every set-aside book whose `R < D`:

1. Remove the position 1 hold from the queue.
2. If the queue is now empty, the book becomes available.
3. Otherwise, the book is set aside for the new position 1, with `readyUntil = R + 7`.
4. Repeat until either the book's `readyUntil ≥ D` or the book is available.

**Effect on all calls:**
- The rule depends only on dates, so its outcome is the same whether it is applied eagerly or lazily.
- It is applied for every dated call, even calls that fail.
- Because of this, applying it is not a "change" by the failed call.
- A member whose hold expired loses the hold entirely. Their fines are not affected.

## 8. Loan Status

- **Overdue:** a loan is overdue on date D when `D > dueDate`.
- **Accruing fines:** overdue loans never charge fines until the book is returned.
- **Fine cap:** each loan's fine is capped at 500 cents, independently of other loans.

## 9. Input Validation Failures

Each of the following returns `{ ok: false, reason: 'invalid_input' }` and changes nothing:

- the argument is not an object;
- a field is missing or has the wrong type;
- an id is an empty string;
- a date is malformed or not a real date;
- `amount` is not a positive integer.

Extra fields in the argument are ignored.

## 10. Reason Codes

`invalid_input`, `date_out_of_order`, `book_exists`, `member_exists`, `unknown_member`, `unknown_book`, `already_borrowed`, `not_available`, `reserved_for_other`, `overdue_loans`, `fines_owed`, `loan_limit`, `not_borrowed`, `overdue`, `renewal_limit`, `has_holds`, `already_held`, `book_available`, `overpayment`.

## 11. Worked Example

| Step | Call | Result |
|---|---|---|
| 1 | Add book B and members A and C. | |
| 2 | `borrow(A, B, 2025-01-01)` | `dueDate 2025-01-22` |
| 3 | `renew(A, B, 2025-01-10)` | `dueDate 2025-02-12` |
| 4 | `placeHold(C, B, 2025-01-11)` | `position 1` |
| 5 | `renew(A, B, 2025-01-12)` | fails with `has_holds` |
| 6 | `returnBook(A, B, 2025-02-15)` | `fine 75` (3 days late); A now owes 75 |
| 7 | B is set aside for C. | |
| 8 | `getMember(C, 2025-02-15)` | `holds [{ bookId: B, position: 1, readyUntil: '2025-02-22' }]` |
| 9 | `borrow(A, B, 2025-02-16)` | fails with `reserved_for_other` |
| 10 | `getMember(C, 2025-02-23)` | C did not pick up B, so the hold has expired. `holds` is `[]` and B is available. |
