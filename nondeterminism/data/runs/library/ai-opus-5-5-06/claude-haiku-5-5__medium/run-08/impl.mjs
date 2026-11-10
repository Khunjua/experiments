const DAY_MS = 86400000;
const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const MAX_FINE = 500;
const PICKUP_DAYS = 7;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

// Returns the day number (days since 1970-01-01, UTC-based) or null if invalid.
function parseDate(s) {
  if (typeof s !== 'string') return null;
  const m = DATE_RE.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const t = new Date(0);
  t.setUTCFullYear(y, mo - 1, d);
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) {
    return null;
  }
  return Math.round(t.getTime() / DAY_MS);
}

function formatDate(day) {
  const t = new Date(day * DAY_MS);
  const y = String(t.getUTCFullYear()).padStart(4, '0');
  const mo = String(t.getUTCMonth() + 1).padStart(2, '0');
  const d = String(t.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${d}`;
}

function isId(v) {
  return typeof v === 'string' && v.length > 0;
}

function asObj(v) {
  return typeof v === 'object' && v !== null ? v : null;
}

function fail(reason) {
  return { ok: false, reason };
}

export function createLibrary() {
  // bookId -> { loan: {memberId, dueDay, renewals, seq} | null, line: [hold], aside: boolean }
  // hold -> { memberId, seq, readyDay: number | null }
  const books = new Map();
  // memberId -> { owed: number }
  const members = new Map();
  let clock = null;
  let seq = 0;

  // Frees a book on `day`: set aside for the first hold, or available.
  function freeBook(book, day) {
    if (book.line.length > 0) {
      book.aside = true;
      book.line[0].readyDay = day + PICKUP_DAYS;
    } else {
      book.aside = false;
    }
  }

  // Applies every hold expiration due up to and including `day`.
  function catchUp(day) {
    for (const book of books.values()) {
      while (book.aside && book.line[0].readyDay < day) {
        const freeDay = book.line[0].readyDay + 1;
        book.line.shift();
        freeBook(book, freeDay);
      }
    }
  }

  // Returns false if the date is earlier than the clock (nothing changes).
  function advance(day) {
    if (clock !== null && day < clock) return false;
    catchUp(day);
    clock = day;
    return true;
  }

  function addBook(args) {
    const a = asObj(args);
    if (!a || !isId(a.bookId)) return fail('INVALID_INPUT');
    if (books.has(a.bookId)) return fail('DUPLICATE');
    books.set(a.bookId, { loan: null, line: [], aside: false });
    return { ok: true };
  }

  function addMember(args) {
    const a = asObj(args);
    if (!a || !isId(a.memberId)) return fail('INVALID_INPUT');
    if (members.has(a.memberId)) return fail('DUPLICATE');
    members.set(a.memberId, { owed: 0 });
    return { ok: true };
  }

  function borrow(args) {
    const a = asObj(args);
    if (!a) return fail('INVALID_INPUT');
    const day = parseDate(a.date);
    if (day === null) return fail('INVALID_INPUT');
    if (!advance(day)) return fail('DATE_OUT_OF_ORDER');
    if (!isId(a.memberId) || !isId(a.bookId)) return fail('INVALID_INPUT');
    if (!members.has(a.memberId)) return fail('NO_MEMBER');
    const book = books.get(a.bookId);
    if (!book) return fail('NO_BOOK');
    if (book.loan) return fail('NOT_AVAILABLE');
    if (book.aside && book.line[0].memberId !== a.memberId) return fail('NOT_AVAILABLE');
    if (book.aside) {
      book.line.shift();
      book.aside = false;
    }
    const loan = { memberId: a.memberId, dueDay: day + LOAN_DAYS, renewals: 0, seq: ++seq };
    book.loan = loan;
    return { ok: true, dueDate: formatDate(loan.dueDay) };
  }

  function placeHold(args) {
    const a = asObj(args);
    if (!a) return fail('INVALID_INPUT');
    const day = parseDate(a.date);
    if (day === null) return fail('INVALID_INPUT');
    if (!advance(day)) return fail('DATE_OUT_OF_ORDER');
    if (!isId(a.memberId) || !isId(a.bookId)) return fail('INVALID_INPUT');
    if (!members.has(a.memberId)) return fail('NO_MEMBER');
    const book = books.get(a.bookId);
    if (!book) return fail('NO_BOOK');
    const available = !book.loan && !book.aside;
    if (available) return fail('BOOK_AVAILABLE');
    if (book.loan && book.loan.memberId === a.memberId) return fail('ALREADY_BORROWED');
    if (book.line.some((h) => h.memberId === a.memberId)) return fail('ALREADY_HOLDING');
    book.line.push({ memberId: a.memberId, seq: ++seq, readyDay: null });
    return { ok: true, position: book.line.length };
  }

  function renew(args) {
    const a = asObj(args);
    if (!a) return fail('INVALID_INPUT');
    const day = parseDate(a.date);
    if (day === null) return fail('INVALID_INPUT');
    if (!advance(day)) return fail('DATE_OUT_OF_ORDER');
    if (!isId(a.memberId) || !isId(a.bookId)) return fail('INVALID_INPUT');
    if (!members.has(a.memberId)) return fail('NO_MEMBER');
    const book = books.get(a.bookId);
    if (!book) return fail('NO_BOOK');
    if (!book.loan || book.loan.memberId !== a.memberId) return fail('NOT_ON_LOAN');
    const loan = book.loan;
    if (day > loan.dueDay) return fail('OVERDUE');
    if (loan.renewals >= MAX_RENEWALS) return fail('RENEWAL_LIMIT');
    if (book.line.length > 0) return fail('HAS_HOLDS');
    loan.dueDay = day + LOAN_DAYS;
    loan.renewals += 1;
    return { ok: true, dueDate: formatDate(loan.dueDay) };
  }

  function returnBook(args) {
    const a = asObj(args);
    if (!a) return fail('INVALID_INPUT');
    const day = parseDate(a.date);
    if (day === null) return fail('INVALID_INPUT');
    if (!advance(day)) return fail('DATE_OUT_OF_ORDER');
    if (!isId(a.memberId) || !isId(a.bookId)) return fail('INVALID_INPUT');
    const member = members.get(a.memberId);
    if (!member) return fail('NO_MEMBER');
    const book = books.get(a.bookId);
    if (!book) return fail('NO_BOOK');
    if (!book.loan || book.loan.memberId !== a.memberId) return fail('NOT_ON_LOAN');
    const late = Math.max(0, day - book.loan.dueDay);
    const fine = Math.min(FINE_PER_DAY * late, MAX_FINE);
    member.owed += fine;
    book.loan = null;
    freeBook(book, day);
    return { ok: true, fine };
  }

  function payFine(args) {
    const a = asObj(args);
    if (!a) return fail('INVALID_INPUT');
    const day = parseDate(a.date);
    if (day === null) return fail('INVALID_INPUT');
    if (!advance(day)) return fail('DATE_OUT_OF_ORDER');
    if (!isId(a.memberId)) return fail('INVALID_INPUT');
    if (typeof a.amount !== 'number' || !Number.isSafeInteger(a.amount) || a.amount < 1) {
      return fail('BAD_AMOUNT');
    }
    const member = members.get(a.memberId);
    if (!member) return fail('NO_MEMBER');
    if (a.amount > member.owed) return fail('BAD_AMOUNT');
    member.owed -= a.amount;
    return { ok: true, owed: member.owed };
  }

  function getMember(args) {
    const a = asObj(args);
    if (!a) return fail('INVALID_INPUT');
    const day = parseDate(a.date);
    if (day === null) return fail('INVALID_INPUT');
    if (!advance(day)) return fail('DATE_OUT_OF_ORDER');
    if (!isId(a.memberId)) return fail('INVALID_INPUT');
    const member = members.get(a.memberId);
    if (!member) return fail('NO_MEMBER');

    const loans = [];
    const holds = [];
    for (const [bookId, book] of books) {
      if (book.loan && book.loan.memberId === a.memberId) {
        loans.push({ seq: book.loan.seq, bookId, dueDate: formatDate(book.loan.dueDay) });
      }
      book.line.forEach((h, i) => {
        if (h.memberId === a.memberId) {
          const set = book.aside && i === 0;
          holds.push({
            seq: h.seq,
            bookId,
            position: i + 1,
            readyUntil: set ? formatDate(h.readyDay) : null,
          });
        }
      });
    }
    loans.sort((x, y) => x.seq - y.seq);
    holds.sort((x, y) => x.seq - y.seq);

    return {
      loans: loans.map((l) => ({ bookId: l.bookId, dueDate: l.dueDate })),
      owed: member.owed,
      holds: holds.map((h) => ({
        bookId: h.bookId,
        position: h.position,
        readyUntil: h.readyUntil,
      })),
    };
  }

  // Guarantees no method throws.
  function safe(fn) {
    return function (args) {
      try {
        return fn(args);
      } catch {
        return { ok: false, reason: 'INVALID_INPUT' };
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
