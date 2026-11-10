const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const RENEW_DAYS = 21;
const FINE_PER_DAY = 25;
const MAX_FINE_PER_LOAN = 500;
const FINE_BLOCK_THRESHOLD = 500;
const MAX_LOANS = 5;
const PICKUP_DAYS = 7;
const DAY_MS = 86400000;
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
  return Math.round(t.getTime() / DAY_MS);
}

function formatDay(n) {
  return new Date(n * DAY_MS).toISOString().slice(0, 10);
}

function isObj(a) {
  return a !== null && typeof a === 'object' && !Array.isArray(a);
}

function isId(s) {
  return typeof s === 'string' && s.length > 0;
}

function fail(reason) {
  return { ok: false, reason };
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
  const books = new Map();   // bookId -> { bookId, status, loan, queue, readyUntil }
  const members = new Map(); // memberId -> { memberId, owed, loans }
  let latest = null;
  let seq = 0;

  function expire(day) {
    for (const b of books.values()) {
      while (b.status === 'set_aside' && b.readyUntil < day) {
        b.queue.shift();
        if (b.queue.length === 0) {
          b.status = 'available';
          b.readyUntil = null;
        } else {
          b.readyUntil += PICKUP_DAYS;
        }
      }
    }
  }

  // Shared preamble for dated calls. Returns { err } or { day, ids }.
  function enter(arg, idKeys, extraCheck) {
    if (!isObj(arg)) return { err: 'invalid_input' };
    const day = parseDate(arg.date);
    const inOrder = day !== null && (latest === null || day >= latest);
    if (inOrder) {
      latest = day;
      expire(day);
    }
    if (day === null) return { err: 'invalid_input' };
    if (extraCheck && !extraCheck(arg)) return { err: 'invalid_input' };
    const ids = {};
    for (const k of idKeys) {
      if (!isId(arg[k])) return { err: 'invalid_input' };
      ids[k] = arg[k];
    }
    if (!inOrder) return { err: 'date_out_of_order' };
    return { day, ids };
  }

  function addBook(arg) {
    if (!isObj(arg) || !isId(arg.bookId)) return fail('invalid_input');
    if (books.has(arg.bookId)) return fail('book_exists');
    books.set(arg.bookId, {
      bookId: arg.bookId,
      status: 'available',
      loan: null,
      queue: [],
      readyUntil: null,
    });
    return { ok: true };
  }

  function addMember(arg) {
    if (!isObj(arg) || !isId(arg.memberId)) return fail('invalid_input');
    if (members.has(arg.memberId)) return fail('member_exists');
    members.set(arg.memberId, { memberId: arg.memberId, owed: 0, loans: [] });
    return { ok: true };
  }

  function borrow(arg) {
    const e = enter(arg, ['memberId', 'bookId']);
    if (e.err) return fail(e.err);
    const { day } = e;
    const { memberId, bookId } = e.ids;

    const m = members.get(memberId);
    if (!m) return fail('unknown_member');
    const b = books.get(bookId);
    if (!b) return fail('unknown_book');

    if (b.status === 'on_loan') {
      return fail(b.loan.memberId === memberId ? 'already_borrowed' : 'not_available');
    }
    if (b.status === 'set_aside' && b.queue[0].memberId !== memberId) {
      return fail('reserved_for_other');
    }
    if (m.loans.some((l) => day > l.dueDay)) return fail('overdue_loans');
    if (m.owed >= FINE_BLOCK_THRESHOLD) return fail('fines_owed');
    if (m.loans.length >= MAX_LOANS) return fail('loan_limit');

    const loan = { memberId, bookId, dueDay: day + LOAN_DAYS, renewCount: 0 };
    m.loans.push(loan);
    if (b.status === 'set_aside') {
      b.queue.shift();
      b.readyUntil = null;
    }
    b.status = 'on_loan';
    b.loan = loan;
    return { ok: true, dueDate: formatDay(loan.dueDay) };
  }

  function returnBook(arg) {
    const e = enter(arg, ['memberId', 'bookId']);
    if (e.err) return fail(e.err);
    const { day } = e;
    const { memberId, bookId } = e.ids;

    const m = members.get(memberId);
    if (!m) return fail('unknown_member');
    const b = books.get(bookId);
    if (!b) return fail('unknown_book');
    if (b.status !== 'on_loan' || b.loan.memberId !== memberId) {
      return fail('not_borrowed');
    }

    const loan = b.loan;
    const daysLate = Math.max(0, day - loan.dueDay);
    const fine = Math.min(FINE_PER_DAY * daysLate, MAX_FINE_PER_LOAN);
    m.owed += fine;
    const idx = m.loans.indexOf(loan);
    if (idx !== -1) m.loans.splice(idx, 1);
    b.loan = null;

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
    const e = enter(arg, ['memberId', 'bookId']);
    if (e.err) return fail(e.err);
    const { day } = e;
    const { memberId, bookId } = e.ids;

    const m = members.get(memberId);
    if (!m) return fail('unknown_member');
    const b = books.get(bookId);
    if (!b) return fail('unknown_book');
    if (b.status !== 'on_loan' || b.loan.memberId !== memberId) {
      return fail('not_borrowed');
    }

    const loan = b.loan;
    if (day > loan.dueDay) return fail('overdue');
    if (loan.renewCount >= MAX_RENEWALS) return fail('renewal_limit');
    if (b.queue.length > 0) return fail('has_holds');

    loan.dueDay += RENEW_DAYS;
    loan.renewCount += 1;
    return { ok: true, dueDate: formatDay(loan.dueDay) };
  }

  function placeHold(arg) {
    const e = enter(arg, ['memberId', 'bookId']);
    if (e.err) return fail(e.err);
    const { memberId, bookId } = e.ids;

    const m = members.get(memberId);
    if (!m) return fail('unknown_member');
    const b = books.get(bookId);
    if (!b) return fail('unknown_book');

    if (b.status === 'on_loan' && b.loan.memberId === memberId) {
      return fail('already_borrowed');
    }
    if (b.queue.some((q) => q.memberId === memberId)) return fail('already_held');
    if (b.status === 'available') return fail('book_available');

    seq += 1;
    b.queue.push({ memberId, seq });
    return { ok: true, position: b.queue.length };
  }

  function payFine(arg) {
    const e = enter(arg, ['memberId'], (a) => Number.isSafeInteger(a.amount) && a.amount > 0);
    if (e.err) return fail(e.err);
    const { ids } = e;
    const amount = arg.amount;

    const m = members.get(ids.memberId);
    if (!m) return fail('unknown_member');
    if (amount > m.owed) return fail('overpayment');

    m.owed -= amount;
    return { ok: true, owed: m.owed };
  }

  function getMember(arg) {
    const e = enter(arg, ['memberId']);
    if (e.err) return fail(e.err);
    const { memberId } = e.ids;

    const m = members.get(memberId);
    if (!m) return fail('unknown_member');

    const found = [];
    for (const b of books.values()) {
      b.queue.forEach((q, i) => {
        if (q.memberId === memberId) {
          const setAsideForMember = i === 0 && b.status === 'set_aside';
          found.push({
            seq: q.seq,
            bookId: b.bookId,
            position: i + 1,
            readyUntil: setAsideForMember ? formatDay(b.readyUntil) : null,
          });
        }
      });
    }
    found.sort((x, y) => x.seq - y.seq);

    return {
      ok: true,
      loans: m.loans.map((l) => ({ bookId: l.bookId, dueDate: formatDay(l.dueDay) })),
      owed: m.owed,
      holds: found.map(({ bookId, position, readyUntil }) => ({ bookId, position, readyUntil })),
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
