// Where a URL in plain or markdown text ends: never on a markdown delimiter (`**url**`, `` `url` ``,
// `[label](url)`) or sentence punctuation, but keeping balanced parentheses (`/Foo_(bar)`).
export const URL_PATTERN = /(?<![A-Za-z0-9])https?:\/\/[^\s<>"'`[\]]+/g;

export function trimUrl(url = '') {
  let end = url.length;
  for (;;) {
    const last = url[end - 1];
    const body = url.slice(0, end);
    if ('.,:!?*_~'.includes(last)) end -= 1;
    else if (last === ')' && body.split('(').length < body.split(')').length) end -= 1;
    else return body;
  }
}

// Telegram `url` entities (UTF-16 offsets, as JS strings index) for the links in text.
export function urlEntities(text = '') {
  return Array.from(String(text).matchAll(URL_PATTERN), (match) => ({
    type: 'url', offset: match.index, length: trimUrl(match[0]).length,
  }));
}
