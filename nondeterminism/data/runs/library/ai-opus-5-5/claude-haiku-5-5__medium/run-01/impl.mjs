const DAY_MS = 86400000;
const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
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

function validId(x) {
  return typeof x === 'string' && x.length > 0;
}

// Returns the day number (days since 1970-01-01 UTC) or null if invalid.
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

export function createLibrary() {
  // bookId -> { loan: { memberId, dueDay, renewals } | null, queue: [{ memberId }], readyUntil: number | null }
  const books = new Map();
  // memberId -> { owed, loans: [bookId] (borrow order), holds: [bookId] (placement order) }
  const members = new Map();
  let current = null;

  function expire(day) {
    for (const [bookId, book] of books) {
      while (
        book.loan === null &&
        book.queue.length > 0 &&
        book.readyUntil !== null &&
        day > book.readyUntil
      ) {
        const gone = book.queue.shift();
        const m = members.get(gone.memberId);
        const idx = m.holds.indexOf(bookId);
        if (idx >= 0) m.holds.splice(idx, 1);
        if (book.queue.length > 0) {
          book.readyUntil = book.readyUntil + 1 + PICKUP_DAYS;
        } else {
          book.readyUntil = null;
        }
      }
    }
  }

  // Validates arguments and date without changing state, then advances the clock
  // and processes expiries. Returns the day number, or null on failure.
  function enter(args, idFields) {
    if (!isObj(args)) return null;
    for (const f of idFields) {
      if (!validId(args[f])) return null;
    }
    const d = parseDate(args.date);
    if (d === null) return null;
    if (current !== null && d < current) return null;
    current = d;
    expire(d);
    return d;
  }

  function removeFrom(list, value) {
    const idx = list.indexOf(value);
    if (idx >= 0) list.splice(idx, 1);
  }

  function addBook(args) {
    if (!isObj(args) || !validId(args.bookId) || books.has(args.bookId)) {
      return { ok: false };
    }
    books.set(args.bookId, { loan: null, queue: [], readyUntil: null });
    return { ok: true };
  }

  function addMember(args) {
    if (!isObj(args) || !validId(args.memberId) || members.has(args.memberId)) {
      return { ok: false };
    }
    members.set(args.memberId, { owed: 0, loans: [], holds: [] });
    return { ok: true };
  }

  function borrow(args) {
    const d = enter(args, ['memberId', 'bookId']);
    if (d === null) return { ok: false };
    const m = members.get(args.memberId);
    const b = books.get(args.bookId);
    if (!m || !b) return { ok: false };
    if (b.loan !== null) return { ok: false };

    let fulfils = false;
    if (b.queue.length > 0) {
      // Book is set aside for the first hold.
      if (b.queue[0].memberId !== args.memberId) return { ok: false };
      fulfils = true;
    }
    if (m.loans.length >= MAX_LOANS) return { ok: false };
    for (const id of m.loans) {
      if (books.get(id).loan.dueDay < d) return { ok: false };
    }
    if (m.owed >= BLOCK_OWED) return { ok: false };

    const due = d + LOAN_DAYS;
    b.loan = { memberId: args.memberId, dueDay: due, renewals: 0 };
    m.loans.push(args.bookId);
    if (fulfils) {
      b.queue.shift();
      removeFrom(m.holds, args.bookId);
      b.readyUntil = null;
    }
    return { ok: true, dueDate: formatDate(due) };
  }

  function returnBook(args) {
    const d = enter(args, ['memberId', 'bookId']);
    if (d === null) return { ok: false };
    const m = members.get(args.memberId);
    const b = books.get(args.bookId);
    if (!m || !b) return { ok: false };
    if (b.loan === null || b.loan.memberId !== args.memberId) return { ok: false };

    const daysLate = Math.max(0, d - b.loan.dueDay);
    const fine = Math.min(MAX_FINE, FINE_PER_DAY * Math.max(0, daysLate - GRACE_DAYS));

    m.owed += fine;
    removeFrom(m.loans, args.bookId);
    b.loan = null;
    if (b.queue.length > 0) {
      b.readyUntil = d + PICKUP_DAYS;
    } else {
      b.readyUntil = null;
    }
    return { ok: true, fine };
  }

  function renew(args) {
    const d = enter(args, ['memberId', 'bookId']);
    if (d === null) return { ok: false };
    const m = members.get(args.memberId);
    const b = books.get(args.bookId);
    if (!m || !b) return { ok: false };
    if (b.loan === null || b.loan.memberId !== args.memberId) return { ok: false };
    if (b.loan.renewals >= MAX_RENEWALS) return { ok: false };
    if (d > b.loan.dueDay) return { ok: false };
    if (b.queue.length > 0) return { ok: false };

    b.loan.dueDay = d + LOAN_DAYS;
    b.loan.renewals += 1;
    return { ok: true, dueDate: formatDate(b.loan.dueDay) };
  }

  function placeHold(args) {
    const d = enter(args, ['memberId', 'bookId']);
    if (d === null) return { ok: false };
    const m = members.get(args.memberId);
    const b = books.get(args.bookId);
    if (!m || !b) return { ok: false };
    if (b.loan === null && b.queue.length === 0) return { ok: false };
    if (b.loan !== null && b.loan.memberId === args.memberId) return { ok: false };
    if (m.holds.includes(args.bookId)) return { ok: false };
    if (m.holds.length >= MAX_HOLDS) return { ok: false };

    b.queue.push({ memberId: args.memberId });
    m.holds.push(args.bookId);
    return { ok: true, position: b.queue.length };
  }

  function payFine(args) {
    if (!isObj(args) || !Number.isSafeInteger(args.amount) || args.amount <= 0) {
      return { ok: false };
    }
    const d = enter(args, ['memberId']);
    if (d === null) return { ok: false };
    const m = members.get(args.memberId);
    if (!m) return { ok: false };
    if (args.amount > m.owed) return { ok: false };

    m.owed -= args.amount;
    return { ok: true, owed: m.owed };
  }

  function getMember(args) {
    const d = enter(args, ['memberId']);
    if (d === null) return { ok: false };
    const m = members.get(args.memberId);
    if (!m) return { ok: false };

    const loans = m.loans.map((id) => ({
      bookId: id,
      dueDate: formatDate(books.get(id).loan.dueDay),
    }));
    const holds = m.holds.map((id) => {
      const b = books.get(id);
      const position = b.queue.findIndex((h) => h.memberId === args.memberId) + 1;
      const ready =
        b.loan === null && b.queue.length > 0 && b.queue[0].memberId === args.memberId;
      return {
        bookId: id,
        position,
        readyUntil: ready ? formatDate(b.readyUntil) : null,
      };
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
