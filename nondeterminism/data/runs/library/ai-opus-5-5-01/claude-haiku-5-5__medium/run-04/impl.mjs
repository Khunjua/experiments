const DAY_MS = 86400000;
const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const RENEW_DAYS = 21;
const FINE_PER_DAY = 25;
const MAX_FINE = 500;
const FINE_BLOCK = 500;
const MAX_LOANS = 5;
const PICKUP_DAYS = 7;

function parseDay(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return Math.round(t.getTime() / DAY_MS);
}

function fmt(day) {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

function isObj(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

function validId(x) {
  return typeof x === 'string' && x.length > 0;
}

export function createLibrary() {
  // bookId -> { status: 'available' | 'on_loan' | 'set_aside', borrower, queue: [{ memberId, seq }], readyUntil }
  const books = new Map();
  // memberId -> { owed, loans: [{ bookId, dueDay, renewCount }] }
  const members = new Map();
  let latestDay = null;
  let seqCounter = 0;

  const fail = (reason) => ({ ok: false, reason });

  // Applies the pickup expiry rule (§7) for date `day`.
  function expire(day) {
    for (const book of books.values()) {
      while (book.status === 'set_aside' && book.readyUntil < day) {
        book.queue.shift();
        if (book.queue.length === 0) {
          book.status = 'available';
          book.borrower = null;
          book.readyUntil = null;
          break;
        }
        book.readyUntil += PICKUP_DAYS;
      }
    }
  }

  // Returns false if the date is out of order (no change made).
  // Otherwise records the date and applies expiry.
  function advance(day) {
    if (latestDay !== null && day < latestDay) return false;
    latestDay = day;
    expire(day);
    return true;
  }

  function addBook(arg) {
    try {
      if (!isObj(arg)) return fail('invalid_input');
      const bookId = arg.bookId;
      if (!validId(bookId)) return fail('invalid_input');
      if (books.has(bookId)) return fail('book_exists');
      books.set(bookId, { status: 'available', borrower: null, queue: [], readyUntil: null });
      return { ok: true };
    } catch {
      return fail('invalid_input');
    }
  }

  function addMember(arg) {
    try {
      if (!isObj(arg)) return fail('invalid_input');
      const memberId = arg.memberId;
      if (!validId(memberId)) return fail('invalid_input');
      if (members.has(memberId)) return fail('member_exists');
      members.set(memberId, { owed: 0, loans: [] });
      return { ok: true };
    } catch {
      return fail('invalid_input');
    }
  }

  function borrow(arg) {
    try {
      if (!isObj(arg)) return fail('invalid_input');
      const memberId = arg.memberId;
      const bookId = arg.bookId;
      const day = parseDay(arg.date);
      if (!validId(memberId) || !validId(bookId) || day === null) return fail('invalid_input');
      if (!advance(day)) return fail('date_out_of_order');

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

      const dueDay = day + LOAN_DAYS;
      m.loans.push({ bookId, dueDay, renewCount: 0 });
      if (b.status === 'set_aside') b.queue.shift();
      b.status = 'on_loan';
      b.borrower = memberId;
      b.readyUntil = null;
      return { ok: true, dueDate: fmt(dueDay) };
    } catch {
      return fail('invalid_input');
    }
  }

  function returnBook(arg) {
    try {
      if (!isObj(arg)) return fail('invalid_input');
      const memberId = arg.memberId;
      const bookId = arg.bookId;
      const day = parseDay(arg.date);
      if (!validId(memberId) || !validId(bookId) || day === null) return fail('invalid_input');
      if (!advance(day)) return fail('date_out_of_order');

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

      if (b.queue.length === 0) {
        b.status = 'available';
        b.borrower = null;
        b.readyUntil = null;
      } else {
        b.status = 'set_aside';
        b.borrower = null;
        b.readyUntil = day + PICKUP_DAYS;
      }
      return { ok: true, fine };
    } catch {
      return fail('invalid_input');
    }
  }

  function renew(arg) {
    try {
      if (!isObj(arg)) return fail('invalid_input');
      const memberId = arg.memberId;
      const bookId = arg.bookId;
      const day = parseDay(arg.date);
      if (!validId(memberId) || !validId(bookId) || day === null) return fail('invalid_input');
      if (!advance(day)) return fail('date_out_of_order');

      const m = members.get(memberId);
      if (!m) return fail('unknown_member');
      const b = books.get(bookId);
      if (!b) return fail('unknown_book');

      const loan = m.loans.find((l) => l.bookId === bookId);
      if (!loan) return fail('not_borrowed');
      if (day > loan.dueDay) return fail('overdue');
      if (loan.renewCount >= MAX_RENEWALS) return fail('renewal_limit');
      if (b.queue.length > 0) return fail('has_holds');

      loan.dueDay += RENEW_DAYS;
      loan.renewCount += 1;
      return { ok: true, dueDate: fmt(loan.dueDay) };
    } catch {
      return fail('invalid_input');
    }
  }

  function placeHold(arg) {
    try {
      if (!isObj(arg)) return fail('invalid_input');
      const memberId = arg.memberId;
      const bookId = arg.bookId;
      const day = parseDay(arg.date);
      if (!validId(memberId) || !validId(bookId) || day === null) return fail('invalid_input');
      if (!advance(day)) return fail('date_out_of_order');

      const m = members.get(memberId);
      if (!m) return fail('unknown_member');
      const b = books.get(bookId);
      if (!b) return fail('unknown_book');

      if (m.loans.some((l) => l.bookId === bookId)) return fail('already_borrowed');
      if (b.queue.some((e) => e.memberId === memberId)) return fail('already_held');
      if (b.status === 'available') return fail('book_available');

      b.queue.push({ memberId, seq: ++seqCounter });
      return { ok: true, position: b.queue.length };
    } catch {
      return fail('invalid_input');
    }
  }

  function payFine(arg) {
    try {
      if (!isObj(arg)) return fail('invalid_input');
      const memberId = arg.memberId;
      const amount = arg.amount;
      const day = parseDay(arg.date);
      if (!validId(memberId) || !Number.isInteger(amount) || amount <= 0 || day === null) {
        return fail('invalid_input');
      }
      if (!advance(day)) return fail('date_out_of_order');

      const m = members.get(memberId);
      if (!m) return fail('unknown_member');
      if (amount > m.owed) return fail('overpayment');

      m.owed -= amount;
      return { ok: true, owed: m.owed };
    } catch {
      return fail('invalid_input');
    }
  }

  function getMember(arg) {
    try {
      if (!isObj(arg)) return fail('invalid_input');
      const memberId = arg.memberId;
      const day = parseDay(arg.date);
      if (!validId(memberId) || day === null) return fail('invalid_input');
      if (!advance(day)) return fail('date_out_of_order');

      const m = members.get(memberId);
      if (!m) return fail('unknown_member');

      const loans = m.loans.map((l) => ({ bookId: l.bookId, dueDate: fmt(l.dueDay) }));

      const found = [];
      for (const [bookId, b] of books) {
        const idx = b.queue.findIndex((e) => e.memberId === memberId);
        if (idx < 0) continue;
        const setAsideForMember = b.status === 'set_aside' && idx === 0;
        found.push({
          seq: b.queue[idx].seq,
          bookId,
          position: idx + 1,
          readyUntil: setAsideForMember ? fmt(b.readyUntil) : null,
        });
      }
      found.sort((a, b) => a.seq - b.seq);
      const holds = found.map(({ bookId, position, readyUntil }) => ({ bookId, position, readyUntil }));

      return { ok: true, loans, owed: m.owed, holds };
    } catch {
      return fail('invalid_input');
    }
  }

  return { addBook, addMember, borrow, returnBook, renew, placeHold, payFine, getMember };
}
