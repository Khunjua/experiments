export function createLibrary() {
  const books = new Map();
  const members = new Map();
  let current = null;

  const validId = (s) => typeof s === "string" && s.length > 0;

  function parseDate(s) {
    if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    const y = +s.slice(0, 4), m = +s.slice(5, 7), d = +s.slice(8, 10);
    if (y < 1) return null;
    const dt = new Date(0);
    dt.setUTCFullYear(y, m - 1, d);
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
    return Math.round(dt.getTime() / 86400000);
  }
  function fmt(days) {
    const dt = new Date(days * 86400000);
    const y = String(dt.getUTCFullYear()).padStart(4, "0");
    const m = String(dt.getUTCMonth() + 1).padStart(2, "0");
    const d = String(dt.getUTCDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }
  const addDays = (s, n) => fmt(parseDate(s) + n);

  const fail = (reason) => ({ ok: false, reason });

  function removeFrom(arr, v) {
    const i = arr.indexOf(v);
    if (i >= 0) arr.splice(i, 1);
  }

  // Returns false if the call must fail (invalid date / earlier than current).
  function tick(date) {
    const n = parseDate(date);
    if (n === null) return false;
    if (current !== null && n < current) return false;
    current = n;
    for (const b of books.values()) {
      while (b.state === "aside" && n > parseDate(b.readyUntil)) {
        const mid = b.queue.shift();
        removeFrom(members.get(mid).holds, b.id);
        if (b.queue.length > 0) {
          b.readyUntil = addDays(b.readyUntil, 8);
        } else {
          b.state = "available";
          b.readyUntil = null;
        }
      }
    }
    return true;
  }

  function prep(args, needBook, needMember = true) {
    if (args === null || typeof args !== "object") return null;
    if (!tick(args.date)) return null;
    let m = null, b = null;
    if (needMember) {
      if (!validId(args.memberId)) return null;
      m = members.get(args.memberId);
      if (!m) return null;
    }
    if (needBook) {
      if (!validId(args.bookId)) return null;
      b = books.get(args.bookId);
      if (!b) return null;
    }
    return { m, b };
  }

  return {
    addBook(args) {
      if (args === null || typeof args !== "object") return fail("invalid");
      const id = args.bookId;
      if (!validId(id) || books.has(id)) return fail("invalid");
      books.set(id, { id, state: "available", queue: [], readyUntil: null, loan: null });
      return { ok: true };
    },
    addMember(args) {
      if (args === null || typeof args !== "object") return fail("invalid");
      const id = args.memberId;
      if (!validId(id) || members.has(id)) return fail("invalid");
      members.set(id, { id, loans: [], holds: [], owed: 0 });
      return { ok: true };
    },
    borrow(args) {
      const p = prep(args, true);
      if (!p) return fail("invalid");
      const { m, b } = p;
      const date = args.date;
      if (b.state === "loan") return fail("on loan");
      if (b.state === "aside" && b.queue[0] !== m.id) return fail("set aside");
      if (m.loans.length >= 5) return fail("limit");
      if (m.owed >= 1000) return fail("owed");
      const dn = parseDate(date);
      for (const id of m.loans) {
        if (parseDate(books.get(id).loan.dueDate) < dn) return fail("overdue");
      }
      if (b.state === "aside") {
        b.queue.shift();
        removeFrom(m.holds, b.id);
        b.readyUntil = null;
      }
      const dueDate = addDays(date, 21);
      b.state = "loan";
      b.loan = { memberId: m.id, dueDate, renewals: 0 };
      m.loans.push(b.id);
      return { ok: true, dueDate };
    },
    returnBook(args) {
      const p = prep(args, true);
      if (!p) return fail("invalid");
      const { m, b } = p;
      if (b.state !== "loan" || b.loan.memberId !== m.id) return fail("not loaned");
      const late = Math.max(0, parseDate(args.date) - parseDate(b.loan.dueDate));
      const fine = Math.min(500, 25 * Math.max(0, late - 2));
      m.owed += fine;
      removeFrom(m.loans, b.id);
      b.loan = null;
      if (b.queue.length === 0) {
        b.state = "available";
        b.readyUntil = null;
      } else {
        b.state = "aside";
        b.readyUntil = addDays(args.date, 7);
      }
      return { ok: true, fine };
    },
    renew(args) {
      const p = prep(args, true);
      if (!p) return fail("invalid");
      const { m, b } = p;
      if (b.state !== "loan" || b.loan.memberId !== m.id) return fail("not loaned");
      if (b.loan.renewals >= 2) return fail("max renewals");
      if (parseDate(args.date) > parseDate(b.loan.dueDate)) return fail("overdue");
      if (b.queue.length > 0) return fail("holds");
      b.loan.dueDate = addDays(args.date, 21);
      b.loan.renewals++;
      return { ok: true, dueDate: b.loan.dueDate };
    },
    placeHold(args) {
      const p = prep(args, true);
      if (!p) return fail("invalid");
      const { m, b } = p;
      if (b.state === "available") return fail("available");
      if (b.state === "loan" && b.loan.memberId === m.id) return fail("own loan");
      if (b.queue.includes(m.id)) return fail("duplicate");
      if (m.holds.length >= 5) return fail("limit");
      b.queue.push(m.id);
      m.holds.push(b.id);
      return { ok: true, position: b.queue.length };
    },
    payFine(args) {
      const p = prep(args, false);
      if (!p) return fail("invalid");
      const { m } = p;
      const a = args.amount;
      if (!Number.isSafeInteger(a) || a <= 0) return fail("amount");
      if (a > m.owed) return fail("overpay");
      m.owed -= a;
      return { ok: true, owed: m.owed };
    },
    getMember(args) {
      const p = prep(args, false);
      if (!p) return fail("invalid");
      const { m } = p;
      return {
        ok: true,
        loans: m.loans.map((id) => ({ bookId: id, dueDate: books.get(id).loan.dueDate })),
        owed: m.owed,
        holds: m.holds.map((id) => {
          const b = books.get(id);
          const i = b.queue.indexOf(m.id);
          return {
            bookId: id,
            position: i + 1,
            readyUntil: b.state === "aside" && i === 0 ? b.readyUntil : null,
          };
        }),
      };
    },
  };
}
