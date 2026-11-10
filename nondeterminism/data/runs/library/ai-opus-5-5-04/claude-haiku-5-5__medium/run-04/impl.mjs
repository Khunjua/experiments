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

// Returns the day number (days since 1970-01-01, UTC) or null if invalid.
function parseDay(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (m < 1 || m > 12 || d < 1) return null;
  const dt = new Date(0);
  dt.setUTCFullYear(y, m - 1, d);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.getTime() / MS_PER_DAY;
}

function validDay(s) {
  return parseDay(s) !== null;
}

function formatDay(n) {
  const dt = new Date(n * MS_PER_DAY);
  const y = String(dt.getUTCFullYear()).padStart(4, '0');
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDays(s, n) {
  return formatDay(parseDay(s) + n);
}

function diffDays(a, b) {
  return parseDay(b) - parseDay(a);
}

function validId(x) {
  return typeof x === 'string' && x.length > 0;
}

function field(args, key) {
  return args !== null && typeof args === 'object' ? args[key] : undefined;
}

const fail = (reason = 'invalid') => ({ ok: false, reason });

export function createLibrary() {
  const books = new Map();   // bookId -> { bookId, status, holdQueue: [] }
  const members = new Map(); // memberId -> { memberId, owed, loans: [] }
  let holdSeq = 0;

  // Hold expiry (section 5.2).
  function advance(date) {
    for (const book of books.values()) {
      while (
        book.status === 'reserved' &&
        book.holdQueue.length > 0 &&
        book.holdQueue[0].readyUntil < date
      ) {
        const expired = book.holdQueue.shift();
        const nextStart = addDays(expired.readyUntil, 1);
        if (book.holdQueue.length === 0) {
          book.status = 'shelf';
        } else {
          const first = book.holdQueue[0];
          first.readyFrom = nextStart;
          first.readyUntil = addDays(nextStart, PICKUP_DAYS - 1);
        }
      }
    }
  }

  function countActiveHolds(memberId) {
    let n = 0;
    for (const book of books.values()) {
      for (const e of book.holdQueue) {
        if (e.memberId === memberId) n++;
      }
    }
    return n;
  }

  function addBook(args) {
    const bookId = field(args, 'bookId');
    if (!validId(bookId)) return fail();
    if (books.has(bookId)) return fail('exists');
    books.set(bookId, { bookId, status: 'shelf', holdQueue: [] });
    return { ok: true };
  }

  function addMember(args) {
    const memberId = field(args, 'memberId');
    if (!validId(memberId)) return fail();
    if (members.has(memberId)) return fail('exists');
    members.set(memberId, { memberId, owed: 0, loans: [] });
    return { ok: true };
  }

  function borrow(args) {
    const memberId = field(args, 'memberId');
    const bookId = field(args, 'bookId');
    const date = field(args, 'date');
    if (!validId(memberId) || !validId(bookId) || !validDay(date)) return fail();
    advance(date);

    const m = members.get(memberId);
    if (!m) return fail('unknown member');
    const b = books.get(bookId);
    if (!b) return fail('unknown book');
    if (b.status === 'loaned') return fail('on loan');
    if (b.status === 'reserved' && b.holdQueue[0].memberId !== memberId) return fail('reserved');
    if (m.owed >= BLOCK_THRESHOLD) return fail('blocked');
    if (m.loans.some((l) => l.dueDate < date)) return fail('overdue');
    if (m.loans.length >= MAX_LOANS) return fail('loan limit');

    if (b.status === 'reserved') {
      b.holdQueue.shift(); // pickup
    }
    const dueDate = addDays(date, LOAN_DAYS);
    m.loans.push({ bookId, borrowDate: date, dueDate, renewals: 0 });
    b.status = 'loaned';
    return { ok: true, dueDate };
  }

  function returnBook(args) {
    const memberId = field(args, 'memberId');
    const bookId = field(args, 'bookId');
    const date = field(args, 'date');
    if (!validId(memberId) || !validId(bookId) || !validDay(date)) return fail();
    advance(date);

    const m = members.get(memberId);
    if (!m) return fail('unknown member');
    const b = books.get(bookId);
    if (!b) return fail('unknown book');
    const loan = m.loans.find((l) => l.bookId === bookId);
    if (!loan) return fail('no loan');

    const daysLate = Math.max(0, diffDays(loan.dueDate, date));
    const fine = Math.min(
      MAX_FINE_PER_LOAN,
      FINE_PER_DAY * Math.max(0, daysLate - GRACE_DAYS)
    );

    m.loans = m.loans.filter((l) => l !== loan);
    m.owed += fine;

    if (b.holdQueue.length === 0) {
      b.status = 'shelf';
    } else {
      const first = b.holdQueue[0];
      first.readyFrom = date;
      first.readyUntil = addDays(date, PICKUP_DAYS - 1);
      b.status = 'reserved';
    }
    return { ok: true, fine };
  }

  function renew(args) {
    const memberId = field(args, 'memberId');
    const bookId = field(args, 'bookId');
    const date = field(args, 'date');
    if (!validId(memberId) || !validId(bookId) || !validDay(date)) return fail();
    advance(date);

    const m = members.get(memberId);
    if (!m) return fail('unknown member');
    const b = books.get(bookId);
    if (!b) return fail('unknown book');
    const loan = m.loans.find((l) => l.bookId === bookId);
    if (!loan) return fail('no loan');
    if (date > loan.dueDate) return fail('overdue');
    if (loan.renewals >= MAX_RENEWALS) return fail('renewal limit');
    if (b.holdQueue.length > 0) return fail('waiting holds');
    if (m.owed >= BLOCK_THRESHOLD) return fail('blocked');

    loan.dueDate = addDays(loan.dueDate, LOAN_DAYS);
    loan.renewals += 1;
    return { ok: true, dueDate: loan.dueDate };
  }

  function placeHold(args) {
    const memberId = field(args, 'memberId');
    const bookId = field(args, 'bookId');
    const date = field(args, 'date');
    if (!validId(memberId) || !validId(bookId) || !validDay(date)) return fail();
    advance(date);

    const m = members.get(memberId);
    if (!m) return fail('unknown member');
    const b = books.get(bookId);
    if (!b) return fail('unknown book');
    if (b.status === 'shelf') return fail('available');
    if (m.loans.some((l) => l.bookId === bookId)) return fail('already on loan');
    if (b.holdQueue.some((e) => e.memberId === memberId)) return fail('already waiting');
    if (countActiveHolds(memberId) >= MAX_HOLDS) return fail('hold limit');

    holdSeq += 1;
    b.holdQueue.push({ memberId, seq: holdSeq, readyFrom: null, readyUntil: null });
    return { ok: true, position: b.holdQueue.length };
  }

  function payFine(args) {
    const memberId = field(args, 'memberId');
    const amount = field(args, 'amount');
    const date = field(args, 'date');
    if (!validId(memberId) || !validDay(date)) return fail();
    advance(date);

    const m = members.get(memberId);
    if (!m) return fail('unknown member');
    if (!Number.isInteger(amount) || amount < 1) return fail('bad amount');
    if (amount > m.owed) return fail('overpayment');

    m.owed -= amount;
    return { ok: true, owed: m.owed };
  }

  function getMember(args) {
    const memberId = field(args, 'memberId');
    const date = field(args, 'date');
    if (!validId(memberId) || !validDay(date)) return fail();
    advance(date);

    const m = members.get(memberId);
    if (!m) return fail('unknown member');

    const loans = m.loans.map((l) => ({ bookId: l.bookId, dueDate: l.dueDate }));

    const holdsWithSeq = [];
    for (const b of books.values()) {
      b.holdQueue.forEach((e, i) => {
        if (e.memberId === memberId) {
          holdsWithSeq.push({
            seq: e.seq,
            bookId: b.bookId,
            position: i + 1,
            readyUntil: i === 0 && b.status === 'reserved' ? e.readyUntil : null,
          });
        }
      });
    }
    holdsWithSeq.sort((x, y) => x.seq - y.seq);
    const holds = holdsWithSeq.map(({ bookId, position, readyUntil }) => ({
      bookId,
      position,
      readyUntil,
    }));

    return { loans, owed: m.owed, holds };
  }

  // Never throw: any unexpected error becomes a failure result.
  const safe = (fn) => (args) => {
    try {
      return fn(args);
    } catch {
      return { ok: false, reason: 'error' };
    }
  };

  return {
    addBook: safe(addBook),
    addMember: safe(addMember),
    borrow: safe(borrow),
    returnBook: safe(returnBook),
    renew: safe(renew),
    placeHold: safe(placeHold),
    payFine: safe(payFine),
    getMember: safe(getMember),
  };
}
