const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 2;
const MAX_FINE = 500;
const MAX_LOANS = 5;
const BLOCK_OWED = 1000;
const MAX_HOLDS = 5;
const PICKUP_DAYS = 7;
const MS_PER_DAY = 86400000;

function isObj(v) {
  return v !== null && typeof v === 'object';
}

function validId(v) {
  return typeof v === 'string' && v.length > 0;
}

// Returns whole days since 1970-01-01 (UTC), or null if not a valid date.
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
  return Math.round(t.getTime() / MS_PER_DAY);
}

function formatDate(n) {
  const t = new Date(n * MS_PER_DAY);
  const y = String(t.getUTCFullYear()).padStart(4, '0');
  const m = String(t.getUTCMonth() + 1).padStart(2, '0');
  const d = String(t.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function createLibrary() {
  const books = new Map();   // bookId -> { loan, ready, readyUntil, queue: [{memberId, seq}] }
  const members = new Map(); // memberId -> { loans: [loan], owed }
  let current = null;
  let holdSeq = 0;

  const fail = () => ({ ok: false });

  function expire(d) {
    for (const b of books.values()) {
      while (b.ready && d > b.readyUntil) {
        b.queue.shift();
        if (b.queue.length > 0) {
          b.readyUntil = b.readyUntil + 1 + PICKUP_DAYS;
        } else {
          b.ready = false;
          b.readyUntil = null;
        }
      }
    }
  }

  function advance(d) {
    if (current !== null && d < current) return false;
    current = d;
    expire(d);
    return true;
  }

  // Validates identifiers and date, advances the clock. Returns day number or null.
  function start(args, idKeys) {
    if (!isObj(args)) return null;
    for (const k of idKeys) {
      if (!validId(args[k])) return null;
    }
    const d = parseDate(args.date);
    if (d === null) return null;
    if (!advance(d)) return null;
    return d;
  }

  function activeHoldCount(memberId) {
    let n = 0;
    for (const b of books.values()) {
      for (const e of b.queue) {
        if (e.memberId === memberId) n++;
      }
    }
    return n;
  }

  return {
    addBook(args) {
      if (!isObj(args) || !validId(args.bookId) || books.has(args.bookId)) return fail();
      books.set(args.bookId, { loan: null, ready: false, readyUntil: null, queue: [] });
      return { ok: true };
    },

    addMember(args) {
      if (!isObj(args) || !validId(args.memberId) || members.has(args.memberId)) return fail();
      members.set(args.memberId, { loans: [], owed: 0 });
      return { ok: true };
    },

    borrow(args) {
      const d = start(args, ['memberId', 'bookId']);
      if (d === null) return fail();
      const m = members.get(args.memberId);
      const b = books.get(args.bookId);
      if (!m || !b) return fail();
      if (b.loan) return fail();
      if (b.ready && b.queue[0].memberId !== args.memberId) return fail();
      if (m.loans.length >= MAX_LOANS) return fail();
      if (m.loans.some((l) => l.dueDate < d)) return fail();
      if (m.owed >= BLOCK_OWED) return fail();

      const loan = { memberId: args.memberId, bookId: args.bookId, dueDate: d + LOAN_DAYS, renewals: 0 };
      m.loans.push(loan);
      b.loan = loan;
      if (b.ready) {
        b.queue.shift();
        b.ready = false;
        b.readyUntil = null;
      }
      return { ok: true, dueDate: formatDate(loan.dueDate) };
    },

    returnBook(args) {
      const d = start(args, ['memberId', 'bookId']);
      if (d === null) return fail();
      const m = members.get(args.memberId);
      const b = books.get(args.bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== args.memberId) return fail();

      const loan = b.loan;
      const late = Math.max(0, d - loan.dueDate);
      const fine = Math.min(MAX_FINE, FINE_PER_DAY * Math.max(0, late - GRACE_DAYS));
      m.owed += fine;
      m.loans.splice(m.loans.indexOf(loan), 1);
      b.loan = null;
      if (b.queue.length === 0) {
        b.ready = false;
        b.readyUntil = null;
      } else {
        b.ready = true;
        b.readyUntil = d + PICKUP_DAYS;
      }
      return { ok: true, fine };
    },

    renew(args) {
      const d = start(args, ['memberId', 'bookId']);
      if (d === null) return fail();
      const m = members.get(args.memberId);
      const b = books.get(args.bookId);
      if (!m || !b || !b.loan || b.loan.memberId !== args.memberId) return fail();

      const loan = b.loan;
      if (loan.renewals >= MAX_RENEWALS) return fail();
      if (d > loan.dueDate) return fail();
      if (b.queue.length > 0) return fail();

      loan.dueDate = d + LOAN_DAYS;
      loan.renewals += 1;
      return { ok: true, dueDate: formatDate(loan.dueDate) };
    },

    placeHold(args) {
      const d = start(args, ['memberId', 'bookId']);
      if (d === null) return fail();
      const m = members.get(args.memberId);
      const b = books.get(args.bookId);
      if (!m || !b) return fail();
      if (!b.loan && !b.ready) return fail();
      if (b.loan && b.loan.memberId === args.memberId) return fail();
      if (b.queue.some((e) => e.memberId === args.memberId)) return fail();
      if (activeHoldCount(args.memberId) >= MAX_HOLDS) return fail();

      b.queue.push({ memberId: args.memberId, seq: ++holdSeq });
      return { ok: true, position: b.queue.length };
    },

    payFine(args) {
      if (!isObj(args) || !Number.isSafeInteger(args.amount) || args.amount <= 0) return fail();
      const d = start(args, ['memberId']);
      if (d === null) return fail();
      const m = members.get(args.memberId);
      if (!m) return fail();
      if (args.amount > m.owed) return fail();
      m.owed -= args.amount;
      return { ok: true, owed: m.owed };
    },

    getMember(args) {
      const d = start(args, ['memberId']);
      if (d === null) return fail();
      const m = members.get(args.memberId);
      if (!m) return fail();

      const found = [];
      for (const [bookId, b] of books) {
        b.queue.forEach((e, i) => {
          if (e.memberId === args.memberId) {
            found.push({
              seq: e.seq,
              bookId,
              position: i + 1,
              readyUntil: b.ready && i === 0 ? formatDate(b.readyUntil) : null,
            });
          }
        });
      }
      found.sort((x, y) => x.seq - y.seq);

      return {
        ok: true,
        loans: m.loans.map((l) => ({ bookId: l.bookId, dueDate: formatDate(l.dueDate) })),
        owed: m.owed,
        holds: found.map(({ bookId, position, readyUntil }) => ({ bookId, position, readyUntil })),
      };
    },
  };
}
