const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const FINE_CAP = 500;
const BLOCK_THRESHOLD = 1000;
const PICKUP_DAYS = 7;
const MS_PER_DAY = 86400000;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return Math.round(t.getTime() / MS_PER_DAY);
}

function dayToStr(n) {
  const t = new Date(n * MS_PER_DAY);
  const y = t.getUTCFullYear();
  const m = t.getUTCMonth() + 1;
  const d = t.getUTCDate();
  return String(y).padStart(4, '0') + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

function isId(v) {
  return typeof v === 'string' && v.length > 0;
}

function fail(reason) {
  return { ok: false, reason };
}

export function createLibrary() {
  const books = new Map();
  const members = new Map();
  let clock = null;
  let counter = 0;

  function removeHold(book, hold) {
    const bi = book.queue.indexOf(hold);
    if (bi !== -1) book.queue.splice(bi, 1);
    const member = members.get(hold.memberId);
    if (member) {
      const mi = member.holds.indexOf(hold);
      if (mi !== -1) member.holds.splice(mi, 1);
    }
  }

  // Section 5.2: a book stops being held on day S.
  function passToQueue(book, S) {
    if (book.queue.length === 0) {
      book.status = 'available';
    } else {
      book.status = 'readyForPickup';
      book.queue[0].readyUntil = S + PICKUP_DAYS;
    }
  }

  // Section 5.3: process hold expirations up to day T.
  function expire(T) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const book of books.values()) {
        if (book.status !== 'readyForPickup') continue;
        const hold = book.queue[0];
        if (hold && hold.readyUntil !== null && hold.readyUntil < T) {
          removeHold(book, hold);
          passToQueue(book, hold.readyUntil + 1);
          changed = true;
        }
      }
    }
  }

  // Validates a dated call (section 3.5 steps 1-3).
  // Returns { error } or { day, memberId, bookId, amount }.
  function prepare(args, opts) {
    if (typeof args !== 'object' || args === null) return { error: 'invalid arguments' };
    const memberId = args.memberId;
    if (!isId(memberId)) return { error: 'invalid memberId' };
    let bookId;
    if (opts.book) {
      bookId = args.bookId;
      if (!isId(bookId)) return { error: 'invalid bookId' };
    }
    let amount;
    if (opts.amount) {
      amount = args.amount;
      if (!Number.isInteger(amount) || amount <= 0) return { error: 'invalid amount' };
    }
    const day = parseDate(args.date);
    if (day === null) return { error: 'invalid date' };
    if (clock !== null && day < clock) return { error: 'date earlier than clock' };
    clock = day;
    expire(day);
    return { day, memberId, bookId, amount };
  }

  function addBook(args) {
    if (typeof args !== 'object' || args === null) return fail('invalid arguments');
    const bookId = args.bookId;
    if (!isId(bookId)) return fail('invalid bookId');
    if (books.has(bookId)) return fail('book exists');
    books.set(bookId, { status: 'available', loan: null, queue: [] });
    return { ok: true };
  }

  function addMember(args) {
    if (typeof args !== 'object' || args === null) return fail('invalid arguments');
    const memberId = args.memberId;
    if (!isId(memberId)) return fail('invalid memberId');
    if (members.has(memberId)) return fail('member exists');
    members.set(memberId, { owed: 0, loans: [], holds: [] });
    return { ok: true };
  }

  function borrow(args) {
    const p = prepare(args, { book: true });
    if (p.error) return fail(p.error);
    const { day, memberId, bookId } = p;
    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b) return fail('unknown member or book');
    if (m.owed >= BLOCK_THRESHOLD) return fail('member blocked');
    if (b.status === 'onLoan') return fail('book on loan');
    if (b.status === 'readyForPickup') {
      const hold = b.queue[0];
      if (!hold || hold.memberId !== memberId || day > hold.readyUntil) {
        return fail('book set aside for another member');
      }
      removeHold(b, hold);
    } else if (b.queue.length > 0) {
      return fail('inconsistent hold queue');
    }
    const loan = {
      bookId,
      memberId,
      borrowDay: day,
      seq: ++counter,
      dueDay: day + LOAN_DAYS,
      renewals: 0
    };
    m.loans.push(loan);
    b.loan = loan;
    b.status = 'onLoan';
    return { ok: true, dueDate: dayToStr(loan.dueDay) };
  }

  function returnBook(args) {
    const p = prepare(args, { book: true });
    if (p.error) return fail(p.error);
    const { day, memberId, bookId } = p;
    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b) return fail('unknown member or book');
    if (b.status !== 'onLoan' || !b.loan || b.loan.memberId !== memberId) {
      return fail('not on loan to this member');
    }
    const loan = b.loan;
    const daysLate = day - loan.dueDay;
    const fine = daysLate > 0 ? Math.min(daysLate * FINE_PER_DAY, FINE_CAP) : 0;
    m.owed += fine;
    const li = m.loans.indexOf(loan);
    if (li !== -1) m.loans.splice(li, 1);
    b.loan = null;
    passToQueue(b, day);
    return { ok: true, fine };
  }

  function renew(args) {
    const p = prepare(args, { book: true });
    if (p.error) return fail(p.error);
    const { day, memberId, bookId } = p;
    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b) return fail('unknown member or book');
    if (b.status !== 'onLoan' || !b.loan || b.loan.memberId !== memberId) {
      return fail('not on loan to this member');
    }
    if (b.queue.length > 0) return fail('someone is waiting');
    const loan = b.loan;
    if (loan.renewals >= MAX_RENEWALS) return fail('renewal limit');
    if (day > loan.dueDay) return fail('loan overdue');
    if (m.owed >= BLOCK_THRESHOLD) return fail('member blocked');
    loan.dueDay += LOAN_DAYS;
    loan.renewals += 1;
    return { ok: true, dueDate: dayToStr(loan.dueDay) };
  }

  function placeHold(args) {
    const p = prepare(args, { book: true });
    if (p.error) return fail(p.error);
    const { memberId, bookId } = p;
    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b) return fail('unknown member or book');
    if (b.status === 'available') return fail('book is available');
    if (b.loan && b.loan.memberId === memberId) return fail('already on loan to member');
    if (b.queue.some(h => h.memberId === memberId)) return fail('hold exists');
    const hold = { bookId, memberId, placedOrder: ++counter, readyUntil: null };
    b.queue.push(hold);
    m.holds.push(hold);
    return { ok: true, position: b.queue.length };
  }

  function payFine(args) {
    const p = prepare(args, { amount: true });
    if (p.error) return fail(p.error);
    const { memberId, amount } = p;
    const m = members.get(memberId);
    if (!m) return fail('unknown member');
    if (amount > m.owed) return fail('amount exceeds owed');
    m.owed -= amount;
    return { ok: true, owed: m.owed };
  }

  function getMember(args) {
    const p = prepare(args, {});
    if (p.error) return fail(p.error);
    const m = members.get(p.memberId);
    if (!m) return fail('unknown member');
    const loans = [...m.loans]
      .sort((x, y) => (x.borrowDay - y.borrowDay) || (x.seq - y.seq))
      .map(l => ({ bookId: l.bookId, dueDate: dayToStr(l.dueDay) }));
    const holds = [...m.holds]
      .sort((x, y) => x.placedOrder - y.placedOrder)
      .map(h => {
        const b = books.get(h.bookId);
        return {
          bookId: h.bookId,
          position: b.queue.indexOf(h) + 1,
          readyUntil: h.readyUntil === null ? null : dayToStr(h.readyUntil)
        };
      });
    return { loans, owed: m.owed, holds };
  }

  function guard(fn) {
    return (args) => {
      try {
        return fn(args);
      } catch {
        return fail('internal error');
      }
    };
  }

  return {
    addBook: guard(addBook),
    addMember: guard(addMember),
    borrow: guard(borrow),
    returnBook: guard(returnBook),
    renew: guard(renew),
    placeHold: guard(placeHold),
    payFine: guard(payFine),
    getMember: guard(getMember)
  };
}
