'use strict';

const punycode = require('punycode');

function normalizeAddress(address) {
    if (address.indexOf('@') < 0) {
        return address
            .normalize('NFC')
            .toLowerCase()
            .trim();
    }

    let user = address
        .substr(0, address.lastIndexOf('@'))
        .normalize('NFC')
        .toLowerCase()
        .trim();

    let domain = address
        .substr(address.lastIndexOf('@') + 1)
        .toLowerCase()
        .trim();

    return user.replace(/\+.*$/, '').trim() + '@' + punycode.toUnicode(domain);
}

// returns a redis config object with a retry strategy
function redisConfig(defaultConfig) {
    return defaultConfig;
}

module.exports = {
    normalizeAddress,
    redisConfig
};
