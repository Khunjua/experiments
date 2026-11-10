const DAY_MS = 86400000;
const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const RENEWAL_DAYS = 21;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 2;
const FINE_CAP = 1000;
const MAX_LOANS = 5;
const DEBT_LIMIT = 1000;
const MAX_HOLDS = 5;
const PICKUP_DAYS = 7;

export function createLibrary() {
  // books: bookId -> { onLoanTo: memberId|null, queue: [memberId], readyUntil: dayNumber|null }
  // members: memberId -> { loans: Map(bookId -> { dueDate, renewals }), owed, holds: [bookId] }
  // Book state: on loan if onLoanTo !== null; set aside if readyUntil !== null; otherwise on shelf.
  const books = new Map();
  const members = new Map();

  const isObj = (a) => a !== null && typeof a === 'object';
  const isId = (x) => typeof x === 'string' && x.length > 0;
  const fail = () => ({ ok: false });

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

  function formatDay(n) {
    const t = new Date(n * DAY_MS);
    const y = String(t.getUTCFullYear()).padStart(4, '0');
    const m = String(t.getUTCMonth() + 1).padStart(2, '0');
    const d = String(t.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function readDay(args) {
    if (!isObj(args)) return null;
    return parseDate(args.date);
  }

  function removeHold(member, bookId) {
    const i = member.holds.indexOf(bookId);
    if (i >= 0) member.holds.splice(i, 1);
  }

  // Time processing (section 3.5): applies to all books up to `today`.
  function expire(today) {
    for (const [bookId, book] of books) {
      while (book.readyUntil !== null && today > book.readyUntil) {
        const firstId = book.queue.shift();
        const member = members.get(firstId);
        if (member) removeHold(member, bookId);
        book.readyUntil = book.queue.length > 0 ? book.readyUntil + PICKUP_DAYS + 1 : null;
      }
    }
  }

  return {
    addBook(args) {
      try {
        if (!isObj(args)) return fail();
        const bookId = args.bookId;
        if (!isId(bookId) || books.has(bookId)) return fail();
        books.set(bookId, { onLoanTo: null, queue: [], readyUntil: null });
        return { ok: true };
      } catch {
        return fail();
      }
    },

    addMember(args) {
      try {
        if (!isObj(args)) return fail();
        const memberId = args.memberId;
        if (!isId(memberId) || members.has(memberId)) return fail();
        members.set(memberId, { loans: new Map(), owed: 0, holds: [] });
        return { ok: true };
      } catch {
        return fail();
      }
    },

    borrow(args) {
      try {
        const day = readDay(args);
        if (day === null) return fail();
        const { memberId, bookId } = args;
        expire(day);
        const m = isId(memberId) ? members.get(memberId) : undefined;
        const b = isId(bookId) ? books.get(bookId) : undefined;
        if (!m || !b) return fail();
        if (b.onLoanTo !== null) return fail();
        if (b.readyUntil !== null) {
          if (b.queue[0] !== memberId) return fail();
        } else if (b.queue.length > 0) {
          return fail();
        }
        if (m.loans.size >= MAX_LOANS) return fail();
        if (m.owed >= DEBT_LIMIT) return fail();
        for (const loan of m.loans.values()) {
          if (loan.dueDate < day) return fail();
        }
        const dueDate = day + LOAN_DAYS;
        m.loans.set(bookId, { dueDate, renewals: 0 });
        if (b.readyUntil !== null) {
          b.queue.shift();
          removeHold(m, bookId);
          b.readyUntil = null;
        }
        b.onLoanTo = memberId;
        return { ok: true, dueDate: formatDay(dueDate) };
      } catch {
        return fail();
      }
    },

    returnBook(args) {
      try {
        const day = readDay(args);
        if (day === null) return fail();
        const { memberId, bookId } = args;
        expire(day);
        const m = isId(memberId) ? members.get(memberId) : undefined;
        const b = isId(bookId) ? books.get(bookId) : undefined;
        if (!m || !b) return fail();
        const loan = m.loans.get(bookId);
        if (!loan || b.onLoanTo !== memberId) return fail();

        const daysLate = Math.max(0, day - loan.dueDate);
        const chargeable = Math.max(0, daysLate - GRACE_DAYS);
        const fine = Math.min(chargeable * FINE_PER_DAY, FINE_CAP);

        m.owed += fine;
        m.loans.delete(bookId);
        b.onLoanTo = null;
        b.readyUntil = b.queue.length > 0 ? day + PICKUP_DAYS : null;
        return { ok: true, fine };
      } catch {
        return fail();
      }
    },

    renew(args) {
      try {
        const day = readDay(args);
        if (day === null) return fail();
        const { memberId, bookId } = args;
        expire(day);
        const m = isId(memberId) ? members.get(memberId) : undefined;
        const b = isId(bookId) ? books.get(bookId) : undefined;
        if (!m || !b) return fail();
        const loan = m.loans.get(bookId);
        if (!loan || b.onLoanTo !== memberId) return fail();
        if (loan.renewals >= MAX_RENEWALS) return fail();
        if (day > loan.dueDate) return fail();
        if (b.queue.length > 0) return fail();
        loan.dueDate += RENEWAL_DAYS;
        loan.renewals += 1;
        return { ok: true, dueDate: formatDay(loan.dueDate) };
      } catch {
        return fail();
      }
    },

    placeHold(args) {
      try {
        const day = readDay(args);
        if (day === null) return fail();
        const { memberId, bookId } = args;
        expire(day);
        const m = isId(memberId) ? members.get(memberId) : undefined;
        const b = isId(bookId) ? books.get(bookId) : undefined;
        if (!m || !b) return fail();
        const onShelf = b.onLoanTo === null && b.readyUntil === null;
        if (onShelf) return fail();
        if (m.loans.has(bookId)) return fail();
        if (m.holds.includes(bookId)) return fail();
        if (m.holds.length >= MAX_HOLDS) return fail();
        b.queue.push(memberId);
        m.holds.push(bookId);
        return { ok: true, position: b.queue.length };
      } catch {
        return fail();
      }
    },

    payFine(args) {
      try {
        const day = readDay(args);
        if (day === null) return fail();
        const { memberId, amount } = args;
        expire(day);
        const m = isId(memberId) ? members.get(memberId) : undefined;
        if (!m) return fail();
        if (!Number.isSafeInteger(amount) || amount < 1) return fail();
        if (amount > m.owed) return fail();
        m.owed -= amount;
        return { ok: true, owed: m.owed };
      } catch {
        return fail();
      }
    },

    getMember(args) {
      try {
        const day = readDay(args);
        if (day === null) return fail();
        const { memberId } = args;
        expire(day);
        const m = isId(memberId) ? members.get(memberId) : undefined;
        if (!m) return fail();

        const loanList = [];
        for (const [bookId, loan] of m.loans) {
          loanList.push({ bookId, due: loan.dueDate });
        }
        loanList.sort((x, y) => {
          if (x.due !== y.due) return x.due - y.due;
          if (x.bookId < y.bookId) return -1;
          if (x.bookId > y.bookId) return 1;
          return 0;
        });
        const loans = loanList.map((l) => ({ bookId: l.bookId, dueDate: formatDay(l.due) }));

        const holds = m.holds.map((bookId) => {
          const b = books.get(bookId);
          const position = b.queue.indexOf(memberId) + 1;
          const setAsideForMember = position === 1 && b.readyUntil !== null;
          return {
            bookId,
            position,
            readyUntil: setAsideForMember ? formatDay(b.readyUntil) : null,
          };
        });

        return { ok: true, loans, owed: m.owed, holds };
      } catch {
        return fail();
      }
    },
  };
}
