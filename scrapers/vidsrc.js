const axios = require('axios');

module.exports = async function(imdb) {
  try {
    const url = `https://vidsrc.to/embed/movie/${imdb}`;
    return url;
  } catch (e) {
    console.error('Scraping error:', e.message);
    return null;
  }
};