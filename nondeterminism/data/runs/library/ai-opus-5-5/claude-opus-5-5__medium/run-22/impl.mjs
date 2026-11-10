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

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y, m) {
  if (m === 2) return isLeap(y) ? 29 : 28;
  return [31, 0, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

function utcDay(y, m, d) {
  const dt = new Date(0);
  dt.setUTCFullYear(y, m - 1, d);
  dt.setUTCHours(0, 0, 0, 0);
  return Math.round(dt.getTime() / 86400000);
}

const MAX_DAY = utcDay(9999, 12, 31);

function parseDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (y < 1 || y > 9999) return null;
  if (m < 1 || m > 12) return null;
  if (d < 1 || d > daysInMonth(y, m)) return null;
  return utcDay(y, m, d);
}

function formatDate(n) {
  const dt = new Date(n * 86400000);
  const y = dt.getUTCFullYear();
  const m = dt.getUTCMonth() + 1;
  const d = dt.getUTCDate();
  return String(y).padStart(4, '0') + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

function isId(v) {
  return typeof v === 'string' && v.length > 0;
}

function isObj(v) {
  return v !== null && typeof v === 'object';
}

function fail(reason) {
  return { ok: false, reason };
}

export function createLibrary() {
  const books = new Map();
  const members = new Map();
  let current = null;

  function processExpiry(day) {
    for (const book of books.values()) {
      while (book.state === 'aside' && day > book.readyUntil) {
        const mid = book.queue.shift();
        const mem = members.get(mid);
        if (mem) {
          const i = mem.holds.indexOf(book.id);
          if (i >= 0) mem.holds.splice(i, 1);
        }
        if (book.queue.length > 0) {
          book.readyUntil = book.readyUntil + 1 + PICKUP_DAYS;
        } else {
          book.state = 'available';
          book.readyUntil = null;
        }
      }
    }
  }

  // Validates date and clock; advances clock and processes expiry. Returns day number or null.
  function clock(args) {
    if (!isObj(args)) return null;
    const day = parseDate(args.date);
    if (day === null) return null;
    if (current !== null && day < current) return null;
    current = day;
    processExpiry(day);
    return day;
  }

  function addBook(args) {
    if (!isObj(args) || !isId(args.bookId)) return fail('invalid');
    if (books.has(args.bookId)) return fail('exists');
    books.set(args.bookId, {
      id: args.bookId,
      state: 'available',
      loanMember: null,
      dueDate: null,
      renewals: 0,
      queue: [],
      readyUntil: null,
    });
    return { ok: true };
  }

  function addMember(args) {
    if (!isObj(args) || !isId(args.memberId)) return fail('invalid');
    if (members.has(args.memberId)) return fail('exists');
    members.set(args.memberId, { id: args.memberId, loans: [], owed: 0, holds: [] });
    return { ok: true };
  }

  function borrow(args) {
    const day = clock(args);
    if (day === null) return fail('invalid date');
    const { memberId, bookId } = args;
    if (!isId(memberId) || !isId(bookId)) return fail('invalid');
    const mem = members.get(memberId);
    const book = books.get(bookId);
    if (!mem || !book) return fail('unknown');
    if (book.state === 'loan') return fail('on loan');
    if (book.state === 'aside' && book.queue[0] !== memberId) return fail('set aside');
    if (mem.loans.length >= MAX_LOANS) return fail('too many loans');
    for (const bid of mem.loans) {
      if (books.get(bid).dueDate < day) return fail('overdue');
    }
    if (mem.owed >= OWED_BLOCK) return fail('owes');
    const due = day + LOAN_DAYS;
    if (due > MAX_DAY) return fail('date out of range');
    if (book.state === 'aside') {
      book.queue.shift();
      const i = mem.holds.indexOf(bookId);
      if (i >= 0) mem.holds.splice(i, 1);
    }
    book.state = 'loan';
    book.loanMember = memberId;
    book.dueDate = due;
    book.renewals = 0;
    book.readyUntil = null;
    mem.loans.push(bookId);
    return { ok: true, dueDate: formatDate(due) };
  }

  function returnBook(args) {
    const day = clock(args);
    if (day === null) return fail('invalid date');
    const { memberId, bookId } = args;
    if (!isId(memberId) || !isId(bookId)) return fail('invalid');
    const mem = members.get(memberId);
    const book = books.get(bookId);
    if (!mem || !book) return fail('unknown');
    if (book.state !== 'loan' || book.loanMember !== memberId) return fail('not on loan to member');
    const daysLate = Math.max(0, day - book.dueDate);
    const fine = Math.min(MAX_FINE, FINE_RATE * Math.max(0, daysLate - GRACE_DAYS));
    mem.owed += fine;
    const i = mem.loans.indexOf(bookId);
    if (i >= 0) mem.loans.splice(i, 1);
    book.loanMember = null;
    book.dueDate = null;
    book.renewals = 0;
    if (book.queue.length === 0) {
      book.state = 'available';
      book.readyUntil = null;
    } else {
      book.state = 'aside';
      book.readyUntil = day + PICKUP_DAYS;
    }
    return { ok: true, fine };
  }

  function renew(args) {
    const day = clock(args);
    if (day === null) return fail('invalid date');
    const { memberId, bookId } = args;
    if (!isId(memberId) || !isId(bookId)) return fail('invalid');
    const mem = members.get(memberId);
    const book = books.get(bookId);
    if (!mem || !book) return fail('unknown');
    if (book.state !== 'loan' || book.loanMember !== memberId) return fail('not on loan to member');
    if (book.renewals >= MAX_RENEWALS) return fail('renewal limit');
    if (day > book.dueDate) return fail('overdue');
    if (book.queue.length > 0) return fail('holds exist');
    const due = day + RENEW_DAYS;
    if (due > MAX_DAY) return fail('date out of range');
    book.dueDate = due;
    book.renewals += 1;
    return { ok: true, dueDate: formatDate(due) };
  }

  function placeHold(args) {
    const day = clock(args);
    if (day === null) return fail('invalid date');
    const { memberId, bookId } = args;
    if (!isId(memberId) || !isId(bookId)) return fail('invalid');
    const mem = members.get(memberId);
    const book = books.get(bookId);
    if (!mem || !book) return fail('unknown');
    if (book.state === 'available') return fail('available');
    if (book.state === 'loan' && book.loanMember === memberId) return fail('member has it');
    if (book.queue.includes(memberId)) return fail('already held');
    if (mem.holds.length >= MAX_HOLDS) return fail('hold limit');
    book.queue.push(memberId);
    mem.holds.push(bookId);
    return { ok: true, position: book.queue.length };
  }

  function payFine(args) {
    const day = clock(args);
    if (day === null) return fail('invalid date');
    const { memberId, amount } = args;
    if (!isId(memberId)) return fail('invalid');
    if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount <= 0) return fail('invalid amount');
    const mem = members.get(memberId);
    if (!mem) return fail('unknown');
    if (amount > mem.owed) return fail('overpayment');
    mem.owed -= amount;
    return { ok: true, owed: mem.owed };
  }

  function getMember(args) {
    const day = clock(args);
    if (day === null) return fail('invalid date');
    const { memberId } = args;
    if (!isId(memberId)) return fail('invalid');
    const mem = members.get(memberId);
    if (!mem) return fail('unknown');
    const loans = mem.loans.map((bid) => ({ bookId: bid, dueDate: formatDate(books.get(bid).dueDate) }));
    const holds = mem.holds.map((bid) => {
      const book = books.get(bid);
      const position = book.queue.indexOf(memberId) + 1;
      const readyUntil = book.state === 'aside' && position === 1 ? formatDate(book.readyUntil) : null;
      return { bookId: bid, position, readyUntil };
    });
    return { ok: true, loans, owed: mem.owed, holds };
  }

  return { addBook, addMember, borrow, returnBook, renew, placeHold, payFine, getMember };
}
