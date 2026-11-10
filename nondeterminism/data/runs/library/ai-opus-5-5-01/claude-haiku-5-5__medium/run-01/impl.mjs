const DAY_MS = 86400000;
const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const MAX_FINE = 500;
const FINE_BLOCK_THRESHOLD = 500;
const MAX_LOANS = 5;
const PICKUP_DAYS = 7;

function parseDate(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(0);
  dt.setUTCFullYear(y, mo - 1, d);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) {
    return null;
  }
  return Math.round(dt.getTime() / DAY_MS);
}

function fmt(n) {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

function isObj(a) {
  return typeof a === 'object' && a !== null;
}

function isId(v) {
  return typeof v === 'string' && v.length > 0;
}

export function createLibrary() {
  const books = new Map();   // bookId -> { status, borrower, queue: [{ memberId, seq }], readyUntil }
  const members = new Map(); // memberId -> { owed, loans: [{ bookId, dueDate, renewCount }] }
  let latest = null;         // latest valid day number seen
  let seq = 0;               // global hold placement counter

  const fail = (reason) => ({ ok: false, reason });

  function applyExpiry(D) {
    for (const book of books.values()) {
      if (book.status !== 'set_aside') continue;
      while (book.status === 'set_aside' && book.readyUntil < D) {
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

  // Called only after input validation has passed.
  function admit(D) {
    if (latest !== null && D < latest) return 'date_out_of_order';
    latest = D;
    applyExpiry(D);
    return null;
  }

  function addBook(a) {
    if (!isObj(a) || !isId(a.bookId)) return fail('invalid_input');
    if (books.has(a.bookId)) return fail('book_exists');
    books.set(a.bookId, { status: 'available', borrower: null, queue: [], readyUntil: null });
    return { ok: true };
  }

  function addMember(a) {
    if (!isObj(a) || !isId(a.memberId)) return fail('invalid_input');
    if (members.has(a.memberId)) return fail('member_exists');
    members.set(a.memberId, { owed: 0, loans: [] });
    return { ok: true };
  }

  function borrow(a) {
    if (!isObj(a) || !isId(a.memberId) || !isId(a.bookId)) return fail('invalid_input');
    const D = parseDate(a.date);
    if (D === null) return fail('invalid_input');
    const late = admit(D);
    if (late) return fail(late);

    const m = members.get(a.memberId);
    if (!m) return fail('unknown_member');
    const b = books.get(a.bookId);
    if (!b) return fail('unknown_book');

    if (b.status === 'on_loan') {
      return fail(b.borrower === a.memberId ? 'already_borrowed' : 'not_available');
    }
    if (b.status === 'set_aside' && b.queue[0].memberId !== a.memberId) {
      return fail('reserved_for_other');
    }
    if (m.loans.some((l) => D > l.dueDate)) return fail('overdue_loans');
    if (m.owed >= FINE_BLOCK_THRESHOLD) return fail('fines_owed');
    if (m.loans.length >= MAX_LOANS) return fail('loan_limit');

    const due = D + LOAN_DAYS;
    m.loans.push({ bookId: a.bookId, dueDate: due, renewCount: 0 });
    if (b.status === 'set_aside') {
      b.queue.shift();
      b.readyUntil = null;
    }
    b.status = 'on_loan';
    b.borrower = a.memberId;
    return { ok: true, dueDate: fmt(due) };
  }

  function returnBook(a) {
    if (!isObj(a) || !isId(a.memberId) || !isId(a.bookId)) return fail('invalid_input');
    const D = parseDate(a.date);
    if (D === null) return fail('invalid_input');
    const late = admit(D);
    if (late) return fail(late);

    const m = members.get(a.memberId);
    if (!m) return fail('unknown_member');
    const b = books.get(a.bookId);
    if (!b) return fail('unknown_book');
    const idx = m.loans.findIndex((l) => l.bookId === a.bookId);
    if (idx === -1) return fail('not_borrowed');

    const loan = m.loans[idx];
    m.loans.splice(idx, 1);
    const daysLate = Math.max(0, D - loan.dueDate);
    const fine = Math.min(FINE_PER_DAY * daysLate, MAX_FINE);
    m.owed += fine;

    b.borrower = null;
    if (b.queue.length === 0) {
      b.status = 'available';
      b.readyUntil = null;
    } else {
      b.status = 'set_aside';
      b.readyUntil = D + PICKUP_DAYS;
    }
    return { ok: true, fine };
  }

  function renew(a) {
    if (!isObj(a) || !isId(a.memberId) || !isId(a.bookId)) return fail('invalid_input');
    const D = parseDate(a.date);
    if (D === null) return fail('invalid_input');
    const late = admit(D);
    if (late) return fail(late);

    const m = members.get(a.memberId);
    if (!m) return fail('unknown_member');
    const b = books.get(a.bookId);
    if (!b) return fail('unknown_book');
    const loan = m.loans.find((l) => l.bookId === a.bookId);
    if (!loan) return fail('not_borrowed');
    if (D > loan.dueDate) return fail('overdue');
    if (loan.renewCount >= MAX_RENEWALS) return fail('renewal_limit');
    if (b.queue.length > 0) return fail('has_holds');

    loan.dueDate += LOAN_DAYS;
    loan.renewCount += 1;
    return { ok: true, dueDate: fmt(loan.dueDate) };
  }

  function placeHold(a) {
    if (!isObj(a) || !isId(a.memberId) || !isId(a.bookId)) return fail('invalid_input');
    const D = parseDate(a.date);
    if (D === null) return fail('invalid_input');
    const late = admit(D);
    if (late) return fail(late);

    const m = members.get(a.memberId);
    if (!m) return fail('unknown_member');
    const b = books.get(a.bookId);
    if (!b) return fail('unknown_book');
    if (m.loans.some((l) => l.bookId === a.bookId)) return fail('already_borrowed');
    if (b.queue.some((e) => e.memberId === a.memberId)) return fail('already_held');
    if (b.status === 'available') return fail('book_available');

    seq += 1;
    b.queue.push({ memberId: a.memberId, seq });
    return { ok: true, position: b.queue.length };
  }

  function payFine(a) {
    if (!isObj(a) || !isId(a.memberId)) return fail('invalid_input');
    if (!Number.isInteger(a.amount) || a.amount <= 0) return fail('invalid_input');
    const D = parseDate(a.date);
    if (D === null) return fail('invalid_input');
    const late = admit(D);
    if (late) return fail(late);

    const m = members.get(a.memberId);
    if (!m) return fail('unknown_member');
    if (a.amount > m.owed) return fail('overpayment');
    m.owed -= a.amount;
    return { ok: true, owed: m.owed };
  }

  function getMember(a) {
    if (!isObj(a) || !isId(a.memberId)) return fail('invalid_input');
    const D = parseDate(a.date);
    if (D === null) return fail('invalid_input');
    const late = admit(D);
    if (late) return fail(late);

    const m = members.get(a.memberId);
    if (!m) return fail('unknown_member');

    const loans = m.loans.map((l) => ({ bookId: l.bookId, dueDate: fmt(l.dueDate) }));

    const entries = [];
    for (const [bookId, b] of books) {
      b.queue.forEach((e, i) => {
        if (e.memberId === a.memberId) {
          const setAsideForMe = b.status === 'set_aside' && i === 0;
          entries.push({
            seq: e.seq,
            bookId,
            position: i + 1,
            readyUntil: setAsideForMe ? fmt(b.readyUntil) : null,
          });
        }
      });
    }
    entries.sort((x, y) => x.seq - y.seq);
    const holds = entries.map((e) => ({
      bookId: e.bookId,
      position: e.position,
      readyUntil: e.readyUntil,
    }));

    return { ok: true, loans, owed: m.owed, holds };
  }

  const guard = (fn) => (a) => {
    try {
      return fn(a);
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
