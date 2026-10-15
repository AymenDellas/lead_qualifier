// Models sometimes wrap an otherwise valid structured response in prose or a
// Markdown fence. Extract only a complete JSON object; never repair partial JSON.
export function parseModelObject(message) {
  const text = String(message || '').trim().replace(/^\uFEFF/, '');
  const fenced = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  const candidates = fenced ? [fenced[1], text] : [text];

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    } catch { /* Try to locate a complete object below. */ }
  }

  let start = -1;
  let depth = 0;
  let brackets = 0;
  let quoted = false;
  let escaped = false;
  let largest = null;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === '{') {
      if (depth === 0) start = index;
      depth++;
    } else if (char === '[' && depth > 0) {
      brackets++;
    } else if (char === ']' && depth > 0) {
      brackets--;
    } else if (char === '}' && depth > 0) {
      depth--;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(text.slice(start, index + 1));
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && (!largest || index + 1 - start > largest.length)) largest = { parsed, length:index + 1 - start };
        } catch { /* A later complete object may be valid. */ }
      }
    }
  }
  if (largest) return largest.parsed;
  throw new Error(depth > 0 || brackets > 0 ? 'incomplete' : 'not an object');
}

