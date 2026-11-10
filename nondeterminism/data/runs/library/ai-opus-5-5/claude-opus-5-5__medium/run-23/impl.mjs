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

const FAIL = Object.freeze({ ok: false });
function fail(reason) {
  return { ok: false, reason };
}

function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y, m) {
  return [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
}

// Days since 1970-01-01 (proleptic Gregorian, UTC-equivalent arithmetic).
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

function parseDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (y < 1 || y > 9999 || m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  return daysFromCivil(y, m, d);
}

function formatDate(n) {
  const [y, m, d] = civilFromDays(n);
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function isId(x) {
  return typeof x === 'string' && x.length > 0;
}

function isObj(x) {
  return typeof x === 'object' && x !== null;
}

export function createLibrary() {
  const books = new Map(); // bookId -> { loan, queue: [memberId], readyUntil }
  const members = new Map(); // memberId -> { owed, loans: [bookId], holds: [bookId] }
  let currentDay = null;

  function isSetAside(book) {
    return book.loan === null && book.queue.length > 0;
  }

  function removeHold(memberId, bookId) {
    const m = members.get(memberId);
    const i = m.holds.indexOf(bookId);
    if (i >= 0) m.holds.splice(i, 1);
  }

  function processExpiry(day) {
    for (const [bookId, book] of books) {
      while (isSetAside(book) && day > book.readyUntil) {
        const prev = book.readyUntil;
        const expired = book.queue.shift();
        removeHold(expired, bookId);
        if (book.queue.length > 0) {
          book.readyUntil = prev + 1 + PICKUP_DAYS;
        } else {
          book.readyUntil = null;
        }
      }
    }
  }

  // Returns day number, or null if the call must fail (no state change).
  function advanceClock(dateStr) {
    const day = parseDate(dateStr);
    if (day === null) return null;
    if (currentDay !== null && day < currentDay) return null;
    currentDay = day;
    processExpiry(day);
    return day;
  }

  function guard(fn) {
    return (args) => {
      try {
        return fn(args);
      } catch {
        return { ...FAIL };
      }
    };
  }

  const addBook = guard((args) => {
    if (!isObj(args) || !isId(args.bookId)) return fail('invalid');
    if (books.has(args.bookId)) return fail('exists');
    books.set(args.bookId, { loan: null, queue: [], readyUntil: null });
    return { ok: true };
  });

  const addMember = guard((args) => {
    if (!isObj(args) || !isId(args.memberId)) return fail('invalid');
    if (members.has(args.memberId)) return fail('exists');
    members.set(args.memberId, { owed: 0, loans: [], holds: [] });
    return { ok: true };
  });

  function memberBookArgs(args) {
    if (!isObj(args)) return null;
    const { memberId, bookId, date } = args;
    if (!isId(memberId) || !isId(bookId) || parseDate(date) === null) return null;
    return { memberId, bookId, date };
  }

  const borrow = guard((args) => {
    const a = memberBookArgs(args);
    if (!a) return fail('invalid');
    const day = advanceClock(a.date);
    if (day === null) return fail('date');
    const member = members.get(a.memberId);
    const book = books.get(a.bookId);
    if (!member || !book) return fail('unknown');
    if (book.loan !== null) return fail('on loan');
    const setAside = isSetAside(book);
    if (setAside && book.queue[0] !== a.memberId) return fail('set aside for another');
    if (member.loans.length >= MAX_LOANS) return fail('loan limit');
    for (const bid of member.loans) {
      if (books.get(bid).loan.dueDay < day) return fail('overdue');
    }
    if (member.owed >= OWED_BLOCK) return fail('owes');
    if (setAside) {
      book.queue.shift();
      removeHold(a.memberId, a.bookId);
    }
    book.readyUntil = null;
    const dueDay = day + LOAN_DAYS;
    book.loan = { memberId: a.memberId, dueDay, renewals: 0 };
    member.loans.push(a.bookId);
    return { ok: true, dueDate: formatDate(dueDay) };
  });

  const returnBook = guard((args) => {
    const a = memberBookArgs(args);
    if (!a) return fail('invalid');
    const day = advanceClock(a.date);
    if (day === null) return fail('date');
    const member = members.get(a.memberId);
    const book = books.get(a.bookId);
    if (!member || !book) return fail('unknown');
    if (book.loan === null || book.loan.memberId !== a.memberId) return fail('not on loan');
    const daysLate = Math.max(0, day - book.loan.dueDay);
    const fine = Math.min(MAX_FINE, FINE_RATE * Math.max(0, daysLate - GRACE_DAYS));
    member.owed += fine;
    book.loan = null;
    const i = member.loans.indexOf(a.bookId);
    if (i >= 0) member.loans.splice(i, 1);
    book.readyUntil = book.queue.length > 0 ? day + PICKUP_DAYS : null;
    return { ok: true, fine };
  });

  const renew = guard((args) => {
    const a = memberBookArgs(args);
    if (!a) return fail('invalid');
    const day = advanceClock(a.date);
    if (day === null) return fail('date');
    const member = members.get(a.memberId);
    const book = books.get(a.bookId);
    if (!member || !book) return fail('unknown');
    const loan = book.loan;
    if (loan === null || loan.memberId !== a.memberId) return fail('not on loan');
    if (loan.renewals >= MAX_RENEWALS) return fail('renewal limit');
    if (day > loan.dueDay) return fail('overdue');
    if (book.queue.length > 0) return fail('holds exist');
    loan.dueDay = Math.max(loan.dueDay, day + RENEW_DAYS);
    loan.renewals += 1;
    return { ok: true, dueDate: formatDate(loan.dueDay) };
  });

  const placeHold = guard((args) => {
    const a = memberBookArgs(args);
    if (!a) return fail('invalid');
    const day = advanceClock(a.date);
    if (day === null) return fail('date');
    const member = members.get(a.memberId);
    const book = books.get(a.bookId);
    if (!member || !book) return fail('unknown');
    if (book.loan === null && book.queue.length === 0) return fail('available');
    if (book.loan !== null && book.loan.memberId === a.memberId) return fail('member has it');
    if (book.queue.includes(a.memberId)) return fail('already held');
    if (member.holds.length >= MAX_HOLDS) return fail('hold limit');
    book.queue.push(a.memberId);
    member.holds.push(a.bookId);
    return { ok: true, position: book.queue.length };
  });

  const payFine = guard((args) => {
    if (!isObj(args)) return fail('invalid');
    const { memberId, amount, date } = args;
    if (!isId(memberId) || !Number.isSafeInteger(amount) || amount <= 0 || parseDate(date) === null) {
      return fail('invalid');
    }
    const day = advanceClock(date);
    if (day === null) return fail('date');
    const member = members.get(memberId);
    if (!member) return fail('unknown');
    if (amount > member.owed) return fail('overpayment');
    member.owed -= amount;
    return { ok: true, owed: member.owed };
  });

  const getMember = guard((args) => {
    if (!isObj(args)) return fail('invalid');
    const { memberId, date } = args;
    if (!isId(memberId) || parseDate(date) === null) return fail('invalid');
    const day = advanceClock(date);
    if (day === null) return fail('date');
    const member = members.get(memberId);
    if (!member) return fail('unknown');
    const loans = member.loans.map((bid) => ({
      bookId: bid,
      dueDate: formatDate(books.get(bid).loan.dueDay),
    }));
    const holds = member.holds.map((bid) => {
      const book = books.get(bid);
      const idx = book.queue.indexOf(memberId);
      const ready = idx === 0 && isSetAside(book);
      return {
        bookId: bid,
        position: idx + 1,
        readyUntil: ready ? formatDate(book.readyUntil) : null,
      };
    });
    return { ok: true, loans, owed: member.owed, holds };
  });

  return { addBook, addMember, borrow, returnBook, renew, placeHold, payFine, getMember };
}
