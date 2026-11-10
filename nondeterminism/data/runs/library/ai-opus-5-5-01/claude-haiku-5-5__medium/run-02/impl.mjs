const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const RENEWAL_DAYS = 21;
const FINE_PER_DAY = 25;
const MAX_FINE = 500;
const FINE_BLOCK = 500;
const MAX_LOANS = 5;
const PICKUP_DAYS = 7;
const DAY_MS = 86400000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const INVALID = 'invalid_input';

function parseDay(s) {
  if (typeof s !== 'string') return null;
  const m = DATE_RE.exec(s);
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

function fmtDay(n) {
  const dt = new Date(n * DAY_MS);
  const y = String(dt.getUTCFullYear()).padStart(4, '0');
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function isObj(a) {
  return typeof a === 'object' && a !== null && !Array.isArray(a);
}

function isId(x) {
  return typeof x === 'string' && x.length > 0;
}

function fail(reason) {
  return { ok: false, reason };
}

function guard(fn) {
  return (arg) => {
    try {
      return fn(arg);
    } catch {
      return fail(INVALID);
    }
  };
}

export function createLibrary() {
  const books = new Map();
  const members = new Map();
  let latest = null;
  let holdSeq = 0;

  // Applies pickup expiry for every set-aside book whose readyUntil < day.
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

  // Checks time order, records the date, and applies expiry.
  // Returns a reason string on failure, or null on success.
  function advance(day) {
    if (latest !== null && day < latest) return 'date_out_of_order';
    latest = day;
    expire(day);
    return null;
  }

  return {
    addBook: guard((arg) => {
      if (!isObj(arg)) return fail(INVALID);
      const bookId = arg.bookId;
      if (!isId(bookId)) return fail(INVALID);
      if (books.has(bookId)) return fail('book_exists');
      books.set(bookId, { status: 'available', borrower: null, queue: [], readyUntil: null });
      return { ok: true };
    }),

    addMember: guard((arg) => {
      if (!isObj(arg)) return fail(INVALID);
      const memberId = arg.memberId;
      if (!isId(memberId)) return fail(INVALID);
      if (members.has(memberId)) return fail('member_exists');
      members.set(memberId, { owed: 0, loans: [] });
      return { ok: true };
    }),

    borrow: guard((arg) => {
      if (!isObj(arg)) return fail(INVALID);
      const memberId = arg.memberId;
      const bookId = arg.bookId;
      const day = parseDay(arg.date);
      if (!isId(memberId) || !isId(bookId) || day === null) return fail(INVALID);
      const ord = advance(day);
      if (ord) return fail(ord);

      const member = members.get(memberId);
      if (!member) return fail('unknown_member');
      const book = books.get(bookId);
      if (!book) return fail('unknown_book');

      if (book.status === 'on_loan') {
        return fail(book.borrower === memberId ? 'already_borrowed' : 'not_available');
      }
      if (book.status === 'set_aside' && book.queue[0].memberId !== memberId) {
        return fail('reserved_for_other');
      }
      if (member.loans.some((l) => day > l.dueDay)) return fail('overdue_loans');
      if (member.owed >= FINE_BLOCK) return fail('fines_owed');
      if (member.loans.length >= MAX_LOANS) return fail('loan_limit');

      const dueDay = day + LOAN_DAYS;
      member.loans.push({ bookId, dueDay, renewCount: 0 });
      if (book.status === 'set_aside') {
        book.queue.shift();
      }
      book.status = 'on_loan';
      book.borrower = memberId;
      book.readyUntil = null;
      return { ok: true, dueDate: fmtDay(dueDay) };
    }),

    returnBook: guard((arg) => {
      if (!isObj(arg)) return fail(INVALID);
      const memberId = arg.memberId;
      const bookId = arg.bookId;
      const day = parseDay(arg.date);
      if (!isId(memberId) || !isId(bookId) || day === null) return fail(INVALID);
      const ord = advance(day);
      if (ord) return fail(ord);

      const member = members.get(memberId);
      if (!member) return fail('unknown_member');
      const book = books.get(bookId);
      if (!book) return fail('unknown_book');

      const idx = member.loans.findIndex((l) => l.bookId === bookId);
      if (idx < 0) return fail('not_borrowed');
      const loan = member.loans[idx];

      const late = Math.max(0, day - loan.dueDay);
      const fine = Math.min(FINE_PER_DAY * late, MAX_FINE);
      member.owed += fine;
      member.loans.splice(idx, 1);

      book.borrower = null;
      if (book.queue.length === 0) {
        book.status = 'available';
        book.readyUntil = null;
      } else {
        book.status = 'set_aside';
        book.readyUntil = day + PICKUP_DAYS;
      }
      return { ok: true, fine };
    }),

    renew: guard((arg) => {
      if (!isObj(arg)) return fail(INVALID);
      const memberId = arg.memberId;
      const bookId = arg.bookId;
      const day = parseDay(arg.date);
      if (!isId(memberId) || !isId(bookId) || day === null) return fail(INVALID);
      const ord = advance(day);
      if (ord) return fail(ord);

      const member = members.get(memberId);
      if (!member) return fail('unknown_member');
      const book = books.get(bookId);
      if (!book) return fail('unknown_book');

      const loan = member.loans.find((l) => l.bookId === bookId);
      if (!loan) return fail('not_borrowed');
      if (day > loan.dueDay) return fail('overdue');
      if (loan.renewCount >= MAX_RENEWALS) return fail('renewal_limit');
      if (book.queue.length > 0) return fail('has_holds');

      loan.dueDay += RENEWAL_DAYS;
      loan.renewCount += 1;
      return { ok: true, dueDate: fmtDay(loan.dueDay) };
    }),

    placeHold: guard((arg) => {
      if (!isObj(arg)) return fail(INVALID);
      const memberId = arg.memberId;
      const bookId = arg.bookId;
      const day = parseDay(arg.date);
      if (!isId(memberId) || !isId(bookId) || day === null) return fail(INVALID);
      const ord = advance(day);
      if (ord) return fail(ord);

      const member = members.get(memberId);
      if (!member) return fail('unknown_member');
      const book = books.get(bookId);
      if (!book) return fail('unknown_book');

      if (member.loans.some((l) => l.bookId === bookId)) return fail('already_borrowed');
      if (book.queue.some((e) => e.memberId === memberId)) return fail('already_held');
      if (book.status === 'available') return fail('book_available');

      book.queue.push({ memberId, seq: holdSeq });
      holdSeq += 1;
      return { ok: true, position: book.queue.length };
    }),

    payFine: guard((arg) => {
      if (!isObj(arg)) return fail(INVALID);
      const memberId = arg.memberId;
      const amount = arg.amount;
      const day = parseDay(arg.date);
      if (!isId(memberId) || !Number.isInteger(amount) || amount <= 0 || day === null) {
        return fail(INVALID);
      }
      const ord = advance(day);
      if (ord) return fail(ord);

      const member = members.get(memberId);
      if (!member) return fail('unknown_member');
      if (amount > member.owed) return fail('overpayment');

      member.owed -= amount;
      return { ok: true, owed: member.owed };
    }),

    getMember: guard((arg) => {
      if (!isObj(arg)) return fail(INVALID);
      const memberId = arg.memberId;
      const day = parseDay(arg.date);
      if (!isId(memberId) || day === null) return fail(INVALID);
      const ord = advance(day);
      if (ord) return fail(ord);

      const member = members.get(memberId);
      if (!member) return fail('unknown_member');

      const loans = member.loans.map((l) => ({
        bookId: l.bookId,
        dueDate: fmtDay(l.dueDay),
      }));

      const found = [];
      for (const [bookId, book] of books) {
        const idx = book.queue.findIndex((e) => e.memberId === memberId);
        if (idx < 0) continue;
        const setAsideForMember = book.status === 'set_aside' && idx === 0;
        found.push({
          bookId,
          position: idx + 1,
          readyUntil: setAsideForMember ? fmtDay(book.readyUntil) : null,
          seq: book.queue[idx].seq,
        });
      }
      found.sort((a, b) => a.seq - b.seq);
      const holds = found.map(({ bookId, position, readyUntil }) => ({
        bookId,
        position,
        readyUntil,
      }));

      return { ok: true, loans, owed: member.owed, holds };
    }),
  };
}
