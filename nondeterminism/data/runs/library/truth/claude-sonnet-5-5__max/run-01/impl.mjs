// Community library: loans, renewals, holds and fines.
//
// Per-book state: at most one active loan, a waiting line of member ids (`queue`),
// and `readyUntil` - the last pickup day (a day number) while the book is set aside
// for queue[0]. Invariants:
//   loan !== null                        => readyUntil === null
//   readyUntil !== null                  => loan === null and queue is not empty
//   loan === null && readyUntil === null => queue is empty (book is free on the shelf)
//
// Time only moves through the dates of calls. Pickup windows are lapsed lazily: every
// call that looks at a book first brings it up to the call's date (see settle).

const LOAN_DAYS = 21;
const MAX_LOANS = 5;
const BORROW_BLOCKED_AT_OWED = 1000; // cents
const MAX_RENEWALS = 2;
const FINE_PER_LATE_DAY = 25; // cents
const FREE_LATE_DAYS = 2; // returning up to this many days late costs nothing
const FINE_CAP = 500; // cents, per returned book
const PICKUP_DAYS = 3;

const MS_PER_DAY = 86400000;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

// 'YYYY-MM-DD' -> whole days since 1970-01-01 (UTC), or null if not a real calendar date.
function parseDay(text) {
  if (typeof text !== 'string') return null;
  const match = DATE_PATTERN.exec(text);
  if (match === null) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const probe = new Date(0);
  probe.setUTCFullYear(year, month - 1, day);
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }
  return Math.round(probe.getTime() / MS_PER_DAY);
}

