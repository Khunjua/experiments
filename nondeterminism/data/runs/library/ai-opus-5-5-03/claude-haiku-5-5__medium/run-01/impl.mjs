const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const MAX_LOANS = 5;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 3;
const MAX_FINE_PER_LOAN = 1000;
const BORROW_BLOCK_OWED = 500;
const PICKUP_DAYS = 7;
const MAX_DATE = '9999-12-31';
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isObj(a) {
  return typeof a === 'object' && a !== null;
}

function isId(v) {
  return typeof v === 'string' && v.length > 0;
}

function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function parseDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (y < 1 || m < 1 || m > 12 || d < 1) return null;
  const dim = [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  if (d > dim) return null;
  return { y, m, d };
}

function isValidDate(s) {
  return parseDate(s) !== null;
}

// Days since 1970-01-01 (proleptic Gregorian), pure integer arithmetic.
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
  y += m <= 2 ? 1 : 0;
  return [y, m, d];
}

function dayNum(s) {
  const p = parseDate(s);
  return daysFromCivil(p.y, p.m, p.d);
}

function pad(n, w) {
  return String(n).padStart(w, '0');
}

// Returns null if the result falls outside years 0001-9999.
function addDays(s, n) {
  const [y, m, d] = civilFromDays(dayNum(s) + n);
  if (y < 1 || y > 9999) return null;
  return `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`;
}

function addDaysCapped(s, n) {
  const r = addDays(s, n);
  return r === null ? MAX_DATE : r;
}

function diffDays(a, b) {
  return dayNum(b) - dayNum(a);
}

function removeId(arr, v) {
  const i = arr.indexOf(v);
  if (i >= 0) arr.splice(i, 1);
}

const fail = () => ({ ok: false });

