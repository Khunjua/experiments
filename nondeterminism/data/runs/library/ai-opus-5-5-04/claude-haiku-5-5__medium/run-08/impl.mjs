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

// Returns epoch ms (UTC midnight) for a valid 'YYYY-MM-DD' string, else null.
function parseDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (m < 1 || m > 12 || d < 1) return null;
  const dt = new Date(0);
  dt.setUTCFullYear(y, m - 1, d);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    return null;
  }
  return dt.getTime();
}

function toIso(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function addDays(d, n) {
  return toIso(parseDate(d) + n * DAY_MS);
}

function diffDays(a, b) {
  return (parseDate(b) - parseDate(a)) / DAY_MS;
}

function isId(x) {
  return typeof x === 'string' && x.length > 0;
}

function argsOf(a) {
  return a !== null && typeof a === 'object' ? a : {};
}

function fail(reason) {
  return { ok: false, reason };
}

export function createLibrary() {
  const books = new Map();   // bookId -> { bookId, status, queue: [{ memberId, readyFrom, readyUntil }] }
  const members = new Map(); // memberId -> { memberId, owed, loans: [{ bookId, borrowDate, dueDate, renewals }], holds: [bookId] }

  // Hold expiry (§5.2). Idempotent for a given date.
  function advance(date) {
    for (const book of books.values()) {
      if (book.status !== 'reserved') continue;
      while (
        book.status === 'reserved' &&
        book.queue.length > 0 &&
        book.queue[0].readyUntil !== null &&
        book.queue[0].readyUntil < date
      ) {
        const expired = book.queue.shift();
        const m = members.get(expired.memberId);
        if (m) m.holds = m.holds.filter((b) => b !== book.bookId);
        const nextStart = addDays(expired.readyUntil, 1);
        if (book.queue.length === 0) {
          book.status = 'shelf';
        } else {
          const first = book.queue[0];
          first.readyFrom = nextStart;
          first.readyUntil = addDays(nextStart, PICKUP_DAYS - 1);
        }
      }
    }
  }

  function addBook(arg) {
    const a = argsOf(arg);
    if (!isId(a.bookId)) return fail('invalid bookId');
    if (books.has(a.bookId)) return fail('book exists');
    books.set(a.bookId, { bookId: a.bookId, status: 'shelf', queue: [] });
    return { ok: true };
  }

  function addMember(arg) {
    const a = argsOf(arg);
    if (!isId(a.memberId)) return fail('invalid memberId');
    if (members.has(a.memberId)) return fail('member exists');
    members.set(a.memberId, { memberId: a.memberId, owed: 0, loans: [], holds: [] });
    return { ok: true };
  }

  function borrow(arg) {
    const a = argsOf(arg);
    const { memberId, bookId, date } = a;
    if (!isId(memberId) || !isId(bookId) || parseDate(date) === null) return fail('invalid');
    advance(date);
    const m = members.get(memberId);
    if (!m) return fail('unknown member');
    const b = books.get(bookId);
    if (!b) return fail('unknown book');
    if (b.status === 'loaned') return fail('on loan');
    if (b.status === 'reserved' && b.queue[0].memberId !== memberId) return fail('reserved');
    if (m.owed >= BLOCK_THRESHOLD) return fail('blocked by fines');
    if (m.loans.some((l) => l.dueDate < date)) return fail('overdue loan');
    if (m.loans.length >= MAX_LOANS) return fail('loan limit');

    if (b.status === 'reserved') {
      b.queue.shift();
      m.holds = m.holds.filter((x) => x !== bookId);
    }
    const dueDate = addDays(date, LOAN_DAYS);
    m.loans.push({ bookId, borrowDate: date, dueDate, renewals: 0 });
    b.status = 'loaned';
    return { ok: true, dueDate };
  }

  function returnBook(arg) {
    const a = argsOf(arg);
    const { memberId, bookId, date } = a;
    if (!isId(memberId) || !isId(bookId) || parseDate(date) === null) return fail('invalid');
    advance(date);
    const m = members.get(memberId);
    if (!m) return fail('unknown member');
    const b = books.get(bookId);
    if (!b) return fail('unknown book');
    const idx = m.loans.findIndex((l) => l.bookId === bookId);
    if (idx < 0) return fail('no such loan');
    const loan = m.loans[idx];
    m.loans.splice(idx, 1);

    const daysLate = Math.max(0, diffDays(loan.dueDate, date));
    const fine = Math.min(
      MAX_FINE_PER_LOAN,
      FINE_PER_DAY * Math.max(0, daysLate - GRACE_DAYS)
    );
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
  }

  function renew(arg) {
    const a = argsOf(arg);
    const { memberId, bookId, date } = a;
    if (!isId(memberId) || !isId(bookId) || parseDate(date) === null) return fail('invalid');
    advance(date);
    const m = members.get(memberId);
    if (!m) return fail('unknown member');
    const b = books.get(bookId);
    if (!b) return fail('unknown book');
    const loan = m.loans.find((l) => l.bookId === bookId);
    if (!loan) return fail('no such loan');
    if (date > loan.dueDate) return fail('overdue');
    if (loan.renewals >= MAX_RENEWALS) return fail('renewal limit');
    if (b.queue.length > 0) return fail('someone waiting');
    if (m.owed >= BLOCK_THRESHOLD) return fail('blocked by fines');

    loan.dueDate = addDays(loan.dueDate, LOAN_DAYS);
    loan.renewals += 1;
    return { ok: true, dueDate: loan.dueDate };
  }

  function placeHold(arg) {
    const a = argsOf(arg);
    const { memberId, bookId, date } = a;
    if (!isId(memberId) || !isId(bookId) || parseDate(date) === null) return fail('invalid');
    advance(date);
    const m = members.get(memberId);
    if (!m) return fail('unknown member');
    const b = books.get(bookId);
    if (!b) return fail('unknown book');
    if (b.status === 'shelf') return fail('available');
    if (m.loans.some((l) => l.bookId === bookId)) return fail('already on loan');
    if (b.queue.some((e) => e.memberId === memberId)) return fail('already held');
    if (m.holds.length >= MAX_HOLDS) return fail('hold limit');

    b.queue.push({ memberId, readyFrom: null, readyUntil: null });
    m.holds.push(bookId);
    return { ok: true, position: b.queue.length };
  }

  function payFine(arg) {
    const a = argsOf(arg);
    const { memberId, amount, date } = a;
    if (!isId(memberId) || parseDate(date) === null) return fail('invalid');
    advance(date);
    const m = members.get(memberId);
    if (!m) return fail('unknown member');
    if (!Number.isInteger(amount) || amount < 1) return fail('invalid amount');
    if (amount > m.owed) return fail('overpayment');
    m.owed -= amount;
    return { ok: true, owed: m.owed };
  }

  function getMember(arg) {
    const a = argsOf(arg);
    const { memberId, date } = a;
    if (!isId(memberId) || parseDate(date) === null) return fail('invalid');
    advance(date);
    const m = members.get(memberId);
    if (!m) return fail('unknown member');

    return {
      loans: m.loans.map((l) => ({ bookId: l.bookId, dueDate: l.dueDate })),
      owed: m.owed,
      holds: m.holds.map((bookId) => {
        const b = books.get(bookId);
        const idx = b.queue.findIndex((e) => e.memberId === memberId);
        const entry = b.queue[idx];
        return {
          bookId,
          position: idx + 1,
          readyUntil: entry.readyUntil !== null ? entry.readyUntil : null,
        };
      }),
    };
  }

  return {
    addBook,
    addMember,
    borrow,
    returnBook,
    renew,
    placeHold,
    payFine,
    getMember,
  };
}
