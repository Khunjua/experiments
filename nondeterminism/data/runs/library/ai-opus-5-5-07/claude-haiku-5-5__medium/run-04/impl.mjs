const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 2;
const FINE_CAP = 1000;
const BLOCK_THRESHOLD = 500;
const PICKUP_DAYS = 7;
const MS_PER_DAY = 86400000;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Returns the UTC epoch day number for a valid 'YYYY-MM-DD' string, or null.
function parseDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (m < 1 || m > 12 || d < 1) return null;
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  t.setUTCHours(0, 0, 0, 0);
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) {
    return null;
  }
  return Math.round(t.getTime() / MS_PER_DAY);
}

function formatDate(n) {
  const t = new Date(n * MS_PER_DAY);
  const y = String(t.getUTCFullYear()).padStart(4, '0');
  const m = String(t.getUTCMonth() + 1).padStart(2, '0');
  const d = String(t.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function isId(x) {
  return typeof x === 'string' && x.length > 0;
}

function isAmount(x) {
  return Number.isInteger(x) && x > 0;
}

export function createLibrary() {
  const books = new Map();
  const members = new Map();
  let seq = 0;

  // Book states:
  //  status: 'available' | 'loan' | 'aside'
  //  memberId: borrower when on loan, otherwise null
  //  dueDate, renewals, loanSeq: meaningful when on loan
  //  readyUntil: epoch day, meaningful when aside
  //  hold: array of { memberId, seq } in line order; hold[0] is reserved member when aside

  function runExpiry(D) {
    for (const book of books.values()) {
      while (book.status === 'aside' && D > book.readyUntil) {
        book.hold.shift();
        if (book.hold.length > 0) {
          book.readyUntil = book.readyUntil + 1 + PICKUP_DAYS;
        } else {
          book.status = 'available';
          book.readyUntil = null;
        }
      }
    }
  }

  // Validates the date, then runs expiry. Returns null if the date is invalid.
  function dated(args) {
    const a = args !== null && typeof args === 'object' ? args : {};
    const D = parseDate(a.date);
    if (D === null) return null;
    runExpiry(D);
    return { a, D };
  }

  function hasOverdue(m, D) {
    for (const book of books.values()) {
      if (book.status === 'loan' && book.memberId === m && book.dueDate < D) {
        return true;
      }
    }
    return false;
  }

  function addBook(args) {
    const a = args !== null && typeof args === 'object' ? args : {};
    const id = a.bookId;
    if (!isId(id) || books.has(id)) return { ok: false };
    books.set(id, {
      status: 'available',
      memberId: null,
      dueDate: null,
      renewals: 0,
      loanSeq: null,
      readyUntil: null,
      hold: [],
    });
    return { ok: true };
  }

  function addMember(args) {
    const a = args !== null && typeof args === 'object' ? args : {};
    const id = a.memberId;
    if (!isId(id) || members.has(id)) return { ok: false };
    members.set(id, { owed: 0 });
    return { ok: true };
  }

  function borrow(args) {
    const FAIL = { ok: false };
    const ctx = dated(args);
    if (!ctx) return FAIL;
    const { a, D } = ctx;
    const m = a.memberId;
    const b = a.bookId;
    if (!isId(m) || !isId(b)) return FAIL;
    const mem = members.get(m);
    const book = books.get(b);
    if (!mem || !book) return FAIL;
    if (book.status === 'loan') return FAIL;
    if (book.status === 'aside' && book.hold[0].memberId !== m) return FAIL;
    if (hasOverdue(m, D)) return FAIL;
    if (mem.owed >= BLOCK_THRESHOLD) return FAIL;

    if (book.status === 'aside') book.hold.shift();
    book.status = 'loan';
    book.memberId = m;
    book.dueDate = D + LOAN_DAYS;
    book.renewals = 0;
    book.loanSeq = ++seq;
    book.readyUntil = null;
    return { ok: true, dueDate: formatDate(book.dueDate) };
  }

  function returnBook(args) {
    const FAIL = { ok: false };
    const ctx = dated(args);
    if (!ctx) return FAIL;
    const { a, D } = ctx;
    const m = a.memberId;
    const b = a.bookId;
    if (!isId(m) || !isId(b)) return FAIL;
    const mem = members.get(m);
    const book = books.get(b);
    if (!mem || !book) return FAIL;
    if (book.status !== 'loan' || book.memberId !== m) return FAIL;

    const late = D - book.dueDate;
    const chargeable = Math.max(0, late - GRACE_DAYS);
    const fine = Math.min(chargeable * FINE_PER_DAY, FINE_CAP);
    mem.owed += fine;

    book.memberId = null;
    book.dueDate = null;
    book.renewals = 0;
    book.loanSeq = null;
    if (book.hold.length > 0) {
      book.status = 'aside';
      book.readyUntil = D + PICKUP_DAYS;
    } else {
      book.status = 'available';
      book.readyUntil = null;
    }
    return { ok: true, fine };
  }

  function renew(args) {
    const FAIL = { ok: false };
    const ctx = dated(args);
    if (!ctx) return FAIL;
    const { a, D } = ctx;
    const m = a.memberId;
    const b = a.bookId;
    if (!isId(m) || !isId(b)) return FAIL;
    const mem = members.get(m);
    const book = books.get(b);
    if (!mem || !book) return FAIL;
    if (book.status !== 'loan' || book.memberId !== m) return FAIL;
    if (D > book.dueDate) return FAIL;
    if (book.renewals >= MAX_RENEWALS) return FAIL;
    if (book.hold.length > 0) return FAIL;
    if (mem.owed >= BLOCK_THRESHOLD) return FAIL;

    book.dueDate = D + LOAN_DAYS;
    book.renewals += 1;
    return { ok: true, dueDate: formatDate(book.dueDate) };
  }

  function placeHold(args) {
    const FAIL = { ok: false };
    const ctx = dated(args);
    if (!ctx) return FAIL;
    const { a, D } = ctx;
    const m = a.memberId;
    const b = a.bookId;
    if (!isId(m) || !isId(b)) return FAIL;
    const mem = members.get(m);
    const book = books.get(b);
    if (!mem || !book) return FAIL;
    if (book.status === 'available') return FAIL;
    if (book.status === 'loan' && book.memberId === m) return FAIL;
    if (book.hold.some((e) => e.memberId === m)) return FAIL;

    book.hold.push({ memberId: m, seq: ++seq });
    return { ok: true, position: book.hold.length };
  }

  function payFine(args) {
    const FAIL = { ok: false };
    const ctx = dated(args);
    if (!ctx) return FAIL;
    const { a } = ctx;
    const m = a.memberId;
    if (!isId(m) || !isAmount(a.amount)) return FAIL;
    const mem = members.get(m);
    if (!mem) return FAIL;
    if (a.amount > mem.owed) return FAIL;

    mem.owed -= a.amount;
    return { ok: true, owed: mem.owed };
  }

  function getMember(args) {
    const FAIL = { ok: false };
    const ctx = dated(args);
    if (!ctx) return FAIL;
    const { a } = ctx;
    const m = a.memberId;
    if (!isId(m)) return FAIL;
    const mem = members.get(m);
    if (!mem) return FAIL;

    const loanRows = [];
    const holdRows = [];
    for (const [bookId, book] of books) {
      if (book.status === 'loan' && book.memberId === m) {
        loanRows.push({ bookId, seq: book.loanSeq, dueDate: book.dueDate });
      }
      const idx = book.hold.findIndex((e) => e.memberId === m);
      if (idx >= 0) {
        const reserved = book.status === 'aside' && idx === 0;
        holdRows.push({
          bookId,
          seq: book.hold[idx].seq,
          position: idx + 1,
          readyUntil: reserved ? formatDate(book.readyUntil) : null,
        });
      }
    }
    loanRows.sort((x, y) => x.seq - y.seq);
    holdRows.sort((x, y) => x.seq - y.seq);

    return {
      loans: loanRows.map((r) => ({ bookId: r.bookId, dueDate: formatDate(r.dueDate) })),
      owed: mem.owed,
      holds: holdRows.map((r) => ({
        bookId: r.bookId,
        position: r.position,
        readyUntil: r.readyUntil,
      })),
    };
  }

  function guard(fn) {
    return (args) => {
      try {
        return fn(args);
      } catch {
        return { ok: false };
      }
    };
  }

  return {
    addBook: guard(addBook),
    addMember: guard(addMember),
    borrow: guard(borrow),
    returnBook: guard(returnBook),
    renew: guard(renew),
    placeHold: guard(placeHold),
    payFine: guard(payFine),
    getMember: guard(getMember),
  };
}
