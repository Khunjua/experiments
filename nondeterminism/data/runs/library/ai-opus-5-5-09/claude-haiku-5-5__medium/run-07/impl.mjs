const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const FINE_CAP = 500;
const BLOCK_THRESHOLD = 1000;
const PICKUP_DAYS = 7;
const MS_PER_DAY = 86400000;

function isPlainObject(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

function isId(x) {
  return typeof x === 'string' && x.length > 0;
}

function parseDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (m < 1 || m > 12 || d < 1) return null;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const dim = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  if (d > dim) return null;
  return { y, m, d };
}

function isDate(s) {
  return parseDate(s) !== null;
}

function dayNumber(s) {
  const { y, m, d } = parseDate(s);
  const dt = new Date(0);
  dt.setUTCFullYear(y, m - 1, d);
  return Math.round(dt.getTime() / MS_PER_DAY);
}

function dayString(n) {
  const dt = new Date(n * MS_PER_DAY);
  const y = dt.getUTCFullYear();
  const m = dt.getUTCMonth() + 1;
  const d = dt.getUTCDate();
  return String(y).padStart(4, '0') + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

function addDays(s, n) {
  return dayString(dayNumber(s) + n);
}

// number of days from b to a (a - b)
function daysBetween(a, b) {
  return dayNumber(a) - dayNumber(b);
}

function guard(fn) {
  return (args) => {
    try {
      return fn(args);
    } catch (e) {
      return { ok: false, reason: 'internal error' };
    }
  };
}

export function createLibrary() {
  const books = new Map();
  const members = new Map();
  let clock = null;
  let seq = 0;

  function fail(reason) {
    return { ok: false, reason };
  }

  // Sets book status after it stops being held by someone, on date S.
  function passToQueue(book, S) {
    if (book.queue.length === 0) {
      book.status = 'available';
    } else {
      book.status = 'readyForPickup';
      book.queue[0].readyUntil = addDays(S, PICKUP_DAYS);
    }
  }

  // Processes hold expirations strictly before date T, repeating until nothing changes.
  function processExpirations(T) {
    const tNum = dayNumber(T);
    let changed = true;
    while (changed) {
      changed = false;
      for (const book of books.values()) {
        if (book.status !== 'readyForPickup') continue;
        const h = book.queue[0];
        if (dayNumber(h.readyUntil) < tNum) {
          book.queue.shift();
          const member = members.get(h.memberId);
          member.holds = member.holds.filter((x) => x !== h);
          passToQueue(book, addDays(h.readyUntil, 1));
          changed = true;
        }
      }
    }
  }

  // Step 2 and 3 of section 3.5. Returns a failure object, or null if the clock advanced.
  function advance(date) {
    if (clock !== null && dayNumber(date) < dayNumber(clock)) {
      return fail('date earlier than clock');
    }
    clock = date;
    processExpirations(date);
    return null;
  }

  const api = {
    addBook: guard((args) => {
      if (!isPlainObject(args) || !isId(args.bookId)) return fail('invalid bookId');
      const bookId = args.bookId;
      if (books.has(bookId)) return fail('book exists');
      books.set(bookId, { id: bookId, status: 'available', loan: null, queue: [] });
      return { ok: true };
    }),

    addMember: guard((args) => {
      if (!isPlainObject(args) || !isId(args.memberId)) return fail('invalid memberId');
      const memberId = args.memberId;
      if (members.has(memberId)) return fail('member exists');
      members.set(memberId, { id: memberId, owed: 0, loans: [], holds: [] });
      return { ok: true };
    }),

    borrow: guard((args) => {
      if (!isPlainObject(args)) return fail('invalid arguments');
      const { memberId, bookId, date } = args;
      if (!isId(memberId) || !isId(bookId)) return fail('invalid id');
      if (!isDate(date)) return fail('invalid date');

      const timeErr = advance(date);
      if (timeErr) return timeErr;

      const member = members.get(memberId);
      if (!member) return fail('no such member');
      const book = books.get(bookId);
      if (!book) return fail('no such book');
      if (member.owed >= BLOCK_THRESHOLD) return fail('member owes too much');
      if (book.status === 'onLoan') return fail('book on loan');
      if (book.status === 'readyForPickup') {
        if (book.queue[0].memberId !== memberId) return fail('set aside for another member');
        const h = book.queue.shift();
        member.holds = member.holds.filter((x) => x !== h);
      } else if (book.queue.length > 0) {
        return fail('inconsistent state');
      }

      const loan = {
        bookId,
        memberId,
        borrowDate: date,
        dueDate: addDays(date, LOAN_DAYS),
        renewals: 0,
        seq: ++seq,
      };
      book.status = 'onLoan';
      book.loan = loan;
      member.loans.push(loan);
      return { ok: true, dueDate: loan.dueDate };
    }),

    returnBook: guard((args) => {
      if (!isPlainObject(args)) return fail('invalid arguments');
      const { memberId, bookId, date } = args;
      if (!isId(memberId) || !isId(bookId)) return fail('invalid id');
      if (!isDate(date)) return fail('invalid date');

      const timeErr = advance(date);
      if (timeErr) return timeErr;

      const member = members.get(memberId);
      if (!member) return fail('no such member');
      const book = books.get(bookId);
      if (!book) return fail('no such book');
      if (book.status !== 'onLoan' || book.loan.memberId !== memberId) {
        return fail('book not on loan to this member');
      }

      const loan = book.loan;
      const late = daysBetween(date, loan.dueDate);
      const fine = late > 0 ? Math.min(late * FINE_PER_DAY, FINE_CAP) : 0;

      member.owed += fine;
      member.loans = member.loans.filter((l) => l !== loan);
      book.loan = null;
      passToQueue(book, date);
      return { ok: true, fine };
    }),

    renew: guard((args) => {
      if (!isPlainObject(args)) return fail('invalid arguments');
      const { memberId, bookId, date } = args;
      if (!isId(memberId) || !isId(bookId)) return fail('invalid id');
      if (!isDate(date)) return fail('invalid date');

      const timeErr = advance(date);
      if (timeErr) return timeErr;

      const member = members.get(memberId);
      if (!member) return fail('no such member');
      const book = books.get(bookId);
      if (!book) return fail('no such book');
      if (book.status !== 'onLoan' || book.loan.memberId !== memberId) {
        return fail('book not on loan to this member');
      }
      if (book.queue.length > 0) return fail('someone is waiting');

      const loan = book.loan;
      if (loan.renewals >= MAX_RENEWALS) return fail('renewal limit reached');
      if (daysBetween(date, loan.dueDate) > 0) return fail('loan is overdue');
      if (member.owed >= BLOCK_THRESHOLD) return fail('member owes too much');

      loan.dueDate = addDays(loan.dueDate, LOAN_DAYS);
      loan.renewals += 1;
      return { ok: true, dueDate: loan.dueDate };
    }),

    placeHold: guard((args) => {
      if (!isPlainObject(args)) return fail('invalid arguments');
      const { memberId, bookId, date } = args;
      if (!isId(memberId) || !isId(bookId)) return fail('invalid id');
      if (!isDate(date)) return fail('invalid date');

      const timeErr = advance(date);
      if (timeErr) return timeErr;

      const member = members.get(memberId);
      if (!member) return fail('no such member');
      const book = books.get(bookId);
      if (!book) return fail('no such book');
      if (book.status === 'available') return fail('book is available');
      if (book.status === 'onLoan' && book.loan.memberId === memberId) {
        return fail('member already has this book');
      }
      if (book.queue.some((h) => h.memberId === memberId)) {
        return fail('member already holds this book');
      }

      const hold = { bookId, memberId, placedOrder: ++seq, readyUntil: null };
      book.queue.push(hold);
      member.holds.push(hold);
      return { ok: true, position: book.queue.length };
    }),

    payFine: guard((args) => {
      if (!isPlainObject(args)) return fail('invalid arguments');
      const { memberId, amount, date } = args;
      if (!isId(memberId)) return fail('invalid memberId');
      if (!Number.isInteger(amount) || amount <= 0) return fail('invalid amount');
      if (!isDate(date)) return fail('invalid date');

      const timeErr = advance(date);
      if (timeErr) return timeErr;

      const member = members.get(memberId);
      if (!member) return fail('no such member');
      if (amount > member.owed) return fail('amount exceeds owed');

      member.owed -= amount;
      return { ok: true, owed: member.owed };
    }),

    getMember: guard((args) => {
      if (!isPlainObject(args)) return fail('invalid arguments');
      const { memberId, date } = args;
      if (!isId(memberId)) return fail('invalid memberId');
      if (!isDate(date)) return fail('invalid date');

      const timeErr = advance(date);
      if (timeErr) return timeErr;

      const member = members.get(memberId);
      if (!member) return fail('no such member');

      const loans = member.loans
        .slice()
        .sort((a, b) => (dayNumber(a.borrowDate) - dayNumber(b.borrowDate)) || (a.seq - b.seq))
        .map((l) => ({ bookId: l.bookId, dueDate: l.dueDate }));

      const holds = member.holds
        .slice()
        .sort((a, b) => a.placedOrder - b.placedOrder)
        .map((h) => {
          const book = books.get(h.bookId);
          return {
            bookId: h.bookId,
            position: book.queue.indexOf(h) + 1,
            readyUntil: h.readyUntil,
          };
        });

      return { loans, owed: member.owed, holds };
    }),
  };

  return api;
}
