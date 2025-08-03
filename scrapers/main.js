const zoro = require('./zoro');

module.exports = async function(imdb) {
  const stream = await zoro(imdb);
  if (!stream) throw new Error("No stream found");
  return stream;
};