const DAY = 86400000;
const RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(s) {
  if (typeof s !== 'string' || !RE.test(s)) return null;
  const y = +s.slice(0, 4), m = +s.slice(5, 7), d = +s.slice(8, 10);
  if (y < 1 || y > 9999) return null;
  const dt = new Date(0);
  dt.setUTCFullYear(y, m - 1, d);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return dt.getTime();
}

function fmt(t) {
  const dt = new Date(t);
  const y = String(dt.getUTCFullYear()).padStart(4, '0');
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function addDays(s, n) {
  return fmt(parseDate(s) + n * DAY);
}

const validId = (x) => typeof x === 'string' && x.length > 0;
const FAIL = (reason) => ({ ok: false, reason });

export function createLibrary() {
  const books = new Map();
  const members = new Map();
  let current = null;

  function expire(date) {
    for (const book of books.values()) {
      while (book.setAside && date > book.readyUntil) {
        const mid = book.queue.shift();
        const mem = members.get(mid);
        const i = mem.holds.indexOf(book.id);
        if (i >= 0) mem.holds.splice(i, 1);
        if (book.queue.length > 0) {
          book.readyUntil = addDays(book.readyUntil, 8);
        } else {
          book.setAside = false;
          book.readyUntil = null;
        }
      }
    }
  }

  // Returns null on success (clock advanced, expiry done), else a failure.
  function tick(args) {
    if (args === null || typeof args !== 'object') return FAIL('args');
    const t = parseDate(args.date);
    if (t === null) return FAIL('date');
    if (current !== null && args.date < current) return FAIL('past');
    current = args.date;
    expire(args.date);
    return null;
  }

  function addBook(args) {
    if (args === null || typeof args !== 'object') return FAIL('args');
    const { bookId } = args;
    if (!validId(bookId) || books.has(bookId)) return FAIL('book');
    books.set(bookId, { id: bookId, loan: null, queue: [], setAside: false, readyUntil: null });
    return { ok: true };
  }

  function addMember(args) {
    if (args === null || typeof args !== 'object') return FAIL('args');
    const { memberId } = args;
    if (!validId(memberId) || members.has(memberId)) return FAIL('member');
    members.set(memberId, { loans: [], holds: [], owed: 0 });
    return { ok: true };
  }

  function lookup(args) {
    if (!validId(args.memberId) || !validId(args.bookId)) return null;
    const mem = members.get(args.memberId);
    const book = books.get(args.bookId);
    if (!mem || !book) return null;
    return { mem, book };
  }

  function borrow(args) {
    const f = tick(args); if (f) return f;
    const r = lookup(args); if (!r) return FAIL('unknown');
    const { mem, book } = r;
    const { memberId, bookId, date } = args;
    if (book.loan) return FAIL('onloan');
    if (book.setAside && book.queue[0] !== memberId) return FAIL('setaside');
    if (mem.loans.length >= 5) return FAIL('limit');
    for (const b of mem.loans) if (books.get(b).loan.dueDate < date) return FAIL('overdue');
    if (mem.owed >= 1000) return FAIL('owed');
    if (book.setAside) {
      book.queue.shift();
      book.setAside = false;
      book.readyUntil = null;
      const i = mem.holds.indexOf(bookId);
      if (i >= 0) mem.holds.splice(i, 1);
    }
    const dueDate = addDays(date, 21);
    book.loan = { memberId, dueDate, renewals: 0 };
    mem.loans.push(bookId);
    return { ok: true, dueDate };
  }

  function returnBook(args) {
    const f = tick(args); if (f) return f;
    const r = lookup(args); if (!r) return FAIL('unknown');
    const { mem, book } = r;
    const { memberId, bookId, date } = args;
    if (!book.loan || book.loan.memberId !== memberId) return FAIL('notloan');
    const late = Math.max(0, Math.round((parseDate(date) - parseDate(book.loan.dueDate)) / DAY));
    const fine = Math.min(500, 25 * Math.max(0, late - 2));
    mem.owed += fine;
    book.loan = null;
    const i = mem.loans.indexOf(bookId);
    if (i >= 0) mem.loans.splice(i, 1);
    if (book.queue.length > 0) {
      book.setAside = true;
      book.readyUntil = addDays(date, 7);
    } else {
      book.setAside = false;
      book.readyUntil = null;
    }
    return { ok: true, fine };
  }

  function renew(args) {
    const f = tick(args); if (f) return f;
    const r = lookup(args); if (!r) return FAIL('unknown');
    const { book } = r;
    const { memberId, date } = args;
    if (!book.loan || book.loan.memberId !== memberId) return FAIL('notloan');
    if (book.loan.renewals >= 2) return FAIL('renewals');
    if (date > book.loan.dueDate) return FAIL('overdue');
    if (book.queue.length > 0) return FAIL('holds');
    book.loan.dueDate = addDays(date, 21);
    book.loan.renewals++;
    return { ok: true, dueDate: book.loan.dueDate };
  }

  function placeHold(args) {
    const f = tick(args); if (f) return f;
    const r = lookup(args); if (!r) return FAIL('unknown');
    const { mem, book } = r;
    const { memberId, bookId } = args;
    if (!book.loan && !book.setAside) return FAIL('available');
    if (book.loan && book.loan.memberId === memberId) return FAIL('hasloan');
    if (book.queue.includes(memberId)) return FAIL('duplicate');
    if (mem.holds.length >= 5) return FAIL('holdlimit');
    book.queue.push(memberId);
    mem.holds.push(bookId);
    return { ok: true, position: book.queue.length };
  }

  function payFine(args) {
    const f = tick(args); if (f) return f;
    if (!validId(args.memberId)) return FAIL('member');
    const mem = members.get(args.memberId);
    if (!mem) return FAIL('unknown');
    const a = args.amount;
    if (typeof a !== 'number' || !Number.isSafeInteger(a) || a <= 0) return FAIL('amount');
    if (a > mem.owed) return FAIL('overpay');
    mem.owed -= a;
    return { ok: true, owed: mem.owed };
  }

  function getMember(args) {
    const f = tick(args); if (f) return f;
    if (!validId(args.memberId)) return FAIL('member');
    const mem = members.get(args.memberId);
    if (!mem) return FAIL('unknown');
    return {
      ok: true,
      loans: mem.loans.map((b) => ({ bookId: b, dueDate: books.get(b).loan.dueDate })),
      owed: mem.owed,
      holds: mem.holds.map((b) => {
        const book = books.get(b);
        const pos = book.queue.indexOf(args.memberId);
        return {
          bookId: b,
          position: pos + 1,
          readyUntil: book.setAside && pos === 0 ? book.readyUntil : null,
        };
      }),
    };
  }

  return { addBook, addMember, borrow, returnBook, renew, placeHold, payFine, getMember };
}
