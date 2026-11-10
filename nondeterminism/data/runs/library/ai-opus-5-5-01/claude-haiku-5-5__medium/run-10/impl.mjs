const PICKUP_DAYS = 7;
const LOAN_DAYS = 21;
const RENEW_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const MAX_FINE = 500;
const FINE_BLOCK = 500;
const MAX_LOANS = 5;
const MS_PER_DAY = 86400000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parseDate(s) {
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
  return Math.round(t.getTime() / MS_PER_DAY);
}

function formatDate(day) {
  return new Date(day * MS_PER_DAY).toISOString().slice(0, 10);
}

const isObj = (a) => a !== null && typeof a === 'object' && !Array.isArray(a);
const isId = (v) => typeof v === 'string' && v.length > 0;
const fail = (reason) => ({ ok: false, reason });

export function createLibrary() {
  const books = new Map();   // bookId -> { status, borrower, queue: [{ memberId, seq }], readyUntil }
  const members = new Map(); // memberId -> { owed, loans: [{ bookId, dueDate, renewCount }] }
  let latest = -Infinity;
  let seqCounter = 0;

  // Applies the pickup-expiry rule (section 7) for date `today`.
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

  // Shared dated-call prologue. Returns a failure object, or null to continue.
  function admit(day, inputOk) {
    if (day !== null && day >= latest) {
      latest = day;
      expire(day);
    }
    if (!inputOk || day === null) return fail('invalid_input');
    if (day < latest) return fail('date_out_of_order');
    return null;
  }

  function addBook(arg) {
    if (!isObj(arg)) return fail('invalid_input');
    const bookId = arg.bookId;
    if (!isId(bookId)) return fail('invalid_input');
    if (books.has(bookId)) return fail('book_exists');
    books.set(bookId, { status: 'available', borrower: null, queue: [], readyUntil: null });
    return { ok: true };
  }

  function addMember(arg) {
    if (!isObj(arg)) return fail('invalid_input');
    const memberId = arg.memberId;
    if (!isId(memberId)) return fail('invalid_input');
    if (members.has(memberId)) return fail('member_exists');
    members.set(memberId, { owed: 0, loans: [] });
    return { ok: true };
  }

  function borrow(arg) {
    if (!isObj(arg)) return fail('invalid_input');
    const memberId = arg.memberId;
    const bookId = arg.bookId;
    const day = parseDate(arg.date);
    const inputOk = isId(memberId) && isId(bookId);
    const err = admit(day, inputOk);
    if (err) return err;

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
    if (m.loans.some((l) => day > l.dueDate)) return fail('overdue_loans');
    if (m.owed >= FINE_BLOCK) return fail('fines_owed');
    if (m.loans.length >= MAX_LOANS) return fail('loan_limit');

    if (b.status === 'set_aside') {
      b.queue.shift();
    }
    const dueDate = day + LOAN_DAYS;
    m.loans.push({ bookId, dueDate, renewCount: 0 });
    b.status = 'on_loan';
    b.borrower = memberId;
    b.readyUntil = null;
    return { ok: true, dueDate: formatDate(dueDate) };
  }

  function returnBook(arg) {
    if (!isObj(arg)) return fail('invalid_input');
    const memberId = arg.memberId;
    const bookId = arg.bookId;
    const day = parseDate(arg.date);
    const inputOk = isId(memberId) && isId(bookId);
    const err = admit(day, inputOk);
    if (err) return err;

    const m = members.get(memberId);
    if (!m) return fail('unknown_member');
    const b = books.get(bookId);
    if (!b) return fail('unknown_book');

    const loan = m.loans.find((l) => l.bookId === bookId);
    if (!loan) return fail('not_borrowed');

    const daysLate = Math.max(0, day - loan.dueDate);
    const fine = Math.min(FINE_PER_DAY * daysLate, MAX_FINE);
    m.owed += fine;
    m.loans.splice(m.loans.indexOf(loan), 1);

    b.borrower = null;
    if (b.queue.length === 0) {
      b.status = 'available';
      b.readyUntil = null;
    } else {
      b.status = 'set_aside';
      b.readyUntil = day + PICKUP_DAYS;
    }
    return { ok: true, fine };
  }

  function renew(arg) {
    if (!isObj(arg)) return fail('invalid_input');
    const memberId = arg.memberId;
    const bookId = arg.bookId;
    const day = parseDate(arg.date);
    const inputOk = isId(memberId) && isId(bookId);
    const err = admit(day, inputOk);
    if (err) return err;

    const m = members.get(memberId);
    if (!m) return fail('unknown_member');
    const b = books.get(bookId);
    if (!b) return fail('unknown_book');

    const loan = m.loans.find((l) => l.bookId === bookId);
    if (!loan) return fail('not_borrowed');
    if (day > loan.dueDate) return fail('overdue');
    if (loan.renewCount >= MAX_RENEWALS) return fail('renewal_limit');
    if (b.queue.length > 0) return fail('has_holds');

    loan.dueDate += RENEW_DAYS;
    loan.renewCount += 1;
    return { ok: true, dueDate: formatDate(loan.dueDate) };
  }

  function placeHold(arg) {
    if (!isObj(arg)) return fail('invalid_input');
    const memberId = arg.memberId;
    const bookId = arg.bookId;
    const day = parseDate(arg.date);
    const inputOk = isId(memberId) && isId(bookId);
    const err = admit(day, inputOk);
    if (err) return err;

    const m = members.get(memberId);
    if (!m) return fail('unknown_member');
    const b = books.get(bookId);
    if (!b) return fail('unknown_book');

    if (m.loans.some((l) => l.bookId === bookId)) return fail('already_borrowed');
    if (b.queue.some((e) => e.memberId === memberId)) return fail('already_held');
    if (b.status === 'available') return fail('book_available');

    seqCounter += 1;
    b.queue.push({ memberId, seq: seqCounter });
    return { ok: true, position: b.queue.length };
  }

  function payFine(arg) {
    if (!isObj(arg)) return fail('invalid_input');
    const memberId = arg.memberId;
    const amount = arg.amount;
    const day = parseDate(arg.date);
    const inputOk = isId(memberId) && Number.isSafeInteger(amount) && amount > 0;
    const err = admit(day, inputOk);
    if (err) return err;

    const m = members.get(memberId);
    if (!m) return fail('unknown_member');
    if (amount > m.owed) return fail('overpayment');

    m.owed -= amount;
    return { ok: true, owed: m.owed };
  }

  function getMember(arg) {
    if (!isObj(arg)) return fail('invalid_input');
    const memberId = arg.memberId;
    const day = parseDate(arg.date);
    const inputOk = isId(memberId);
    const err = admit(day, inputOk);
    if (err) return err;

    const m = members.get(memberId);
    if (!m) return fail('unknown_member');

    const loans = m.loans.map((l) => ({ bookId: l.bookId, dueDate: formatDate(l.dueDate) }));

    const found = [];
    for (const [bookId, b] of books) {
      const i = b.queue.findIndex((e) => e.memberId === memberId);
      if (i === -1) continue;
      const readyUntil = b.status === 'set_aside' && i === 0 ? formatDate(b.readyUntil) : null;
      found.push({ seq: b.queue[i].seq, bookId, position: i + 1, readyUntil });
    }
    found.sort((x, y) => x.seq - y.seq);
    const holds = found.map(({ bookId, position, readyUntil }) => ({ bookId, position, readyUntil }));

    return { ok: true, loans, owed: m.owed, holds };
  }

  // Ensures no method throws, whatever the input.
  const guard = (fn) => (arg) => {
    try {
      return fn(arg);
    } catch {
      return fail('invalid_input');
    }
  };

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
