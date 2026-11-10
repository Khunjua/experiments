const DAY_MS = 86400000;
const LOAN_DAYS = 21;
const RENEWAL_LIMIT = 2;
const RENEWAL_DAYS = 21;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 2;
const MAX_FINE = 500;
const MAX_LOANS = 5;
const BLOCK_OWED = 1000;
const MAX_HOLDS = 5;
const PICKUP_DAYS = 7;

// Returns the day number (days since 1970-01-01 UTC) for a valid 'YYYY-MM-DD'
// string, or null if the value is not a valid date in years 0001..9999.
function parseDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (y < 1) return null;
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) {
    return null;
  }
  return Math.round(t.getTime() / DAY_MS);
}

const MIN_DAY = parseDate('0001-01-01');
const MAX_DAY = parseDate('9999-12-31');

function formatDate(n) {
  const t = new Date(n * DAY_MS);
  const y = String(t.getUTCFullYear()).padStart(4, '0');
  const m = String(t.getUTCMonth() + 1).padStart(2, '0');
  const d = String(t.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Dates saturate at 9999-12-31 so every result stays a valid date string.
function clampDay(n) {
  return Math.min(n, MAX_DAY);
}

function isObj(v) {
  return v !== null && typeof v === 'object';
}

function isId(v) {
  return typeof v === 'string' && v.length > 0;
}

function fail() {
  return { ok: false };
}

export function createLibrary() {
  // bookId -> { loanedTo, readyUntil, queue }
  //   loanedTo:   memberId currently holding the book, or null
  //   readyUntil: day number the set-aside book can be picked up through, or null
  //   queue:      memberIds of holds in order; queue[0] is the ready hold when set aside
  const books = new Map();
  // memberId -> { loans: [{ bookId, dueDay, renewals }], holds: [{ bookId }], owed }
  const members = new Map();
  let today = null;

  function expire() {
    for (const [bookId, book] of books) {
      while (book.readyUntil !== null && today > book.readyUntil) {
        const holderId = book.queue.shift();
        const holder = members.get(holderId);
        const idx = holder.holds.findIndex((h) => h.bookId === bookId);
        if (idx !== -1) holder.holds.splice(idx, 1);
        if (book.queue.length > 0) {
          book.readyUntil = clampDay(book.readyUntil + 1 + PICKUP_DAYS);
        } else {
          book.readyUntil = null;
        }
      }
    }
  }

  // Applies the clock rule. Returns false if the date is earlier than the current date.
  function advance(day) {
    if (today !== null && day < today) return false;
    today = day;
    expire();
    return true;
  }

  function addBook(args) {
    if (!isObj(args)) return fail();
    const bookId = args.bookId;
    if (!isId(bookId) || books.has(bookId)) return fail();
    books.set(bookId, { loanedTo: null, readyUntil: null, queue: [] });
    return { ok: true };
  }

  function addMember(args) {
    if (!isObj(args)) return fail();
    const memberId = args.memberId;
    if (!isId(memberId) || members.has(memberId)) return fail();
    members.set(memberId, { loans: [], holds: [], owed: 0 });
    return { ok: true };
  }

  function borrow(args) {
    if (!isObj(args)) return fail();
    const memberId = args.memberId;
    const bookId = args.bookId;
    const day = parseDate(args.date);
    if (!isId(memberId) || !isId(bookId) || day === null) return fail();
    if (!advance(day)) return fail();

    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b) return fail();
    if (b.loanedTo !== null) return fail();
    if (b.readyUntil !== null && b.queue[0] !== memberId) return fail();
    if (m.loans.length >= MAX_LOANS) return fail();
    if (m.loans.some((l) => l.dueDay < day)) return fail();
    if (m.owed >= BLOCK_OWED) return fail();

    if (b.readyUntil !== null) {
      // Set aside for this member: fulfil that hold.
      b.queue.shift();
      const idx = m.holds.findIndex((h) => h.bookId === bookId);
      if (idx !== -1) m.holds.splice(idx, 1);
      b.readyUntil = null;
    }

    const dueDay = clampDay(day + LOAN_DAYS);
    b.loanedTo = memberId;
    m.loans.push({ bookId, dueDay, renewals: 0 });
    return { ok: true, dueDate: formatDate(dueDay) };
  }

  function returnBook(args) {
    if (!isObj(args)) return fail();
    const memberId = args.memberId;
    const bookId = args.bookId;
    const day = parseDate(args.date);
    if (!isId(memberId) || !isId(bookId) || day === null) return fail();
    if (!advance(day)) return fail();

    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b) return fail();
    if (b.loanedTo !== memberId) return fail();

    const idx = m.loans.findIndex((l) => l.bookId === bookId);
    if (idx === -1) return fail();
    const loan = m.loans[idx];

    const daysLate = Math.max(0, day - loan.dueDay);
    const fine = Math.min(MAX_FINE, FINE_PER_DAY * Math.max(0, daysLate - GRACE_DAYS));
    m.owed += fine;
    m.loans.splice(idx, 1);

    b.loanedTo = null;
    if (b.queue.length > 0) {
      b.readyUntil = clampDay(day + PICKUP_DAYS);
    }
    return { ok: true, fine };
  }

  function renew(args) {
    if (!isObj(args)) return fail();
    const memberId = args.memberId;
    const bookId = args.bookId;
    const day = parseDate(args.date);
    if (!isId(memberId) || !isId(bookId) || day === null) return fail();
    if (!advance(day)) return fail();

    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b) return fail();
    if (b.loanedTo !== memberId) return fail();

    const loan = m.loans.find((l) => l.bookId === bookId);
    if (!loan) return fail();
    if (loan.renewals >= RENEWAL_LIMIT) return fail();
    if (day > loan.dueDay) return fail();
    if (b.queue.length > 0) return fail();

    loan.dueDay = clampDay(day + RENEWAL_DAYS);
    loan.renewals += 1;
    return { ok: true, dueDate: formatDate(loan.dueDay) };
  }

  function placeHold(args) {
    if (!isObj(args)) return fail();
    const memberId = args.memberId;
    const bookId = args.bookId;
    const day = parseDate(args.date);
    if (!isId(memberId) || !isId(bookId) || day === null) return fail();
    if (!advance(day)) return fail();

    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b) return fail();
    if (b.loanedTo === null && b.queue.length === 0) return fail();
    if (b.loanedTo === memberId) return fail();
    if (m.holds.some((h) => h.bookId === bookId)) return fail();
    if (m.holds.length >= MAX_HOLDS) return fail();

    b.queue.push(memberId);
    m.holds.push({ bookId });
    return { ok: true, position: b.queue.length };
  }

  function payFine(args) {
    if (!isObj(args)) return fail();
    const memberId = args.memberId;
    const amount = args.amount;
    const day = parseDate(args.date);
    if (!isId(memberId) || !Number.isSafeInteger(amount) || amount <= 0 || day === null) {
      return fail();
    }
    if (!advance(day)) return fail();

    const m = members.get(memberId);
    if (!m) return fail();
    if (amount > m.owed) return fail();

    m.owed -= amount;
    return { ok: true, owed: m.owed };
  }

  function getMember(args) {
    if (!isObj(args)) return fail();
    const memberId = args.memberId;
    const day = parseDate(args.date);
    if (!isId(memberId) || day === null) return fail();
    if (!advance(day)) return fail();

    const m = members.get(memberId);
    if (!m) return fail();

    const loans = m.loans.map((l) => ({
      bookId: l.bookId,
      dueDate: formatDate(l.dueDay),
    }));

    const holds = m.holds.map((h) => {
      const b = books.get(h.bookId);
      const position = b.queue.indexOf(memberId) + 1;
      const readyUntil =
        b.loanedTo === null && b.readyUntil !== null && b.queue[0] === memberId
          ? formatDate(b.readyUntil)
          : null;
      return { bookId: h.bookId, position, readyUntil };
    });

    return { ok: true, loans, owed: m.owed, holds };
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
