const path = require('path');
require('dotenv').config();

const config = {
    port: process.env.PORT || 5000,
    nodeEnv: process.env.NODE_ENV || 'development',
    corsOrigins: process.env.CORS_ORIGINS?.split(',') || ['*'],
    uploadLimit: '50mb',
    chromePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    authPath: process.env.AUTH_PATH || path.join(__dirname, '..', '.wwebjs_auth'),
    mediaPath: process.env.MEDIA_PATH || path.join(__dirname, 'media'),
    tempPath: process.env.TEMP_PATH || path.join(__dirname, 'temp'),
    reconnectDelay: parseInt(process.env.RECONNECT_DELAY) || 5000,
    maxRetries: parseInt(process.env.MAX_RETRIES) || 3,
    passEncrypted: process.env.PASS_ENCRYPTED || 'Nigga'
};

module.exports = config;