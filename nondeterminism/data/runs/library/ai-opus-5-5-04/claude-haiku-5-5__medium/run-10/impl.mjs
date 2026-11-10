const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 3;
const MAX_FINE_PER_LOAN = 500;
const BLOCK_THRESHOLD = 500;
const MAX_LOANS = 5;
const MAX_HOLDS = 5;
const PICKUP_DAYS = 7;

const MS_PER_DAY = 86400000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDay(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (m < 1 || m > 12 || d < 1) return null;
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return Math.round(t.getTime() / MS_PER_DAY);
}

function formatDay(n) {
  const t = new Date(n * MS_PER_DAY);
  return String(t.getUTCFullYear()).padStart(4, '0') + '-' +
    String(t.getUTCMonth() + 1).padStart(2, '0') + '-' +
    String(t.getUTCDate()).padStart(2, '0');
}

function validDate(s) {
  return parseDay(s) !== null;
}

function addDays(s, n) {
  return formatDay(parseDay(s) + n);
}

function diffDays(a, b) {
  return parseDay(b) - parseDay(a);
}

function isObj(x) {
  return x !== null && typeof x === 'object';
}

function isId(x) {
  return typeof x === 'string' && x.length > 0;
}

function fail(reason = 'invalid') {
  return { ok: false, reason };
}

