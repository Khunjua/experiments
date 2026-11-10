const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const MAX_LOANS = 5;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 3;
const MAX_FINE = 1000;
const DEBT_LIMIT = 1000;
const PICKUP_DAYS = 7;

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y, m) {
  if (m === 2) return isLeap(y) ? 29 : 28;
  return MONTH_DAYS[m - 1];
}

// Days since 1970-01-01 for a proleptic Gregorian date (no Date object, no time zones).
function daysFromCivil(y, m, d) {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const doy = Math.floor((153 * (m > 2 ? m - 3 : m + 9) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

// Inverse of daysFromCivil. Returns [year, month, day].
function civilFromDays(z0) {
  const z = z0 + 719468;
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

function fmt(day) {
  const [y, m, d] = civilFromDays(day);
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// Returns a day number for a valid 'YYYY-MM-DD' string, otherwise null.
function parseDate(v) {
  if (typeof v !== 'string') return null;
  const mt = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!mt) return null;
  const y = Number(mt[1]);
  const m = Number(mt[2]);
  const d = Number(mt[3]);
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  return daysFromCivil(y, m, d);
}

const isId = (v) => typeof v === 'string' && v.length > 0;
const obj = (v) => (v !== null && typeof v === 'object' ? v : {});
const fail = (reason = 'not allowed') => ({ ok: false, reason });
const guard = (fn) => (args) => {
  try {
    return fn(args);
  } catch {
    return fail('error');
  }
};

export function createLibrary() {
  // bookId -> { loanTo: memberId|null, readyUntil: dayNum|null, queue: [{ memberId, seq }] }
  const books = new Map();
  // memberId -> { loans: [{ bookId, due, renewals }] (creation order), owed }
  const members = new Map();
  let lastDay = null;
  let holdSeq = 0;

  // Pickup expiry (§4.2), run for every book on every accepted date-bearing call.
  function expire(day) {
    for (const book of books.values()) {
      while (book.readyUntil !== null && day > book.readyUntil) {
        book.queue.shift();
        const next = book.readyUntil + 1;
        book.readyUntil = book.queue.length > 0 ? next + PICKUP_DAYS : null;
      }
    }
  }

  // Validates the date against the clock; if accepted, advances the clock and runs expiry.
  // Returns the day number, or null if the call must fail.
  function accept(dateStr) {
    const day = parseDate(dateStr);
    if (day === null) return null;
    if (lastDay !== null && day < lastDay) return null;
    lastDay = day;
    expire(day);
    return day;
  }

  const api = {
    addBook: guard((args) => {
      const { bookId } = obj(args);
      if (!isId(bookId) || books.has(bookId)) return fail();
      books.set(bookId, { loanTo: null, readyUntil: null, queue: [] });
      return { ok: true };
    }),

    addMember: guard((args) => {
      const { memberId } = obj(args);
      if (!isId(memberId) || members.has(memberId)) return fail();
      members.set(memberId, { loans: [], owed: 0 });
      return { ok: true };
    }),

    borrow: guard((args) => {
      const { memberId, bookId, date } = obj(args);
      if (!isId(memberId) || !isId(bookId)) return fail();
      const day = accept(date);
      if (day === null) return fail('bad date');
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return fail('unknown member or book');
      if (b.loanTo !== null) return fail('on loan');
      if (b.readyUntil !== null) {
        if (b.queue[0]?.memberId !== memberId) return fail('set aside for another member');
      } else if (b.queue.length > 0) {
        return fail('queue not empty');
      }
      if (m.owed >= DEBT_LIMIT) return fail('debt limit');
      if (m.loans.some((l) => l.due < day)) return fail('overdue loan');
      if (m.loans.length >= MAX_LOANS) return fail('loan limit');

      if (b.readyUntil !== null) b.queue.shift(); // this member's own hold is consumed
      b.readyUntil = null;
      b.loanTo = memberId;
      const due = day + LOAN_DAYS;
      m.loans.push({ bookId, due, renewals: 0 });
      return { ok: true, dueDate: fmt(due) };
    }),

    returnBook: guard((args) => {
      const { memberId, bookId, date } = obj(args);
      if (!isId(memberId) || !isId(bookId)) return fail();
      const day = accept(date);
      if (day === null) return fail('bad date');
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return fail('unknown member or book');
      const idx = m.loans.findIndex((l) => l.bookId === bookId);
      if (idx < 0 || b.loanTo !== memberId) return fail('not on loan to this member');

      const loan = m.loans[idx];
      const late = Math.max(0, day - loan.due);
      const fine = Math.min(MAX_FINE, FINE_PER_DAY * Math.max(0, late - GRACE_DAYS));
      m.owed += fine;
      m.loans.splice(idx, 1);

      b.loanTo = null;
      b.readyUntil = b.queue.length > 0 ? day + PICKUP_DAYS : null;
      return { ok: true, fine };
    }),

    renew: guard((args) => {
      const { memberId, bookId, date } = obj(args);
      if (!isId(memberId) || !isId(bookId)) return fail();
      const day = accept(date);
      if (day === null) return fail('bad date');
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return fail('unknown member or book');
      const loan = m.loans.find((l) => l.bookId === bookId);
      if (!loan || b.loanTo !== memberId) return fail('not on loan to this member');
      if (day > loan.due) return fail('overdue');
      if (loan.renewals >= MAX_RENEWALS) return fail('renewal limit');
      if (b.queue.length > 0) return fail('someone is waiting');
      if (m.owed >= DEBT_LIMIT) return fail('debt limit');

      loan.due += LOAN_DAYS;
      loan.renewals += 1;
      return { ok: true, dueDate: fmt(loan.due) };
    }),

    placeHold: guard((args) => {
      const { memberId, bookId, date } = obj(args);
      if (!isId(memberId) || !isId(bookId)) return fail();
      const day = accept(date);
      if (day === null) return fail('bad date');
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return fail('unknown member or book');
      if (b.loanTo === null && b.readyUntil === null) return fail('book is available');
      if (b.loanTo === memberId) return fail('member has this book on loan');
      if (b.queue.some((e) => e.memberId === memberId)) return fail('hold already exists');

      holdSeq += 1;
      b.queue.push({ memberId, seq: holdSeq });
      return { ok: true, position: b.queue.length };
    }),

    payFine: guard((args) => {
      const { memberId, amount, date } = obj(args);
      if (!isId(memberId) || !Number.isInteger(amount)) return fail();
      const day = accept(date);
      if (day === null) return fail('bad date');
      const m = members.get(memberId);
      if (!m) return fail('unknown member');
      if (amount < 1 || amount > m.owed) return fail('invalid amount');

      m.owed -= amount;
      return { ok: true, owed: m.owed };
    }),

    getMember: guard((args) => {
      const { memberId, date } = obj(args);
      if (!isId(memberId)) return fail('bad member id');
      const day = accept(date);
      if (day === null) return fail('bad date');
      const m = members.get(memberId);
      if (!m) return fail('unknown member');

      const loans = m.loans.map((l) => ({ bookId: l.bookId, dueDate: fmt(l.due) }));

      const found = [];
      for (const [bookId, b] of books) {
        b.queue.forEach((e, i) => {
          if (e.memberId !== memberId) return;
          const setAside = i === 0 && b.readyUntil !== null;
          found.push({
            seq: e.seq,
            bookId,
            position: i + 1,
            readyUntil: setAside ? fmt(b.readyUntil) : null,
          });
        });
      }
      found.sort((x, y) => x.seq - y.seq);
      const holds = found.map(({ bookId, position, readyUntil }) => ({
        bookId,
        position,
        readyUntil,
      }));

      return { loans, owed: m.owed, holds };
    }),
  };

  return api;
}
