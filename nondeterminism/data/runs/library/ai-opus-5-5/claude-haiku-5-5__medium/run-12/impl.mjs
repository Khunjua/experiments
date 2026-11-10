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
const DAY_MS = 86400000;

// Returns the day number (days since 1970-01-01, UTC) or null if invalid.
function parseDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (y < 1 || y > 9999 || m < 1 || m > 12 || d < 1) return null;
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return Math.round(t.getTime() / DAY_MS);
}

function formatDate(n) {
  const t = new Date(n * DAY_MS);
  const y = String(t.getUTCFullYear()).padStart(4, '0');
  const m = String(t.getUTCMonth() + 1).padStart(2, '0');
  const d = String(t.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function validId(v) {
  return typeof v === 'string' && v.length > 0;
}

function isObj(v) {
  return v !== null && typeof v === 'object';
}

export function createLibrary() {
  // bookId -> { state: 'available' | 'loan' | 'setAside', holder, readyUntil, queue: [{memberId, seq}] }
  const books = new Map();
  // memberId -> { owed, loans: Map(bookId -> { dueDay, renewals }) }
  const members = new Map();
  let now = null;
  let seqCounter = 0;

  function expire(day) {
    for (const book of books.values()) {
      while (book.state === 'setAside' && day > book.readyUntil) {
        book.queue.shift();
        if (book.queue.length > 0) {
          book.readyUntil = book.readyUntil + 1 + PICKUP_DAYS;
        } else {
          book.state = 'available';
          book.readyUntil = null;
        }
      }
    }
  }

  // Validates the date, enforces the clock, and processes expiries.
  // Returns the day number, or null if the date is invalid or in the past (no change).
  function advance(dateStr) {
    const day = parseDate(dateStr);
    if (day === null) return null;
    if (now !== null && day < now) return null;
    now = day;
    expire(day);
    return day;
  }

  const fail = () => ({ ok: false });

  return {
    addBook(a) {
      if (!isObj(a) || !validId(a.bookId)) return fail();
      if (books.has(a.bookId)) return fail();
      books.set(a.bookId, { state: 'available', holder: null, readyUntil: null, queue: [] });
      return { ok: true };
    },

    addMember(a) {
      if (!isObj(a) || !validId(a.memberId)) return fail();
      if (members.has(a.memberId)) return fail();
      members.set(a.memberId, { owed: 0, loans: new Map() });
      return { ok: true };
    },

    borrow(a) {
      if (!isObj(a) || !validId(a.memberId) || !validId(a.bookId)) return fail();
      const day = advance(a.date);
      if (day === null) return fail();
      const m = members.get(a.memberId);
      const b = books.get(a.bookId);
      if (!m || !b) return fail();
      if (b.state === 'loan') return fail();
      if (b.state === 'setAside' && b.queue[0].memberId !== a.memberId) return fail();
      if (m.loans.size >= MAX_LOANS) return fail();
      for (const l of m.loans.values()) {
        if (l.dueDay < day) return fail();
      }
      if (m.owed >= BLOCK_OWED) return fail();

      const dueDay = day + LOAN_DAYS;
      m.loans.set(a.bookId, { dueDay, renewals: 0 });
      if (b.state === 'setAside') {
        b.queue.shift();
      }
      b.state = 'loan';
      b.holder = a.memberId;
      b.readyUntil = null;
      return { ok: true, dueDate: formatDate(dueDay) };
    },

    returnBook(a) {
      if (!isObj(a) || !validId(a.memberId) || !validId(a.bookId)) return fail();
      const day = advance(a.date);
      if (day === null) return fail();
      const m = members.get(a.memberId);
      const b = books.get(a.bookId);
      if (!m || !b) return fail();
      if (b.state !== 'loan' || b.holder !== a.memberId) return fail();
      const loan = m.loans.get(a.bookId);
      if (!loan) return fail();

      const late = Math.max(0, day - loan.dueDay);
      const fine = Math.min(MAX_FINE, FINE_PER_DAY * Math.max(0, late - GRACE_DAYS));
      m.owed += fine;
      m.loans.delete(a.bookId);

      b.holder = null;
      if (b.queue.length === 0) {
        b.state = 'available';
        b.readyUntil = null;
      } else {
        b.state = 'setAside';
        b.readyUntil = day + PICKUP_DAYS;
      }
      return { ok: true, fine };
    },

    renew(a) {
      if (!isObj(a) || !validId(a.memberId) || !validId(a.bookId)) return fail();
      const day = advance(a.date);
      if (day === null) return fail();
      const m = members.get(a.memberId);
      const b = books.get(a.bookId);
      if (!m || !b) return fail();
      if (b.state !== 'loan' || b.holder !== a.memberId) return fail();
      const loan = m.loans.get(a.bookId);
      if (!loan) return fail();
      if (loan.renewals >= MAX_RENEWALS) return fail();
      if (day > loan.dueDay) return fail();
      if (b.queue.length > 0) return fail();

      loan.dueDay = day + RENEW_DAYS;
      loan.renewals += 1;
      return { ok: true, dueDate: formatDate(loan.dueDay) };
    },

    placeHold(a) {
      if (!isObj(a) || !validId(a.memberId) || !validId(a.bookId)) return fail();
      const day = advance(a.date);
      if (day === null) return fail();
      const m = members.get(a.memberId);
      const b = books.get(a.bookId);
      if (!m || !b) return fail();
      if (b.state === 'available') return fail();
      if (b.state === 'loan' && b.holder === a.memberId) return fail();
      if (b.queue.some((h) => h.memberId === a.memberId)) return fail();

      let active = 0;
      for (const bk of books.values()) {
        for (const h of bk.queue) {
          if (h.memberId === a.memberId) active++;
        }
      }
      if (active >= MAX_HOLDS) return fail();

      b.queue.push({ memberId: a.memberId, seq: seqCounter++ });
      return { ok: true, position: b.queue.length };
    },

    payFine(a) {
      if (!isObj(a) || !validId(a.memberId)) return fail();
      if (!Number.isSafeInteger(a.amount) || a.amount <= 0) return fail();
      const day = advance(a.date);
      if (day === null) return fail();
      const m = members.get(a.memberId);
      if (!m) return fail();
      if (a.amount > m.owed) return fail();
      m.owed -= a.amount;
      return { ok: true, owed: m.owed };
    },

    getMember(a) {
      if (!isObj(a) || !validId(a.memberId)) return fail();
      const day = advance(a.date);
      if (day === null) return fail();
      const m = members.get(a.memberId);
      if (!m) return fail();

      const loans = [];
      for (const [bookId, l] of m.loans) {
        loans.push({ bookId, dueDate: formatDate(l.dueDay) });
      }

      const holdsRaw = [];
      for (const [bookId, b] of books) {
        b.queue.forEach((h, i) => {
          if (h.memberId === a.memberId) {
            holdsRaw.push({
              seq: h.seq,
              bookId,
              position: i + 1,
              readyUntil: i === 0 && b.state === 'setAside' ? formatDate(b.readyUntil) : null,
            });
          }
        });
      }
      holdsRaw.sort((x, y) => x.seq - y.seq);
      const holds = holdsRaw.map(({ bookId, position, readyUntil }) => ({ bookId, position, readyUntil }));

      return { ok: true, loans, owed: m.owed, holds };
    },
  };
}
