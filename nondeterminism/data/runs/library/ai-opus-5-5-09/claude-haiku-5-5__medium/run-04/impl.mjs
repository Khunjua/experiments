const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const FINE_CAP = 500;
const BLOCK_THRESHOLD = 1000;
const PICKUP_DAYS = 7;

// Proleptic Gregorian day arithmetic (days since 1970-01-01, no time zones).
function daysFromCivil(y, m, d) {
  y -= m <= 2 ? 1 : 0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = (m + 9) % 12;
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

// Returns a day number, or null if the string is not a real YYYY-MM-DD date.
function parseDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (m < 1 || m > 12 || d < 1) return null;
  const z = daysFromCivil(y, m, d);
  const c = civilFromDays(z);
  if (c.y !== y || c.m !== m || c.d !== d) return null;
  return z;
}

function formatDay(z) {
  const c = civilFromDays(z);
  return String(c.y).padStart(4, '0') + '-' +
    String(c.m).padStart(2, '0') + '-' +
    String(c.d).padStart(2, '0');
}

function isObj(a) {
  return a !== null && typeof a === 'object';
}

function isId(x) {
  return typeof x === 'string' && x.length > 0;
}

function fail(reason = 'invalid') {
  return { ok: false, reason };
}

export function createLibrary() {
  // bookId -> { status, loan, queue }
  const books = new Map();
  // memberId -> { owed, loans, holds }
  const members = new Map();
  // Day number of the most recent accepted dated call, or null.
  let clock = null;

  // Step 2 and 3 of §3.5: check time order, set clock, expire holds.
  function advance(day) {
    if (clock !== null && day < clock) return false;
    clock = day;
    expire(day);
    return true;
  }

  // §5.2: a book stops being held and goes to the queue or the shelf on day startDay.
  function offerBook(book, startDay) {
    book.loan = null;
    if (book.queue.length === 0) {
      book.status = 'available';
      return;
    }
    book.status = 'readyForPickup';
    book.queue[0].readyUntil = startDay + PICKUP_DAYS;
  }

  // §5.3: process hold expirations strictly before day.
  function expire(day) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const book of books.values()) {
        if (book.status !== 'readyForPickup') continue;
        const h = book.queue[0];
        if (h.readyUntil < day) {
          book.queue.shift();
          const m = members.get(h.memberId);
          const idx = m.holds.indexOf(h);
          if (idx !== -1) m.holds.splice(idx, 1);
          offerBook(book, h.readyUntil + 1);
          changed = true;
        }
      }
    }
  }

  return {
    addBook(args) {
      if (!isObj(args) || !isId(args.bookId)) return fail();
      if (books.has(args.bookId)) return fail('exists');
      books.set(args.bookId, { status: 'available', loan: null, queue: [] });
      return { ok: true };
    },

    addMember(args) {
      if (!isObj(args) || !isId(args.memberId)) return fail();
      if (members.has(args.memberId)) return fail('exists');
      members.set(args.memberId, { owed: 0, loans: [], holds: [] });
      return { ok: true };
    },

    borrow(args) {
      if (!isObj(args) || !isId(args.memberId) || !isId(args.bookId)) return fail();
      const day = parseDate(args.date);
      if (day === null) return fail();
      if (!advance(day)) return fail('time');

      const m = members.get(args.memberId);
      const b = books.get(args.bookId);
      if (!m || !b) return fail();
      if (m.owed >= BLOCK_THRESHOLD) return fail('blocked');
      if (b.status === 'onLoan') return fail('onLoan');

      if (b.status === 'readyForPickup') {
        if (b.queue[0].memberId !== args.memberId) return fail('reserved');
        const h = b.queue.shift();
        const idx = m.holds.indexOf(h);
        if (idx !== -1) m.holds.splice(idx, 1);
      } else if (b.queue.length > 0) {
        return fail('inconsistent');
      }

      const loan = {
        memberId: args.memberId,
        bookId: args.bookId,
        due: day + LOAN_DAYS,
        renewals: 0,
      };
      m.loans.push(loan);
      b.loan = loan;
      b.status = 'onLoan';
      return { ok: true, dueDate: formatDay(loan.due) };
    },

    returnBook(args) {
      if (!isObj(args) || !isId(args.memberId) || !isId(args.bookId)) return fail();
      const day = parseDate(args.date);
      if (day === null) return fail();
      if (!advance(day)) return fail('time');

      const m = members.get(args.memberId);
      const b = books.get(args.bookId);
      if (!m || !b) return fail();
      if (b.status !== 'onLoan' || !b.loan || b.loan.memberId !== args.memberId) {
        return fail('notOnLoan');
      }

      const loan = b.loan;
      const late = day - loan.due;
      const fine = late > 0 ? Math.min(late * FINE_PER_DAY, FINE_CAP) : 0;

      m.owed += fine;
      const idx = m.loans.indexOf(loan);
      if (idx !== -1) m.loans.splice(idx, 1);
      offerBook(b, day);
      return { ok: true, fine };
    },

    renew(args) {
      if (!isObj(args) || !isId(args.memberId) || !isId(args.bookId)) return fail();
      const day = parseDate(args.date);
      if (day === null) return fail();
      if (!advance(day)) return fail('time');

      const m = members.get(args.memberId);
      const b = books.get(args.bookId);
      if (!m || !b) return fail();
      if (b.status !== 'onLoan' || !b.loan || b.loan.memberId !== args.memberId) {
        return fail('notOnLoan');
      }
      if (b.queue.length > 0) return fail('waiting');

      const loan = b.loan;
      if (loan.renewals >= MAX_RENEWALS) return fail('maxRenewals');
      if (day > loan.due) return fail('overdue');
      if (m.owed >= BLOCK_THRESHOLD) return fail('blocked');

      loan.due += LOAN_DAYS;
      loan.renewals += 1;
      return { ok: true, dueDate: formatDay(loan.due) };
    },

    placeHold(args) {
      if (!isObj(args) || !isId(args.memberId) || !isId(args.bookId)) return fail();
      const day = parseDate(args.date);
      if (day === null) return fail();
      if (!advance(day)) return fail('time');

      const m = members.get(args.memberId);
      const b = books.get(args.bookId);
      if (!m || !b) return fail();
      if (b.status === 'available') return fail('available');
      if (b.status === 'onLoan' && b.loan && b.loan.memberId === args.memberId) {
        return fail('alreadyBorrowed');
      }
      if (b.queue.some((h) => h.memberId === args.memberId)) return fail('alreadyHeld');

      const hold = { bookId: args.bookId, memberId: args.memberId, readyUntil: null };
      b.queue.push(hold);
      m.holds.push(hold);
      return { ok: true, position: b.queue.length };
    },

    payFine(args) {
      if (!isObj(args) || !isId(args.memberId)) return fail();
      if (!Number.isInteger(args.amount) || args.amount <= 0) return fail();
      const day = parseDate(args.date);
      if (day === null) return fail();
      if (!advance(day)) return fail('time');

      const m = members.get(args.memberId);
      if (!m) return fail();
      if (args.amount > m.owed) return fail('overpayment');

      m.owed -= args.amount;
      return { ok: true, owed: m.owed };
    },

    getMember(args) {
      if (!isObj(args) || !isId(args.memberId)) return fail();
      const day = parseDate(args.date);
      if (day === null) return fail();
      if (!advance(day)) return fail('time');

      const m = members.get(args.memberId);
      if (!m) return fail();

      return {
        loans: m.loans.map((l) => ({
          bookId: l.bookId,
          dueDate: formatDay(l.due),
        })),
        owed: m.owed,
        holds: m.holds.map((h) => {
          const b = books.get(h.bookId);
          return {
            bookId: h.bookId,
            position: b.queue.indexOf(h) + 1,
            readyUntil: h.readyUntil === null ? null : formatDay(h.readyUntil),
          };
        }),
      };
    },
  };
}
