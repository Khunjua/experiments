Write one JavaScript ES module for Node.js 26. No dependencies. No file, network or console I/O.

The module must export exactly one function:

    export function createLibrary()

It returns a new, empty library object with the methods below. All methods are synchronous.

Conventions
- Dates are strings 'YYYY-MM-DD' (whole calendar days, no time zones).
- Money is an integer number of cents.
- Calls arrive in time order: a call's date is never earlier than the date of the previous call.
- Methods never throw because of a business rule. When an action is not allowed, return { ok: false } (you may add a reason field; it is ignored) and change nothing.

Methods
- addBook({ bookId }) -> { ok }
- addMember({ memberId }) -> { ok }
- borrow({ memberId, bookId, date }) -> { ok, dueDate }
- returnBook({ memberId, bookId, date }) -> { ok, fine }
    fine: cents charged for this return, 0 if none
- renew({ memberId, bookId, date }) -> { ok, dueDate }
    dueDate: the new due date
- placeHold({ memberId, bookId, date }) -> { ok, position }
    position: place in the waiting line, 1 = next
- payFine({ memberId, amount, date }) -> { ok, owed }
    owed: cents still owed after the payment
- getMember({ memberId, date }) -> { loans: [{ bookId, dueDate }], owed, holds: [{ bookId, position, readyUntil }] }
    readyUntil: the last day the member can pick up a book that is set aside for them, or null if it is not set aside for them
