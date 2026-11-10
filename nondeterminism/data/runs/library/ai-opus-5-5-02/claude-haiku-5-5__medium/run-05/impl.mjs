const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const MAX_FINE_PER_LOAN = 1000;
const BORROW_BLOCK_OWED = 1000;
const MAX_LOANS = 5;
const MAX_HOLDS = 5;
const PICKUP_DAYS = 7;
const MS_PER_DAY = 86400000;

function parseDay(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (y < 1 || m < 1 || m > 12 || d < 1) return null;
  const dt = new Date(0);
  dt.setUTCFullYear(y, m - 1, d);
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return Math.round(dt.getTime() / MS_PER_DAY);
}

function formatDay(day) {
  const dt = new Date(day * MS_PER_DAY);
  const y = String(dt.getUTCFullYear()).padStart(4, '0');
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function validId(id) {
  return typeof id === 'string' && id.length > 0;
}

function args(x) {
  return x !== null && typeof x === 'object' ? x : {};
}

export function createLibrary() {
  const books = new Map();
  const members = new Map();
  let lastDay = -Infinity;

  function expire(today) {
    for (const [bookId, b] of books) {
      while (b.status === 'setaside' && b.readyUntil < today) {
        const holder = members.get(b.member);
        if (holder) {
          holder.holds = holder.holds.filter((id) => id !== bookId);
        }
        const start = b.readyUntil + 1;
        if (b.queue.length > 0) {
          b.member = b.queue.shift();
          b.readyUntil = start + PICKUP_DAYS;
        } else {
          b.status = 'shelf';
          b.member = null;
          b.readyUntil = null;
        }
      }
    }
  }

  // Returns the day number if the date is valid and not earlier than the
  // latest date seen; otherwise null. On acceptance, updates the latest date
  // and runs expiry processing.
  function enter(date) {
    const day = parseDay(date);
    if (day === null || day < lastDay) return null;
    lastDay = day;
    expire(day);
    return day;
  }

  function addBook(input) {
    const { bookId } = args(input);
    if (!validId(bookId) || books.has(bookId)) return { ok: false };
    books.set(bookId, { status: 'shelf', member: null, readyUntil: null, queue: [] });
    return { ok: true };
  }

  function addMember(input) {
    const { memberId } = args(input);
    if (!validId(memberId) || members.has(memberId)) return { ok: false };
    members.set(memberId, { owed: 0, loans: [], holds: [] });
    return { ok: true };
  }

  function borrow(input) {
    const { memberId, bookId, date } = args(input);
    const day = enter(date);
    if (day === null) return { ok: false };
    if (!validId(memberId) || !validId(bookId)) return { ok: false };
    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b) return { ok: false };

    if (b.status === 'loan') return { ok: false };
    if (b.status === 'setaside' && b.member !== memberId) return { ok: false };
    if (b.status === 'shelf' && b.queue.length > 0) return { ok: false };
    if (m.loans.length >= MAX_LOANS) return { ok: false };
    if (m.owed >= BORROW_BLOCK_OWED) return { ok: false };

    if (b.status === 'setaside') {
      m.holds = m.holds.filter((id) => id !== bookId);
    }
    b.status = 'loan';
    b.member = memberId;
    b.readyUntil = null;

    const dueDay = day + LOAN_DAYS;
    m.loans.push({ bookId, dueDay, renewals: 0 });
    return { ok: true, dueDate: formatDay(dueDay) };
  }

  function returnBook(input) {
    const { memberId, bookId, date } = args(input);
    const day = enter(date);
    if (day === null) return { ok: false };
    if (!validId(memberId) || !validId(bookId)) return { ok: false };
    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b) return { ok: false };
    if (b.status !== 'loan' || b.member !== memberId) return { ok: false };

    const idx = m.loans.findIndex((l) => l.bookId === bookId);
    if (idx < 0) return { ok: false };
    const loan = m.loans[idx];

    const daysLate = Math.max(0, day - loan.dueDay);
    const fine = Math.min(daysLate * FINE_PER_DAY, MAX_FINE_PER_LOAN);
    m.owed += fine;
    m.loans.splice(idx, 1);

    if (b.queue.length > 0) {
      b.status = 'setaside';
      b.member = b.queue.shift();
      b.readyUntil = day + PICKUP_DAYS;
    } else {
      b.status = 'shelf';
      b.member = null;
      b.readyUntil = null;
    }
    return { ok: true, fine };
  }

  function renew(input) {
    const { memberId, bookId, date } = args(input);
    const day = enter(date);
    if (day === null) return { ok: false };
    if (!validId(memberId) || !validId(bookId)) return { ok: false };
    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b) return { ok: false };
    if (b.status !== 'loan' || b.member !== memberId) return { ok: false };

    const loan = m.loans.find((l) => l.bookId === bookId);
    if (!loan) return { ok: false };
    if (loan.renewals >= MAX_RENEWALS) return { ok: false };
    if (day > loan.dueDay) return { ok: false };
    if (b.queue.length > 0) return { ok: false };

    loan.dueDay = day + LOAN_DAYS;
    loan.renewals += 1;
    return { ok: true, dueDate: formatDay(loan.dueDay) };
  }

  function placeHold(input) {
    const { memberId, bookId, date } = args(input);
    const day = enter(date);
    if (day === null) return { ok: false };
    if (!validId(memberId) || !validId(bookId)) return { ok: false };
    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b) return { ok: false };

    if (b.status === 'shelf') return { ok: false };
    if (b.status === 'loan' && b.member === memberId) return { ok: false };
    if (b.queue.includes(memberId)) return { ok: false };
    if (b.status === 'setaside' && b.member === memberId) return { ok: false };
    if (m.holds.length >= MAX_HOLDS) return { ok: false };

    b.queue.push(memberId);
    m.holds.push(bookId);
    const position = b.queue.length + (b.status === 'setaside' ? 1 : 0);
    return { ok: true, position };
  }

  function payFine(input) {
    const { memberId, amount, date } = args(input);
    const day = enter(date);
    if (day === null) return { ok: false };
    if (!validId(memberId)) return { ok: false };
    const m = members.get(memberId);
    if (!m) return { ok: false };
    if (!Number.isInteger(amount) || amount <= 0 || amount > m.owed) return { ok: false };

    m.owed -= amount;
    return { ok: true, owed: m.owed };
  }

  function getMember(input) {
    const { memberId, date } = args(input);
    const day = enter(date);
    if (day === null) return { ok: false };
    if (!validId(memberId)) return { ok: false };
    const m = members.get(memberId);
    if (!m) return { ok: false };

    const loans = m.loans.map((l) => ({ bookId: l.bookId, dueDate: formatDay(l.dueDay) }));
    const holds = m.holds.map((bookId) => {
      const b = books.get(bookId);
      if (b.status === 'setaside' && b.member === memberId) {
        return { bookId, position: 1, readyUntil: formatDay(b.readyUntil) };
      }
      const idx = b.queue.indexOf(memberId);
      const position = idx + 1 + (b.status === 'setaside' ? 1 : 0);
      return { bookId, position, readyUntil: null };
    });

    return { loans, owed: m.owed, holds };
  }

  return {
    addBook,
    addMember,
    borrow,
    returnBook,
    renew,
    placeHold,
    payFine,
    getMember,
  };
}
