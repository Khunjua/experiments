const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const RENEWAL_DAYS = 21;
const MAX_LOANS = 5;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 3;
const MAX_FINE = 1000;
const DEBT_LIMIT = 1000;
const PICKUP_DAYS = 7;

function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

// Day number (days since 1970-01-01) for a proleptic Gregorian date.
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

// Returns a day number, or null if the string is not a valid calendar date.
function parseDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (m < 1 || m > 12) return null;
  const dim = [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  if (d < 1 || d > dim) return null;
  return daysFromCivil(y, m, d);
}

function formatDate(n) {
  const [y, m, d] = civilFromDays(n);
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function isId(v) {
  return typeof v === 'string' && v.length > 0;
}

function isObj(v) {
  return v !== null && typeof v === 'object';
}

const fail = (reason = 'invalid') => ({ ok: false, reason });

function guard(fn) {
  return function (arg) {
    try {
      return fn(arg);
    } catch (e) {
      return fail('internal');
    }
  };
}

export function createLibrary() {
  // book: { state: 'available' | 'loan' | 'set', loanMember, readyUntil, queue: [{ memberId, seq }] }
  const books = new Map();
  // member: { owed, loans: [{ bookId, dueDate, renewals }] } (loans in creation order)
  const members = new Map();
  let lastDate = null;
  let holdSeq = 0;

  function expire(D) {
    for (const book of books.values()) {
      while (book.state === 'set' && D > book.readyUntil) {
        book.queue.shift();
        const S = book.readyUntil + 1;
        if (book.queue.length > 0) {
          book.readyUntil = S + PICKUP_DAYS;
        } else {
          book.state = 'available';
          book.loanMember = null;
          book.readyUntil = null;
        }
      }
    }
  }

  // Validates the date against the clock, then runs time processing.
  // Returns the day number, or null if the call is rejected by the clock.
  function accept(date) {
    const n = parseDate(date);
    if (n === null) return null;
    if (lastDate !== null && n < lastDate) return null;
    lastDate = n;
    expire(n);
    return n;
  }

  const addBook = guard((arg) => {
    if (!isObj(arg) || !isId(arg.bookId)) return fail();
    if (books.has(arg.bookId)) return fail('exists');
    books.set(arg.bookId, { state: 'available', loanMember: null, readyUntil: null, queue: [] });
    return { ok: true };
  });

  const addMember = guard((arg) => {
    if (!isObj(arg) || !isId(arg.memberId)) return fail();
    if (members.has(arg.memberId)) return fail('exists');
    members.set(arg.memberId, { owed: 0, loans: [] });
    return { ok: true };
  });

  const borrow = guard((arg) => {
    if (!isObj(arg) || !isId(arg.memberId) || !isId(arg.bookId)) return fail();
    const { memberId, bookId, date } = arg;
    const D = accept(date);
    if (D === null) return fail('date');
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book) return fail('not found');
    if (book.state === 'loan') return fail('on loan');
    if (book.state === 'set' && book.queue[0].memberId !== memberId) return fail('set aside for another');
    if (book.state === 'available' && book.queue.length > 0) return fail('queue inconsistent');
    if (member.owed >= DEBT_LIMIT) return fail('debt');
    if (member.loans.some((l) => D > l.dueDate)) return fail('overdue loan');
    if (member.loans.length >= MAX_LOANS) return fail('loan limit');

    const dueDate = D + LOAN_DAYS;
    member.loans.push({ bookId, dueDate, renewals: 0 });
    if (book.state === 'set') book.queue.shift();
    book.state = 'loan';
    book.loanMember = memberId;
    book.readyUntil = null;
    return { ok: true, dueDate: formatDate(dueDate) };
  });

  const returnBook = guard((arg) => {
    if (!isObj(arg) || !isId(arg.memberId) || !isId(arg.bookId)) return fail();
    const { memberId, bookId, date } = arg;
    const D = accept(date);
    if (D === null) return fail('date');
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book) return fail('not found');
    const idx = member.loans.findIndex((l) => l.bookId === bookId);
    if (idx < 0) return fail('not on loan');

    const loan = member.loans[idx];
    const late = Math.max(0, D - loan.dueDate);
    const fine = Math.min(MAX_FINE, FINE_PER_DAY * Math.max(0, late - GRACE_DAYS));
    member.owed += fine;
    member.loans.splice(idx, 1);

    if (book.queue.length > 0) {
      book.state = 'set';
      book.loanMember = null;
      book.readyUntil = D + PICKUP_DAYS;
    } else {
      book.state = 'available';
      book.loanMember = null;
      book.readyUntil = null;
    }
    return { ok: true, fine };
  });

  const renew = guard((arg) => {
    if (!isObj(arg) || !isId(arg.memberId) || !isId(arg.bookId)) return fail();
    const { memberId, bookId, date } = arg;
    const D = accept(date);
    if (D === null) return fail('date');
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book) return fail('not found');
    const loan = member.loans.find((l) => l.bookId === bookId);
    if (!loan) return fail('not on loan');
    if (D > loan.dueDate) return fail('overdue');
    if (loan.renewals >= MAX_RENEWALS) return fail('renewal limit');
    if (book.queue.length > 0) return fail('someone is waiting');
    if (member.owed >= DEBT_LIMIT) return fail('debt');

    loan.dueDate += RENEWAL_DAYS;
    loan.renewals += 1;
    return { ok: true, dueDate: formatDate(loan.dueDate) };
  });

  const placeHold = guard((arg) => {
    if (!isObj(arg) || !isId(arg.memberId) || !isId(arg.bookId)) return fail();
    const { memberId, bookId, date } = arg;
    const D = accept(date);
    if (D === null) return fail('date');
    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book) return fail('not found');
    if (book.state === 'available') return fail('available, borrow instead');
    if (book.state === 'loan' && book.loanMember === memberId) return fail('already on loan to member');
    if (book.queue.some((e) => e.memberId === memberId)) return fail('already holding');

    holdSeq += 1;
    book.queue.push({ memberId, seq: holdSeq });
    return { ok: true, position: book.queue.length };
  });

  const payFine = guard((arg) => {
    if (!isObj(arg) || !isId(arg.memberId) || !Number.isInteger(arg.amount)) return fail();
    const { memberId, amount, date } = arg;
    const D = accept(date);
    if (D === null) return fail('date');
    const member = members.get(memberId);
    if (!member) return fail('not found');
    if (amount < 1) return fail('amount');
    if (amount > member.owed) return fail('overpayment');

    member.owed -= amount;
    return { ok: true, owed: member.owed };
  });

  const getMember = guard((arg) => {
    if (!isObj(arg) || !isId(arg.memberId)) return fail();
    const { memberId, date } = arg;
    const D = accept(date);
    if (D === null) return fail('date');
    const member = members.get(memberId);
    if (!member) return fail('not found');

    const loans = member.loans.map((l) => ({
      bookId: l.bookId,
      dueDate: formatDate(l.dueDate),
    }));

    const found = [];
    for (const [bookId, book] of books) {
      book.queue.forEach((e, i) => {
        if (e.memberId !== memberId) return;
        const setAsideForMember = i === 0 && book.state === 'set';
        found.push({
          seq: e.seq,
          hold: {
            bookId,
            position: i + 1,
            readyUntil: setAsideForMember ? formatDate(book.readyUntil) : null,
          },
        });
      });
    }
    found.sort((a, b) => a.seq - b.seq);
    const holds = found.map((f) => f.hold);

    return { loans, owed: member.owed, holds };
  });

  return { addBook, addMember, borrow, returnBook, renew, placeHold, payFine, getMember };
}
