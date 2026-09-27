export function shellQuote(value) {
  const text = String(value ?? '');
  if (text.length === 0) return "''";
  return `'${text.replaceAll("'", "'\\''")}'`;
}

export function shellEscape(value) {
  return `'${String(value ?? '').replace(/'/g, `'\"'\"'`)}'`;
}
