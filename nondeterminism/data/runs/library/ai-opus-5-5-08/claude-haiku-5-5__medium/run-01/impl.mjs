const DAY_MS = 86400000;
const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const RENEW_DAYS = 21;
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

// Returns integer day number (days since 1970-01-01 UTC) or null if invalid.
function parseDay(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  const dt = new Date(0);
  dt.setUTCFullYear(y, m - 1, d);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) {
    return null;
  }
  return Math.round(dt.getTime() / DAY_MS);
}

function formatDay(n) {
  const dt = new Date(n * DAY_MS);
  const y = String(dt.getUTCFullYear()).padStart(4, '0');
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function createLibrary() {
  // book: { id, queue: [memberId], loanedTo: memberId|null, readyUntil: dayNum|null }
  // member: { loans: Map<bookId, { dueDate: dayNum, renewals: number }>, owed: number, holds: [bookId] }
  const books = new Map();
  const members = new Map();

  // Hold expiration (section 3.5). Processes all books up to `today`.
  function processExpirations(today) {
    for (const b of books.values()) {
      if (b.loanedTo !== null) continue;
      while (b.queue.length > 0 && b.readyUntil !== null && today > b.readyUntil) {
        const gone = b.queue.shift();
        const m = members.get(gone);
        if (m) {
          m.holds = m.holds.filter((id) => id !== b.id);
        }
        if (b.queue.length > 0) {
          b.readyUntil = b.readyUntil + 1 + PICKUP_DAYS;
        } else {
          b.readyUntil = null;
        }
      }
    }
  }

  // Validates the argument and date, then runs expiration.
  // Returns the day number, or null if the argument or date is invalid.
  function begin(arg) {
    if (!isObj(arg)) return null;
    const day = parseDay(arg.date);
    if (day === null) return null;
    processExpirations(day);
    return day;
  }

  function run(fn) {
    try {
      return fn();
    } catch (e) {
      return { ok: false };
    }
  }

  return {
    addBook(arg) {
      return run(() => {
        if (!isObj(arg) || !validId(arg.bookId)) return { ok: false };
        if (books.has(arg.bookId)) return { ok: false };
        books.set(arg.bookId, {
          id: arg.bookId,
          queue: [],
          loanedTo: null,
          readyUntil: null,
        });
        return { ok: true };
      });
    },

    addMember(arg) {
      return run(() => {
        if (!isObj(arg) || !validId(arg.memberId)) return { ok: false };
        if (members.has(arg.memberId)) return { ok: false };
        members.set(arg.memberId, {
          loans: new Map(),
          owed: 0,
          holds: [],
        });
        return { ok: true };
      });
    },

    borrow(arg) {
      return run(() => {
        const day = begin(arg);
        if (day === null) return { ok: false };
        const memberId = arg.memberId;
        const bookId = arg.bookId;
        if (!validId(memberId) || !validId(bookId)) return { ok: false };
        const m = members.get(memberId);
        const b = books.get(bookId);
        if (!m || !b) return { ok: false };
        if (b.loanedTo !== null) return { ok: false };
        if (b.queue.length > 0 && b.queue[0] !== memberId) return { ok: false };
        if (m.loans.size >= MAX_LOANS) return { ok: false };
        if (m.owed >= DEBT_BLOCK) return { ok: false };
        for (const loan of m.loans.values()) {
          if (loan.dueDate < day) return { ok: false };
        }
        if (b.queue.length > 0) {
          // Book is set aside for this member; consume that hold.
          b.queue.shift();
          m.holds = m.holds.filter((id) => id !== bookId);
          b.readyUntil = null;
        }
        b.loanedTo = memberId;
        m.loans.set(bookId, { dueDate: day + LOAN_DAYS, renewals: 0 });
        return { ok: true, dueDate: formatDay(day + LOAN_DAYS) };
      });
    },

    returnBook(arg) {
      return run(() => {
        const day = begin(arg);
        if (day === null) return { ok: false };
        const memberId = arg.memberId;
        const bookId = arg.bookId;
        if (!validId(memberId) || !validId(bookId)) return { ok: false };
        const m = members.get(memberId);
        const b = books.get(bookId);
        if (!m || !b) return { ok: false };
        if (b.loanedTo !== memberId) return { ok: false };
        const loan = m.loans.get(bookId);
        if (!loan) return { ok: false };

        const daysLate = Math.max(0, day - loan.dueDate);
        const chargeable = Math.max(0, daysLate - GRACE_DAYS);
        const fine = Math.min(chargeable * FINE_PER_DAY, FINE_CAP);

        m.owed += fine;
        m.loans.delete(bookId);
        b.loanedTo = null;
        if (b.queue.length > 0) {
          b.readyUntil = day + PICKUP_DAYS;
        } else {
          b.readyUntil = null;
        }
        return { ok: true, fine };
      });
    },

    renew(arg) {
      return run(() => {
        const day = begin(arg);
        if (day === null) return { ok: false };
        const memberId = arg.memberId;
        const bookId = arg.bookId;
        if (!validId(memberId) || !validId(bookId)) return { ok: false };
        const m = members.get(memberId);
        const b = books.get(bookId);
        if (!m || !b) return { ok: false };
        if (b.loanedTo !== memberId) return { ok: false };
        const loan = m.loans.get(bookId);
        if (!loan) return { ok: false };
        if (loan.renewals >= MAX_RENEWALS) return { ok: false };
        if (day > loan.dueDate) return { ok: false };
        if (b.queue.length > 0) return { ok: false };
        loan.dueDate += RENEW_DAYS;
        loan.renewals += 1;
        return { ok: true, dueDate: formatDay(loan.dueDate) };
      });
    },

    placeHold(arg) {
      return run(() => {
        const day = begin(arg);
        if (day === null) return { ok: false };
        const memberId = arg.memberId;
        const bookId = arg.bookId;
        if (!validId(memberId) || !validId(bookId)) return { ok: false };
        const m = members.get(memberId);
        const b = books.get(bookId);
        if (!m || !b) return { ok: false };
        // On shelf: loanedTo null and queue empty.
        if (b.loanedTo === null && b.queue.length === 0) return { ok: false };
        if (m.loans.has(bookId)) return { ok: false };
        if (b.queue.includes(memberId)) return { ok: false };
        if (m.holds.length >= MAX_HOLDS) return { ok: false };
        b.queue.push(memberId);
        m.holds.push(bookId);
        return { ok: true, position: b.queue.length };
      });
    },

    payFine(arg) {
      return run(() => {
        const day = begin(arg);
        if (day === null) return { ok: false };
        const memberId = arg.memberId;
        if (!validId(memberId)) return { ok: false };
        const m = members.get(memberId);
        if (!m) return { ok: false };
        const amount = arg.amount;
        if (!Number.isSafeInteger(amount) || amount < 1) return { ok: false };
        if (amount > m.owed) return { ok: false };
        m.owed -= amount;
        return { ok: true, owed: m.owed };
      });
    },

    getMember(arg) {
      return run(() => {
        const day = begin(arg);
        if (day === null) return { ok: false };
        const memberId = arg.memberId;
        if (!validId(memberId)) return { ok: false };
        const m = members.get(memberId);
        if (!m) return { ok: false };

        const loans = [];
        for (const [bookId, loan] of m.loans.entries()) {
          loans.push({ bookId, dueDate: formatDay(loan.dueDate) });
        }
        loans.sort((x, y) => {
          if (x.dueDate < y.dueDate) return -1;
          if (x.dueDate > y.dueDate) return 1;
          if (x.bookId < y.bookId) return -1;
          if (x.bookId > y.bookId) return 1;
          return 0;
        });

        const holds = [];
        for (const bookId of m.holds) {
          const b = books.get(bookId);
          if (!b) continue;
          const idx = b.queue.indexOf(memberId);
          if (idx === -1) continue;
          const position = idx + 1;
          const setAside = b.loanedTo === null && position === 1 && b.readyUntil !== null;
          holds.push({
            bookId,
            position,
            readyUntil: setAside ? formatDay(b.readyUntil) : null,
          });
        }

        return { ok: true, loans, owed: m.owed, holds };
      });
    },
  };
}
