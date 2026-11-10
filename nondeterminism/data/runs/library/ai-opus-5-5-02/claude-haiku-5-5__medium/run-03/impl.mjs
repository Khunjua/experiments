const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const MAX_FINE_PER_LOAN = 1000;
const BORROW_BLOCK_OWED = 1000;
const MAX_LOANS = 5;
const MAX_HOLDS = 5;
const PICKUP_DAYS = 7;
const DAY_MS = 86400000;

function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y, mo) {
  const days = [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return days[mo - 1];
}

// Returns integer day number (days since 1970-01-01 UTC) or null if invalid.
function parseDate(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1 || mo < 1 || mo > 12 || d < 1) return null;
  if (d > daysInMonth(y, mo)) return null;
  const t = new Date(0);
  t.setUTCFullYear(y, mo - 1, d);
  return Math.round(t.getTime() / DAY_MS);
}

function formatDay(n) {
  const t = new Date(n * DAY_MS);
  const y = String(t.getUTCFullYear()).padStart(4, '0');
  const m = String(t.getUTCMonth() + 1).padStart(2, '0');
  const d = String(t.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function validId(x) {
  return typeof x === 'string' && x.length > 0;
}

function args(x) {
  return x && typeof x === 'object' ? x : {};
}

export function createLibrary() {
  const books = new Map();
  const members = new Map();
  let latest = null;

  function advance(dateStr) {
    const day = parseDate(dateStr);
    if (day === null) return null;
    if (latest !== null && day < latest) return null;
    latest = day;
    expire(day);
    return day;
  }

  function expire(day) {
    for (const book of books.values()) {
      while (book.status === 'aside' && book.readyDay < day) {
        const holder = members.get(book.asideMember);
        if (holder) {
          holder.holds = holder.holds.filter((h) => h.bookId !== book.id);
        }
        const start = book.readyDay + 1;
        if (book.queue.length > 0) {
          book.asideMember = book.queue.shift();
          book.readyDay = start + PICKUP_DAYS;
        } else {
          book.status = 'shelf';
          book.asideMember = null;
          book.readyDay = null;
        }
      }
    }
  }

  function addBook(input) {
    const { bookId } = args(input);
    if (!validId(bookId) || books.has(bookId)) return { ok: false };
    books.set(bookId, {
      id: bookId,
      status: 'shelf',
      loanMember: null,
      asideMember: null,
      readyDay: null,
      queue: [],
    });
    return { ok: true };
  }

  function addMember(input) {
    const { memberId } = args(input);
    if (!validId(memberId) || members.has(memberId)) return { ok: false };
    members.set(memberId, { id: memberId, owed: 0, loans: [], holds: [] });
    return { ok: true };
  }

  function borrow(input) {
    const { memberId, bookId, date } = args(input);
    const day = advance(date);
    if (day === null) return { ok: false };
    if (!validId(memberId) || !validId(bookId)) return { ok: false };
    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b) return { ok: false };
    if (b.status === 'loan') return { ok: false };
    if (b.status === 'aside' && b.asideMember !== memberId) return { ok: false };
    if (b.status === 'shelf' && b.queue.length > 0) return { ok: false };
    if (m.loans.length >= MAX_LOANS) return { ok: false };
    if (m.owed >= BORROW_BLOCK_OWED) return { ok: false };

    if (b.status === 'aside') {
      m.holds = m.holds.filter((h) => h.bookId !== bookId);
    }
    b.status = 'loan';
    b.loanMember = memberId;
    b.asideMember = null;
    b.readyDay = null;

    const dueDay = day + LOAN_DAYS;
    m.loans.push({ bookId, dueDay, renewals: 0 });
    return { ok: true, dueDate: formatDay(dueDay) };
  }

  function returnBook(input) {
    const { memberId, bookId, date } = args(input);
    const day = advance(date);
    if (day === null) return { ok: false };
    if (!validId(memberId) || !validId(bookId)) return { ok: false };
    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b) return { ok: false };
    if (b.status !== 'loan' || b.loanMember !== memberId) return { ok: false };
    const idx = m.loans.findIndex((l) => l.bookId === bookId);
    if (idx < 0) return { ok: false };
    const loan = m.loans[idx];

    const daysLate = Math.max(0, day - loan.dueDay);
    const fine = Math.min(daysLate * FINE_PER_DAY, MAX_FINE_PER_LOAN);
    m.owed += fine;
    m.loans.splice(idx, 1);

    b.loanMember = null;
    if (b.queue.length > 0) {
      b.status = 'aside';
      b.asideMember = b.queue.shift();
      b.readyDay = day + PICKUP_DAYS;
    } else {
      b.status = 'shelf';
    }
    return { ok: true, fine };
  }

  function renew(input) {
    const { memberId, bookId, date } = args(input);
    const day = advance(date);
    if (day === null) return { ok: false };
    if (!validId(memberId) || !validId(bookId)) return { ok: false };
    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b) return { ok: false };
    if (b.status !== 'loan' || b.loanMember !== memberId) return { ok: false };
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
    const day = advance(date);
    if (day === null) return { ok: false };
    if (!validId(memberId) || !validId(bookId)) return { ok: false };
    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b) return { ok: false };
    if (b.status === 'shelf') return { ok: false };
    if (b.status === 'loan' && b.loanMember === memberId) return { ok: false };
    if (b.status === 'aside' && b.asideMember === memberId) return { ok: false };
    if (b.queue.includes(memberId)) return { ok: false };
    if (m.holds.length >= MAX_HOLDS) return { ok: false };

    b.queue.push(memberId);
    m.holds.push({ bookId });
    const position = b.queue.length + (b.status === 'aside' ? 1 : 0);
    return { ok: true, position };
  }

  function payFine(input) {
    const { memberId, amount, date } = args(input);
    const day = advance(date);
    if (day === null) return { ok: false };
    if (!validId(memberId)) return { ok: false };
    const m = members.get(memberId);
    if (!m) return { ok: false };
    if (!Number.isInteger(amount) || amount <= 0) return { ok: false };
    if (amount > m.owed) return { ok: false };
    m.owed -= amount;
    return { ok: true, owed: m.owed };
  }

  function getMember(input) {
    const { memberId, date } = args(input);
    const day = advance(date);
    if (day === null) return { ok: false };
    if (!validId(memberId)) return { ok: false };
    const m = members.get(memberId);
    if (!m) return { ok: false };

    const loans = m.loans.map((l) => ({
      bookId: l.bookId,
      dueDate: formatDay(l.dueDay),
    }));

    const holds = m.holds.map((h) => {
      const b = books.get(h.bookId);
      if (b.status === 'aside' && b.asideMember === memberId) {
        return {
          bookId: h.bookId,
          position: 1,
          readyUntil: formatDay(b.readyDay),
        };
      }
      const index = b.queue.indexOf(memberId) + 1;
      return {
        bookId: h.bookId,
        position: index + (b.status === 'aside' ? 1 : 0),
        readyUntil: null,
      };
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
