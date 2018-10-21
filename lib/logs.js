'use strict';

const config = require('wild-config');
const fs = require('fs');

const messagelog = fs.createWriteStream(config.log.files.messagelog, {
    flags: 'a'
});

const userlog = fs.createWriteStream(config.log.files.userlog, {
    flags: 'a'
});

const errorlog = fs.createWriteStream(config.log.files.errorlog, {
    flags: 'a'
});

messagelog.write(getInfo() + 'Logging started\n');
userlog.write(getInfo() + 'Logging started\n');
errorlog.write(getInfo() + 'Logging started\n');

module.exports = (logTarget, message) => {
    let log;
    switch (logTarget) {
        case 'message':
            log = messagelog;
            break;
        case 'user':
            log = userlog;
            break;
        case 'error':
            log = errorlog;
            break;
    }
    message = (message || '').trim();
    if (log && message) {
        log.write(getInfo() + message + '\n');
    }
};

function getInfo() {
    return (
        '[' +
        new Date()
            .toISOString()
            .substr(0, 19)
            .replace(/T/, ' ') +
        '] ' +
        process.pid +
        ' '
    );
}
