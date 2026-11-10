export function createLibrary() {
  const LOAN_DAYS = 21;
  const MAX_RENEWALS = 2;
  const RENEW_DAYS = 21;
  const FINE_RATE = 25;
  const GRACE = 2;
  const MAX_FINE = 500;
  const MAX_LOANS = 5;
  const OWED_BLOCK = 1000;
  const MAX_HOLDS = 5;
  const PICKUP_DAYS = 7;

  const books = new Map();   // bookId -> { loan, queue: [{memberId, seq}], readyUntil }
  const members = new Map(); // memberId -> { owed, loans: [bookId], holds: [{bookId, seq}] }
  let currentDay = null;
  let holdSeq = 0;

  const fail = (reason) => ({ ok: false, reason });

  function isId(v) {
    return typeof v === 'string' && v.length > 0;
  }

  function isObj(a) {
    return typeof a === 'object' && a !== null;
  }

  function daysFromCivil(y, m, d) {
    y -= m <= 2 ? 1 : 0;
    const era = Math.floor(y / 400);
    const yoe = y - era * 400;
    const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
    const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
    return era * 146097 + doe - 719468;
  }

  function civilFromDays(z) {
    z += 719468;
    const era = Math.floor(z / 146097);
    const doe = z - era * 146097;
    const yoe = Math.floor(
      (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365
    );
    let y = yoe + era * 400;
    const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
    const mp = Math.floor((5 * doy + 2) / 153);
    const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
    const m = mp < 10 ? mp + 3 : mp - 9;
    if (m <= 2) y += 1;
    return { y, m, d };
  }

  function parseDate(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const y = Number(s.slice(0, 4));
    const m = Number(s.slice(5, 7));
    const d = Number(s.slice(8, 10));
    if (y < 1 || y > 9999 || m < 1 || m > 12 || d < 1) return null;
    const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    const dim = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
    if (d > dim) return null;
    return daysFromCivil(y, m, d);
  }

  function fmt(day) {
    const { y, m, d } = civilFromDays(day);
    return String(y).padStart(4, '0') + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  }

  function removeMemberHold(memberId, bookId) {
    const mem = members.get(memberId);
    if (!mem) return;
    const i = mem.holds.findIndex((h) => h.bookId === bookId);
    if (i >= 0) mem.holds.splice(i, 1);
  }

  function processExpiry(day) {
    for (const [bookId, book] of books) {
      while (!book.loan && book.queue.length > 0 && book.readyUntil !== null && day > book.readyUntil) {
        const expired = book.queue.shift();
        removeMemberHold(expired.memberId, bookId);
        if (book.queue.length > 0) {
          book.readyUntil = book.readyUntil + 1 + PICKUP_DAYS;
        } else {
          book.readyUntil = null;
        }
      }
    }
  }

  // Returns day number, or null on failure (invalid or earlier date).
  function enterDated(dateStr) {
    const day = parseDate(dateStr);
    if (day === null) return null;
    if (currentDay !== null && day < currentDay) return null;
    currentDay = day;
    processExpiry(day);
    return day;
  }

  function isSetAside(book) {
    return !book.loan && book.queue.length > 0;
  }

  function addBook(args) {
    if (!isObj(args)) return fail('invalid');
    const { bookId } = args;
    if (!isId(bookId)) return fail('invalid');
    if (books.has(bookId)) return fail('exists');
    books.set(bookId, { loan: null, queue: [], readyUntil: null });
    return { ok: true };
  }

  function addMember(args) {
    if (!isObj(args)) return fail('invalid');
    const { memberId } = args;
    if (!isId(memberId)) return fail('invalid');
    if (members.has(memberId)) return fail('exists');
    members.set(memberId, { owed: 0, loans: [], holds: [] });
    return { ok: true };
  }

  function borrow(args) {
    if (!isObj(args)) return fail('invalid');
    const { memberId, bookId, date } = args;
    const day = enterDated(date);
    if (day === null) return fail('date');
    if (!isId(memberId) || !isId(bookId)) return fail('invalid');
    const mem = members.get(memberId);
    const book = books.get(bookId);
    if (!mem || !book) return fail('unknown');
    if (book.loan) return fail('on loan');
    const setAside = isSetAside(book);
    if (setAside && book.queue[0].memberId !== memberId) return fail('set aside');
    if (mem.loans.length >= MAX_LOANS) return fail('loan limit');
    for (const bid of mem.loans) {
      if (books.get(bid).loan.dueDate < day) return fail('overdue');
    }
    if (mem.owed >= OWED_BLOCK) return fail('owed');

    if (setAside) {
      book.queue.shift();
      book.readyUntil = null;
      removeMemberHold(memberId, bookId);
    }
    const dueDate = day + LOAN_DAYS;
    book.loan = { memberId, dueDate, renewals: 0 };
    mem.loans.push(bookId);
    return { ok: true, dueDate: fmt(dueDate) };
  }

  function returnBook(args) {
    if (!isObj(args)) return fail('invalid');
    const { memberId, bookId, date } = args;
    const day = enterDated(date);
    if (day === null) return fail('date');
    if (!isId(memberId) || !isId(bookId)) return fail('invalid');
    const mem = members.get(memberId);
    const book = books.get(bookId);
    if (!mem || !book) return fail('unknown');
    if (!book.loan || book.loan.memberId !== memberId) return fail('not on loan');

    const daysLate = Math.max(0, day - book.loan.dueDate);
    const fine = Math.min(MAX_FINE, FINE_RATE * Math.max(0, daysLate - GRACE));
    mem.owed += fine;
    book.loan = null;
    const i = mem.loans.indexOf(bookId);
    if (i >= 0) mem.loans.splice(i, 1);
    book.readyUntil = book.queue.length > 0 ? day + PICKUP_DAYS : null;
    return { ok: true, fine };
  }

  function renew(args) {
    if (!isObj(args)) return fail('invalid');
    const { memberId, bookId, date } = args;
    const day = enterDated(date);
    if (day === null) return fail('date');
    if (!isId(memberId) || !isId(bookId)) return fail('invalid');
    const mem = members.get(memberId);
    const book = books.get(bookId);
    if (!mem || !book) return fail('unknown');
    const loan = book.loan;
    if (!loan || loan.memberId !== memberId) return fail('not on loan');
    if (loan.renewals >= MAX_RENEWALS) return fail('renewal limit');
    if (day > loan.dueDate) return fail('overdue');
    if (book.queue.length > 0) return fail('holds');
    loan.dueDate = Math.max(loan.dueDate, day + RENEW_DAYS);
    loan.renewals += 1;
    return { ok: true, dueDate: fmt(loan.dueDate) };
  }

  function placeHold(args) {
    if (!isObj(args)) return fail('invalid');
    const { memberId, bookId, date } = args;
    const day = enterDated(date);
    if (day === null) return fail('date');
    if (!isId(memberId) || !isId(bookId)) return fail('invalid');
    const mem = members.get(memberId);
    const book = books.get(bookId);
    if (!mem || !book) return fail('unknown');
    if (!book.loan && book.queue.length === 0) return fail('available');
    if (book.loan && book.loan.memberId === memberId) return fail('own loan');
    if (book.queue.some((h) => h.memberId === memberId)) return fail('duplicate');
    if (mem.holds.length >= MAX_HOLDS) return fail('hold limit');
    const seq = ++holdSeq;
    book.queue.push({ memberId, seq });
    mem.holds.push({ bookId, seq });
    return { ok: true, position: book.queue.length };
  }

  function payFine(args) {
    if (!isObj(args)) return fail('invalid');
    const { memberId, amount, date } = args;
    const day = enterDated(date);
    if (day === null) return fail('date');
    if (!isId(memberId)) return fail('invalid');
    if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount <= 0) return fail('amount');
    const mem = members.get(memberId);
    if (!mem) return fail('unknown');
    if (amount > mem.owed) return fail('overpay');
    mem.owed -= amount;
    return { ok: true, owed: mem.owed };
  }

  function getMember(args) {
    if (!isObj(args)) return fail('invalid');
    const { memberId, date } = args;
    const day = enterDated(date);
    if (day === null) return fail('date');
    if (!isId(memberId)) return fail('invalid');
    const mem = members.get(memberId);
    if (!mem) return fail('unknown');
    const loans = mem.loans.map((bid) => ({ bookId: bid, dueDate: fmt(books.get(bid).loan.dueDate) }));
    const holds = mem.holds.map((h) => {
      const book = books.get(h.bookId);
      const idx = book.queue.findIndex((q) => q.memberId === memberId);
      const ready = idx === 0 && isSetAside(book) && book.readyUntil !== null;
      return { bookId: h.bookId, position: idx + 1, readyUntil: ready ? fmt(book.readyUntil) : null };
    });
    return { ok: true, loans, owed: mem.owed, holds };
  }

  return { addBook, addMember, borrow, returnBook, renew, placeHold, payFine, getMember };
}
