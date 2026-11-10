const LOAN_DAYS = 21;
const RENEW_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const FINE_CAP = 500;
const PICKUP_DAYS = 7;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

// Days since 1970-01-01 in the proleptic Gregorian calendar (pure integer arithmetic).
function daysFromCivil(y, m, d) {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
  const mp = m > 2 ? m - 3 : m + 9;
  const doy = Math.floor((153 * mp + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

function civilFromDays(z0) {
  const z = z0 + 719468;
  const era = Math.floor(z / 146097);
  const doe = z - era * 146097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365
  );
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  return [m <= 2 ? y + 1 : y, m, d];
}

function parseDate(s) {
  if (typeof s !== 'string') return null;
  const match = DATE_RE.exec(s);
  if (match === null) return null;
  const y = Number(match[1]);
  const mo = Number(match[2]);
  const d = Number(match[3]);
  if (mo < 1 || mo > 12 || d < 1) return null;
  const dim = [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
  if (d > dim) return null;
  return daysFromCivil(y, mo, d);
}

function formatDate(n) {
  const [y, m, d] = civilFromDays(n);
  return String(y).padStart(4, '0') + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

function isObj(v) {
  return typeof v === 'object' && v !== null;
}

function isId(v) {
  return typeof v === 'string' && v.length > 0;
}

function reject(reason) {
  return { ok: false, reason };
}

function guard(fn) {
  return (arg) => {
    try {
      return fn(arg);
    } catch (e) {
      return reject('INVALID_INPUT');
    }
  };
}

export function createLibrary() {
  const books = new Map();   // bookId -> { id, loan, line }
  const members = new Map(); // memberId -> { id, owed }
  let clock = null;          // day number of latest accepted dated call
  let seq = 0;               // shared creation counter for loans and holds

  // Expires every set-aside window that ended before `day`.
  function catchUp(day) {
    for (const book of books.values()) {
      while (
        book.loan === null &&
        book.line.length > 0 &&
        book.line[0].readyUntil !== null &&
        book.line[0].readyUntil < day
      ) {
        const freed = book.line[0].readyUntil + 1;
        book.line.shift();
        if (book.line.length > 0) {
          book.line[0].readyUntil = freed + PICKUP_DAYS;
        }
      }
    }
  }

  // Validates a dated call's date, rejects if out of order, otherwise moves the clock
  // and applies catch-up. Returns the day number or null if rejected.
  function enterDated(rawDate) {
    const day = parseDate(rawDate);
    if (day === null) return null;
    if (clock !== null && day < clock) return null;
    clock = day;
    catchUp(day);
    return day;
  }

  // Called when a book that is on loan (or otherwise free) becomes free on `day`.
  function becomeFree(book, day) {
    if (book.line.length > 0) {
      book.line[0].readyUntil = day + PICKUP_DAYS;
    }
  }

  const addBook = guard((arg) => {
    if (!isObj(arg)) return reject('INVALID_INPUT');
    const id = arg.bookId;
    if (!isId(id)) return reject('INVALID_INPUT');
    if (books.has(id)) return reject('DUPLICATE');
    books.set(id, { id, loan: null, line: [] });
    return { ok: true };
  });

  const addMember = guard((arg) => {
    if (!isObj(arg)) return reject('INVALID_INPUT');
    const id = arg.memberId;
    if (!isId(id)) return reject('INVALID_INPUT');
    if (members.has(id)) return reject('DUPLICATE');
    members.set(id, { id, owed: 0 });
    return { ok: true };
  });

  const borrow = guard((arg) => {
    if (!isObj(arg)) return reject('INVALID_INPUT');
    const memberId = arg.memberId;
    const bookId = arg.bookId;
    const day = enterDated(arg.date);
    if (day === null) return reject('INVALID_INPUT');
    if (!isId(memberId) || !isId(bookId)) return reject('INVALID_INPUT');
    if (!members.has(memberId)) return reject('NO_MEMBER');
    const b = books.get(bookId);
    if (!b) return reject('NO_BOOK');
    if (b.loan !== null) return reject('NOT_AVAILABLE');
    if (b.line.length > 0 && (b.line[0].member !== memberId || b.line[0].readyUntil === null)) {
      return reject('NOT_AVAILABLE');
    }
    if (b.line.length > 0) {
      b.line.shift();
    }
    b.loan = {
      memberId,
      borrowDay: day,
      dueDay: day + LOAN_DAYS,
      renewals: 0,
      seq: ++seq,
    };
    return { ok: true, dueDate: formatDate(day + LOAN_DAYS) };
  });

  const placeHold = guard((arg) => {
    if (!isObj(arg)) return reject('INVALID_INPUT');
    const memberId = arg.memberId;
    const bookId = arg.bookId;
    const day = enterDated(arg.date);
    if (day === null) return reject('INVALID_INPUT');
    if (!isId(memberId) || !isId(bookId)) return reject('INVALID_INPUT');
    if (!members.has(memberId)) return reject('NO_MEMBER');
    const b = books.get(bookId);
    if (!b) return reject('NO_BOOK');
    if (b.loan === null && b.line.length === 0) return reject('BOOK_AVAILABLE');
    if (b.loan !== null && b.loan.memberId === memberId) return reject('ALREADY_BORROWED');
    if (b.line.some((h) => h.member === memberId)) return reject('ALREADY_HOLDING');
    b.line.push({ member: memberId, seq: ++seq, readyUntil: null });
    return { ok: true, position: b.line.length };
  });

  const renew = guard((arg) => {
    if (!isObj(arg)) return reject('INVALID_INPUT');
    const memberId = arg.memberId;
    const bookId = arg.bookId;
    const day = enterDated(arg.date);
    if (day === null) return reject('INVALID_INPUT');
    if (!isId(memberId) || !isId(bookId)) return reject('INVALID_INPUT');
    if (!members.has(memberId)) return reject('NO_MEMBER');
    const b = books.get(bookId);
    if (!b) return reject('NO_BOOK');
    const loan = b.loan;
    if (loan === null || loan.memberId !== memberId) return reject('NOT_ON_LOAN');
    if (day > loan.dueDay) return reject('OVERDUE');
    if (loan.renewals >= MAX_RENEWALS) return reject('RENEWAL_LIMIT');
    if (b.line.length > 0) return reject('HAS_HOLDS');
    loan.dueDay = day + RENEW_DAYS;
    loan.renewals += 1;
    return { ok: true, dueDate: formatDate(loan.dueDay) };
  });

  const returnBook = guard((arg) => {
    if (!isObj(arg)) return reject('INVALID_INPUT');
    const memberId = arg.memberId;
    const bookId = arg.bookId;
    const day = enterDated(arg.date);
    if (day === null) return reject('INVALID_INPUT');
    if (!isId(memberId) || !isId(bookId)) return reject('INVALID_INPUT');
    const m = members.get(memberId);
    if (!m) return reject('NO_MEMBER');
    const b = books.get(bookId);
    if (!b) return reject('NO_BOOK');
    const loan = b.loan;
    if (loan === null || loan.memberId !== memberId) return reject('NOT_ON_LOAN');
    const lateDays = Math.max(0, day - loan.dueDay);
    const fine = Math.min(FINE_PER_DAY * lateDays, FINE_CAP);
    m.owed += fine;
    b.loan = null;
    becomeFree(b, day);
    return { ok: true, fine };
  });

  const renewOrNothing = null; // placeholder removed below

  const payFine = guard((arg) => {
    if (!isObj(arg)) return reject('INVALID_INPUT');
    const memberId = arg.memberId;
    const amount = arg.amount;
    const day = enterDated(arg.date);
    if (day === null) return reject('INVALID_INPUT');
    if (!isId(memberId)) return reject('INVALID_INPUT');
    if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount < 1) {
      return reject('BAD_AMOUNT');
    }
    const m = members.get(memberId);
    if (!m) return reject('NO_MEMBER');
    if (amount > m.owed) return reject('BAD_AMOUNT');
    m.owed -= amount;
    return { ok: true, owed: m.owed };
  });

  const getMember = guard((arg) => {
    if (!isObj(arg)) return reject('INVALID_INPUT');
    const memberId = arg.memberId;
    const day = enterDated(arg.date);
    if (day === null) return reject('INVALID_INPUT');
    if (!isId(memberId)) return reject('INVALID_INPUT');
    const m = members.get(memberId);
    if (!m) return reject('NO_MEMBER');

    const loanRows = [];
    const holdRows = [];
    for (const b of books.values()) {
      if (b.loan !== null && b.loan.memberId === memberId) {
        loanRows.push({
          seq: b.loan.seq,
          bookId: b.id,
          dueDate: formatDate(b.loan.dueDay),
        });
      }
      b.line.forEach((h, i) => {
        if (h.member === memberId) {
          const setAside = i === 0 && h.readyUntil !== null;
          holdRows.push({
            seq: h.seq,
            bookId: b.id,
            position: i + 1,
            readyUntil: setAside ? formatDate(h.readyUntil) : null,
          });
        }
      });
    }
    loanRows.sort((x, y) => x.seq - y.seq);
    holdRows.sort((x, y) => x.seq - y.seq);

    return {
      loans: loanRows.map((r) => ({ bookId: r.bookId, dueDate: r.dueDate })),
      owed: m.owed,
      holds: holdRows.map((r) => ({
        bookId: r.bookId,
        position: r.position,
        readyUntil: r.readyUntil,
      })),
    };
  });

  return { addBook, addMember, borrow, returnBook, renew, placeHold, payFine, getMember };
}
