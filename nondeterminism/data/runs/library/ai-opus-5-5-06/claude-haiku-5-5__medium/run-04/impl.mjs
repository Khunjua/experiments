const DAY_MS = 86400000;
const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const MAX_FINE = 500;
const PICKUP_DAYS = 7;

function parseDate(v) {
  if (typeof v !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (m === null) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
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

function isAmount(v) {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 1;
}

function asObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : null;
}

export function createLibrary() {
  const books = new Map();   // bookId -> book
  const members = new Map(); // memberId -> { owed }
  let clock = null;          // day number of latest date seen
  let counter = 0;           // shared sequence for loans and holds

  const fail = (reason) => ({ ok: false, reason });

  function freeBook(book, day) {
    book.loan = null;
    if (book.line.length > 0) {
      book.state = 'aside';
      book.asideUntil = day + PICKUP_DAYS;
    } else {
      book.state = 'available';
      book.asideUntil = null;
    }
  }

  // Applies every hold expiration due up to and including `day`.
  function advance(day) {
    for (const book of books.values()) {
      while (book.state === 'aside' && book.asideUntil < day) {
        const free = book.asideUntil + 1;
        book.line.shift();
        freeBook(book, free);
      }
    }
  }

  // Handles the date of a dated call. Returns { day, error }.
  function enter(a) {
    const day = parseDate(a.date);
    if (day === null) return { day: null, error: fail('INVALID_INPUT') };
    if (clock !== null && day < clock) {
      return { day: null, error: fail('DATE_OUT_OF_ORDER') };
    }
    clock = day;
    advance(day);
    return { day, error: null };
  }

  function addBook(args) {
    const a = asObject(args);
    if (a === null || !isId(a.bookId)) return fail('INVALID_INPUT');
    if (books.has(a.bookId)) return fail('DUPLICATE');
    books.set(a.bookId, {
      state: 'available', // 'available' | 'loan' | 'aside'
      loan: null,         // { bookId, memberId, dueDay, renewals, seq }
      line: [],           // holds: { memberId, seq }, oldest first
      asideUntil: null,   // day number, only when state is 'aside'
    });
    return { ok: true };
  }

  function addMember(args) {
    const a = asObject(args);
    if (a === null || !isId(a.memberId)) return fail('INVALID_INPUT');
    if (members.has(a.memberId)) return fail('DUPLICATE');
    members.set(a.memberId, { owed: 0 });
    return { ok: true };
  }

  function borrow(args) {
    const a = asObject(args);
    if (a === null) return fail('INVALID_INPUT');
    const t = enter(a);
    if (t.error) return t.error;
    const day = t.day;
    const memberId = a.memberId;
    const bookId = a.bookId;
    if (!isId(memberId) || !isId(bookId)) return fail('INVALID_INPUT');
    if (!members.has(memberId)) return fail('NO_MEMBER');
    const b = books.get(bookId);
    if (b === undefined) return fail('NO_BOOK');
    if (b.state === 'loan') return fail('NOT_ON_LOAN');
    if (b.state === 'aside' && b.line[0].memberId !== memberId) {
      return fail('NOT_AVAILABLE');
    }
    if (b.state === 'aside') b.line.shift();
    const dueDay = day + LOAN_DAYS;
    b.state = 'loan';
    b.asideUntil = null;
    b.loan = { bookId, memberId, dueDay, renewals: 0, seq: ++counter };
    return { ok: true, dueDate: formatDate(dueDay) };
  }

  function returnBook(args) {
    const a = asObject(args);
    if (a === null) return fail('INVALID_INPUT');
    const t = enter(a);
    if (t.error) return t.error;
    const day = t.day;
    const memberId = a.memberId;
    const bookId = a.bookId;
    if (!isId(memberId) || !isId(bookId)) return fail('INVALID_INPUT');
    const m = members.get(memberId);
    if (m === undefined) return fail('NO_MEMBER');
    const b = books.get(bookId);
    if (b === undefined) return fail('NO_BOOK');
    if (b.loan === null || b.loan.memberId !== memberId) return fail('NOT_ON_LOAN');
    const late = Math.max(0, day - b.loan.dueDay);
    const fine = Math.min(FINE_PER_DAY * late, MAX_FINE);
    m.owed += fine;
    freeBook(b, day);
    return { ok: true, fine };
  }

  function renew(args) {
    const a = asObject(args);
    if (a === null) return fail('INVALID_INPUT');
    const t = enter(a);
    if (t.error) return t.error;
    const day = t.day;
    const memberId = a.memberId;
    const bookId = a.bookId;
    if (!isId(memberId) || !isId(bookId)) return fail('INVALID_INPUT');
    if (!members.has(memberId)) return fail('NO_MEMBER');
    const b = books.get(bookId);
    if (b === undefined) return fail('NO_BOOK');
    if (b.loan === null || b.loan.memberId !== memberId) return fail('NOT_ON_LOAN');
    if (day > b.loan.dueDay) return fail('OVERDUE');
    if (b.loan.renewals >= MAX_RENEWALS) return fail('RENEWAL_LIMIT');
    if (b.line.length > 0) return fail('HAS_HOLDS');
    b.loan.dueDay = day + LOAN_DAYS;
    b.loan.renewals += 1;
    return { ok: true, dueDate: formatDate(b.loan.dueDay) };
  }

  function placeHold(args) {
    const a = asObject(args);
    if (a === null) return fail('INVALID_INPUT');
    const t = enter(a);
    if (t.error) return t.error;
    const memberId = a.memberId;
    const bookId = a.bookId;
    if (!isId(memberId) || !isId(bookId)) return fail('INVALID_INPUT');
    if (!members.has(memberId)) return fail('NO_MEMBER');
    const b = books.get(bookId);
    if (b === undefined) return fail('NO_BOOK');
    if (b.state === 'available') return fail('BOOK_AVAILABLE');
    if (b.loan !== null && b.loan.memberId === memberId) return fail('ALREADY_BORROWED');
    if (b.line.some((h) => h.memberId === memberId)) return fail('ALREADY_HOLDING');
    b.line.push({ memberId, seq: ++counter });
    return { ok: true, position: b.line.length };
  }

  function payFine(args) {
    const a = asObject(args);
    if (a === null) return fail('INVALID_INPUT');
    const t = enter(a);
    if (t.error) return t.error;
    const memberId = a.memberId;
    if (!isId(memberId)) return fail('INVALID_INPUT');
    if (!isAmount(a.amount)) return fail('BAD_AMOUNT');
    const m = members.get(memberId);
    if (m === undefined) return fail('NO_MEMBER');
    if (a.amount > m.owed) return fail('BAD_AMOUNT');
    m.owed -= a.amount;
    return { ok: true, owed: m.owed };
  }

  function getMember(args) {
    const a = asObject(args);
    if (a === null) return fail('INVALID_INPUT');
    const t = enter(a);
    if (t.error) return t.error;
    const memberId = a.memberId;
    if (!isId(memberId)) return fail('INVALID_INPUT');
    const m = members.get(memberId);
    if (m === undefined) return fail('NO_MEMBER');

    const loans = [];
    const holds = [];
    for (const [bookId, b] of books) {
      if (b.loan !== null && b.loan.memberId === memberId) {
        loans.push({ seq: b.loan.seq, bookId, dueDate: formatDate(b.loan.dueDay) });
      }
      const idx = b.line.findIndex((h) => h.memberId === memberId);
      if (idx >= 0) {
        const setAside = idx === 0 && b.state === 'aside';
        holds.push({
          seq: b.line[idx].seq,
          bookId,
          position: idx + 1,
          readyUntil: setAside ? formatDate(b.asideUntil) : null,
        });
      }
    }
    loans.sort((x, y) => x.seq - y.seq);
    holds.sort((x, y) => x.seq - y.seq);

    return {
      loans: loans.map((l) => ({ bookId: l.bookId, dueDate: l.dueDate })),
      owed: m.owed,
      holds: holds.map((h) => ({
        bookId: h.bookId,
        position: h.position,
        readyUntil: h.readyUntil,
      })),
    };
  }

  // Safety net: no method may throw for any input.
  const safe = (fn) => (args) => {
    try {
      return fn(args);
    } catch {
      return { ok: false, reason: 'INVALID_INPUT' };
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
