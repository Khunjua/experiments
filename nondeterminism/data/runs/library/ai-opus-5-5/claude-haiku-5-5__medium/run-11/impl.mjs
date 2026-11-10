const DAY_MS = 86400000;
const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const RENEW_DAYS = 21;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 2;
const MAX_FINE = 500;
const MAX_LOANS = 5;
const BLOCK_OWED = 1000;
const MAX_HOLDS = 5;
const PICKUP_DAYS = 7;

function isObj(x) {
  return typeof x === 'object' && x !== null;
}

function isId(x) {
  return typeof x === 'string' && x.length > 0;
}

// Returns the day number (days since 1970-01-01 UTC) or null if invalid.
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

function formatDate(n) {
  const t = new Date(n * DAY_MS);
  const y = String(t.getUTCFullYear()).padStart(4, '0');
  const m = String(t.getUTCMonth() + 1).padStart(2, '0');
  const d = String(t.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function createLibrary() {
  const books = new Map();   // bookId -> { id, loan, queue, readyUntil }
  const members = new Map(); // memberId -> { id, loans, owed }
  let today = null;          // current date as day number, or null if unset
  let holdSeq = 0;

  function fail() {
    return { ok: false };
  }

  // Processes hold expiries for all books as of day d.
  function expire(d) {
    for (const book of books.values()) {
      if (book.loan !== null) continue;
      while (book.queue.length > 0 && d > book.readyUntil) {
        book.queue.shift();
        if (book.queue.length > 0) {
          book.readyUntil = book.readyUntil + 1 + PICKUP_DAYS;
        } else {
          book.readyUntil = null;
        }
      }
    }
  }

  // Applies the clock rule for a validated dated call.
  function advance(d) {
    if (today !== null && d < today) return false;
    today = d;
    expire(d);
    return true;
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

  function addBook(arg) {
    if (!isObj(arg) || !isId(arg.bookId) || books.has(arg.bookId)) return fail();
    books.set(arg.bookId, { id: arg.bookId, loan: null, queue: [], readyUntil: null });
    return { ok: true };
  }

  function addMember(arg) {
    if (!isObj(arg) || !isId(arg.memberId) || members.has(arg.memberId)) return fail();
    members.set(arg.memberId, { id: arg.memberId, loans: [], owed: 0 });
    return { ok: true };
  }

  function borrow(arg) {
    if (!isObj(arg)) return fail();
    const memberId = arg.memberId;
    const bookId = arg.bookId;
    const d = parseDate(arg.date);
    if (!isId(memberId) || !isId(bookId) || d === null) return fail();
    if (!advance(d)) return fail();

    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b) return fail();
    if (b.loan !== null) return fail();
    if (b.queue.length > 0 && b.queue[0].memberId !== memberId) return fail();
    if (m.loans.length >= MAX_LOANS) return fail();
    for (const id of m.loans) {
      if (books.get(id).loan.dueDay < d) return fail();
    }
    if (m.owed >= BLOCK_OWED) return fail();

    if (b.queue.length > 0) {
      b.queue.shift();
    }
    b.readyUntil = null;
    b.loan = { memberId, dueDay: d + LOAN_DAYS, renewals: 0 };
    m.loans.push(bookId);
    return { ok: true, dueDate: formatDate(b.loan.dueDay) };
  }

  function returnBook(arg) {
    if (!isObj(arg)) return fail();
    const memberId = arg.memberId;
    const bookId = arg.bookId;
    const d = parseDate(arg.date);
    if (!isId(memberId) || !isId(bookId) || d === null) return fail();
    if (!advance(d)) return fail();

    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b) return fail();
    if (b.loan === null || b.loan.memberId !== memberId) return fail();

    const daysLate = Math.max(0, d - b.loan.dueDay);
    const fine = Math.min(MAX_FINE, FINE_PER_DAY * Math.max(0, daysLate - GRACE_DAYS));
    m.owed += fine;
    m.loans.splice(m.loans.indexOf(bookId), 1);
    b.loan = null;
    if (b.queue.length > 0) {
      b.readyUntil = d + PICKUP_DAYS;
    } else {
      b.readyUntil = null;
    }
    return { ok: true, fine };
  }

  function renew(arg) {
    if (!isObj(arg)) return fail();
    const memberId = arg.memberId;
    const bookId = arg.bookId;
    const d = parseDate(arg.date);
    if (!isId(memberId) || !isId(bookId) || d === null) return fail();
    if (!advance(d)) return fail();

    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b) return fail();
    if (b.loan === null || b.loan.memberId !== memberId) return fail();
    if (b.loan.renewals >= MAX_RENEWALS) return fail();
    if (d > b.loan.dueDay) return fail();
    if (b.queue.length > 0) return fail();

    b.loan.dueDay = d + RENEW_DAYS;
    b.loan.renewals += 1;
    return { ok: true, dueDate: formatDate(b.loan.dueDay) };
  }

  function placeHold(arg) {
    if (!isObj(arg)) return fail();
    const memberId = arg.memberId;
    const bookId = arg.bookId;
    const d = parseDate(arg.date);
    if (!isId(memberId) || !isId(bookId) || d === null) return fail();
    if (!advance(d)) return fail();

    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b) return fail();
    if (b.loan === null && b.queue.length === 0) return fail();
    if (b.loan !== null && b.loan.memberId === memberId) return fail();
    if (b.queue.some((h) => h.memberId === memberId)) return fail();
    if (activeHoldCount(memberId) >= MAX_HOLDS) return fail();

    b.queue.push({ memberId, seq: ++holdSeq });
    return { ok: true, position: b.queue.length };
  }

  function payFine(arg) {
    if (!isObj(arg)) return fail();
    const memberId = arg.memberId;
    const amount = arg.amount;
    const d = parseDate(arg.date);
    if (!isId(memberId) || d === null) return fail();
    if (!Number.isSafeInteger(amount) || amount <= 0) return fail();
    if (!advance(d)) return fail();

    const m = members.get(memberId);
    if (!m) return fail();
    if (amount > m.owed) return fail();

    m.owed -= amount;
    return { ok: true, owed: m.owed };
  }

  function getMember(arg) {
    if (!isObj(arg)) return fail();
    const memberId = arg.memberId;
    const d = parseDate(arg.date);
    if (!isId(memberId) || d === null) return fail();
    if (!advance(d)) return fail();

    const m = members.get(memberId);
    if (!m) return fail();

    const loans = m.loans.map((id) => ({
      bookId: id,
      dueDate: formatDate(books.get(id).loan.dueDay),
    }));

    const found = [];
    for (const b of books.values()) {
      b.queue.forEach((h, i) => {
        if (h.memberId !== memberId) return;
        found.push({
          seq: h.seq,
          bookId: b.id,
          position: i + 1,
          readyUntil: b.loan === null && i === 0 ? formatDate(b.readyUntil) : null,
        });
      });
    }
    found.sort((x, y) => x.seq - y.seq);
    const holds = found.map((h) => ({
      bookId: h.bookId,
      position: h.position,
      readyUntil: h.readyUntil,
    }));

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
