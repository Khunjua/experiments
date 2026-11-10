const DAY_MS = 86400000;
const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const RENEWAL_DAYS = 21;
const FINE_RATE = 25;
const GRACE_DAYS = 2;
const MAX_FINE = 500;
const MAX_LOANS = 5;
const BLOCK_OWED = 1000;
const MAX_HOLDS = 5;
const PICKUP_DAYS = 7;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (y < 1 || m < 1 || m > 12 || d < 1) return null;
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return Math.round(t.getTime() / DAY_MS);
}

function pad(n, width) {
  return String(n).padStart(width, '0');
}

function formatDate(n) {
  const t = new Date(n * DAY_MS);
  return pad(t.getUTCFullYear(), 4) + '-' + pad(t.getUTCMonth() + 1, 2) + '-' + pad(t.getUTCDate(), 2);
}

function isId(v) {
  return typeof v === 'string' && v.length > 0;
}

function asArgs(x) {
  return x !== null && typeof x === 'object' ? x : null;
}

function fail() {
  return { ok: false };
}

export function createLibrary() {
  const books = new Map();   // bookId -> { loanedTo, queue: [{ memberId, seq }], readyUntil }
  const members = new Map(); // memberId -> { loans: [{ bookId, dueDate, renewals }], owed }
  let today = null;          // day number of current date, or null if unset
  let seq = 0;

  function advance(d) {
    today = d;
    expire();
  }

  function expire() {
    for (const book of books.values()) {
      while (book.loanedTo === null && book.queue.length > 0 && today > book.readyUntil) {
        book.queue.shift();
        book.readyUntil = book.queue.length > 0 ? book.readyUntil + 1 + PICKUP_DAYS : null;
      }
    }
  }

  function activeHoldCount(memberId) {
    let count = 0;
    for (const book of books.values()) {
      for (const h of book.queue) {
        if (h.memberId === memberId) count++;
      }
    }
    return count;
  }

  // Validates the common (memberId, date) arguments and applies the clock rule.
  // Returns the day number or null when the call must fail without effect.
  function startDated(a) {
    if (!isId(a.memberId)) return null;
    const d = parseDate(a.date);
    if (d === null) return null;
    if (today !== null && d < today) return null;
    advance(d);
    return d;
  }

  function addBook(x) {
    const a = asArgs(x);
    if (!a || !isId(a.bookId) || books.has(a.bookId)) return fail();
    books.set(a.bookId, { loanedTo: null, queue: [], readyUntil: null });
    return { ok: true };
  }

  function addMember(x) {
    const a = asArgs(x);
    if (!a || !isId(a.memberId) || members.has(a.memberId)) return fail();
    members.set(a.memberId, { loans: [], owed: 0 });
    return { ok: true };
  }

  function borrow(x) {
    const a = asArgs(x);
    if (!a || !isId(a.bookId)) return fail();
    const d = startDated(a);
    if (d === null) return fail();
    const m = members.get(a.memberId);
    const b = books.get(a.bookId);
    if (!m || !b) return fail();
    if (b.loanedTo !== null) return fail();
    const isReady = b.queue.length > 0;
    if (isReady && b.queue[0].memberId !== a.memberId) return fail();
    if (m.loans.length >= MAX_LOANS) return fail();
    if (m.loans.some((l) => l.dueDate < d)) return fail();
    if (m.owed >= BLOCK_OWED) return fail();

    const due = d + LOAN_DAYS;
    m.loans.push({ bookId: a.bookId, dueDate: due, renewals: 0 });
    b.loanedTo = a.memberId;
    if (isReady) {
      b.queue.shift();
      b.readyUntil = null;
    }
    return { ok: true, dueDate: formatDate(due) };
  }

  function returnBook(x) {
    const a = asArgs(x);
    if (!a || !isId(a.bookId)) return fail();
    const d = startDated(a);
    if (d === null) return fail();
    const m = members.get(a.memberId);
    const b = books.get(a.bookId);
    if (!m || !b) return fail();
    if (b.loanedTo !== a.memberId) return fail();
    const idx = m.loans.findIndex((l) => l.bookId === a.bookId);
    if (idx < 0) return fail();

    const loan = m.loans[idx];
    const daysLate = Math.max(0, d - loan.dueDate);
    const fine = Math.min(MAX_FINE, FINE_RATE * Math.max(0, daysLate - GRACE_DAYS));
    m.owed += fine;
    m.loans.splice(idx, 1);

    b.loanedTo = null;
    if (b.queue.length > 0) {
      b.readyUntil = d + PICKUP_DAYS;
    } else {
      b.readyUntil = null;
    }
    return { ok: true, fine };
  }

  function renew(x) {
    const a = asArgs(x);
    if (!a || !isId(a.bookId)) return fail();
    const d = startDated(a);
    if (d === null) return fail();
    const m = members.get(a.memberId);
    const b = books.get(a.bookId);
    if (!m || !b) return fail();
    if (b.loanedTo !== a.memberId) return fail();
    const loan = m.loans.find((l) => l.bookId === a.bookId);
    if (!loan) return fail();
    if (loan.renewals >= MAX_RENEWALS) return fail();
    if (d > loan.dueDate) return fail();
    if (b.queue.length > 0) return fail();

    loan.dueDate = d + RENEWAL_DAYS;
    loan.renewals += 1;
    return { ok: true, dueDate: formatDate(loan.dueDate) };
  }

  function placeHold(x) {
    const a = asArgs(x);
    if (!a || !isId(a.bookId)) return fail();
    const d = startDated(a);
    if (d === null) return fail();
    const m = members.get(a.memberId);
    const b = books.get(a.bookId);
    if (!m || !b) return fail();
    if (b.loanedTo === null && b.queue.length === 0) return fail();
    if (b.loanedTo === a.memberId) return fail();
    if (b.queue.some((h) => h.memberId === a.memberId)) return fail();
    if (activeHoldCount(a.memberId) >= MAX_HOLDS) return fail();

    b.queue.push({ memberId: a.memberId, seq: ++seq });
    return { ok: true, position: b.queue.length };
  }

  function payFine(x) {
    const a = asArgs(x);
    if (!a || !isId(a.memberId)) return fail();
    if (!Number.isSafeInteger(a.amount) || a.amount <= 0) return fail();
    const d = parseDate(a.date);
    if (d === null) return fail();
    if (today !== null && d < today) return fail();
    advance(d);
    const m = members.get(a.memberId);
    if (!m) return fail();
    if (a.amount > m.owed) return fail();
    m.owed -= a.amount;
    return { ok: true, owed: m.owed };
  }

  function getMember(x) {
    const a = asArgs(x);
    if (!a || !isId(a.memberId)) return fail();
    const d = parseDate(a.date);
    if (d === null) return fail();
    if (today !== null && d < today) return fail();
    advance(d);
    const m = members.get(a.memberId);
    if (!m) return fail();

    const loans = m.loans.map((l) => ({ bookId: l.bookId, dueDate: formatDate(l.dueDate) }));

    const found = [];
    for (const [bookId, b] of books) {
      b.queue.forEach((h, i) => {
        if (h.memberId === a.memberId) {
          const setAside = b.loanedTo === null && i === 0;
          found.push({
            seq: h.seq,
            bookId,
            position: i + 1,
            readyUntil: setAside ? formatDate(b.readyUntil) : null,
          });
        }
      });
    }
    found.sort((p, q) => p.seq - q.seq);
    const holds = found.map(({ bookId, position, readyUntil }) => ({ bookId, position, readyUntil }));

    return { ok: true, loans, owed: m.owed, holds };
  }

  return { addBook, addMember, borrow, returnBook, renew, placeHold, payFine, getMember };
}
