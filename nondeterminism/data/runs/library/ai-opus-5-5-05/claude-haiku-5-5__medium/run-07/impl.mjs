const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const MAX_LOANS = 5;
const LATE_FEE = 25;
const GRACE_DAYS = 2;
const MAX_FINE = 1000;
const BLOCK_OWED = 500;
const PICKUP_DAYS = 7;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

// Days since 1970-01-01 for a proleptic Gregorian date (pure calendar arithmetic).
function daysFromCivil(y, m, d) {
  if (m <= 2) y -= 1;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = m > 2 ? m - 3 : m + 9;
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1;
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
  let y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  if (m <= 2) y += 1;
  return { y, m, d };
}

function parseDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (y < 1 || m < 1 || m > 12) return null;
  const dim = m === 2 && isLeap(y) ? 29 : MONTH_DAYS[m - 1];
  if (d < 1 || d > dim) return null;
  return daysFromCivil(y, m, d);
}

function fmt(dn) {
  const { y, m, d } = civilFromDays(dn);
  const ys = y < 1000 ? String(y).padStart(4, '0') : String(y);
  return `${ys}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function isObj(x) {
  return typeof x === 'object' && x !== null;
}

function isId(x) {
  return typeof x === 'string' && x.length > 0;
}

export function createLibrary() {
  const books = new Map();   // bookId -> { id, status, borrower, queue, readyUntil }
  const members = new Map(); // memberId -> { id, loans: Map(bookId -> {dueDay, renewals}), owed, holds: Map(bookId -> true) }
  let clock = null;          // day number of the library's current date

  function fail(reason) {
    return { ok: false, reason };
  }

  function processExpiry(day) {
    for (const b of books.values()) {
      while (b.status === 'set' && day > b.readyUntil) {
        const expired = b.queue.shift();
        members.get(expired).holds.delete(b.id);
        if (b.queue.length === 0) {
          b.status = 'available';
          b.readyUntil = null;
        } else {
          b.readyUntil = b.readyUntil + PICKUP_DAYS + 1;
        }
      }
    }
  }

  // Validates input, applies the clock step and expiry processing for dated calls.
  // Returns { error } on failure or the parsed fields on success.
  function prepare(args, needs) {
    if (!isObj(args)) return { error: 'invalid input' };
    const out = {};
    if (needs.member) {
      if (!isId(args.memberId)) return { error: 'invalid memberId' };
      out.memberId = args.memberId;
    }
    if (needs.book) {
      if (!isId(args.bookId)) return { error: 'invalid bookId' };
      out.bookId = args.bookId;
    }
    const day = parseDate(args.date);
    if (day === null) return { error: 'invalid date' };
    if (needs.amount) {
      if (!Number.isSafeInteger(args.amount) || args.amount <= 0) {
        return { error: 'invalid amount' };
      }
      out.amount = args.amount;
    }
    if (clock !== null && day < clock) return { error: 'date earlier than library clock' };
    clock = day;
    processExpiry(day);
    out.day = day;
    return out;
  }

  function guard(fn) {
    return (args) => {
      try {
        return fn(args);
      } catch {
        return { ok: false, reason: 'internal error' };
      }
    };
  }

  const api = {
    addBook: guard((args) => {
      if (!isObj(args) || !isId(args.bookId)) return fail('invalid bookId');
      if (books.has(args.bookId)) return fail('book exists');
      books.set(args.bookId, {
        id: args.bookId,
        status: 'available',
        borrower: null,
        queue: [],
        readyUntil: null,
      });
      return { ok: true };
    }),

    addMember: guard((args) => {
      if (!isObj(args) || !isId(args.memberId)) return fail('invalid memberId');
      if (members.has(args.memberId)) return fail('member exists');
      members.set(args.memberId, {
        id: args.memberId,
        loans: new Map(),
        owed: 0,
        holds: new Map(),
      });
      return { ok: true };
    }),

    borrow: guard((args) => {
      const p = prepare(args, { member: true, book: true });
      if (p.error) return fail(p.error);
      const m = members.get(p.memberId);
      const b = books.get(p.bookId);
      if (!m || !b) return fail('unknown member or book');
      if (b.status === 'loan') return fail('book on loan');
      if (b.status === 'set' && b.queue[0] !== p.memberId) return fail('set aside for another member');
      if (m.loans.size >= MAX_LOANS) return fail('loan limit reached');
      if (m.owed >= BLOCK_OWED) return fail('borrowing blocked by owed amount');

      if (b.status === 'set') {
        b.queue.shift();
        m.holds.delete(p.bookId);
      }
      b.status = 'loan';
      b.borrower = p.memberId;
      b.readyUntil = null;

      const dueDay = p.day + LOAN_DAYS;
      m.loans.set(p.bookId, { dueDay, renewals: 0 });
      return { ok: true, dueDate: fmt(dueDay) };
    }),

    renew: guard((args) => {
      const p = prepare(args, { member: true, book: true });
      if (p.error) return fail(p.error);
      const m = members.get(p.memberId);
      const b = books.get(p.bookId);
      if (!m || !b) return fail('unknown member or book');
      const loan = m.loans.get(p.bookId);
      if (!loan) return fail('not on loan to member');
      if (loan.renewals >= MAX_RENEWALS) return fail('renewal limit reached');
      if (b.queue.length > 0) return fail('book has waiting holds');
      if (p.day > loan.dueDay) return fail('loan overdue');
      const newDue = p.day + LOAN_DAYS;
      if (newDue <= loan.dueDay) return fail('renewal does not extend loan');
      loan.dueDay = newDue;
      loan.renewals += 1;
      return { ok: true, dueDate: fmt(newDue) };
    }),

    returnBook: guard((args) => {
      const p = prepare(args, { member: true, book: true });
      if (p.error) return fail(p.error);
      const m = members.get(p.memberId);
      const b = books.get(p.bookId);
      if (!m || !b) return fail('unknown member or book');
      const loan = m.loans.get(p.bookId);
      if (!loan) return fail('not on loan to member');

      const daysLate = p.day - loan.dueDay;
      const chargeable = Math.max(0, daysLate - GRACE_DAYS);
      const fine = Math.min(LATE_FEE * chargeable, MAX_FINE);

      m.loans.delete(p.bookId);
      m.owed += fine;
      b.borrower = null;
      if (b.queue.length === 0) {
        b.status = 'available';
        b.readyUntil = null;
      } else {
        b.status = 'set';
        b.readyUntil = p.day + PICKUP_DAYS;
      }
      return { ok: true, fine };
    }),

    placeHold: guard((args) => {
      const p = prepare(args, { member: true, book: true });
      if (p.error) return fail(p.error);
      const m = members.get(p.memberId);
      const b = books.get(p.bookId);
      if (!m || !b) return fail('unknown member or book');
      if (b.status === 'available') return fail('book is available');
      if (b.borrower === p.memberId || m.loans.has(p.bookId)) return fail('member has this book');
      if (m.holds.has(p.bookId)) return fail('hold already exists');
      b.queue.push(p.memberId);
      m.holds.set(p.bookId, true);
      return { ok: true, position: b.queue.length };
    }),

    payFine: guard((args) => {
      const p = prepare(args, { member: true, amount: true });
      if (p.error) return fail(p.error);
      const m = members.get(p.memberId);
      if (!m) return fail('unknown member');
      if (p.amount > m.owed) return fail('overpayment');
      m.owed -= p.amount;
      return { ok: true, owed: m.owed };
    }),

    getMember: guard((args) => {
      const p = prepare(args, { member: true });
      if (p.error) return fail(p.error);
      const m = members.get(p.memberId);
      if (!m) return fail('unknown member');

      const loans = [];
      for (const [bookId, loan] of m.loans) {
        loans.push({ bookId, dueDate: fmt(loan.dueDay) });
      }

      const holds = [];
      for (const bookId of m.holds.keys()) {
        const b = books.get(bookId);
        const idx = b.queue.indexOf(p.memberId);
        const setAside = b.status === 'set' && idx === 0;
        holds.push({
          bookId,
          position: idx + 1,
          readyUntil: setAside ? fmt(b.readyUntil) : null,
        });
      }

      return { ok: true, loans, owed: m.owed, holds };
    }),
  };

  return api;
}
