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

function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function parseDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (y < 1 || y > 9999 || m < 1 || m > 12 || d < 1) return null;
  const dim = [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  if (d > dim) return null;
  return daysFromCivil(y, m, d);
}

function formatDate(n) {
  const [y, m, d] = civilFromDays(n);
  return (
    String(y).padStart(4, '0') + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0')
  );
}

function validId(x) {
  return typeof x === 'string' && x.length > 0;
}

function isObj(a) {
  return typeof a === 'object' && a !== null;
}

const FAIL = () => ({ ok: false });

export function createLibrary() {
  const books = new Map(); // bookId -> { state, loanMember, queue: [memberId], readyUntil }
  const members = new Map(); // memberId -> { loans: Map(bookId -> {dueDate, renewals}), owed, holds: [bookId] }
  let current = null;

  function removeMemberHold(memberId, bookId) {
    const m = members.get(memberId);
    if (!m) return;
    const i = m.holds.indexOf(bookId);
    if (i >= 0) m.holds.splice(i, 1);
  }

  function processExpiry(day) {
    for (const [bookId, b] of books) {
      while (b.state === 'aside' && day > b.readyUntil) {
        const prev = b.readyUntil;
        const expired = b.queue.shift();
        removeMemberHold(expired, bookId);
        if (b.queue.length > 0) {
          b.readyUntil = prev + 1 + PICKUP_DAYS;
        } else {
          b.state = 'available';
          b.readyUntil = null;
        }
      }
    }
  }

  // Validates the date, enforces clock ordering, advances clock and runs expiry.
  // Returns day number or null on failure.
  function enterDated(dateStr) {
    const day = parseDate(dateStr);
    if (day === null) return null;
    if (current !== null && day < current) return null;
    current = day;
    processExpiry(day);
    return day;
  }

  function safe(fn) {
    return function (args) {
      try {
        return fn(args);
      } catch {
        return FAIL();
      }
    };
  }

  const addBook = safe((args) => {
    if (!isObj(args)) return FAIL();
    const { bookId } = args;
    if (!validId(bookId) || books.has(bookId)) return FAIL();
    books.set(bookId, { state: 'available', loanMember: null, queue: [], readyUntil: null });
    return { ok: true };
  });

  const addMember = safe((args) => {
    if (!isObj(args)) return FAIL();
    const { memberId } = args;
    if (!validId(memberId) || members.has(memberId)) return FAIL();
    members.set(memberId, { loans: new Map(), owed: 0, holds: [] });
    return { ok: true };
  });

  const borrow = safe((args) => {
    if (!isObj(args)) return FAIL();
    const { memberId, bookId, date } = args;
    if (!validId(memberId) || !validId(bookId) || parseDate(date) === null) return FAIL();
    const day = enterDated(date);
    if (day === null) return FAIL();
    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b) return FAIL();
    if (b.state === 'loan') return FAIL();
    if (b.state === 'aside' && b.queue[0] !== memberId) return FAIL();
    if (m.loans.size >= MAX_LOANS) return FAIL();
    for (const loan of m.loans.values()) {
      if (loan.dueDate < day) return FAIL();
    }
    if (m.owed >= OWED_BLOCK) return FAIL();

    if (b.state === 'aside') {
      b.queue.shift();
      removeMemberHold(memberId, bookId);
    }
    b.state = 'loan';
    b.loanMember = memberId;
    b.readyUntil = null;
    const dueDate = day + LOAN_DAYS;
    m.loans.set(bookId, { dueDate, renewals: 0 });
    return { ok: true, dueDate: formatDate(dueDate) };
  });

  const returnBook = safe((args) => {
    if (!isObj(args)) return FAIL();
    const { memberId, bookId, date } = args;
    if (!validId(memberId) || !validId(bookId) || parseDate(date) === null) return FAIL();
    const day = enterDated(date);
    if (day === null) return FAIL();
    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b) return FAIL();
    if (b.state !== 'loan' || b.loanMember !== memberId || !m.loans.has(bookId)) return FAIL();

    const loan = m.loans.get(bookId);
    const daysLate = Math.max(0, day - loan.dueDate);
    const fine = Math.min(MAX_FINE, FINE_RATE * Math.max(0, daysLate - GRACE_DAYS));
    m.owed += fine;
    m.loans.delete(bookId);
    b.loanMember = null;
    if (b.queue.length === 0) {
      b.state = 'available';
      b.readyUntil = null;
    } else {
      b.state = 'aside';
      b.readyUntil = day + PICKUP_DAYS;
    }
    return { ok: true, fine };
  });

  const renew = safe((args) => {
    if (!isObj(args)) return FAIL();
    const { memberId, bookId, date } = args;
    if (!validId(memberId) || !validId(bookId) || parseDate(date) === null) return FAIL();
    const day = enterDated(date);
    if (day === null) return FAIL();
    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b) return FAIL();
    if (b.state !== 'loan' || b.loanMember !== memberId || !m.loans.has(bookId)) return FAIL();
    const loan = m.loans.get(bookId);
    if (loan.renewals >= MAX_RENEWALS) return FAIL();
    if (day > loan.dueDate) return FAIL();
    if (b.queue.length > 0) return FAIL();
    loan.dueDate = day + RENEW_DAYS;
    loan.renewals += 1;
    return { ok: true, dueDate: formatDate(loan.dueDate) };
  });

  const placeHold = safe((args) => {
    if (!isObj(args)) return FAIL();
    const { memberId, bookId, date } = args;
    if (!validId(memberId) || !validId(bookId) || parseDate(date) === null) return FAIL();
    const day = enterDated(date);
    if (day === null) return FAIL();
    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b) return FAIL();
    if (b.state === 'available') return FAIL();
    if (b.state === 'loan' && b.loanMember === memberId) return FAIL();
    if (b.queue.includes(memberId)) return FAIL();
    if (m.holds.length >= MAX_HOLDS) return FAIL();
    b.queue.push(memberId);
    m.holds.push(bookId);
    return { ok: true, position: b.queue.length };
  });

  const payFine = safe((args) => {
    if (!isObj(args)) return FAIL();
    const { memberId, amount, date } = args;
    if (!validId(memberId) || parseDate(date) === null) return FAIL();
    if (typeof amount !== 'number' || !Number.isSafeInteger(amount) || amount <= 0) return FAIL();
    const day = enterDated(date);
    if (day === null) return FAIL();
    const m = members.get(memberId);
    if (!m) return FAIL();
    if (amount > m.owed) return FAIL();
    m.owed -= amount;
    return { ok: true, owed: m.owed };
  });

  const getMember = safe((args) => {
    if (!isObj(args)) return FAIL();
    const { memberId, date } = args;
    if (!validId(memberId) || parseDate(date) === null) return FAIL();
    const day = enterDated(date);
    if (day === null) return FAIL();
    const m = members.get(memberId);
    if (!m) return FAIL();
    const loans = [];
    for (const [bookId, loan] of m.loans) {
      loans.push({ bookId, dueDate: formatDate(loan.dueDate) });
    }
    const holds = [];
    for (const bookId of m.holds) {
      const b = books.get(bookId);
      const idx = b.queue.indexOf(memberId);
      const ready = b.state === 'aside' && idx === 0;
      holds.push({
        bookId,
        position: idx + 1,
        readyUntil: ready ? formatDate(b.readyUntil) : null,
      });
    }
    return { ok: true, loans, owed: m.owed, holds };
  });

  return { addBook, addMember, borrow, returnBook, renew, placeHold, payFine, getMember };
}
