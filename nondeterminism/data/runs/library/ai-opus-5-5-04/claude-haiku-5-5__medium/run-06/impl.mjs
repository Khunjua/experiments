const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 3;
const MAX_FINE_PER_LOAN = 500;
const BLOCK_THRESHOLD = 500;
const MAX_LOANS = 5;
const MAX_HOLDS = 5;
const PICKUP_DAYS = 7;
const DAY_MS = 86400000;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y, m) {
  if (m === 2) return isLeap(y) ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

function parseDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  return { y, m, d };
}

function isValidDate(s) {
  return parseDate(s) !== null;
}

function toDayNumber(s) {
  const { y, m, d } = parseDate(s);
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  return Math.round(t.getTime() / DAY_MS);
}

function fromDayNumber(n) {
  const t = new Date(n * DAY_MS);
  const y = String(t.getUTCFullYear()).padStart(4, '0');
  const m = String(t.getUTCMonth() + 1).padStart(2, '0');
  const d = String(t.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDays(s, n) {
  return fromDayNumber(toDayNumber(s) + n);
}

function diffDays(a, b) {
  return toDayNumber(b) - toDayNumber(a);
}

function isId(x) {
  return typeof x === 'string' && x.length > 0;
}

function isObj(x) {
  return typeof x === 'object' && x !== null;
}

function fail(reason) {
  return { ok: false, reason };
}

function guard(fn) {
  try {
    return fn();
  } catch {
    return fail('error');
  }
}

export function createLibrary() {
  // bookId -> { bookId, status, queue: [{ memberId, readyFrom, readyUntil }] }
  const books = new Map();
  // memberId -> { memberId, owed, loans: [{ memberId, bookId, borrowDate, dueDate, renewals }], holds: [bookId] }
  const members = new Map();

  function advance(date) {
    for (const book of books.values()) {
      for (;;) {
        if (book.status !== 'reserved') break;
        const first = book.queue[0];
        if (!(first.readyUntil < date)) break;
        book.queue.shift();
        const m = members.get(first.memberId);
        m.holds = m.holds.filter((id) => id !== book.bookId);
        const nextStart = addDays(first.readyUntil, 1);
        if (book.queue.length === 0) {
          book.status = 'shelf';
          break;
        }
        const next = book.queue[0];
        next.readyFrom = nextStart;
        next.readyUntil = addDays(nextStart, PICKUP_DAYS - 1);
      }
    }
  }

  // Shape check; if it passes and the date is valid, runs advance.
  function begin(args, idKeys) {
    if (!isObj(args)) return false;
    for (const k of idKeys) {
      if (!isId(args[k])) return false;
    }
    if (!isValidDate(args.date)) return false;
    advance(args.date);
    return true;
  }

  return {
    addBook(args) {
      return guard(() => {
        if (!isObj(args) || !isId(args.bookId)) return fail('invalid');
        if (books.has(args.bookId)) return fail('exists');
        books.set(args.bookId, { bookId: args.bookId, status: 'shelf', queue: [] });
        return { ok: true };
      });
    },

    addMember(args) {
      return guard(() => {
        if (!isObj(args) || !isId(args.memberId)) return fail('invalid');
        if (members.has(args.memberId)) return fail('exists');
        members.set(args.memberId, { memberId: args.memberId, owed: 0, loans: [], holds: [] });
        return { ok: true };
      });
    },

    borrow(args) {
      return guard(() => {
        if (!begin(args, ['memberId', 'bookId'])) return fail('invalid');
        const { memberId, bookId, date } = args;
        const m = members.get(memberId);
        if (!m) return fail('unknown member');
        const b = books.get(bookId);
        if (!b) return fail('unknown book');
        if (b.status === 'loaned') return fail('on loan');
        if (b.status === 'reserved' && b.queue[0].memberId !== memberId) return fail('reserved for another');
        if (m.owed >= BLOCK_THRESHOLD) return fail('owes too much');
        if (m.loans.some((l) => l.dueDate < date)) return fail('overdue loan');
        if (m.loans.length >= MAX_LOANS) return fail('too many loans');

        if (b.status === 'reserved') {
          b.queue.shift();
          m.holds = m.holds.filter((id) => id !== bookId);
        }
        const dueDate = addDays(date, LOAN_DAYS);
        m.loans.push({ memberId, bookId, borrowDate: date, dueDate, renewals: 0 });
        b.status = 'loaned';
        return { ok: true, dueDate };
      });
    },

    returnBook(args) {
      return guard(() => {
        if (!begin(args, ['memberId', 'bookId'])) return fail('invalid');
        const { memberId, bookId, date } = args;
        const m = members.get(memberId);
        if (!m) return fail('unknown member');
        const b = books.get(bookId);
        if (!b) return fail('unknown book');
        const idx = m.loans.findIndex((l) => l.bookId === bookId);
        if (idx < 0) return fail('no such loan');
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
      });
    },

    renew(args) {
      return guard(() => {
        if (!begin(args, ['memberId', 'bookId'])) return fail('invalid');
        const { memberId, bookId, date } = args;
        const m = members.get(memberId);
        if (!m) return fail('unknown member');
        const b = books.get(bookId);
        if (!b) return fail('unknown book');
        const loan = m.loans.find((l) => l.bookId === bookId);
        if (!loan) return fail('no such loan');
        if (date > loan.dueDate) return fail('overdue');
        if (loan.renewals >= MAX_RENEWALS) return fail('max renewals');
        if (b.queue.length > 0) return fail('someone waiting');
        if (m.owed >= BLOCK_THRESHOLD) return fail('owes too much');

        loan.dueDate = addDays(loan.dueDate, LOAN_DAYS);
        loan.renewals += 1;
        return { ok: true, dueDate: loan.dueDate };
      });
    },

    placeHold(args) {
      return guard(() => {
        if (!begin(args, ['memberId', 'bookId'])) return fail('invalid');
        const { memberId, bookId } = args;
        const m = members.get(memberId);
        if (!m) return fail('unknown member');
        const b = books.get(bookId);
        if (!b) return fail('unknown book');
        if (b.status === 'shelf') return fail('available');
        if (m.loans.some((l) => l.bookId === bookId)) return fail('already on loan');
        if (b.queue.some((e) => e.memberId === memberId)) return fail('already in queue');
        if (m.holds.length >= MAX_HOLDS) return fail('too many holds');

        b.queue.push({ memberId, readyFrom: null, readyUntil: null });
        m.holds.push(bookId);
        return { ok: true, position: b.queue.length };
      });
    },

    payFine(args) {
      return guard(() => {
        if (!begin(args, ['memberId'])) return fail('invalid');
        const { memberId, amount } = args;
        const m = members.get(memberId);
        if (!m) return fail('unknown member');
        if (!Number.isInteger(amount) || amount < 1) return fail('invalid amount');
        if (amount > m.owed) return fail('overpayment');
        m.owed -= amount;
        return { ok: true, owed: m.owed };
      });
    },

    getMember(args) {
      return guard(() => {
        if (!begin(args, ['memberId'])) return fail('invalid');
        const { memberId } = args;
        const m = members.get(memberId);
        if (!m) return fail('unknown member');

        const loans = m.loans.map((l) => ({ bookId: l.bookId, dueDate: l.dueDate }));
        const holds = m.holds.map((bookId) => {
          const b = books.get(bookId);
          const idx = b.queue.findIndex((e) => e.memberId === memberId);
          const entry = b.queue[idx];
          const setAside = idx === 0 && b.status === 'reserved';
          return {
            bookId,
            position: idx + 1,
            readyUntil: setAside ? entry.readyUntil : null,
          };
        });
        return { loans, owed: m.owed, holds };
      });
    },
  };
}
