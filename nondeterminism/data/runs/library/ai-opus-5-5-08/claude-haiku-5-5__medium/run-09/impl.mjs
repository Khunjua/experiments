const DAY_MS = 86400000;
const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const RENEW_DAYS = 21;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 2;
const FINE_CAP = 1000;
const MAX_LOANS = 5;
const DEBT_LIMIT = 1000;
const MAX_HOLDS = 5;
const PICKUP_DAYS = 7;

function isObj(x) {
  return x !== null && typeof x === 'object';
}

function isId(x) {
  return typeof x === 'string' && x.length > 0;
}

function isSafeAmount(x) {
  return Number.isSafeInteger(x) && x >= 1;
}

// Returns an integer day number (days since 1970-01-01 UTC), or null if invalid.
function parseDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return Math.round(t.getTime() / DAY_MS);
}

function formatDate(n) {
  const t = new Date(n * DAY_MS);
  const y = String(t.getUTCFullYear()).padStart(4, '0');
  const m = String(t.getUTCMonth() + 1).padStart(2, '0');
  const d = String(t.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function createLibrary() {
  // bookId -> { loanedTo: memberId|null, queue: [memberId], readyDay: number|null }
  const books = new Map();
  // memberId -> { loans: Map(bookId -> { dueDay, renewals }), owed: number, holds: [bookId] }
  const members = new Map();

  function guard(fn) {
    try {
      return fn();
    } catch {
      return { ok: false };
    }
  }

  function removeHold(member, bookId) {
    const i = member.holds.indexOf(bookId);
    if (i >= 0) member.holds.splice(i, 1);
  }

  // Hold expiration processing (section 3.5).
  function expire(day) {
    for (const [bookId, book] of books) {
      if (book.loanedTo !== null || book.queue.length === 0 || book.readyDay === null) continue;
      while (book.queue.length > 0 && book.readyDay !== null && day > book.readyDay) {
        const lost = book.queue.shift();
        const lostMember = members.get(lost);
        if (lostMember) removeHold(lostMember, bookId);
        if (book.queue.length > 0) {
          // start = previous readyUntil + 1; readyUntil = start + 7
          book.readyDay = book.readyDay + 1 + PICKUP_DAYS;
        } else {
          book.readyDay = null;
        }
      }
    }
  }

  // Validates the argument object and date, then runs expiration.
  // Returns the day number, or null if the call must fail without processing.
  function startDated(arg) {
    if (!isObj(arg)) return null;
    const day = parseDate(arg.date);
    if (day === null) return null;
    expire(day);
    return day;
  }

  return {
    addBook(arg) {
      return guard(() => {
        if (!isObj(arg) || !isId(arg.bookId) || books.has(arg.bookId)) return { ok: false };
        books.set(arg.bookId, { loanedTo: null, queue: [], readyDay: null });
        return { ok: true };
      });
    },

    addMember(arg) {
      return guard(() => {
        if (!isObj(arg) || !isId(arg.memberId) || members.has(arg.memberId)) return { ok: false };
        members.set(arg.memberId, { loans: new Map(), owed: 0, holds: [] });
        return { ok: true };
      });
    },

    borrow(arg) {
      return guard(() => {
        const day = startDated(arg);
        if (day === null) return { ok: false };
        const { memberId, bookId } = arg;
        if (!isId(memberId) || !isId(bookId)) return { ok: false };
        const member = members.get(memberId);
        const book = books.get(bookId);
        if (!member || !book) return { ok: false };

        if (book.loanedTo !== null) return { ok: false };
        if (book.queue.length > 0) {
          if (book.readyDay === null) return { ok: false };
          if (book.queue[0] !== memberId) return { ok: false };
        }
        if (member.loans.size >= MAX_LOANS) return { ok: false };
        if (member.owed >= DEBT_LIMIT) return { ok: false };
        for (const loan of member.loans.values()) {
          if (loan.dueDay < day) return { ok: false };
        }

        const dueDay = day + LOAN_DAYS;
        member.loans.set(bookId, { dueDay, renewals: 0 });
        if (book.queue.length > 0) {
          book.queue.shift();
          removeHold(member, bookId);
          book.readyDay = null;
        }
        book.loanedTo = memberId;
        return { ok: true, dueDate: formatDate(dueDay) };
      });
    },

    returnBook(arg) {
      return guard(() => {
        const day = startDated(arg);
        if (day === null) return { ok: false };
        const { memberId, bookId } = arg;
        if (!isId(memberId) || !isId(bookId)) return { ok: false };
        const member = members.get(memberId);
        const book = books.get(bookId);
        if (!member || !book) return { ok: false };
        if (book.loanedTo !== memberId) return { ok: false };
        const loan = member.loans.get(bookId);
        if (!loan) return { ok: false };

        const daysLate = Math.max(0, day - loan.dueDay);
        const chargeable = Math.max(0, daysLate - GRACE_DAYS);
        const fine = Math.min(chargeable * FINE_PER_DAY, FINE_CAP);

        member.owed += fine;
        member.loans.delete(bookId);
        book.loanedTo = null;
        if (book.queue.length > 0) {
          book.readyDay = day + PICKUP_DAYS;
        } else {
          book.readyDay = null;
        }
        return { ok: true, fine };
      });
    },

    renew(arg) {
      return guard(() => {
        const day = startDated(arg);
        if (day === null) return { ok: false };
        const { memberId, bookId } = arg;
        if (!isId(memberId) || !isId(bookId)) return { ok: false };
        const member = members.get(memberId);
        const book = books.get(bookId);
        if (!member || !book) return { ok: false };
        if (book.loanedTo !== memberId) return { ok: false };
        const loan = member.loans.get(bookId);
        if (!loan) return { ok: false };
        if (loan.renewals >= MAX_RENEWALS) return { ok: false };
        if (day > loan.dueDay) return { ok: false };
        if (book.queue.length > 0) return { ok: false };

        loan.dueDay += RENEW_DAYS;
        loan.renewals += 1;
        return { ok: true, dueDate: formatDate(loan.dueDay) };
      });
    },

    placeHold(arg) {
      return guard(() => {
        const day = startDated(arg);
        if (day === null) return { ok: false };
        const { memberId, bookId } = arg;
        if (!isId(memberId) || !isId(bookId)) return { ok: false };
        const member = members.get(memberId);
        const book = books.get(bookId);
        if (!member || !book) return { ok: false };

        // On shelf: nothing to wait for.
        if (book.loanedTo === null && book.queue.length === 0) return { ok: false };
        if (book.loanedTo === memberId) return { ok: false };
        if (member.loans.has(bookId)) return { ok: false };
        if (book.queue.includes(memberId)) return { ok: false };
        if (member.holds.length >= MAX_HOLDS) return { ok: false };

        book.queue.push(memberId);
        member.holds.push(bookId);
        return { ok: true, position: book.queue.length };
      });
    },

    payFine(arg) {
      return guard(() => {
        const day = startDated(arg);
        if (day === null) return { ok: false };
        const { memberId, amount } = arg;
        if (!isId(memberId)) return { ok: false };
        const member = members.get(memberId);
        if (!member) return { ok: false };
        if (!isSafeAmount(amount)) return { ok: false };
        if (amount > member.owed) return { ok: false };

        member.owed -= amount;
        return { ok: true, owed: member.owed };
      });
    },

    getMember(arg) {
      return guard(() => {
        const day = startDated(arg);
        if (day === null) return { ok: false };
        const { memberId } = arg;
        if (!isId(memberId)) return { ok: false };
        const member = members.get(memberId);
        if (!member) return { ok: false };

        const loans = [...member.loans]
          .map(([bookId, loan]) => ({ bookId, dueDay: loan.dueDay }))
          .sort((a, b) => {
            if (a.dueDay !== b.dueDay) return a.dueDay - b.dueDay;
            if (a.bookId < b.bookId) return -1;
            if (a.bookId > b.bookId) return 1;
            return 0;
          })
          .map(({ bookId, dueDay }) => ({ bookId, dueDate: formatDate(dueDay) }));

        const holds = member.holds.map((bookId) => {
          const book = books.get(bookId);
          const position = book.queue.indexOf(memberId) + 1;
          const setAside = book.loanedTo === null && position === 1 && book.readyDay !== null;
          return {
            bookId,
            position,
            readyUntil: setAside ? formatDate(book.readyDay) : null,
          };
        });

        return { ok: true, loans, owed: member.owed, holds };
      });
    },
  };
}
