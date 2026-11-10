const DAY_MS = 86400000;
const LOAN_DAYS = 21;
const RENEW_LIMIT = 2;
const GRACE_DAYS = 2;
const FEE_PER_DAY = 25;
const FINE_CAP = 1000;
const MAX_LOANS = 5;
const DEBT_BLOCK = 1000;
const MAX_HOLDS = 5;
const PICKUP_DAYS = 7;

function isObj(x) {
  return x !== null && typeof x === 'object';
}

function isId(x) {
  return typeof x === 'string' && x.length > 0;
}

// Returns the day number (days since 1970-01-01 UTC) or null if invalid.
function parseDay(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return Math.round(t.getTime() / DAY_MS);
}

function fmt(n) {
  const t = new Date(n * DAY_MS);
  return String(t.getUTCFullYear()).padStart(4, '0') + '-' +
    String(t.getUTCMonth() + 1).padStart(2, '0') + '-' +
    String(t.getUTCDate()).padStart(2, '0');
}

function cmpStr(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function removeHold(member, bookId) {
  const i = member.holds.indexOf(bookId);
  if (i !== -1) member.holds.splice(i, 1);
}

function guard(fn) {
  return function (...args) {
    try {
      return fn(...args);
    } catch {
      return { ok: false };
    }
  };
}

export function createLibrary() {
  // bookId -> { id, state: 'shelf'|'loan'|'setaside', holder, queue: [memberId], readyUntil: dayNumber|null }
  const books = new Map();
  // memberId -> { loans: Map(bookId -> { dueDay, renewals }), owed, holds: [bookId in placement order] }
  const members = new Map();

  // Lazy hold expiration, processed for all books up to `day`.
  function expire(day) {
    for (const b of books.values()) {
      while (b.state === 'setaside' && day > b.readyUntil) {
        const dropped = b.queue.shift();
        const m = members.get(dropped);
        if (m) removeHold(m, b.id);
        if (b.queue.length > 0) {
          // start = previous readyUntil + 1; readyUntil = start + PICKUP_DAYS
          b.readyUntil = b.readyUntil + 1 + PICKUP_DAYS;
        } else {
          b.state = 'shelf';
          b.holder = null;
          b.readyUntil = null;
        }
      }
    }
  }

  const addBook = guard(function (args) {
    if (!isObj(args)) return { ok: false };
    const id = args.bookId;
    if (!isId(id) || books.has(id)) return { ok: false };
    books.set(id, { id, state: 'shelf', holder: null, queue: [], readyUntil: null });
    return { ok: true };
  });

  const addMember = guard(function (args) {
    if (!isObj(args)) return { ok: false };
    const id = args.memberId;
    if (!isId(id) || members.has(id)) return { ok: false };
    members.set(id, { loans: new Map(), owed: 0, holds: [] });
    return { ok: true };
  });

  const borrow = guard(function (args) {
    if (!isObj(args)) return { ok: false };
    const day = parseDay(args.date);
    if (day === null) return { ok: false };
    expire(day);
    const memberId = args.memberId;
    const bookId = args.bookId;
    if (!isId(memberId) || !isId(bookId)) return { ok: false };
    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b) return { ok: false };
    if (b.state === 'loan') return { ok: false };
    if (b.state === 'setaside' && b.queue[0] !== memberId) return { ok: false };
    if (b.state === 'shelf' && b.queue.length > 0) return { ok: false };
    if (m.loans.size >= MAX_LOANS) return { ok: false };
    if (m.owed >= DEBT_BLOCK) return { ok: false };
    for (const loan of m.loans.values()) {
      if (loan.dueDay < day) return { ok: false };
    }

    if (b.state === 'setaside') {
      b.queue.shift();
      removeHold(m, bookId);
    }
    b.state = 'loan';
    b.holder = memberId;
    b.readyUntil = null;
    m.loans.set(bookId, { dueDay: day + LOAN_DAYS, renewals: 0 });
    return { ok: true, dueDate: fmt(day + LOAN_DAYS) };
  });

  const returnBook = guard(function (args) {
    if (!isObj(args)) return { ok: false };
    const day = parseDay(args.date);
    if (day === null) return { ok: false };
    expire(day);
    const memberId = args.memberId;
    const bookId = args.bookId;
    if (!isId(memberId) || !isId(bookId)) return { ok: false };
    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b) return { ok: false };
    const loan = m.loans.get(bookId);
    if (!loan || b.state !== 'loan' || b.holder !== memberId) return { ok: false };

    const daysLate = Math.max(0, day - loan.dueDay);
    const chargeable = Math.max(0, daysLate - GRACE_DAYS);
    const fine = Math.min(chargeable * FEE_PER_DAY, FINE_CAP);

    m.owed += fine;
    m.loans.delete(bookId);

    if (b.queue.length > 0) {
      b.state = 'setaside';
      b.holder = null;
      b.readyUntil = day + PICKUP_DAYS;
    } else {
      b.state = 'shelf';
      b.holder = null;
      b.readyUntil = null;
    }
    return { ok: true, fine };
  });

  const renew = guard(function (args) {
    if (!isObj(args)) return { ok: false };
    const day = parseDay(args.date);
    if (day === null) return { ok: false };
    expire(day);
    const memberId = args.memberId;
    const bookId = args.bookId;
    if (!isId(memberId) || !isId(bookId)) return { ok: false };
    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b) return { ok: false };
    const loan = m.loans.get(bookId);
    if (!loan || b.state !== 'loan' || b.holder !== memberId) return { ok: false };
    if (loan.renewals >= RENEW_LIMIT) return { ok: false };
    if (day > loan.dueDay) return { ok: false };
    if (b.queue.length > 0) return { ok: false };

    loan.dueDay += LOAN_DAYS;
    loan.renewals += 1;
    return { ok: true, dueDate: fmt(loan.dueDay) };
  });

  const placeHold = guard(function (args) {
    if (!isObj(args)) return { ok: false };
    const day = parseDay(args.date);
    if (day === null) return { ok: false };
    expire(day);
    const memberId = args.memberId;
    const bookId = args.bookId;
    if (!isId(memberId) || !isId(bookId)) return { ok: false };
    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b) return { ok: false };
    if (b.state === 'shelf') return { ok: false };
    if (m.loans.has(bookId)) return { ok: false };
    if (b.queue.includes(memberId)) return { ok: false };
    if (m.holds.length >= MAX_HOLDS) return { ok: false };

    b.queue.push(memberId);
    m.holds.push(bookId);
    return { ok: true, position: b.queue.length };
  });

  const payFine = guard(function (args) {
    if (!isObj(args)) return { ok: false };
    const day = parseDay(args.date);
    if (day === null) return { ok: false };
    expire(day);
    const memberId = args.memberId;
    const amount = args.amount;
    if (!isId(memberId)) return { ok: false };
    const m = members.get(memberId);
    if (!m) return { ok: false };
    if (!Number.isSafeInteger(amount) || amount < 1) return { ok: false };
    if (amount > m.owed) return { ok: false };

    m.owed -= amount;
    return { ok: true, owed: m.owed };
  });

  const getMember = guard(function (args) {
    if (!isObj(args)) return { ok: false };
    const day = parseDay(args.date);
    if (day === null) return { ok: false };
    expire(day);
    const memberId = args.memberId;
    if (!isId(memberId)) return { ok: false };
    const m = members.get(memberId);
    if (!m) return { ok: false };

    const loanEntries = [...m.loans.entries()];
    loanEntries.sort((x, y) => (x[1].dueDay - y[1].dueDay) || cmpStr(x[0], y[0]));
    const loans = loanEntries.map(([bookId, l]) => ({ bookId, dueDate: fmt(l.dueDay) }));

    const holds = m.holds.map((bookId) => {
      const b = books.get(bookId);
      const position = b.queue.indexOf(memberId) + 1;
      const setAside = b.state === 'setaside' && b.queue[0] === memberId;
      return {
        bookId,
        position,
        readyUntil: setAside ? fmt(b.readyUntil) : null,
      };
    });

    return { ok: true, loans, owed: m.owed, holds };
  });

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
