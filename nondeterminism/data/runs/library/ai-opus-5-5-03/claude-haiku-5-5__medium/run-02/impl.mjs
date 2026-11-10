const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const MAX_LOANS = 5;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 3;
const MAX_FINE_PER_LOAN = 1000;
const BORROW_BLOCK_OWED = 500;
const PICKUP_DAYS = 7;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y, m) {
  return [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

// Days since 1970-01-01 for a proleptic Gregorian civil date (exact integer arithmetic).
function civilToDay(y, m, d) {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const mp = (m + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

// Inverse of civilToDay: returns [year, month, day].
function dayToCivil(z) {
  const zz = z + 719468;
  const era = Math.floor(zz / 146097);
  const doe = zz - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365
  );
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return [m <= 2 ? y + 1 : y, m, d];
}

const MIN_DAY = civilToDay(1, 1, 1);
const MAX_DAY = civilToDay(9999, 12, 31);

function addDays(z, n) {
  return Math.min(z + n, MAX_DAY);
}

function parseDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (y < 1 || m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  const z = civilToDay(y, m, d);
  if (z < MIN_DAY || z > MAX_DAY) return null;
  return z;
}

function formatDay(z) {
  const [y, m, d] = dayToCivil(z);
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function validId(v) {
  return typeof v === 'string' && v.length > 0;
}

function isObj(v) {
  return typeof v === 'object' && v !== null;
}

function fail() {
  return { ok: false };
}

function safe(fn) {
  try {
    return fn();
  } catch {
    return fail();
  }
}

export function createLibrary() {
  // bookId -> { loan: null | { memberId, dueDay, renewals, seq }, queue: [{ memberId, readyUntil, seq }] }
  const books = new Map();
  // memberId -> { owed }
  const members = new Map();
  let clock = null; // day number of the latest valid date seen
  let seqCounter = 0;

  function processHolds(z) {
    for (const book of books.values()) {
      const q = book.queue;
      while (q.length > 0 && q[0].readyUntil !== null && q[0].readyUntil < z) {
        const old = q.shift().readyUntil;
        if (q.length > 0) {
          q[0].readyUntil = addDays(addDays(old, 1), PICKUP_DAYS);
        }
      }
    }
  }

  // Validates the date, enforces time order, advances the clock and runs hold processing.
  // Returns the day number, or null if the call must fail.
  function startDated(args) {
    if (!isObj(args)) return null;
    const z = parseDate(args.date);
    if (z === null) return null;
    if (clock !== null && z < clock) return null;
    clock = z;
    processHolds(z);
    return z;
  }

  function countLoans(memberId) {
    let n = 0;
    for (const b of books.values()) {
      if (b.loan && b.loan.memberId === memberId) n++;
    }
    return n;
  }

  return {
    addBook(args) {
      return safe(() => {
        if (!isObj(args)) return fail();
        const bookId = args.bookId;
        if (!validId(bookId) || books.has(bookId)) return fail();
        books.set(bookId, { loan: null, queue: [] });
        return { ok: true };
      });
    },

    addMember(args) {
      return safe(() => {
        if (!isObj(args)) return fail();
        const memberId = args.memberId;
        if (!validId(memberId) || members.has(memberId)) return fail();
        members.set(memberId, { owed: 0 });
        return { ok: true };
      });
    },

    borrow(args) {
      return safe(() => {
        const z = startDated(args);
        if (z === null) return fail();
        const memberId = args.memberId;
        const bookId = args.bookId;
        if (!validId(memberId) || !validId(bookId)) return fail();
        const m = members.get(memberId);
        const b = books.get(bookId);
        if (!m || !b) return fail();
        if (b.loan) return fail();

        let myHold = null;
        if (b.queue.length > 0) {
          const head = b.queue[0];
          if (head.readyUntil === null || head.memberId !== memberId) return fail();
          myHold = head;
        }
        if (countLoans(memberId) >= MAX_LOANS) return fail();
        if (m.owed >= BORROW_BLOCK_OWED) return fail();

        const due = addDays(z, LOAN_DAYS);
        if (myHold) b.queue.shift();
        b.loan = { memberId, dueDay: due, renewals: 0, seq: seqCounter++ };
        return { ok: true, dueDate: formatDay(due) };
      });
    },

    returnBook(args) {
      return safe(() => {
        const z = startDated(args);
        if (z === null) return fail();
        const memberId = args.memberId;
        const bookId = args.bookId;
        if (!validId(memberId) || !validId(bookId)) return fail();
        const m = members.get(memberId);
        const b = books.get(bookId);
        if (!m || !b) return fail();
        if (!b.loan || b.loan.memberId !== memberId) return fail();

        const daysLate = z - b.loan.dueDay;
        const fine = daysLate <= GRACE_DAYS
          ? 0
          : Math.min(daysLate * FINE_PER_DAY, MAX_FINE_PER_LOAN);

        m.owed += fine;
        b.loan = null;
        if (b.queue.length > 0) {
          b.queue[0].readyUntil = addDays(z, PICKUP_DAYS);
        }
        return { ok: true, fine };
      });
    },

    renew(args) {
      return safe(() => {
        const z = startDated(args);
        if (z === null) return fail();
        const memberId = args.memberId;
        const bookId = args.bookId;
        if (!validId(memberId) || !validId(bookId)) return fail();
        if (!members.has(memberId)) return fail();
        const b = books.get(bookId);
        if (!b) return fail();
        if (!b.loan || b.loan.memberId !== memberId) return fail();
        if (z > b.loan.dueDay) return fail();
        if (b.loan.renewals >= MAX_RENEWALS) return fail();
        if (b.queue.length > 0) return fail();

        b.loan.dueDay = addDays(b.loan.dueDay, LOAN_DAYS);
        b.loan.renewals += 1;
        return { ok: true, dueDate: formatDay(b.loan.dueDay) };
      });
    },

    placeHold(args) {
      return safe(() => {
        const z = startDated(args);
        if (z === null) return fail();
        const memberId = args.memberId;
        const bookId = args.bookId;
        if (!validId(memberId) || !validId(bookId)) return fail();
        if (!members.has(memberId)) return fail();
        const b = books.get(bookId);
        if (!b) return fail();
        // Available: no loan and no holds.
        if (!b.loan && b.queue.length === 0) return fail();
        if (b.loan && b.loan.memberId === memberId) return fail();
        if (b.queue.some((h) => h.memberId === memberId)) return fail();

        b.queue.push({ memberId, readyUntil: null, seq: seqCounter++ });
        return { ok: true, position: b.queue.length };
      });
    },

    payFine(args) {
      return safe(() => {
        const z = startDated(args);
        if (z === null) return fail();
        const memberId = args.memberId;
        const amount = args.amount;
        if (!validId(memberId)) return fail();
        if (!Number.isSafeInteger(amount) || amount <= 0) return fail();
        const m = members.get(memberId);
        if (!m) return fail();
        if (amount > m.owed) return fail();

        m.owed -= amount;
        return { ok: true, owed: m.owed };
      });
    },

    getMember(args) {
      return safe(() => {
        const z = startDated(args);
        if (z === null) return fail();
        const memberId = args.memberId;
        if (!validId(memberId)) return fail();
        const m = members.get(memberId);
        if (!m) return fail();

        const loans = [];
        const holds = [];
        for (const [bookId, b] of books) {
          if (b.loan && b.loan.memberId === memberId) {
            loans.push({
              seq: b.loan.seq,
              bookId,
              dueDate: formatDay(b.loan.dueDay),
            });
          }
          b.queue.forEach((h, i) => {
            if (h.memberId === memberId) {
              holds.push({
                seq: h.seq,
                bookId,
                position: i + 1,
                readyUntil: h.readyUntil === null ? null : formatDay(h.readyUntil),
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
