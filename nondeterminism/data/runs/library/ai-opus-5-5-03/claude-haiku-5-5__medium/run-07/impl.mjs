const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const MAX_LOANS = 5;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 3;
const MAX_FINE_PER_LOAN = 1000;
const BORROW_BLOCK_OWED = 500;
const PICKUP_DAYS = 7;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Proleptic Gregorian day arithmetic (days since 1970-01-01), no Date object needed.
function daysFromCivil(y, m, d) {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const mp = m > 2 ? m - 3 : m + 9;
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(z0) {
  const z = z0 + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  const y = yoe + era * 400 + (m <= 2 ? 1 : 0);
  return [y, m, d];
}

const MAX_DAY = daysFromCivil(9999, 12, 31);

// Returns a day number, or null if the string is not a real date in 0001-9999.
function parseDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (y < 1 || m < 1 || m > 12 || d < 1) return null;
  const n = daysFromCivil(y, m, d);
  const [cy, cm, cd] = civilFromDays(n);
  if (cy !== y || cm !== m || cd !== d) return null;
  return n;
}

function formatDay(n) {
  const [y, m, d] = civilFromDays(n);
  return String(y).padStart(4, '0') + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

// Adds k days; clamps at 9999-12-31 so every returned date stays valid.
function addDay(n, k) {
  return Math.min(n + k, MAX_DAY);
}

function isId(v) {
  return typeof v === 'string' && v.length > 0;
}

function isArgs(a) {
  return a !== null && typeof a === 'object';
}

const fail = () => ({ ok: false });

export function createLibrary() {
  // bookId -> { loan: null | { memberId, dueDay, renewals }, queue: [{ memberId, seq, ready, readyUntil }] }
  const books = new Map();
  // memberId -> { owed, loans: [bookId in borrow order] }
  const members = new Map();
  let clock = null;
  let seqCounter = 0;

  // Section 5: hold processing at day D.
  function processHolds(D) {
    for (const book of books.values()) {
      const q = book.queue;
      while (q.length > 0 && q[0].ready && q[0].readyUntil < D) {
        const old = q.shift();
        if (q.length > 0) {
          const E = addDay(old.readyUntil, 1);
          q[0].ready = true;
          q[0].readyUntil = addDay(E, PICKUP_DAYS);
        }
      }
    }
  }

  // Validates the date, enforces the clock, and runs hold processing.
  // Returns the day number, or null on failure.
  function step(dateStr) {
    const n = parseDate(dateStr);
    if (n === null) return null;
    if (clock !== null && n < clock) return null;
    clock = n;
    processHolds(n);
    return n;
  }

  function addBook(args) {
    try {
      if (!isArgs(args)) return fail();
      const bookId = args.bookId;
      if (!isId(bookId) || books.has(bookId)) return fail();
      books.set(bookId, { loan: null, queue: [] });
      return { ok: true };
    } catch (e) {
      return fail();
    }
  }

  function addMember(args) {
    try {
      if (!isArgs(args)) return fail();
      const memberId = args.memberId;
      if (!isId(memberId) || members.has(memberId)) return fail();
      members.set(memberId, { owed: 0, loans: [] });
      return { ok: true };
    } catch (e) {
      return fail();
    }
  }

  function borrow(args) {
    try {
      if (!isArgs(args)) return fail();
      const memberId = args.memberId;
      const bookId = args.bookId;
      if (!isId(memberId) || !isId(bookId)) return fail();
      const D = step(args.date);
      if (D === null) return fail();

      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return fail();
      if (b.loan) return fail();
      if (b.queue.length > 0 && b.queue[0].ready && b.queue[0].memberId !== memberId) return fail();
      if (m.loans.length >= MAX_LOANS) return fail();
      if (m.owed >= BORROW_BLOCK_OWED) return fail();

      // Set-aside for this member: consume that ready hold.
      if (b.queue.length > 0 && b.queue[0].ready && b.queue[0].memberId === memberId) {
        b.queue.shift();
        if (b.queue.length > 0) {
          b.queue[0].ready = false;
          b.queue[0].readyUntil = null;
        }
      }

      const dueDay = addDay(D, LOAN_DAYS);
      b.loan = { memberId, dueDay, renewals: 0 };
      m.loans.push(bookId);
      return { ok: true, dueDate: formatDay(dueDay) };
    } catch (e) {
      return fail();
    }
  }

  function returnBook(args) {
    try {
      if (!isArgs(args)) return fail();
      const memberId = args.memberId;
      const bookId = args.bookId;
      if (!isId(memberId) || !isId(bookId)) return fail();
      const D = step(args.date);
      if (D === null) return fail();

      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return fail();
      if (!b.loan || b.loan.memberId !== memberId) return fail();

      const daysLate = D - b.loan.dueDay;
      const fine = daysLate <= GRACE_DAYS
        ? 0
        : Math.min(daysLate * FINE_PER_DAY, MAX_FINE_PER_LOAN);

      m.owed += fine;
      b.loan = null;
      const idx = m.loans.indexOf(bookId);
      if (idx >= 0) m.loans.splice(idx, 1);

      if (b.queue.length > 0) {
        b.queue[0].ready = true;
        b.queue[0].readyUntil = addDay(D, PICKUP_DAYS);
      }
      return { ok: true, fine };
    } catch (e) {
      return fail();
    }
  }

  function renew(args) {
    try {
      if (!isArgs(args)) return fail();
      const memberId = args.memberId;
      const bookId = args.bookId;
      if (!isId(memberId) || !isId(bookId)) return fail();
      const D = step(args.date);
      if (D === null) return fail();

      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return fail();
      const loan = b.loan;
      if (!loan || loan.memberId !== memberId) return fail();
      if (D > loan.dueDay) return fail();
      if (loan.renewals >= MAX_RENEWALS) return fail();
      if (b.queue.length > 0) return fail();

      loan.dueDay = addDay(loan.dueDay, LOAN_DAYS);
      loan.renewals += 1;
      return { ok: true, dueDate: formatDay(loan.dueDay) };
    } catch (e) {
      return fail();
    }
  }

  function placeHold(args) {
    try {
      if (!isArgs(args)) return fail();
      const memberId = args.memberId;
      const bookId = args.bookId;
      if (!isId(memberId) || !isId(bookId)) return fail();
      const D = step(args.date);
      if (D === null) return fail();

      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return fail();
      // Available: no loan and empty queue.
      if (!b.loan && b.queue.length === 0) return fail();
      if (b.loan && b.loan.memberId === memberId) return fail();
      if (b.queue.some((h) => h.memberId === memberId)) return fail();

      b.queue.push({ memberId, seq: seqCounter++, ready: false, readyUntil: null });
      return { ok: true, position: b.queue.length };
    } catch (e) {
      return fail();
    }
  }

  function payFine(args) {
    try {
      if (!isArgs(args)) return fail();
      const memberId = args.memberId;
      const amount = args.amount;
      if (!isId(memberId)) return fail();
      if (!Number.isSafeInteger(amount) || amount <= 0) return fail();
      const D = step(args.date);
      if (D === null) return fail();

      const m = members.get(memberId);
      if (!m) return fail();
      if (amount > m.owed) return fail();

      m.owed -= amount;
      return { ok: true, owed: m.owed };
    } catch (e) {
      return fail();
    }
  }

  function getMember(args) {
    try {
      if (!isArgs(args)) return fail();
      const memberId = args.memberId;
      if (!isId(memberId)) return fail();
      const D = step(args.date);
      if (D === null) return fail();

      const m = members.get(memberId);
      if (!m) return fail();

      const loans = m.loans.map((bookId) => ({
        bookId,
        dueDate: formatDay(books.get(bookId).loan.dueDay),
      }));

      const found = [];
      for (const [bookId, book] of books) {
        book.queue.forEach((h, i) => {
          if (h.memberId === memberId) {
            found.push({
              seq: h.seq,
              bookId,
              position: i + 1,
              readyUntil: h.ready ? formatDay(h.readyUntil) : null,
            });
          }
        });
      }
      found.sort((x, y) => x.seq - y.seq);
      const holds = found.map(({ bookId, position, readyUntil }) => ({ bookId, position, readyUntil }));

      return { ok: true, loans, owed: m.owed, holds };
    } catch (e) {
      return fail();
    }
  }

  return { addBook, addMember, borrow, returnBook, renew, placeHold, payFine, getMember };
}
