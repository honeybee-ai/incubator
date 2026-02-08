// A small module with terrible variable names.
// Task: rename all single-letter variables to descriptive names.

function processData(d) {
  const r = [];
  const m = new Map();

  for (const x of d) {
    const k = x.id;
    const v = x.name.trim().toLowerCase();

    if (m.has(k)) {
      const e = m.get(k);
      e.count += 1;
      e.names.push(v);
    } else {
      m.set(k, { count: 1, names: [v] });
    }
  }

  for (const [k, v] of m.entries()) {
    if (v.count > 1) {
      r.push({ id: k, ...v });
    }
  }

  return r;
}

function formatOutput(a, s) {
  const t = s || ', ';
  const p = a.map(i => {
    const n = i.names.join(t);
    return `${i.id}: ${n} (${i.count}x)`;
  });
  return p.join('\n');
}

module.exports = { processData, formatOutput };