// Day number -> 'YYYY-MM-DD'.
function formatDay(day) {
  const date = new Date(day * MS_PER_DAY);
  const year = String(date.getUTCFullYear()).padStart(4, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dayOfMonth = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${dayOfMonth}`;
}

function isId(value) {
  return value !== undefined && value !== null && !Number.isNaN(value);
}

function refuse(reason) {
  return { ok: false, reason };
}

export function createLibrary() {
  const books = new Map(); // bookId -> { id, loan, queue, readyUntil }
  const members = new Map(); // memberId -> { owed, loans: Set<bookId>, holds: Set<bookId> }

  // Applies every pickup window that has lapsed on `book` by day `today`.
  // A window ends after readyUntil; the next member in line gets readyUntil + 3 days
  // (measured from the old window, not from today), until someone's window is still
  // open or the line is empty (book becomes free).
  function settle(book, today) {
    while (book.readyUntil !== null && book.readyUntil < today) {
      const lapsed = book.queue.shift();
      members.get(lapsed).holds.delete(book.id);
      book.readyUntil =
        book.queue.length > 0 ? book.readyUntil + PICKUP_DAYS : null;
    }
  }

  // Common argument handling for calls that name a member, a book and a date.
  function resolve(args) {
    const { memberId, bookId, date } = args ?? {};
    const today = parseDay(date);
    if (today === null) return { error: 'invalid date' };
    const member = members.get(memberId);
    if (member === undefined) return { error: 'unknown member' };
    const book = books.get(bookId);
    if (book === undefined) return { error: 'unknown book' };
    settle(book, today);
    return { today, memberId, member, book };
  }

  return {
    addBook(args) {
      const { bookId } = args ?? {};
      if (!isId(bookId)) return refuse('invalid book id');
      if (books.has(bookId)) return refuse('book already exists');
      books.set(bookId, { id: bookId, loan: null, queue: [], readyUntil: null });
      return { ok: true };
    },

    addMember(args) {
      const { memberId } = args ?? {};
      if (!isId(memberId)) return refuse('invalid member id');
      if (members.has(memberId)) return refuse('member already exists');
      members.set(memberId, { owed: 0, loans: new Set(), holds: new Set() });
      return { ok: true };
    },

    borrow(args) {
      const ctx = resolve(args);
      if (ctx.error) return refuse(ctx.error);
      const { today, memberId, member, book } = ctx;

      if (member.owed >= BORROW_BLOCKED_AT_OWED) return refuse('member owes too much');
      if (member.loans.size >= MAX_LOANS) return refuse('member has too many books on loan');
      if (book.loan !== null) return refuse('book is on loan');
      const setAside = book.readyUntil !== null;
      if (setAside && book.queue[0] !== memberId) {
        return refuse('book is set aside for another member');
      }

      if (setAside) {
        // The member picks up the copy set aside for them: their hold ends and
        // everyone behind them moves up one place.
        book.queue.shift();
        member.holds.delete(book.id);
        book.readyUntil = null;
      }
      book.loan = { memberId, due: today + LOAN_DAYS, renewals: 0 };
      member.loans.add(book.id);
      return { ok: true, dueDate: formatDay(book.loan.due) };
    },

    returnBook(args) {
      const ctx = resolve(args);
      if (ctx.error) return refuse(ctx.error);
      const { today, memberId, member, book } = ctx;

      const loan = book.loan;
      if (loan === null || loan.memberId !== memberId) {
        return refuse('book is not on loan to this member');
      }

      const daysLate = today - loan.due;
      const fine =
        daysLate > FREE_LATE_DAYS
          ? Math.min(FINE_CAP, daysLate * FINE_PER_LATE_DAY)
          : 0;
      member.owed += fine;
      member.loans.delete(book.id);
      book.loan = null;
      if (book.queue.length > 0) {
        book.readyUntil = today + PICKUP_DAYS;
      }
      return { ok: true, fine };
    },

    renew(args) {
      const ctx = resolve(args);
      if (ctx.error) return refuse(ctx.error);
      const { today, memberId, book } = ctx;

      const loan = book.loan;
      if (loan === null || loan.memberId !== memberId) {
        return refuse('book is not on loan to this member');
      }
      if (today > loan.due) return refuse('loan is overdue');
      if (loan.renewals >= MAX_RENEWALS) return refuse('renewal limit reached');
      if (book.queue.length > 0) return refuse('book has holds');

      loan.due += LOAN_DAYS;
      loan.renewals += 1;
      return { ok: true, dueDate: formatDay(loan.due) };
    },

    placeHold(args) {
      const ctx = resolve(args);
      if (ctx.error) return refuse(ctx.error);
      const { memberId, member, book } = ctx;

      const onLoan = book.loan !== null;
      const setAside = book.readyUntil !== null;
      if (!onLoan && !setAside) return refuse('book is free on the shelf');
      if (onLoan && book.loan.memberId === memberId) {
        return refuse('member already has this book on loan');
      }
      if (member.holds.has(book.id)) return refuse('member already holds this book');

      book.queue.push(memberId);
      member.holds.add(book.id);
      return { ok: true, position: book.queue.length };
    },

    payFine(args) {
      const { memberId, amount, date } = args ?? {};
      if (parseDay(date) === null) return refuse('invalid date');
      const member = members.get(memberId);
      if (member === undefined) return refuse('unknown member');
      if (!Number.isSafeInteger(amount) || amount <= 0) {
        return refuse('amount must be a positive whole number of cents');
      }
      if (amount > member.owed) return refuse('amount exceeds what is owed');

      member.owed -= amount;
      return { ok: true, owed: member.owed };
    },

    getMember(args) {
      const { memberId, date } = args ?? {};
      const today = parseDay(date);
      const member = members.get(memberId);
      if (today === null || member === undefined) {
        return {
          ok: false,
          reason: today === null ? 'invalid date' : 'unknown member',
          loans: [],
          owed: 0,
          holds: [],
        };
      }

      // Bring the member's held books up to date first; this may drop their holds.
      for (const bookId of [...member.holds]) {
        settle(books.get(bookId), today);
      }

      const loans = [];
      for (const bookId of member.loans) {
        loans.push({ bookId, dueDate: formatDay(books.get(bookId).loan.due) });
      }

      const holds = [];
      for (const bookId of member.holds) {
        const book = books.get(bookId);
        const position = book.queue.indexOf(memberId) + 1;
        holds.push({
          bookId,
          position,
          readyUntil:
            position === 1 && book.readyUntil !== null
              ? formatDay(book.readyUntil)
              : null,
        });
      }

      return { loans, owed: member.owed, holds };
    },
  };
}
