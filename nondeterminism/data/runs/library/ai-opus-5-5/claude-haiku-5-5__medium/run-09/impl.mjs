const DAY_MS = 86400000;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const LOAN_DAYS = 21;
const MAX_RENEWALS = 2;
const FINE_PER_DAY = 25;
const GRACE_DAYS = 2;
const FINE_CAP = 500;
const MAX_LOANS = 5;
const BLOCK_OWED = 1000;
const MAX_HOLDS = 5;
const PICKUP_DAYS = 7;

// Returns the day number (days since 1970-01-01, UTC) or null if invalid.
function parseDate(s) {
  if (typeof s !== 'string') return null;
  const m = DATE_RE.exec(s);
  if (m === null) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const t = new Date(0);
  t.setUTCFullYear(y, mo - 1, d);
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) {
    return null;
  }
  return Math.round(t.getTime() / DAY_MS);
}

function formatDay(n) {
  const t = new Date(n * DAY_MS);
  const y = String(t.getUTCFullYear()).padStart(4, '0');
  const mo = String(t.getUTCMonth() + 1).padStart(2, '0');
  const d = String(t.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${d}`;
}

const MIN_DAY = parseDate('0001-01-01');
const MAX_DAY = parseDate('9999-12-31');

// Returns n + k, or null if the result is outside 0001-01-01..9999-12-31.
function addDays(n, k) {
  const r = n + k;
  if (r < MIN_DAY || r > MAX_DAY) return null;
  return r;
}

export function createLibrary() {
  const books = new Map();
  const members = new Map();
  let today = null;
  let holdSeq = 0;

  const fail = () => ({ ok: false });
  const isObj = (v) => v !== null && typeof v === 'object';
  const validId = (v) => typeof v === 'string' && v.length > 0;

  // Validates a date argument against the clock. Returns the day or null.
  function checkDate(v) {
    const day = parseDate(v);
    if (day === null) return null;
    if (today !== null && day < today) return null;
    return day;
  }

  // Validates memberId (and bookId if requested) plus date. Returns the day or null.
  function readDated(args, needBook) {
    if (!isObj(args) || !validId(args.memberId)) return null;
    if (needBook && !validId(args.bookId)) return null;
    return checkDate(args.date);
  }

  function expire(day) {
    for (const b of books.values()) {
      while (b.status === 'shelf' && day > b.readyUntil) {
        b.holds.shift();
        if (b.holds.length === 0) {
          b.status = 'available';
          b.readyUntil = null;
        } else {
          const next = addDays(b.readyUntil, PICKUP_DAYS + 1);
          if (next === null) {
            // Cannot schedule beyond the last representable date.
            b.holds.length = 0;
            b.status = 'available';
            b.readyUntil = null;
          } else {
            b.readyUntil = next;
          }
        }
      }
    }
  }

  function tick(day) {
    today = day;
    expire(day);
  }

  function activeHoldCount(memberId) {
    let n = 0;
    for (const b of books.values()) {
      for (const h of b.holds) {
        if (h.memberId === memberId) n++;
      }
    }
    return n;
  }

  return {
    addBook(args) {
      if (!isObj(args) || !validId(args.bookId) || books.has(args.bookId)) return fail();
      books.set(args.bookId, {
        id: args.bookId,
        status: 'available',
        loanMember: null,
        holds: [],
        readyUntil: null,
      });
      return { ok: true };
    },

    addMember(args) {
      if (!isObj(args) || !validId(args.memberId) || members.has(args.memberId)) return fail();
      members.set(args.memberId, { id: args.memberId, owed: 0, loans: new Map() });
      return { ok: true };
    },

    borrow(args) {
      const day = readDated(args, true);
      if (day === null) return fail();
      tick(day);
      const m = members.get(args.memberId);
      const b = books.get(args.bookId);
      if (!m || !b) return fail();
      if (b.status === 'loan') return fail();
      if (b.status === 'shelf' && b.holds[0].memberId !== m.id) return fail();
      if (m.loans.size >= MAX_LOANS) return fail();
      for (const loan of m.loans.values()) {
        if (loan.dueDate < day) return fail();
      }
      if (m.owed >= BLOCK_OWED) return fail();
      const due = addDays(day, LOAN_DAYS);
      if (due === null) return fail();

      if (b.status === 'shelf') b.holds.shift();
      b.status = 'loan';
      b.loanMember = m.id;
      b.readyUntil = null;
      m.loans.set(b.id, { dueDate: due, renewals: 0 });
      return { ok: true, dueDate: formatDay(due) };
    },

    returnBook(args) {
      const day = readDated(args, true);
      if (day === null) return fail();
      tick(day);
      const m = members.get(args.memberId);
      const b = books.get(args.bookId);
      if (!m || !b) return fail();
      if (b.status !== 'loan' || b.loanMember !== m.id) return fail();

      const loan = m.loans.get(b.id);
      const late = Math.max(0, day - loan.dueDate);
      const fine = Math.min(FINE_CAP, FINE_PER_DAY * Math.max(0, late - GRACE_DAYS));

      let ready = null;
      if (b.holds.length > 0) {
        ready = addDays(day, PICKUP_DAYS);
        if (ready === null) return fail();
      }

      m.owed += fine;
      m.loans.delete(b.id);
      b.loanMember = null;
      if (b.holds.length === 0) {
        b.status = 'available';
        b.readyUntil = null;
      } else {
        b.status = 'shelf';
        b.readyUntil = ready;
      }
      return { ok: true, fine };
    },

    renew(args) {
      const day = readDated(args, true);
      if (day === null) return fail();
      tick(day);
      const m = members.get(args.memberId);
      const b = books.get(args.bookId);
      if (!m || !b) return fail();
      if (b.status !== 'loan' || b.loanMember !== m.id) return fail();

      const loan = m.loans.get(b.id);
      if (loan.renewals >= MAX_RENEWALS) return fail();
      if (day > loan.dueDate) return fail();
      if (b.holds.length > 0) return fail();
      const due = addDays(day, LOAN_DAYS);
      if (due === null) return fail();

      loan.renewals += 1;
      loan.dueDate = due;
      return { ok: true, dueDate: formatDay(due) };
    },

    placeHold(args) {
      const day = readDated(args, true);
      if (day === null) return fail();
      tick(day);
      const m = members.get(args.memberId);
      const b = books.get(args.bookId);
      if (!m || !b) return fail();
      if (b.status === 'available') return fail();
      if (b.status === 'loan' && b.loanMember === m.id) return fail();
      if (m.loans.has(b.id)) return fail();
      if (b.holds.some((h) => h.memberId === m.id)) return fail();
      if (activeHoldCount(m.id) >= MAX_HOLDS) return fail();

      b.holds.push({ memberId: m.id, seq: ++holdSeq });
      return { ok: true, position: b.holds.length };
    },

    payFine(args) {
      if (
        !isObj(args) ||
        !validId(args.memberId) ||
        !Number.isSafeInteger(args.amount) ||
        args.amount <= 0
      ) {
        return fail();
      }
      const day = checkDate(args.date);
      if (day === null) return fail();
      tick(day);
      const m = members.get(args.memberId);
      if (!m) return fail();
      if (args.amount > m.owed) return fail();

      m.owed -= args.amount;
      return { ok: true, owed: m.owed };
    },

    getMember(args) {
      const day = readDated(args, false);
      if (day === null) return fail();
      tick(day);
      const m = members.get(args.memberId);
      if (!m) return fail();

      const loans = [];
      for (const [bookId, loan] of m.loans) {
        loans.push({ bookId, dueDate: formatDay(loan.dueDate) });
      }

      const found = [];
      for (const b of books.values()) {
        b.holds.forEach((h, i) => {
          if (h.memberId === m.id) {
            const isReady = i === 0 && b.status === 'shelf';
            found.push({
              seq: h.seq,
              bookId: b.id,
              position: i + 1,
              readyUntil: isReady ? formatDay(b.readyUntil) : null,
            });
          }
        });
      }
      found.sort((x, y) => x.seq - y.seq);
      const holds = found.map((h) => ({
        bookId: h.bookId,
        position: h.position,
        readyUntil: h.readyUntil,
      }));

      return { ok: true, loans, owed: m.owed, holds };
    },
  };
}
