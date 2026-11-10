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
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

// Returns {y, m, d} for a valid 'YYYY-MM-DD' string, otherwise null.
function parseDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (y < 1 || m < 1 || m > 12) return null;
  const dim = m === 2 && isLeap(y) ? 29 : MONTH_DAYS[m - 1];
  if (d < 1 || d > dim) return null;
  return { y, m, d };
}

function isDate(s) {
  return parseDate(s) !== null;
}

// Day number (days since 1970-01-01, UTC) for a valid date string.
function toDay(s) {
  const p = parseDate(s);
  const t = new Date(0);
  t.setUTCFullYear(p.y, p.m - 1, p.d);
  return Math.round(t.getTime() / DAY_MS);
}

function fromDay(n) {
  const t = new Date(n * DAY_MS);
  return String(t.getUTCFullYear()).padStart(4, '0') + '-' +
    String(t.getUTCMonth() + 1).padStart(2, '0') + '-' +
    String(t.getUTCDate()).padStart(2, '0');
}

const MAX_DATE = '9999-12-31';
const MAX_DAY = toDay(MAX_DATE);

// Dates beyond 9999-12-31 are clamped to 9999-12-31.
function addDays(s, n) {
  let day = toDay(s) + n;
  if (day > MAX_DAY) day = MAX_DAY;
  return fromDay(day);
}

// Calendar days from a to b.
function diff(a, b) {
  return toDay(b) - toDay(a);
}

function fail() {
  return { ok: false };
}

function isId(x) {
  return typeof x === 'string' && x.length > 0;
}

function isAmount(x) {
  return Number.isSafeInteger(x) && x > 0;
}

function argsOf(input) {
  return typeof input === 'object' && input !== null ? input : null;
}

function guard(fn) {
  try {
    return fn();
  } catch {
    return fail();
  }
}

