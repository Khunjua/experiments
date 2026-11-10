const LOAN_DAYS = 21;
const RENEWAL_DAYS = 21;
const PICKUP_DAYS = 7;
const FINE_PER_DAY = 25;
const FINE_CAP = 500;
const MAX_RENEWALS = 2;

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function isLeapYear(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y, m) {
  if (m === 2) return isLeapYear(y) ? 29 : 28;
  return (m === 4 || m === 6 || m === 9 || m === 11) ? 30 : 31;
}

// Day number relative to 1970-01-01, pure integer calendar arithmetic.
function toDayNumber(y, m, d) {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const mp = m > 2 ? m - 3 : m + 9;
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function fromDayNumber(z0) {
  const z = z0 + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  const y = yoe + era * 400 + (m <= 2 ? 1 : 0);
  return { y, m, d };
}

function parseDate(s) {
  if (typeof s !== 'string') return null;
  const match = DATE_PATTERN.exec(s);
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  return toDayNumber(y, m, d);
}

function formatDate(n) {
  const { y, m, d } = fromDayNumber(n);
  return String(y).padStart(4, '0') + '-' +
    String(m).padStart(2, '0') + '-' +
    String(d).padStart(2, '0');
}

function isId(v) {
  return typeof v === 'string' && v.length > 0;
}

function fail(reason) {
  return { ok: false, reason };
}

function safely(fn) {
  try {
    return fn();
  } catch {
    return fail('INVALID_INPUT');
  }
}

// Validates the shape of a dated call. Returns null if the shape is invalid.
function readCall(arg, needBook) {
  if (arg === null || typeof arg !== 'object') return null;
  const memberId = arg.memberId;
  if (!isId(memberId)) return null;
  let bookId;
  if (needBook) {
    bookId = arg.bookId;
    if (!isId(bookId)) return null;
  }
  const day = parseDate(arg.date);
  if (day === null) return null;
  return { memberId, bookId, day, amount: arg.amount };
}

export function createLibrary() {
  const books = new Map();   // bookId -> { id, loan, holds }
  const members = new Map(); // memberId -> { id, owed }
  let clock = null;          // day number of latest dated call
  let loanSeq = 0;
  let holdSeq = 0;

  // Hold line semantics:
  // - book.loan !== null: on loan; holds may exist behind it.
  // - book.loan === null and holds.length > 0: set aside for holds[0].
  // - book.loan === null and holds.length === 0: available.
  // Only holds[0] can have a non-null readyUntil.

  function setAside(book, freeDay) {
    if (book.holds.length > 0) {
      book.holds[0].readyUntil = freeDay + PICKUP_DAYS;
    }
  }

  function expire(book, day) {
    while (
      book.loan === null &&
      book.holds.length > 0 &&
      book.holds[0].readyUntil !== null &&
      book.holds[0].readyUntil < day
    ) {
      const freeDay = book.holds[0].readyUntil + 1;
      book.holds.shift();
      setAside(book, freeDay);
    }
  }

  // Applies the clock rule and catch-up. Returns false if the date is out of order.
  function advance(day) {
    if (clock !== null && day < clock) return false;
    for (const book of books.values()) {
      expire(book, day);
    }
    clock = day;
    return true;
  }

  return {
    addBook(arg) {
      return safely(() => {
        if (arg === null || typeof arg !== 'object') return fail('INVALID_INPUT');
        const bookId = arg.bookId;
        if (!isId(bookId)) return fail('INVALID_INPUT');
        if (books.has(bookId)) return fail('DUPLICATE');
        books.set(bookId, { id: bookId, loan: null, holds: [] });
        return { ok: true };
      });
    },

    addMember(arg) {
      return safely(() => {
        if (arg === null || typeof arg !== 'object') return fail('INVALID_INPUT');
        const memberId = arg.memberId;
        if (!isId(memberId)) return fail('INVALID_INPUT');
        if (members.has(memberId)) return fail('DUPLICATE');
        members.set(memberId, { id: memberId, owed: 0 });
        return { ok: true };
      });
    },

    borrow(arg) {
      return safely(() => {
        const c = readCall(arg, true);
        if (!c) return fail('INVALID_INPUT');
        if (!advance(c.day)) return fail('DATE_OUT_OF_ORDER');
        const member = members.get(c.memberId);
        if (!member) return fail('NO_MEMBER');
        const book = books.get(c.bookId);
        if (!book) return fail('NO_BOOK');
        if (book.loan !== null) return fail('NOT_ON_LOAN');
        if (book.holds.length > 0 && book.holds[0].memberId !== c.memberId) {
          return fail('NOT_AVAILABLE');
        }
        if (book.holds.length > 0) {
          book.holds.shift();
        }
        const due = c.day + LOAN_DAYS;
        book.loan = { memberId: c.memberId, seq: loanSeq++, dueDay: due, renewals: 0 };
        return { ok: true, dueDate: formatDate(due) };
      });
    },

    returnBook(arg) {
      return safely(() => {
        const c = readCall(arg, true);
        if (!c) return fail('INVALID_INPUT');
        if (!advance(c.day)) return fail('DATE_OUT_OF_ORDER');
        const member = members.get(c.memberId);
        if (!member) return fail('NO_MEMBER');
        const book = books.get(c.bookId);
        if (!book) return fail('NO_BOOK');
        const loan = book.loan;
        if (loan === null || loan.memberId !== c.memberId) return fail('NOT_ON_LOAN');

        const late = c.day - loan.dueDay;
        const fine = late > 0 ? Math.min(FINE_PER_DAY * late, FINE_CAP) : 0;
        member.owed += fine;
        book.loan = null;
        setAside(book, c.day);
        return { ok: true, fine };
      });
    },

    renew(arg) {
      return safely(() => {
        const c = readCall(arg, true);
        if (!c) return fail('INVALID_INPUT');
        if (!advance(c.day)) return fail('DATE_OUT_OF_ORDER');
        const member = members.get(c.memberId);
        if (!member) return fail('NO_MEMBER');
        const book = books.get(c.bookId);
        if (!book) return fail('NO_BOOK');
        const loan = book.loan;
        if (loan === null || loan.memberId !== c.memberId) return fail('NOT_ON_LOAN');
        if (c.day > loan.dueDay) return fail('OVERDUE');
        if (loan.renewals >= MAX_RENEWALS) return fail('RENEWAL_LIMIT');
        if (book.holds.length > 0) return fail('HAS_HOLDS');

        loan.dueDay = c.day + RENEWAL_DAYS;
        loan.renewals += 1;
        return { ok: true, dueDate: formatDate(loan.dueDay) };
      });
    },

    placeHold(arg) {
      return safely(() => {
        const c = readCall(arg, true);
        if (!c) return fail('INVALID_INPUT');
        if (!advance(c.day)) return fail('DATE_OUT_OF_ORDER');
        const member = members.get(c.memberId);
        if (!member) return fail('NO_MEMBER');
        const book = books.get(c.bookId);
        if (!book) return fail('NO_BOOK');
        if (book.loan === null && book.holds.length === 0) return fail('BOOK_AVAILABLE');
        if (book.loan !== null && book.loan.memberId === c.memberId) {
          return fail('ALREADY_BORROWED');
        }
        if (book.holds.some((h) => h.memberId === c.memberId)) {
          return fail('ALREADY_HOLDING');
        }
        book.holds.push({ memberId: c.memberId, seq: holdSeq++, readyUntil: null });
        return { ok: true, position: book.holds.length };
      });
    },

    payFine(arg) {
      return safely(() => {
        const c = readCall(arg, false);
        if (!c) return fail('INVALID_INPUT');
        if (!advance(c.day)) return fail('DATE_OUT_OF_ORDER');
        const amount = c.amount;
        if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 1) {
          return fail('BAD_AMOUNT');
        }
        const member = members.get(c.memberId);
        if (!member) return fail('NO_MEMBER');
        if (amount > member.owed) return fail('BAD_AMOUNT');
        member.owed -= amount;
        return { ok: true, owed: member.owed };
      });
    },

    getMember(arg) {
      return safely(() => {
        const c = readCall(arg, false);
        if (!c) return fail('INVALID_INPUT');
        if (!advance(c.day)) return fail('DATE_OUT_OF_ORDER');
        const member = members.get(c.memberId);
        if (!member) return fail('NO_MEMBER');

        const loanItems = [];
        const holdItems = [];
        for (const book of books.values()) {
          if (book.loan !== null && book.loan.memberId === c.memberId) {
            loanItems.push({
              seq: book.loan.seq,
              bookId: book.id,
              dueDate: formatDate(book.loan.dueDay),
            });
          }
          book.holds.forEach((h, index) => {
            if (h.memberId === c.memberId) {
              holdItems.push({
                seq: h.seq,
                bookId: book.id,
                position: index + 1,
                readyUntil: h.readyUntil === null ? null : formatDate(h.readyUntil),
              });
            }
          });
        }
        loanItems.sort((a, b) => a.seq - b.seq);
        holdItems.sort((a, b) => a.seq - b.seq);

        return {
          loans: loanItems.map((l) => ({ bookId: l.bookId, dueDate: l.dueDate })),
          owed: member.owed,
          holds: holdItems.map((h) => ({
            bookId: h.bookId,
            position: h.position,
            readyUntil: h.readyUntil,
          })),
        };
      });
    },
  };
}
