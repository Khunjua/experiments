const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const RENEW_DAYS = 21;
const FINE_PER_DAY = 25;
const MAX_FINE = 500;
const FINE_BLOCK = 500;
const MAX_LOANS = 5;
const PICKUP_DAYS = 7;
const MS_PER_DAY = 86400000;

function isObject(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

function isId(x) {
  return typeof x === 'string' && x.length > 0;
}

function isAmount(x) {
  return Number.isSafeInteger(x) && x > 0;
}

// Returns the day number (days since 1970-01-01) or null if invalid.
function parseDay(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const t = new Date(0);
  t.setUTCFullYear(y, mo - 1, d);
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) {
    return null;
  }
  return t.getTime() / MS_PER_DAY;
}

function dayStr(n) {
  return new Date(n * MS_PER_DAY).toISOString().slice(0, 10);
}

export function createLibrary() {
  // bookId -> { status: 'available' | 'on_loan' | 'set_aside', borrower, queue: [{ memberId, seq }], readyUntil }
  const books = new Map();
  // memberId -> { owed, loans: [{ bookId, dueDay, renewCount }] }
  const members = new Map();
  let latest = null;
  let seqCounter = 0;

  const fail = (reason) => ({ ok: false, reason });

  const guard = (fn) => {
    try {
      return fn();
    } catch {
      return fail('invalid_input');
    }
  };

  // Resolves every set-aside book whose pickup window ended before day.
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

  // Called only after a valid, in-order date has been confirmed.
  function advance(day) {
    latest = day;
    expire(day);
  }

  function outOfOrder(day) {
    return latest !== null && day < latest;
  }

  return {
    addBook(arg) {
      return guard(() => {
        if (!isObject(arg) || !isId(arg.bookId)) return fail('invalid_input');
        const bookId = arg.bookId;
        if (books.has(bookId)) return fail('book_exists');
        books.set(bookId, { status: 'available', borrower: null, queue: [], readyUntil: null });
        return { ok: true };
      });
    },

    addMember(arg) {
      return guard(() => {
        if (!isObject(arg) || !isId(arg.memberId)) return fail('invalid_input');
        const memberId = arg.memberId;
        if (members.has(memberId)) return fail('member_exists');
        members.set(memberId, { owed: 0, loans: [] });
        return { ok: true };
      });
    },

    borrow(arg) {
      return guard(() => {
        if (!isObject(arg)) return fail('invalid_input');
        const memberId = arg.memberId;
        const bookId = arg.bookId;
        if (!isId(memberId) || !isId(bookId)) return fail('invalid_input');
        const day = parseDay(arg.date);
        if (day === null) return fail('invalid_input');
        if (outOfOrder(day)) return fail('date_out_of_order');
        advance(day);

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
        if (m.owed >= FINE_BLOCK) return fail('fines_owed');
        if (m.loans.length >= MAX_LOANS) return fail('loan_limit');

        if (b.status === 'set_aside') {
          b.queue.shift();
        }
        const dueDay = day + LOAN_DAYS;
        b.status = 'on_loan';
        b.borrower = memberId;
        b.readyUntil = null;
        m.loans.push({ bookId, dueDay, renewCount: 0 });
        return { ok: true, dueDate: dayStr(dueDay) };
      });
    },

    returnBook(arg) {
      return guard(() => {
        if (!isObject(arg)) return fail('invalid_input');
        const memberId = arg.memberId;
        const bookId = arg.bookId;
        if (!isId(memberId) || !isId(bookId)) return fail('invalid_input');
        const day = parseDay(arg.date);
        if (day === null) return fail('invalid_input');
        if (outOfOrder(day)) return fail('date_out_of_order');
        advance(day);

        const m = members.get(memberId);
        if (!m) return fail('unknown_member');
        const b = books.get(bookId);
        if (!b) return fail('unknown_book');

        const idx = m.loans.findIndex((l) => l.bookId === bookId);
        if (idx < 0 || b.borrower !== memberId) return fail('not_borrowed');

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
      });
    },

    renew(arg) {
      return guard(() => {
        if (!isObject(arg)) return fail('invalid_input');
        const memberId = arg.memberId;
        const bookId = arg.bookId;
        if (!isId(memberId) || !isId(bookId)) return fail('invalid_input');
        const day = parseDay(arg.date);
        if (day === null) return fail('invalid_input');
        if (outOfOrder(day)) return fail('date_out_of_order');
        advance(day);

        const m = members.get(memberId);
        if (!m) return fail('unknown_member');
        const b = books.get(bookId);
        if (!b) return fail('unknown_book');

        const loan = m.loans.find((l) => l.bookId === bookId);
        if (!loan || b.borrower !== memberId) return fail('not_borrowed');
        if (day > loan.dueDay) return fail('overdue');
        if (loan.renewCount >= MAX_RENEWALS) return fail('renewal_limit');
        if (b.queue.length > 0) return fail('has_holds');

        loan.dueDay += RENEW_DAYS;
        loan.renewCount += 1;
        return { ok: true, dueDate: dayStr(loan.dueDay) };
      });
    },

    placeHold(arg) {
      return guard(() => {
        if (!isObject(arg)) return fail('invalid_input');
        const memberId = arg.memberId;
        const bookId = arg.bookId;
        if (!isId(memberId) || !isId(bookId)) return fail('invalid_input');
        const day = parseDay(arg.date);
        if (day === null) return fail('invalid_input');
        if (outOfOrder(day)) return fail('date_out_of_order');
        advance(day);

        const m = members.get(memberId);
        if (!m) return fail('unknown_member');
        const b = books.get(bookId);
        if (!b) return fail('unknown_book');

        if (m.loans.some((l) => l.bookId === bookId)) return fail('already_borrowed');
        if (b.queue.some((e) => e.memberId === memberId)) return fail('already_held');
        if (b.status === 'available') return fail('book_available');

        b.queue.push({ memberId, seq: ++seqCounter });
        return { ok: true, position: b.queue.length };
      });
    },

    payFine(arg) {
      return guard(() => {
        if (!isObject(arg)) return fail('invalid_input');
        const memberId = arg.memberId;
        const amount = arg.amount;
        if (!isId(memberId) || !isAmount(amount)) return fail('invalid_input');
        const day = parseDay(arg.date);
        if (day === null) return fail('invalid_input');
        if (outOfOrder(day)) return fail('date_out_of_order');
        advance(day);

        const m = members.get(memberId);
        if (!m) return fail('unknown_member');
        if (amount > m.owed) return fail('overpayment');

        m.owed -= amount;
        return { ok: true, owed: m.owed };
      });
    },

    getMember(arg) {
      return guard(() => {
        if (!isObject(arg)) return fail('invalid_input');
        const memberId = arg.memberId;
        if (!isId(memberId)) return fail('invalid_input');
        const day = parseDay(arg.date);
        if (day === null) return fail('invalid_input');
        if (outOfOrder(day)) return fail('date_out_of_order');
        advance(day);

        const m = members.get(memberId);
        if (!m) return fail('unknown_member');

        const loans = m.loans.map((l) => ({ bookId: l.bookId, dueDate: dayStr(l.dueDay) }));

        const found = [];
        for (const [bookId, b] of books) {
          const i = b.queue.findIndex((e) => e.memberId === memberId);
          if (i < 0) continue;
          const setAsideForMember = i === 0 && b.status === 'set_aside';
          found.push({
            seq: b.queue[i].seq,
            bookId,
            position: i + 1,
            readyUntil: setAsideForMember ? dayStr(b.readyUntil) : null,
          });
        }
        found.sort((x, y) => x.seq - y.seq);
        const holds = found.map(({ bookId, position, readyUntil }) => ({ bookId, position, readyUntil }));

        return { ok: true, loans, owed: m.owed, holds };
      });
    },
  };
}
