const DAY_MS = 86400000;
const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const MAX_LOANS = 5;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 3;
const MAX_FINE = 1000;
const DEBT_LIMIT = 1000;
const PICKUP_DAYS = 7;

function fail(reason) {
  return { ok: false, reason };
}

function safe(fn) {
  try {
    return fn();
  } catch {
    return fail('internal error');
  }
}

function obj(x) {
  return x !== null && typeof x === 'object' ? x : {};
}

function isId(x) {
  return typeof x === 'string' && x.length > 0;
}

function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

// Returns the day number (days since 1970-01-01, UTC) or null if invalid.
function parseDate(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12) return null;
  const dim = [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
  if (d < 1 || d > dim) return null;
  const t = new Date(0);
  t.setUTCFullYear(y, mo - 1, d);
  return Math.round(t.getTime() / DAY_MS);
}

function fmtDate(n) {
  const t = new Date(n * DAY_MS);
  const y = String(t.getUTCFullYear()).padStart(4, '0');
  const m = String(t.getUTCMonth() + 1).padStart(2, '0');
  const d = String(t.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function createLibrary() {
  // bookId -> { state: 'available'|'loan'|'set', loanedTo, readyUntil, queue: [{memberId, seq}] }
  const books = new Map();
  // memberId -> { loans: Map(bookId -> { dueDay, renewals }), owed }
  const members = new Map();
  let lastDay = null;
  let holdSeq = 0;

  // Pickup expiry processing (section 4.2).
  function expire(D) {
    for (const book of books.values()) {
      while (book.state === 'set' && D > book.readyUntil) {
        book.queue.shift();
        const S = book.readyUntil + 1;
        if (book.queue.length > 0) {
          book.readyUntil = S + PICKUP_DAYS;
        } else {
          book.state = 'available';
          book.readyUntil = null;
          book.loanedTo = null;
        }
      }
    }
  }

  // Validates the date against the clock and runs time processing.
  // Returns the day number, or null if the date is invalid or too early.
  function tick(date) {
    const d = parseDate(date);
    if (d === null) return null;
    if (lastDay !== null && d < lastDay) return null;
    lastDay = d;
    expire(d);
    return d;
  }

  return {
    addBook(args) {
      return safe(() => {
        const a = obj(args);
        if (!isId(a.bookId) || books.has(a.bookId)) return fail('invalid or existing book');
        books.set(a.bookId, { state: 'available', loanedTo: null, readyUntil: null, queue: [] });
        return { ok: true };
      });
    },

    addMember(args) {
      return safe(() => {
        const a = obj(args);
        if (!isId(a.memberId) || members.has(a.memberId)) return fail('invalid or existing member');
        members.set(a.memberId, { loans: new Map(), owed: 0 });
        return { ok: true };
      });
    },

    borrow(args) {
      return safe(() => {
        const a = obj(args);
        if (!isId(a.memberId) || !isId(a.bookId)) return fail('invalid arguments');
        const D = tick(a.date);
        if (D === null) return fail('invalid or out-of-order date');
        const m = members.get(a.memberId);
        const b = books.get(a.bookId);
        if (!m || !b) return fail('unknown member or book');
        if (b.state === 'loan') return fail('book on loan');
        if (b.state === 'set' && b.queue[0].memberId !== a.memberId) {
          return fail('book set aside for another member');
        }
        if (b.state === 'available' && b.queue.length > 0) return fail('book has a queue');
        if (m.owed >= DEBT_LIMIT) return fail('member owes too much');
        for (const loan of m.loans.values()) {
          if (D > loan.dueDay) return fail('member has overdue loan');
        }
        if (m.loans.size >= MAX_LOANS) return fail('loan limit reached');

        const dueDay = D + LOAN_DAYS;
        m.loans.set(a.bookId, { dueDay, renewals: 0 });
        if (b.state === 'set') b.queue.shift();
        b.state = 'loan';
        b.loanedTo = a.memberId;
        b.readyUntil = null;
        return { ok: true, dueDate: fmtDate(dueDay) };
      });
    },

    returnBook(args) {
      return safe(() => {
        const a = obj(args);
        if (!isId(a.memberId) || !isId(a.bookId)) return fail('invalid arguments');
        const D = tick(a.date);
        if (D === null) return fail('invalid or out-of-order date');
        const m = members.get(a.memberId);
        const b = books.get(a.bookId);
        if (!m || !b) return fail('unknown member or book');
        const loan = m.loans.get(a.bookId);
        if (!loan || b.state !== 'loan' || b.loanedTo !== a.memberId) {
          return fail('book not on loan to member');
        }

        const late = Math.max(0, D - loan.dueDay);
        const fine = Math.min(MAX_FINE, FINE_PER_DAY * Math.max(0, late - GRACE_DAYS));
        m.owed += fine;
        m.loans.delete(a.bookId);

        b.loanedTo = null;
        if (b.queue.length > 0) {
          b.state = 'set';
          b.readyUntil = D + PICKUP_DAYS;
        } else {
          b.state = 'available';
          b.readyUntil = null;
        }
        return { ok: true, fine };
      });
    },

    renew(args) {
      return safe(() => {
        const a = obj(args);
        if (!isId(a.memberId) || !isId(a.bookId)) return fail('invalid arguments');
        const D = tick(a.date);
        if (D === null) return fail('invalid or out-of-order date');
        const m = members.get(a.memberId);
        const b = books.get(a.bookId);
        if (!m || !b) return fail('unknown member or book');
        const loan = m.loans.get(a.bookId);
        if (!loan) return fail('book not on loan to member');
        if (D > loan.dueDay) return fail('loan is overdue');
        if (loan.renewals >= MAX_RENEWALS) return fail('renewal limit reached');
        if (b.queue.length > 0) return fail('book is requested');
        if (m.owed >= DEBT_LIMIT) return fail('member owes too much');

        loan.dueDay += LOAN_DAYS;
        loan.renewals += 1;
        return { ok: true, dueDate: fmtDate(loan.dueDay) };
      });
    },

    placeHold(args) {
      return safe(() => {
        const a = obj(args);
        if (!isId(a.memberId) || !isId(a.bookId)) return fail('invalid arguments');
        const D = tick(a.date);
        if (D === null) return fail('invalid or out-of-order date');
        const m = members.get(a.memberId);
        const b = books.get(a.bookId);
        if (!m || !b) return fail('unknown member or book');
        if (b.state === 'available') return fail('book is available');
        if (m.loans.has(a.bookId)) return fail('member has this book on loan');
        if (b.queue.some((e) => e.memberId === a.memberId)) return fail('hold already exists');

        b.queue.push({ memberId: a.memberId, seq: holdSeq++ });
        return { ok: true, position: b.queue.length };
      });
    },

    payFine(args) {
      return safe(() => {
        const a = obj(args);
        if (!isId(a.memberId)) return fail('invalid arguments');
        if (!Number.isInteger(a.amount)) return fail('amount must be an integer');
        const D = tick(a.date);
        if (D === null) return fail('invalid or out-of-order date');
        const m = members.get(a.memberId);
        if (!m) return fail('unknown member');
        if (a.amount < 1) return fail('amount too small');
        if (a.amount > m.owed) return fail('overpayment');

        m.owed -= a.amount;
        return { ok: true, owed: m.owed };
      });
    },

    getMember(args) {
      return safe(() => {
        const a = obj(args);
        if (!isId(a.memberId)) return fail('invalid arguments');
        const D = tick(a.date);
        if (D === null) return fail('invalid or out-of-order date');
        const m = members.get(a.memberId);
        if (!m) return fail('unknown member');

        const loans = [];
        for (const [bookId, loan] of m.loans) {
          loans.push({ bookId, dueDate: fmtDate(loan.dueDay) });
        }

        const found = [];
        for (const [bookId, b] of books) {
          b.queue.forEach((e, i) => {
            if (e.memberId === a.memberId) {
              const setAsideForMember = b.state === 'set' && i === 0;
              found.push({
                seq: e.seq,
                bookId,
                position: i + 1,
                readyUntil: setAsideForMember ? fmtDate(b.readyUntil) : null,
              });
            }
          });
        }
        found.sort((x, y) => x.seq - y.seq);
        const holds = found.map((h) => ({
          bookId: h.bookId,
          position: h.position,
          readyUntil: h.readyUntil,
        }));

        return { loans, owed: m.owed, holds };
      });
    },
  };
}
