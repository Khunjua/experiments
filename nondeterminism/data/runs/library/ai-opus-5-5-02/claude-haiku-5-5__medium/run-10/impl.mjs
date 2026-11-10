const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const MAX_FINE_PER_LOAN = 1000;
const GRACE_DAYS = 0;
const BORROW_BLOCK_OWED = 1000;
const MAX_LOANS = 5;
const MAX_HOLDS = 5;
const PICKUP_DAYS = 7;
const MS_PER_DAY = 86400000;

function isId(v) {
  return typeof v === 'string' && v.length > 0;
}

// Returns the day number (days since 1970-01-01 UTC) or null if invalid.
function parseDate(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1 || mo < 1 || mo > 12 || d < 1) return null;
  const t = new Date(0);
  t.setUTCFullYear(y, mo - 1, d);
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) {
    return null;
  }
  return Math.round(t.getTime() / MS_PER_DAY);
}

function formatDate(n) {
  const t = new Date(n * MS_PER_DAY);
  const y = String(t.getUTCFullYear()).padStart(4, '0');
  const mo = String(t.getUTCMonth() + 1).padStart(2, '0');
  const d = String(t.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${d}`;
}

function argsOf(a) {
  return a !== null && typeof a === 'object' ? a : {};
}

export function createLibrary() {
  const books = new Map();
  const members = new Map();
  let latest = null;

  // Hold-expiry processing up to day D (section 6.4).
  function expire(day) {
    for (const book of books.values()) {
      while (book.status === 'set' && book.readyUntil < day) {
        const holder = members.get(book.setMember);
        if (holder) {
          holder.holds = holder.holds.filter((id) => id !== book.id);
        }
        const start = book.readyUntil + 1;
        if (book.queue.length > 0) {
          book.setMember = book.queue.shift();
          book.readyUntil = start + PICKUP_DAYS;
        } else {
          book.status = 'shelf';
          book.setMember = null;
          book.readyUntil = null;
        }
      }
    }
  }

  // Validates a dated call's date, enforces time order, updates the latest
  // date and runs expiry. Returns the day number, or null if rejected.
  function enter(date) {
    const day = parseDate(date);
    if (day === null) return null;
    if (latest !== null && day < latest) return null;
    latest = day;
    expire(day);
    return day;
  }

  return {
    addBook(arg) {
      const { bookId } = argsOf(arg);
      if (!isId(bookId) || books.has(bookId)) return { ok: false };
      books.set(bookId, {
        id: bookId,
        status: 'shelf',
        loanMember: null,
        setMember: null,
        readyUntil: null,
        queue: [],
      });
      return { ok: true };
    },

    addMember(arg) {
      const { memberId } = argsOf(arg);
      if (!isId(memberId) || members.has(memberId)) return { ok: false };
      members.set(memberId, {
        id: memberId,
        owed: 0,
        loans: [],
        holds: [],
      });
      return { ok: true };
    },

    borrow(arg) {
      const { memberId, bookId, date } = argsOf(arg);
      const day = enter(date);
      if (day === null) return { ok: false };
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return { ok: false };
      if (b.status === 'loan') return { ok: false };
      if (b.status === 'set' && b.setMember !== memberId) return { ok: false };
      if (b.status === 'shelf' && b.queue.length > 0) return { ok: false };
      if (m.loans.length >= MAX_LOANS) return { ok: false };
      if (m.owed >= BORROW_BLOCK_OWED) return { ok: false };

      if (b.status === 'set') {
        m.holds = m.holds.filter((id) => id !== bookId);
      }
      const dueDay = day + LOAN_DAYS;
      m.loans.push({ bookId, dueDay, renewals: 0 });
      b.status = 'loan';
      b.loanMember = memberId;
      b.setMember = null;
      b.readyUntil = null;
      return { ok: true, dueDate: formatDate(dueDay) };
    },

    returnBook(arg) {
      const { memberId, bookId, date } = argsOf(arg);
      const day = enter(date);
      if (day === null) return { ok: false };
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return { ok: false };
      if (b.status !== 'loan' || b.loanMember !== memberId) return { ok: false };
      const idx = m.loans.findIndex((l) => l.bookId === bookId);
      if (idx < 0) return { ok: false };

      const loan = m.loans[idx];
      const daysLate = Math.max(0, day - loan.dueDay - GRACE_DAYS);
      const fine = Math.min(daysLate * FINE_PER_DAY, MAX_FINE_PER_LOAN);
      m.owed += fine;
      m.loans.splice(idx, 1);

      b.loanMember = null;
      if (b.queue.length > 0) {
        b.status = 'set';
        b.setMember = b.queue.shift();
        b.readyUntil = day + PICKUP_DAYS;
      } else {
        b.status = 'shelf';
        b.setMember = null;
        b.readyUntil = null;
      }
      return { ok: true, fine };
    },

    renew(arg) {
      const { memberId, bookId, date } = argsOf(arg);
      const day = enter(date);
      if (day === null) return { ok: false };
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
      return { ok: true, dueDate: formatDate(loan.dueDay) };
    },

    placeHold(arg) {
      const { memberId, bookId, date } = argsOf(arg);
      const day = enter(date);
      if (day === null) return { ok: false };
      const m = members.get(memberId);
      const b = books.get(bookId);
      if (!m || !b) return { ok: false };
      if (b.status === 'shelf') return { ok: false };
      if (b.status === 'loan' && b.loanMember === memberId) return { ok: false };
      if (b.queue.includes(memberId)) return { ok: false };
      if (b.status === 'set' && b.setMember === memberId) return { ok: false };
      if (m.holds.length >= MAX_HOLDS) return { ok: false };

      b.queue.push(memberId);
      m.holds.push(bookId);
      const position = b.queue.length + (b.status === 'set' ? 1 : 0);
      return { ok: true, position };
    },

    payFine(arg) {
      const { memberId, amount, date } = argsOf(arg);
      const day = enter(date);
      if (day === null) return { ok: false };
      const m = members.get(memberId);
      if (!m) return { ok: false };
      if (!Number.isInteger(amount) || amount <= 0) return { ok: false };
      if (amount > m.owed) return { ok: false };

      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },

    getMember(arg) {
      const { memberId, date } = argsOf(arg);
      const day = enter(date);
      if (day === null) return { ok: false };
      const m = members.get(memberId);
      if (!m) return { ok: false };

      const loans = m.loans.map((l) => ({
        bookId: l.bookId,
        dueDate: formatDate(l.dueDay),
      }));

      const holds = m.holds.map((id) => {
        const b = books.get(id);
        if (b.status === 'set' && b.setMember === memberId) {
          return { bookId: id, position: 1, readyUntil: formatDate(b.readyUntil) };
        }
        const idx = b.queue.indexOf(memberId);
        const position = idx + 1 + (b.status === 'set' ? 1 : 0);
        return { bookId: id, position, readyUntil: null };
      });

      return { loans, owed: m.owed, holds };
    },
  };
}
