const MS_PER_DAY = 86400000;
const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const MAX_LOANS = 5;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 3;
const MAX_FINE = 1000;
const DEBT_LIMIT = 1000;
const PICKUP_DAYS = 7;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

// Returns whole-day number (days since 1970-01-01, UTC arithmetic) or null.
function parseDate(s) {
  if (typeof s !== 'string') return null;
  const m = DATE_RE.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12) return null;
  let max = DAYS_IN_MONTH[mo - 1];
  if (mo === 2 && isLeap(y)) max = 29;
  if (d < 1 || d > max) return null;
  const dt = new Date(0);
  dt.setUTCFullYear(y, mo - 1, d);
  return Math.round(dt.getTime() / MS_PER_DAY);
}

function fromDay(n) {
  const dt = new Date(n * MS_PER_DAY);
  const y = String(dt.getUTCFullYear()).padStart(4, '0');
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function isId(v) {
  return typeof v === 'string' && v.length > 0;
}

function isObj(v) {
  return v !== null && typeof v === 'object';
}

function fail(reason) {
  return { ok: false, reason };
}

function guard(fn) {
  return (args) => {
    try {
      return fn(args);
    } catch {
      return fail('invalid input');
    }
  };
}

export function createLibrary() {
  // bookId -> { state: 'available' | 'loan' | 'setAside', loanMember, queue: [{ memberId, seq }], readyUntil }
  const books = new Map();
  // memberId -> { loans: [{ bookId, dueDate, renewals }], owed }
  const members = new Map();
  let lastDay = null;
  let holdSeq = 0;

  // Validates the date against the clock, then runs time processing.
  // Returns the day number, or null if the call must fail.
  function advanceClock(dateStr) {
    const d = parseDate(dateStr);
    if (d === null) return null;
    if (lastDay !== null && d < lastDay) return null;
    lastDay = d;
    expireHolds(d);
    return d;
  }

  function expireHolds(d) {
    for (const book of books.values()) {
      while (book.state === 'setAside' && book.readyUntil < d) {
        book.queue.shift();
        const nextStart = book.readyUntil + 1;
        if (book.queue.length > 0) {
          book.readyUntil = nextStart + PICKUP_DAYS;
        } else {
          book.state = 'available';
          book.readyUntil = null;
          book.loanMember = null;
        }
      }
    }
  }

  // All holds of a member, oldest placement first.
  function holdsOf(memberId) {
    const out = [];
    for (const [bookId, book] of books) {
      const idx = book.queue.findIndex((e) => e.memberId === memberId);
      if (idx >= 0) {
        out.push({ bookId, book, index: idx, seq: book.queue[idx].seq });
      }
    }
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  const addBook = guard((args) => {
    const bookId = isObj(args) ? args.bookId : undefined;
    if (!isId(bookId)) return fail('invalid bookId');
    if (books.has(bookId)) return fail('book exists');
    books.set(bookId, {
      state: 'available',
      loanMember: null,
      queue: [],
      readyUntil: null,
    });
    return { ok: true };
  });

  const addMember = guard((args) => {
    const memberId = isObj(args) ? args.memberId : undefined;
    if (!isId(memberId)) return fail('invalid memberId');
    if (members.has(memberId)) return fail('member exists');
    members.set(memberId, { loans: [], owed: 0 });
    return { ok: true };
  });

  const borrow = guard((args) => {
    const a = isObj(args) ? args : {};
    const memberId = a.memberId;
    const bookId = a.bookId;
    const date = a.date;
    if (!isId(memberId) || !isId(bookId)) return fail('invalid arguments');
    const d = advanceClock(date);
    if (d === null) return fail('invalid date or earlier than last date');

    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book) return fail('not found');
    if (book.state === 'loan') return fail('book on loan');
    if (book.state === 'setAside' && book.queue[0].memberId !== memberId) {
      return fail('book set aside for another member');
    }
    if (book.state === 'available' && book.queue.length > 0) {
      return fail('hold queue not empty');
    }
    if (member.owed >= DEBT_LIMIT) return fail('debt limit');
    if (member.loans.some((l) => d > l.dueDate)) return fail('overdue loan');
    if (member.loans.length >= MAX_LOANS) return fail('loan limit');

    const dueDate = d + LOAN_DAYS;
    member.loans.push({ bookId, dueDate, renewals: 0 });
    if (book.state === 'setAside') {
      book.queue.shift();
    }
    book.state = 'loan';
    book.loanMember = memberId;
    book.readyUntil = null;
    return { ok: true, dueDate: fromDay(dueDate) };
  });

  const returnBook = guard((args) => {
    const a = isObj(args) ? args : {};
    const memberId = a.memberId;
    const bookId = a.bookId;
    const date = a.date;
    if (!isId(memberId) || !isId(bookId)) return fail('invalid arguments');
    const d = advanceClock(date);
    if (d === null) return fail('invalid date or earlier than last date');

    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book) return fail('not found');
    const idx = member.loans.findIndex((l) => l.bookId === bookId);
    if (idx < 0) return fail('not on loan to member');

    const loan = member.loans[idx];
    const late = Math.max(0, d - loan.dueDate);
    const fine = Math.min(MAX_FINE, FINE_PER_DAY * Math.max(0, late - GRACE_DAYS));
    member.owed += fine;
    member.loans.splice(idx, 1);

    book.loanMember = null;
    if (book.queue.length > 0) {
      book.state = 'setAside';
      book.readyUntil = d + PICKUP_DAYS;
    } else {
      book.state = 'available';
      book.readyUntil = null;
    }
    return { ok: true, fine };
  });

  const renew = guard((args) => {
    const a = isObj(args) ? args : {};
    const memberId = a.memberId;
    const bookId = a.bookId;
    const date = a.date;
    if (!isId(memberId) || !isId(bookId)) return fail('invalid arguments');
    const d = advanceClock(date);
    if (d === null) return fail('invalid date or earlier than last date');

    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book) return fail('not found');
    const loan = member.loans.find((l) => l.bookId === bookId);
    if (!loan) return fail('not on loan to member');
    if (d > loan.dueDate) return fail('overdue loan');
    if (loan.renewals >= MAX_RENEWALS) return fail('renewal limit');
    if (book.queue.length > 0) return fail('book is wanted');
    if (member.owed >= DEBT_LIMIT) return fail('debt limit');

    loan.dueDate += LOAN_DAYS;
    loan.renewals += 1;
    return { ok: true, dueDate: fromDay(loan.dueDate) };
  });

  const placeHold = guard((args) => {
    const a = isObj(args) ? args : {};
    const memberId = a.memberId;
    const bookId = a.bookId;
    const date = a.date;
    if (!isId(memberId) || !isId(bookId)) return fail('invalid arguments');
    const d = advanceClock(date);
    if (d === null) return fail('invalid date or earlier than last date');

    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book) return fail('not found');
    if (book.state === 'available') return fail('book is available');
    if (member.loans.some((l) => l.bookId === bookId)) {
      return fail('member has book on loan');
    }
    if (book.queue.some((e) => e.memberId === memberId)) {
      return fail('hold already exists');
    }
    book.queue.push({ memberId, seq: holdSeq });
    holdSeq += 1;
    return { ok: true, position: book.queue.length };
  });

  const payFine = guard((args) => {
    const a = isObj(args) ? args : {};
    const memberId = a.memberId;
    const amount = a.amount;
    const date = a.date;
    if (!isId(memberId)) return fail('invalid memberId');
    if (!Number.isInteger(amount) || amount < 1) return fail('invalid amount');
    const d = advanceClock(date);
    if (d === null) return fail('invalid date or earlier than last date');

    const member = members.get(memberId);
    if (!member) return fail('not found');
    if (amount > member.owed) return fail('overpayment');
    member.owed -= amount;
    return { ok: true, owed: member.owed };
  });

  const getMember = guard((args) => {
    const a = isObj(args) ? args : {};
    const memberId = a.memberId;
    const date = a.date;
    if (!isId(memberId)) return fail('invalid memberId');
    const d = advanceClock(date);
    if (d === null) return fail('invalid date or earlier than last date');

    const member = members.get(memberId);
    if (!member) return fail('not found');

    const loans = member.loans.map((l) => ({
      bookId: l.bookId,
      dueDate: fromDay(l.dueDate),
    }));
    const holds = holdsOf(memberId).map((h) => ({
      bookId: h.bookId,
      position: h.index + 1,
      readyUntil:
        h.index === 0 && h.book.state === 'setAside'
          ? fromDay(h.book.readyUntil)
          : null,
    }));
    return { loans, owed: member.owed, holds };
  });

  return { addBook, addMember, borrow, returnBook, renew, placeHold, payFine, getMember };
}
