const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const MAX_LOANS = 5;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 3;
const MAX_FINE_PER_LOAN = 1000;
const BORROW_BLOCK_OWED = 500;
const PICKUP_DAYS = 7;
const DAY_MS = 86400000;

function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

// Day number (days since 1970-01-01, UTC) for a valid y/m/d. Works for years 1-9999.
function dayNumber(y, m, d) {
  const dt = new Date(0);
  dt.setUTCFullYear(y, m - 1, d);
  return Math.round(dt.getTime() / DAY_MS);
}

const MAX_DAY = dayNumber(9999, 12, 31);

// Returns day number for a valid 'YYYY-MM-DD' string, or null.
function parseDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (y < 1 || m < 1 || m > 12) return null;
  const dim = [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  if (d < 1 || d > dim) return null;
  return dayNumber(y, m, d);
}

// Day number -> 'YYYY-MM-DD'. Input must be within 0001-01-01..9999-12-31.
function fromDayNumber(n) {
  const dt = new Date(n * DAY_MS);
  const y = String(dt.getUTCFullYear()).padStart(4, '0');
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Assumes s is a valid date string already stored in state.
function dn(s) {
  return parseDate(s);
}

// addDays on a valid date string; clamps to 9999-12-31.
function addDaysStr(s, n) {
  const r = Math.min(dn(s) + n, MAX_DAY);
  return fromDayNumber(r);
}

function isObj(a) {
  return a !== null && typeof a === 'object';
}

function validId(v) {
  return typeof v === 'string' && v.length > 0;
}

function validAmount(v) {
  return Number.isSafeInteger(v) && v > 0;
}

export function createLibrary() {
  // bookId -> { loan: null | { memberId, dueDate, renewals, seq }, queue: [{ memberId, seq, readyUntil }] }
  const books = new Map();
  // memberId -> { owed }
  const members = new Map();
  let clock = null; // day number of latest valid date seen
  let seq = 0;

  const fail = () => ({ ok: false });

  function processHolds(d) {
    for (const book of books.values()) {
      while (
        book.queue.length > 0 &&
        book.queue[0].readyUntil !== null &&
        dn(book.queue[0].readyUntil) < d
      ) {
        const old = book.queue.shift();
        if (book.queue.length > 0) {
          const e = addDaysStr(old.readyUntil, 1);
          book.queue[0].readyUntil = addDaysStr(e, PICKUP_DAYS);
        }
      }
    }
  }

  // Clock and hold processing for a dated call. Returns false if the date is invalid or out of order.
  function advance(s) {
    const d = parseDate(s);
    if (d === null) return false;
    if (clock !== null && d < clock) return false;
    clock = d;
    processHolds(d);
    return true;
  }

  function countLoans(memberId) {
    let n = 0;
    for (const book of books.values()) {
      if (book.loan && book.loan.memberId === memberId) n++;
    }
    return n;
  }

  function addBook(arg) {
    try {
      if (!isObj(arg) || !validId(arg.bookId)) return fail();
      if (books.has(arg.bookId)) return fail();
      books.set(arg.bookId, { loan: null, queue: [] });
      return { ok: true };
    } catch {
      return fail();
    }
  }

  function addMember(arg) {
    try {
      if (!isObj(arg) || !validId(arg.memberId)) return fail();
      if (members.has(arg.memberId)) return fail();
      members.set(arg.memberId, { owed: 0 });
      return { ok: true };
    } catch {
      return fail();
    }
  }

  function borrow(arg) {
    try {
      if (!isObj(arg) || !validId(arg.memberId) || !validId(arg.bookId) || parseDate(arg.date) === null) {
        return fail();
      }
      if (!advance(arg.date)) return fail();
      const { memberId, bookId, date } = arg;
      if (!members.has(memberId) || !books.has(bookId)) return fail();
      const m = members.get(memberId);
      const book = books.get(bookId);
      if (book.loan) return fail();
      const head = book.queue[0];
      if (head && head.readyUntil !== null && head.memberId !== memberId) return fail();
      if (m.owed >= BORROW_BLOCK_OWED) return fail();
      if (countLoans(memberId) >= MAX_LOANS) return fail();
      if (head && head.readyUntil !== null) book.queue.shift();
      const dueDate = addDaysStr(date, LOAN_DAYS);
      book.loan = { memberId, dueDate, renewals: 0, seq: seq++ };
      return { ok: true, dueDate };
    } catch {
      return fail();
    }
  }

  function returnBook(arg) {
    try {
      if (!isObj(arg) || !validId(arg.memberId) || !validId(arg.bookId) || parseDate(arg.date) === null) {
        return fail();
      }
      if (!advance(arg.date)) return fail();
      const { memberId, bookId, date } = arg;
      if (!members.has(memberId) || !books.has(bookId)) return fail();
      const m = members.get(memberId);
      const book = books.get(bookId);
      if (!book.loan || book.loan.memberId !== memberId) return fail();
      const daysLate = dn(date) - dn(book.loan.dueDate);
      const fine =
        daysLate <= GRACE_DAYS ? 0 : Math.min(daysLate * FINE_PER_DAY, MAX_FINE_PER_LOAN);
      m.owed += fine;
      book.loan = null;
      if (book.queue.length > 0) {
        book.queue[0].readyUntil = addDaysStr(date, PICKUP_DAYS);
      }
      return { ok: true, fine };
    } catch {
      return fail();
    }
  }

  function renew(arg) {
    try {
      if (!isObj(arg) || !validId(arg.memberId) || !validId(arg.bookId) || parseDate(arg.date) === null) {
        return fail();
      }
      if (!advance(arg.date)) return fail();
      const { memberId, bookId, date } = arg;
      if (!members.has(memberId) || !books.has(bookId)) return fail();
      const book = books.get(bookId);
      if (!book.loan || book.loan.memberId !== memberId) return fail();
      if (dn(date) > dn(book.loan.dueDate)) return fail();
      if (book.loan.renewals >= MAX_RENEWALS) return fail();
      if (book.queue.length > 0) return fail();
      book.loan.dueDate = addDaysStr(book.loan.dueDate, LOAN_DAYS);
      book.loan.renewals += 1;
      return { ok: true, dueDate: book.loan.dueDate };
    } catch {
      return fail();
    }
  }

  function placeHold(arg) {
    try {
      if (!isObj(arg) || !validId(arg.memberId) || !validId(arg.bookId) || parseDate(arg.date) === null) {
        return fail();
      }
      if (!advance(arg.date)) return fail();
      const { memberId, bookId } = arg;
      if (!members.has(memberId) || !books.has(bookId)) return fail();
      const book = books.get(bookId);
      if (!book.loan && book.queue.length === 0) return fail(); // Available
      if (book.loan && book.loan.memberId === memberId) return fail();
      if (book.queue.some((h) => h.memberId === memberId)) return fail();
      book.queue.push({ memberId, seq: seq++, readyUntil: null });
      return { ok: true, position: book.queue.length };
    } catch {
      return fail();
    }
  }

  function payFine(arg) {
    try {
      if (
        !isObj(arg) ||
        !validId(arg.memberId) ||
        !validAmount(arg.amount) ||
        parseDate(arg.date) === null
      ) {
        return fail();
      }
      if (!advance(arg.date)) return fail();
      const { memberId, amount } = arg;
      if (!members.has(memberId)) return fail();
      const m = members.get(memberId);
      if (amount > m.owed) return fail();
      m.owed -= amount;
      return { ok: true, owed: m.owed };
    } catch {
      return fail();
    }
  }

  function getMember(arg) {
    try {
      if (!isObj(arg) || !validId(arg.memberId) || parseDate(arg.date) === null) return fail();
      if (!advance(arg.date)) return fail();
      const { memberId } = arg;
      if (!members.has(memberId)) return fail();
      const m = members.get(memberId);

      const loanEntries = [];
      const holdEntries = [];
      for (const [bookId, book] of books) {
        if (book.loan && book.loan.memberId === memberId) {
          loanEntries.push({ seq: book.loan.seq, bookId, dueDate: book.loan.dueDate });
        }
        book.queue.forEach((h, i) => {
          if (h.memberId === memberId) {
            holdEntries.push({
              seq: h.seq,
              bookId,
              position: i + 1,
              readyUntil: h.readyUntil,
            });
          }
        });
      }
      loanEntries.sort((a, b) => a.seq - b.seq);
      holdEntries.sort((a, b) => a.seq - b.seq);

      return {
        ok: true,
        loans: loanEntries.map((e) => ({ bookId: e.bookId, dueDate: e.dueDate })),
        owed: m.owed,
        holds: holdEntries.map((e) => ({
          bookId: e.bookId,
          position: e.position,
          readyUntil: e.readyUntil,
        })),
      };
    } catch {
      return fail();
    }
  }

  return { addBook, addMember, borrow, returnBook, renew, placeHold, payFine, getMember };
}
