const DAY_MS = 86400000;
const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const RENEWAL_DAYS = 21;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 2;
const MAX_FINE = 500;
const MAX_LOANS = 5;
const BLOCK_OWED = 1000;
const MAX_HOLDS = 5;
const PICKUP_DAYS = 7;

function isObj(x) {
  return x !== null && typeof x === 'object';
}

function validId(x) {
  return typeof x === 'string' && x.length > 0;
}

function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y, m) {
  return [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

// Returns a day number (days since 1970-01-01 UTC) or null if invalid.
function parseDate(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1 || mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
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

const MAX_DAY = parseDate('9999-12-31');

// Dates past 9999-12-31 are clamped to 9999-12-31.
function addDays(n, k) {
  return Math.min(n + k, MAX_DAY);
}

export function createLibrary() {
  // bookId -> { state: 'available' | 'loan' | 'aside', borrower, queue, readyUntil }
  // queue entries: { memberId, seq }; when 'aside', queue[0] is the ready hold.
  const books = new Map();
  // memberId -> { loans: [{ bookId, dueDay, renewals }], owed }
  const members = new Map();
  let now = null;
  let holdSeq = 0;

  function fail() {
    return { ok: false };
  }

  // Processes hold expiries up to and including day D.
  function expire(D) {
    for (const book of books.values()) {
      while (book.state === 'aside' && D > book.readyUntil) {
        book.queue.shift();
        if (book.queue.length > 0) {
          book.readyUntil = addDays(book.readyUntil, 1 + PICKUP_DAYS);
        } else {
          book.state = 'available';
          book.borrower = null;
          book.readyUntil = null;
        }
      }
    }
  }

  // Validates the date, enforces clock order, advances the clock and
  // processes expiries. Returns the day number, or null if rejected.
  function advance(dateStr) {
    const D = parseDate(dateStr);
    if (D === null) return null;
    if (now !== null && D < now) return null;
    now = D;
    expire(D);
    return D;
  }

  function activeHoldCount(memberId) {
    let n = 0;
    for (const book of books.values()) {
      for (const h of book.queue) {
        if (h.memberId === memberId) n++;
      }
    }
    return n;
  }

  function addBook(args) {
    if (!isObj(args) || !validId(args.bookId) || books.has(args.bookId)) return fail();
    books.set(args.bookId, { state: 'available', borrower: null, queue: [], readyUntil: null });
    return { ok: true };
  }

  function addMember(args) {
    if (!isObj(args) || !validId(args.memberId) || members.has(args.memberId)) return fail();
    members.set(args.memberId, { loans: [], owed: 0 });
    return { ok: true };
  }

  function borrow(args) {
    if (!isObj(args) || !validId(args.memberId) || !validId(args.bookId)) return fail();
    const D = advance(args.date);
    if (D === null) return fail();
    const member = members.get(args.memberId);
    const book = books.get(args.bookId);
    if (!member || !book) return fail();
    if (book.state === 'loan') return fail();
    if (book.state === 'aside' && book.queue[0].memberId !== args.memberId) return fail();
    if (member.loans.length >= MAX_LOANS) return fail();
    if (member.loans.some((l) => l.dueDay < D)) return fail();
    if (member.owed >= BLOCK_OWED) return fail();

    const due = addDays(D, LOAN_DAYS);
    member.loans.push({ bookId: args.bookId, dueDay: due, renewals: 0 });
    if (book.state === 'aside') book.queue.shift();
    book.state = 'loan';
    book.borrower = args.memberId;
    book.readyUntil = null;
    return { ok: true, dueDate: fmtDate(due) };
  }

  function returnBook(args) {
    if (!isObj(args) || !validId(args.memberId) || !validId(args.bookId)) return fail();
    const D = advance(args.date);
    if (D === null) return fail();
    const member = members.get(args.memberId);
    const book = books.get(args.bookId);
    if (!member || !book) return fail();
    if (book.state !== 'loan' || book.borrower !== args.memberId) return fail();
    const idx = member.loans.findIndex((l) => l.bookId === args.bookId);
    if (idx < 0) return fail();

    const loan = member.loans[idx];
    const late = Math.max(0, D - loan.dueDay);
    const fine = Math.min(MAX_FINE, FINE_PER_DAY * Math.max(0, late - GRACE_DAYS));
    member.owed += fine;
    member.loans.splice(idx, 1);

    book.borrower = null;
    if (book.queue.length === 0) {
      book.state = 'available';
      book.readyUntil = null;
    } else {
      book.state = 'aside';
      book.readyUntil = addDays(D, PICKUP_DAYS);
    }
    return { ok: true, fine };
  }

  function renew(args) {
    if (!isObj(args) || !validId(args.memberId) || !validId(args.bookId)) return fail();
    const D = advance(args.date);
    if (D === null) return fail();
    const member = members.get(args.memberId);
    const book = books.get(args.bookId);
    if (!member || !book) return fail();
    if (book.state !== 'loan' || book.borrower !== args.memberId) return fail();
    const loan = member.loans.find((l) => l.bookId === args.bookId);
    if (!loan) return fail();
    if (loan.renewals >= MAX_RENEWALS) return fail();
    if (D > loan.dueDay) return fail();
    if (book.queue.length > 0) return fail();

    loan.dueDay = addDays(D, RENEWAL_DAYS);
    loan.renewals += 1;
    return { ok: true, dueDate: fmtDate(loan.dueDay) };
  }

  function placeHold(args) {
    if (!isObj(args) || !validId(args.memberId) || !validId(args.bookId)) return fail();
    const D = advance(args.date);
    if (D === null) return fail();
    const member = members.get(args.memberId);
    const book = books.get(args.bookId);
    if (!member || !book) return fail();
    if (book.state === 'available') return fail();
    if (book.state === 'loan' && book.borrower === args.memberId) return fail();
    if (book.queue.some((h) => h.memberId === args.memberId)) return fail();
    if (activeHoldCount(args.memberId) >= MAX_HOLDS) return fail();

    book.queue.push({ memberId: args.memberId, seq: holdSeq++ });
    return { ok: true, position: book.queue.length };
  }

  function payFine(args) {
    if (
      !isObj(args) ||
      !validId(args.memberId) ||
      !Number.isSafeInteger(args.amount) ||
      args.amount <= 0
    ) {
      return fail();
    }
    const D = advance(args.date);
    if (D === null) return fail();
    const member = members.get(args.memberId);
    if (!member) return fail();
    if (args.amount > member.owed) return fail();

    member.owed -= args.amount;
    return { ok: true, owed: member.owed };
  }

  function getMember(args) {
    if (!isObj(args) || !validId(args.memberId)) return fail();
    const D = advance(args.date);
    if (D === null) return fail();
    const member = members.get(args.memberId);
    if (!member) return fail();

    const loans = member.loans.map((l) => ({
      bookId: l.bookId,
      dueDate: fmtDate(l.dueDay),
    }));

    const found = [];
    for (const [bookId, book] of books) {
      book.queue.forEach((h, i) => {
        if (h.memberId === args.memberId) {
          found.push({
            seq: h.seq,
            bookId,
            position: i + 1,
            readyUntil:
              book.state === 'aside' && i === 0 ? fmtDate(book.readyUntil) : null,
          });
        }
      });
    }
    found.sort((a, b) => a.seq - b.seq);
    const holds = found.map(({ bookId, position, readyUntil }) => ({
      bookId,
      position,
      readyUntil,
    }));

    return { ok: true, loans, owed: member.owed, holds };
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
