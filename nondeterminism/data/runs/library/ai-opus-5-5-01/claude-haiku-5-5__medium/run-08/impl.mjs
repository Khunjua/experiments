const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86400000;
const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const RENEW_DAYS = 21;
const FINE_PER_DAY = 25;
const MAX_FINE = 500;
const FINE_BLOCK = 500;
const MAX_LOANS = 5;
const PICKUP_DAYS = 7;

function isObj(a) {
  return a !== null && typeof a === 'object' && !Array.isArray(a);
}

function isId(v) {
  return typeof v === 'string' && v.length > 0;
}

function isAmount(v) {
  return Number.isInteger(v) && v > 0;
}

// Returns integer day number (days since 1970-01-01, UTC) or null if invalid.
function dayOf(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return Math.round(t.getTime() / DAY_MS);
}

function fmt(day) {
  const t = new Date(day * DAY_MS);
  const y = String(t.getUTCFullYear()).padStart(4, '0');
  const m = String(t.getUTCMonth() + 1).padStart(2, '0');
  const d = String(t.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function createLibrary() {
  // bookId -> { status: 'available' | 'on_loan' | 'set_aside', borrower, queue: [{ memberId, seq }], readyUntil }
  const books = new Map();
  // memberId -> { owed, loans: [{ bookId, dueDay, renewCount }] }
  const members = new Map();
  let latest = null;
  let holdSeq = 0;

  const fail = (reason) => ({ ok: false, reason });

  const guard = (fn) => (arg) => {
    try {
      return fn(arg);
    } catch {
      return fail('invalid_input');
    }
  };

  function resolveExpiry(day) {
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

  // Applies the date gate for a dated call. Returns a failure reason or null.
  function advance(day, fieldsOk) {
    if (day === null) return 'invalid_input';
    if (latest !== null && day < latest) {
      return fieldsOk ? 'date_out_of_order' : 'invalid_input';
    }
    latest = day;
    resolveExpiry(day);
    return fieldsOk ? null : 'invalid_input';
  }

  const addBook = guard((arg) => {
    if (!isObj(arg) || !isId(arg.bookId)) return fail('invalid_input');
    if (books.has(arg.bookId)) return fail('book_exists');
    books.set(arg.bookId, { status: 'available', borrower: null, queue: [], readyUntil: null });
    return { ok: true };
  });

  const addMember = guard((arg) => {
    if (!isObj(arg) || !isId(arg.memberId)) return fail('invalid_input');
    if (members.has(arg.memberId)) return fail('member_exists');
    members.set(arg.memberId, { owed: 0, loans: [] });
    return { ok: true };
  });

  const borrow = guard((arg) => {
    if (!isObj(arg)) return fail('invalid_input');
    const { memberId, bookId } = arg;
    const day = dayOf(arg.date);
    const r = advance(day, isId(memberId) && isId(bookId));
    if (r) return fail(r);

    const member = members.get(memberId);
    if (!member) return fail('unknown_member');
    const book = books.get(bookId);
    if (!book) return fail('unknown_book');

    if (book.status === 'on_loan') {
      return fail(book.borrower === memberId ? 'already_borrowed' : 'not_available');
    }
    const reservedHere = book.status === 'set_aside' && book.queue[0].memberId === memberId;
    if (book.status === 'set_aside' && !reservedHere) return fail('reserved_for_other');
    if (member.loans.some((l) => l.dueDay < day)) return fail('overdue_loans');
    if (member.owed >= FINE_BLOCK) return fail('fines_owed');
    if (member.loans.length >= MAX_LOANS) return fail('loan_limit');

    if (reservedHere) book.queue.shift();
    book.status = 'on_loan';
    book.borrower = memberId;
    book.readyUntil = null;
    const dueDay = day + LOAN_DAYS;
    member.loans.push({ bookId, dueDay, renewCount: 0 });
    return { ok: true, dueDate: fmt(dueDay) };
  });

  const returnBook = guard((arg) => {
    if (!isObj(arg)) return fail('invalid_input');
    const { memberId, bookId } = arg;
    const day = dayOf(arg.date);
    const r = advance(day, isId(memberId) && isId(bookId));
    if (r) return fail(r);

    const member = members.get(memberId);
    if (!member) return fail('unknown_member');
    const book = books.get(bookId);
    if (!book) return fail('unknown_book');

    const idx = member.loans.findIndex((l) => l.bookId === bookId);
    if (idx < 0) return fail('not_borrowed');
    const loan = member.loans[idx];
    member.loans.splice(idx, 1);

    const late = Math.max(0, day - loan.dueDay);
    const fine = Math.min(FINE_PER_DAY * late, MAX_FINE);
    member.owed += fine;

    book.borrower = null;
    if (book.queue.length === 0) {
      book.status = 'available';
      book.readyUntil = null;
    } else {
      book.status = 'set_aside';
      book.readyUntil = day + PICKUP_DAYS;
    }
    return { ok: true, fine };
  });

  const renew = guard((arg) => {
    if (!isObj(arg)) return fail('invalid_input');
    const { memberId, bookId } = arg;
    const day = dayOf(arg.date);
    const r = advance(day, isId(memberId) && isId(bookId));
    if (r) return fail(r);

    const member = members.get(memberId);
    if (!member) return fail('unknown_member');
    const book = books.get(bookId);
    if (!book) return fail('unknown_book');

    const loan = member.loans.find((l) => l.bookId === bookId);
    if (!loan) return fail('not_borrowed');
    if (day > loan.dueDay) return fail('overdue');
    if (loan.renewCount >= MAX_RENEWALS) return fail('renewal_limit');
    if (book.queue.length > 0) return fail('has_holds');

    loan.dueDay += RENEW_DAYS;
    loan.renewCount += 1;
    return { ok: true, dueDate: fmt(loan.dueDay) };
  });

  const placeHold = guard((arg) => {
    if (!isObj(arg)) return fail('invalid_input');
    const { memberId, bookId } = arg;
    const day = dayOf(arg.date);
    const r = advance(day, isId(memberId) && isId(bookId));
    if (r) return fail(r);

    const member = members.get(memberId);
    if (!member) return fail('unknown_member');
    const book = books.get(bookId);
    if (!book) return fail('unknown_book');

    if (member.loans.some((l) => l.bookId === bookId)) return fail('already_borrowed');
    if (book.queue.some((e) => e.memberId === memberId)) return fail('already_held');
    if (book.status === 'available') return fail('book_available');

    book.queue.push({ memberId, seq: ++holdSeq });
    return { ok: true, position: book.queue.length };
  });

  const payFine = guard((arg) => {
    if (!isObj(arg)) return fail('invalid_input');
    const { memberId, amount } = arg;
    const day = dayOf(arg.date);
    const r = advance(day, isId(memberId) && isAmount(amount));
    if (r) return fail(r);

    const member = members.get(memberId);
    if (!member) return fail('unknown_member');
    if (amount > member.owed) return fail('overpayment');

    member.owed -= amount;
    return { ok: true, owed: member.owed };
  });

  const getMember = guard((arg) => {
    if (!isObj(arg)) return fail('invalid_input');
    const { memberId } = arg;
    const day = dayOf(arg.date);
    const r = advance(day, isId(memberId));
    if (r) return fail(r);

    const member = members.get(memberId);
    if (!member) return fail('unknown_member');

    const loans = member.loans.map((l) => ({ bookId: l.bookId, dueDate: fmt(l.dueDay) }));

    const found = [];
    for (const [bookId, book] of books) {
      const i = book.queue.findIndex((e) => e.memberId === memberId);
      if (i < 0) continue;
      const reserved = i === 0 && book.status === 'set_aside';
      found.push({
        bookId,
        position: i + 1,
        readyUntil: reserved ? fmt(book.readyUntil) : null,
        seq: book.queue[i].seq,
      });
    }
    found.sort((a, b) => a.seq - b.seq);
    const holds = found.map(({ bookId, position, readyUntil }) => ({ bookId, position, readyUntil }));

    return { ok: true, loans, owed: member.owed, holds };
  });

  return { addBook, addMember, borrow, returnBook, renew, placeHold, payFine, getMember };
}
