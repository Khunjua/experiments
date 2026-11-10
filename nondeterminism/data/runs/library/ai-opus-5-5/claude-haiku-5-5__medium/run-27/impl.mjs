const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86400000;
const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const RENEW_DAYS = 21;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 2;
const MAX_FINE = 500;
const MAX_LOANS = 5;
const BLOCK_OWED = 1000;
const MAX_HOLDS = 5;
const PICKUP_DAYS = 7;

function dayOf(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (y < 1) return null;
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return Math.round(t.getTime() / DAY_MS);
}

function dateOf(n) {
  const t = new Date(n * DAY_MS);
  const y = String(t.getUTCFullYear()).padStart(4, '0');
  const m = String(t.getUTCMonth() + 1).padStart(2, '0');
  const d = String(t.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

const MIN_DAY = dayOf('0001-01-01');
const MAX_DAY = dayOf('9999-12-31');

function plus(n, k) {
  return Math.min(MAX_DAY, n + k);
}

function isId(x) {
  return typeof x === 'string' && x.length > 0;
}

function argsOf(a) {
  return a !== null && typeof a === 'object' ? a : {};
}

function removeFrom(list, value) {
  const i = list.indexOf(value);
  if (i !== -1) list.splice(i, 1);
}

export function createLibrary() {
  const books = new Map();
  const members = new Map();
  let today = null;

  const fail = () => ({ ok: false });

  function expire(day) {
    for (const [bookId, book] of books) {
      while (book.status === 'set' && day > book.readyDay) {
        const memberId = book.queue.shift();
        removeFrom(members.get(memberId).holdBooks, bookId);
        if (book.queue.length === 0) {
          book.status = 'available';
          book.readyDay = null;
        } else {
          book.readyDay = plus(plus(book.readyDay, 1), PICKUP_DAYS);
        }
      }
    }
  }

  function enter(date) {
    const day = dayOf(date);
    if (day === null) return null;
    if (today !== null && day < today) return null;
    today = day;
    expire(day);
    return day;
  }

  function addBook(args) {
    const { bookId } = argsOf(args);
    if (!isId(bookId) || books.has(bookId)) return fail();
    books.set(bookId, { status: 'available', loan: null, queue: [], readyDay: null });
    return { ok: true };
  }

  function addMember(args) {
    const { memberId } = argsOf(args);
    if (!isId(memberId) || members.has(memberId)) return fail();
    members.set(memberId, { loanBooks: [], holdBooks: [], owed: 0 });
    return { ok: true };
  }

  function borrow(args) {
    const a = argsOf(args);
    const day = enter(a.date);
    if (day === null) return fail();
    const { memberId, bookId } = a;
    if (!isId(memberId) || !isId(bookId)) return fail();
    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b) return fail();
    if (b.status === 'loan') return fail();
    if (b.status === 'set' && b.queue[0] !== memberId) return fail();
    if (m.loanBooks.length >= MAX_LOANS) return fail();
    for (const id of m.loanBooks) {
      if (books.get(id).loan.dueDay < day) return fail();
    }
    if (m.owed >= BLOCK_OWED) return fail();

    if (b.status === 'set') {
      b.queue.shift();
      removeFrom(m.holdBooks, bookId);
    }
    const dueDay = plus(day, LOAN_DAYS);
    b.status = 'loan';
    b.readyDay = null;
    b.loan = { memberId, dueDay, renewals: 0 };
    m.loanBooks.push(bookId);
    return { ok: true, dueDate: dateOf(dueDay) };
  }

  function returnBook(args) {
    const a = argsOf(args);
    const day = enter(a.date);
    if (day === null) return fail();
    const { memberId, bookId } = a;
    if (!isId(memberId) || !isId(bookId)) return fail();
    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b) return fail();
    if (b.status !== 'loan' || b.loan.memberId !== memberId) return fail();

    const late = Math.max(0, day - b.loan.dueDay);
    const fine = Math.min(MAX_FINE, FINE_PER_DAY * Math.max(0, late - GRACE_DAYS));
    m.owed += fine;
    removeFrom(m.loanBooks, bookId);
    b.loan = null;
    if (b.queue.length === 0) {
      b.status = 'available';
      b.readyDay = null;
    } else {
      b.status = 'set';
      b.readyDay = plus(day, PICKUP_DAYS);
    }
    return { ok: true, fine };
  }

  function renew(args) {
    const a = argsOf(args);
    const day = enter(a.date);
    if (day === null) return fail();
    const { memberId, bookId } = a;
    if (!isId(memberId) || !isId(bookId)) return fail();
    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b) return fail();
    if (b.status !== 'loan' || b.loan.memberId !== memberId) return fail();
    if (b.loan.renewals >= MAX_RENEWALS) return fail();
    if (day > b.loan.dueDay) return fail();
    if (b.queue.length > 0) return fail();

    b.loan.dueDay = plus(day, RENEW_DAYS);
    b.loan.renewals += 1;
    return { ok: true, dueDate: dateOf(b.loan.dueDay) };
  }

  function placeHold(args) {
    const a = argsOf(args);
    const day = enter(a.date);
    if (day === null) return fail();
    const { memberId, bookId } = a;
    if (!isId(memberId) || !isId(bookId)) return fail();
    const m = members.get(memberId);
    const b = books.get(bookId);
    if (!m || !b) return fail();
    if (b.status === 'available') return fail();
    if (b.status === 'loan' && b.loan.memberId === memberId) return fail();
    if (b.queue.includes(memberId)) return fail();
    if (m.holdBooks.length >= MAX_HOLDS) return fail();

    b.queue.push(memberId);
    m.holdBooks.push(bookId);
    return { ok: true, position: b.queue.length };
  }

  function payFine(args) {
    const a = argsOf(args);
    const day = enter(a.date);
    if (day === null) return fail();
    const { memberId, amount } = a;
    if (!isId(memberId)) return fail();
    if (!Number.isSafeInteger(amount) || amount <= 0) return fail();
    const m = members.get(memberId);
    if (!m) return fail();
    if (amount > m.owed) return fail();

    m.owed -= amount;
    return { ok: true, owed: m.owed };
  }

  function getMember(args) {
    const a = argsOf(args);
    const day = enter(a.date);
    if (day === null) return fail();
    const { memberId } = a;
    if (!isId(memberId)) return fail();
    const m = members.get(memberId);
    if (!m) return fail();

    const loans = m.loanBooks.map((id) => ({
      bookId: id,
      dueDate: dateOf(books.get(id).loan.dueDay),
    }));
    const holds = m.holdBooks.map((id) => {
      const b = books.get(id);
      const idx = b.queue.indexOf(memberId);
      const ready = b.status === 'set' && idx === 0;
      return {
        bookId: id,
        position: idx + 1,
        readyUntil: ready ? dateOf(b.readyDay) : null,
      };
    });
    return { ok: true, loans, owed: m.owed, holds };
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
