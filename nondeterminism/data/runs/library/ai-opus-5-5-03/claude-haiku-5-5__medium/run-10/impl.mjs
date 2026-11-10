const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const MAX_LOANS = 5;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 3;
const MAX_FINE_PER_LOAN = 1000;
const BORROW_BLOCK_OWED = 500;
const PICKUP_DAYS = 7;

const DAY_MS = 86400000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function serialOf(y, m, d) {
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  return Math.round(t.getTime() / DAY_MS);
}

const MAX_SERIAL = serialOf(9999, 12, 31);

function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function parseDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (y < 1 || m < 1 || m > 12 || d < 1) return null;
  const dim = [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  if (d > dim) return null;
  return serialOf(y, m, d);
}

function formatSerial(n) {
  const t = new Date(n * DAY_MS);
  const y = String(t.getUTCFullYear()).padStart(4, '0');
  const m = String(t.getUTCMonth() + 1).padStart(2, '0');
  const d = String(t.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Dates are clamped to 9999-12-31 so that every returned date stays representable.
function addDays(n, k) {
  return Math.min(n + k, MAX_SERIAL);
}

const isObj = (a) => a !== null && typeof a === 'object';
const isId = (v) => typeof v === 'string' && v.length > 0;
const isAmount = (v) => Number.isSafeInteger(v) && v > 0;
const FAIL = () => ({ ok: false });

function safe(fn) {
  try {
    return fn();
  } catch (e) {
    return { ok: false };
  }
}

export function createLibrary() {
  // bookId -> { loan: null | { memberId, dueDate, renewals, seq }, queue: [{ memberId, readyUntil, seq }] }
  const books = new Map();
  // memberId -> { owed }
  const members = new Map();
  let clock = null;
  let seq = 0;

  function processHolds(D) {
    for (const book of books.values()) {
      while (
        book.queue.length > 0 &&
        book.queue[0].readyUntil !== null &&
        book.queue[0].readyUntil < D
      ) {
        const expired = book.queue.shift();
        const E = addDays(expired.readyUntil, 1);
        if (book.queue.length > 0) {
          book.queue[0].readyUntil = addDays(E, PICKUP_DAYS);
        }
      }
    }
  }

  // Parses the date, checks clock order, advances the clock and runs hold processing.
  // Returns the serial day number, or null if the date is invalid or out of order.
  function startDated(date) {
    const D = parseDate(date);
    if (D === null) return null;
    if (clock !== null && D < clock) return null;
    clock = D;
    processHolds(D);
    return D;
  }

  function countLoans(memberId) {
    let n = 0;
    for (const b of books.values()) {
      if (b.loan && b.loan.memberId === memberId) n++;
    }
    return n;
  }

  return {
    addBook(arg) {
      return safe(() => {
        if (!isObj(arg) || !isId(arg.bookId) || books.has(arg.bookId)) return FAIL();
        books.set(arg.bookId, { loan: null, queue: [] });
        return { ok: true };
      });
    },

    addMember(arg) {
      return safe(() => {
        if (!isObj(arg) || !isId(arg.memberId) || members.has(arg.memberId)) return FAIL();
        members.set(arg.memberId, { owed: 0 });
        return { ok: true };
      });
    },

    borrow(arg) {
      return safe(() => {
        if (!isObj(arg) || !isId(arg.memberId) || !isId(arg.bookId)) return FAIL();
        const D = startDated(arg.date);
        if (D === null) return FAIL();
        const m = members.get(arg.memberId);
        const b = books.get(arg.bookId);
        if (!m || !b) return FAIL();
        if (b.loan) return FAIL();
        if (b.queue.length > 0) {
          const head = b.queue[0];
          if (head.memberId !== arg.memberId || head.readyUntil === null) return FAIL();
        }
        if (countLoans(arg.memberId) >= MAX_LOANS) return FAIL();
        if (m.owed >= BORROW_BLOCK_OWED) return FAIL();

        if (b.queue.length > 0) b.queue.shift();
        const due = addDays(D, LOAN_DAYS);
        b.loan = { memberId: arg.memberId, dueDate: due, renewals: 0, seq: ++seq };
        return { ok: true, dueDate: formatSerial(due) };
      });
    },

    returnBook(arg) {
      return safe(() => {
        if (!isObj(arg) || !isId(arg.memberId) || !isId(arg.bookId)) return FAIL();
        const D = startDated(arg.date);
        if (D === null) return FAIL();
        const m = members.get(arg.memberId);
        const b = books.get(arg.bookId);
        if (!m || !b) return FAIL();
        if (!b.loan || b.loan.memberId !== arg.memberId) return FAIL();

        const daysLate = D - b.loan.dueDate;
        let fine = 0;
        if (daysLate > GRACE_DAYS) {
          fine = Math.min(daysLate * FINE_PER_DAY, MAX_FINE_PER_LOAN);
        }
        m.owed += fine;
        b.loan = null;
        if (b.queue.length > 0) {
          b.queue[0].readyUntil = addDays(D, PICKUP_DAYS);
        }
        return { ok: true, fine };
      });
    },

    renew(arg) {
      return safe(() => {
        if (!isObj(arg) || !isId(arg.memberId) || !isId(arg.bookId)) return FAIL();
        const D = startDated(arg.date);
        if (D === null) return FAIL();
        const m = members.get(arg.memberId);
        const b = books.get(arg.bookId);
        if (!m || !b) return FAIL();
        if (!b.loan || b.loan.memberId !== arg.memberId) return FAIL();
        if (D > b.loan.dueDate) return FAIL();
        if (b.loan.renewals >= MAX_RENEWALS) return FAIL();
        if (b.queue.length > 0) return FAIL();

        b.loan.dueDate = addDays(b.loan.dueDate, LOAN_DAYS);
        b.loan.renewals += 1;
        return { ok: true, dueDate: formatSerial(b.loan.dueDate) };
      });
    },

    placeHold(arg) {
      return safe(() => {
        if (!isObj(arg) || !isId(arg.memberId) || !isId(arg.bookId)) return FAIL();
        const D = startDated(arg.date);
        if (D === null) return FAIL();
        const m = members.get(arg.memberId);
        const b = books.get(arg.bookId);
        if (!m || !b) return FAIL();
        // Available: no loan and empty queue.
        if (!b.loan && b.queue.length === 0) return FAIL();
        if (b.loan && b.loan.memberId === arg.memberId) return FAIL();
        if (b.queue.some((h) => h.memberId === arg.memberId)) return FAIL();

        b.queue.push({ memberId: arg.memberId, readyUntil: null, seq: ++seq });
        return { ok: true, position: b.queue.length };
      });
    },

    payFine(arg) {
      return safe(() => {
        if (!isObj(arg) || !isId(arg.memberId) || !isAmount(arg.amount)) return FAIL();
        const D = startDated(arg.date);
        if (D === null) return FAIL();
        const m = members.get(arg.memberId);
        if (!m) return FAIL();
        if (arg.amount > m.owed) return FAIL();

        m.owed -= arg.amount;
        return { ok: true, owed: m.owed };
      });
    },

    getMember(arg) {
      return safe(() => {
        if (!isObj(arg) || !isId(arg.memberId)) return FAIL();
        const D = startDated(arg.date);
        if (D === null) return FAIL();
        const m = members.get(arg.memberId);
        if (!m) return FAIL();

        const loanRows = [];
        const holdRows = [];
        for (const [bookId, b] of books) {
          if (b.loan && b.loan.memberId === arg.memberId) {
            loanRows.push({ seq: b.loan.seq, bookId, dueDate: b.loan.dueDate });
          }
          b.queue.forEach((h, i) => {
            if (h.memberId === arg.memberId) {
              holdRows.push({ seq: h.seq, bookId, position: i + 1, readyUntil: h.readyUntil });
            }
          });
        }
        loanRows.sort((x, y) => x.seq - y.seq);
        holdRows.sort((x, y) => x.seq - y.seq);

        return {
          ok: true,
          loans: loanRows.map((r) => ({ bookId: r.bookId, dueDate: formatSerial(r.dueDate) })),
          owed: m.owed,
          holds: holdRows.map((r) => ({
            bookId: r.bookId,
            position: r.position,
            readyUntil: r.readyUntil === null ? null : formatSerial(r.readyUntil),
          })),
        };
      });
    },
  };
}
