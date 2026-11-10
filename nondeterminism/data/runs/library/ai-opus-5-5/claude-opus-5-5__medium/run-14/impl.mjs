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
const MS_PER_DAY = 86400000;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (y < 1 || y > 9999 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(0);
  dt.setUTCFullYear(y, m - 1, d);
  dt.setUTCHours(0, 0, 0, 0);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return Math.round(dt.getTime() / MS_PER_DAY);
}

const MAX_DAY = parseDate('9999-12-31');

function formatDate(day) {
  const dt = new Date(day * MS_PER_DAY);
  const y = String(dt.getUTCFullYear()).padStart(4, '0');
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function validId(x) {
  return typeof x === 'string' && x.length > 0;
}

function fail(reason) {
  return { ok: false, reason };
}

export function createLibrary() {
  const books = new Map();   // bookId -> { loan, queue: [{memberId, seq}], readyUntil }
  const members = new Map(); // memberId -> { loans: [bookId], owed, holds: [{bookId, seq}] }
  let current = null;
  let holdSeq = 0;

  function getArgs(args) {
    if (args === null || typeof args !== 'object') return null;
    return args;
  }

  function expire(day) {
    for (const book of books.values()) {
      while (book.loan === null && book.readyUntil !== null && day > book.readyUntil) {
        const removed = book.queue.shift();
        removeMemberHold(removed.memberId, removed.seq);
        if (book.queue.length > 0) {
          book.readyUntil = book.readyUntil + 1 + PICKUP_DAYS;
        } else {
          book.readyUntil = null;
        }
      }
    }
  }

  function removeMemberHold(memberId, seq) {
    const m = members.get(memberId);
    if (!m) return;
    const i = m.holds.findIndex(h => h.seq === seq);
    if (i >= 0) m.holds.splice(i, 1);
  }

  // Advances the clock and processes expiry. Returns the day number or null if earlier than current.
  function begin(day) {
    if (current !== null && day < current) return null;
    current = day;
    expire(day);
    return day;
  }

  function safe(fn) {
    return function (args) {
      try {
        return fn(args);
      } catch {
        return fail('error');
      }
    };
  }

  const addBook = safe(args => {
    const a = getArgs(args);
    if (!a || !validId(a.bookId)) return fail('invalid');
    if (books.has(a.bookId)) return fail('exists');
    books.set(a.bookId, { loan: null, queue: [], readyUntil: null });
    return { ok: true };
  });

  const addMember = safe(args => {
    const a = getArgs(args);
    if (!a || !validId(a.memberId)) return fail('invalid');
    if (members.has(a.memberId)) return fail('exists');
    members.set(a.memberId, { loans: [], owed: 0, holds: [] });
    return { ok: true };
  });

  const borrow = safe(args => {
    const a = getArgs(args);
    if (!a || !validId(a.memberId) || !validId(a.bookId)) return fail('invalid');
    const d = parseDate(a.date);
    if (d === null) return fail('invalid date');
    if (begin(d) === null) return fail('date in past');
    const member = members.get(a.memberId);
    const book = books.get(a.bookId);
    if (!member || !book) return fail('unknown');
    if (book.loan !== null) return fail('on loan');
    const setAside = book.readyUntil !== null;
    if (setAside && book.queue[0].memberId !== a.memberId) return fail('set aside for other');
    if (member.loans.length >= MAX_LOANS) return fail('too many loans');
    for (const bid of member.loans) {
      if (books.get(bid).loan.dueDate < d) return fail('overdue loan');
    }
    if (member.owed >= OWED_BLOCK) return fail('owes too much');
    const due = d + LOAN_DAYS;
    if (due > MAX_DAY) return fail('due date out of range');
    if (setAside) {
      const h = book.queue.shift();
      removeMemberHold(h.memberId, h.seq);
      book.readyUntil = null;
    }
    book.loan = { memberId: a.memberId, dueDate: due, renewals: 0 };
    member.loans.push(a.bookId);
    return { ok: true, dueDate: formatDate(due) };
  });

  const returnBook = safe(args => {
    const a = getArgs(args);
    if (!a || !validId(a.memberId) || !validId(a.bookId)) return fail('invalid');
    const d = parseDate(a.date);
    if (d === null) return fail('invalid date');
    if (begin(d) === null) return fail('date in past');
    const member = members.get(a.memberId);
    const book = books.get(a.bookId);
    if (!member || !book) return fail('unknown');
    if (book.loan === null || book.loan.memberId !== a.memberId) return fail('not on loan to member');
    const daysLate = Math.max(0, d - book.loan.dueDate);
    const fine = Math.min(MAX_FINE, FINE_PER_DAY * Math.max(0, daysLate - GRACE_DAYS));
    member.owed += fine;
    book.loan = null;
    const i = member.loans.indexOf(a.bookId);
    if (i >= 0) member.loans.splice(i, 1);
    if (book.queue.length === 0) {
      book.readyUntil = null;
    } else {
      book.readyUntil = d + PICKUP_DAYS;
    }
    return { ok: true, fine };
  });

  const renew = safe(args => {
    const a = getArgs(args);
    if (!a || !validId(a.memberId) || !validId(a.bookId)) return fail('invalid');
    const d = parseDate(a.date);
    if (d === null) return fail('invalid date');
    if (begin(d) === null) return fail('date in past');
    const member = members.get(a.memberId);
    const book = books.get(a.bookId);
    if (!member || !book) return fail('unknown');
    const loan = book.loan;
    if (loan === null || loan.memberId !== a.memberId) return fail('not on loan to member');
    if (loan.renewals >= MAX_RENEWALS) return fail('max renewals');
    if (d > loan.dueDate) return fail('overdue');
    if (book.queue.length > 0) return fail('holds waiting');
    const due = d + RENEW_DAYS;
    if (due > MAX_DAY) return fail('due date out of range');
    loan.dueDate = due;
    loan.renewals += 1;
    return { ok: true, dueDate: formatDate(due) };
  });

  const placeHold = safe(args => {
    const a = getArgs(args);
    if (!a || !validId(a.memberId) || !validId(a.bookId)) return fail('invalid');
    const d = parseDate(a.date);
    if (d === null) return fail('invalid date');
    if (begin(d) === null) return fail('date in past');
    const member = members.get(a.memberId);
    const book = books.get(a.bookId);
    if (!member || !book) return fail('unknown');
    if (book.loan === null && book.readyUntil === null) return fail('available');
    if (book.loan !== null && book.loan.memberId === a.memberId) return fail('member has it');
    if (book.queue.some(h => h.memberId === a.memberId)) return fail('already held');
    if (member.holds.length >= MAX_HOLDS) return fail('too many holds');
    const seq = ++holdSeq;
    book.queue.push({ memberId: a.memberId, seq });
    member.holds.push({ bookId: a.bookId, seq });
    return { ok: true, position: book.queue.length };
  });

  const payFine = safe(args => {
    const a = getArgs(args);
    if (!a || !validId(a.memberId)) return fail('invalid');
    if (typeof a.amount !== 'number' || !Number.isSafeInteger(a.amount) || a.amount <= 0) return fail('invalid amount');
    const d = parseDate(a.date);
    if (d === null) return fail('invalid date');
    if (begin(d) === null) return fail('date in past');
    const member = members.get(a.memberId);
    if (!member) return fail('unknown');
    if (a.amount > member.owed) return fail('overpayment');
    member.owed -= a.amount;
    return { ok: true, owed: member.owed };
  });

  const getMember = safe(args => {
    const a = getArgs(args);
    if (!a || !validId(a.memberId)) return fail('invalid');
    const d = parseDate(a.date);
    if (d === null) return fail('invalid date');
    if (begin(d) === null) return fail('date in past');
    const member = members.get(a.memberId);
    if (!member) return fail('unknown');
    const loans = member.loans.map(bid => ({
      bookId: bid,
      dueDate: formatDate(books.get(bid).loan.dueDate),
    }));
    const holds = member.holds.map(h => {
      const book = books.get(h.bookId);
      const idx = book.queue.findIndex(q => q.seq === h.seq);
      const ready = idx === 0 && book.loan === null && book.readyUntil !== null;
      return {
        bookId: h.bookId,
        position: idx + 1,
        readyUntil: ready ? formatDate(book.readyUntil) : null,
      };
    });
    return { ok: true, loans, owed: member.owed, holds };
  });

  return { addBook, addMember, borrow, returnBook, renew, placeHold, payFine, getMember };
}
