const { dedupePinnedComments, ensurePinnedFieldsValid } = require('../server.js');

if (typeof dedupePinnedComments !== 'function') {
  throw new Error('dedupePinnedComments helper is missing or not a function');
}
if (typeof ensurePinnedFieldsValid !== 'function') {
  throw new Error('ensurePinnedFieldsValid helper is missing or not a function');
}

console.log('Pinned helper exports are available');
