/**
 * Deterministic, dependency-free text embeddings.
 *
 * A real deployment would call an embedding model. For this project we need a
 * vector database that works offline and without an API key, so documents are
 * embedded with a hashed bag-of-words model: every token and token bigram is
 * hashed into a fixed-size vector. Cosine similarity over these vectors still
 * captures lexical overlap, which is enough to demonstrate retrieval-augmented
 * generation end to end.
 *
 * The same function is used for documents at seed time and for queries, so the
 * vectors always live in the same space.
 */

const TOKEN_RE = /[\p{L}\p{N}]+/gu;

/**
 * @param {string} text
 * @param {number} dimension
 * @returns {number[]} L2-normalized vector of exactly `dimension` numbers
 */
export function embed(text, dimension) {
  const vector = new Array(dimension).fill(0);
  const tokens = tokenize(text);

  if (tokens.length === 0) {
    // Qdrant rejects zero vectors for cosine distance, so use a harmless
    // unit vector for empty documents/queries.
    vector[0] = 1;
    return vector;
  }

  const counts = new Map();
  for (const token of tokens) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }

  for (const [token, count] of counts) {
    // Sublinear term frequency keeps repeated words from dominating.
    vector[hashToken(token) % dimension] += 1 + Math.log(count);
  }

  for (let index = 0; index < tokens.length - 1; index += 1) {
    const bigram = `${tokens[index]}\u0000${tokens[index + 1]}`;
    vector[hashToken(bigram) % dimension] += 0.35;
  }

  let norm = 0;
  for (const value of vector) norm += value * value;
  norm = Math.sqrt(norm);

  if (norm > 0) {
    for (let index = 0; index < dimension; index += 1) vector[index] /= norm;
  }

  return vector;
}

/**
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  return text.toLowerCase().match(TOKEN_RE) ?? [];
}

/**
 * FNV-1a 32-bit hash. Fast, stable, and good enough for feature hashing.
 * @param {string} value
 * @returns {number}
 */
export function hashToken(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Split a document into overlapping chunks suitable for retrieval.
 *
 * Paragraph boundaries are preferred; a paragraph that is still too long is
 * split by character count.
 *
 * @param {string} text
 * @param {number} size
 * @param {number} overlap
 * @returns {string[]}
 */
export function chunkText(text, size, overlap) {
  const safeSize = Math.max(100, size);
  const safeOverlap = Math.min(Math.max(0, overlap), Math.floor(safeSize / 2));
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (!normalized) return [];

  const paragraphs = normalized
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

  const pieces = [];
  for (const paragraph of paragraphs) {
    if (paragraph.length <= safeSize) {
      pieces.push(paragraph);
      continue;
    }
    const step = safeSize - safeOverlap;
    for (let start = 0; start < paragraph.length; start += step) {
      pieces.push(paragraph.slice(start, start + safeSize));
    }
  }

  const chunks = [];
  let current = "";

  for (const piece of pieces) {
    if (!current) {
      current = piece;
      continue;
    }
    if (current.length + piece.length + 2 <= safeSize) {
      current += `\n\n${piece}`;
      continue;
    }

    chunks.push(current);
    const tail = safeOverlap > 0 ? current.slice(-safeOverlap) : "";
    current = tail ? `${tail}\n\n${piece}` : piece;
  }

  if (current.trim()) chunks.push(current);
  return chunks;
}
