const axios = require('axios');

module.exports = async function(imdb) {
  try {
    const res = await axios.get(`https://vidsrc.to/embed/movie/${imdb}`);
    if (res.status === 200 && res.data.includes("m3u8")) {
      return `https://vidsrc.to/embed/movie/${imdb}`;
    }
    return null;
  } catch {
    return null;
  }
};