export function createLibrary() {
  const books = new Map();   // bookId -> { id, loan: null | { memberId, dueDate, renewals }, queue: [{ memberId, ready, readyUntil }] }
  const members = new Map(); // memberId -> { id, loans: [bookId] (borrow order), holds: [bookId] (placement order), owed }
  let clock = null;

  function processHolds(D) {
    for (const b of books.values()) {
      while (b.queue.length > 0 && b.queue[0].ready && b.queue[0].readyUntil < D) {
        const gone = b.queue.shift();
        const gm = members.get(gone.memberId);
        if (gm) removeId(gm.holds, b.id);
        if (b.queue.length > 0) {
          const E = addDaysCapped(gone.readyUntil, 1);
          const head = b.queue[0];
          head.ready = true;
          head.readyUntil = addDaysCapped(E, PICKUP_DAYS);
        }
      }
    }
  }

  // Validates the date, enforces time order, advances clock and runs hold processing.
  function advance(date) {
    if (!isValidDate(date)) return false;
    if (clock !== null && date < clock) return false;
    clock = date;
    processHolds(date);
    return true;
  }

  function addBook(args) {
    if (!isObj(args)) return fail();
    const bookId = args.bookId;
    if (!isId(bookId)) return fail();
    if (books.has(bookId)) return fail();
    books.set(bookId, { id: bookId, loan: null, queue: [] });
    return { ok: true };
  }

  function addMember(args) {
    if (!isObj(args)) return fail();
    const memberId = args.memberId;
    if (!isId(memberId)) return fail();
    if (members.has(memberId)) return fail();
    members.set(memberId, { id: memberId, loans: [], holds: [], owed: 0 });
    return { ok: true };
  }

  function borrow(args) {
    if (!isObj(args)) return fail();
    const memberId = args.memberId;
    const bookId = args.bookId;
    const date = args.date;
    if (!isId(memberId) || !isId(bookId)) return fail();
    if (!advance(date)) return fail();
    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b) return fail();
    if (b.loan) return fail();
    const head = b.queue[0];
    const setAsideForMember = !!(head && head.ready && head.memberId === memberId);
    if (head && head.ready && !setAsideForMember) return fail();
    if (m.loans.length >= MAX_LOANS) return fail();
    if (m.owed >= BORROW_BLOCK_OWED) return fail();
    const due = addDays(date, LOAN_DAYS);
    if (due === null) return fail();
    if (setAsideForMember) {
      b.queue.shift();
      removeId(m.holds, bookId);
    }
    b.loan = { memberId, dueDate: due, renewals: 0 };
    m.loans.push(bookId);
    return { ok: true, dueDate: due };
  }

  function returnBook(args) {
    if (!isObj(args)) return fail();
    const memberId = args.memberId;
    const bookId = args.bookId;
    const date = args.date;
    if (!isId(memberId) || !isId(bookId)) return fail();
    if (!advance(date)) return fail();
    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b) return fail();
    if (!b.loan || b.loan.memberId !== memberId) return fail();
    const daysLate = diffDays(b.loan.dueDate, date);
    const fine = daysLate <= GRACE_DAYS
      ? 0
      : Math.min(daysLate * FINE_PER_DAY, MAX_FINE_PER_LOAN);
    const head = b.queue[0];
    let readyUntil = null;
    if (head) {
      readyUntil = addDays(date, PICKUP_DAYS);
      if (readyUntil === null) return fail();
    }
    m.owed += fine;
    b.loan = null;
    removeId(m.loans, bookId);
    if (head) {
      head.ready = true;
      head.readyUntil = readyUntil;
    }
    return { ok: true, fine };
  }

  function renew(args) {
    if (!isObj(args)) return fail();
    const memberId = args.memberId;
    const bookId = args.bookId;
    const date = args.date;
    if (!isId(memberId) || !isId(bookId)) return fail();
    if (!advance(date)) return fail();
    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b) return fail();
    if (!b.loan || b.loan.memberId !== memberId) return fail();
    if (date > b.loan.dueDate) return fail();
    if (b.loan.renewals >= MAX_RENEWALS) return fail();
    if (b.queue.length > 0) return fail();
    const due = addDays(b.loan.dueDate, LOAN_DAYS);
    if (due === null) return fail();
    b.loan.dueDate = due;
    b.loan.renewals += 1;
    return { ok: true, dueDate: due };
  }

  function placeHold(args) {
    if (!isObj(args)) return fail();
    const memberId = args.memberId;
    const bookId = args.bookId;
    const date = args.date;
    if (!isId(memberId) || !isId(bookId)) return fail();
    if (!advance(date)) return fail();
    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b) return fail();
    if (!b.loan && b.queue.length === 0) return fail(); // Available
    if (b.loan && b.loan.memberId === memberId) return fail();
    if (m.holds.includes(bookId)) return fail();
    b.queue.push({ memberId, ready: false, readyUntil: null });
    m.holds.push(bookId);
    return { ok: true, position: b.queue.length };
  }

  function payFine(args) {
    if (!isObj(args)) return fail();
    const memberId = args.memberId;
    const amount = args.amount;
    const date = args.date;
    if (!isId(memberId)) return fail();
    if (!Number.isSafeInteger(amount) || amount <= 0) return fail();
    if (!advance(date)) return fail();
    const m = members.get(memberId);
    if (!m) return fail();
    if (amount > m.owed) return fail();
    m.owed -= amount;
    return { ok: true, owed: m.owed };
  }

  function getMember(args) {
    if (!isObj(args)) return fail();
    const memberId = args.memberId;
    const date = args.date;
    if (!isId(memberId)) return fail();
    if (!advance(date)) return fail();
    const m = members.get(memberId);
    if (!m) return fail();
    const loans = [];
    for (const bookId of m.loans) {
      const b = books.get(bookId);
      if (b && b.loan) loans.push({ bookId, dueDate: b.loan.dueDate });
    }
    const holds = [];
    for (const bookId of m.holds) {
      const b = books.get(bookId);
      if (!b) continue;
      const idx = b.queue.findIndex((h) => h.memberId === memberId);
      if (idx < 0) continue;
      const h = b.queue[idx];
      holds.push({
        bookId,
        position: idx + 1,
        readyUntil: h.ready ? h.readyUntil : null,
      });
    }
    return { ok: true, loans, owed: m.owed, holds };
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
