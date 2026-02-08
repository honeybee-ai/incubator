// monolith.js - Everything jammed in one file. Split this into modules.

const DEFAULT_PAGE_SIZE = 20;
const MAX_RETRIES = 3;
const CACHE_TTL_MS = 60000;

// ── User Management ─────────────────────────────────────────

function createUser(name, email, role = 'member') {
  if (!name || !email) throw new Error('Name and email required');
  if (!email.includes('@')) throw new Error('Invalid email');
  return {
    id: generateId(),
    name: name.trim(),
    email: email.toLowerCase(),
    role,
    createdAt: new Date(),
    active: true,
  };
}

function deactivateUser(user) {
  return { ...user, active: false, deactivatedAt: new Date() };
}

function changeRole(user, newRole) {
  const validRoles = ['admin', 'member', 'viewer'];
  if (!validRoles.includes(newRole)) throw new Error(`Invalid role: ${newRole}`);
  return { ...user, role: newRole };
}

function formatUserDisplay(user) {
  const status = user.active ? 'active' : 'inactive';
  return `${user.name} <${user.email}> [${user.role}] (${status})`;
}

// ── Post Management ─────────────────────────────────────────

function createPost(author, title, body, tags = []) {
  if (!title || !body) throw new Error('Title and body required');
  return {
    id: generateId(),
    authorId: author.id,
    title: title.trim(),
    body,
    tags: tags.map(t => t.toLowerCase()),
    createdAt: new Date(),
    updatedAt: new Date(),
    published: false,
  };
}

function publishPost(post) {
  return { ...post, published: true, publishedAt: new Date(), updatedAt: new Date() };
}

function addTag(post, tag) {
  if (post.tags.includes(tag.toLowerCase())) return post;
  return { ...post, tags: [...post.tags, tag.toLowerCase()], updatedAt: new Date() };
}

function removeTag(post, tag) {
  return {
    ...post,
    tags: post.tags.filter(t => t !== tag.toLowerCase()),
    updatedAt: new Date(),
  };
}

// ── Search & Filtering ──────────────────────────────────────

function searchPosts(posts, query) {
  const lower = query.toLowerCase();
  return posts.filter(p =>
    p.title.toLowerCase().includes(lower) ||
    p.body.toLowerCase().includes(lower) ||
    p.tags.some(t => t.includes(lower))
  );
}

function filterByTag(posts, tag) {
  return posts.filter(p => p.tags.includes(tag.toLowerCase()));
}

function filterByAuthor(posts, authorId) {
  return posts.filter(p => p.authorId === authorId);
}

function sortByDate(posts, order = 'desc') {
  return [...posts].sort((a, b) => {
    const diff = new Date(a.createdAt) - new Date(b.createdAt);
    return order === 'desc' ? -diff : diff;
  });
}

function paginate(items, page = 1, pageSize = DEFAULT_PAGE_SIZE) {
  const start = (page - 1) * pageSize;
  return {
    items: items.slice(start, start + pageSize),
    page,
    pageSize,
    total: items.length,
    totalPages: Math.ceil(items.length / pageSize),
  };
}

// ── Cache ───────────────────────────────────────────────────

function createCache() {
  const store = new Map();

  return {
    get(key) {
      const entry = store.get(key);
      if (!entry) return null;
      if (Date.now() - entry.setAt > (entry.ttl || CACHE_TTL_MS)) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },
    set(key, value, ttl) {
      store.set(key, { value, setAt: Date.now(), ttl });
    },
    delete(key) {
      return store.delete(key);
    },
    clear() {
      store.clear();
    },
    size() {
      return store.size;
    },
  };
}

// ── Utilities ───────────────────────────────────────────────

let _idCounter = 0;
function generateId() {
  return `${Date.now()}-${++_idCounter}`;
}

function retry(fn, maxRetries = MAX_RETRIES) {
  let lastError;
  for (let i = 0; i <= maxRetries; i++) {
    try {
      return fn();
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

// ── Exports ─────────────────────────────────────────────────

module.exports = {
  createUser, deactivateUser, changeRole, formatUserDisplay,
  createPost, publishPost, addTag, removeTag,
  searchPosts, filterByTag, filterByAuthor, sortByDate, paginate,
  createCache,
  generateId, retry, debounce, deepClone,
  DEFAULT_PAGE_SIZE, MAX_RETRIES, CACHE_TTL_MS,
};
