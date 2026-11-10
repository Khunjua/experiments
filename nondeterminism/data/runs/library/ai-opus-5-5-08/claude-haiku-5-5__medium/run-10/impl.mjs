const DAY_MS = 86400000;
const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const RENEWAL_DAYS = 21;
const GRACE_DAYS = 2;
const FINE_PER_DAY = 25;
const FINE_CAP = 1000;
const MAX_LOANS = 5;
const DEBT_LIMIT = 1000;
const MAX_HOLDS = 5;
const PICKUP_DAYS = 7;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Returns the day number (days since 1970-01-01 UTC) or null if invalid.
function parseDay(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) return null;
  const y = Number(value.slice(0, 4));
  const m = Number(value.slice(5, 7));
  const d = Number(value.slice(8, 10));
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) {
    return null;
  }
  return Math.round(t.getTime() / DAY_MS);
}

function formatDay(n) {
  const t = new Date(n * DAY_MS);
  const y = String(t.getUTCFullYear()).padStart(4, '0');
  const m = String(t.getUTCMonth() + 1).padStart(2, '0');
  const d = String(t.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function validId(x) {
  return typeof x === 'string' && x.length > 0;
}

function readFields(args, keys) {
  try {
    if (args === null || typeof args !== 'object') return null;
    const out = {};
    for (const k of keys) out[k] = args[k];
    return out;
  } catch {
    return null;
  }
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

export function createLibrary() {
  // bookId -> { id, loan: null | loan, queue: [memberId], readyDay: number | null }
  // loan   -> { bookId, memberId, dueDay, renewals }
  // A book with loan === null and a non-empty queue is set aside for queue[0].
  const books = new Map();
  // memberId -> { id, loans: Map(bookId -> loan), holds: [bookId in placement order], owed }
  const members = new Map();

  function findMember(id) {
    return validId(id) ? members.get(id) : undefined;
  }

  function findBook(id) {
    return validId(id) ? books.get(id) : undefined;
  }

  // Time processing (section 3.5).
  function expire(now) {
    for (const book of books.values()) {
      while (book.loan === null && book.queue.length > 0 && now > book.readyDay) {
        const memberId = book.queue.shift();
        const member = members.get(memberId);
        if (member) {
          member.holds = member.holds.filter((id) => id !== book.id);
        }
        if (book.queue.length > 0) {
          book.readyDay = book.readyDay + 1 + PICKUP_DAYS;
        } else {
          book.readyDay = null;
        }
      }
    }
  }

  // Validates the argument object and the date, then runs expiration.
  // Returns null (no processing) if the argument is not an object or the date is invalid.
  function dated(args, keys) {
    const f = readFields(args, keys);
    if (f === null) return null;
    const day = parseDay(f.date);
    if (day === null) return null;
    expire(day);
    return { f, day };
  }

  function addBook(args) {
    const f = readFields(args, ['bookId']);
    if (f === null || !validId(f.bookId) || books.has(f.bookId)) return { ok: false };
    books.set(f.bookId, { id: f.bookId, loan: null, queue: [], readyDay: null });
    return { ok: true };
  }

  function addMember(args) {
    const f = readFields(args, ['memberId']);
    if (f === null || !validId(f.memberId) || members.has(f.memberId)) return { ok: false };
    members.set(f.memberId, { id: f.memberId, loans: new Map(), holds: [], owed: 0 });
    return { ok: true };
  }

  function borrow(args) {
    const p = dated(args, ['memberId', 'bookId', 'date']);
    if (p === null) return { ok: false };
    const { memberId, bookId } = p.f;
    const now = p.day;

    const member = findMember(memberId);
    const book = findBook(bookId);
    if (!member || !book) return { ok: false };

    // On loan (including to this member): reject.
    if (book.loan !== null) return { ok: false };
    // Set aside for someone else: reject. (Shelf with non-empty queue is impossible.)
    if (book.queue.length > 0 && book.queue[0] !== memberId) return { ok: false };
    if (member.loans.size >= MAX_LOANS) return { ok: false };
    if (member.owed >= DEBT_LIMIT) return { ok: false };
    for (const loan of member.loans.values()) {
      if (loan.dueDay < now) return { ok: false };
    }

    // All checks passed: mutate.
    if (book.queue.length > 0) {
      book.queue.shift();
      member.holds = member.holds.filter((id) => id !== bookId);
      book.readyDay = null;
    }
    const loan = { bookId, memberId, dueDay: now + LOAN_DAYS, renewals: 0 };
    book.loan = loan;
    member.loans.set(bookId, loan);
    return { ok: true, dueDate: formatDay(loan.dueDay) };
  }

  function returnBook(args) {
    const p = dated(args, ['memberId', 'bookId', 'date']);
    if (p === null) return { ok: false };
    const { memberId, bookId } = p.f;
    const now = p.day;

    const member = findMember(memberId);
    const book = findBook(bookId);
    if (!member || !book) return { ok: false };
    const loan = member.loans.get(bookId);
    if (!loan || book.loan !== loan) return { ok: false };

    const daysLate = Math.max(0, now - loan.dueDay);
    const chargeable = Math.max(0, daysLate - GRACE_DAYS);
    const fine = Math.min(chargeable * FINE_PER_DAY, FINE_CAP);

    member.loans.delete(bookId);
    member.owed += fine;
    book.loan = null;
    if (book.queue.length > 0) {
      book.readyDay = now + PICKUP_DAYS;
    } else {
      book.readyDay = null;
    }
    return { ok: true, fine };
  }

  function renew(args) {
    const p = dated(args, ['memberId', 'bookId', 'date']);
    if (p === null) return { ok: false };
    const { memberId, bookId } = p.f;
    const now = p.day;

    const member = findMember(memberId);
    const book = findBook(bookId);
    if (!member || !book) return { ok: false };
    const loan = member.loans.get(bookId);
    if (!loan || book.loan !== loan) return { ok: false };
    if (loan.renewals >= MAX_RENEWALS) return { ok: false };
    if (now > loan.dueDay) return { ok: false };
    if (book.queue.length > 0) return { ok: false };

    loan.dueDay += RENEWAL_DAYS;
    loan.renewals += 1;
    return { ok: true, dueDate: formatDay(loan.dueDay) };
  }

  function placeHold(args) {
    const p = dated(args, ['memberId', 'bookId', 'date']);
    if (p === null) return { ok: false };
    const { memberId, bookId } = p.f;

    const member = findMember(memberId);
    const book = findBook(bookId);
    if (!member || !book) return { ok: false };
    // On the shelf: reject.
    if (book.loan === null && book.queue.length === 0) return { ok: false };
    if (member.loans.has(bookId)) return { ok: false };
    if (book.queue.includes(memberId)) return { ok: false };
    if (member.holds.length >= MAX_HOLDS) return { ok: false };

    book.queue.push(memberId);
    member.holds.push(bookId);
    return { ok: true, position: book.queue.length };
  }

  function payFine(args) {
    const p = dated(args, ['memberId', 'amount', 'date']);
    if (p === null) return { ok: false };
    const { memberId, amount } = p.f;

    const member = findMember(memberId);
    if (!member) return { ok: false };
    if (!Number.isSafeInteger(amount) || amount < 1) return { ok: false };
    if (amount > member.owed) return { ok: false };

    member.owed -= amount;
    return { ok: true, owed: member.owed };
  }

  function getMember(args) {
    const p = dated(args, ['memberId', 'date']);
    if (p === null) return { ok: false };
    const { memberId } = p.f;

    const member = findMember(memberId);
    if (!member) return { ok: false };

    const loans = [...member.loans.values()]
      .map((loan) => ({ bookId: loan.bookId, dueDate: formatDay(loan.dueDay) }))
      .sort((a, b) => {
        if (a.dueDate < b.dueDate) return -1;
        if (a.dueDate > b.dueDate) return 1;
        if (a.bookId < b.bookId) return -1;
        if (a.bookId > b.bookId) return 1;
        return 0;
      });

    const holds = member.holds.map((bookId) => {
      const book = books.get(bookId);
      const position = book.queue.indexOf(memberId) + 1;
      const setAside = position === 1 && book.loan === null;
      return {
        bookId,
        position,
        readyUntil: setAside ? formatDay(book.readyDay) : null,
      };
    });

    return { ok: true, loans, owed: member.owed, holds };
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
