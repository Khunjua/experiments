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

function isLeap(y) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y, mo) {
  const table = [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return table[mo - 1];
}

function dayNumber(y, mo, d) {
  const dt = new Date(0);
  dt.setUTCFullYear(y, mo - 1, d);
  return Math.round(dt.getTime() / MS_PER_DAY);
}

// Returns a day number, or null if the string is not a valid YYYY-MM-DD date.
function parseDate(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1 || mo < 1 || mo > 12 || d < 1) return null;
  if (d > daysInMonth(y, mo)) return null;
  return dayNumber(y, mo, d);
}

function formatDay(n) {
  const dt = new Date(n * MS_PER_DAY);
  const y = String(dt.getUTCFullYear()).padStart(4, '0');
  const mo = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${d}`;
}

function isValidId(v) {
  return typeof v === 'string' && v.length > 0;
}

function args(o) {
  return o !== null && typeof o === 'object' ? o : {};
}

export function createLibrary() {
  const books = new Map();
  const members = new Map();
  let latest = null;

  const no = () => ({ ok: false });

  // Expiry processing up to day `today` (see requirements §6.4).
  function expire(today) {
    for (const book of books.values()) {
      while (book.status === 'set' && book.readyUntil < today) {
        const holder = members.get(book.setFor);
        if (holder) {
          holder.holds = holder.holds.filter((id) => id !== book.id);
        }
        const start = book.readyUntil + 1;
        if (book.queue.length > 0) {
          book.setFor = book.queue.shift();
          book.readyUntil = start + PICKUP_DAYS;
        } else {
          book.status = 'shelf';
          book.setFor = null;
          book.readyUntil = null;
        }
      }
    }
  }

  // Handles the time step for a dated call. Returns the day number, or null
  // if the date is invalid or earlier than the latest date seen.
  function admit(dateStr) {
    const day = parseDate(dateStr);
    if (day === null) return null;
    if (latest !== null && day < latest) return null;
    latest = day;
    expire(day);
    return day;
  }

  function findMember(id) {
    return isValidId(id) ? members.get(id) : undefined;
  }

  function findBook(id) {
    return isValidId(id) ? books.get(id) : undefined;
  }

  return {
    addBook(input) {
      const { bookId } = args(input);
      if (!isValidId(bookId) || books.has(bookId)) return no();
      books.set(bookId, {
        id: bookId,
        status: 'shelf',
        loan: null,
        setFor: null,
        readyUntil: null,
        queue: [],
      });
      return { ok: true };
    },

    addMember(input) {
      const { memberId } = args(input);
      if (!isValidId(memberId) || members.has(memberId)) return no();
      members.set(memberId, {
        id: memberId,
        owed: 0,
        loans: [],
        holds: [],
      });
      return { ok: true };
    },

    borrow(input) {
      const a = args(input);
      const day = admit(a.date);
      if (day === null) return no();
      const m = findMember(a.memberId);
      const b = findBook(a.bookId);
      if (!m || !b) return no();
      if (b.status === 'loan') return no();
      if (b.status === 'set' && b.setFor !== m.id) return no();
      if (b.status === 'shelf' && b.queue.length > 0) return no();
      if (m.loans.length >= MAX_LOANS) return no();
      if (m.owed >= BORROW_BLOCK_OWED) return no();

      if (b.status === 'set') {
        // The set-aside hold for this member is consumed.
        m.holds = m.holds.filter((id) => id !== b.id);
        b.setFor = null;
        b.readyUntil = null;
      }

      const loan = {
        bookId: b.id,
        memberId: m.id,
        dueDate: day + LOAN_DAYS,
        renewals: 0,
      };
      m.loans.push(loan);
      b.loan = loan;
      b.status = 'loan';
      return { ok: true, dueDate: formatDay(loan.dueDate) };
    },

    returnBook(input) {
      const a = args(input);
      const day = admit(a.date);
      if (day === null) return no();
      const m = findMember(a.memberId);
      const b = findBook(a.bookId);
      if (!m || !b) return no();
      if (b.status !== 'loan' || b.loan.memberId !== m.id) return no();

      const loan = b.loan;
      const daysLate = Math.max(0, day - loan.dueDate - GRACE_DAYS);
      const fine = Math.min(daysLate * FINE_PER_DAY, MAX_FINE_PER_LOAN);
      m.owed += fine;
      m.loans = m.loans.filter((l) => l !== loan);
      b.loan = null;

      if (b.queue.length > 0) {
        b.status = 'set';
        b.setFor = b.queue.shift();
        b.readyUntil = day + PICKUP_DAYS;
      } else {
        b.status = 'shelf';
      }
      return { ok: true, fine };
    },

    renew(input) {
      const a = args(input);
      const day = admit(a.date);
      if (day === null) return no();
      const m = findMember(a.memberId);
      const b = findBook(a.bookId);
      if (!m || !b) return no();
      if (b.status !== 'loan' || b.loan.memberId !== m.id) return no();

      const loan = b.loan;
      if (loan.renewals >= MAX_RENEWALS) return no();
      if (day > loan.dueDate) return no();
      if (b.queue.length > 0) return no();

      loan.dueDate = day + LOAN_DAYS;
      loan.renewals += 1;
      return { ok: true, dueDate: formatDay(loan.dueDate) };
    },

    placeHold(input) {
      const a = args(input);
      const day = admit(a.date);
      if (day === null) return no();
      const m = findMember(a.memberId);
      const b = findBook(a.bookId);
      if (!m || !b) return no();
      if (b.status === 'shelf') return no();
      if (b.status === 'loan' && b.loan.memberId === m.id) return no();
      if (b.queue.includes(m.id)) return no();
      if (b.status === 'set' && b.setFor === m.id) return no();
      if (m.holds.length >= MAX_HOLDS) return no();

      b.queue.push(m.id);
      m.holds.push(b.id);
      const position = b.queue.length + (b.status === 'set' ? 1 : 0);
      return { ok: true, position };
    },

    payFine(input) {
      const a = args(input);
      const day = admit(a.date);
      if (day === null) return no();
      const m = findMember(a.memberId);
      if (!m) return no();
      const amount = a.amount;
      if (!Number.isInteger(amount) || amount <= 0) return no();
      if (amount > m.owed) return no();

      m.owed -= amount;
      return { ok: true, owed: m.owed };
    },

    getMember(input) {
      const a = args(input);
      const day = admit(a.date);
      if (day === null) return no();
      const m = findMember(a.memberId);
      if (!m) return no();

      const loans = m.loans.map((l) => ({
        bookId: l.bookId,
        dueDate: formatDay(l.dueDate),
      }));

      const holds = m.holds.map((bookId) => {
        const b = books.get(bookId);
        if (b.status === 'set' && b.setFor === m.id) {
          return {
            bookId,
            position: 1,
            readyUntil: formatDay(b.readyUntil),
          };
        }
        const index = b.queue.indexOf(m.id) + 1;
        return {
          bookId,
          position: index + (b.status === 'set' ? 1 : 0),
          readyUntil: null,
        };
      });

      return { loans, owed: m.owed, holds };
    },
  };
}
