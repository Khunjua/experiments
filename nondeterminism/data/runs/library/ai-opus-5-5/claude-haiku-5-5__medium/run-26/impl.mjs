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

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Returns the day number (days since 1970-01-01 UTC) or null if invalid.
function parseDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return null;
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

const MAX_DAY = parseDate('9999-12-31');

function isId(v) {
  return typeof v === 'string' && v.length > 0;
}

function isObj(a) {
  return typeof a === 'object' && a !== null;
}

export function createLibrary() {
  // bookId -> { loan: { memberId, due, renewals } | null, queue: [{ memberId, seq, readyUntil }] }
  const books = new Map();
  // memberId -> { loans: [bookId, ...] in borrow order, owed }
  const members = new Map();
  let current = null;
  let seqCounter = 0;

  // Processes hold expiries for every book as of day number `now`.
  function expire(now) {
    for (const book of books.values()) {
      while (
        book.loan === null &&
        book.queue.length > 0 &&
        book.queue[0].readyUntil < now
      ) {
        const expiredReady = book.queue.shift().readyUntil;
        if (book.queue.length === 0) break;
        const r = expiredReady + 1 + PICKUP_DAYS;
        if (r > MAX_DAY) {
          book.queue = [];
          break;
        }
        book.queue[0].readyUntil = r;
      }
    }
  }

  // Validates a dated call's date, advances the clock, and runs expiry.
  // Returns the day number, or null if the date is invalid or too early.
  function enter(dateStr) {
    const d = parseDate(dateStr);
    if (d === null) return null;
    if (current !== null && d < current) return null;
    current = d;
    expire(d);
    return d;
  }

  // Active holds of a member, sorted by placement order.
  function activeHoldEntries(memberId) {
    const out = [];
    for (const [bookId, book] of books) {
      book.queue.forEach((e, i) => {
        if (e.memberId === memberId) {
          const setAside = book.loan === null && i === 0;
          out.push({
            bookId,
            position: i + 1,
            readyUntil: setAside ? e.readyUntil : null,
            seq: e.seq,
          });
        }
      });
    }
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  return {
    addBook(args) {
      if (!isObj(args) || !isId(args.bookId) || books.has(args.bookId)) {
        return { ok: false };
      }
      books.set(args.bookId, { loan: null, queue: [] });
      return { ok: true };
    },

    addMember(args) {
      if (!isObj(args) || !isId(args.memberId) || members.has(args.memberId)) {
        return { ok: false };
      }
      members.set(args.memberId, { loans: [], owed: 0 });
      return { ok: true };
    },

    borrow(args) {
      if (!isObj(args) || !isId(args.memberId) || !isId(args.bookId)) {
        return { ok: false };
      }
      const d = enter(args.date);
      if (d === null) return { ok: false };
      const m = members.get(args.memberId);
      const b = books.get(args.bookId);
      if (!m || !b) return { ok: false };
      if (b.loan !== null) return { ok: false };

      let fulfils = false;
      if (b.queue.length > 0) {
        if (b.queue[0].memberId !== args.memberId) return { ok: false };
        fulfils = true;
      }
      if (m.loans.length >= MAX_LOANS) return { ok: false };
      if (m.loans.some((id) => books.get(id).loan.due < d)) return { ok: false };
      if (m.owed >= BLOCK_OWED) return { ok: false };

      const due = d + LOAN_DAYS;
      if (due > MAX_DAY) return { ok: false };

      if (fulfils) b.queue.shift();
      b.loan = { memberId: args.memberId, due, renewals: 0 };
      m.loans.push(args.bookId);
      return { ok: true, dueDate: formatDate(due) };
    },

    returnBook(args) {
      if (!isObj(args) || !isId(args.memberId) || !isId(args.bookId)) {
        return { ok: false };
      }
      const d = enter(args.date);
      if (d === null) return { ok: false };
      const m = members.get(args.memberId);
      const b = books.get(args.bookId);
      if (!m || !b) return { ok: false };
      if (b.loan === null || b.loan.memberId !== args.memberId) return { ok: false };

      const daysLate = Math.max(0, d - b.loan.due);
      const fine = Math.min(MAX_FINE, FINE_PER_DAY * Math.max(0, daysLate - GRACE_DAYS));

      let ready = null;
      if (b.queue.length > 0) {
        ready = d + PICKUP_DAYS;
        if (ready > MAX_DAY) return { ok: false };
      }

      m.owed += fine;
      m.loans.splice(m.loans.indexOf(args.bookId), 1);
      b.loan = null;
      if (b.queue.length > 0) b.queue[0].readyUntil = ready;
      return { ok: true, fine };
    },

    renew(args) {
      if (!isObj(args) || !isId(args.memberId) || !isId(args.bookId)) {
        return { ok: false };
      }
      const d = enter(args.date);
      if (d === null) return { ok: false };
      const m = members.get(args.memberId);
      const b = books.get(args.bookId);
      if (!m || !b) return { ok: false };
      if (b.loan === null || b.loan.memberId !== args.memberId) return { ok: false };
      if (b.loan.renewals >= MAX_RENEWALS) return { ok: false };
      if (d > b.loan.due) return { ok: false };
      if (b.queue.length > 0) return { ok: false };

      const due = d + RENEW_DAYS;
      if (due > MAX_DAY) return { ok: false };

      b.loan.due = due;
      b.loan.renewals += 1;
      return { ok: true, dueDate: formatDate(due) };
    },

    placeHold(args) {
      if (!isObj(args) || !isId(args.memberId) || !isId(args.bookId)) {
        return { ok: false };
      }
      const d = enter(args.date);
      if (d === null) return { ok: false };
      const m = members.get(args.memberId);
      const b = books.get(args.bookId);
      if (!m || !b) return { ok: false };
      if (b.loan === null && b.queue.length === 0) return { ok: false };
      if (b.loan !== null && b.loan.memberId === args.memberId) return { ok: false };

      const active = activeHoldEntries(args.memberId);
      if (active.length >= MAX_HOLDS) return { ok: false };
      if (active.some((h) => h.bookId === args.bookId)) return { ok: false };

      b.queue.push({ memberId: args.memberId, seq: ++seqCounter, readyUntil: null });
      return { ok: true, position: b.queue.length };
    },

    payFine(args) {
      if (!isObj(args) || !isId(args.memberId)) return { ok: false };
      if (!Number.isSafeInteger(args.amount) || args.amount <= 0) return { ok: false };
      const d = enter(args.date);
      if (d === null) return { ok: false };
      const m = members.get(args.memberId);
      if (!m) return { ok: false };
      if (args.amount > m.owed) return { ok: false };

      m.owed -= args.amount;
      return { ok: true, owed: m.owed };
    },

    getMember(args) {
      if (!isObj(args) || !isId(args.memberId)) return { ok: false };
      const d = enter(args.date);
      if (d === null) return { ok: false };
      const m = members.get(args.memberId);
      if (!m) return { ok: false };

      const loans = m.loans.map((id) => ({
        bookId: id,
        dueDate: formatDate(books.get(id).loan.due),
      }));
      const holds = activeHoldEntries(args.memberId).map((h) => ({
        bookId: h.bookId,
        position: h.position,
        readyUntil: h.readyUntil === null ? null : formatDate(h.readyUntil),
      }));
      return { ok: true, loans, owed: m.owed, holds };
    },
  };
}
