const axios = require('axios');
const cheerio = require('cheerio');

async function scrapeEmbed(imdb) {
  try {
    const url = `https://vidsrc.to/embed/movie/${imdb}`;
    const response = await axios.get(url);
    const html = response.data;
    const $ = cheerio.load(html);

    // Simulated scraping: just return the embed URL for now
    return `https://vidsrc.to/embed/movie/${imdb}`;
  } catch (err) {
    throw new Error('Scrape failed');
  }
}

module.exports = scrapeEmbed;
