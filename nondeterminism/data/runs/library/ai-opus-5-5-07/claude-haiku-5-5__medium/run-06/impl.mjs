const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 2;
const FINE_CAP = 1000;
const BLOCK_THRESHOLD = 500;
const PICKUP_DAYS = 7;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y, m) {
  const table = [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return table[m - 1];
}

// Days since 1970-01-01 (proleptic Gregorian, no time zones).
function daysFromCivil(y, m, d) {
  y -= m <= 2 ? 1 : 0;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const mp = m > 2 ? m - 3 : m + 9;
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
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  const year = m <= 2 ? y + 1 : y;
  return [year, m, d];
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

function fmt(z) {
  const [y, m, d] = civilFromDays(z);
  return `${String(y).padStart(4, '0')}-${pad2(m)}-${pad2(d)}`;
}

// Returns the day number, or null if the string is not a real calendar date.
function parseDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  return daysFromCivil(y, m, d);
}

function validId(x) {
  return typeof x === 'string' && x.length > 0;
}

function asObj(x) {
  return x !== null && typeof x === 'object' ? x : {};
}

function removeFirst(arr, value) {
  const i = arr.indexOf(value);
  if (i !== -1) arr.splice(i, 1);
}

export function createLibrary() {
  const books = new Map();
  const members = new Map();

  // §5.4 expiry processing for day D.
  function expire(D) {
    for (const [bookId, book] of books) {
      while (book.readyDay !== null && D > book.readyDay) {
        if (book.holdLine.length === 0) {
          book.readyDay = null;
          break;
        }
        const memberId = book.holdLine.shift();
        const m = members.get(memberId);
        if (m) removeFirst(m.holds, bookId);
        if (book.holdLine.length > 0) {
          book.readyDay = book.readyDay + 1 + PICKUP_DAYS;
        } else {
          book.readyDay = null;
        }
      }
    }
  }

  function addBook(args) {
    const a = asObj(args);
    if (!validId(a.bookId) || books.has(a.bookId)) return { ok: false };
    books.set(a.bookId, {
      loanedTo: null,
      dueDay: null,
      renewals: 0,
      holdLine: [],
      readyDay: null,
    });
    return { ok: true };
  }

  function addMember(args) {
    const a = asObj(args);
    if (!validId(a.memberId) || members.has(a.memberId)) return { ok: false };
    members.set(a.memberId, { owed: 0, loans: [], holds: [] });
    return { ok: true };
  }

  function borrow(args) {
    const a = asObj(args);
    const D = parseDate(a.date);
    if (D === null) return { ok: false };
    expire(D);

    const memberId = a.memberId;
    const bookId = a.bookId;
    if (!validId(memberId) || !validId(bookId)) return { ok: false };
    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b) return { ok: false };
    if (b.loanedTo !== null) return { ok: false };
    if (b.holdLine.length > 0 && b.holdLine[0] !== memberId) return { ok: false };
    if (m.loans.some((id) => books.get(id).dueDay < D)) return { ok: false };
    if (m.owed >= BLOCK_THRESHOLD) return { ok: false };

    if (b.holdLine.length > 0) {
      // Set aside for this member: remove their hold, others move up.
      b.holdLine.shift();
      removeFirst(m.holds, bookId);
    }
    b.loanedTo = memberId;
    b.dueDay = D + LOAN_DAYS;
    b.renewals = 0;
    b.readyDay = null;
    m.loans.push(bookId);
    return { ok: true, dueDate: fmt(b.dueDay) };
  }

  function returnBook(args) {
    const a = asObj(args);
    const D = parseDate(a.date);
    if (D === null) return { ok: false };
    expire(D);

    const memberId = a.memberId;
    const bookId = a.bookId;
    if (!validId(memberId) || !validId(bookId)) return { ok: false };
    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b) return { ok: false };
    if (b.loanedTo !== memberId) return { ok: false };

    const late = D - b.dueDay;
    const chargeable = Math.max(0, late - GRACE_DAYS);
    const fine = Math.min(chargeable * FINE_PER_DAY, FINE_CAP);
    m.owed += fine;

    removeFirst(m.loans, bookId);
    b.loanedTo = null;
    b.dueDay = null;
    b.renewals = 0;
    if (b.holdLine.length > 0) {
      b.readyDay = D + PICKUP_DAYS;
    } else {
      b.readyDay = null;
    }
    return { ok: true, fine };
  }

  function renew(args) {
    const a = asObj(args);
    const D = parseDate(a.date);
    if (D === null) return { ok: false };
    expire(D);

    const memberId = a.memberId;
    const bookId = a.bookId;
    if (!validId(memberId) || !validId(bookId)) return { ok: false };
    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b) return { ok: false };
    if (b.loanedTo !== memberId) return { ok: false };
    if (D > b.dueDay) return { ok: false };
    if (b.renewals >= MAX_RENEWALS) return { ok: false };
    if (b.holdLine.length > 0) return { ok: false };
    if (m.owed >= BLOCK_THRESHOLD) return { ok: false };

    b.dueDay = D + LOAN_DAYS;
    b.renewals += 1;
    return { ok: true, dueDate: fmt(b.dueDay) };
  }

  function placeHold(args) {
    const a = asObj(args);
    const D = parseDate(a.date);
    if (D === null) return { ok: false };
    expire(D);

    const memberId = a.memberId;
    const bookId = a.bookId;
    if (!validId(memberId) || !validId(bookId)) return { ok: false };
    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b) return { ok: false };
    if (b.loanedTo === null && b.holdLine.length === 0) return { ok: false };
    if (b.loanedTo === memberId) return { ok: false };
    if (b.holdLine.includes(memberId)) return { ok: false };

    b.holdLine.push(memberId);
    m.holds.push(bookId);
    return { ok: true, position: b.holdLine.length };
  }

  function payFine(args) {
    const a = asObj(args);
    const D = parseDate(a.date);
    if (D === null) return { ok: false };
    expire(D);

    const memberId = a.memberId;
    const amount = a.amount;
    if (!validId(memberId)) return { ok: false };
    if (!Number.isInteger(amount) || amount <= 0) return { ok: false };
    const m = members.get(memberId);
    if (!m) return { ok: false };
    if (amount > m.owed) return { ok: false };

    m.owed -= amount;
    return { ok: true, owed: m.owed };
  }

  function getMember(args) {
    const a = asObj(args);
    const D = parseDate(a.date);
    if (D === null) return { ok: false };
    expire(D);

    const memberId = a.memberId;
    if (!validId(memberId)) return { ok: false };
    const m = members.get(memberId);
    if (!m) return { ok: false };

    const loans = m.loans.map((id) => ({
      bookId: id,
      dueDate: fmt(books.get(id).dueDay),
    }));

    const holds = m.holds.map((id) => {
      const b = books.get(id);
      const position = b.holdLine.indexOf(memberId) + 1;
      const setAsideForMe =
        b.loanedTo === null && b.readyDay !== null && b.holdLine[0] === memberId;
      return {
        bookId: id,
        position,
        readyUntil: setAsideForMe ? fmt(b.readyDay) : null,
      };
    });

    return { loans, owed: m.owed, holds };
  }

  const safe = (fn) => (args) => {
    try {
      return fn(args);
    } catch {
      return { ok: false };
    }
  };

  return {
    addBook: safe(addBook),
    addMember: safe(addMember),
    borrow: safe(borrow),
    returnBook: safe(returnBook),
    renew: safe(renew),
    placeHold: safe(placeHold),
    payFine: safe(payFine),
    getMember: safe(getMember),
  };
}
