const express = require('express');
const path = require('path');
const app = express();
const port = process.env.PORT || 10000;

app.use(express.static(path.join(__dirname, 'public')));

const embedRoute = require('./api/embed');
app.use('/api/embed', embedRoute);

app.listen(port, () => {
  console.log(`Server is live on port ${port}`);
});
