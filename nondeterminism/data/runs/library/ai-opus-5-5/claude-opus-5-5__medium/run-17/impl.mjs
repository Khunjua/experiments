const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const RENEW_DAYS = 21;
const FINE_RATE = 25;
const GRACE_DAYS = 2;
const MAX_FINE = 500;
const MAX_LOANS = 5;
const OWED_BLOCK = 1000;
const MAX_HOLDS = 5;
const PICKUP_DAYS = 7;

function daysFromCivil(y, m, d) {
  y -= m <= 2 ? 1 : 0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = (m + 9) % 12;
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(z) {
  z += 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  let y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  if (m <= 2) y += 1;
  return [y, m, d];
}

function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function parseDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (y < 1 || y > 9999 || m < 1 || m > 12 || d < 1) return null;
  const dim = [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  if (d > dim) return null;
  return daysFromCivil(y, m, d);
}

function formatDate(n) {
  const [y, m, d] = civilFromDays(n);
  return String(y).padStart(4, '0') + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

function isId(v) {
  return typeof v === 'string' && v.length > 0;
}

function getArgs(a) {
  return a !== null && typeof a === 'object' ? a : null;
}

const FAIL = (reason) => ({ ok: false, reason });

export function createLibrary() {
  const books = new Map();   // bookId -> { loan: {memberId, due, renewals} | null, queue: [hold], readyUntil: number|null }
  const members = new Map(); // memberId -> { loans: [bookId], owed, holds: [hold] }
  let current = null;

  function processExpiry(day) {
    for (const book of books.values()) {
      while (book.loan === null && book.queue.length > 0 && book.readyUntil !== null && day > book.readyUntil) {
        const prev = book.readyUntil;
        const hold = book.queue.shift();
        hold.active = false;
        if (book.queue.length > 0) {
          book.readyUntil = prev + 1 + PICKUP_DAYS;
        } else {
          book.readyUntil = null;
        }
      }
    }
  }

  // Returns day number or null on failure (invalid date or earlier than clock).
  function tick(dateStr) {
    const day = parseDate(dateStr);
    if (day === null) return null;
    if (current !== null && day < current) return null;
    current = day;
    processExpiry(day);
    return day;
  }

  function isSetAside(book) {
    return book.loan === null && book.queue.length > 0;
  }

  function activeHoldCount(member) {
    let c = 0;
    for (const h of member.holds) if (h.active) c++;
    return c;
  }

  return {
    addBook(args) {
      const a = getArgs(args);
      if (!a || !isId(a.bookId)) return FAIL('invalid');
      if (books.has(a.bookId)) return FAIL('exists');
      books.set(a.bookId, { loan: null, queue: [], readyUntil: null });
      return { ok: true };
    },

    addMember(args) {
      const a = getArgs(args);
      if (!a || !isId(a.memberId)) return FAIL('invalid');
      if (members.has(a.memberId)) return FAIL('exists');
      members.set(a.memberId, { loans: [], owed: 0, holds: [] });
      return { ok: true };
    },

    borrow(args) {
      const a = getArgs(args);
      if (!a) return FAIL('invalid');
      const day = tick(a.date);
      if (day === null) return FAIL('date');
      if (!isId(a.memberId) || !isId(a.bookId)) return FAIL('invalid');
      const member = members.get(a.memberId);
      const book = books.get(a.bookId);
      if (!member || !book) return FAIL('unknown');
      if (book.loan !== null) return FAIL('on loan');
      const setAside = isSetAside(book);
      if (setAside && book.queue[0].memberId !== a.memberId) return FAIL('set aside');
      if (member.loans.length >= MAX_LOANS) return FAIL('too many loans');
      for (const bid of member.loans) {
        if (books.get(bid).loan.due < day) return FAIL('overdue');
      }
      if (member.owed >= OWED_BLOCK) return FAIL('owes');
      if (setAside) {
        const hold = book.queue.shift();
        hold.active = false;
        book.readyUntil = null;
      }
      const due = day + LOAN_DAYS;
      book.loan = { memberId: a.memberId, due, renewals: 0 };
      member.loans.push(a.bookId);
      return { ok: true, dueDate: formatDate(due) };
    },

    returnBook(args) {
      const a = getArgs(args);
      if (!a) return FAIL('invalid');
      const day = tick(a.date);
      if (day === null) return FAIL('date');
      if (!isId(a.memberId) || !isId(a.bookId)) return FAIL('invalid');
      const member = members.get(a.memberId);
      const book = books.get(a.bookId);
      if (!member || !book) return FAIL('unknown');
      if (book.loan === null || book.loan.memberId !== a.memberId) return FAIL('not on loan');
      const daysLate = Math.max(0, day - book.loan.due);
      const fine = Math.min(MAX_FINE, FINE_RATE * Math.max(0, daysLate - GRACE_DAYS));
      member.owed += fine;
      member.loans.splice(member.loans.indexOf(a.bookId), 1);
      book.loan = null;
      book.readyUntil = book.queue.length > 0 ? day + PICKUP_DAYS : null;
      return { ok: true, fine };
    },

    renew(args) {
      const a = getArgs(args);
      if (!a) return FAIL('invalid');
      const day = tick(a.date);
      if (day === null) return FAIL('date');
      if (!isId(a.memberId) || !isId(a.bookId)) return FAIL('invalid');
      const member = members.get(a.memberId);
      const book = books.get(a.bookId);
      if (!member || !book) return FAIL('unknown');
      if (book.loan === null || book.loan.memberId !== a.memberId) return FAIL('not on loan');
      if (book.loan.renewals >= MAX_RENEWALS) return FAIL('max renewals');
      if (day > book.loan.due) return FAIL('overdue');
      if (book.queue.length > 0) return FAIL('holds');
      book.loan.due = day + RENEW_DAYS;
      book.loan.renewals += 1;
      return { ok: true, dueDate: formatDate(book.loan.due) };
    },

    placeHold(args) {
      const a = getArgs(args);
      if (!a) return FAIL('invalid');
      const day = tick(a.date);
      if (day === null) return FAIL('date');
      if (!isId(a.memberId) || !isId(a.bookId)) return FAIL('invalid');
      const member = members.get(a.memberId);
      const book = books.get(a.bookId);
      if (!member || !book) return FAIL('unknown');
      if (book.loan === null && book.queue.length === 0) return FAIL('available');
      if (book.loan !== null && book.loan.memberId === a.memberId) return FAIL('own loan');
      if (book.queue.some((h) => h.memberId === a.memberId)) return FAIL('already held');
      if (activeHoldCount(member) >= MAX_HOLDS) return FAIL('too many holds');
      const hold = { memberId: a.memberId, bookId: a.bookId, active: true };
      book.queue.push(hold);
      member.holds.push(hold);
      return { ok: true, position: book.queue.length };
    },

    payFine(args) {
      const a = getArgs(args);
      if (!a) return FAIL('invalid');
      const day = tick(a.date);
      if (day === null) return FAIL('date');
      if (!isId(a.memberId)) return FAIL('invalid');
      if (typeof a.amount !== 'number' || !Number.isSafeInteger(a.amount) || a.amount <= 0) return FAIL('amount');
      const member = members.get(a.memberId);
      if (!member) return FAIL('unknown');
      if (a.amount > member.owed) return FAIL('overpay');
      member.owed -= a.amount;
      return { ok: true, owed: member.owed };
    },

    getMember(args) {
      const a = getArgs(args);
      if (!a) return FAIL('invalid');
      const day = tick(a.date);
      if (day === null) return FAIL('date');
      if (!isId(a.memberId)) return FAIL('invalid');
      const member = members.get(a.memberId);
      if (!member) return FAIL('unknown');
      const loans = member.loans.map((bid) => ({ bookId: bid, dueDate: formatDate(books.get(bid).loan.due) }));
      const holds = [];
      member.holds = member.holds.filter((h) => h.active);
      for (const h of member.holds) {
        const book = books.get(h.bookId);
        const idx = book.queue.indexOf(h);
        const ready = idx === 0 && book.loan === null;
        holds.push({ bookId: h.bookId, position: idx + 1, readyUntil: ready ? formatDate(book.readyUntil) : null });
      }
      return { ok: true, loans, owed: member.owed, holds };
    },
  };
}
