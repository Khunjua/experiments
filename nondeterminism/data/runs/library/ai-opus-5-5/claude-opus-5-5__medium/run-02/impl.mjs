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

// Pure proleptic Gregorian arithmetic (equivalent to UTC day counting).
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
  return [y, m, d];
}

function parseDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (y < 1 || y > 9999) return null;
  if (m < 1 || m > 12) return null;
  if (d < 1 || d > daysInMonth(y, m)) return null;
  return daysFromCivil(y, m, d);
}

function formatDay(n) {
  const [y, m, d] = civilFromDays(n);
  return (
    String(y).padStart(4, '0') + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0')
  );
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
  // book: { onLoanTo: memberId|null, queue: [memberId], readyUntil: dayNumber|null }
  const books = new Map();
  // member: { loans: [{ bookId, dueDay, renewals }], owed, holds: [bookId] }
  const members = new Map();
  let currentDay = null;

  function isSetAside(book) {
    return book.onLoanTo === null && book.queue.length > 0;
  }

  function removeMemberHold(memberId, bookId) {
    const m = members.get(memberId);
    if (!m) return;
    const i = m.holds.indexOf(bookId);
    if (i >= 0) m.holds.splice(i, 1);
  }

  function processExpiries(day) {
    for (const [bookId, book] of books) {
      while (isSetAside(book) && book.readyUntil !== null && day > book.readyUntil) {
        const prev = book.readyUntil;
        const expired = book.queue.shift();
        removeMemberHold(expired, bookId);
        if (book.queue.length > 0) {
          book.readyUntil = prev + 1 + PICKUP_DAYS;
        } else {
          book.readyUntil = null;
        }
      }
    }
  }

  // Returns day number, or null if the date is earlier than the clock.
  function tick(day) {
    if (currentDay !== null && day < currentDay) return null;
    currentDay = day;
    processExpiries(day);
    return day;
  }

  function addBook(args) {
    if (!isObj(args) || !isId(args.bookId)) return fail('invalid');
    if (books.has(args.bookId)) return fail('exists');
    books.set(args.bookId, { onLoanTo: null, queue: [], readyUntil: null });
    return { ok: true };
  }

  function addMember(args) {
    if (!isObj(args) || !isId(args.memberId)) return fail('invalid');
    if (members.has(args.memberId)) return fail('exists');
    members.set(args.memberId, { loans: [], owed: 0, holds: [] });
    return { ok: true };
  }

  function borrow(args) {
    if (!isObj(args) || !isId(args.memberId) || !isId(args.bookId)) return fail('invalid');
    const d = parseDate(args.date);
    if (d === null) return fail('invalid date');
    const day = tick(d);
    if (day === null) return fail('date in past');
    const { memberId, bookId } = args;
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book) return fail('not registered');
    if (book.onLoanTo !== null) return fail('on loan');
    const setAsideForMe = isSetAside(book) && book.queue[0] === memberId;
    if (isSetAside(book) && !setAsideForMe) return fail('set aside');
    if (member.loans.length >= MAX_LOANS) return fail('too many loans');
    if (member.loans.some((l) => l.dueDay < day)) return fail('overdue');
    if (member.owed >= OWED_BLOCK) return fail('owes');
    if (setAsideForMe) {
      book.queue.shift();
      removeMemberHold(memberId, bookId);
    }
    book.readyUntil = null;
    book.onLoanTo = memberId;
    const dueDay = day + LOAN_DAYS;
    member.loans.push({ bookId, dueDay, renewals: 0 });
    return { ok: true, dueDate: formatDay(dueDay) };
  }

  function returnBook(args) {
    if (!isObj(args) || !isId(args.memberId) || !isId(args.bookId)) return fail('invalid');
    const d = parseDate(args.date);
    if (d === null) return fail('invalid date');
    const day = tick(d);
    if (day === null) return fail('date in past');
    const { memberId, bookId } = args;
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book) return fail('not registered');
    if (book.onLoanTo !== memberId) return fail('not on loan to member');
    const idx = member.loans.findIndex((l) => l.bookId === bookId);
    if (idx < 0) return fail('not on loan to member');
    const loan = member.loans[idx];
    const daysLate = Math.max(0, day - loan.dueDay);
    const fine = Math.min(MAX_FINE, FINE_RATE * Math.max(0, daysLate - GRACE_DAYS));
    member.owed += fine;
    member.loans.splice(idx, 1);
    book.onLoanTo = null;
    book.readyUntil = book.queue.length > 0 ? day + PICKUP_DAYS : null;
    return { ok: true, fine };
  }

  function renew(args) {
    if (!isObj(args) || !isId(args.memberId) || !isId(args.bookId)) return fail('invalid');
    const d = parseDate(args.date);
    if (d === null) return fail('invalid date');
    const day = tick(d);
    if (day === null) return fail('date in past');
    const { memberId, bookId } = args;
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book) return fail('not registered');
    if (book.onLoanTo !== memberId) return fail('not on loan to member');
    const loan = member.loans.find((l) => l.bookId === bookId);
    if (!loan) return fail('not on loan to member');
    if (loan.renewals >= MAX_RENEWALS) return fail('renewal limit');
    if (day > loan.dueDay) return fail('overdue');
    if (book.queue.length > 0) return fail('holds waiting');
    loan.dueDay = Math.max(loan.dueDay, day + RENEW_DAYS);
    loan.renewals += 1;
    return { ok: true, dueDate: formatDay(loan.dueDay) };
  }

  function placeHold(args) {
    if (!isObj(args) || !isId(args.memberId) || !isId(args.bookId)) return fail('invalid');
    const d = parseDate(args.date);
    if (d === null) return fail('invalid date');
    const day = tick(d);
    if (day === null) return fail('date in past');
    const { memberId, bookId } = args;
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book) return fail('not registered');
    if (book.onLoanTo === null && book.queue.length === 0) return fail('available');
    if (book.onLoanTo === memberId) return fail('member has book');
    if (book.queue.includes(memberId)) return fail('already held');
    if (member.holds.length >= MAX_HOLDS) return fail('too many holds');
    book.queue.push(memberId);
    member.holds.push(bookId);
    return { ok: true, position: book.queue.length };
  }

  function payFine(args) {
    if (!isObj(args) || !isId(args.memberId)) return fail('invalid');
    const amount = args.amount;
    if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount <= 0) {
      return fail('invalid amount');
    }
    const d = parseDate(args.date);
    if (d === null) return fail('invalid date');
    const day = tick(d);
    if (day === null) return fail('date in past');
    const member = members.get(args.memberId);
    if (!member) return fail('not registered');
    if (amount > member.owed) return fail('overpayment');
    member.owed -= amount;
    return { ok: true, owed: member.owed };
  }

  function getMember(args) {
    if (!isObj(args) || !isId(args.memberId)) return fail('invalid');
    const d = parseDate(args.date);
    if (d === null) return fail('invalid date');
    const day = tick(d);
    if (day === null) return fail('date in past');
    const member = members.get(args.memberId);
    if (!member) return fail('not registered');
    const loans = member.loans.map((l) => ({ bookId: l.bookId, dueDate: formatDay(l.dueDay) }));
    const holds = member.holds.map((bookId) => {
      const book = books.get(bookId);
      const idx = book.queue.indexOf(args.memberId);
      const ready = idx === 0 && isSetAside(book) && book.readyUntil !== null;
      return {
        bookId,
        position: idx + 1,
        readyUntil: ready ? formatDay(book.readyUntil) : null,
      };
    });
    return { ok: true, loans, owed: member.owed, holds };
  }

  return { addBook, addMember, borrow, returnBook, renew, placeHold, payFine, getMember };
}
