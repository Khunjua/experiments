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

// Returns the day number (days since 1970-01-01 UTC) or null if invalid.
function parseDay(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (m < 1 || m > 12 || d < 1) return null;
  const dt = new Date(0);
  dt.setUTCFullYear(y, m - 1, d);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    return null;
  }
  return Math.round(dt.getTime() / DAY_MS);
}

function formatDay(n) {
  const dt = new Date(n * DAY_MS);
  const y = String(dt.getUTCFullYear()).padStart(4, '0');
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDays(dateStr, n) {
  return formatDay(parseDay(dateStr) + n);
}

function isId(x) {
  return typeof x === 'string' && x.length > 0;
}

function args(a) {
  return a !== null && typeof a === 'object' ? a : {};
}

function fail(reason) {
  return { ok: false, reason };
}

export function createLibrary() {
  const books = new Map();
  const members = new Map();
  let seq = 0;

  // Sets the first queue entry aside from `from` for PICKUP_DAYS days.
  function setAside(book, from) {
    const entry = book.queue[0];
    entry.readyFrom = from;
    entry.readyUntil = addDays(from, PICKUP_DAYS - 1);
  }

  // Hold expiry processing, per spec section 5.2.
  function advance(date) {
    for (const book of books.values()) {
      while (book.status === 'reserved' && book.queue[0].readyUntil < date) {
        const expired = book.queue.shift();
        const nextStart = addDays(expired.readyUntil, 1);
        if (book.queue.length === 0) {
          book.status = 'shelf';
        } else {
          setAside(book, nextStart);
        }
      }
    }
  }

  // Validates the date; if valid, runs advance. Returns the day number or null.
  function prep(date) {
    const day = parseDay(date);
    if (day === null) return null;
    advance(date);
    return day;
  }

  function countHolds(memberId) {
    let n = 0;
    for (const book of books.values()) {
      for (const e of book.queue) {
        if (e.memberId === memberId) n++;
      }
    }
    return n;
  }

  function addBook(a) {
    const { bookId } = args(a);
    if (!isId(bookId)) return fail('invalid bookId');
    if (books.has(bookId)) return fail('book exists');
    books.set(bookId, { bookId, status: 'shelf', queue: [], loan: null });
    return { ok: true };
  }

  function addMember(a) {
    const { memberId } = args(a);
    if (!isId(memberId)) return fail('invalid memberId');
    if (members.has(memberId)) return fail('member exists');
    members.set(memberId, { memberId, owed: 0, loans: [] });
    return { ok: true };
  }

  function borrow(a) {
    const { memberId, bookId, date } = args(a);
    const day = prep(date);
    if (day === null || !isId(memberId) || !isId(bookId)) return fail('invalid input');

    const member = members.get(memberId);
    if (!member) return fail('unknown member');
    const book = books.get(bookId);
    if (!book) return fail('unknown book');

    if (book.status === 'loaned') return fail('book on loan');
    if (book.status === 'reserved' && book.queue[0].memberId !== memberId) {
      return fail('reserved for another member');
    }
    if (member.owed >= BLOCK_THRESHOLD) return fail('member blocked by fines');
    if (member.loans.some((l) => l.dueDate < date)) return fail('overdue loan');
    if (member.loans.length >= MAX_LOANS) return fail('loan limit reached');

    if (book.status === 'reserved') {
      // Pickup: remove this member's set-aside hold; remaining entries keep order.
      book.queue.shift();
    }

    const dueDate = formatDay(day + LOAN_DAYS);
    const loan = { memberId, bookId, borrowDate: date, dueDate, renewals: 0, seq: seq++ };
    member.loans.push(loan);
    book.loan = loan;
    book.status = 'loaned';
    return { ok: true, dueDate };
  }

  function returnBook(a) {
    const { memberId, bookId, date } = args(a);
    const day = prep(date);
    if (day === null || !isId(memberId) || !isId(bookId)) return fail('invalid input');

    const member = members.get(memberId);
    if (!member) return fail('unknown member');
    const book = books.get(bookId);
    if (!book) return fail('unknown book');

    const idx = member.loans.findIndex((l) => l.bookId === bookId);
    if (idx < 0) return fail('no active loan');
    const loan = member.loans[idx];

    const daysLate = Math.max(0, day - parseDay(loan.dueDate));
    const fine = Math.min(
      MAX_FINE_PER_LOAN,
      FINE_PER_DAY * Math.max(0, daysLate - GRACE_DAYS)
    );

    member.loans.splice(idx, 1);
    book.loan = null;
    member.owed += fine;

    if (book.queue.length === 0) {
      book.status = 'shelf';
    } else {
      book.status = 'reserved';
      setAside(book, date);
    }
    return { ok: true, fine };
  }

  function renew(a) {
    const { memberId, bookId, date } = args(a);
    const day = prep(date);
    if (day === null || !isId(memberId) || !isId(bookId)) return fail('invalid input');

    const member = members.get(memberId);
    if (!member) return fail('unknown member');
    const book = books.get(bookId);
    if (!book) return fail('unknown book');

    const loan = member.loans.find((l) => l.bookId === bookId);
    if (!loan) return fail('no active loan');
    if (date > loan.dueDate) return fail('overdue loan');
    if (loan.renewals >= MAX_RENEWALS) return fail('renewal limit reached');
    if (book.queue.length > 0) return fail('book has waiting members');
    if (member.owed >= BLOCK_THRESHOLD) return fail('member blocked by fines');

    loan.dueDate = addDays(loan.dueDate, LOAN_DAYS);
    loan.renewals += 1;
    return { ok: true, dueDate: loan.dueDate };
  }

  function placeHold(a) {
    const { memberId, bookId, date } = args(a);
    const day = prep(date);
    if (day === null || !isId(memberId) || !isId(bookId)) return fail('invalid input');

    const member = members.get(memberId);
    if (!member) return fail('unknown member');
    const book = books.get(bookId);
    if (!book) return fail('unknown book');

    if (book.status === 'shelf') return fail('book available on shelf');
    if (member.loans.some((l) => l.bookId === bookId)) return fail('member has this book');
    if (book.queue.some((e) => e.memberId === memberId)) return fail('already in queue');
    if (countHolds(memberId) >= MAX_HOLDS) return fail('hold limit reached');

    book.queue.push({ memberId, seq: seq++, readyFrom: null, readyUntil: null });
    return { ok: true, position: book.queue.length };
  }

  function payFine(a) {
    const { memberId, amount, date } = args(a);
    const day = prep(date);
    if (day === null || !isId(memberId)) return fail('invalid input');

    const member = members.get(memberId);
    if (!member) return fail('unknown member');
    if (!Number.isInteger(amount) || amount < 1) return fail('invalid amount');
    if (amount > member.owed) return fail('overpayment');

    member.owed -= amount;
    return { ok: true, owed: member.owed };
  }

  function getMember(a) {
    const { memberId, date } = args(a);
    const day = prep(date);
    if (day === null || !isId(memberId)) return fail('invalid input');

    const member = members.get(memberId);
    if (!member) return fail('unknown member');

    const loans = member.loans.map((l) => ({ bookId: l.bookId, dueDate: l.dueDate }));

    const rawHolds = [];
    for (const book of books.values()) {
      book.queue.forEach((e, i) => {
        if (e.memberId === memberId) {
          const setAsideForMe = i === 0 && book.status === 'reserved';
          rawHolds.push({
            seq: e.seq,
            bookId: book.bookId,
            position: i + 1,
            readyUntil: setAsideForMe ? e.readyUntil : null,
          });
        }
      });
    }
    rawHolds.sort((x, y) => x.seq - y.seq);
    const holds = rawHolds.map(({ bookId, position, readyUntil }) => ({
      bookId,
      position,
      readyUntil,
    }));

    return { loans, owed: member.owed, holds };
  }

  function safe(fn) {
    return (a) => {
      try {
        return fn(a);
      } catch {
        return fail('internal error');
      }
    };
  }

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
