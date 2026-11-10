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
  if (m === 2) return isLeap(y) ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

// Proleptic Gregorian day count (days since 1970-01-01), no time zones.
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
  const zz = z + 719468;
  const era = Math.floor(zz / 146097);
  const doe = zz - era * 146097;
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

function fmt(z) {
  const { y, m, d } = civilFromDays(z);
  return (
    String(y).padStart(4, '0') + '-' +
    String(m).padStart(2, '0') + '-' +
    String(d).padStart(2, '0')
  );
}

// Returns epoch day number, or null if not a valid calendar date string.
function parseDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (m < 1 || m > 12) return null;
  if (d < 1 || d > daysInMonth(y, m)) return null;
  return daysFromCivil(y, m, d);
}

function isId(x) {
  return typeof x === 'string' && x.length > 0;
}

function obj(arg) {
  return typeof arg === 'object' && arg !== null ? arg : {};
}

function removeOne(arr, v) {
  const i = arr.indexOf(v);
  if (i >= 0) arr.splice(i, 1);
}

export function createLibrary() {
  const books = new Map();
  const members = new Map();

  function makeAvailable(b) {
    b.state = 'available';
    b.memberId = null;
    b.dueDate = null;
    b.renewals = 0;
    b.readyUntil = null;
  }

  // §5.4 Expiry processing for epoch day `day`.
  function expire(day) {
    for (const b of books.values()) {
      while (b.state === 'aside' && day > b.readyUntil) {
        const gone = b.holds.shift();
        const gm = members.get(gone);
        if (gm) removeOne(gm.holds, b.id);
        if (b.holds.length > 0) {
          b.memberId = b.holds[0];
          b.readyUntil = b.readyUntil + 1 + PICKUP_DAYS;
        } else {
          makeAvailable(b);
        }
      }
    }
  }

  function addBook(arg) {
    const bookId = obj(arg).bookId;
    if (!isId(bookId) || books.has(bookId)) return { ok: false };
    books.set(bookId, {
      id: bookId,
      state: 'available',
      memberId: null,
      dueDate: null,
      renewals: 0,
      readyUntil: null,
      holds: [],
    });
    return { ok: true };
  }

  function addMember(arg) {
    const memberId = obj(arg).memberId;
    if (!isId(memberId) || members.has(memberId)) return { ok: false };
    members.set(memberId, { owed: 0, loans: [], holds: [] });
    return { ok: true };
  }

  function borrow(arg) {
    const o = obj(arg);
    const day = parseDate(o.date);
    if (day === null) return { ok: false };
    expire(day);
    const memberId = o.memberId;
    const bookId = o.bookId;
    if (!isId(memberId) || !isId(bookId)) return { ok: false };
    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b) return { ok: false };
    if (b.state === 'loan') return { ok: false };
    if (b.state === 'aside' && b.memberId !== memberId) return { ok: false };
    for (const lid of m.loans) {
      if (books.get(lid).dueDate < day) return { ok: false };
    }
    if (m.owed >= BLOCK_THRESHOLD) return { ok: false };

    if (b.state === 'aside') {
      b.holds.shift();
      removeOne(m.holds, bookId);
    }
    b.state = 'loan';
    b.memberId = memberId;
    b.dueDate = day + LOAN_DAYS;
    b.renewals = 0;
    b.readyUntil = null;
    m.loans.push(bookId);
    return { ok: true, dueDate: fmt(b.dueDate) };
  }

  function returnBook(arg) {
    const o = obj(arg);
    const day = parseDate(o.date);
    if (day === null) return { ok: false };
    expire(day);
    const memberId = o.memberId;
    const bookId = o.bookId;
    if (!isId(memberId) || !isId(bookId)) return { ok: false };
    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b) return { ok: false };
    if (b.state !== 'loan' || b.memberId !== memberId) return { ok: false };

    const late = day - b.dueDate;
    const chargeable = Math.max(0, late - GRACE_DAYS);
    const fine = Math.min(chargeable * FINE_PER_DAY, FINE_CAP);
    m.owed += fine;
    removeOne(m.loans, bookId);

    if (b.holds.length > 0) {
      b.state = 'aside';
      b.memberId = b.holds[0];
      b.readyUntil = day + PICKUP_DAYS;
      b.dueDate = null;
      b.renewals = 0;
    } else {
      makeAvailable(b);
    }
    return { ok: true, fine };
  }

  function renew(arg) {
    const o = obj(arg);
    const day = parseDate(o.date);
    if (day === null) return { ok: false };
    expire(day);
    const memberId = o.memberId;
    const bookId = o.bookId;
    if (!isId(memberId) || !isId(bookId)) return { ok: false };
    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b) return { ok: false };
    if (b.state !== 'loan' || b.memberId !== memberId) return { ok: false };
    if (day > b.dueDate) return { ok: false };
    if (b.renewals >= MAX_RENEWALS) return { ok: false };
    if (b.holds.length > 0) return { ok: false };
    if (m.owed >= BLOCK_THRESHOLD) return { ok: false };

    b.dueDate = day + LOAN_DAYS;
    b.renewals += 1;
    return { ok: true, dueDate: fmt(b.dueDate) };
  }

  function placeHold(arg) {
    const o = obj(arg);
    const day = parseDate(o.date);
    if (day === null) return { ok: false };
    expire(day);
    const memberId = o.memberId;
    const bookId = o.bookId;
    if (!isId(memberId) || !isId(bookId)) return { ok: false };
    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b) return { ok: false };
    if (b.state === 'available') return { ok: false };
    if (b.state === 'loan' && b.memberId === memberId) return { ok: false };
    if (b.holds.includes(memberId)) return { ok: false };

    b.holds.push(memberId);
    m.holds.push(bookId);
    return { ok: true, position: b.holds.length };
  }

  function payFine(arg) {
    const o = obj(arg);
    const day = parseDate(o.date);
    if (day === null) return { ok: false };
    expire(day);
    const memberId = o.memberId;
    const amount = o.amount;
    if (!isId(memberId)) return { ok: false };
    if (!Number.isInteger(amount) || amount <= 0) return { ok: false };
    const m = members.get(memberId);
    if (!m) return { ok: false };
    if (amount > m.owed) return { ok: false };

    m.owed -= amount;
    return { ok: true, owed: m.owed };
  }

  function getMember(arg) {
    const o = obj(arg);
    const day = parseDate(o.date);
    if (day === null) return { ok: false };
    expire(day);
    const memberId = o.memberId;
    if (!isId(memberId)) return { ok: false };
    const m = members.get(memberId);
    if (!m) return { ok: false };

    const loans = m.loans.map((bid) => {
      const b = books.get(bid);
      return { bookId: bid, dueDate: fmt(b.dueDate) };
    });
    const holds = m.holds.map((bid) => {
      const b = books.get(bid);
      const asideForMe = b.state === 'aside' && b.memberId === memberId;
      return {
        bookId: bid,
        position: b.holds.indexOf(memberId) + 1,
        readyUntil: asideForMe ? fmt(b.readyUntil) : null,
      };
    });
    return { loans, owed: m.owed, holds };
  }

  const guard = (fn) => (arg) => {
    try {
      return fn(arg);
    } catch {
      return { ok: false };
    }
  };

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
