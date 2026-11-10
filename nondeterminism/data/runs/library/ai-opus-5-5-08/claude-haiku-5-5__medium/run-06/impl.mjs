const DAY_MS = 86400000;
const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 2;
const FINE_CAP = 1000;
const MAX_LOANS = 5;
const DEBT_BLOCK = 1000;
const MAX_HOLDS = 5;
const PICKUP_DAYS = 7;

function isObj(x) {
  return x !== null && typeof x === 'object';
}

function validId(x) {
  return typeof x === 'string' && x.length > 0;
}

// Returns the day number (days since 1970-01-01 UTC), or null if invalid.
function parseDate(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
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

function formatDay(n) {
  const t = new Date(n * DAY_MS);
  const y = String(t.getUTCFullYear()).padStart(4, '0');
  const mo = String(t.getUTCMonth() + 1).padStart(2, '0');
  const d = String(t.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${d}`;
}

export function createLibrary() {
  // bookId -> { queue: [memberId], loan: { memberId, dueDay, renewals } | null, readyUntil: dayNum | null }
  const books = new Map();
  // memberId -> { loanIds: Set<bookId>, owed: number, holds: [bookId in placement order] }
  const members = new Map();

  function removeHold(member, bookId) {
    const i = member.holds.indexOf(bookId);
    if (i >= 0) member.holds.splice(i, 1);
  }

  function expire(day) {
    for (const [bookId, book] of books) {
      while (book.readyUntil !== null && day > book.readyUntil) {
        const memberId = book.queue.shift();
        const member = members.get(memberId);
        if (member) removeHold(member, bookId);
        if (book.queue.length > 0) {
          book.readyUntil = book.readyUntil + 1 + PICKUP_DAYS;
        } else {
          book.readyUntil = null;
        }
      }
    }
  }

  // Validates the argument object and date, then runs time processing.
  // Returns the day number, or null if the call must fail without processing.
  function begin(args) {
    if (!isObj(args)) return null;
    const day = parseDate(args.date);
    if (day === null) return null;
    expire(day);
    return day;
  }

  function addBook(args) {
    if (!isObj(args) || !validId(args.bookId) || books.has(args.bookId)) {
      return { ok: false };
    }
    books.set(args.bookId, { queue: [], loan: null, readyUntil: null });
    return { ok: true };
  }

  function addMember(args) {
    if (!isObj(args) || !validId(args.memberId) || members.has(args.memberId)) {
      return { ok: false };
    }
    members.set(args.memberId, { loanIds: new Set(), owed: 0, holds: [] });
    return { ok: true };
  }

  function borrow(args) {
    const day = begin(args);
    if (day === null) return { ok: false };
    const memberId = args.memberId;
    const bookId = args.bookId;
    if (!validId(memberId) || !validId(bookId)) return { ok: false };
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book) return { ok: false };

    // On loan (including to this member).
    if (book.loan !== null) return { ok: false };
    // Set aside for someone else, or defensive: shelf with non-empty queue.
    if (book.queue.length > 0) {
      if (book.readyUntil === null || book.queue[0] !== memberId) return { ok: false };
    }
    if (member.loanIds.size >= MAX_LOANS) return { ok: false };
    if (member.owed >= DEBT_BLOCK) return { ok: false };
    for (const id of member.loanIds) {
      const other = books.get(id);
      if (other && other.loan && other.loan.dueDay < day) return { ok: false };
    }

    const dueDay = day + LOAN_DAYS;
    book.loan = { memberId, dueDay, renewals: 0 };
    member.loanIds.add(bookId);
    if (book.queue.length > 0) {
      // Book was set aside for this member: consume the hold.
      book.queue.shift();
      removeHold(member, bookId);
      book.readyUntil = null;
    }
    return { ok: true, dueDate: formatDay(dueDay) };
  }

  function returnBook(args) {
    const day = begin(args);
    if (day === null) return { ok: false };
    const memberId = args.memberId;
    const bookId = args.bookId;
    if (!validId(memberId) || !validId(bookId)) return { ok: false };
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book) return { ok: false };
    if (!book.loan || book.loan.memberId !== memberId) return { ok: false };

    const late = Math.max(0, day - book.loan.dueDay);
    const chargeable = Math.max(0, late - GRACE_DAYS);
    const fine = Math.min(chargeable * FINE_PER_DAY, FINE_CAP);

    member.owed += fine;
    member.loanIds.delete(bookId);
    book.loan = null;
    if (book.queue.length > 0) {
      book.readyUntil = day + PICKUP_DAYS;
    } else {
      book.readyUntil = null;
    }
    return { ok: true, fine };
  }

  function renew(args) {
    const day = begin(args);
    if (day === null) return { ok: false };
    const memberId = args.memberId;
    const bookId = args.bookId;
    if (!validId(memberId) || !validId(bookId)) return { ok: false };
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book) return { ok: false };
    if (!book.loan || book.loan.memberId !== memberId) return { ok: false };
    if (book.loan.renewals >= MAX_RENEWALS) return { ok: false };
    if (day > book.loan.dueDay) return { ok: false };
    if (book.queue.length > 0) return { ok: false };

    book.loan.dueDay += LOAN_DAYS;
    book.loan.renewals += 1;
    return { ok: true, dueDate: formatDay(book.loan.dueDay) };
  }

  function placeHold(args) {
    const day = begin(args);
    if (day === null) return { ok: false };
    const memberId = args.memberId;
    const bookId = args.bookId;
    if (!validId(memberId) || !validId(bookId)) return { ok: false };
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book) return { ok: false };
    // Book is on the shelf.
    if (book.loan === null && book.queue.length === 0) return { ok: false };
    // Member currently has this book on loan.
    if (book.loan && book.loan.memberId === memberId) return { ok: false };
    // Member already holds this book (including set aside for them).
    if (member.holds.includes(bookId)) return { ok: false };
    if (member.holds.length >= MAX_HOLDS) return { ok: false };

    book.queue.push(memberId);
    member.holds.push(bookId);
    return { ok: true, position: book.queue.length };
  }

  function payFine(args) {
    const day = begin(args);
    if (day === null) return { ok: false };
    const memberId = args.memberId;
    const amount = args.amount;
    if (!validId(memberId)) return { ok: false };
    const member = members.get(memberId);
    if (!member) return { ok: false };
    if (!Number.isSafeInteger(amount) || amount < 1) return { ok: false };
    if (amount > member.owed) return { ok: false };

    member.owed -= amount;
    return { ok: true, owed: member.owed };
  }

  function getMember(args) {
    const day = begin(args);
    if (day === null) return { ok: false };
    const memberId = args.memberId;
    if (!validId(memberId)) return { ok: false };
    const member = members.get(memberId);
    if (!member) return { ok: false };

    const loans = [];
    for (const bookId of member.loanIds) {
      const book = books.get(bookId);
      if (book && book.loan) {
        loans.push({ bookId, dueDate: formatDay(book.loan.dueDay) });
      }
    }
    loans.sort((a, b) => {
      if (a.dueDate < b.dueDate) return -1;
      if (a.dueDate > b.dueDate) return 1;
      if (a.bookId < b.bookId) return -1;
      if (a.bookId > b.bookId) return 1;
      return 0;
    });

    const holds = member.holds.map((bookId) => {
      const book = books.get(bookId);
      const position = book.queue.indexOf(memberId) + 1;
      const readyUntil =
        position === 1 && book.readyUntil !== null ? formatDay(book.readyUntil) : null;
      return { bookId, position, readyUntil };
    });

    return { ok: true, loans, owed: member.owed, holds };
  }

  const safe = (fn) => (args) => {
    try {
      return fn(args);
    } catch {
      return { ok: false };
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
