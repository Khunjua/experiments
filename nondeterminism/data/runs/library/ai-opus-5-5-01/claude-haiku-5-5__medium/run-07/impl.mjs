const LOAN_DAYS = 21;
const RENEW_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const MAX_FINE = 500;
const FINE_BLOCK = 500;
const MAX_LOANS = 5;
const PICKUP_DAYS = 7;
const DAY_MS = 86400000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function fail(reason) {
  return { ok: false, reason };
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isId(v) {
  return typeof v === 'string' && v.length > 0;
}

function parseDay(s) {
  if (typeof s !== 'string') return null;
  const m = DATE_RE.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const t = new Date(0);
  t.setUTCFullYear(y, mo - 1, d);
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) {
    return null;
  }
  return Math.round(t.getTime() / DAY_MS);
}

function formatDay(n) {
  const t = new Date(n * DAY_MS);
  const y = String(t.getUTCFullYear()).padStart(4, '0');
  const m = String(t.getUTCMonth() + 1).padStart(2, '0');
  const d = String(t.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function createLibrary() {
  const books = new Map();
  const members = new Map();
  let latest = null;
  let seq = 0;

  function newBook() {
    return { status: 'available', borrower: null, queue: [], readyUntil: null };
  }

  function expire(today) {
    for (const book of books.values()) {
      while (book.status === 'set_aside' && book.readyUntil < today) {
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

  // Called once input has passed validation. Returns false if out of order.
  function admit(day) {
    if (latest !== null && day < latest) return false;
    latest = day;
    expire(day);
    return true;
  }

  function guard(fn) {
    return (input) => {
      try {
        return fn(input);
      } catch {
        return fail('invalid_input');
      }
    };
  }

  const addBook = guard((input) => {
    if (!isObject(input) || !isId(input.bookId)) return fail('invalid_input');
    if (books.has(input.bookId)) return fail('book_exists');
    books.set(input.bookId, newBook());
    return { ok: true };
  });

  const addMember = guard((input) => {
    if (!isObject(input) || !isId(input.memberId)) return fail('invalid_input');
    if (members.has(input.memberId)) return fail('member_exists');
    members.set(input.memberId, { owed: 0, loans: [] });
    return { ok: true };
  });

  const borrow = guard((input) => {
    if (!isObject(input) || !isId(input.memberId) || !isId(input.bookId)) {
      return fail('invalid_input');
    }
    const day = parseDay(input.date);
    if (day === null) return fail('invalid_input');
    if (!admit(day)) return fail('date_out_of_order');

    const { memberId, bookId } = input;
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
    return { ok: true, dueDate: formatDay(dueDay) };
  });

  const returnBook = guard((input) => {
    if (!isObject(input) || !isId(input.memberId) || !isId(input.bookId)) {
      return fail('invalid_input');
    }
    const day = parseDay(input.date);
    if (day === null) return fail('invalid_input');
    if (!admit(day)) return fail('date_out_of_order');

    const { memberId, bookId } = input;
    const m = members.get(memberId);
    if (!m) return fail('unknown_member');
    const b = books.get(bookId);
    if (!b) return fail('unknown_book');

    const idx = m.loans.findIndex((l) => l.bookId === bookId);
    if (idx < 0) return fail('not_borrowed');
    const loan = m.loans[idx];

    const late = Math.max(0, day - loan.dueDay);
    const fine = Math.min(FINE_PER_DAY * late, MAX_FINE);

    m.loans.splice(idx, 1);
    m.owed += fine;

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

  const renew = guard((input) => {
    if (!isObject(input) || !isId(input.memberId) || !isId(input.bookId)) {
      return fail('invalid_input');
    }
    const day = parseDay(input.date);
    if (day === null) return fail('invalid_input');
    if (!admit(day)) return fail('date_out_of_order');

    const { memberId, bookId } = input;
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
    return { ok: true, dueDate: formatDay(loan.dueDay) };
  });

  const placeHold = guard((input) => {
    if (!isObject(input) || !isId(input.memberId) || !isId(input.bookId)) {
      return fail('invalid_input');
    }
    const day = parseDay(input.date);
    if (day === null) return fail('invalid_input');
    if (!admit(day)) return fail('date_out_of_order');

    const { memberId, bookId } = input;
    const m = members.get(memberId);
    if (!m) return fail('unknown_member');
    const b = books.get(bookId);
    if (!b) return fail('unknown_book');

    if (m.loans.some((l) => l.bookId === bookId)) return fail('already_borrowed');
    if (b.queue.some((e) => e.memberId === memberId)) return fail('already_held');
    if (b.status === 'available') return fail('book_available');

    b.queue.push({ memberId, seq: seq++ });
    return { ok: true, position: b.queue.length };
  });

  const payFine = guard((input) => {
    if (
      !isObject(input) ||
      !isId(input.memberId) ||
      !Number.isInteger(input.amount) ||
      input.amount <= 0
    ) {
      return fail('invalid_input');
    }
    const day = parseDay(input.date);
    if (day === null) return fail('invalid_input');
    if (!admit(day)) return fail('date_out_of_order');

    const { memberId, amount } = input;
    const m = members.get(memberId);
    if (!m) return fail('unknown_member');
    if (amount > m.owed) return fail('overpayment');

    m.owed -= amount;
    return { ok: true, owed: m.owed };
  });

  const getMember = guard((input) => {
    if (!isObject(input) || !isId(input.memberId)) return fail('invalid_input');
    const day = parseDay(input.date);
    if (day === null) return fail('invalid_input');
    if (!admit(day)) return fail('date_out_of_order');

    const { memberId } = input;
    const m = members.get(memberId);
    if (!m) return fail('unknown_member');

    const loans = m.loans.map((l) => ({ bookId: l.bookId, dueDate: formatDay(l.dueDay) }));

    const found = [];
    for (const [bookId, b] of books) {
      const i = b.queue.findIndex((e) => e.memberId === memberId);
      if (i < 0) continue;
      const readyUntil =
        b.status === 'set_aside' && i === 0 ? formatDay(b.readyUntil) : null;
      found.push({ order: b.queue[i].seq, bookId, position: i + 1, readyUntil });
    }
    found.sort((x, y) => x.order - y.order);
    const holds = found.map(({ bookId, position, readyUntil }) => ({
      bookId,
      position,
      readyUntil,
    }));

    return { ok: true, loans, owed: m.owed, holds };
  });

  return {
    addBook,
    addMember,
    borrow,
    returnBook,
    renew,
    placeHold,
    payFine,
    getMember,
  };
}
