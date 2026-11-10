const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const MAX_FINE_PER_LOAN = 1000;
const GRACE_DAYS = 0;
const BORROW_BLOCK_OWED = 1000;
const MAX_LOANS = 5;
const MAX_HOLDS = 5;
const PICKUP_DAYS = 7;

function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y, m) {
  return [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

// Days since 1970-01-01 (proleptic Gregorian), integer.
function daysFromCivil(y, m, d) {
  y -= m <= 2 ? 1 : 0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (m > 2 ? m - 3 : m + 9) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(z) {
  z += 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
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

function formatDay(n) {
  const [y, m, d] = civilFromDays(n);
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// Returns day number for a valid 'YYYY-MM-DD' string, or null.
function parseDate(s) {
  if (typeof s !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (y < 1 || m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  return daysFromCivil(y, m, d);
}

export function createLibrary() {
  const books = new Map();
  const members = new Map();
  let latest = null;

  const fail = () => ({ ok: false });
  const isId = (v) => typeof v === 'string' && v.length > 0;
  const argsOf = (a) => (a && typeof a === 'object' ? a : {});
  const findBook = (id) => (isId(id) ? books.get(id) : undefined);
  const findMember = (id) => (isId(id) ? members.get(id) : undefined);

  // Hold-expiry processing up to day D (section 6.4).
  function runExpiry(D) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const book of books.values()) {
        if (book.status === 'setAside' && book.readyUntil < D) {
          const holder = members.get(book.holder);
          if (holder) {
            holder.holds = holder.holds.filter((h) => h.bookId !== book.id);
          }
          const start = book.readyUntil + 1;
          if (book.queue.length > 0) {
            book.holder = book.queue.shift();
            book.readyUntil = start + PICKUP_DAYS;
          } else {
            book.status = 'shelf';
            book.holder = null;
            book.readyUntil = null;
          }
          changed = true;
        }
      }
    }
  }

  // Validates the date, enforces ordering, updates latest and runs expiry.
  // Returns the day number, or null if the call must be rejected.
  function advance(a) {
    const D = parseDate(a.date);
    if (D === null) return null;
    if (latest !== null && D < latest) return null;
    latest = D;
    runExpiry(D);
    return D;
  }

  return {
    addBook(args) {
      const a = argsOf(args);
      if (!isId(a.bookId) || books.has(a.bookId)) return fail();
      books.set(a.bookId, {
        id: a.bookId,
        status: 'shelf',
        holder: null,
        readyUntil: null,
        queue: [],
      });
      return { ok: true };
    },

    addMember(args) {
      const a = argsOf(args);
      if (!isId(a.memberId) || members.has(a.memberId)) return fail();
      members.set(a.memberId, { owed: 0, loans: new Map(), holds: [] });
      return { ok: true };
    },

    borrow(args) {
      const a = argsOf(args);
      const D = advance(a);
      if (D === null) return fail();
      const m = findMember(a.memberId);
      const b = findBook(a.bookId);
      if (!m || !b) return fail();
      if (b.status === 'loan') return fail();
      if (b.status === 'setAside' && b.holder !== a.memberId) return fail();
      if (b.status === 'shelf' && b.queue.length > 0) return fail();
      if (m.loans.size >= MAX_LOANS) return fail();
      if (m.owed >= BORROW_BLOCK_OWED) return fail();

      if (b.status === 'setAside') {
        m.holds = m.holds.filter((h) => h.bookId !== b.id);
        b.readyUntil = null;
      }
      const dueDay = D + LOAN_DAYS;
      m.loans.set(b.id, { dueDay, renewals: 0 });
      b.status = 'loan';
      b.holder = a.memberId;
      return { ok: true, dueDate: formatDay(dueDay) };
    },

    returnBook(args) {
      const a = argsOf(args);
      const D = advance(a);
      if (D === null) return fail();
      const m = findMember(a.memberId);
      const b = findBook(a.bookId);
      if (!m || !b) return fail();
      if (b.status !== 'loan' || b.holder !== a.memberId) return fail();
      const loan = m.loans.get(b.id);
      if (!loan) return fail();

      const daysLate = Math.max(0, D - loan.dueDay - GRACE_DAYS);
      const fine = Math.min(daysLate * FINE_PER_DAY, MAX_FINE_PER_LOAN);
      m.owed += fine;
      m.loans.delete(b.id);

      b.holder = null;
      if (b.queue.length > 0) {
        b.holder = b.queue.shift();
        b.status = 'setAside';
        b.readyUntil = D + PICKUP_DAYS;
      } else {
        b.status = 'shelf';
        b.readyUntil = null;
      }
      return { ok: true, fine };
    },

    renew(args) {
      const a = argsOf(args);
      const D = advance(a);
      if (D === null) return fail();
      const m = findMember(a.memberId);
      const b = findBook(a.bookId);
      if (!m || !b) return fail();
      if (b.status !== 'loan' || b.holder !== a.memberId) return fail();
      const loan = m.loans.get(b.id);
      if (!loan) return fail();
      if (loan.renewals >= MAX_RENEWALS) return fail();
      if (D > loan.dueDay) return fail();
      if (b.queue.length > 0) return fail();

      loan.dueDay = D + LOAN_DAYS;
      loan.renewals += 1;
      return { ok: true, dueDate: formatDay(loan.dueDay) };
    },

    placeHold(args) {
      const a = argsOf(args);
      const D = advance(a);
      if (D === null) return fail();
      const m = findMember(a.memberId);
      const b = findBook(a.bookId);
      if (!m || !b) return fail();
      if (b.status === 'shelf') return fail();
      if (b.status === 'loan' && b.holder === a.memberId) return fail();
      if (b.status === 'setAside' && b.holder === a.memberId) return fail();
      if (b.queue.includes(a.memberId)) return fail();
      if (m.holds.length >= MAX_HOLDS) return fail();

      b.queue.push(a.memberId);
      m.holds.push({ bookId: b.id });
      const position = b.queue.length + (b.status === 'setAside' ? 1 : 0);
      return { ok: true, position };
    },

    payFine(args) {
      const a = argsOf(args);
      const D = advance(a);
      if (D === null) return fail();
      const m = findMember(a.memberId);
      if (!m) return fail();
      if (!Number.isInteger(a.amount) || a.amount <= 0) return fail();
      if (a.amount > m.owed) return fail();
      m.owed -= a.amount;
      return { ok: true, owed: m.owed };
    },

    getMember(args) {
      const a = argsOf(args);
      const D = advance(a);
      if (D === null) return fail();
      const m = findMember(a.memberId);
      if (!m) return fail();

      const loans = [];
      for (const [bookId, loan] of m.loans) {
        loans.push({ bookId, dueDate: formatDay(loan.dueDay) });
      }

      const holds = m.holds.map((h) => {
        const b = books.get(h.bookId);
        if (b.status === 'setAside' && b.holder === a.memberId) {
          return { bookId: b.id, position: 1, readyUntil: formatDay(b.readyUntil) };
        }
        const idx = b.queue.indexOf(a.memberId);
        const position = idx + 1 + (b.status === 'setAside' ? 1 : 0);
        return { bookId: b.id, position, readyUntil: null };
      });

      return { loans, owed: m.owed, holds };
    },
  };
}
