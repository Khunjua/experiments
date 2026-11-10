const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const RENEW_DAYS = 21;
const FINE_PER_DAY = 25;
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
  return [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

// Days since 1970-01-01 using UTC; setUTCFullYear avoids the 0-99 year mapping.
function toDayNum(y, m, d) {
  const dt = new Date(Date.UTC(2000, 0, 1));
  dt.setUTCFullYear(y, m - 1, d);
  return Math.round(dt.getTime() / 86400000);
}

function fromDayNum(n) {
  const dt = new Date(n * 86400000);
  const y = dt.getUTCFullYear();
  const m = dt.getUTCMonth() + 1;
  const d = dt.getUTCDate();
  return (
    String(y).padStart(4, '0') + '-' +
    String(m).padStart(2, '0') + '-' +
    String(d).padStart(2, '0')
  );
}

function parseDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (y < 1 || y > 9999) return null;
  if (m < 1 || m > 12) return null;
  if (d < 1 || d > daysInMonth(y, m)) return null;
  return toDayNum(y, m, d);
}

function validId(v) {
  return typeof v === 'string' && v.length > 0;
}

function isObj(a) {
  return typeof a === 'object' && a !== null;
}

const FAIL = (reason) => ({ ok: false, reason });

export function createLibrary() {
  // bookId -> { state: 'available'|'loan'|'aside', loanMember: string|null, queue: hold[] }
  const books = new Map();
  // memberId -> { owed, loans: loan[], holds: hold[] }
  const members = new Map();
  const asideBooks = new Set();
  let current = null;

  function removeHoldFromMember(hold) {
    const m = members.get(hold.memberId);
    const i = m.holds.indexOf(hold);
    if (i >= 0) m.holds.splice(i, 1);
  }

  function processExpiry(day) {
    for (const bookId of Array.from(asideBooks)) {
      const book = books.get(bookId);
      while (book.state === 'aside' && day > book.queue[0].readyUntil) {
        const prev = book.queue.shift();
        removeHoldFromMember(prev);
        if (book.queue.length > 0) {
          book.queue[0].readyUntil = prev.readyUntil + 1 + PICKUP_DAYS;
        } else {
          book.state = 'available';
          asideBooks.delete(bookId);
        }
      }
    }
  }

  // Returns the day number if the clock accepts it, else null.
  function tick(dateStr) {
    const day = parseDate(dateStr);
    if (day === null) return null;
    if (current !== null && day < current) return null;
    current = day;
    processExpiry(day);
    return day;
  }

  function readArgs(args, keys) {
    if (!isObj(args)) return null;
    const out = {};
    for (const k of keys) out[k] = args[k];
    return out;
  }

  function addBook(args) {
    try {
      const a = readArgs(args, ['bookId']);
      if (!a || !validId(a.bookId)) return FAIL('invalid');
      if (books.has(a.bookId)) return FAIL('exists');
      books.set(a.bookId, { state: 'available', loanMember: null, queue: [] });
      return { ok: true };
    } catch {
      return FAIL('invalid');
    }
  }

  function addMember(args) {
    try {
      const a = readArgs(args, ['memberId']);
      if (!a || !validId(a.memberId)) return FAIL('invalid');
      if (members.has(a.memberId)) return FAIL('exists');
      members.set(a.memberId, { owed: 0, loans: [], holds: [] });
      return { ok: true };
    } catch {
      return FAIL('invalid');
    }
  }

  function borrow(args) {
    try {
      const a = readArgs(args, ['memberId', 'bookId', 'date']);
      if (!a) return FAIL('invalid');
      const day = tick(a.date);
      if (day === null) return FAIL('date');
      if (!validId(a.memberId) || !validId(a.bookId)) return FAIL('invalid');
      const member = members.get(a.memberId);
      const book = books.get(a.bookId);
      if (!member || !book) return FAIL('unknown');
      if (book.state === 'loan') return FAIL('on loan');
      if (book.state === 'aside' && book.queue[0].memberId !== a.memberId) return FAIL('set aside');
      if (member.loans.length >= MAX_LOANS) return FAIL('loan limit');
      if (member.loans.some((l) => l.due < day)) return FAIL('overdue');
      if (member.owed >= OWED_BLOCK) return FAIL('owes');

      if (book.state === 'aside') {
        const hold = book.queue.shift();
        removeHoldFromMember(hold);
        asideBooks.delete(a.bookId);
      }
      const due = day + LOAN_DAYS;
      book.state = 'loan';
      book.loanMember = a.memberId;
      member.loans.push({ bookId: a.bookId, due, renewals: 0 });
      return { ok: true, dueDate: fromDayNum(due) };
    } catch {
      return FAIL('invalid');
    }
  }

  function returnBook(args) {
    try {
      const a = readArgs(args, ['memberId', 'bookId', 'date']);
      if (!a) return FAIL('invalid');
      const day = tick(a.date);
      if (day === null) return FAIL('date');
      if (!validId(a.memberId) || !validId(a.bookId)) return FAIL('invalid');
      const member = members.get(a.memberId);
      const book = books.get(a.bookId);
      if (!member || !book) return FAIL('unknown');
      if (book.state !== 'loan' || book.loanMember !== a.memberId) return FAIL('not on loan');
      const idx = member.loans.findIndex((l) => l.bookId === a.bookId);
      if (idx < 0) return FAIL('not on loan');
      const loan = member.loans[idx];

      const daysLate = Math.max(0, day - loan.due);
      const fine = Math.min(MAX_FINE, FINE_PER_DAY * Math.max(0, daysLate - GRACE_DAYS));
      member.owed += fine;
      member.loans.splice(idx, 1);
      book.loanMember = null;
      if (book.queue.length === 0) {
        book.state = 'available';
      } else {
        book.state = 'aside';
        book.queue[0].readyUntil = day + PICKUP_DAYS;
        asideBooks.add(a.bookId);
      }
      return { ok: true, fine };
    } catch {
      return FAIL('invalid');
    }
  }

  function renew(args) {
    try {
      const a = readArgs(args, ['memberId', 'bookId', 'date']);
      if (!a) return FAIL('invalid');
      const day = tick(a.date);
      if (day === null) return FAIL('date');
      if (!validId(a.memberId) || !validId(a.bookId)) return FAIL('invalid');
      const member = members.get(a.memberId);
      const book = books.get(a.bookId);
      if (!member || !book) return FAIL('unknown');
      if (book.state !== 'loan' || book.loanMember !== a.memberId) return FAIL('not on loan');
      const loan = member.loans.find((l) => l.bookId === a.bookId);
      if (!loan) return FAIL('not on loan');
      if (loan.renewals >= MAX_RENEWALS) return FAIL('renewal limit');
      if (day > loan.due) return FAIL('overdue');
      if (book.queue.length > 0) return FAIL('holds');
      loan.due = day + RENEW_DAYS;
      loan.renewals += 1;
      return { ok: true, dueDate: fromDayNum(loan.due) };
    } catch {
      return FAIL('invalid');
    }
  }

  function placeHold(args) {
    try {
      const a = readArgs(args, ['memberId', 'bookId', 'date']);
      if (!a) return FAIL('invalid');
      const day = tick(a.date);
      if (day === null) return FAIL('date');
      if (!validId(a.memberId) || !validId(a.bookId)) return FAIL('invalid');
      const member = members.get(a.memberId);
      const book = books.get(a.bookId);
      if (!member || !book) return FAIL('unknown');
      if (book.state === 'available') return FAIL('available');
      if (book.state === 'loan' && book.loanMember === a.memberId) return FAIL('own loan');
      if (book.queue.some((h) => h.memberId === a.memberId)) return FAIL('duplicate');
      if (member.holds.length >= MAX_HOLDS) return FAIL('hold limit');
      const hold = { memberId: a.memberId, bookId: a.bookId, readyUntil: null };
      book.queue.push(hold);
      member.holds.push(hold);
      return { ok: true, position: book.queue.length };
    } catch {
      return FAIL('invalid');
    }
  }

  function payFine(args) {
    try {
      const a = readArgs(args, ['memberId', 'amount', 'date']);
      if (!a) return FAIL('invalid');
      const day = tick(a.date);
      if (day === null) return FAIL('date');
      if (!validId(a.memberId)) return FAIL('invalid');
      if (!Number.isSafeInteger(a.amount) || a.amount <= 0) return FAIL('amount');
      const member = members.get(a.memberId);
      if (!member) return FAIL('unknown');
      if (a.amount > member.owed) return FAIL('overpay');
      member.owed -= a.amount;
      return { ok: true, owed: member.owed };
    } catch {
      return FAIL('invalid');
    }
  }

  function getMember(args) {
    try {
      const a = readArgs(args, ['memberId', 'date']);
      if (!a) return FAIL('invalid');
      const day = tick(a.date);
      if (day === null) return FAIL('date');
      if (!validId(a.memberId)) return FAIL('invalid');
      const member = members.get(a.memberId);
      if (!member) return FAIL('unknown');
      return {
        ok: true,
        loans: member.loans.map((l) => ({ bookId: l.bookId, dueDate: fromDayNum(l.due) })),
        owed: member.owed,
        holds: member.holds.map((h) => {
          const book = books.get(h.bookId);
          const position = book.queue.indexOf(h) + 1;
          const ready = book.state === 'aside' && position === 1;
          return {
            bookId: h.bookId,
            position,
            readyUntil: ready ? fromDayNum(h.readyUntil) : null,
          };
        }),
      };
    } catch {
      return FAIL('invalid');
    }
  }

  return { addBook, addMember, borrow, returnBook, renew, placeHold, payFine, getMember };
}
