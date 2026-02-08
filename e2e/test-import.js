const utils = require('./utils');
const users = require('./users');
const posts = require('./posts');
const search = require('./search');
const cache = require('./cache');

console.log('Loaded modules');
console.log('utils keys:', Object.keys(utils));
console.log('users keys:', Object.keys(users));

// Try direct function access
console.log('generateId function:', typeof utils.generateId);

// Test it
if (typeof utils.generateId === 'function') {
  const id = utils.generateId();
  console.log('Generated ID:', id);
}