export function createLibrary() {
  const books = new Map();   // bookId -> { loan: {memberId, dueDate, renewals, seq} | null, queue: [{memberId, readyUntil, seq}] }
  const members = new Map(); // memberId -> { owed }
  let clock = null;          // day number of latest valid date seen
  let counter = 0;           // global sequence for loans and holds

  // Section 5: pickup expiry, applied to every book for day `day`.
  function processHolds(day) {
    for (const book of books.values()) {
      const q = book.queue;
      while (q.length > 0 && q[0].readyUntil !== null && toDay(q[0].readyUntil) < day) {
        const expired = q.shift().readyUntil;
        if (q.length > 0) {
          q[0].readyUntil = addDays(addDays(expired, 1), PICKUP_DAYS);
        }
      }
    }
  }

  // Section 4.4: returns false if the date is earlier than the clock.
  // The date must already be valid.
  function advance(date) {
    const day = toDay(date);
    if (clock !== null && day < clock) return false;
    clock = day;
    processHolds(day);
    return true;
  }

  function countLoans(memberId) {
    let n = 0;
    for (const b of books.values()) {
      if (b.loan && b.loan.memberId === memberId) n++;
    }
    return n;
  }

  return {
    addBook(input) {
      return guard(() => {
        const a = argsOf(input);
        if (!a) return fail();
        const bookId = a.bookId;
        if (!isId(bookId) || books.has(bookId)) return fail();
        books.set(bookId, { loan: null, queue: [] });
        return { ok: true };
      });
    },

    addMember(input) {
      return guard(() => {
        const a = argsOf(input);
        if (!a) return fail();
        const memberId = a.memberId;
        if (!isId(memberId) || members.has(memberId)) return fail();
        members.set(memberId, { owed: 0 });
        return { ok: true };
      });
    },

    borrow(input) {
      return guard(() => {
        const a = argsOf(input);
        if (!a) return fail();
        const memberId = a.memberId;
        const bookId = a.bookId;
        const date = a.date;
        if (!isId(memberId) || !isId(bookId) || !isDate(date)) return fail();
        if (!advance(date)) return fail();

        const m = members.get(memberId);
        const b = books.get(bookId);
        if (!m || !b || b.loan) return fail();

        const head = b.queue[0];
        if (head && (head.memberId !== memberId || head.readyUntil === null)) return fail();
        if (countLoans(memberId) >= MAX_LOANS) return fail();
        if (m.owed >= BORROW_BLOCK_OWED) return fail();

        if (head) b.queue.shift();
        const dueDate = addDays(date, LOAN_DAYS);
        b.loan = { memberId, dueDate, renewals: 0, seq: ++counter };
        return { ok: true, dueDate };
      });
    },

    returnBook(input) {
      return guard(() => {
        const a = argsOf(input);
        if (!a) return fail();
        const memberId = a.memberId;
        const bookId = a.bookId;
        const date = a.date;
        if (!isId(memberId) || !isId(bookId) || !isDate(date)) return fail();
        if (!advance(date)) return fail();

        const m = members.get(memberId);
        const b = books.get(bookId);
        if (!m || !b || !b.loan || b.loan.memberId !== memberId) return fail();

        const late = diff(b.loan.dueDate, date);
        const fine = late <= GRACE_DAYS
          ? 0
          : Math.min(late * FINE_PER_DAY, MAX_FINE_PER_LOAN);

        m.owed += fine;
        b.loan = null;
        if (b.queue.length > 0) {
          b.queue[0].readyUntil = addDays(date, PICKUP_DAYS);
        }
        return { ok: true, fine };
      });
    },

    renew(input) {
      return guard(() => {
        const a = argsOf(input);
        if (!a) return fail();
        const memberId = a.memberId;
        const bookId = a.bookId;
        const date = a.date;
        if (!isId(memberId) || !isId(bookId) || !isDate(date)) return fail();
        if (!advance(date)) return fail();

        const b = books.get(bookId);
        if (!members.has(memberId) || !b || !b.loan || b.loan.memberId !== memberId) return fail();
        if (diff(b.loan.dueDate, date) > 0) return fail();          // overdue
        if (b.loan.renewals >= MAX_RENEWALS) return fail();
        if (b.queue.length > 0) return fail();                      // someone is waiting

        b.loan.dueDate = addDays(b.loan.dueDate, LOAN_DAYS);
        b.loan.renewals += 1;
        return { ok: true, dueDate: b.loan.dueDate };
      });
    },

    placeHold(input) {
      return guard(() => {
        const a = argsOf(input);
        if (!a) return fail();
        const memberId = a.memberId;
        const bookId = a.bookId;
        const date = a.date;
        if (!isId(memberId) || !isId(bookId) || !isDate(date)) return fail();
        if (!advance(date)) return fail();

        const b = books.get(bookId);
        if (!members.has(memberId) || !b) return fail();
        if (!b.loan && b.queue.length === 0) return fail();         // available
        if (b.loan && b.loan.memberId === memberId) return fail();  // already on loan to them
        if (b.queue.some((h) => h.memberId === memberId)) return fail();

        b.queue.push({ memberId, readyUntil: null, seq: ++counter });
        return { ok: true, position: b.queue.length };
      });
    },

    payFine(input) {
      return guard(() => {
        const a = argsOf(input);
        if (!a) return fail();
        const memberId = a.memberId;
        const amount = a.amount;
        const date = a.date;
        if (!isId(memberId) || !isAmount(amount) || !isDate(date)) return fail();
        if (!advance(date)) return fail();

        const m = members.get(memberId);
        if (!m || amount > m.owed) return fail();

        m.owed -= amount;
        return { ok: true, owed: m.owed };
      });
    },

    getMember(input) {
      return guard(() => {
        const a = argsOf(input);
        if (!a) return fail();
        const memberId = a.memberId;
        const date = a.date;
        if (!isId(memberId) || !isDate(date)) return fail();
        if (!advance(date)) return fail();

        const m = members.get(memberId);
        if (!m) return fail();

        const loans = [];
        const holds = [];
        for (const [bookId, b] of books) {
          if (b.loan && b.loan.memberId === memberId) {
            loans.push({ seq: b.loan.seq, bookId, dueDate: b.loan.dueDate });
          }
          b.queue.forEach((h, i) => {
            if (h.memberId === memberId) {
              holds.push({
                seq: h.seq,
                bookId,
                position: i + 1,
                readyUntil: h.readyUntil,
              });
            }
          });
        }

        loans.sort((x, y) => x.seq - y.seq);
        holds.sort((x, y) => x.seq - y.seq);

        return {
          ok: true,
          loans: loans.map(({ bookId, dueDate }) => ({ bookId, dueDate })),
          owed: m.owed,
          holds: holds.map(({ bookId, position, readyUntil }) => ({ bookId, position, readyUntil })),
        };
      });
    },
  };
}
