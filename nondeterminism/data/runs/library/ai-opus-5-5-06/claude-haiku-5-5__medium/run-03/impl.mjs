const DAY_MS = 86400000;
const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const MAX_FINE = 500;
const HOLD_WINDOW = 7;

const fail = (reason) => ({ ok: false, reason });

function isObject(v) {
  return v !== null && typeof v === 'object';
}

function isId(v) {
  return typeof v === 'string' && v.length > 0;
}

function isAmount(v) {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 1;
}

// Returns integer day number (days since 1970-01-01 UTC) or null if invalid.
function parseDate(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1) return null;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const dim = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
  if (d > dim) return null;
  const t = new Date(0);
  t.setUTCFullYear(y, mo - 1, d);
  return Math.round(t.getTime() / DAY_MS);
}

function formatDay(n) {
  const t = new Date(n * DAY_MS);
  const y = String(t.getUTCFullYear()).padStart(4, '0');
  const m = String(t.getUTCMonth() + 1).padStart(2, '0');
  const d = String(t.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function createLibrary() {
  let clock = null;
  let seq = 0;
  // bookId -> { state: 'available' | 'loan' | 'set', holds: [], loan: null | {memberId, dueDay, renewals, seq} }
  // holds: [{ memberId, seq, readyUntil: dayNumber | null }]; only holds[0] may have readyUntil set.
  const books = new Map();
  // memberId -> { owed }
  const members = new Map();

  // Book becomes free on `day`: set aside for first hold, or available.
  function freeBook(book, day) {
    if (book.holds.length > 0) {
      book.holds[0].readyUntil = day + HOLD_WINDOW;
      book.state = 'set';
    } else {
      book.state = 'available';
    }
  }

  // Applies every set-aside expiration due on or before `day`.
  function applyExpirations(day) {
    for (const book of books.values()) {
      while (book.state === 'set' && book.holds[0].readyUntil < day) {
        const r = book.holds[0].readyUntil;
        book.holds.shift();
        freeBook(book, r + 1);
      }
    }
  }

  // Common date handling for dated calls. Returns { day } or { reason }.
  function startDated(args) {
    const day = parseDate(args.date);
    if (day === null) return { reason: 'INVALID_INPUT' };
    if (clock !== null && day < clock) return { reason: 'DATE_OUT_OF_ORDER' };
    clock = day;
    applyExpirations(day);
    return { day };
  }

  function addBook(args) {
    if (!isObject(args)) return fail('INVALID_INPUT');
    const bookId = args.bookId;
    if (!isId(bookId)) return fail('INVALID_INPUT');
    if (books.has(bookId)) return fail('DUPLICATE');
    books.set(bookId, { state: 'available', holds: [], loan: null });
    return { ok: true };
  }

  function addMember(args) {
    if (!isObject(args)) return fail('INVALID_INPUT');
    const memberId = args.memberId;
    if (!isId(memberId)) return fail('INVALID_INPUT');
    if (members.has(memberId)) return fail('DUPLICATE');
    members.set(memberId, { owed: 0 });
    return { ok: true };
  }

  function borrow(args) {
    if (!isObject(args)) return fail('INVALID_INPUT');
    const t = startDated(args);
    if (t.reason) return fail(t.reason);
    const memberId = args.memberId;
    const bookId = args.bookId;
    if (!isId(memberId) || !isId(bookId)) return fail('INVALID_INPUT');
    if (!members.has(memberId)) return fail('NO_MEMBER');
    const book = books.get(bookId);
    if (!book) return fail('NO_BOOK');
    if (book.loan) return fail('ALREADY_BORROWED');
    if (book.state === 'set' && book.holds[0].memberId !== memberId) {
      return fail('NOT_AVAILABLE');
    }
    if (book.state === 'set') {
      book.holds.shift();
    }
    const dueDay = t.day + LOAN_DAYS;
    book.loan = { memberId, dueDay, renewals: 0, seq: ++seq };
    book.state = 'loan';
    return { ok: true, dueDate: formatDay(dueDay) };
  }

  function placeHold(args) {
    if (!isObject(args)) return fail('INVALID_INPUT');
    const t = startDated(args);
    if (t.reason) return fail(t.reason);
    const memberId = args.memberId;
    const bookId = args.bookId;
    if (!isId(memberId) || !isId(bookId)) return fail('INVALID_INPUT');
    if (!members.has(memberId)) return fail('NO_MEMBER');
    const book = books.get(bookId);
    if (!book) return fail('NO_BOOK');
    if (book.state === 'available') return fail('BOOK_AVAILABLE');
    if (book.loan && book.loan.memberId === memberId) return fail('ALREADY_BORROWED');
    if (book.holds.some((h) => h.memberId === memberId)) return fail('ALREADY_HOLDING');
    book.holds.push({ memberId, seq: ++seq, readyUntil: null });
    return { ok: true, position: book.holds.length };
  }

  function returnBook(args) {
    if (!isObject(args)) return fail('INVALID_INPUT');
    const t = startDated(args);
    if (t.reason) return fail(t.reason);
    const memberId = args.memberId;
    const bookId = args.bookId;
    if (!isId(memberId) || !isId(bookId)) return fail('INVALID_INPUT');
    if (!members.has(memberId)) return fail('NO_MEMBER');
    const book = books.get(bookId);
    if (!book) return fail('NO_BOOK');
    if (!book.loan || book.loan.memberId !== memberId) return fail('NOT_ON_LOAN');
    const late = t.day - book.loan.dueDay;
    const fine = late > 0 ? Math.min(late * FINE_PER_DAY, MAX_FINE) : 0;
    members.get(memberId).owed += fine;
    book.loan = null;
    freeBook(book, t.day);
    return { ok: true, fine };
  }

  function renew(args) {
    if (!isObject(args)) return fail('INVALID_INPUT');
    const t = startDated(args);
    if (t.reason) return fail(t.reason);
    const memberId = args.memberId;
    const bookId = args.bookId;
    if (!isId(memberId) || !isId(bookId)) return fail('INVALID_INPUT');
    if (!members.has(memberId)) return fail('NO_MEMBER');
    const book = books.get(bookId);
    if (!book) return fail('NO_BOOK');
    if (!book.loan || book.loan.memberId !== memberId) return fail('NOT_ON_LOAN');
    if (t.day > book.loan.dueDay) return fail('OVERDUE');
    if (book.loan.renewals >= MAX_RENEWALS) return fail('RENEWAL_LIMIT');
    if (book.holds.length > 0) return fail('HAS_HOLDS');
    book.loan.dueDay = t.day + LOAN_DAYS;
    book.loan.renewals += 1;
    return { ok: true, dueDate: formatDay(book.loan.dueDay) };
  }

  function payFine(args) {
    if (!isObject(args)) return fail('INVALID_INPUT');
    const t = startDated(args);
    if (t.reason) return fail(t.reason);
    const memberId = args.memberId;
    const amount = args.amount;
    if (!isId(memberId)) return fail('INVALID_INPUT');
    if (!isAmount(amount)) return fail('BAD_AMOUNT');
    const member = members.get(memberId);
    if (!member) return fail('NO_MEMBER');
    if (amount > member.owed) return fail('BAD_AMOUNT');
    member.owed -= amount;
    return { ok: true, owed: member.owed };
  }

  function getMember(args) {
    if (!isObject(args)) return fail('INVALID_INPUT');
    const t = startDated(args);
    if (t.reason) return fail(t.reason);
    const memberId = args.memberId;
    if (!isId(memberId)) return fail('INVALID_INPUT');
    const member = members.get(memberId);
    if (!member) return fail('NO_MEMBER');

    const loanRows = [];
    const holdRows = [];
    for (const [bookId, book] of books) {
      if (book.loan && book.loan.memberId === memberId) {
        loanRows.push({ seq: book.loan.seq, bookId, dueDay: book.loan.dueDay });
      }
      book.holds.forEach((h, i) => {
        if (h.memberId === memberId) {
          holdRows.push({
            seq: h.seq,
            bookId,
            position: i + 1,
            readyUntil: h.readyUntil === null ? null : h.readyUntil,
          });
        }
      });
    }
    loanRows.sort((a, b) => a.seq - b.seq);
    holdRows.sort((a, b) => a.seq - b.seq);

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

  const safe = (fn) => (args) => {
    try {
      return fn(args);
    } catch {
      return fail('INVALID_INPUT');
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
