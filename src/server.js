const config = require('./config');
const { createApp } = require('./app');
const { refreshAllAgeGroups } = require('./utils/profiles');

const app = createApp();
app.listen(config.port, () => console.log(`Satsang Spark API listening on :${config.port} (${config.env})`));

// Keep stored age groups current as birthdays pass (also refreshed lazily on login/profile loads).
setInterval(() => refreshAllAgeGroups().catch((e) => console.error('age-group refresh failed', e)), 6 * 60 * 60 * 1000).unref();
