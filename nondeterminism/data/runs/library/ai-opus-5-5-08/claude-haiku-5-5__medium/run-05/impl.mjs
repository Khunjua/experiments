const DAY_MS = 86400000;
const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const MAX_LOANS = 5;
const MAX_HOLDS = 5;
const DEBT_LIMIT = 1000;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 2;
const FINE_CAP = 1000;
const PICKUP_DAYS = 7;

function parseDay(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const mo = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  const t = new Date(0);
  t.setUTCFullYear(y, mo - 1, d);
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
  return Math.round(t.getTime() / DAY_MS);
}

function formatDay(n) {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

function isId(x) {
  return typeof x === 'string' && x.length > 0;
}

function isObj(x) {
  return typeof x === 'object' && x !== null;
}

function safe(fn) {
  return (args) => {
    try {
      return fn(args);
    } catch {
      return { ok: false };
    }
  };
}

export function createLibrary() {
  const books = new Map();
  const members = new Map();

  // Remove memberId's hold from book's queue and from member's holdOrder.
  function removeHold(book, memberId) {
    const i = book.queue.indexOf(memberId);
    if (i >= 0) book.queue.splice(i, 1);
    const m = members.get(memberId);
    if (m) m.holdOrder = m.holdOrder.filter((id) => id !== book.id);
  }

  // Hold expiration (section 3.5) for all books, up to `today`.
  function expire(today) {
    for (const book of books.values()) {
      while (
        book.loanedTo === null &&
        book.queue.length > 0 &&
        book.readyUntil !== null &&
        today > book.readyUntil
      ) {
        removeHold(book, book.queue[0]);
        if (book.queue.length > 0) {
          book.readyUntil = book.readyUntil + 1 + PICKUP_DAYS;
        } else {
          book.readyUntil = null;
        }
      }
    }
  }

  // Returns the parsed day after running expiration, or null if the
  // argument is not an object or the date is invalid.
  function begin(args) {
    if (!isObj(args)) return null;
    const day = parseDay(args.date);
    if (day === null) return null;
    expire(day);
    return day;
  }

  function loansOf(memberId) {
    const out = [];
    for (const b of books.values()) {
      if (b.loanedTo === memberId) out.push(b);
    }
    return out;
  }

  function addBook(args) {
    if (!isObj(args) || !isId(args.bookId)) return { ok: false };
    if (books.has(args.bookId)) return { ok: false };
    books.set(args.bookId, {
      id: args.bookId,
      loanedTo: null,
      dueDay: null,
      renewals: 0,
      queue: [],
      readyUntil: null,
    });
    return { ok: true };
  }

  function addMember(args) {
    if (!isObj(args) || !isId(args.memberId)) return { ok: false };
    if (members.has(args.memberId)) return { ok: false };
    members.set(args.memberId, { owed: 0, holdOrder: [] });
    return { ok: true };
  }

  function borrow(args) {
    const day = begin(args);
    if (day === null) return { ok: false };
    const { memberId, bookId } = args;
    if (!isId(memberId) || !isId(bookId)) return { ok: false };
    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b) return { ok: false };
    if (b.loanedTo !== null) return { ok: false };
    if (b.queue.length > 0 && b.queue[0] !== memberId) return { ok: false };
    if (b.queue.length > 0 && b.readyUntil === null) return { ok: false };
    const loans = loansOf(memberId);
    if (loans.length >= MAX_LOANS) return { ok: false };
    if (m.owed >= DEBT_LIMIT) return { ok: false };
    if (loans.some((l) => l.dueDay < day)) return { ok: false };

    if (b.queue.length > 0) {
      removeHold(b, memberId);
      b.readyUntil = null;
    }
    b.loanedTo = memberId;
    b.dueDay = day + LOAN_DAYS;
    b.renewals = 0;
    return { ok: true, dueDate: formatDay(b.dueDay) };
  }

  function returnBook(args) {
    const day = begin(args);
    if (day === null) return { ok: false };
    const { memberId, bookId } = args;
    if (!isId(memberId) || !isId(bookId)) return { ok: false };
    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b) return { ok: false };
    if (b.loanedTo !== memberId) return { ok: false };

    const daysLate = Math.max(0, day - b.dueDay);
    const chargeable = Math.max(0, daysLate - GRACE_DAYS);
    const fine = Math.min(chargeable * FINE_PER_DAY, FINE_CAP);

    m.owed += fine;
    b.loanedTo = null;
    b.dueDay = null;
    b.renewals = 0;
    if (b.queue.length > 0) {
      b.readyUntil = day + PICKUP_DAYS;
    } else {
      b.readyUntil = null;
    }
    return { ok: true, fine };
  }

  function renew(args) {
    const day = begin(args);
    if (day === null) return { ok: false };
    const { memberId, bookId } = args;
    if (!isId(memberId) || !isId(bookId)) return { ok: false };
    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b) return { ok: false };
    if (b.loanedTo !== memberId) return { ok: false };
    if (b.renewals >= MAX_RENEWALS) return { ok: false };
    if (day > b.dueDay) return { ok: false };
    if (b.queue.length > 0) return { ok: false };

    b.dueDay += LOAN_DAYS;
    b.renewals += 1;
    return { ok: true, dueDate: formatDay(b.dueDay) };
  }

  function placeHold(args) {
    const day = begin(args);
    if (day === null) return { ok: false };
    const { memberId, bookId } = args;
    if (!isId(memberId) || !isId(bookId)) return { ok: false };
    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b) return { ok: false };
    if (b.loanedTo === null && b.queue.length === 0) return { ok: false };
    if (b.loanedTo === memberId) return { ok: false };
    if (b.queue.includes(memberId)) return { ok: false };
    if (m.holdOrder.length >= MAX_HOLDS) return { ok: false };

    b.queue.push(memberId);
    m.holdOrder.push(bookId);
    return { ok: true, position: b.queue.length };
  }

  function payFine(args) {
    const day = begin(args);
    if (day === null) return { ok: false };
    const { memberId, amount } = args;
    if (!isId(memberId)) return { ok: false };
    const m = members.get(memberId);
    if (!m) return { ok: false };
    if (!Number.isSafeInteger(amount) || amount < 1) return { ok: false };
    if (amount > m.owed) return { ok: false };

    m.owed -= amount;
    return { ok: true, owed: m.owed };
  }

  function getMember(args) {
    const day = begin(args);
    if (day === null) return { ok: false };
    const { memberId } = args;
    if (!isId(memberId)) return { ok: false };
    const m = members.get(memberId);
    if (!m) return { ok: false };

    const loans = loansOf(memberId)
      .sort((a, b) => {
        if (a.dueDay !== b.dueDay) return a.dueDay - b.dueDay;
        if (a.id < b.id) return -1;
        if (a.id > b.id) return 1;
        return 0;
      })
      .map((b) => ({ bookId: b.id, dueDate: formatDay(b.dueDay) }));

    const holds = m.holdOrder.map((bid) => {
      const b = books.get(bid);
      const position = b.queue.indexOf(memberId) + 1;
      const readyUntil =
        b.loanedTo === null && b.queue[0] === memberId && b.readyUntil !== null
          ? formatDay(b.readyUntil)
          : null;
      return { bookId: bid, position, readyUntil };
    });

    return { ok: true, loans, owed: m.owed, holds };
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