export function createLibrary() {
  // bookId -> { status, queue: [{ memberId, seq, readyFrom, readyUntil }] }
  const books = new Map();
  // memberId -> { owed, loans: [{ bookId, borrowDate, dueDate, renewals }] }
  const members = new Map();
  let holdSeq = 0;

  function advance(date) {
    for (const book of books.values()) {
      if (book.status !== 'reserved') continue;
      while (book.queue.length > 0 &&
             book.queue[0].readyUntil !== null &&
             book.queue[0].readyUntil < date) {
        const expired = book.queue.shift();
        const nextStart = addDays(expired.readyUntil, 1);
        if (book.queue.length === 0) {
          book.status = 'shelf';
          break;
        }
        const first = book.queue[0];
        first.readyFrom = nextStart;
        first.readyUntil = addDays(nextStart, PICKUP_DAYS - 1);
      }
    }
  }

  function holdCount(memberId) {
    let n = 0;
    for (const book of books.values()) {
      for (const e of book.queue) {
        if (e.memberId === memberId) n++;
      }
    }
    return n;
  }

  return {
    addBook(args) {
      try {
        if (!isObj(args) || !isId(args.bookId)) return fail();
        if (books.has(args.bookId)) return fail('exists');
        books.set(args.bookId, { status: 'shelf', queue: [] });
        return { ok: true };
      } catch {
        return fail('error');
      }
    },

    addMember(args) {
      try {
        if (!isObj(args) || !isId(args.memberId)) return fail();
        if (members.has(args.memberId)) return fail('exists');
        members.set(args.memberId, { owed: 0, loans: [] });
        return { ok: true };
      } catch {
        return fail('error');
      }
    },

    borrow(args) {
      try {
        if (!isObj(args)) return fail();
        const { memberId, bookId, date } = args;
        if (!isId(memberId) || !isId(bookId) || !validDate(date)) return fail();
        advance(date);
        const m = members.get(memberId);
        if (!m) return fail('unknown member');
        const b = books.get(bookId);
        if (!b) return fail('unknown book');
        if (b.status === 'loaned') return fail('loaned');
        if (b.status === 'reserved' && b.queue[0].memberId !== memberId) return fail('reserved');
        if (m.owed >= BLOCK_THRESHOLD) return fail('owes too much');
        if (m.loans.some(l => l.dueDate < date)) return fail('overdue');
        if (m.loans.length >= MAX_LOANS) return fail('too many loans');

        const dueDate = addDays(date, LOAN_DAYS);
        if (b.status === 'reserved') b.queue.shift();
        b.status = 'loaned';
        m.loans.push({ bookId, borrowDate: date, dueDate, renewals: 0 });
        return { ok: true, dueDate };
      } catch {
        return fail('error');
      }
    },

    returnBook(args) {
      try {
        if (!isObj(args)) return fail();
        const { memberId, bookId, date } = args;
        if (!isId(memberId) || !isId(bookId) || !validDate(date)) return fail();
        advance(date);
        const m = members.get(memberId);
        if (!m) return fail('unknown member');
        const b = books.get(bookId);
        if (!b) return fail('unknown book');
        const idx = m.loans.findIndex(l => l.bookId === bookId);
        if (idx < 0) return fail('no loan');

        const loan = m.loans[idx];
        const daysLate = Math.max(0, diffDays(loan.dueDate, date));
        const fine = Math.min(
          MAX_FINE_PER_LOAN,
          FINE_PER_DAY * Math.max(0, daysLate - GRACE_DAYS)
        );

        m.loans.splice(idx, 1);
        m.owed += fine;
        if (b.queue.length === 0) {
          b.status = 'shelf';
        } else {
          b.status = 'reserved';
          const first = b.queue[0];
          first.readyFrom = date;
          first.readyUntil = addDays(date, PICKUP_DAYS - 1);
        }
        return { ok: true, fine };
      } catch {
        return fail('error');
      }
    },

    renew(args) {
      try {
        if (!isObj(args)) return fail();
        const { memberId, bookId, date } = args;
        if (!isId(memberId) || !isId(bookId) || !validDate(date)) return fail();
        advance(date);
        const m = members.get(memberId);
        if (!m) return fail('unknown member');
        const b = books.get(bookId);
        if (!b) return fail('unknown book');
        const loan = m.loans.find(l => l.bookId === bookId);
        if (!loan) return fail('no loan');
        if (date > loan.dueDate) return fail('overdue');
        if (loan.renewals >= MAX_RENEWALS) return fail('renewal limit');
        if (b.queue.length > 0) return fail('someone waiting');
        if (m.owed >= BLOCK_THRESHOLD) return fail('owes too much');

        loan.dueDate = addDays(loan.dueDate, LOAN_DAYS);
        loan.renewals += 1;
        return { ok: true, dueDate: loan.dueDate };
      } catch {
        return fail('error');
      }
    },

    placeHold(args) {
      try {
        if (!isObj(args)) return fail();
        const { memberId, bookId, date } = args;
        if (!isId(memberId) || !isId(bookId) || !validDate(date)) return fail();
        advance(date);
        const m = members.get(memberId);
        if (!m) return fail('unknown member');
        const b = books.get(bookId);
        if (!b) return fail('unknown book');
        if (b.status === 'shelf') return fail('available');
        if (m.loans.some(l => l.bookId === bookId)) return fail('already has it');
        if (b.queue.some(e => e.memberId === memberId)) return fail('already in queue');
        if (holdCount(memberId) >= MAX_HOLDS) return fail('too many holds');

        holdSeq += 1;
        b.queue.push({ memberId, seq: holdSeq, readyFrom: null, readyUntil: null });
        return { ok: true, position: b.queue.length };
      } catch {
        return fail('error');
      }
    },

    payFine(args) {
      try {
        if (!isObj(args)) return fail();
        const { memberId, amount, date } = args;
        if (!isId(memberId) || !validDate(date)) return fail();
        advance(date);
        const m = members.get(memberId);
        if (!m) return fail('unknown member');
        if (!Number.isInteger(amount) || amount < 1) return fail('bad amount');
        if (amount > m.owed) return fail('overpayment');

        m.owed -= amount;
        return { ok: true, owed: m.owed };
      } catch {
        return fail('error');
      }
    },

    getMember(args) {
      try {
        if (!isObj(args)) return fail();
        const { memberId, date } = args;
        if (!isId(memberId) || !validDate(date)) return fail();
        advance(date);
        const m = members.get(memberId);
        if (!m) return fail('unknown member');

        const loans = m.loans.map(l => ({ bookId: l.bookId, dueDate: l.dueDate }));

        const collected = [];
        for (const [bookId, b] of books) {
          for (let i = 0; i < b.queue.length; i++) {
            const e = b.queue[i];
            if (e.memberId === memberId) {
              collected.push({
                seq: e.seq,
                bookId,
                position: i + 1,
                readyUntil: e.readyUntil === null ? null : e.readyUntil,
              });
            }
          }
        }
        collected.sort((x, y) => x.seq - y.seq);
        const holds = collected.map(h => ({
          bookId: h.bookId,
          position: h.position,
          readyUntil: h.readyUntil,
        }));

        return { loans, owed: m.owed, holds };
      } catch {
        return fail('error');
      }
    },
  };
}
