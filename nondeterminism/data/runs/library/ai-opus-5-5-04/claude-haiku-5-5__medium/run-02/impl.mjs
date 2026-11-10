const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 3;
const MAX_FINE_PER_LOAN = 500;
const BLOCK_THRESHOLD = 500;
const MAX_LOANS = 5;
const MAX_HOLDS = 5;
const PICKUP_DAYS = 7;
const MS_PER_DAY = 86400000;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isValidId(x) {
  return typeof x === 'string' && x.length > 0;
}

function isValidDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (m < 1 || m > 12 || d < 1) return false;
  // setUTCFullYear avoids the 0-99 year mapping of Date.UTC
  const t = new Date(0);
  t.setUTCFullYear(y, m, 0); // day 0 of next month index = last day of month m
  const dim = t.getUTCDate();
  return d <= dim;
}

function toDays(s) {
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  return Math.round(t.getTime() / MS_PER_DAY);
}

function fromDays(n) {
  return new Date(n * MS_PER_DAY).toISOString().slice(0, 10);
}

function addDays(s, n) {
  return fromDays(toDays(s) + n);
}

function diffDays(a, b) {
  return toDays(b) - toDays(a);
}

function fail(reason) {
  return { ok: false, reason };
}

export function createLibrary() {
  const books = new Map();
  const members = new Map();

  function removeHoldRef(memberId, bookId) {
    const m = members.get(memberId);
    if (m) m.holds = m.holds.filter((x) => x !== bookId);
  }

  // Hold expiry processing (section 5.2).
  function advance(date) {
    for (const book of books.values()) {
      if (book.status !== 'reserved') continue;
      while (
        book.holdQueue.length > 0 &&
        book.holdQueue[0].readyUntil !== null &&
        book.holdQueue[0].readyUntil < date
      ) {
        const expired = book.holdQueue.shift();
        removeHoldRef(expired.memberId, book.bookId);
        if (book.holdQueue.length === 0) {
          book.status = 'shelf';
          break;
        }
        const nextStart = addDays(expired.readyUntil, 1);
        const first = book.holdQueue[0];
        first.readyFrom = nextStart;
        first.readyUntil = addDays(nextStart, PICKUP_DAYS - 1);
      }
    }
  }

  function addBook(input) {
    const { bookId } = input;
    if (!isValidId(bookId)) return fail('invalid id');
    if (books.has(bookId)) return fail('exists');
    books.set(bookId, { bookId, status: 'shelf', holdQueue: [], loanedTo: null });
    return { ok: true };
  }

  function addMember(input) {
    const { memberId } = input;
    if (!isValidId(memberId)) return fail('invalid id');
    if (members.has(memberId)) return fail('exists');
    members.set(memberId, { memberId, owed: 0, loans: [], holds: [] });
    return { ok: true };
  }

  function borrow(input) {
    const { memberId, bookId, date } = input;
    if (!isValidId(memberId) || !isValidId(bookId) || !isValidDate(date)) {
      return fail('invalid input');
    }
    advance(date);
    const m = members.get(memberId);
    if (!m) return fail('unknown member');
    const b = books.get(bookId);
    if (!b) return fail('unknown book');
    if (b.status === 'loaned') return fail('on loan');
    let pickup = false;
    if (b.status === 'reserved') {
      if (b.holdQueue[0].memberId !== memberId) return fail('reserved for another');
      pickup = true;
    }
    if (m.owed >= BLOCK_THRESHOLD) return fail('owes too much');
    if (m.loans.some((l) => l.dueDate < date)) return fail('overdue loan');
    if (m.loans.length >= MAX_LOANS) return fail('loan limit');

    if (pickup) {
      b.holdQueue.shift();
      m.holds = m.holds.filter((x) => x !== bookId);
    }
    const dueDate = addDays(date, LOAN_DAYS);
    m.loans.push({ bookId, borrowDate: date, dueDate, renewals: 0 });
    b.status = 'loaned';
    b.loanedTo = memberId;
    return { ok: true, dueDate };
  }

  function returnBook(input) {
    const { memberId, bookId, date } = input;
    if (!isValidId(memberId) || !isValidId(bookId) || !isValidDate(date)) {
      return fail('invalid input');
    }
    advance(date);
    const m = members.get(memberId);
    if (!m) return fail('unknown member');
    const b = books.get(bookId);
    if (!b) return fail('unknown book');
    const li = m.loans.findIndex((l) => l.bookId === bookId);
    if (li < 0) return fail('no such loan');
    const loan = m.loans[li];

    const daysLate = Math.max(0, diffDays(loan.dueDate, date));
    const fine = Math.min(
      MAX_FINE_PER_LOAN,
      FINE_PER_DAY * Math.max(0, daysLate - GRACE_DAYS)
    );

    m.loans.splice(li, 1);
    m.owed += fine;
    b.loanedTo = null;
    if (b.holdQueue.length === 0) {
      b.status = 'shelf';
    } else {
      b.status = 'reserved';
      const first = b.holdQueue[0];
      first.readyFrom = date;
      first.readyUntil = addDays(date, PICKUP_DAYS - 1);
    }
    return { ok: true, fine };
  }

  function renew(input) {
    const { memberId, bookId, date } = input;
    if (!isValidId(memberId) || !isValidId(bookId) || !isValidDate(date)) {
      return fail('invalid input');
    }
    advance(date);
    const m = members.get(memberId);
    if (!m) return fail('unknown member');
    const b = books.get(bookId);
    if (!b) return fail('unknown book');
    const loan = m.loans.find((l) => l.bookId === bookId);
    if (!loan) return fail('no such loan');
    if (date > loan.dueDate) return fail('overdue');
    if (loan.renewals >= MAX_RENEWALS) return fail('renewal limit');
    if (b.holdQueue.length > 0) return fail('someone is waiting');
    if (m.owed >= BLOCK_THRESHOLD) return fail('owes too much');

    loan.dueDate = addDays(loan.dueDate, LOAN_DAYS);
    loan.renewals += 1;
    return { ok: true, dueDate: loan.dueDate };
  }

  function placeHold(input) {
    const { memberId, bookId, date } = input;
    if (!isValidId(memberId) || !isValidId(bookId) || !isValidDate(date)) {
      return fail('invalid input');
    }
    advance(date);
    const m = members.get(memberId);
    if (!m) return fail('unknown member');
    const b = books.get(bookId);
    if (!b) return fail('unknown book');
    if (b.status === 'shelf') return fail('available');
    if (m.loans.some((l) => l.bookId === bookId)) return fail('already on loan');
    if (b.holdQueue.some((e) => e.memberId === memberId)) return fail('already in queue');
    if (m.holds.length >= MAX_HOLDS) return fail('hold limit');

    b.holdQueue.push({ memberId, readyFrom: null, readyUntil: null });
    m.holds.push(bookId);
    return { ok: true, position: b.holdQueue.length };
  }

  function payFine(input) {
    const { memberId, amount, date } = input;
    if (!isValidId(memberId) || !isValidDate(date)) return fail('invalid input');
    advance(date);
    const m = members.get(memberId);
    if (!m) return fail('unknown member');
    if (!Number.isInteger(amount) || amount < 1) return fail('invalid amount');
    if (amount > m.owed) return fail('overpayment');
    m.owed -= amount;
    return { ok: true, owed: m.owed };
  }

  function getMember(input) {
    const { memberId, date } = input;
    if (!isValidId(memberId) || !isValidDate(date)) return fail('invalid input');
    advance(date);
    const m = members.get(memberId);
    if (!m) return fail('unknown member');

    const loans = m.loans.map((l) => ({ bookId: l.bookId, dueDate: l.dueDate }));
    const holds = [];
    for (const bookId of m.holds) {
      const b = books.get(bookId);
      if (!b) continue;
      const idx = b.holdQueue.findIndex((e) => e.memberId === memberId);
      if (idx < 0) continue;
      const entry = b.holdQueue[idx];
      const setAside = idx === 0 && b.status === 'reserved';
      holds.push({
        bookId,
        position: idx + 1,
        readyUntil: setAside ? entry.readyUntil : null,
      });
    }
    return { loans, owed: m.owed, holds };
  }

  function guard(fn) {
    return (input) => {
      const a = input && typeof input === 'object' ? input : {};
      try {
        return fn(a);
      } catch {
        return fail('internal');
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
    getMember: guard(getMember),
  };
}
