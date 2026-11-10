const LOAN_DAYS = 21;
const RENEW_DAYS = 21;
const MAX_RENEWALS = 2;
const PICKUP_DAYS = 7;
const FINE_PER_DAY = 25;
const MAX_FINE = 500;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y, m) {
  return [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

// Days since 1970-01-01 (proleptic Gregorian), pure integer arithmetic.
function daysFromCivil(y, m, d) {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const mp = m > 2 ? m - 3 : m + 9;
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(z) {
  z += 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  const y = yoe + era * 400 + (m <= 2 ? 1 : 0);
  return [y, m, d];
}

function parseDay(s) {
  if (typeof s !== 'string') return null;
  const match = DATE_RE.exec(s);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  return daysFromCivil(y, m, d);
}

function formatDay(n) {
  const [y, m, d] = civilFromDays(n);
  return String(y).padStart(4, '0') + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

function isId(v) {
  return typeof v === 'string' && v.length > 0;
}

function argObj(a) {
  return typeof a === 'object' && a !== null && !Array.isArray(a) ? a : null;
}

export function createLibrary() {
  const books = new Map();   // bookId -> { loan: null | loan, line: [hold, ...] }
  const members = new Map(); // memberId -> { owed }
  let clock = null;
  let nextSeq = 0;

  function fail(reason) {
    return { ok: false, reason };
  }

  // Parses common dated arguments. Returns null if anything is malformed.
  function dated(arg, opts) {
    const a = argObj(arg);
    if (!a || !isId(a.memberId)) return null;
    if (opts.book && !isId(a.bookId)) return null;
    const day = parseDay(a.date);
    if (day === null) return null;
    const out = { memberId: a.memberId, bookId: a.bookId, day, amount: undefined };
    if (opts.amount) {
      if (typeof a.amount !== 'number' || !Number.isSafeInteger(a.amount) || a.amount < 1) return null;
      out.amount = a.amount;
    }
    return out;
  }

  // Moves the clock forward and applies hold expirations. Returns false if the date is out of order.
  function advance(day) {
    if (clock !== null && day < clock) return false;
    clock = day;
    for (const book of books.values()) {
      expire(book, day);
    }
    return true;
  }

  // Applies every set-aside expiration whose free day is on or before `day`.
  function expire(book, day) {
    while (
      book.loan === null &&
      book.line.length > 0 &&
      book.line[0].readyUntil !== null &&
      book.line[0].readyUntil < day
    ) {
      const freeDay = book.line[0].readyUntil + 1;
      book.line.shift();
      if (book.line.length > 0) {
        book.line[0].readyUntil = freeDay + PICKUP_DAYS;
      }
    }
  }

  // A book becomes free on `day`: set aside for the first hold, or stays available.
  function freeBook(book, day) {
    if (book.line.length > 0) {
      book.line[0].readyUntil = day + PICKUP_DAYS;
    }
  }

  function addBook(arg) {
    const a = argObj(arg);
    if (!a || !isId(a.bookId)) return fail('INVALID_INPUT');
    if (books.has(a.bookId)) return fail('DUPLICATE');
    books.set(a.bookId, { loan: null, line: [] });
    return { ok: true };
  }

  function addMember(arg) {
    const a = argObj(arg);
    if (!a || !isId(a.memberId)) return fail('INVALID_INPUT');
    if (members.has(a.memberId)) return fail('DUPLICATE');
    members.set(a.memberId, { owed: 0 });
    return { ok: true };
  }

  function borrow(arg) {
    const r = dated(arg, { book: true });
    if (!r) return fail('INVALID_INPUT');
    if (!advance(r.day)) return fail('DATE_OUT_OF_ORDER');
    if (!members.has(r.memberId)) return fail('NO_MEMBER');
    const book = books.get(r.bookId);
    if (!book) return fail('NO_BOOK');
    if (book.loan !== null) return fail('NOT_AVAILABLE');
    const front = book.line[0];
    const setAsideHere = front !== undefined && front.readyUntil !== null;
    if (setAsideHere && front.memberId !== r.memberId) return fail('NOT_AVAILABLE');

    if (setAsideHere) {
      book.line.shift();
    }
    const loan = {
      memberId: r.memberId,
      bookId: r.bookId,
      dueDay: r.day + LOAN_DAYS,
      renewals: 0,
      seq: ++nextSeq,
    };
    book.loan = loan;
    return { ok: true, dueDate: formatDay(loan.dueDay) };
  }

  function placeHold(arg) {
    const r = dated(arg, { book: true });
    if (!r) return fail('INVALID_INPUT');
    if (!advance(r.day)) return fail('DATE_OUT_OF_ORDER');
    if (!members.has(r.memberId)) return fail('NO_MEMBER');
    const book = books.get(r.bookId);
    if (!book) return fail('NO_BOOK');
    if (book.loan === null && book.line.length === 0) return fail('BOOK_AVAILABLE');
    if (book.loan !== null && book.loan.memberId === r.memberId) return fail('ALREADY_BORROWED');
    if (book.line.some((h) => h.memberId === r.memberId)) return fail('ALREADY_HOLDING');

    book.line.push({ memberId: r.memberId, bookId: r.bookId, seq: ++nextSeq, readyUntil: null });
    return { ok: true, position: book.line.length };
  }

  function returnBook(arg) {
    const r = dated(arg, { book: true });
    if (!r) return fail('INVALID_INPUT');
    if (!advance(r.day)) return fail('DATE_OUT_OF_ORDER');
    if (!members.has(r.memberId)) return fail('NO_MEMBER');
    const book = books.get(r.bookId);
    if (!book) return fail('NO_BOOK');
    if (book.loan === null || book.loan.memberId !== r.memberId) return fail('NOT_ON_LOAN');

    const late = r.day - book.loan.dueDay;
    const fine = late > 0 ? Math.min(late * FINE_PER_DAY, MAX_FINE) : 0;
    members.get(r.memberId).owed += fine;
    book.loan = null;
    freeBook(book, r.day);
    return { ok: true, fine };
  }

  function renew(arg) {
    const r = dated(arg, { book: true });
    if (!r) return fail('INVALID_INPUT');
    if (!advance(r.day)) return fail('DATE_OUT_OF_ORDER');
    if (!members.has(r.memberId)) return fail('NO_MEMBER');
    const book = books.get(r.bookId);
    if (!book) return fail('NO_BOOK');
    if (book.loan === null || book.loan.memberId !== r.memberId) return fail('NOT_ON_LOAN');
    const loan = book.loan;
    if (r.day > loan.dueDay) return fail('OVERDUE');
    if (loan.renewals >= MAX_RENEWALS) return fail('RENEWAL_LIMIT');
    if (book.line.length > 0) return fail('HAS_HOLDS');

    loan.dueDay = r.day + RENEW_DAYS;
    loan.renewals += 1;
    return { ok: true, dueDate: formatDay(loan.dueDay) };
  }

  function payFine(arg) {
    const r = dated(arg, { book: false, amount: true });
    if (!r) return fail('INVALID_INPUT');
    if (!advance(r.day)) return fail('DATE_OUT_OF_ORDER');
    const member = members.get(r.memberId);
    if (!member) return fail('NO_MEMBER');
    if (r.amount > member.owed) return fail('BAD_AMOUNT');
    member.owed -= r.amount;
    return { ok: true, owed: member.owed };
  }

  function getMember(arg) {
    const r = dated(arg, { book: false });
    if (!r) return fail('INVALID_INPUT');
    if (!advance(r.day)) return fail('DATE_OUT_OF_ORDER');
    const member = members.get(r.memberId);
    if (!member) return fail('NO_MEMBER');

    const loanRows = [];
    const holdRows = [];
    for (const [bookId, book] of books) {
      if (book.loan !== null && book.loan.memberId === r.memberId) {
        loanRows.push({ seq: book.loan.seq, bookId, dueDay: book.loan.dueDay });
      }
      book.line.forEach((h, i) => {
        if (h.memberId === r.memberId) {
          holdRows.push({ seq: h.seq, bookId, position: i + 1, readyUntil: h.readyUntil });
        }
      });
    }
    loanRows.sort((x, y) => x.seq - y.seq);
    holdRows.sort((x, y) => x.seq - y.seq);

    return {
      loans: loanRows.map((l) => ({ bookId: l.bookId, dueDate: formatDay(l.dueDay) })),
      owed: member.owed,
      holds: holdRows.map((h) => ({
        bookId: h.bookId,
        position: h.position,
        readyUntil: h.readyUntil === null ? null : formatDay(h.readyUntil),
      })),
    };
  }

  // Guard: no method may throw. Argument reads happen before any mutation.
  function safe(fn) {
    return (arg) => {
      try {
        return fn(arg);
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
