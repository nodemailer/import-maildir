'use strict';

const util = require('util');
const uploader = require('./uploader');
const log = require('npmlog');
const MaildirScan = require('maildir-scan');
const scanner = new MaildirScan({
    mergeSpecial: true
});
const pathlib = require('path');
const tools = require('./tools');

const logLevels = ['silly', 'verbose', 'info', 'http', 'warn', 'error'];

let flogger = (target, ...data) => {
    let message = util.format(...[].concat(data || []));
    process.send({
        t: target,
        m: message
    });
};

let logger = (level, data) => {
    data.messageRaw[0] = '(' + data.prefix + ') ' + data.messageRaw[0];
    let msg = util.format(...data.messageRaw);
    process.send({
        msg,
        level
    });
    if (level === 'error') {
        flogger('error', msg);
    }
};

logLevels.reverse().forEach(level => {
    log.on('log.' + level, data => {
        logger(level, data);
    });
});

log.level = 'silent'; // disable normal log stream

let processNext = msg => {
    let entry = msg.entry;

    let user = {
        address: tools.normalizeAddress(entry.user)
    };

    scanner.scan(entry.path, (err, folders) => {
        if (err) {
            flogger('user', '%s %s error %s', entry.path, user.address, err.message);
            log.error('scan', 'Failed to scan %s. %s', entry.path, err.message);
            return setTimeout(
                () =>
                    process.send({
                        idle: true
                    }),
                1000
            );
        }

        uploader.getUser(user, (err, userData) => {
            if (err) {
                flogger('user', '%s %s error %s', entry.path, user.address, err.message);
            } else if (userData) {
                flogger('user', '%s %s resolved %s', entry.path, user.address, userData._id);
            } else {
                flogger('user', '%s %s error %s', entry.path, user.address, err.message);
                return setTimeout(
                    () =>
                        process.send({
                            idle: true
                        }),
                    1000
                );
            }

            let folderpos = 0;
            let processFolders = () => {
                if (folderpos >= folders.length) {
                    process.send({
                        idle: true
                    });
                }
                let folder = folders[folderpos++];
                if (!folder || !folder.messages) {
                    return setImmediate(processFolders);
                }
                folder.path = pathlib.join(entry.path, folder.path);

                if (!folder.messages.length || msg.foldersOnly) {
                    // ensure folder
                    return uploader.ensureFolder(entry.path, user, folder, err => {
                        if (err) {
                            log.error('upload', 'Failed to process empty folder %s. error=%s', folder.path, err.message);
                            return setTimeout(() => processFolders(), 1000);
                        }
                        setImmediate(processFolders);
                    });
                }

                let messagepos = 0;
                let processMessages = () => {
                    if (messagepos >= folder.messages.length) {
                        return setImmediate(processFolders);
                    }

                    let message = folder.messages[messagepos++];
                    if (!message) {
                        return setImmediate(processMessages);
                    }

                    let messagePath = pathlib.join(entry.path, message.path);
                    let lastError;
                    let tryCount = 0;

                    let tryUpload = () => {
                        if (tryCount++ > 5) {
                            log.error('upload', 'Gave up processing message %s after %s tries', message.path, tryCount);
                            flogger('message', '%s error %s', messagePath, (lastError && lastError.message) || 'Too many retries');
                            return setTimeout(() => processMessages(), 1000);
                        }

                        uploader.upload(entry.path, user, folder, message, (err, uploaded, status) => {
                            if (err) {
                                lastError = err;
                                return setTimeout(tryUpload, 1000);
                            }
                            flogger('message', '%s created %s', messagePath, status);
                            setImmediate(processMessages);
                        });
                    };

                    tryUpload();
                };

                setImmediate(processMessages);
            };

            setImmediate(processFolders);
        });
    });
};

uploader.init(() => {
    process.send({
        idle: true
    });
});

process.on('message', msg => {
    if (msg && msg.entry) {
        processNext(msg);
    }
});
