/** Drop only the gateway's non-chat bookkeeping frames. Never suppress error events.
 * @param {string} frame
 * @returns {string}
 */
export function normalizeFrame(frame) {
  const data = frame
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trim())
    .join('\n');
  if (!data || data === '[DONE]') return frame + '\n\n';
  try {
    const value = JSON.parse(data);
    if (value === null || value?.object === 'billing.summary') return '';
  } catch {
    /* Keep malformed data visible to the client instead of hiding a provider error. */
  }
  return frame + '\n\n';
}

/** @param {ReadableStream<Uint8Array>} body @returns {ReadableStream<Uint8Array>} */
export function normalizeStream(body) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';
  return body.pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        buffer = (buffer + decoder.decode(chunk, { stream: true })).replace(/\r\n/g, '\n');
        if (buffer.length > 2_000_000) throw new Error('The provider returned an oversized event.');
        let end;
        while ((end = buffer.indexOf('\n\n')) !== -1) {
          const normalized = normalizeFrame(buffer.slice(0, end));
          buffer = buffer.slice(end + 2);
          if (normalized) controller.enqueue(encoder.encode(normalized));
        }
      },
      flush(controller) {
        buffer += decoder.decode();
        if (buffer.trim()) controller.enqueue(encoder.encode(normalizeFrame(buffer)));
      },
    }),
  );
}
