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

// Returns epoch milliseconds (UTC midnight) for a valid 'YYYY-MM-DD' string, else null.
function parseDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (m < 1 || m > 12 || d < 1) return null;
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return t.getTime();
}

function isDate(s) {
  return parseDate(s) !== null;
}

function formatDate(ms) {
  const t = new Date(ms);
  const y = String(t.getUTCFullYear()).padStart(4, '0');
  const m = String(t.getUTCMonth() + 1).padStart(2, '0');
  const d = String(t.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDays(s, n) {
  return formatDate(parseDate(s) + n * DAY_MS);
}

function diffDays(a, b) {
  return Math.round((parseDate(b) - parseDate(a)) / DAY_MS);
}

function isId(v) {
  return typeof v === 'string' && v.length > 0;
}

function field(arg, key) {
  return arg !== null && typeof arg === 'object' ? arg[key] : undefined;
}

function fail(reason) {
  return { ok: false, reason };
}

function safe(fn) {
  return (arg) => {
    try {
      return fn(arg);
    } catch {
      return fail('error');
    }
  };
}

export function createLibrary() {
  // bookId -> { status: 'shelf' | 'loaned' | 'reserved', queue: [entry], loanedTo: memberId | null }
  // entry -> { memberId, seq, readyFrom, readyUntil }  (readyFrom/readyUntil set only on a set-aside first entry)
  const books = new Map();
  // memberId -> { owed: number, loans: [{ bookId, borrowDate, dueDate, renewals }] } (creation order)
  const members = new Map();
  let holdSeq = 0;

  function advance(date) {
    for (const book of books.values()) {
      if (book.status !== 'reserved') continue;
      while (
        book.queue.length > 0 &&
        book.queue[0].readyUntil !== null &&
        book.queue[0].readyUntil < date
      ) {
        const expired = book.queue.shift();
        const nextStart = addDays(expired.readyUntil, 1);
        if (book.queue.length === 0) {
          book.status = 'shelf';
          book.loanedTo = null;
        } else {
          const first = book.queue[0];
          first.readyFrom = nextStart;
          first.readyUntil = addDays(nextStart, PICKUP_DAYS - 1);
        }
      }
    }
  }

  function memberHolds(memberId) {
    const out = [];
    for (const [bookId, book] of books) {
      book.queue.forEach((entry, index) => {
        if (entry.memberId !== memberId) return;
        const setAside = index === 0 && book.status === 'reserved' && entry.readyUntil !== null;
        out.push({
          seq: entry.seq,
          bookId,
          position: index + 1,
          readyUntil: setAside ? entry.readyUntil : null,
        });
      });
    }
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  const addBook = safe((arg) => {
    const bookId = field(arg, 'bookId');
    if (!isId(bookId)) return fail('invalid bookId');
    if (books.has(bookId)) return fail('duplicate book');
    books.set(bookId, { status: 'shelf', queue: [], loanedTo: null });
    return { ok: true };
  });

  const addMember = safe((arg) => {
    const memberId = field(arg, 'memberId');
    if (!isId(memberId)) return fail('invalid memberId');
    if (members.has(memberId)) return fail('duplicate member');
    members.set(memberId, { owed: 0, loans: [] });
    return { ok: true };
  });

  const borrow = safe((arg) => {
    const memberId = field(arg, 'memberId');
    const bookId = field(arg, 'bookId');
    const date = field(arg, 'date');
    if (!isId(memberId) || !isId(bookId) || !isDate(date)) return fail('invalid input');
    advance(date);

    const m = members.get(memberId);
    if (!m) return fail('unknown member');
    const b = books.get(bookId);
    if (!b) return fail('unknown book');
    if (b.status === 'loaned') return fail('book on loan');
    if (b.status === 'reserved' && b.queue[0].memberId !== memberId) return fail('reserved for another');
    if (m.owed >= BLOCK_THRESHOLD) return fail('owes too much');
    if (m.loans.some((l) => l.dueDate < date)) return fail('overdue loan');
    if (m.loans.length >= MAX_LOANS) return fail('too many loans');

    if (b.status === 'reserved') {
      b.queue.shift(); // pickup
    }
    const dueDate = addDays(date, LOAN_DAYS);
    m.loans.push({ bookId, borrowDate: date, dueDate, renewals: 0 });
    b.status = 'loaned';
    b.loanedTo = memberId;
    return { ok: true, dueDate };
  });

  const returnBook = safe((arg) => {
    const memberId = field(arg, 'memberId');
    const bookId = field(arg, 'bookId');
    const date = field(arg, 'date');
    if (!isId(memberId) || !isId(bookId) || !isDate(date)) return fail('invalid input');
    advance(date);

    const m = members.get(memberId);
    if (!m) return fail('unknown member');
    const b = books.get(bookId);
    if (!b) return fail('unknown book');
    const idx = m.loans.findIndex((l) => l.bookId === bookId);
    if (idx === -1) return fail('no such loan');

    const loan = m.loans[idx];
    const daysLate = Math.max(0, diffDays(loan.dueDate, date));
    const fine = Math.min(MAX_FINE_PER_LOAN, FINE_PER_DAY * Math.max(0, daysLate - GRACE_DAYS));

    m.loans.splice(idx, 1);
    m.owed += fine;
    b.loanedTo = null;
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

  const renew = safe((arg) => {
    const memberId = field(arg, 'memberId');
    const bookId = field(arg, 'bookId');
    const date = field(arg, 'date');
    if (!isId(memberId) || !isId(bookId) || !isDate(date)) return fail('invalid input');
    advance(date);

    const m = members.get(memberId);
    if (!m) return fail('unknown member');
    const b = books.get(bookId);
    if (!b) return fail('unknown book');
    const loan = m.loans.find((l) => l.bookId === bookId);
    if (!loan) return fail('no such loan');
    if (date > loan.dueDate) return fail('overdue');
    if (loan.renewals >= MAX_RENEWALS) return fail('max renewals');
    if (b.queue.length > 0) return fail('book wanted');
    if (m.owed >= BLOCK_THRESHOLD) return fail('owes too much');

    loan.dueDate = addDays(loan.dueDate, LOAN_DAYS);
    loan.renewals += 1;
    return { ok: true, dueDate: loan.dueDate };
  });

  const placeHold = safe((arg) => {
    const memberId = field(arg, 'memberId');
    const bookId = field(arg, 'bookId');
    const date = field(arg, 'date');
    if (!isId(memberId) || !isId(bookId) || !isDate(date)) return fail('invalid input');
    advance(date);

    const m = members.get(memberId);
    if (!m) return fail('unknown member');
    const b = books.get(bookId);
    if (!b) return fail('unknown book');
    if (b.status === 'shelf') return fail('available');
    if (m.loans.some((l) => l.bookId === bookId)) return fail('already on loan');
    if (b.queue.some((e) => e.memberId === memberId)) return fail('already in queue');
    if (memberHolds(memberId).length >= MAX_HOLDS) return fail('too many holds');

    holdSeq += 1;
    b.queue.push({ memberId, seq: holdSeq, readyFrom: null, readyUntil: null });
    return { ok: true, position: b.queue.length };
  });

  const payFine = safe((arg) => {
    const memberId = field(arg, 'memberId');
    const amount = field(arg, 'amount');
    const date = field(arg, 'date');
    if (!isId(memberId) || !isDate(date)) return fail('invalid input');
    advance(date);

    const m = members.get(memberId);
    if (!m) return fail('unknown member');
    if (!Number.isInteger(amount) || amount < 1) return fail('invalid amount');
    if (amount > m.owed) return fail('overpayment');

    m.owed -= amount;
    return { ok: true, owed: m.owed };
  });

  const getMember = safe((arg) => {
    const memberId = field(arg, 'memberId');
    const date = field(arg, 'date');
    if (!isId(memberId) || !isDate(date)) return fail('invalid input');
    advance(date);

    const m = members.get(memberId);
    if (!m) return fail('unknown member');

    return {
      loans: m.loans.map((l) => ({ bookId: l.bookId, dueDate: l.dueDate })),
      owed: m.owed,
      holds: memberHolds(memberId).map((h) => ({
        bookId: h.bookId,
        position: h.position,
        readyUntil: h.readyUntil,
      })),
    };
  });

  return { addBook, addMember, borrow, returnBook, renew, placeHold, payFine, getMember };
}
