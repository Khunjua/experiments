const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const RENEWAL_DAYS = 21;
const FINE_PER_DAY = 25;
const MAX_FINE = 500;
const FINE_BLOCK_THRESHOLD = 500;
const MAX_LOANS = 5;
const PICKUP_DAYS = 7;

function fail(reason) {
  return { ok: false, reason };
}

function isObject(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

function isId(x) {
  return typeof x === 'string' && x.length > 0;
}

function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y, m) {
  return [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

// Days since 1970-01-01 (proleptic Gregorian), civil-from-days algorithm.
function toDay(y, m, d) {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const mp = m > 2 ? m - 3 : m + 9;
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function fromDay(n) {
  const z = n + 719468;
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
  return { y, m, d };
}

function fmt(n) {
  const { y, m, d } = fromDay(n);
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// Returns integer day number, or null if the string is not a real YYYY-MM-DD date.
function parseDay(s) {
  if (typeof s !== 'string') return null;
  const mt = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!mt) return null;
  const y = Number(mt[1]);
  const m = Number(mt[2]);
  const d = Number(mt[3]);
  if (m < 1 || m > 12) return null;
  if (d < 1 || d > daysInMonth(y, m)) return null;
  return toDay(y, m, d);
}

function guard(fn) {
  return (arg) => {
    try {
      return fn(arg);
    } catch {
      return fail('invalid_input');
    }
  };
}

export function createLibrary() {
  // bookId -> { status: 'available' | 'on_loan' | 'set_aside', borrower, queue: [{ memberId, seq }], readyUntil }
  const books = new Map();
  // memberId -> { owed, loans: [{ bookId, dueDay, renewCount }] }
  const members = new Map();
  let latest = null;
  let seqCounter = 0;

  // Applies pickup expiry for date `day` (§7).
  function expire(day) {
    for (const book of books.values()) {
      while (book.status === 'set_aside' && book.readyUntil < day) {
        book.queue.shift();
        if (book.queue.length === 0) {
          book.status = 'available';
          book.readyUntil = null;
        } else {
          book.readyUntil += PICKUP_DAYS;
        }
      }
    }
  }

  // Time-order check, then record the date and apply expiry.
  // Returns a failure object, or null when the call may proceed.
  function admitDate(day) {
    if (latest !== null && day < latest) return fail('date_out_of_order');
    latest = day;
    expire(day);
    return null;
  }

  function findLoan(member, bookId) {
    return member.loans.find((l) => l.bookId === bookId) || null;
  }

  return {
    addBook: guard((arg) => {
      if (!isObject(arg) || !isId(arg.bookId)) return fail('invalid_input');
      const bookId = arg.bookId;
      if (books.has(bookId)) return fail('book_exists');
      books.set(bookId, { status: 'available', borrower: null, queue: [], readyUntil: null });
      return { ok: true };
    }),

    addMember: guard((arg) => {
      if (!isObject(arg) || !isId(arg.memberId)) return fail('invalid_input');
      const memberId = arg.memberId;
      if (members.has(memberId)) return fail('member_exists');
      members.set(memberId, { owed: 0, loans: [] });
      return { ok: true };
    }),

    borrow: guard((arg) => {
      if (!isObject(arg)) return fail('invalid_input');
      const { memberId, bookId, date } = arg;
      if (!isId(memberId) || !isId(bookId)) return fail('invalid_input');
      const day = parseDay(date);
      if (day === null) return fail('invalid_input');
      const bad = admitDate(day);
      if (bad) return bad;

      const m = members.get(memberId);
      if (!m) return fail('unknown_member');
      const b = books.get(bookId);
      if (!b) return fail('unknown_book');

      if (b.status === 'on_loan') {
        return fail(b.borrower === memberId ? 'already_borrowed' : 'not_available');
      }
      if (b.status === 'set_aside' && b.queue[0].memberId !== memberId) {
        return fail('reserved_for_other');
      }
      if (m.loans.some((l) => day > l.dueDay)) return fail('overdue_loans');
      if (m.owed >= FINE_BLOCK_THRESHOLD) return fail('fines_owed');
      if (m.loans.length >= MAX_LOANS) return fail('loan_limit');

      const dueDay = day + LOAN_DAYS;
      m.loans.push({ bookId, dueDay, renewCount: 0 });
      if (b.status === 'set_aside') {
        b.queue.shift();
      }
      b.status = 'on_loan';
      b.borrower = memberId;
      b.readyUntil = null;
      return { ok: true, dueDate: fmt(dueDay) };
    }),

    returnBook: guard((arg) => {
      if (!isObject(arg)) return fail('invalid_input');
      const { memberId, bookId, date } = arg;
      if (!isId(memberId) || !isId(bookId)) return fail('invalid_input');
      const day = parseDay(date);
      if (day === null) return fail('invalid_input');
      const bad = admitDate(day);
      if (bad) return bad;

      const m = members.get(memberId);
      if (!m) return fail('unknown_member');
      const b = books.get(bookId);
      if (!b) return fail('unknown_book');
      const idx = m.loans.findIndex((l) => l.bookId === bookId);
      if (idx < 0) return fail('not_borrowed');

      const loan = m.loans[idx];
      const daysLate = Math.max(0, day - loan.dueDay);
      const fine = Math.min(FINE_PER_DAY * daysLate, MAX_FINE);
      m.owed += fine;
      m.loans.splice(idx, 1);

      b.borrower = null;
      if (b.queue.length === 0) {
        b.status = 'available';
        b.readyUntil = null;
      } else {
        b.status = 'set_aside';
        b.readyUntil = day + PICKUP_DAYS;
      }
      return { ok: true, fine };
    }),

    renew: guard((arg) => {
      if (!isObject(arg)) return fail('invalid_input');
      const { memberId, bookId, date } = arg;
      if (!isId(memberId) || !isId(bookId)) return fail('invalid_input');
      const day = parseDay(date);
      if (day === null) return fail('invalid_input');
      const bad = admitDate(day);
      if (bad) return bad;

      const m = members.get(memberId);
      if (!m) return fail('unknown_member');
      const b = books.get(bookId);
      if (!b) return fail('unknown_book');
      const loan = findLoan(m, bookId);
      if (!loan) return fail('not_borrowed');
      if (day > loan.dueDay) return fail('overdue');
      if (loan.renewCount >= MAX_RENEWALS) return fail('renewal_limit');
      if (b.queue.length > 0) return fail('has_holds');

      loan.dueDay += RENEWAL_DAYS;
      loan.renewCount += 1;
      return { ok: true, dueDate: fmt(loan.dueDay) };
    }),

    placeHold: guard((arg) => {
      if (!isObject(arg)) return fail('invalid_input');
      const { memberId, bookId, date } = arg;
      if (!isId(memberId) || !isId(bookId)) return fail('invalid_input');
      const day = parseDay(date);
      if (day === null) return fail('invalid_input');
      const bad = admitDate(day);
      if (bad) return bad;

      const m = members.get(memberId);
      if (!m) return fail('unknown_member');
      const b = books.get(bookId);
      if (!b) return fail('unknown_book');
      if (findLoan(m, bookId)) return fail('already_borrowed');
      if (b.queue.some((e) => e.memberId === memberId)) return fail('already_held');
      if (b.status === 'available') return fail('book_available');

      b.queue.push({ memberId, seq: seqCounter++ });
      return { ok: true, position: b.queue.length };
    }),

    payFine: guard((arg) => {
      if (!isObject(arg)) return fail('invalid_input');
      const { memberId, amount, date } = arg;
      if (!isId(memberId)) return fail('invalid_input');
      if (!Number.isInteger(amount) || amount <= 0) return fail('invalid_input');
      const day = parseDay(date);
      if (day === null) return fail('invalid_input');
      const bad = admitDate(day);
      if (bad) return bad;

      const m = members.get(memberId);
      if (!m) return fail('unknown_member');
      if (amount > m.owed) return fail('overpayment');

      m.owed -= amount;
      return { ok: true, owed: m.owed };
    }),

    getMember: guard((arg) => {
      if (!isObject(arg)) return fail('invalid_input');
      const { memberId, date } = arg;
      if (!isId(memberId)) return fail('invalid_input');
      const day = parseDay(date);
      if (day === null) return fail('invalid_input');
      const bad = admitDate(day);
      if (bad) return bad;

      const m = members.get(memberId);
      if (!m) return fail('unknown_member');

      const loans = m.loans.map((l) => ({ bookId: l.bookId, dueDate: fmt(l.dueDay) }));

      const found = [];
      for (const [bookId, b] of books) {
        b.queue.forEach((e, i) => {
          if (e.memberId !== memberId) return;
          const readyUntil =
            b.status === 'set_aside' && i === 0 ? fmt(b.readyUntil) : null;
          found.push({
            seq: e.seq,
            entry: { bookId, position: i + 1, readyUntil },
          });
        });
      }
      found.sort((x, y) => x.seq - y.seq);
      const holds = found.map((f) => f.entry);

      return { ok: true, loans, owed: m.owed, holds };
    }),
  };
}
