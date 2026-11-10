const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const MAX_LOANS = 5;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 2;
const MAX_FINE = 1000;
const BLOCK_OWED = 500;
const PICKUP_DAYS = 7;
const RELEASE_STEP = PICKUP_DAYS + 1;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isObject(v) {
  return v !== null && typeof v === 'object';
}

function isId(v) {
  return typeof v === 'string' && v.length > 0;
}

function isAmount(v) {
  return Number.isSafeInteger(v) && v > 0;
}

function isLeapYear(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y, m) {
  return m === 2 && isLeapYear(y) ? 29 : MONTH_LENGTHS[m - 1];
}

// Days since 1970-01-01 (proleptic Gregorian, pure integer arithmetic).
function dayNumber(y, m, d) {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const mp = m > 2 ? m - 3 : m + 9;
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function formatDay(n) {
  const z = n + 719468;
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
  return String(y).padStart(4, '0') + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

// Returns a day number, or null if the value is not a valid YYYY-MM-DD date.
function parseDate(v) {
  if (typeof v !== 'string') return null;
  const match = DATE_RE.exec(v);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (y < 1 || m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  return dayNumber(y, m, d);
}

function guard(fn) {
  return (args) => {
    try {
      return fn(args);
    } catch {
      return { ok: false, reason: 'internal error' };
    }
  };
}

export function createLibrary() {
  const books = new Map();   // bookId -> { id, loan, queue, readyUntil }
  const members = new Map(); // memberId -> { id, owed, loans: Map<bookId, loan>, holds: Set<bookId> }
  let clock = null;          // day number of the current library date

  const reject = (reason) => ({ ok: false, reason });

  function expireHolds(day) {
    for (const book of books.values()) {
      while (
        !book.loan &&
        book.queue.length > 0 &&
        book.readyUntil !== null &&
        day > book.readyUntil
      ) {
        const gone = book.queue.shift();
        members.get(gone.memberId).holds.delete(book.id);
        if (book.queue.length === 0) {
          book.readyUntil = null;
        } else {
          book.readyUntil += RELEASE_STEP;
        }
      }
    }
  }

  // Returns false (and changes nothing) if the date is earlier than the clock.
  function advanceClock(day) {
    if (clock !== null && day < clock) return false;
    clock = day;
    expireHolds(day);
    return true;
  }

  function addBook(args) {
    if (!isObject(args)) return reject('invalid argument');
    const bookId = args.bookId;
    if (!isId(bookId)) return reject('invalid bookId');
    if (books.has(bookId)) return reject('book exists');
    books.set(bookId, { id: bookId, loan: null, queue: [], readyUntil: null });
    return { ok: true };
  }

  function addMember(args) {
    if (!isObject(args)) return reject('invalid argument');
    const memberId = args.memberId;
    if (!isId(memberId)) return reject('invalid memberId');
    if (members.has(memberId)) return reject('member exists');
    members.set(memberId, { id: memberId, owed: 0, loans: new Map(), holds: new Set() });
    return { ok: true };
  }

  function borrow(args) {
    if (!isObject(args)) return reject('invalid argument');
    const memberId = args.memberId;
    const bookId = args.bookId;
    const day = parseDate(args.date);
    if (!isId(memberId) || !isId(bookId) || day === null) return reject('invalid input');
    if (!advanceClock(day)) return reject('date earlier than current date');

    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book) return reject('unknown member or book');
    if (book.loan) return reject('book is on loan');
    const head = book.queue.length > 0 ? book.queue[0] : null;
    if (head && head.memberId !== memberId) return reject('book is set aside for another member');
    if (member.loans.size >= MAX_LOANS) return reject('loan limit reached');
    if (member.owed >= BLOCK_OWED) return reject('borrowing blocked by fines');

    if (head) {
      book.queue.shift();
      member.holds.delete(bookId);
    }
    book.readyUntil = null;
    const loan = { memberId, dueDay: day + LOAN_DAYS, renewals: 0 };
    book.loan = loan;
    member.loans.set(bookId, loan);
    return { ok: true, dueDate: formatDay(loan.dueDay) };
  }

  function renew(args) {
    if (!isObject(args)) return reject('invalid argument');
    const memberId = args.memberId;
    const bookId = args.bookId;
    const day = parseDate(args.date);
    if (!isId(memberId) || !isId(bookId) || day === null) return reject('invalid input');
    if (!advanceClock(day)) return reject('date earlier than current date');

    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book) return reject('unknown member or book');
    const loan = book.loan;
    if (!loan || loan.memberId !== memberId) return reject('not on loan to member');
    if (loan.renewals >= MAX_RENEWALS) return reject('renewal limit reached');
    if (book.queue.length > 0) return reject('book has a waiting hold');
    if (day > loan.dueDay) return reject('loan is overdue');
    const newDue = day + LOAN_DAYS;
    if (newDue <= loan.dueDay) return reject('renewal does not extend loan');

    loan.dueDay = newDue;
    loan.renewals += 1;
    return { ok: true, dueDate: formatDay(newDue) };
  }

  function returnBook(args) {
    if (!isObject(args)) return reject('invalid argument');
    const memberId = args.memberId;
    const bookId = args.bookId;
    const day = parseDate(args.date);
    if (!isId(memberId) || !isId(bookId) || day === null) return reject('invalid input');
    if (!advanceClock(day)) return reject('date earlier than current date');

    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book) return reject('unknown member or book');
    const loan = book.loan;
    if (!loan || loan.memberId !== memberId) return reject('not on loan to member');

    const daysLate = day - loan.dueDay;
    const chargeableDays = Math.max(0, daysLate - GRACE_DAYS);
    const fine = Math.min(FINE_PER_DAY * chargeableDays, MAX_FINE);

    book.loan = null;
    member.loans.delete(bookId);
    member.owed += fine;
    book.readyUntil = book.queue.length > 0 ? day + PICKUP_DAYS : null;
    return { ok: true, fine };
  }

  function placeHold(args) {
    if (!isObject(args)) return reject('invalid argument');
    const memberId = args.memberId;
    const bookId = args.bookId;
    const day = parseDate(args.date);
    if (!isId(memberId) || !isId(bookId) || day === null) return reject('invalid input');
    if (!advanceClock(day)) return reject('date earlier than current date');

    const member = members.get(memberId);
    const book = books.get(bookId);
    if (!member || !book) return reject('unknown member or book');
    if (book.loan && book.loan.memberId === memberId) return reject('member has this book on loan');
    if (!book.loan && book.queue.length === 0) return reject('book is available');
    if (book.queue.some((e) => e.memberId === memberId)) return reject('hold already exists');

    book.queue.push({ memberId });
    member.holds.add(bookId);
    return { ok: true, position: book.queue.length };
  }

  function payFine(args) {
    if (!isObject(args)) return reject('invalid argument');
    const memberId = args.memberId;
    const amount = args.amount;
    const day = parseDate(args.date);
    if (!isId(memberId) || !isAmount(amount) || day === null) return reject('invalid input');
    if (!advanceClock(day)) return reject('date earlier than current date');

    const member = members.get(memberId);
    if (!member) return reject('unknown member');
    if (amount > member.owed) return reject('overpayment');

    member.owed -= amount;
    return { ok: true, owed: member.owed };
  }

  function getMember(args) {
    if (!isObject(args)) return reject('invalid argument');
    const memberId = args.memberId;
    const day = parseDate(args.date);
    if (!isId(memberId) || day === null) return reject('invalid input');
    if (!advanceClock(day)) return reject('date earlier than current date');

    const member = members.get(memberId);
    if (!member) return reject('unknown member');

    const loans = [];
    for (const [bookId, loan] of member.loans) {
      loans.push({ bookId, dueDate: formatDay(loan.dueDay) });
    }

    const holds = [];
    for (const bookId of member.holds) {
      const book = books.get(bookId);
      const idx = book.queue.findIndex((e) => e.memberId === memberId);
      const setAside = idx === 0 && !book.loan && book.readyUntil !== null;
      holds.push({
        bookId,
        position: idx + 1,
        readyUntil: setAside ? formatDay(book.readyUntil) : null,
      });
    }

    return { ok: true, loans, owed: member.owed, holds };
  }

  return {
    addBook: guard(addBook),
    addMember: guard(addMember),
    borrow: guard(borrow),
    returnBook: guard(returnBook),
    renew: guard(renew),
    placeHold: guard(placeHold),
    payFine: guard(payFine),
    getMember: guard(getMember),
  };
}
