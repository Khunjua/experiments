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

// Days since 1970-01-01 in the proleptic Gregorian calendar (no time zones).
function daysFromCivil(y, m, d) {
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yoe = yy - era * 400;
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
  return [m <= 2 ? y + 1 : y, m, d];
}

function parseDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (m < 1 || m > 12) return null;
  const dim = [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  if (d < 1 || d > dim) return null;
  return daysFromCivil(y, m, d);
}

function formatDate(z) {
  const [y, m, d] = civilFromDays(z);
  return String(y).padStart(4, '0') + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}

function validId(x) {
  return typeof x === 'string' && x.length > 0;
}

function obj(arg) {
  return arg !== null && typeof arg === 'object' ? arg : {};
}

function removeItem(arr, value) {
  const i = arr.indexOf(value);
  if (i >= 0) arr.splice(i, 1);
}

export function createLibrary() {
  // Book: { id, status: 'available' | 'loan' | 'set', holder, dueDay, renewals, holds, readyUntil }
  // Member: { id, owed, loans: Set<bookId>, holds: [bookId] }
  const books = new Map();
  const members = new Map();

  const fail = () => ({ ok: false });

  function lookupBook(id) {
    return validId(id) ? books.get(id) : undefined;
  }

  function lookupMember(id) {
    return validId(id) ? members.get(id) : undefined;
  }

  // §5.4 expiry processing for day number D.
  function expire(D) {
    for (const book of books.values()) {
      while (book.status === 'set' && D > book.readyUntil) {
        const reserved = book.holds.shift();
        const m = members.get(reserved);
        if (m) removeItem(m.holds, book.id);
        if (book.holds.length > 0) {
          book.readyUntil = book.readyUntil + 1 + PICKUP_DAYS;
        } else {
          book.status = 'available';
          book.readyUntil = null;
        }
      }
    }
  }

  function addBook(arg) {
    const a = obj(arg);
    const id = a.bookId;
    if (!validId(id) || books.has(id)) return fail();
    books.set(id, {
      id,
      status: 'available',
      holder: null,
      dueDay: null,
      renewals: 0,
      holds: [],
      readyUntil: null,
    });
    return { ok: true };
  }

  function addMember(arg) {
    const a = obj(arg);
    const id = a.memberId;
    if (!validId(id) || members.has(id)) return fail();
    members.set(id, { id, owed: 0, loans: new Set(), holds: [] });
    return { ok: true };
  }

  function borrow(arg) {
    const a = obj(arg);
    const D = parseDate(a.date);
    if (D === null) return fail();
    expire(D);
    const m = lookupMember(a.memberId);
    const b = lookupBook(a.bookId);
    if (!m || !b) return fail();
    if (b.status === 'loan') return fail();
    if (b.status === 'set' && b.holds[0] !== m.id) return fail();
    for (const bid of m.loans) {
      if (books.get(bid).dueDay < D) return fail();
    }
    if (m.owed >= BLOCK_THRESHOLD) return fail();

    if (b.status === 'set') {
      b.holds.shift();
      removeItem(m.holds, b.id);
    }
    b.status = 'loan';
    b.holder = m.id;
    b.dueDay = D + LOAN_DAYS;
    b.renewals = 0;
    b.readyUntil = null;
    m.loans.add(b.id);
    return { ok: true, dueDate: formatDate(b.dueDay) };
  }

  function returnBook(arg) {
    const a = obj(arg);
    const D = parseDate(a.date);
    if (D === null) return fail();
    expire(D);
    const m = lookupMember(a.memberId);
    const b = lookupBook(a.bookId);
    if (!m || !b) return fail();
    if (b.status !== 'loan' || b.holder !== m.id) return fail();

    const late = D - b.dueDay;
    const chargeable = Math.max(0, late - GRACE_DAYS);
    const fine = Math.min(chargeable * FINE_PER_DAY, FINE_CAP);
    m.owed += fine;

    m.loans.delete(b.id);
    b.holder = null;
    b.dueDay = null;
    b.renewals = 0;
    if (b.holds.length > 0) {
      b.status = 'set';
      b.readyUntil = D + PICKUP_DAYS;
    } else {
      b.status = 'available';
      b.readyUntil = null;
    }
    return { ok: true, fine };
  }

  function renew(arg) {
    const a = obj(arg);
    const D = parseDate(a.date);
    if (D === null) return fail();
    expire(D);
    const m = lookupMember(a.memberId);
    const b = lookupBook(a.bookId);
    if (!m || !b) return fail();
    if (b.status !== 'loan' || b.holder !== m.id) return fail();
    if (D > b.dueDay) return fail();
    if (b.renewals >= MAX_RENEWALS) return fail();
    if (b.holds.length > 0) return fail();
    if (m.owed >= BLOCK_THRESHOLD) return fail();

    b.dueDay = D + LOAN_DAYS;
    b.renewals += 1;
    return { ok: true, dueDate: formatDate(b.dueDay) };
  }

  function placeHold(arg) {
    const a = obj(arg);
    const D = parseDate(a.date);
    if (D === null) return fail();
    expire(D);
    const m = lookupMember(a.memberId);
    const b = lookupBook(a.bookId);
    if (!m || !b) return fail();
    if (b.status === 'available') return fail();
    if (b.status === 'loan' && b.holder === m.id) return fail();
    if (b.holds.includes(m.id)) return fail();

    b.holds.push(m.id);
    m.holds.push(b.id);
    return { ok: true, position: b.holds.length };
  }

  function payFine(arg) {
    const a = obj(arg);
    const D = parseDate(a.date);
    if (D === null) return fail();
    expire(D);
    const m = lookupMember(a.memberId);
    if (!m) return fail();
    const amount = a.amount;
    if (!Number.isInteger(amount) || amount <= 0) return fail();
    if (amount > m.owed) return fail();

    m.owed -= amount;
    return { ok: true, owed: m.owed };
  }

  function getMember(arg) {
    const a = obj(arg);
    const D = parseDate(a.date);
    if (D === null) return fail();
    expire(D);
    const m = lookupMember(a.memberId);
    if (!m) return fail();

    const loans = [];
    for (const bid of m.loans) {
      const b = books.get(bid);
      loans.push({ bookId: bid, dueDate: formatDate(b.dueDay) });
    }

    const holds = [];
    for (const bid of m.holds) {
      const b = books.get(bid);
      const position = b.holds.indexOf(m.id) + 1;
      const readyUntil =
        b.status === 'set' && b.holds[0] === m.id ? formatDate(b.readyUntil) : null;
      holds.push({ bookId: bid, position, readyUntil });
    }

    return { loans, owed: m.owed, holds };
  }

  function guarded(fn) {
    return function (arg) {
      try {
        return fn(arg);
      } catch {
        return { ok: false };
      }
    };
  }

  return {
    addBook: guarded(addBook),
    addMember: guarded(addMember),
    borrow: guarded(borrow),
    returnBook: guarded(returnBook),
    renew: guarded(renew),
    placeHold: guarded(placeHold),
    payFine: guarded(payFine),
    getMember: guarded(getMember),
  };
}
