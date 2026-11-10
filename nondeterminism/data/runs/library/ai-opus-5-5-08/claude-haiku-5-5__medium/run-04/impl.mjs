const DAY_MS = 86400000;
const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const RENEWAL_DAYS = 21;
const FEE_PER_DAY = 25;
const GRACE_DAYS = 2;
const FINE_CAP = 1000;
const MAX_LOANS = 5;
const DEBT_BLOCK = 1000;
const MAX_HOLDS = 5;
const PICKUP_DAYS = 7;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const FAIL = Object.freeze({ ok: false });

function isObject(v) {
  return typeof v === 'object' && v !== null;
}

function isId(v) {
  return typeof v === 'string' && v.length > 0;
}

function isAmount(v) {
  return Number.isSafeInteger(v) && v >= 1;
}

// Returns integer day number (days since 1970-01-01 UTC), or null if invalid.
function parseDay(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (m < 1 || m > 12 || d < 1) return null;
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

function safe(fn) {
  return (arg) => {
    try {
      return fn(arg);
    } catch {
      return { ok: false };
    }
  };
}

export function createLibrary() {
  // bookId -> { loan: null | { memberId, dueDate (day), renewals }, queue: [memberId], readyUntil: day | null }
  const books = new Map();
  // memberId -> { loans: Set<bookId>, owed: cents, holds: [bookId] in placement order }
  const members = new Map();

  // Lazy hold expiration for all books up to `day`.
  function expire(day) {
    for (const [bookId, book] of books) {
      if (book.loan !== null) continue;
      while (book.queue.length > 0 && day > book.readyUntil) {
        const memberId = book.queue.shift();
        const member = members.get(memberId);
        member.holds = member.holds.filter((id) => id !== bookId);
        if (book.queue.length > 0) {
          // new start day = previous readyUntil + 1; readyUntil = start + 7
          book.readyUntil = book.readyUntil + PICKUP_DAYS + 1;
        } else {
          book.readyUntil = null;
        }
      }
    }
  }

  function addBook(arg) {
    if (!isObject(arg)) return { ok: false };
    const { bookId } = arg;
    if (!isId(bookId)) return { ok: false };
    if (books.has(bookId)) return { ok: false };
    books.set(bookId, { loan: null, queue: [], readyUntil: null });
    return { ok: true };
  }

  function addMember(arg) {
    if (!isObject(arg)) return { ok: false };
    const { memberId } = arg;
    if (!isId(memberId)) return { ok: false };
    if (members.has(memberId)) return { ok: false };
    members.set(memberId, { loans: new Set(), owed: 0, holds: [] });
    return { ok: true };
  }

  function borrow(arg) {
    if (!isObject(arg)) return { ok: false };
    const { memberId, bookId, date } = arg;
    const day = parseDay(date);
    if (day === null) return { ok: false };
    expire(day);

    if (!isId(memberId) || !isId(bookId)) return { ok: false };
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book) return { ok: false };

    if (book.loan !== null) return { ok: false };
    if (book.queue.length > 0 && book.queue[0] !== memberId) return { ok: false };
    if (member.loans.size >= MAX_LOANS) return { ok: false };
    if (member.owed >= DEBT_BLOCK) return { ok: false };
    for (const id of member.loans) {
      if (books.get(id).loan.dueDate < day) return { ok: false };
    }

    // Success
    if (book.queue.length > 0) {
      book.queue.shift();
      member.holds = member.holds.filter((id) => id !== bookId);
    }
    book.readyUntil = null;
    const dueDay = day + LOAN_DAYS;
    book.loan = { memberId, dueDate: dueDay, renewals: 0 };
    member.loans.add(bookId);
    return { ok: true, dueDate: formatDay(dueDay) };
  }

  function returnBook(arg) {
    if (!isObject(arg)) return { ok: false };
    const { memberId, bookId, date } = arg;
    const day = parseDay(date);
    if (day === null) return { ok: false };
    expire(day);

    if (!isId(memberId) || !isId(bookId)) return { ok: false };
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book) return { ok: false };
    if (book.loan === null || book.loan.memberId !== memberId) return { ok: false };

    const daysLate = Math.max(0, day - book.loan.dueDate);
    const chargeable = Math.max(0, daysLate - GRACE_DAYS);
    const fine = Math.min(chargeable * FEE_PER_DAY, FINE_CAP);

    // Success
    member.owed += fine;
    member.loans.delete(bookId);
    book.loan = null;
    if (book.queue.length > 0) {
      book.readyUntil = day + PICKUP_DAYS;
    } else {
      book.readyUntil = null;
    }
    return { ok: true, fine };
  }

  function renew(arg) {
    if (!isObject(arg)) return { ok: false };
    const { memberId, bookId, date } = arg;
    const day = parseDay(date);
    if (day === null) return { ok: false };
    expire(day);

    if (!isId(memberId) || !isId(bookId)) return { ok: false };
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book) return { ok: false };
    if (book.loan === null || book.loan.memberId !== memberId) return { ok: false };
    if (book.loan.renewals >= MAX_RENEWALS) return { ok: false };
    if (day > book.loan.dueDate) return { ok: false };
    if (book.queue.length > 0) return { ok: false };

    // Success
    book.loan.dueDate += RENEWAL_DAYS;
    book.loan.renewals += 1;
    return { ok: true, dueDate: formatDay(book.loan.dueDate) };
  }

  function placeHold(arg) {
    if (!isObject(arg)) return { ok: false };
    const { memberId, bookId, date } = arg;
    const day = parseDay(date);
    if (day === null) return { ok: false };
    expire(day);

    if (!isId(memberId) || !isId(bookId)) return { ok: false };
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book) return { ok: false };

    const onShelf = book.loan === null && book.queue.length === 0;
    if (onShelf) return { ok: false };
    if (book.loan !== null && book.loan.memberId === memberId) return { ok: false };
    if (member.holds.includes(bookId)) return { ok: false };
    if (member.holds.length >= MAX_HOLDS) return { ok: false };

    // Success
    book.queue.push(memberId);
    member.holds.push(bookId);
    return { ok: true, position: book.queue.length };
  }

  function payFine(arg) {
    if (!isObject(arg)) return { ok: false };
    const { memberId, amount, date } = arg;
    const day = parseDay(date);
    if (day === null) return { ok: false };
    expire(day);

    if (!isId(memberId)) return { ok: false };
    const member = members.get(memberId);
    if (!member) return { ok: false };
    if (!isAmount(amount)) return { ok: false };
    if (amount > member.owed) return { ok: false };

    // Success
    member.owed -= amount;
    return { ok: true, owed: member.owed };
  }

  function getMember(arg) {
    if (!isObject(arg)) return { ok: false };
    const { memberId, date } = arg;
    const day = parseDay(date);
    if (day === null) return { ok: false };
    expire(day);

    if (!isId(memberId)) return { ok: false };
    const member = members.get(memberId);
    if (!member) return { ok: false };

    const sortedLoans = [...member.loans].map((bookId) => ({
      bookId,
      due: books.get(bookId).loan.dueDate,
    }));
    sortedLoans.sort((a, b) => {
      if (a.due !== b.due) return a.due - b.due;
      if (a.bookId < b.bookId) return -1;
      if (a.bookId > b.bookId) return 1;
      return 0;
    });
    const loans = sortedLoans.map((l) => ({
      bookId: l.bookId,
      dueDate: formatDay(l.due),
    }));

    const holds = member.holds.map((bookId) => {
      const book = books.get(bookId);
      const position = book.queue.indexOf(memberId) + 1;
      const setAside = position === 1 && book.loan === null;
      return {
        bookId,
        position,
        readyUntil: setAside ? formatDay(book.readyUntil) : null,
      };
    });

    return { ok: true, loans, owed: member.owed, holds };
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
